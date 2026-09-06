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
 * Estimates baseline monthly cloud compute costs in USD for a topology.
 *
 * Grounded in on-demand cloud pricing profiles ($15-$70/instance-month).
 * Provides a pure, deterministic calculation with zero I/O and zero external dependencies.
 */
export function estimateTopologyCost(topology: Topology): number {
  let total = 0;
  for (const node of topology.nodes) {
    const instances =
      typeof node.config.instances === 'number' && node.config.instances > 0
        ? Math.floor(node.config.instances)
        : 1;

    switch (node.kind) {
      case 'client':
        // Traffic originates outside the account; 0 cloud compute cost.
        break;
      case 'lb':
      case 'apigateway':
        total += 20;
        break;
      case 'service':
      case 'worker':
      case 'transcoder':
      case 'lambda':
        total += 35 * instances;
        break;
      case 'cache':
        total += 30 * instances;
        break;
      case 'db':
        total += 70 * instances;
        break;
      case 'replica': {
        const replicaCount =
          typeof node.config.replicaCount === 'number' && node.config.replicaCount > 0
            ? Math.floor(node.config.replicaCount)
            : 1;
        // Primary plus replicas
        total += 70 * (replicaCount + 1);
        break;
      }
      case 'shard': {
        const shardCount =
          typeof node.config.shardCount === 'number' && node.config.shardCount > 0
            ? Math.floor(node.config.shardCount)
            : 1;
        total += 70 * shardCount;
        break;
      }
      case 'queue':
      case 'streambroker':
      case 'pubsub':
      case 'retryqueue':
        total += 25;
        break;
      case 'ratelimiter':
      case 'breaker':
      case 'loadshedder':
      case 'bulkhead':
        total += 15;
        break;
      default:
        total += 30 * instances;
        break;
    }
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

  return {
    version: '1.0',
    topologyHash,
    simulatorVersion,
    seed,
    scenarios: telemetry,
    score,
    findings,
    estimatedMonthlyCostUsd,
    evaluatedAt,
  };
}
