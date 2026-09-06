import { describe, expect, it } from 'vitest';
import { BASELINE_SCENARIO, CACHE_FAILURE_SCENARIO, SPIKE_SCENARIO } from './scenarios';
import { runScenario, runScenarios } from './runner';
import type { EvaluationScenario } from './types';
import type { Topology } from '../types';
import { PRESETS } from '../presets';

/**
 * Creates a simple deterministic test topology:
 * Client (50 RPS) -> Service (Capacity 10, 10ms) -> Cache (Hit rate 0.8) -> DB (Capacity 4, 30ms)
 */
function createTestTopology(): Topology {
  return {
    nodes: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Client',
        x: 0,
        y: 0,
        config: {
          capacity: 1,
          instances: 1,
          serviceMs: 0,
          serviceCv: 0,
          queueLimit: 0,
          hitRate: 0,
          errorRate: 0,
          timeoutMs: 1000,
          retries: 0,
          rps: 50,
          replicaCount: 1,
          replicationLagMs: 0,
          readFraction: 1,
          shardCount: 1,
          shardCapacity: 1,
          hotKeyFraction: 0,
        },
      },
      {
        id: 'service-1',
        kind: 'service',
        label: 'API Service',
        x: 150,
        y: 0,
        config: {
          capacity: 16,
          instances: 1,
          serviceMs: 10,
          serviceCv: 0.2,
          queueLimit: 64,
          hitRate: 0,
          errorRate: 0,
          timeoutMs: 500,
          retries: 0,
          rps: 0,
          replicaCount: 1,
          replicationLagMs: 0,
          readFraction: 1,
          shardCount: 1,
          shardCapacity: 1,
          hotKeyFraction: 0,
        },
      },
      {
        id: 'cache-1',
        kind: 'cache',
        label: 'Redis Cache',
        x: 300,
        y: 0,
        config: {
          capacity: 32,
          instances: 1,
          serviceMs: 2,
          serviceCv: 0.1,
          queueLimit: 128,
          hitRate: 0.8,
          errorRate: 0,
          timeoutMs: 200,
          retries: 0,
          rps: 0,
          replicaCount: 1,
          replicationLagMs: 0,
          readFraction: 1,
          shardCount: 1,
          shardCapacity: 1,
          hotKeyFraction: 0,
        },
      },
      {
        id: 'db-1',
        kind: 'db',
        label: 'Postgres DB',
        x: 450,
        y: 0,
        config: {
          capacity: 4,
          instances: 1,
          serviceMs: 40,
          serviceCv: 0.3,
          queueLimit: 16,
          hitRate: 0,
          errorRate: 0,
          timeoutMs: 0,
          retries: 0,
          rps: 0,
          replicaCount: 1,
          replicationLagMs: 0,
          readFraction: 1,
          shardCount: 1,
          shardCapacity: 1,
          hotKeyFraction: 0,
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e2', from: 'service-1', to: 'cache-1', weight: 1 },
      { id: 'e3', from: 'cache-1', to: 'db-1', weight: 1 },
    ],
  };
}

describe('evaluator runner', () => {
  it('same topology + same seed produces byte-identical telemetry', () => {
    const topology = createTestTopology();
    const run1 = runScenario(topology, BASELINE_SCENARIO, 42);
    const run2 = runScenario(topology, BASELINE_SCENARIO, 42);

    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('diverges for different seeds when stochasticity is present', () => {
    const topology = structuredClone(PRESETS[0].topology);
    const run1 = runScenario(topology, BASELINE_SCENARIO, 42);
    const run2 = runScenario(topology, BASELINE_SCENARIO, 99);

    expect(JSON.stringify(run1)).not.toBe(JSON.stringify(run2));
  });

  it('baseline scenario produces expected request count', () => {
    const topology = createTestTopology();
    // 50 RPS for 5000ms duration = ~250 requests
    const shortBaseline: EvaluationScenario = {
      ...BASELINE_SCENARIO,
      durationMs: 5000,
    };
    const telemetry = runScenario(topology, shortBaseline, 42);

    expect(telemetry.totalRequests).toBeGreaterThanOrEqual(230);
    expect(telemetry.totalRequests).toBeLessThanOrEqual(270);
    expect(telemetry.lostRequests).toBe(0);
  });

  it('spike scenario scales traffic multiplier proportionally', () => {
    const topology = createTestTopology();
    const durationMs = 10000;

    const baseline: EvaluationScenario = {
      id: 'test_baseline',
      name: 'Baseline',
      durationMs,
      trafficMultiplier: 1.0,
    };

    const spike: EvaluationScenario = {
      id: 'test_spike',
      name: 'Spike 3x',
      durationMs,
      trafficMultiplier: 3.0,
    };

    const baselineTelemetry = runScenario(topology, baseline, 42);
    const spikeTelemetry = runScenario(topology, spike, 42);

    const ratio = spikeTelemetry.totalRequests / baselineTelemetry.totalRequests;
    expect(ratio).toBeGreaterThanOrEqual(2.5);
    expect(ratio).toBeLessThanOrEqual(3.5);
  });

  it('fault scenarios actually invoke the engine fault mechanism', () => {
    const topology = createTestTopology();

    // In a healthy run, there are zero lost requests
    const healthy = runScenario(topology, BASELINE_SCENARIO, 42);
    expect(healthy.lostRequests).toBe(0);

    // With cache crashed at t=1000ms, traffic cascades to db-1 which has capacity 4, causing queue saturation & drops
    const faultedScenario: EvaluationScenario = {
      id: 'cache_crash_test',
      name: 'Cache Crash Test',
      durationMs: 6000,
      trafficMultiplier: 1.0,
      faults: [
        {
          kind: 'crash',
          target: { nodeKind: 'cache' },
          atMs: 1000,
        },
      ],
    };

    const faultTelemetry = runScenario(topology, faultedScenario, 42);
    expect(faultTelemetry.lostRequests).toBeGreaterThan(0);
  });

  it('runner does not mutate the input topology', () => {
    const topology = createTestTopology();
    const beforeJson = JSON.stringify(topology);

    runScenarios(topology, {
      seed: 42,
      simulatorVersion: '1.0',
      scenarios: [BASELINE_SCENARIO, SPIKE_SCENARIO, CACHE_FAILURE_SCENARIO],
    });

    const afterJson = JSON.stringify(topology);
    expect(afterJson).toBe(beforeJson);
  });
});
