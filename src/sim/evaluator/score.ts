import type {
  Evidence,
  Finding,
  EvaluationScore,
  ScenarioTelemetry,
  ScoreContribution,
  ScoreDimension,
} from './types';

export const DIMENSION_WEIGHTS: Readonly<Record<ScoreDimension, number>> = {
  resilience: 0.3,
  scalability: 0.25,
  costEfficiency: 0.2,
  simplicity: 0.15,
  correctness: 0.1,
} as const;

interface CandidatePenalty {
  readonly rootCauseKey: string;
  readonly findingId: string;
  readonly dimension: ScoreDimension;
  readonly penalty: number;
  readonly evidence: readonly Evidence[];
}

/**
 * Maps a finding to one or more candidate dimensional penalties and determines
 * its root-cause grouping key (e.g. node, edge, or structural topic).
 */
function extractFindingCandidates(finding: Finding): CandidatePenalty[] {
  const candidates: CandidatePenalty[] = [];
  const rootKey = finding.nodeId
    ? `node:${finding.nodeId}`
    : finding.edgeId
      ? `edge:${finding.edgeId}`
      : `finding:${finding.id}`;

  if (finding.id.startsWith('DISCONNECTED_STORAGE_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'correctness',
      penalty: 40,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('CYCLIC_DEPENDENCY_')) {
    candidates.push({
      rootCauseKey: 'structural:cyclic_dependency',
      findingId: finding.id,
      dimension: 'simplicity',
      penalty: 25,
      evidence: finding.evidence,
    });
    candidates.push({
      rootCauseKey: 'structural:cyclic_dependency',
      findingId: finding.id,
      dimension: 'correctness',
      penalty: 25,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('STATIC_SPOF_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'resilience',
      penalty: 15,
      evidence: finding.evidence,
    });
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'simplicity',
      penalty: 10,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('SYNC_LATENCY_UNPROTECTED_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'resilience',
      penalty: 15,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('CACHE_MISS_AMPLIFICATION_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'resilience',
      penalty: 10,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('UNSCALED_READ_HEAVY_DB_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'scalability',
      penalty: 15,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('UNSTABLE_CAPACITY_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'scalability',
      penalty: 25,
      evidence: finding.evidence,
    });
  } else if (finding.id.startsWith('EMPIRICAL_SATURATION_')) {
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'scalability',
      penalty: 25,
      evidence: finding.evidence,
    });
    // If request drops occurred, it also directly penalizes resilience
    const hasDrops = finding.evidence.some(
      (e) => e.metric === 'lost_requests' && e.value > 0,
    );
    if (hasDrops) {
      candidates.push({
        rootCauseKey: rootKey,
        findingId: finding.id,
        dimension: 'resilience',
        penalty: 25,
        evidence: finding.evidence,
      });
    }
  } else {
    // General fallback based strictly on finding severity
    const defaultPenalty =
      finding.severity === 'critical' ? 25 : finding.severity === 'warning' ? 15 : 5;
    candidates.push({
      rootCauseKey: rootKey,
      findingId: finding.id,
      dimension: 'resilience',
      penalty: defaultPenalty,
      evidence: finding.evidence,
    });
  }

  return candidates;
}

/**
 * Evaluates empirical telemetry across all scenarios to detect unlinked tail latency
 * or global request drops not already attributed to a specific node finding.
 */
function extractTelemetryCandidates(
  telemetry: readonly ScenarioTelemetry[],
  claimedRootKeys: ReadonlySet<string>,
): CandidatePenalty[] {
  const candidates: CandidatePenalty[] = [];

  let maxP99 = 0;
  let worstP99Scenario: ScenarioTelemetry | null = null;

  for (const t of telemetry) {
    if (t.p99Ms > maxP99) {
      maxP99 = t.p99Ms;
      worstP99Scenario = t;
    }

    // Unattributed request drop check (if bottleneck node was null or not claimed)
    if (t.lostRequests > 0) {
      const rootKey = t.bottleneckNodeId
        ? `node:${t.bottleneckNodeId}`
        : `telemetry:drops:${t.scenarioId}`;
      if (!claimedRootKeys.has(`${rootKey}:resilience`)) {
        const lossRatio = t.totalRequests > 0 ? t.lostRequests / t.totalRequests : 0;
        const penalty = lossRatio >= 0.05 ? 25 : lossRatio >= 0.001 ? 15 : 5;
        candidates.push({
          rootCauseKey: rootKey,
          findingId: `UNATTRIBUTED_DROPS_${t.scenarioId}`,
          dimension: 'resilience',
          penalty,
          evidence: [
            {
              metric: 'lost_requests',
              scenarioId: t.scenarioId,
              nodeId: t.bottleneckNodeId ?? undefined,
              value: t.lostRequests,
              unit: 'count',
              threshold: 0,
            },
          ],
        });
      }
    }
  }

  // Tail latency penalty on scalability
  if (worstP99Scenario && maxP99 > 500) {
    const p99Penalty = maxP99 > 2000 ? 20 : maxP99 > 1000 ? 10 : 5;
    candidates.push({
      rootCauseKey: 'telemetry:tail_latency',
      findingId: `HIGH_TAIL_LATENCY_${worstP99Scenario.scenarioId}`,
      dimension: 'scalability',
      penalty: p99Penalty,
      evidence: [
        {
          metric: 'p99_latency',
          scenarioId: worstP99Scenario.scenarioId,
          value: Math.round(maxP99),
          unit: 'ms',
          threshold: 500,
        },
      ],
    });
  }

  return candidates;
}

/**
 * Calculates a deterministic cost efficiency penalty from monthly cloud compute spend.
 * Grounded in typical Breakscale preset spend profiles ($50 - $1,500/mo).
 */
function calculateCostContribution(
  estimatedMonthlyCostUsd: number,
): ScoreContribution | null {
  if (estimatedMonthlyCostUsd <= 150) {
    return null;
  }

  let penalty = 0;
  if (estimatedMonthlyCostUsd <= 500) {
    // $150 to $500: up to 25 pts
    penalty = Math.min(25, Math.round((estimatedMonthlyCostUsd - 150) / 14));
  } else if (estimatedMonthlyCostUsd <= 1500) {
    // $500 to $1500: 25 to 50 pts
    penalty = Math.min(50, 25 + Math.round((estimatedMonthlyCostUsd - 500) / 40));
  } else {
    // > $1500: capped at 75 pts
    penalty = Math.min(75, 50 + Math.round((estimatedMonthlyCostUsd - 1500) / 100));
  }

  return {
    findingId: 'COST_OVERHEAD',
    dimension: 'costEfficiency',
    penalty,
    evidence: [
      {
        metric: 'estimated_monthly_cost',
        scenarioId: 'cost_model',
        value: Math.round(estimatedMonthlyCostUsd),
        unit: 'usd',
        threshold: 150,
      },
    ],
  };
}

/**
 * Groups candidate penalties by (dimension, rootCauseKey) to prevent double-counting
 * multiple symptoms of the same underlying root cause.
 */
function groupContributions(
  candidates: readonly CandidatePenalty[],
): ScoreContribution[] {
  const groups = new Map<string, CandidatePenalty[]>();

  for (const c of candidates) {
    const groupKey = `${c.dimension}:::${c.rootCauseKey}`;
    const list = groups.get(groupKey);
    if (list) {
      list.push(c);
    } else {
      groups.set(groupKey, [c]);
    }
  }

  const contributions: ScoreContribution[] = [];

  for (const list of groups.values()) {
    // 1. Take the dominant penalty for this root cause on this dimension
    const dominantPenalty = Math.max(...list.map((c) => c.penalty));

    // 2. Select primary finding id (critical/highest penalty first)
    const sorted = [...list].sort((a, b) => b.penalty - a.penalty);
    const primaryFindingId = sorted[0].findingId;
    const dimension = sorted[0].dimension;

    // 3. Combine and deduplicate supporting evidence across all related findings
    const evidenceMap = new Map<string, Evidence>();
    for (const item of list) {
      for (const ev of item.evidence) {
        const evKey = `${ev.metric}:${ev.scenarioId}:${ev.nodeId ?? ''}:${ev.edgeId ?? ''}`;
        if (!evidenceMap.has(evKey)) {
          evidenceMap.set(evKey, ev);
        }
      }
    }

    contributions.push({
      findingId: primaryFindingId,
      dimension,
      penalty: dominantPenalty,
      evidence: Array.from(evidenceMap.values()),
    });
  }

  return contributions;
}

/**
 * Deterministically evaluates an architectural topology score across 5 weighted dimensions.
 *
 * Guaranteed:
 * - Same findings + telemetry + cost produces byte-identical score.
 * - Anti-double-counting: Symptoms of the same root cause are grouped into a single penalty.
 * - Non-mutating: Inputs are never modified.
 */
export function evaluateScore(
  findings: readonly Finding[],
  telemetry: readonly ScenarioTelemetry[],
  estimatedMonthlyCostUsd: number,
): {
  score: EvaluationScore;
  contributions: readonly ScoreContribution[];
} {
  const findingCandidates: CandidatePenalty[] = [];
  const claimedRootKeys = new Set<string>();

  for (const f of findings) {
    const extracted = extractFindingCandidates(f);
    for (const c of extracted) {
      findingCandidates.push(c);
      claimedRootKeys.add(`${c.rootCauseKey}:${c.dimension}`);
    }
  }

  const telemetryCandidates = extractTelemetryCandidates(telemetry, claimedRootKeys);
  const allCandidates = [...findingCandidates, ...telemetryCandidates];

  const contributions = groupContributions(allCandidates);

  // Add cost contribution if applicable
  const costContribution = calculateCostContribution(estimatedMonthlyCostUsd);
  if (costContribution) {
    contributions.push(costContribution);
  }

  // Sum penalties per dimension
  const penalties: Record<ScoreDimension, number> = {
    resilience: 0,
    scalability: 0,
    costEfficiency: 0,
    simplicity: 0,
    correctness: 0,
  };

  for (const c of contributions) {
    penalties[c.dimension] += c.penalty;
  }

  const resilience = Math.max(0, Math.min(100, Math.round(100 - penalties.resilience)));
  const scalability = Math.max(
    0,
    Math.min(100, Math.round(100 - penalties.scalability)),
  );
  const costEfficiency = Math.max(
    0,
    Math.min(100, Math.round(100 - penalties.costEfficiency)),
  );
  const simplicity = Math.max(0, Math.min(100, Math.round(100 - penalties.simplicity)));
  const correctness = Math.max(
    0,
    Math.min(100, Math.round(100 - penalties.correctness)),
  );

  const total = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        resilience * DIMENSION_WEIGHTS.resilience +
          scalability * DIMENSION_WEIGHTS.scalability +
          costEfficiency * DIMENSION_WEIGHTS.costEfficiency +
          simplicity * DIMENSION_WEIGHTS.simplicity +
          correctness * DIMENSION_WEIGHTS.correctness,
      ),
    ),
  );

  return {
    score: {
      resilience,
      scalability,
      costEfficiency,
      simplicity,
      correctness,
      total,
    },
    contributions,
  };
}
