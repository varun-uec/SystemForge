import type { NodeKind, SimNode, Topology } from '../types';
import type { Evidence, Finding } from './types';

export interface NodeCapacityInfo {
  readonly effectiveCapacitySlots: number;
  readonly serviceMs: number;
  readonly sustainableRps: number;
}

export interface NodeStability {
  readonly nodeId: string;
  readonly nodeKind: NodeKind;
  readonly arrivalRps: number;
  readonly sustainableRps: number;
  readonly trafficIntensity: number; // rho = lambda / (c * mu)
  readonly isStable: boolean;
  readonly saturationTimeEstimateMs: number | null;
}

/**
 * Computes a node's effective slot capacity and sustainable throughput ceiling in RPS
 * based strictly on the simulator engine's actual execution semantics:
 *
 *   slots = capacity * instances
 *   sustainableRps = slots * (1000 / serviceMs)
 */
export function calculateNodeServiceCapacity(node: SimNode): NodeCapacityInfo {
  const cfg = node.config;
  const serviceMs = cfg.serviceMs ?? 0;

  let slots = 1;

  switch (node.kind) {
    case 'replica': {
      // Replicas serve read traffic: replicaCount * capacity
      const replicas = Math.max(1, Math.floor(cfg.replicaCount ?? 1));
      slots = Math.max(1, Math.floor(cfg.capacity)) * replicas;
      break;
    }
    case 'shard': {
      // Shards distribute slots: shardCount * shardCapacity
      const shards = Math.max(1, Math.floor(cfg.shardCount ?? 1));
      const cap = Math.max(1, Math.floor(cfg.shardCapacity ?? 1));
      slots = shards * cap;
      break;
    }
    default: {
      // Default engine instance model: clampInt(capacity, 1) * clampInt(instances, 1)
      const instances =
        cfg.instances === undefined ? 1 : Math.max(1, Math.floor(cfg.instances));
      slots = Math.max(1, Math.floor(cfg.capacity)) * instances;
      break;
    }
  }

  // Rate limiter hard throttles admissions to rateLimitRps if configured
  if (
    node.kind === 'ratelimiter' &&
    cfg.rateLimitRps !== undefined &&
    cfg.rateLimitRps > 0
  ) {
    const rawRps = serviceMs > 0 ? (slots * 1000) / serviceMs : Infinity;
    const sustainableRps = Math.min(rawRps, cfg.rateLimitRps);
    return { effectiveCapacitySlots: slots, serviceMs, sustainableRps };
  }

  const sustainableRps = serviceMs > 0 ? (slots * 1000) / serviceMs : Infinity;
  return { effectiveCapacitySlots: slots, serviceMs, sustainableRps };
}

/**
 * Propagates offered traffic through the topology graph to calculate steady-state
 * arrival rates (lambda) for each node. Respects edge weights, control edge exclusion,
 * and cache miss filtering.
 */
export function estimateTopologyArrivalRates(
  topology: Topology,
  trafficMultiplier = 1.0,
): Map<string, number> {
  const arrivalRates = new Map<string, number>();
  for (const node of topology.nodes) {
    arrivalRates.set(node.id, 0);
  }

  // 1. Initialize client offered rates
  for (const node of topology.nodes) {
    if (node.kind === 'client') {
      const offered = (node.config.rps ?? 0) * trafficMultiplier;
      arrivalRates.set(node.id, offered);
    }
  }

  // Filter out control edges: supervisory links carry no request traffic
  const trafficEdges = topology.edges.filter((e) => !e.control);

  // 2. Iteratively propagate traffic through outgoing edges until convergence
  // (handles branches, cascades, and potential cycles up to 30 iterations)
  const MAX_ITERATIONS = 30;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    const nextFlows = new Map<string, number>(arrivalRates);

    for (const node of topology.nodes) {
      if (node.kind === 'client') continue; // Clients generate external traffic

      // Sum all incoming traffic from parent edges
      const incomingEdges = trafficEdges.filter((e) => e.to === node.id);
      let incomingRps = 0;

      for (const edge of incomingEdges) {
        const sourceNode = topology.nodes.find((n) => n.id === edge.from);
        if (!sourceNode) continue;

        const sourceArrival = arrivalRates.get(sourceNode.id) ?? 0;
        const sourceOutgoing = trafficEdges.filter((e) => e.from === sourceNode.id);
        const totalWeight = sourceOutgoing.reduce(
          (acc, e) => acc + Math.max(0, e.weight),
          0,
        );
        const edgeShare =
          totalWeight > 0
            ? Math.max(0, edge.weight) / totalWeight
            : 1 / sourceOutgoing.length;

        let outgoingFlow = sourceArrival * edgeShare;

        // Cache / CDN miss reduction: only cache misses propagate downstream
        if (sourceNode.kind === 'cache' || sourceNode.kind === 'cdn') {
          const hitRate = Math.max(0, Math.min(1, sourceNode.config.hitRate ?? 0));
          outgoingFlow *= 1 - hitRate;
        }

        incomingRps += outgoingFlow;
      }

      incomingRps = Math.round(incomingRps * 1e6) / 1e6;
      const prev = arrivalRates.get(node.id) ?? 0;
      if (Math.abs(incomingRps - prev) > 0.01) {
        changed = true;
        nextFlows.set(node.id, incomingRps);
      }
    }

    for (const [id, val] of nextFlows) {
      arrivalRates.set(id, val);
    }

    if (!changed) break;
  }

  return arrivalRates;
}

