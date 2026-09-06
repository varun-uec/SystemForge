import type { Finding } from './types';
import type { SimEdge, SimNode, Topology } from '../types';
import { defaultConfig } from '../presets';

/**
 * An executable, non-mutating transformation that remediates an architectural finding.
 */
export type RemediationPatch = (topology: Topology, finding: Finding) => Topology;

export interface RemediationMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly expectedTradeoffs: readonly string[];
  readonly apply: RemediationPatch;
}

/**
 * 1. Add Read Replica Patch:
 * Converts a standalone db to a replica set, or increments replica count.
 */
export const addReadReplicaPatch: RemediationPatch = (topology, finding) => {
  const targetId = finding.nodeId;
  if (!targetId) return topology;

  const nodeIndex = topology.nodes.findIndex((n) => n.id === targetId);
  if (nodeIndex === -1) return topology;

  const targetNode = topology.nodes[nodeIndex];
  let updatedNode: SimNode;

  if (targetNode.kind === 'db') {
    updatedNode = {
      ...targetNode,
      kind: 'replica',
      config: {
        ...targetNode.config,
        replicaCount: 2,
        replicationLagMs: targetNode.config.replicationLagMs ?? 20,
      },
    };
  } else if (targetNode.kind === 'replica') {
    const currentReplicas = targetNode.config.replicaCount ?? 1;
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        replicaCount: Math.max(2, currentReplicas + 1),
      },
    };
  } else {
    return topology;
  }

  const nextNodes = [...topology.nodes];
  nextNodes[nodeIndex] = updatedNode;

  return {
    ...topology,
    nodes: nextNodes,
    edges: [...topology.edges],
  };
};

/**
 * 2. Add Redundant Instance Patch:
 * Eliminates single-point-of-failure risks by ensuring fleet size >= 2.
 */
export const addRedundantInstancePatch: RemediationPatch = (topology, finding) => {
  const targetId = finding.nodeId;
  if (!targetId) return topology;

  const nodeIndex = topology.nodes.findIndex((n) => n.id === targetId);
  if (nodeIndex === -1) return topology;

  const targetNode = topology.nodes[nodeIndex];
  let updatedNode: SimNode;

  if (targetNode.kind === 'db') {
    updatedNode = {
      ...targetNode,
      kind: 'replica',
      config: {
        ...targetNode.config,
        replicaCount: 2,
      },
    };
  } else if (targetNode.kind === 'replica') {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        replicaCount: Math.max(2, (targetNode.config.replicaCount ?? 1) + 1),
      },
    };
  } else if (targetNode.kind === 'shard') {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        shardCount: Math.max(2, (targetNode.config.shardCount ?? 1) + 1),
      },
    };
  } else {
    const currentInstances = targetNode.config.instances ?? 1;
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        instances: Math.max(2, currentInstances + 1),
      },
    };
  }

  const nextNodes = [...topology.nodes];
  nextNodes[nodeIndex] = updatedNode;

  return {
    ...topology,
    nodes: nextNodes,
    edges: [...topology.edges],
  };
};

/**
 * 3. Increase Node Capacity Patch:
 * Scales up instances or capacity to ensure service capacity exceeds arrival rate.
 */
export const increaseNodeCapacityPatch: RemediationPatch = (topology, finding) => {
  const targetId = finding.nodeId;
  if (!targetId) return topology;

  const nodeIndex = topology.nodes.findIndex((n) => n.id === targetId);
  if (nodeIndex === -1) return topology;

  const targetNode = topology.nodes[nodeIndex];
  let updatedNode: SimNode;

  if (targetNode.kind === 'replica') {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        replicaCount: Math.max(2, (targetNode.config.replicaCount ?? 1) + 1),
      },
    };
  } else if (targetNode.kind === 'shard') {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        shardCount: Math.max(2, (targetNode.config.shardCount ?? 1) * 2),
      },
    };
  } else if (
    typeof targetNode.config.instances === 'number' &&
    targetNode.config.instances > 0
  ) {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        instances: Math.max(2, Math.round(targetNode.config.instances * 2)),
      },
    };
  } else {
    updatedNode = {
      ...targetNode,
      config: {
        ...targetNode.config,
        capacity: Math.max(2, Math.ceil(targetNode.config.capacity * 2)),
      },
    };
  }

  const nextNodes = [...topology.nodes];
  nextNodes[nodeIndex] = updatedNode;

  return {
    ...topology,
    nodes: nextNodes,
    edges: [...topology.edges],
  };
};

/**
 * 4. Insert Circuit Breaker Patch:
 * Splices a circuit breaker node into an unprotected synchronous edge.
 */
export const insertCircuitBreakerPatch: RemediationPatch = (topology, finding) => {
  let targetEdge: SimEdge | undefined;

  if (finding.edgeId) {
    targetEdge = topology.edges.find((e) => e.id === finding.edgeId);
  } else if (finding.nodeId) {
    targetEdge = topology.edges.find(
      (e) => e.from === finding.nodeId || e.to === finding.nodeId,
    );
  }

  if (!targetEdge) return topology;

  const fromNode = topology.nodes.find((n) => n.id === targetEdge!.from);
  const toNode = topology.nodes.find((n) => n.id === targetEdge!.to);

  const breakerId = `${targetEdge.from}_cb_${targetEdge.to}`;
  // Avoid duplicate breaker creation
  if (topology.nodes.some((n) => n.id === breakerId)) {
    return topology;
  }

  const midX = fromNode && toNode ? Math.round((fromNode.x + toNode.x) / 2) : 0;
  const midY = fromNode && toNode ? Math.round((fromNode.y + toNode.y) / 2) : 0;

  const breakerNode: SimNode = {
    id: breakerId,
    kind: 'breaker',
    label: 'Circuit Breaker',
    x: midX,
    y: midY,
    config: defaultConfig('breaker'),
  };

  const edgeIn: SimEdge = {
    id: `e_${targetEdge.from}_to_${breakerId}`,
    from: targetEdge.from,
    to: breakerId,
    weight: targetEdge.weight,
    control: false,
  };

  const edgeOut: SimEdge = {
    id: `e_${breakerId}_to_${targetEdge.to}`,
    from: breakerId,
    to: targetEdge.to,
    weight: 1,
    control: false,
  };

  const nextEdges = topology.edges.filter((e) => e.id !== targetEdge!.id);
  nextEdges.push(edgeIn, edgeOut);

  return {
    ...topology,
    nodes: [...topology.nodes, breakerNode],
    edges: nextEdges,
  };
};

