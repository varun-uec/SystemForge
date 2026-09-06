import { describe, expect, it } from 'vitest';
import {
  createEvaluationBundle,
  getBuiltinRecommendation,
  validateRecommendation,
  generateFindingExplanation,
  generateAllRecommendations,
} from './ai';
import { evaluateTopology } from './index';
import { REMEDIATION_REGISTRY } from './registry';
import type { Finding } from './types';
import type { Topology } from '../types';
import { defaultConfig } from '../presets';

function createSampleTopology(): Topology {
  return {
    nodes: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Client',
        x: 0,
        y: 0,
        config: { ...defaultConfig('client'), rps: 80 },
      },
      {
        id: 'service-1',
        kind: 'service',
        label: 'API Service',
        x: 100,
        y: 0,
        config: { ...defaultConfig('service'), capacity: 10, serviceMs: 30 },
      },
      {
        id: 'db-1',
        kind: 'db',
        label: 'Primary DB',
        x: 200,
        y: 0,
        config: {
          ...defaultConfig('db'),
          capacity: 5,
          serviceMs: 50,
          readFraction: 0.9,
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e2', from: 'service-1', to: 'db-1', weight: 1 },
    ],
  };
}

describe('evaluator AI boundary', () => {
  it('1. exports a canonical EvaluationBundle with all contracts', () => {
    const topo = createSampleTopology();
    const result = evaluateTopology(topo, { seed: 100 });
    const bundle = createEvaluationBundle(topo, result);

    expect(bundle.version).toBe('1.0');
    expect(bundle.topology).toBe(topo);
    expect(bundle.evaluationResult).toBe(result);
    expect(bundle.scoreContributions.length).toBeGreaterThan(0);
    expect(bundle.availableRemediationIds).toEqual(Object.keys(REMEDIATION_REGISTRY));
    expect(Date.parse(bundle.exportedAt)).not.toBeNaN();
  });

  it('2. provides rich deterministic built-in explanations for all finding types', () => {
    const topo = createSampleTopology();
    const result = evaluateTopology(topo, { seed: 100 });
    const bundle = createEvaluationBundle(topo, result);

    // Read-heavy DB
    const dbFinding = result.findings.find((f) =>
      f.id.startsWith('UNSCALED_READ_HEAVY_DB'),
    );
    expect(dbFinding).toBeDefined();
    const recDb = getBuiltinRecommendation(dbFinding!, bundle);
    expect(recDb.remediationId).toBe('ADD_READ_REPLICA_DB');
    expect(recDb.rationale).toContain('read queries contend with write transactions');
    expect(recDb.tradeoffs.length).toBeGreaterThanOrEqual(2);

    // SPOF
    const spofFinding: Finding = {
      id: 'STATIC_SPOF_service-1',
      category: 'static',
      severity: 'warning',
      title: 'SPOF detected',
      description: 'Single point of failure',
      nodeId: 'service-1',
      evidence: [],
      remediationId: 'ADD_REDUNDANT_INSTANCE',
    };
    const recSpof = getBuiltinRecommendation(spofFinding, bundle);
    expect(recSpof.remediationId).toBe('ADD_REDUNDANT_INSTANCE');
    expect(recSpof.rationale).toContain('articulation point');

    // Unprotected sync latency
    const latencyFinding: Finding = {
      id: 'SYNC_LATENCY_UNPROTECTED_e2',
      category: 'static',
      severity: 'warning',
      title: 'Unprotected sync latency',
      description: 'No timeout or breaker',
      nodeId: 'service-1',
      edgeId: 'e2',
      evidence: [],
      remediationId: 'INSERT_CIRCUIT_BREAKER',
    };
    const recLatency = getBuiltinRecommendation(latencyFinding, bundle);
    expect(recLatency.remediationId).toBe('INSERT_CIRCUIT_BREAKER');
    expect(recLatency.tradeoffs.length).toBeGreaterThanOrEqual(1);

    // Cache miss amplification
    const cacheFinding: Finding = {
      id: 'CACHE_MISS_AMPLIFICATION_cache-1_db-1',
      category: 'static',
      severity: 'warning',
      title: 'Direct cache miss path',
      description: 'Misses hit DB unbuffered',
      nodeId: 'cache-1',
      evidence: [],
      remediationId: 'ADD_INGESTION_QUEUE',
    };
    const recCache = getBuiltinRecommendation(cacheFinding, bundle);
    expect(recCache.remediationId).toBe('ADD_INGESTION_QUEUE');
    expect(recCache.tradeoffs.length).toBeGreaterThanOrEqual(1);
  });

  it('3. validates and rejects invented remediation IDs from untrusted sources', () => {
    const topo = createSampleTopology();
    const result = evaluateTopology(topo, { seed: 100 });
    const bundle = createEvaluationBundle(topo, result);
    const finding = result.findings[0];

    // Invalid remediation ID "REPLACE_WITH_MAGIC_QUANTUM_DB"
    const untrustedOutput = {
      findingId: finding.id,
      remediationId: 'REPLACE_WITH_MAGIC_QUANTUM_DB',
      rationale: 'We should use a magic quantum database.',
      tradeoffs: ['Magic is unpredictable'],
    };

    const validated = validateRecommendation(
      untrustedOutput,
      bundle.availableRemediationIds,
      finding,
      bundle,
    );

    // Must be coerced to a valid registry ID, never the invented one!
    expect(bundle.availableRemediationIds).toContain(validated.remediationId);
    expect(validated.remediationId).not.toBe('REPLACE_WITH_MAGIC_QUANTUM_DB');
  });

  it('4. generateFindingExplanation & generateAllRecommendations return valid recommendations', async () => {
    const topo = createSampleTopology();
    const result = evaluateTopology(topo, { seed: 100 });
    const bundle = createEvaluationBundle(topo, result);

    const rec = await generateFindingExplanation(result.findings[0], bundle, {
      provider: 'builtin',
    });
    expect(rec.findingId).toBe(result.findings[0].id);
    expect(bundle.availableRemediationIds).toContain(rec.remediationId);

    const allRecs = await generateAllRecommendations(bundle, { provider: 'builtin' });
    expect(allRecs.length).toBe(result.findings.length);
  });
});