/**
 * Evaluates queue stability for all nodes in the topology under a given traffic multiplier.
 * Uses the queue stability condition: rho = lambda / (c * mu) < 1.0.
 */
export function evaluateTopologyStability(
  topology: Topology,
  trafficMultiplier = 1.0,
): Map<string, NodeStability> {
  const arrivalRates = estimateTopologyArrivalRates(topology, trafficMultiplier);
  const results = new Map<string, NodeStability>();

  for (const node of topology.nodes) {
    if (node.kind === 'client') {
      results.set(node.id, {
        nodeId: node.id,
        nodeKind: node.kind,
        arrivalRps: arrivalRates.get(node.id) ?? 0,
        sustainableRps: Infinity,
        trafficIntensity: 0,
        isStable: true,
        saturationTimeEstimateMs: null,
      });
      continue;
    }

    const { sustainableRps } = calculateNodeServiceCapacity(node);
    const arrivalRps = arrivalRates.get(node.id) ?? 0;

    let trafficIntensity = 0;
    if (sustainableRps === Infinity) {
      trafficIntensity = 0;
    } else if (sustainableRps > 0) {
      trafficIntensity = arrivalRps / sustainableRps;
    } else {
      trafficIntensity = arrivalRps > 0 ? Infinity : 0;
    }

    const isStable = trafficIntensity < 1.0;

    // Estimate time for bounded queue to saturate under overload: queueLimit / (lambda - capacity)
    let saturationTimeEstimateMs: number | null = null;
    const queueLimit = node.config.queueLimit ?? 0;
    if (!isStable && queueLimit > 0 && arrivalRps > sustainableRps) {
      const excessRps = arrivalRps - sustainableRps;
      saturationTimeEstimateMs = Math.round((queueLimit / excessRps) * 1000);
    }

    results.set(node.id, {
      nodeId: node.id,
      nodeKind: node.kind,
      arrivalRps,
      sustainableRps,
      trafficIntensity,
      isStable,
      saturationTimeEstimateMs,
    });
  }

  return results;
}

/**
 * Generates static findings for any node violating the queue stability condition (lambda >= c * mu).
 */
export function generateStabilityFindings(
  topology: Topology,
  trafficMultiplier = 1.0,
): readonly Finding[] {
  const stabilities = evaluateTopologyStability(topology, trafficMultiplier);
  const findings: Finding[] = [];

  for (const [nodeId, s] of stabilities) {
    if (s.isStable) continue;

    const node = topology.nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    const evidence: Evidence[] = [
      {
        metric: 'arrival_rate',
        scenarioId: 'static_analysis',
        nodeId,
        value: Math.round(s.arrivalRps * 10) / 10,
        unit: 'rps',
      },
      {
        metric: 'sustainable_capacity',
        scenarioId: 'static_analysis',
        nodeId,
        value: Math.round(s.sustainableRps * 10) / 10,
        unit: 'rps',
      },
      {
        metric: 'traffic_intensity',
        scenarioId: 'static_analysis',
        nodeId,
        value: Math.round(s.trafficIntensity * 100) / 100,
        unit: 'ratio',
        threshold: 1.0,
      },
    ];

    if (s.saturationTimeEstimateMs !== null) {
      evidence.push({
        metric: 'estimated_saturation_time',
        scenarioId: 'static_analysis',
        nodeId,
        value: s.saturationTimeEstimateMs,
        unit: 'ms',
      });
    }

    findings.push({
      id: `UNSTABLE_CAPACITY_${nodeId}`,
      category: 'static',
      severity: 'critical',
      title: `Unstable capacity on "${node.label || node.id}"`,
      description: `Arrival rate (${Math.round(s.arrivalRps)} rps) exceeds sustainable service capacity (${Math.round(s.sustainableRps)} rps). Traffic intensity rho = ${s.trafficIntensity.toFixed(2)} >= 1.0, causing continuous queue growth and request drops.`,
      nodeId,
      evidence,
      remediationId:
        node.kind === 'db' ? 'ADD_READ_REPLICA_DB' : 'INCREASE_NODE_CAPACITY',
    });
  }

  return findings;
}
