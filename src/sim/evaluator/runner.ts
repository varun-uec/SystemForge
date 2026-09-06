import { Engine } from '../engine';
import type { Topology } from '../types';
import { DEFAULT_SCENARIOS } from './scenarios';
import type { EvaluationOptions, EvaluationScenario, ScenarioTelemetry } from './types';

export const RUNNER_STEP_MS = 50;

/**
 * Creates an isolated clone of the topology with scaled client offered rates,
 * guaranteeing the input topology is never mutated.
 */
function prepareTopology(topology: Topology, trafficMultiplier: number): Topology {
  return {
    ...topology,
    nodes: topology.nodes.map((n) => {
      if (n.kind !== 'client' || trafficMultiplier === 1) {
        return { ...n, config: { ...n.config } };
      }
      return {
        ...n,
        config: {
          ...n.config,
          rps: Math.round(n.config.rps * trafficMultiplier),
        },
      };
    }),
    edges: topology.edges.map((e) => ({ ...e })),
  };
}

/**
 * Runs a single scenario against a topology in a headless discrete-event loop.
 *
 * Deterministic: identical topology and seed produces byte-identical results.
 * Pure: no DOM, no rAF, no React, no timers, no I/O.
 */
export function runScenario(
  topology: Topology,
  scenario: EvaluationScenario,
  seed = 42,
): ScenarioTelemetry {
  const prepared = prepareTopology(topology, scenario.trafficMultiplier);
  const engine = new Engine(prepared, seed);

  const maxQueueDepth: Record<string, number> = {};
  for (const n of topology.nodes) {
    maxQueueDepth[n.id] = 0;
  }

  let firstSaturatedNodeId: string | null = null;
  let firstSaturationTimeMs: number | null = null;

  const pendingFaults = (scenario.faults ?? []).map((f) => ({
    fault: f,
    injected: false,
  }));

  const totalSteps = Math.max(1, Math.round(scenario.durationMs / RUNNER_STEP_MS));

  for (let step = 0; step < totalSteps; step++) {
    const currentMs = step * RUNNER_STEP_MS;

    // Inject any faults scheduled at or before this simulated time step
    for (const item of pendingFaults) {
      if (!item.injected && currentMs >= (item.fault.atMs ?? 0)) {
        item.injected = true;
        const target = item.fault.target;
        if (typeof target === 'string') {
          engine.injectFailure(target, item.fault.kind, item.fault.opts);
        } else if (target && typeof target === 'object' && 'nodeKind' in target) {
          for (const n of prepared.nodes) {
            if (n.kind === target.nodeKind) {
              engine.injectFailure(n.id, item.fault.kind, item.fault.opts);
            }
          }
        }
      }
    }

    engine.advance(RUNNER_STEP_MS);

    const snap = engine.snapshot();
    for (const [id, stats] of Object.entries(snap.nodes)) {
      const q = stats.queued ?? 0;
      if (q > (maxQueueDepth[id] ?? 0)) {
        maxQueueDepth[id] = q;
      }
      const isSaturated =
        (stats.queueLimit > 0 && q >= stats.queueLimit) || (stats.shedRate ?? 0) > 0;
      if (isSaturated && firstSaturationTimeMs === null) {
        firstSaturationTimeMs = currentMs;
        firstSaturatedNodeId = id;
      }
    }
  }

  const finalSnapshot = engine.snapshot();
  const system = finalSnapshot.system;

  let bottleneckNodeId: string | null = firstSaturatedNodeId;
  let saturationTimeMs: number | null = firstSaturationTimeMs;

  if (bottleneckNodeId === null) {
    let maxQueue = 0;
    let worstNodeId: string | null = null;
    for (const [id, depth] of Object.entries(maxQueueDepth)) {
      if (depth > maxQueue) {
        maxQueue = depth;
        worstNodeId = id;
      }
    }
    if (worstNodeId !== null && maxQueue > 0) {
      bottleneckNodeId = worstNodeId;
    }
  }

  return {
    scenarioId: scenario.id,
    p50Ms: system.p50,
    p95Ms: system.p95,
    p99Ms: system.p99,
    maxQueueDepth,
    lostRequests: system.totalFailed,
    totalRequests: system.totalRequests,
    bottleneckNodeId,
    saturationTimeMs,
  };
}

/**
 * Runs a suite of scenarios sequentially against a topology using the specified options.
 */
export function runScenarios(
  topology: Topology,
  options: EvaluationOptions,
): readonly ScenarioTelemetry[] {
  const scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
  return scenarios.map((scenario) => runScenario(topology, scenario, options.seed));
}
