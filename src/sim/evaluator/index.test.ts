import { describe, expect, it } from 'vitest';
import {
  evaluateTopology,
  applyRemediation,
  calculateEvaluationDiff,
  estimateTopologyCost,
} from './index';
import type { Topology } from '../types';
import { defaultConfig } from '../presets';

function createE2ETopology(): Topology {
  return {
    nodes: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Web Client',
        x: 100,
        y: 200,
        config: { ...defaultConfig('client'), rps: 100 },
      },
      {
        id: 'service-1',
        kind: 'service',
        label: 'API Service',
        x: 300,
        y: 200,
        config: {
          ...defaultConfig('service'),
          instances: 1,
          capacity: 10,
          serviceMs: 20,
        },
      },
      {
        id: 'db-1',
        kind: 'db',
        label: 'Primary Database',
        x: 500,
        y: 200,
        config: {
          ...defaultConfig('db'),
          capacity: 8,
          serviceMs: 30,
          readFraction: 0.85,
        },
      },
    ],
    edges: [
      { id: 'e_c_s', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e_s_d', from: 'service-1', to: 'db-1', weight: 1 },
    ],
  };
}

describe('evaluator end-to-end facade', () => {
  it('1. performs full deterministic evaluation of a topology', () => {
    const topo = createE2ETopology();
    const result = evaluateTopology(topo, {
      seed: 42,
      evaluatedAt: '2026-09-06T12:00:00.000Z',
    });

    expect(result.version).toBe('1.0');
    expect(result.topologyHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.simulatorVersion).toBe('1.0');
    expect(result.seed).toBe(42);
    expect(result.evaluatedAt).toBe('2026-09-06T12:00:00.000Z');

    // Scenarios executed
    expect(result.scenarios.length).toBe(3); // baseline, traffic_spike, cache_failure
    expect(result.scenarios[0].scenarioId).toBe('baseline');
    expect(result.scenarios[0].totalRequests).toBeGreaterThan(0);
    expect(result.scenarios[0].p95Ms).toBeGreaterThan(0);

    // Score generated across all 5 dimensions
    expect(result.score.resilience).toBeGreaterThanOrEqual(0);
    expect(result.score.resilience).toBeLessThanOrEqual(100);
    expect(result.score.scalability).toBeGreaterThanOrEqual(0);
    expect(result.score.scalability).toBeLessThanOrEqual(100);
    expect(result.score.costEfficiency).toBeGreaterThanOrEqual(0);
    expect(result.score.costEfficiency).toBeLessThanOrEqual(100);
    expect(result.score.simplicity).toBeGreaterThanOrEqual(0);
    expect(result.score.simplicity).toBeLessThanOrEqual(100);
    expect(result.score.correctness).toBeGreaterThanOrEqual(0);
    expect(result.score.correctness).toBeLessThanOrEqual(100);
    expect(result.score.total).toBeGreaterThanOrEqual(0);
    expect(result.score.total).toBeLessThanOrEqual(100);

    // Cost computed
    expect(result.estimatedMonthlyCostUsd).toBeGreaterThan(0);

    // Findings identified (e.g. SPOF, unscaled read-heavy DB)
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.id.includes('STATIC_SPOF'))).toBe(true);
  });

  it('2. contract: same seed and topology produces byte-identical evaluation result', () => {
    const topo = createE2ETopology();
    const r1 = evaluateTopology(topo, {
      seed: 42,
      evaluatedAt: '2026-09-06T12:00:00.000Z',
    });
    const r2 = evaluateTopology(topo, {
      seed: 42,
      evaluatedAt: '2026-09-06T12:00:00.000Z',
    });

    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('3. full remediation loop: Simulation -> Evaluation -> Remediation -> Proof', () => {
    const initialTopo = createE2ETopology();

    // 1. Initial Evaluation
    const beforeResult = evaluateTopology(initialTopo, {
      seed: 42,
      evaluatedAt: '2026-09-06T12:00:00.000Z',
    });

    // Find the read-heavy DB finding
    const dbFinding = beforeResult.findings.find((f) =>
      f.id.startsWith('UNSCALED_READ_HEAVY_DB'),
    );
    expect(dbFinding).toBeDefined();

    // 2. Apply Trusted Remediation Patch
    const remediatedTopo = applyRemediation(initialTopo, dbFinding!);
    expect(remediatedTopo.nodes.find((n) => n.id === 'db-1')?.kind).toBe('replica');

    // 3. Evaluates Remediated Topology
    const afterResult = evaluateTopology(remediatedTopo, {
      seed: 42,
      evaluatedAt: '2026-09-06T12:00:00.000Z',
    });

    // 4. Calculate Differential
    const diff = calculateEvaluationDiff(beforeResult, afterResult);

    // Finding should be resolved!
    expect(diff.resolvedFindingIds).toContain(dbFinding!.id);
    // Scalability should improve
    expect(diff.scoreDelta.scalability).toBeGreaterThanOrEqual(15);
  });

  it('4. estimateTopologyCost accurately reflects component types and fleets', () => {
    const topo = createE2ETopology();
    // service ($35) + db ($70) = $105
    expect(estimateTopologyCost(topo)).toBe(105);
  });
});
