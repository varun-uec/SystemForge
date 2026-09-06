import { describe, expect, it } from 'vitest';
import { evaluateScore, DIMENSION_WEIGHTS } from './score';
import type { Finding, ScenarioTelemetry } from './types';

function createHealthyTelemetry(): ScenarioTelemetry {
  return {
    scenarioId: 'baseline',
    p50Ms: 15,
    p95Ms: 35,
    p99Ms: 45,
    maxQueueDepth: { 'api-1': 0, 'db-1': 0 },
    lostRequests: 0,
    totalRequests: 500,
    bottleneckNodeId: null,
    saturationTimeMs: null,
  };
}

describe('evaluator deterministic score', () => {
  it('1. perfect topology produces 100/100', () => {
    const { score, contributions } = evaluateScore([], [createHealthyTelemetry()], 120);

    expect(score.resilience).toBe(100);
    expect(score.scalability).toBe(100);
    expect(score.costEfficiency).toBe(100);
    expect(score.simplicity).toBe(100);
    expect(score.correctness).toBe(100);
    expect(score.total).toBe(100);
    expect(contributions.length).toBe(0);
  });

  it('2. findings affect only their appropriate dimensions', () => {
    const dbFinding: Finding = {
      id: 'UNSCALED_READ_HEAVY_DB_db-1',
      category: 'static',
      severity: 'warning',
      title: 'Read heavy db without replicas',
      description: 'Single DB handles 90% read traffic',
      nodeId: 'db-1',
      evidence: [
        {
          metric: 'read_fraction',
          scenarioId: 'static_analysis',
          nodeId: 'db-1',
          value: 90,
          unit: 'pct',
        },
      ],
    };

    const { score, contributions } = evaluateScore(
      [dbFinding],
      [createHealthyTelemetry()],
      100,
    );

    // Only scalability is penalized (-15)
    expect(score.scalability).toBe(85);
    expect(score.resilience).toBe(100);
    expect(score.costEfficiency).toBe(100);
    expect(score.simplicity).toBe(100);
    expect(score.correctness).toBe(100);
    expect(contributions.some((c) => c.dimension === 'scalability')).toBe(true);
    expect(contributions.some((c) => c.dimension === 'resilience')).toBe(false);
  });

  it('3. weighted composite is calculated correctly', () => {
    // Disconnected storage finding (-40 correctness)
    const finding: Finding = {
      id: 'DISCONNECTED_STORAGE_client-1',
      category: 'static',
      severity: 'critical',
      title: 'Client cannot reach storage',
      description: 'Dead end client path',
      nodeId: 'client-1',
      evidence: [],
    };

    const { score } = evaluateScore([finding], [createHealthyTelemetry()], 100);
    expect(score.correctness).toBe(60);
    expect(score.resilience).toBe(100);
    expect(score.scalability).toBe(100);
    expect(score.costEfficiency).toBe(100);
    expect(score.simplicity).toBe(100);

    // 100*0.30 + 100*0.25 + 100*0.20 + 100*0.15 + 60*0.10 = 30 + 25 + 20 + 15 + 6 = 96
    const expected = Math.round(
      100 * DIMENSION_WEIGHTS.resilience +
        100 * DIMENSION_WEIGHTS.scalability +
        100 * DIMENSION_WEIGHTS.costEfficiency +
        100 * DIMENSION_WEIGHTS.simplicity +
        60 * DIMENSION_WEIGHTS.correctness,
    );
    expect(score.total).toBe(expected);
    expect(score.total).toBe(96);
  });

  it('4. critical/warning/info severities produce deterministic penalties', () => {
    const warningFinding: Finding = {
      id: 'STATIC_SPOF_api-1',
      category: 'static',
      severity: 'warning',
      title: 'SPOF on api-1',
      description: 'Intermediate cut vertex',
      nodeId: 'api-1',
      evidence: [],
    };

    const criticalFinding: Finding = {
      id: 'UNSTABLE_CAPACITY_db-1',
      category: 'static',
      severity: 'critical',
      title: 'Unstable capacity',
      description: 'rho >= 1.0',
      nodeId: 'db-1',
      evidence: [],
    };

    const { contributions } = evaluateScore(
      [warningFinding, criticalFinding],
      [createHealthyTelemetry()],
      100,
    );

    const spof = contributions.find(
      (c) => c.findingId === 'STATIC_SPOF_api-1' && c.dimension === 'resilience',
    );
    const unstable = contributions.find(
      (c) => c.findingId === 'UNSTABLE_CAPACITY_db-1',
    );

    expect(spof?.penalty).toBe(15);
    expect(unstable?.penalty).toBe(25);
  });

  it('5. related evidence on the same root cause does not cause double-counting', () => {
    // 3 findings all targeting db-primary capacity
    const unstableFinding: Finding = {
      id: 'UNSTABLE_CAPACITY_db-primary',
      category: 'static',
      severity: 'critical',
      title: 'Unstable capacity on db-primary',
      description: 'rho = 1.42',
      nodeId: 'db-primary',
      evidence: [
        {
          metric: 'traffic_intensity',
          scenarioId: 'static',
          nodeId: 'db-primary',
          value: 1.42,
          unit: 'ratio',
        },
        {
          metric: 'arrival_rate',
          scenarioId: 'static',
          nodeId: 'db-primary',
          value: 300,
          unit: 'rps',
        },
      ],
    };

    const readHeavyFinding: Finding = {
      id: 'UNSCALED_READ_HEAVY_DB_db-primary',
      category: 'static',
      severity: 'warning',
      title: 'Read heavy db',
      description: 'readFraction = 0.95',
      nodeId: 'db-primary',
      evidence: [
        {
          metric: 'read_fraction',
          scenarioId: 'static',
          nodeId: 'db-primary',
          value: 95,
          unit: 'pct',
        },
      ],
    };

    const empiricalFinding: Finding = {
      id: 'EMPIRICAL_SATURATION_traffic_spike_db-primary',
      category: 'empirical',
      severity: 'critical',
      title: 'Observed saturation on db-primary',
      description: 'Saturated at t=1800ms',
      nodeId: 'db-primary',
      evidence: [
        {
          metric: 'lost_requests',
          scenarioId: 'traffic_spike',
          nodeId: 'db-primary',
          value: 50,
          unit: 'count',
        },
        {
          metric: 'saturation_time',
          scenarioId: 'traffic_spike',
          nodeId: 'db-primary',
          value: 1800,
          unit: 'ms',
        },
      ],
    };

    const { score, contributions } = evaluateScore(
      [unstableFinding, readHeavyFinding, empiricalFinding],
      [createHealthyTelemetry()],
      100,
    );

    // On scalability, all 3 belong to rootCause 'node:db-primary'.
    // Dominant penalty is 25 (critical), NOT 25 + 15 + 25 = 65!
    expect(score.scalability).toBe(75);

    const scalabilityContrib = contributions.find((c) => c.dimension === 'scalability');
    expect(scalabilityContrib).toBeDefined();
    expect(scalabilityContrib?.penalty).toBe(25);

    // Evidence from all three findings must be preserved in the contribution!
    const metricNames = scalabilityContrib?.evidence.map((e) => e.metric);
    expect(metricNames).toContain('traffic_intensity');
    expect(metricNames).toContain('read_fraction');
    expect(metricNames).toContain('lost_requests');
    expect(metricNames).toContain('saturation_time');
  });

  it('6. spike telemetry with measured request loss reduces resilience appropriately', () => {
    const spikeLossTelemetry: ScenarioTelemetry = {
      scenarioId: 'traffic_spike',
      p50Ms: 200,
      p95Ms: 1200,
      p99Ms: 2400,
      maxQueueDepth: { 'db-1': 64 },
      lostRequests: 120,
      totalRequests: 500, // 24% loss rate
      bottleneckNodeId: 'db-1',
      saturationTimeMs: 1200,
    };

    const { score } = evaluateScore([], [spikeLossTelemetry], 100);
    expect(score.resilience).toBeLessThanOrEqual(75);
    expect(score.scalability).toBeLessThanOrEqual(80); // Also hit by high p99
  });

  it('7. high measured p99 affects scalability', () => {
    const highLatencyTelemetry: ScenarioTelemetry = {
      scenarioId: 'baseline',
      p50Ms: 100,
      p95Ms: 1500,
      p99Ms: 2200, // > 2000ms triggers tail latency penalty
      maxQueueDepth: {},
      lostRequests: 0,
      totalRequests: 500,
      bottleneckNodeId: null,
      saturationTimeMs: null,
    };

    const { score, contributions } = evaluateScore([], [highLatencyTelemetry], 100);
    expect(score.scalability).toBe(80); // 100 - 20 = 80
    expect(
      contributions.some((c) => c.findingId.startsWith('HIGH_TAIL_LATENCY_')),
    ).toBe(true);
  });

  it('8. cost efficiency is deterministic and scales with monthly spend', () => {
    const cheap = evaluateScore([], [createHealthyTelemetry()], 100);
    expect(cheap.score.costEfficiency).toBe(100);

    const moderate = evaluateScore([], [createHealthyTelemetry()], 360);
    expect(moderate.score.costEfficiency).toBe(85); // 100 - round((360-150)/14) = 100 - 15 = 85

    const expensive = evaluateScore([], [createHealthyTelemetry()], 1200);
    expect(expensive.score.costEfficiency).toBe(57); // 100 - (25 + round(700/40)) = 100 - 43 = 57
  });

  it('9. same inputs always produce byte-identical results', () => {
    const findings: Finding[] = [
      {
        id: 'STATIC_SPOF_node-a',
        category: 'static',
        severity: 'warning',
        title: 'SPOF',
        description: 'SPOF desc',
        nodeId: 'node-a',
        evidence: [],
      },
    ];
    const telemetry = [createHealthyTelemetry()];
    const cost = 450;

    const res1 = evaluateScore(findings, telemetry, cost);
    const res2 = evaluateScore(findings, telemetry, cost);

    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
  });

  it('10. no mutation of findings or telemetry inputs', () => {
    const findings: Finding[] = [
      {
        id: 'STATIC_SPOF_node-a',
        category: 'static',
        severity: 'warning',
        title: 'SPOF',
        description: 'SPOF desc',
        nodeId: 'node-a',
        evidence: [
          { metric: 'redundancy', scenarioId: 'static', value: 0, unit: 'count' },
        ],
      },
    ];
    const telemetry = [createHealthyTelemetry()];

    const beforeFindingsJson = JSON.stringify(findings);
    const beforeTelemetryJson = JSON.stringify(telemetry);

    evaluateScore(findings, telemetry, 500);

    expect(JSON.stringify(findings)).toBe(beforeFindingsJson);
    expect(JSON.stringify(telemetry)).toBe(beforeTelemetryJson);
  });
});
