import { SIMULATOR_VERSION } from './types';
import type { EvaluationOptions, EvaluationResult, Finding } from './types';
import type { Topology } from '../types';
import { DEFAULT_SCENARIOS } from './scenarios';
import { runScenarios } from './runner';
import { lintTopology, correlateTelemetryFindings } from './linter';
import { evaluateScore } from './score';
import { hashTopology } from './hash';

export * from './types';
export * from './scenarios';
export * from './runner';
export * from './stability';
export * from './linter';
export * from './score';
export * from './hash';
export * from './registry';
export * from './diff';
export * from './ai';

/**
 * Monthly USD cost per unit (instance / replica / shard / fixed appliance) by node kind.
 * On-demand cloud pricing profiles, $15-$70/unit-month. Tunable in one place: adjust
 * these for reserved pricing or a different provider without touching the walk below.
 * `DEFAULT_UNIT_COST` covers any kind not listed. `client` is 0 (traffic originates
 * outside the account).
 * ponytail: flat rate table, not per-region — add a pricing profile param if someone asks for AWS-vs-GCP
 */
export const COST_RATES: Readonly<Record<string, number>> = {
  client: 0,
  lb: 20,
  apigateway: 20,
  service: 35,
  worker: 35,
  transcoder: 35,
  lambda: 35,
  cache: 30,
  db: 70,
  replica: 70,
  shard: 70,
  queue: 25,
  streambroker: 25,
  pubsub: 25,
  retryqueue: 25,
  ratelimiter: 15,
  breaker: 15,
  loadshedder: 15,
  bulkhead: 15,
};

const DEFAULT_UNIT_COST = 30;

/** Fixed-price appliances: one flat charge regardless of instances/replicas/shards. */
const FIXED_PRICE_KINDS = new Set([
  'lb',
  'apigateway',
  'queue',
  'streambroker',
  'pubsub',
  'retryqueue',
  'ratelimiter',
  'breaker',
  'loadshedder',
  'bulkhead',
]);

function positiveIntConfig(value: unknown): number {
  return typeof value === 'number' && value > 0 ? Math.floor(value) : 1;
}

/**
 * Estimates baseline monthly cloud compute costs in USD for a topology.
 *
 * Pure, deterministic, zero I/O. Rates live in COST_RATES.
 */
export function estimateTopologyCost(topology: Topology): number {
  let total = 0;
  for (const node of topology.nodes) {
    const rate = COST_RATES[node.kind] ?? DEFAULT_UNIT_COST;
    if (rate === 0) continue;

    let units: number;
    if (FIXED_PRICE_KINDS.has(node.kind)) {
      units = 1;
    } else if (node.kind === 'replica') {
      units = positiveIntConfig(node.config.replicaCount) + 1; // primary + replicas
    } else if (node.kind === 'shard') {
      units = positiveIntConfig(node.config.shardCount);
    } else {
      units = positiveIntConfig(node.config.instances);
    }
    total += rate * units;
  }
  return total;
}

/**
 * Evaluates a complete system design topology deterministically.
 *
 * Orchestrates:
 * 1. Provenance hashing: Byte-identical topologyHash using canonical sorting and 128-bit FNV-1a.
 * 2. Static linting: Identifies SPOFs, unprotected high-latency links, unscaled databases,
 *    cache miss amplification, and cyclic dependencies.
 * 3. Discrete-event simulation: Runs baseline, spike, and chaos scenarios headlessly with exact
 *    measured LatencyRing percentiles (p50, p95, p99).
 * 4. Finding correlation: Maps empirical bottlenecks and request drops to architectural root causes.
 * 5. Deterministic scoring: Generates 5 weighted rubric dimensions (Resilience 30%, Scalability 25%,
 *    Cost Efficiency 20%, Simplicity 15%, Correctness 10%) with symptom grouping to prevent double-counting.
 *
 * Returns a versioned, immutable EvaluationResult ('1.0').
 */
// ponytail: unbounded Map cache, add LRU eviction if the experiment tree grows past ~100 nodes
const evaluationCache = new Map<string, Omit<EvaluationResult, 'evaluatedAt'>>();

export function evaluateTopology(
  topology: Topology,
  options?: Partial<EvaluationOptions>,
): EvaluationResult {
  const seed = options?.seed ?? 42;
  const simulatorVersion = options?.simulatorVersion ?? SIMULATOR_VERSION;
  const scenarios = options?.scenarios ?? DEFAULT_SCENARIOS;
  const evaluatedAt = options?.evaluatedAt ?? new Date().toISOString();

  // 1. Provenance hash
  const topologyHash = hashTopology(topology);

  // The artifact is fully reproducible from hash + seed + simulatorVersion + scenario
  // definitions + cost override, so those form the cache key. evaluatedAt is layered
  // back on per call since it is the sole non-deterministic field.
  const cacheKey = JSON.stringify([
    topologyHash,
    seed,
    simulatorVersion,
    scenarios,
    options?.estimatedMonthlyCostUsd ?? null,
  ]);
  const cached = evaluationCache.get(cacheKey);
  if (cached) {
    return { ...cached, evaluatedAt };
  }

  // 2. Static analysis
  const staticFindings = lintTopology(topology);

  // 3. Headless simulation
  const telemetry = runScenarios(topology, {
    seed,
    simulatorVersion,
    scenarios,
  });

  // 4. Empirical correlation
  const empiricalFindings = correlateTelemetryFindings(staticFindings, telemetry);

  // 5. Aggregate findings
  const findings: readonly Finding[] = [...staticFindings, ...empiricalFindings];

  // 6. Cost estimation
  const estimatedMonthlyCostUsd =
    options?.estimatedMonthlyCostUsd ?? estimateTopologyCost(topology);

  // 7. Deterministic rubric scoring
  const { score } = evaluateScore(findings, telemetry, estimatedMonthlyCostUsd);

  const deterministic: Omit<EvaluationResult, 'evaluatedAt'> = {
    version: '1.0',
    topologyHash,
    simulatorVersion,
    seed,
    scenarios: telemetry,
    score,
    findings,
    estimatedMonthlyCostUsd,
  };
  evaluationCache.set(cacheKey, deterministic);

  return { ...deterministic, evaluatedAt };
}
