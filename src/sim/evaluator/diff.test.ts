import { describe, expect, it } from 'vitest';
import { calculateEvaluationDiff, isRegression } from './diff';
import type { EvaluationResult } from './types';

function makeMockResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    version: '1.0',
    topologyHash: 'hash_initial',
    simulatorVersion: '1.0',
    seed: 42,
    scenarios: [
      {
        scenarioId: 'baseline',
        p50Ms: 20,
        p95Ms: 40,
        p99Ms: 60,
        maxQueueDepth: { 'node-1': 10 },
        lostRequests: 10,
        totalRequests: 1000,
        bottleneckNodeId: 'node-1',
        saturationTimeMs: 1500,
      },
    ],
    score: {
      resilience: 60,
      scalability: 65,
      costEfficiency: 80,
      simplicity: 90,
      correctness: 85,
      total: 72,
    },
    findings: [
      {
        id: 'FINDING_A',
        category: 'static',
        severity: 'warning',
        title: 'Finding A',
        description: 'Issue A',
        evidence: [],
      },
      {
        id: 'FINDING_B',
        category: 'empirical',
        severity: 'critical',
        title: 'Finding B',
        description: 'Issue B',
        evidence: [],
      },
    ],
    estimatedMonthlyCostUsd: 200,
    evaluatedAt: '2026-09-06T10:00:00.000Z',
    ...overrides,
  };
}

describe('evaluator calculateEvaluationDiff', () => {
  it('1. correctly computes positive score deltas and resolved findings upon remediation', () => {
    const before = makeMockResult();
    const after = makeMockResult({
      topologyHash: 'hash_remediated',
      scenarios: [
        {
          scenarioId: 'baseline',
          p50Ms: 15,
          p95Ms: 25,
          p99Ms: 35,
          maxQueueDepth: { 'node-1': 0 },
          lostRequests: 0,
          totalRequests: 1000,
          bottleneckNodeId: null,
          saturationTimeMs: null,
        },
      ],
      score: {
        resilience: 90,
        scalability: 95,
        costEfficiency: 70, // Slight cost penalty due to added replica
        simplicity: 85,
        correctness: 100,
        total: 88,
      },
      findings: [
        // FINDING_B resolved, FINDING_A still present
        before.findings[0],
      ],
      estimatedMonthlyCostUsd: 280,
    });

    const diff = calculateEvaluationDiff(before, after);

    expect(diff.scoreDelta.total).toBe(16);
    expect(diff.scoreDelta.resilience).toBe(30);
    expect(diff.scoreDelta.scalability).toBe(30);
    expect(diff.scoreDelta.costEfficiency).toBe(-10);
    expect(diff.scoreDelta.correctness).toBe(15);

    expect(diff.p99DeltaMs).toBe(-25); // Reduced tail latency
    expect(diff.lostRequestsDeltaPct).toBe(-1); // 0% - 1% = -1%
    expect(diff.costDeltaUsd).toBe(80);

    expect(diff.resolvedFindingIds).toEqual(['FINDING_B']);
    expect(diff.newFindingIds).toEqual([]);
    expect(isRegression(diff)).toBe(false);
  });

  it('2. detects regression when new findings appear or score drops', () => {
    const before = makeMockResult();
    const after = makeMockResult({
      topologyHash: 'hash_regressed',
      score: {
        ...before.score,
        total: 60,
      },
      findings: [
        ...before.findings,
        {
          id: 'NEW_REGRESSION_C',
          category: 'static',
          severity: 'critical',
          title: 'Regression',
          description: 'Broken chain',
          evidence: [],
        },
      ],
    });

    const diff = calculateEvaluationDiff(before, after);

    expect(diff.scoreDelta.total).toBe(-12);
    expect(diff.newFindingIds).toEqual(['NEW_REGRESSION_C']);
    expect(isRegression(diff)).toBe(true);
  });

  it('3. preserves iteration provenance IDs', () => {
    const before = makeMockResult();
    const after = makeMockResult();

    const diff = calculateEvaluationDiff(before, after, 'iter-1', 'iter-2');
    expect(diff.fromIterationId).toBe('iter-1');
    expect(diff.toIterationId).toBe('iter-2');
  });
});
