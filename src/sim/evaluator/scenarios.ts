import type { EvaluationScenario } from './types';

/**
 * Baseline nominal load scenario.
 * Evaluates the topology under standard offered traffic without faults.
 */
export const BASELINE_SCENARIO: EvaluationScenario = {
  id: 'baseline',
  name: 'Baseline Load',
  durationMs: 10_000,
  trafficMultiplier: 1.0,
};

/**
 * Traffic spike scenario.
 * Tests queue limits, backpressure, and capacity headroom by offering 3x baseline traffic.
 */
export const SPIKE_SCENARIO: EvaluationScenario = {
  id: 'traffic_spike',
  name: 'Traffic Spike (3x)',
  durationMs: 10_000,
  trafficMultiplier: 3.0,
};

/**
 * Cache failure scenario.
 * Injects a crash fault into any cache tier node 2 seconds into the simulation
 * to test resilience against cache stampedes, origin fallback, and database saturation.
 */
export const CACHE_FAILURE_SCENARIO: EvaluationScenario = {
  id: 'cache_failure',
  name: 'Cache Failure',
  durationMs: 10_000,
  trafficMultiplier: 1.0,
  faults: [
    {
      kind: 'crash',
      target: { nodeKind: 'cache' },
      atMs: 2_000,
    },
  ],
};

/**
 * Default immutable suite of scenarios executed during evaluation.
 */
export const DEFAULT_SCENARIOS: readonly EvaluationScenario[] = [
  BASELINE_SCENARIO,
  SPIKE_SCENARIO,
  CACHE_FAILURE_SCENARIO,
] as const;
