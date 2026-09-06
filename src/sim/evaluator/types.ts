import type { FailureKind, FailureOpts, NodeKind, Topology } from '../types';

export const SIMULATOR_VERSION = '1.0';

/* ---------------- Structured Evidence ---------------- */

export interface Evidence {
  readonly metric: string;
  readonly scenarioId: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly value: number;
  readonly unit: 'ms' | 'rps' | 'count' | 'pct' | 'ratio' | 'usd';
  readonly threshold?: number;
}

/* ---------------- Findings & Scoring ---------------- */

export type Severity = 'info' | 'warning' | 'critical';
export type FindingCategory = 'static' | 'empirical';

export interface Finding {
  readonly id: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly title: string;
  readonly description: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly evidence: readonly Evidence[];
  readonly remediationId?: string;
}

export type ScoreDimension =
  'resilience' | 'scalability' | 'costEfficiency' | 'simplicity' | 'correctness';

export interface ScoreContribution {
  readonly findingId: string;
  readonly dimension: ScoreDimension;
  readonly penalty: number;
  readonly evidence: readonly Evidence[];
}

export interface EvaluationScore {
  readonly resilience: number;
  readonly scalability: number;
  readonly costEfficiency: number;
  readonly simplicity: number;
  readonly correctness: number;
  readonly total: number;
}

/* ---------------- Scenarios & Telemetry ---------------- */

export interface ScenarioFault {
  readonly kind: FailureKind;
  readonly target: string | { readonly nodeKind: NodeKind };
  readonly opts?: FailureOpts;
  readonly atMs?: number;
}

export interface EvaluationScenario {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
  readonly trafficMultiplier: number;
  readonly faults?: readonly ScenarioFault[];
}

/**
 * Empirical telemetry recorded directly from simulator measurements.
 *
 * Latency percentiles strictly reflect the engine's LatencyRing reservoir (p50, p95, p99),
 * preserving the project contract that metrics are measured rather than approximated.
 */
export interface ScenarioTelemetry {
  readonly scenarioId: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxQueueDepth: Readonly<Record<string, number>>;
  readonly lostRequests: number;
  readonly totalRequests: number;
  readonly bottleneckNodeId: string | null;
  readonly saturationTimeMs: number | null;
}

/* ---------------- Immutable Versioned Result ---------------- */

export interface EvaluationResult {
  readonly version: '1.0';
  readonly topologyHash: string;
  readonly simulatorVersion: string;
  readonly seed: number;
  readonly scenarios: readonly ScenarioTelemetry[];
  readonly score: EvaluationScore;
  readonly findings: readonly Finding[];
  readonly estimatedMonthlyCostUsd: number;
  readonly evaluatedAt: string;
}

/* ---------------- Evaluation Options ---------------- */

export interface EvaluationOptions {
  readonly seed: number;
  readonly simulatorVersion: string;
  readonly scenarios?: readonly EvaluationScenario[];
  readonly estimatedMonthlyCostUsd?: number;
  readonly evaluatedAt?: string;
}

/* ---------------- AI Boundary ---------------- */

export interface AIRecommendation {
  readonly findingId: string;
  readonly remediationId: string;
  readonly rationale: string;
  readonly tradeoffs: readonly string[];
}

/* ---------------- Experiment History ---------------- */

export interface HistoryIteration {
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly appliedRemediationId?: string;
  readonly topology: Topology;
  readonly result: EvaluationResult;
}

export interface EvaluationDiff {
  readonly fromIterationId: string;
  readonly toIterationId: string;
  readonly scoreDelta: EvaluationScore;
  readonly p99DeltaMs: number;
  readonly lostRequestsDeltaPct: number;
  readonly costDeltaUsd: number;
  readonly resolvedFindingIds: readonly string[];
  readonly newFindingIds: readonly string[];
}