/**
 * 5. Add Ingestion Queue Patch:
 * Inserts an asynchronous queue buffer in front of a vulnerable or overwhelmed component.
 */
export const addIngestionQueuePatch: RemediationPatch = (topology, finding) => {
  const targetId = finding.nodeId;
  if (!targetId) return topology;

  const targetNode = topology.nodes.find((n) => n.id === targetId);
  if (!targetNode) return topology;

  const incomingEdges = topology.edges.filter((e) => e.to === targetId && !e.control);
  if (incomingEdges.length === 0) return topology;

  const queueId = `queue_${targetId}`;
  if (topology.nodes.some((n) => n.id === queueId)) {
    return topology;
  }

  const firstSource = topology.nodes.find((n) => n.id === incomingEdges[0].from);
  const midX = firstSource
    ? Math.round((firstSource.x + targetNode.x) / 2)
    : targetNode.x - 100;
  const midY = firstSource
    ? Math.round((firstSource.y + targetNode.y) / 2)
    : targetNode.y;

  const queueNode: SimNode = {
    id: queueId,
    kind: 'queue',
    label: 'Ingestion Queue',
    x: midX,
    y: midY,
    config: {
      ...defaultConfig('queue'),
      queueLimit: 1000,
    },
  };

  const incomingIds = new Set(incomingEdges.map((e) => e.id));
  const remainingEdges = topology.edges.filter((e) => !incomingIds.has(e.id));

  // Reroute incoming edges to the queue
  for (const edge of incomingEdges) {
    remainingEdges.push({
      ...edge,
      to: queueId,
    });
  }

  // Add edge from queue to target node
  remainingEdges.push({
    id: `e_${queueId}_to_${targetId}`,
    from: queueId,
    to: targetId,
    weight: 1,
    control: false,
  });

  return {
    ...topology,
    nodes: [...topology.nodes, queueNode],
    edges: remainingEdges,
  };
};

/**
 * Trusted Remediation Patch Registry.
 *
 * Grounded rule: The AI judge NEVER mutates topology directly.
 * It suggests a remediationId from this trusted, deterministic registry.
 */
export const REMEDIATION_REGISTRY: Readonly<Record<string, RemediationMetadata>> = {
  ADD_READ_REPLICA_DB: {
    id: 'ADD_READ_REPLICA_DB',
    title: 'Add Read Replica to Database',
    description:
      'Converts a standalone primary database into a read-replicated cluster, distributing read traffic and offloading the primary node.',
    expectedTradeoffs: [
      'Replication lag can expose stale data to readers',
      'Increased database infrastructure monthly cost',
    ],
    apply: addReadReplicaPatch,
  },
  ADD_REDUNDANT_INSTANCE: {
    id: 'ADD_REDUNDANT_INSTANCE',
    title: 'Add Redundant Instance',
    description:
      'Increases instance count to eliminate single-point-of-failure risks and improve resilience.',
    expectedTradeoffs: [
      'Increases monthly compute spend',
      'Requires load balancing across instances',
    ],
    apply: addRedundantInstancePatch,
  },
  INCREASE_NODE_CAPACITY: {
    id: 'INCREASE_NODE_CAPACITY',
    title: 'Scale Up Node Capacity / Instances',
    description:
      'Increases instance count or node processing capacity so sustainable throughput exceeds offered load.',
    expectedTradeoffs: [
      'Higher monthly compute cost',
      'Potential downstream bottleneck migration',
    ],
    apply: increaseNodeCapacityPatch,
  },
  INSERT_CIRCUIT_BREAKER: {
    id: 'INSERT_CIRCUIT_BREAKER',
    title: 'Insert Circuit Breaker Protection',
    description:
      'Slices an inline circuit breaker into a high-latency synchronous link to prevent cascading timeouts.',
    expectedTradeoffs: [
      'Fast-fails requests when the downstream service degrades',
      'Adds an extra intermediary node',
    ],
    apply: insertCircuitBreakerPatch,
  },
  ADD_INGESTION_QUEUE: {
    id: 'ADD_INGESTION_QUEUE',
    title: 'Add Asynchronous Queue Buffer',
    description:
      'Buffers incoming traffic in a persistent queue, smoothing traffic spikes and preventing storage saturation.',
    expectedTradeoffs: [
      'Converts synchronous request-response into asynchronous delivery',
      'Adds queue maintenance and consumer worker requirements',
    ],
    apply: addIngestionQueuePatch,
  },
} as const;

/**
 * Resolves and applies a trusted remediation patch to a topology.
 * If the remediationId is unknown, returns the unmodified topology.
 */
export function applyRemediation(
  topology: Topology,
  finding: Finding,
  remediationId?: string,
): Topology {
  const effectiveId = remediationId ?? finding.remediationId;
  if (!effectiveId) return topology;

  const metadata = REMEDIATION_REGISTRY[effectiveId];
  if (!metadata) return topology;

  return metadata.apply(topology, finding);
}
