import { describe, expect, it } from 'vitest';
import {
  REMEDIATION_REGISTRY,
  addReadReplicaPatch,
  addRedundantInstancePatch,
  increaseNodeCapacityPatch,
  insertCircuitBreakerPatch,
  addIngestionQueuePatch,
  applyRemediation,
} from './registry';
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
        x: 50,
        y: 100,
        config: defaultConfig('client'),
      },
      {
        id: 'service-1',
        kind: 'service',
        label: 'Service',
        x: 200,
        y: 100,
        config: { ...defaultConfig('service'), instances: 1 },
      },
      {
        id: 'db-1',
        kind: 'db',
        label: 'Database',
        x: 400,
        y: 100,
        config: defaultConfig('db'),
      },
    ],
    edges: [
      { id: 'e_c_s', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e_s_d', from: 'service-1', to: 'db-1', weight: 1 },
    ],
  };
}

describe('evaluator remediation registry', () => {
  it('1. ADD_READ_REPLICA_DB converts db to replica without mutating original', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'UNSCALED_READ_HEAVY_DB_db-1',
      category: 'static',
      severity: 'warning',
      title: 'Read heavy database',
      description: 'DB needs replicas',
      nodeId: 'db-1',
      evidence: [],
      remediationId: 'ADD_READ_REPLICA_DB',
    };

    const nextTopo = addReadReplicaPatch(topo, finding);

    expect(topo.nodes.find((n) => n.id === 'db-1')?.kind).toBe('db');

    const patchedNode = nextTopo.nodes.find((n) => n.id === 'db-1');
    expect(patchedNode?.kind).toBe('replica');
    expect(patchedNode?.config.replicaCount).toBe(2);
  });

  it('2. ADD_READ_REPLICA_DB increments replicaCount if already replica', () => {
    const topo = createSampleTopology();
    topo.nodes[2] = {
      ...topo.nodes[2],
      kind: 'replica',
      config: { ...topo.nodes[2].config, replicaCount: 2 },
    };

    const finding: Finding = {
      id: 'UNSCALED_READ_HEAVY_DB_db-1',
      category: 'static',
      severity: 'warning',
      title: 'Read heavy database',
      description: 'DB needs replicas',
      nodeId: 'db-1',
      evidence: [],
      remediationId: 'ADD_READ_REPLICA_DB',
    };

    const nextTopo = addReadReplicaPatch(topo, finding);
    const patchedNode = nextTopo.nodes.find((n) => n.id === 'db-1');
    expect(patchedNode?.config.replicaCount).toBe(3);
  });

  it('3. ADD_REDUNDANT_INSTANCE increases instances for SPOF node', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'STATIC_SPOF_service-1',
      category: 'static',
      severity: 'warning',
      title: 'SPOF service',
      description: 'Single instance',
      nodeId: 'service-1',
      evidence: [],
      remediationId: 'ADD_REDUNDANT_INSTANCE',
    };

    const nextTopo = addRedundantInstancePatch(topo, finding);
    const patchedNode = nextTopo.nodes.find((n) => n.id === 'service-1');
    expect(patchedNode?.config.instances).toBe(2);
  });

  it('4. INCREASE_NODE_CAPACITY scales capacity or instances', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'UNSTABLE_CAPACITY_service-1',
      category: 'static',
      severity: 'critical',
      title: 'Unstable capacity',
      description: 'Overwhelmed',
      nodeId: 'service-1',
      evidence: [],
      remediationId: 'INCREASE_NODE_CAPACITY',
    };

    const nextTopo = increaseNodeCapacityPatch(topo, finding);
    const patchedNode = nextTopo.nodes.find((n) => n.id === 'service-1');
    expect(patchedNode?.config.instances).toBe(2);
  });

  it('5. INSERT_CIRCUIT_BREAKER splices a breaker into an unprotected edge', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'SYNC_LATENCY_UNPROTECTED_e_s_d',
      category: 'static',
      severity: 'warning',
      title: 'Unprotected latency',
      description: 'Slow DB without breaker',
      edgeId: 'e_s_d',
      evidence: [],
      remediationId: 'INSERT_CIRCUIT_BREAKER',
    };

    const nextTopo = insertCircuitBreakerPatch(topo, finding);

    // Old edge should be removed
    expect(nextTopo.edges.some((e) => e.id === 'e_s_d')).toBe(false);

    // Breaker node should be created
    const breakerNode = nextTopo.nodes.find((n) => n.id === 'service-1_cb_db-1');
    expect(breakerNode).toBeDefined();
    expect(breakerNode?.kind).toBe('breaker');

    // Two new edges should route through breaker
    expect(
      nextTopo.edges.some(
        (e) => e.from === 'service-1' && e.to === 'service-1_cb_db-1',
      ),
    ).toBe(true);
    expect(
      nextTopo.edges.some((e) => e.from === 'service-1_cb_db-1' && e.to === 'db-1'),
    ).toBe(true);
  });

  it('6. ADD_INGESTION_QUEUE splices a queue buffer in front of target', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'CACHE_MISS_AMPLIFICATION_cache_db-1',
      category: 'static',
      severity: 'warning',
      title: 'Cache miss amplification',
      description: 'Direct hit on DB',
      nodeId: 'db-1',
      evidence: [],
      remediationId: 'ADD_INGESTION_QUEUE',
    };

    const nextTopo = addIngestionQueuePatch(topo, finding);

    const queueNode = nextTopo.nodes.find((n) => n.id === 'queue_db-1');
    expect(queueNode).toBeDefined();
    expect(queueNode?.kind).toBe('queue');

    // Upstream service now routes to queue
    expect(
      nextTopo.edges.some((e) => e.from === 'service-1' && e.to === 'queue_db-1'),
    ).toBe(true);
    // Queue routes to db
    expect(nextTopo.edges.some((e) => e.from === 'queue_db-1' && e.to === 'db-1')).toBe(
      true,
    );
  });

  it('7. applyRemediation resolves registered patch and handles unknowns safely', () => {
    const topo = createSampleTopology();
    const finding: Finding = {
      id: 'UNKNOWN_FINDING',
      category: 'static',
      severity: 'info',
      title: 'Some finding',
      description: 'No remediation',
      evidence: [],
      remediationId: 'NON_EXISTENT_REMEDIATION',
    };

    // Unknown remediation leaves topology untouched
    const unchanged = applyRemediation(topo, finding);
    expect(unchanged).toEqual(topo);

    // Known remediation applies correctly
    const validFinding: Finding = {
      ...finding,
      nodeId: 'db-1',
      remediationId: 'ADD_READ_REPLICA_DB',
    };
    const patched = applyRemediation(topo, validFinding);
    expect(patched.nodes.find((n) => n.id === 'db-1')?.kind).toBe('replica');
  });

  it('8. registry metadata contains honest trade-off documentation', () => {
    for (const [id, meta] of Object.entries(REMEDIATION_REGISTRY)) {
      expect(meta.id).toBe(id);
      expect(meta.title.length).toBeGreaterThan(5);
      expect(meta.description.length).toBeGreaterThan(10);
      expect(meta.expectedTradeoffs.length).toBeGreaterThanOrEqual(1);
    }
  });
});
