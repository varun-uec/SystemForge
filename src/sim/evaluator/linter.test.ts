import { describe, expect, it } from 'vitest';
import {
  calculateNodeServiceCapacity,
  estimateTopologyArrivalRates,
  evaluateTopologyStability,
  generateStabilityFindings,
} from './stability';
import { correlateTelemetryFindings, lintTopology } from './linter';
import type { SimNode, Topology } from '../types';
import type { ScenarioTelemetry } from './types';

function makeTestNode(
  id: string,
  kind: SimNode['kind'],
  partialConfig: Partial<SimNode['config']> = {},
): SimNode {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: {
      capacity: 10,
      instances: 1,
      serviceMs: 10,
      serviceCv: 0,
      queueLimit: 100,
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
      ...partialConfig,
    },
  };
}

describe('evaluator stability analysis', () => {
  it('calculates sustainable capacity from engine instance and serviceMs semantics', () => {
    // 4 instances * 10 capacity = 40 slots; 20ms serviceMs -> 40 * (1000/20) = 2000 RPS
    const node = makeTestNode('api', 'service', {
      instances: 4,
      capacity: 10,
      serviceMs: 20,
    });
    const info = calculateNodeServiceCapacity(node);
    expect(info.effectiveCapacitySlots).toBe(40);
    expect(info.sustainableRps).toBe(2000);
  });

  it('calculates replica read slots accurately', () => {
    // 3 replicas * 8 capacity = 24 read slots
    const replicaNode = makeTestNode('replica-db', 'replica', {
      capacity: 8,
      replicaCount: 3,
      serviceMs: 25,
    });
    const info = calculateNodeServiceCapacity(replicaNode);
    expect(info.effectiveCapacitySlots).toBe(24);
    expect(info.sustainableRps).toBe(960);
  });

  it('detects queue instability when arrival rate exceeds sustainable service capacity (lambda >= c * mu)', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 300 }),
        // capacity 2 * instances 1 = 2 slots; 20ms -> 2 * 50 = 100 RPS capacity. Arrival = 300 RPS -> rho = 3.0
        makeTestNode('service-1', 'service', {
          capacity: 2,
          instances: 1,
          serviceMs: 20,
          queueLimit: 50,
        }),
      ],
      edges: [{ id: 'e1', from: 'client-1', to: 'service-1', weight: 1 }],
    };

    const stability = evaluateTopologyStability(topology, 1.0);
    const s = stability.get('service-1')!;
    expect(s.isStable).toBe(false);
    expect(s.trafficIntensity).toBe(3.0);
    expect(s.sustainableRps).toBe(100);
    expect(s.arrivalRps).toBe(300);
    // Queue of 50 / (300 - 100 excess RPS) = 250ms estimated time to saturate
    expect(s.saturationTimeEstimateMs).toBe(250);

    const findings = generateStabilityFindings(topology, 1.0);
    expect(findings.length).toBe(1);
    expect(findings[0].category).toBe('static');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].id).toBe('UNSTABLE_CAPACITY_service-1');
  });

  it('calculates shard slots as shardCount * shardCapacity', () => {
    // 4 shards * 5 slots = 20 slots; 40ms -> 20 * 25 = 500 RPS
    const shardNode = makeTestNode('sharded-db', 'shard', {
      shardCount: 4,
      shardCapacity: 5,
      serviceMs: 40,
    });
    const info = calculateNodeServiceCapacity(shardNode);
    expect(info.effectiveCapacitySlots).toBe(20);
    expect(info.sustainableRps).toBe(500);
  });

  it('clamps sustainable capacity to rateLimitRps when it is the binding constraint', () => {
    // Raw: 10 slots * 100 = 1000 RPS, but rate limiter caps admissions at 200 RPS
    const limited = makeTestNode('rl', 'ratelimiter', {
      capacity: 10,
      serviceMs: 10,
      rateLimitRps: 200,
    });
    expect(calculateNodeServiceCapacity(limited).sustainableRps).toBe(200);

    // Rate limit above raw capacity does not raise it
    const generous = makeTestNode('rl2', 'ratelimiter', {
      capacity: 10,
      serviceMs: 10,
      rateLimitRps: 5000,
    });
    expect(calculateNodeServiceCapacity(generous).sustainableRps).toBe(1000);
  });

  it('treats rho exactly at 1.0 as unstable (rho < 1 is the stability condition)', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 100 }),
        // 2 slots * 50 = 100 RPS capacity, arrival 100 -> rho = 1.0 exactly
        makeTestNode('service-1', 'service', {
          capacity: 2,
          instances: 1,
          serviceMs: 20,
        }),
      ],
      edges: [{ id: 'e1', from: 'client-1', to: 'service-1', weight: 1 }],
    };
    const s = evaluateTopologyStability(topology, 1.0).get('service-1')!;
    expect(s.trafficIntensity).toBe(1.0);
    expect(s.isStable).toBe(false);
  });

  it('scales arrival rates by the traffic multiplier', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 100 }),
        makeTestNode('service-1', 'service', { capacity: 20, serviceMs: 10 }), // 2000 RPS
      ],
      edges: [{ id: 'e1', from: 'client-1', to: 'service-1', weight: 1 }],
    };
    const s = evaluateTopologyStability(topology, 3.0).get('service-1')!;
    expect(s.arrivalRps).toBe(300);
    expect(s.trafficIntensity).toBeCloseTo(0.15, 5);
  });

  it('accounts for cache hit reduction when calculating downstream arrival rates', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 1000 }),
        makeTestNode('cache-1', 'cache', { capacity: 100, serviceMs: 1, hitRate: 0.9 }),
        makeTestNode('db-1', 'db', { capacity: 10, serviceMs: 50 }), // Capacity = 10 * 20 = 200 RPS
      ],
      edges: [
        { id: 'e1', from: 'client-1', to: 'cache-1', weight: 1 },
        { id: 'e2', from: 'cache-1', to: 'db-1', weight: 1 },
      ],
    };

    const rates = estimateTopologyArrivalRates(topology, 1.0);
    expect(rates.get('cache-1')).toBe(1000);
    // 90% hit rate means only 10% miss traffic reaches db-1 (100 RPS)
    expect(rates.get('db-1')).toBe(100);

    const stability = evaluateTopologyStability(topology, 1.0);
    const dbStability = stability.get('db-1')!;
    expect(dbStability.isStable).toBe(true);
    expect(dbStability.trafficIntensity).toBe(0.5);
  });
});

