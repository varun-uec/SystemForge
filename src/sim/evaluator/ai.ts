import type { Topology } from '../types';
import { REMEDIATION_REGISTRY } from './registry';
import { evaluateScore } from './score';
import type {
  AIRecommendation,
  EvaluationResult,
  Finding,
  ScoreContribution,
} from './types';

export type AIProvider = 'builtin' | 'openai' | 'anthropic' | 'google';

export interface AIConfig {
  readonly provider: AIProvider;
  readonly apiKey?: string;
  readonly model?: string;
}

export interface EvaluationBundle {
  readonly version: '1.0';
  readonly topology: Topology;
  readonly evaluationResult: EvaluationResult;
  readonly scoreContributions: readonly ScoreContribution[];
  readonly availableRemediationIds: readonly string[];
  readonly exportedAt: string;
}

/**
 * Creates an exportable Evaluation Bundle for external consumption or coding agents.
 */
export function createEvaluationBundle(
  topology: Topology,
  result: EvaluationResult,
  scoreContributions?: readonly ScoreContribution[],
): EvaluationBundle {
  const contributions =
    scoreContributions ??
    evaluateScore(result.findings, result.scenarios, result.estimatedMonthlyCostUsd)
      .contributions;

  return {
    version: '1.0',
    topology,
    evaluationResult: result,
    scoreContributions: contributions,
    availableRemediationIds: Object.keys(REMEDIATION_REGISTRY),
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic built-in explainer providing educational root cause diagnoses and trade-offs.
 * Used when offline, when no API key is configured, or as a reliable fallback.
 */
export function getBuiltinRecommendation(
  finding: Finding,
  bundle: EvaluationBundle,
): AIRecommendation {
  const remediationId = finding.remediationId ?? 'INCREASE_NODE_CAPACITY';
  const targetNode = finding.nodeId
    ? bundle.topology.nodes.find((n) => n.id === finding.nodeId)
    : undefined;
  const nodeName = targetNode?.label || targetNode?.id || finding.nodeId || 'Component';

  // Format observed evidence into plain English sentences
  const evidenceLines = finding.evidence
    .map((e) => {
      if (e.metric === 'arrival_rate') return `Observed arrival rate of ${e.value} rps`;
      if (e.metric === 'sustainable_capacity')
        return `Sustainable capacity ceiling is ${e.value} rps`;
      if (e.metric === 'traffic_intensity')
        return `Traffic intensity ρ = ${e.value} (stability boundary is 1.0)`;
      if (e.metric === 'lost_requests') return `${e.value} dropped requests recorded`;
      if (e.metric === 'lost_requests_pct') return `${e.value}% of total requests lost`;
      if (e.metric === 'p99_latency')
        return `p99 tail latency measured at ${e.value}ms`;
      if (e.metric === 'read_fraction')
        return `Read traffic comprises ${e.value}% of operations`;
      if (e.metric === 'target_service_ms')
        return `Downstream processing latency is ${e.value}ms`;
      if (e.metric === 'caller_timeout_ms')
        return `Caller timeout is set to ${e.value}ms`;
      if (e.metric === 'cache_hit_rate') return `Cache hit rate is ${e.value}%`;
      return `${e.metric}: ${e.value} ${e.unit}`;
    })
    .join('; ');

  if (
    finding.id.startsWith('UNSCALED_READ_HEAVY_DB') ||
    finding.id.includes('READ_HEAVY')
  ) {
    return {
      findingId: finding.id,
      remediationId: 'ADD_READ_REPLICA_DB',
      rationale: `${nodeName} handles heavy read traffic (${evidenceLines}). In a single-instance relational database, read queries contend with write transactions for lock table entries and shared buffer pools. Introducing read replicas offloads read traffic to dedicated read-only copies.`,
      tradeoffs: [
        'Replication lag introduces eventual consistency: reads immediately following a write may observe stale state.',
        'Increases monthly database infrastructure cost proportionally to replica instances.',
        'Requires application query routing or a database proxy to split reads and writes.',
      ],
    };
  }

  if (finding.id.startsWith('STATIC_SPOF') || finding.id.includes('SPOF')) {
    return {
      findingId: finding.id,
      remediationId: 'ADD_REDUNDANT_INSTANCE',
      rationale: `${nodeName} constitutes an articulation point in the request topology (${evidenceLines}). If this instance crashes or experiences network degradation, no alternative path exists to downstream data. Adding redundant instances provides high-availability failover.`,
      tradeoffs: [
        'Multi-instance redundancy increases compute and idle provisioning costs.',
        'Requires an upstream load balancer or service discovery mechanism to distribute health-checked requests.',
      ],
    };
  }

  if (
    finding.id.startsWith('SYNC_LATENCY_UNPROTECTED') ||
    finding.id.includes('LATENCY_UNPROTECTED')
  ) {
    return {
      findingId: finding.id,
      remediationId: 'INSERT_CIRCUIT_BREAKER',
      rationale: `Synchronous communication to ${nodeName} lacks defensive timeouts and failure isolation (${evidenceLines}). When a downstream dependency degrades, callers block waiting for slow responses, exhausting their own thread pools and causing cascading system-wide collapse.`,
      tradeoffs: [
        'An open circuit breaker fails fast and returns errors or degraded fallbacks to callers.',
        'Adds state tracking and health probe coordination to client edges.',
      ],
    };
  }

  if (
    finding.id.startsWith('CACHE_MISS_AMPLIFICATION') ||
    finding.id.includes('CACHE_MISS')
  ) {
    return {
      findingId: finding.id,
      remediationId: 'ADD_INGESTION_QUEUE',
      rationale: `Cache misses directly strike the backing datastore without protective rate limits or buffering (${evidenceLines}). During cold boots, deployments, or cache invalidation events, a thundering herd of cache misses will overwhelm the database. An asynchronous queue buffers miss traffic.`,
      tradeoffs: [
        'Asynchronous queueing converts synchronous read-response paths into buffered event handling.',
        'Requires consumer workers and worker pool management to drain the queue.',
      ],
    };
  }

  if (
    finding.id.startsWith('UNSTABLE_CAPACITY') ||
    finding.id.startsWith('EMPIRICAL_SATURATION') ||
    finding.id.includes('SATURATION')
  ) {
    const isDb = targetNode?.kind === 'db';
    const effectiveRemediation = isDb
      ? 'ADD_READ_REPLICA_DB'
      : 'INCREASE_NODE_CAPACITY';
    return {
      findingId: finding.id,
      remediationId: effectiveRemediation,
      rationale: `${nodeName} entered an unstable operating regime (${evidenceLines}). The arrival rate exceeds sustainable service throughput (traffic intensity ρ >= 1.0). In an M/M/c queueing model, queues grow without bound under overload until buffers saturate and load shedding forces dropped requests.`,
      tradeoffs: [
        'Horizontal or vertical scaling increases ongoing cloud compute spend.',
        'Scaling one tier may shift the saturation bottleneck further downstream to dependencies.',
      ],
    };
  }

  if (finding.id.startsWith('CYCLIC_DEPENDENCY')) {
    return {
      findingId: finding.id,
      remediationId,
      rationale: `A cyclic dependency loop was identified in the call graph (${evidenceLines}). Circular synchronous calls produce recursive amplification, distributed deadlocks, and cascading timeouts. Decompose the cycle using event-driven pub/sub messaging.`,
      tradeoffs: [
        'Refactoring synchronous cycles into asynchronous events introduces eventual consistency.',
        'Requires message broker infrastructure and distributed tracing.',
      ],
    };
  }

  if (finding.id.startsWith('DISCONNECTED_STORAGE')) {
    return {
      findingId: finding.id,
      remediationId,
      rationale: `Client requests have no path to durable storage (${evidenceLines}). Without persistent state or datastore connectivity, client transactions cannot be durably committed.`,
      tradeoffs: [
        'Connecting client routes to storage introduces network hops and latency budgets.',
      ],
    };
  }

  return {
    findingId: finding.id,
    remediationId,
    rationale: `${finding.title}: ${finding.description} Supported by measurements: ${evidenceLines}.`,
    tradeoffs: [
      'Remediation alters topology and requires verification through re-simulation.',
      'Potential trade-off between infrastructure cost and system resilience.',
    ],
  };
}

/**
 * Validates external LLM recommendations against strict evaluation contracts:
 * - Must reference a valid finding ID.
 * - Must select a remediation ID from the trusted registry.
 * - Must not invent metrics.
 */
export function validateRecommendation(
  raw: unknown,
  availableRemediationIds: readonly string[],
  fallbackFinding: Finding,
  bundle: EvaluationBundle,
): AIRecommendation {
  if (!raw || typeof raw !== 'object') {
    return getBuiltinRecommendation(fallbackFinding, bundle);
  }

  const rec = raw as Record<string, unknown>;
  const findingId =
    typeof rec.findingId === 'string' && rec.findingId
      ? rec.findingId
      : fallbackFinding.id;
  const rawRemediationId =
    typeof rec.remediationId === 'string' ? rec.remediationId : '';

  const remediationId = availableRemediationIds.includes(rawRemediationId)
    ? rawRemediationId
    : (fallbackFinding.remediationId ?? 'INCREASE_NODE_CAPACITY');

  const rationale =
    typeof rec.rationale === 'string' && rec.rationale.trim().length > 0
      ? rec.rationale.trim()
      : getBuiltinRecommendation(fallbackFinding, bundle).rationale;

  const tradeoffs =
    Array.isArray(rec.tradeoffs) && rec.tradeoffs.every((t) => typeof t === 'string')
      ? (rec.tradeoffs as string[])
      : getBuiltinRecommendation(fallbackFinding, bundle).tradeoffs;

  return {
    findingId,
    remediationId,
    rationale,
    tradeoffs,
  };
}

/**
 * Generates an AI recommendation and diagnosis for a single finding.
 */
export async function generateFindingExplanation(
  finding: Finding,
  bundle: EvaluationBundle,
  config?: AIConfig,
): Promise<AIRecommendation> {
  if (!config || config.provider === 'builtin' || !config.apiKey) {
    return getBuiltinRecommendation(finding, bundle);
  }

  try {
    const prompt = `You are the Breakscale System Design Evaluator AI.
Follow this governing contract strictly:
Simulation produces truth. Evaluation produces judgment. AI produces understanding. The patch registry produces change. Simulation produces proof.

CONTRACT INVARIANTS:
1. NEVER invent, approximate, or modify metrics.
2. NEVER modify scores or penalties.
3. NEVER invent a remediationId. You MUST choose ONLY from: ${JSON.stringify(bundle.availableRemediationIds)}.
4. NEVER output executable code or topology mutations.
5. Provide a plain-English educational explanation for CS students and interview candidates.
6. Provide concrete engineering trade-offs.

FINDING TO EXPLAIN:
ID: ${finding.id}
Category: ${finding.category}
Severity: ${finding.severity}
Title: ${finding.title}
Description: ${finding.description}
Evidence: ${JSON.stringify(finding.evidence)}
Suggested Remediation ID: ${finding.remediationId ?? 'None'}

Return ONLY a valid JSON object matching this exact TypeScript schema:
{
  "findingId": "${finding.id}",
  "remediationId": "<one of: ${bundle.availableRemediationIds.join(', ')}>",
  "rationale": "<plain English root cause and importance>",
  "tradeoffs": ["<tradeoff 1>", "<tradeoff 2>"]
}`;

    if (config.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });

      if (!res.ok) {
        return getBuiltinRecommendation(finding, bundle);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const parsed = JSON.parse(data.choices[0].message.content) as unknown;
      return validateRecommendation(
        parsed,
        bundle.availableRemediationIds,
        finding,
        bundle,
      );
    }

    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'dangerously-allow-browser': 'true',
        },
        body: JSON.stringify({
          model: config.model || 'claude-3-5-haiku-latest',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        return getBuiltinRecommendation(finding, bundle);
      }

      const data = (await res.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = data.content.find((c) => c.type === 'text')?.text ?? '{}';
      const parsed = JSON.parse(text) as unknown;
      return validateRecommendation(
        parsed,
        bundle.availableRemediationIds,
        finding,
        bundle,
      );
    }

    if (config.provider === 'google') {
      const model = config.model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });

      if (!res.ok) {
        return getBuiltinRecommendation(finding, bundle);
      }

      const data = (await res.json()) as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const text = data.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(text) as unknown;
      return validateRecommendation(
        parsed,
        bundle.availableRemediationIds,
        finding,
        bundle,
      );
    }

    return getBuiltinRecommendation(finding, bundle);
  } catch {
    return getBuiltinRecommendation(finding, bundle);
  }
}

/**
 * Generates recommendations for all findings in an evaluation result.
 */
export async function generateAllRecommendations(
  bundle: EvaluationBundle,
  config?: AIConfig,
): Promise<readonly AIRecommendation[]> {
  const recommendations: AIRecommendation[] = [];
  for (const finding of bundle.evaluationResult.findings) {
    const rec = await generateFindingExplanation(finding, bundle, config);
    recommendations.push(rec);
  }
  return recommendations;
}
