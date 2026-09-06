import type {
  EvaluationDiff,
  EvaluationResult,
  EvaluationScore,
  HistoryIteration,
} from './types';

/**
 * Computes an immutable, deterministic diff between two evaluation results.
 *
 * Quantifies exact improvements or regressions across:
 * - 5 score dimensions (resilience, scalability, cost efficiency, simplicity, correctness)
 * - Measured worst-case tail latency (p99)
 * - Lost request percentages
 * - Monthly compute cost
 * - Resolved vs newly introduced architectural findings
 */
export function calculateEvaluationDiff(
  before: EvaluationResult,
  after: EvaluationResult,
  fromIterationId?: string,
  toIterationId?: string,
): EvaluationDiff {
  const fromId = fromIterationId ?? before.topologyHash;
  const toId = toIterationId ?? after.topologyHash;

  const scoreDelta: EvaluationScore = {
    resilience: after.score.resilience - before.score.resilience,
    scalability: after.score.scalability - before.score.scalability,
    costEfficiency: after.score.costEfficiency - before.score.costEfficiency,
    simplicity: after.score.simplicity - before.score.simplicity,
    correctness: after.score.correctness - before.score.correctness,
    total: after.score.total - before.score.total,
  };

  // Measured peak tail latency comparison
  const beforeMaxP99 =
    before.scenarios.length > 0 ? Math.max(...before.scenarios.map((s) => s.p99Ms)) : 0;
  const afterMaxP99 =
    after.scenarios.length > 0 ? Math.max(...after.scenarios.map((s) => s.p99Ms)) : 0;
  const p99DeltaMs = Math.round((afterMaxP99 - beforeMaxP99) * 10) / 10;

  // Aggregate lost request percentage comparison
  const beforeLost = before.scenarios.reduce((sum, s) => sum + s.lostRequests, 0);
  const beforeTotal = before.scenarios.reduce((sum, s) => sum + s.totalRequests, 0);
  const beforeLostPct = beforeTotal > 0 ? (beforeLost / beforeTotal) * 100 : 0;

  const afterLost = after.scenarios.reduce((sum, s) => sum + s.lostRequests, 0);
  const afterTotal = after.scenarios.reduce((sum, s) => sum + s.totalRequests, 0);
  const afterLostPct = afterTotal > 0 ? (afterLost / afterTotal) * 100 : 0;

  const lostRequestsDeltaPct = Math.round((afterLostPct - beforeLostPct) * 100) / 100;

  // Monthly compute cost delta
  const costDeltaUsd =
    Math.round((after.estimatedMonthlyCostUsd - before.estimatedMonthlyCostUsd) * 100) /
    100;

  // Finding resolution and introduction
  const beforeFindingIds = new Set(before.findings.map((f) => f.id));
  const afterFindingIds = new Set(after.findings.map((f) => f.id));

  const resolvedFindingIds = Array.from(beforeFindingIds)
    .filter((id) => !afterFindingIds.has(id))
    .sort();

  const newFindingIds = Array.from(afterFindingIds)
    .filter((id) => !beforeFindingIds.has(id))
    .sort();

  return {
    fromIterationId: fromId,
    toIterationId: toId,
    scoreDelta,
    p99DeltaMs,
    lostRequestsDeltaPct,
    costDeltaUsd,
    resolvedFindingIds,
    newFindingIds,
  };
}

/**
 * Computes the diff between two history iterations.
 */
export function calculateIterationDiff(
  before: HistoryIteration,
  after: HistoryIteration,
): EvaluationDiff {
  return calculateEvaluationDiff(before.result, after.result, before.id, after.id);
}

/**
 * Checks if a diff represents an overall architectural regression.
 */
export function isRegression(diff: EvaluationDiff): boolean {
  return (
    diff.scoreDelta.total < 0 ||
    diff.lostRequestsDeltaPct > 0 ||
    diff.newFindingIds.length > 0
  );
}