describe('evaluator linter', () => {
  it('detects disconnected client to storage paths', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 50 }),
        makeTestNode('service-1', 'service'),
        makeTestNode('db-1', 'db'), // db exists but client path dead-ends at service-1
      ],
      edges: [{ id: 'e1', from: 'client-1', to: 'service-1', weight: 1 }],
    };

    const findings = lintTopology(topology);
    const disconnected = findings.find((f) => f.id.startsWith('DISCONNECTED_STORAGE_'));
    expect(disconnected).toBeDefined();
    expect(disconnected?.category).toBe('static');
    expect(disconnected?.severity).toBe('critical');
  });

  it('detects single points of failure (SPOF) on critical intermediate services', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 50 }),
        makeTestNode('api-gateway', 'apigateway'), // SPOF
        makeTestNode('db-1', 'db'),
      ],
      edges: [
        { id: 'e1', from: 'client-1', to: 'api-gateway', weight: 1 },
        { id: 'e2', from: 'api-gateway', to: 'db-1', weight: 1 },
      ],
    };

    const findings = lintTopology(topology);
    const spof = findings.find((f) => f.id === 'STATIC_SPOF_api-gateway');
    expect(spof).toBeDefined();
    expect(spof?.category).toBe('static');
    expect(spof?.severity).toBe('warning');
  });

  it('detects unprotected synchronous latency edges', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 10 }),
        makeTestNode('caller', 'service', { timeoutMs: 0 }),
        makeTestNode('slow-dep', 'service', { serviceMs: 80 }),
        makeTestNode('db-1', 'db'),
      ],
      edges: [
        { id: 'e1', from: 'client-1', to: 'caller', weight: 1 },
        { id: 'e2', from: 'caller', to: 'slow-dep', weight: 1 },
        { id: 'e3', from: 'slow-dep', to: 'db-1', weight: 1 },
      ],
    };

    const findings = lintTopology(topology);
    const unprotected = findings.find((f) => f.id === 'SYNC_LATENCY_UNPROTECTED_e2');
    expect(unprotected).toBeDefined();
    expect(unprotected?.category).toBe('static');
  });

  it('detects read-heavy databases without read scaling', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 10 }),
        makeTestNode('db-primary', 'db', { readFraction: 0.9, replicaCount: 1 }),
      ],
      edges: [{ id: 'e1', from: 'client-1', to: 'db-primary', weight: 1 }],
    };

    const findings = lintTopology(topology);
    const readHeavy = findings.find(
      (f) => f.id === 'UNSCALED_READ_HEAVY_DB_db-primary',
    );
    expect(readHeavy).toBeDefined();
    expect(readHeavy?.remediationId).toBe('ADD_READ_REPLICA_DB');
  });

  it('detects cache to DB miss amplification', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('client-1', 'client', { rps: 10 }),
        makeTestNode('cache-tier', 'cache', { capacity: 100, hitRate: 0.5 }),
        makeTestNode('db-small', 'db', { capacity: 4 }), // DB capacity is < 25% of cache capacity
      ],
      edges: [
        { id: 'e1', from: 'client-1', to: 'cache-tier', weight: 1 },
        { id: 'e2', from: 'cache-tier', to: 'db-small', weight: 1 },
      ],
    };

    const findings = lintTopology(topology);
    const missAmp = findings.find((f) => f.id.startsWith('CACHE_MISS_AMPLIFICATION_'));
    expect(missAmp).toBeDefined();
    expect(missAmp?.category).toBe('static');
  });

  it('detects cyclic synchronous dependencies', () => {
    const topology: Topology = {
      nodes: [
        makeTestNode('svc-a', 'service'),
        makeTestNode('svc-b', 'service'),
        makeTestNode('svc-c', 'service'),
      ],
      edges: [
        { id: 'e1', from: 'svc-a', to: 'svc-b', weight: 1 },
        { id: 'e2', from: 'svc-b', to: 'svc-c', weight: 1 },
        { id: 'e3', from: 'svc-c', to: 'svc-a', weight: 1 }, // Cycle: A -> B -> C -> A
      ],
    };

    const findings = lintTopology(topology);
    const cycleFinding = findings.find((f) => f.id.startsWith('CYCLIC_DEPENDENCY_'));
    expect(cycleFinding).toBeDefined();
    expect(cycleFinding?.category).toBe('static');
    expect(cycleFinding?.severity).toBe('critical');
  });

  it('correlates static risks with empirical scenario telemetry', () => {
    const staticFindings = [
      {
        id: 'STATIC_SPOF_db-primary',
        category: 'static' as const,
        severity: 'warning' as const,
        title: 'Single Point of Failure: db-primary',
        description: 'db-primary is a cut vertex',
        nodeId: 'db-primary',
        evidence: [],
        remediationId: 'ADD_READ_REPLICA_DB',
      },
    ];

    const telemetry: ScenarioTelemetry[] = [
      {
        scenarioId: 'traffic_spike',
        p50Ms: 120,
        p95Ms: 1800,
        p99Ms: 2450,
        maxQueueDepth: { 'db-primary': 32 },
        lostRequests: 142,
        totalRequests: 600,
        bottleneckNodeId: 'db-primary',
        saturationTimeMs: 1800,
      },
    ];

    const empirical = correlateTelemetryFindings(staticFindings, telemetry);
    expect(empirical.length).toBe(1);
    expect(empirical[0].category).toBe('empirical');
    expect(empirical[0].severity).toBe('critical');
    expect(empirical[0].nodeId).toBe('db-primary');
    expect(empirical[0].title).toContain(
      'Observed saturation on "db-primary" during "traffic_spike"',
    );
    expect(empirical[0].description).toContain('Correlates with static risk');
    expect(empirical[0].evidence.find((e) => e.metric === 'lost_requests')?.value).toBe(
      142,
    );
  });
});
