import type { NodeKind, SimNode, Topology } from '../types';
import { generateStabilityFindings } from './stability';
import type { Evidence, Finding, ScenarioTelemetry } from './types';

const STORAGE_KINDS: ReadonlySet<NodeKind> = new Set([
  'db',
  'replica',
  'shard',
  'objectstore',
  'coldstorage',
  'timeseriesdb',
  'graphdb',
  'vectordb',
]);

/**
 * Deterministically checks for reachability between source and target in a directed graph,
 * excluding control edges. If `excludeNodeId` is specified, simulates graph without that node.
 */
function isReachable(
  topology: Topology,
  startNodeId: string,
  targetPredicate: (node: SimNode) => boolean,
  excludeNodeId?: string,
): boolean {
  if (startNodeId === excludeNodeId) return false;

  const visited = new Set<string>();
  const queue = [startNodeId];
  visited.add(startNodeId);

  const trafficEdges = topology.edges.filter(
    (e) => !e.control && e.from !== excludeNodeId && e.to !== excludeNodeId,
  );

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = topology.nodes.find((n) => n.id === current);
    if (currentNode && targetPredicate(currentNode)) {
      return true;
    }

    const outgoing = trafficEdges.filter((e) => e.from === current);
    for (const edge of outgoing) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return false;
}

/**
 * Detects cycles in the directed request graph (DFS 3-color algorithm).
 */
function findCyclicDependencies(topology: Topology): string[][] {
  const trafficEdges = topology.edges.filter((e) => !e.control);
  const adj = new Map<string, string[]>();
  for (const node of topology.nodes) {
    adj.set(node.id, []);
  }
  for (const edge of trafficEdges) {
    adj.get(edge.from)?.push(edge.to);
  }

  const visited = new Map<string, 'white' | 'gray' | 'black'>();
  for (const node of topology.nodes) {
    visited.set(node.id, 'white');
  }

  const cycles: string[][] = [];
  const currentPath: string[] = [];

  function dfs(nodeId: string): void {
    visited.set(nodeId, 'gray');
    currentPath.push(nodeId);

    const neighbors = adj.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      const state = visited.get(neighbor);
      if (state === 'gray') {
        // Cycle detected: extract subpath from neighbor to current
        const cycleStartIndex = currentPath.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          cycles.push(currentPath.slice(cycleStartIndex).concat(neighbor));
        }
      } else if (state === 'white') {
        dfs(neighbor);
      }
    }

    currentPath.pop();
    visited.set(nodeId, 'black');
  }

  for (const node of topology.nodes) {
    if (visited.get(node.id) === 'white') {
      dfs(node.id);
    }
  }

  return cycles;
}

/**
 * 1. Disconnected client -> storage paths
 */
function checkDisconnectedStorage(topology: Topology): Finding[] {
  const findings: Finding[] = [];
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  const hasStorage = topology.nodes.some((n) => STORAGE_KINDS.has(n.kind));

  if (clients.length === 0 || !hasStorage) return findings;

  for (const client of clients) {
    const reachesStorage = isReachable(topology, client.id, (n) =>
      STORAGE_KINDS.has(n.kind),
    );
    if (!reachesStorage) {
      findings.push({
        id: `DISCONNECTED_STORAGE_${client.id}`,
        category: 'static',
        severity: 'critical',
        title: `Client "${client.label || client.id}" cannot reach persistent storage`,
        description: `No active request path exists from client "${client.label || client.id}" to any persistent datastore. Client requests cannot persist data or query application state.`,
        nodeId: client.id,
        evidence: [
          {
            metric: 'storage_reachability',
            scenarioId: 'static_analysis',
            nodeId: client.id,
            value: 0,
            unit: 'count',
            threshold: 1,
          },
        ],
      });
    }
  }

  return findings;
}

/**
 * 2. Articulation points / SPOFs
 */
function checkSinglePointsOfFailure(topology: Topology): Finding[] {
  const findings: Finding[] = [];
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  const storageNodes = topology.nodes.filter((n) => STORAGE_KINDS.has(n.kind));

  if (clients.length === 0 || storageNodes.length === 0) return findings;

  // Intermediate nodes (not clients, not leaf storage) that lie on the path
  const intermediateNodes = topology.nodes.filter(
    (n) => n.kind !== 'client' && !STORAGE_KINDS.has(n.kind),
  );

  for (const node of intermediateNodes) {
    // Check if removing this node disconnects ALL paths from a client to storage
    for (const client of clients) {
      const originallyReachable = isReachable(topology, client.id, (n) =>
        STORAGE_KINDS.has(n.kind),
      );
      if (!originallyReachable) continue;

      const stillReachable = isReachable(
        topology,
        client.id,
        (n) => STORAGE_KINDS.has(n.kind),
        node.id,
      );

      if (!stillReachable) {
        findings.push({
          id: `STATIC_SPOF_${node.id}`,
          category: 'static',
          severity: 'warning',
          title: `Single Point of Failure (SPOF): "${node.label || node.id}"`,
          description: `Node "${node.label || node.id}" is a critical cut vertex. An outage or crash of this node completely severs client traffic from reaching downstream datastores.`,
          nodeId: node.id,
          evidence: [
            {
              metric: 'downstream_redundancy',
              scenarioId: 'static_analysis',
              nodeId: node.id,
              value: 0,
              unit: 'count',
              threshold: 1,
            },
          ],
          remediationId: 'ADD_REDUNDANT_INSTANCE',
        });
        break; // One finding per node is sufficient
      }
    }
  }

  return findings;
}

/**
 * 3. Synchronous high-latency edges without timeout or circuit breaker
 */
function checkUnprotectedLatencyEdges(topology: Topology): Finding[] {
  const findings: Finding[] = [];
  const trafficEdges = topology.edges.filter((e) => !e.control);

  for (const edge of trafficEdges) {
    const fromNode = topology.nodes.find((n) => n.id === edge.from);
    const toNode = topology.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

    const downstreamMs = toNode.config.serviceMs ?? 0;
    const callerTimeoutMs = fromNode.config.timeoutMs ?? 0;

    // High downstream latency (> 40ms) with no caller timeout and no intermediate breaker
    if (downstreamMs >= 40 && callerTimeoutMs === 0 && toNode.kind !== 'breaker') {
      findings.push({
        id: `SYNC_LATENCY_UNPROTECTED_${edge.id}`,
        category: 'static',
        severity: 'warning',
        title: `Unprotected synchronous dependency on "${toNode.label || toNode.id}"`,
        description: `Edge from "${fromNode.label || fromNode.id}" to "${toNode.label || toNode.id}" has no timeout configured, and target service has high service latency (${downstreamMs}ms). Downstream degradation will stall upstream callers.`,
        edgeId: edge.id,
        nodeId: fromNode.id,
        evidence: [
          {
            metric: 'target_service_ms',
            scenarioId: 'static_analysis',
            nodeId: toNode.id,
            edgeId: edge.id,
            value: downstreamMs,
            unit: 'ms',
            threshold: 40,
          },
          {
            metric: 'caller_timeout_ms',
            scenarioId: 'static_analysis',
            nodeId: fromNode.id,
            edgeId: edge.id,
            value: callerTimeoutMs,
            unit: 'ms',
            threshold: 1,
          },
        ],
        remediationId: 'INSERT_CIRCUIT_BREAKER',
      });
    }
  }

  return findings;
}

/**
 * 4. Read-heavy DB without read scaling
 */
function checkReadHeavyDatabases(topology: Topology): Finding[] {
  const findings: Finding[] = [];

  for (const node of topology.nodes) {
    if (node.kind !== 'db') continue;

    const readFraction = node.config.readFraction ?? 0.8;

    // Single primary DB handling heavy read traffic (>= 75%)
    if (readFraction >= 0.75) {
      findings.push({
        id: `UNSCALED_READ_HEAVY_DB_${node.id}`,
        category: 'static',
        severity: 'warning',
        title: `Read-heavy datastore without read replicas: "${node.label || node.id}"`,
        description: `Database "${node.label || node.id}" has a ${Math.round(readFraction * 100)}% read workload on a single primary instance with zero read replicas, creating write lock contention and unscaled read throughput.`,
        nodeId: node.id,
        evidence: [
          {
            metric: 'read_fraction',
            scenarioId: 'static_analysis',
            nodeId: node.id,
            value: Math.round(readFraction * 100),
            unit: 'pct',
            threshold: 75,
          },
          {
            metric: 'replica_count',
            scenarioId: 'static_analysis',
            nodeId: node.id,
            value: 1,
            unit: 'count',
            threshold: 2,
          },
        ],
        remediationId: 'ADD_READ_REPLICA_DB',
      });
    }
  }

  return findings;
}

/**
 * 5. Cache -> DB miss amplification
 */
function checkCacheMissAmplification(topology: Topology): Finding[] {
  const findings: Finding[] = [];
  const trafficEdges = topology.edges.filter((e) => !e.control);

  for (const edge of trafficEdges) {
    const fromNode = topology.nodes.find((n) => n.id === edge.from);
    const toNode = topology.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

    if (
      (fromNode.kind === 'cache' || fromNode.kind === 'cdn') &&
      toNode.kind === 'db'
    ) {
      const hitRate = fromNode.config.hitRate ?? 0.8;
      const dbCapacity = (toNode.config.capacity ?? 1) * (toNode.config.instances ?? 1);
      const cacheCapacity =
        (fromNode.config.capacity ?? 1) * (fromNode.config.instances ?? 1);

      if (dbCapacity < cacheCapacity * 0.25 || hitRate < 0.7) {
        findings.push({
          id: `CACHE_MISS_AMPLIFICATION_${fromNode.id}_${toNode.id}`,
          category: 'static',
          severity: 'warning',
          title: `Direct cache miss path to DB without buffer: "${fromNode.label}" -> "${toNode.label}"`,
          description: `Cache misses from "${fromNode.label || fromNode.id}" fall directly onto single database "${toNode.label || toNode.id}". In the event of a cold start or cache invalidation storm, unbuffered miss traffic will saturate the database.`,
          edgeId: edge.id,
          nodeId: fromNode.id,
          evidence: [
            {
              metric: 'cache_hit_rate',
              scenarioId: 'static_analysis',
              nodeId: fromNode.id,
              value: Math.round(hitRate * 100),
              unit: 'pct',
              threshold: 70,
            },
            {
              metric: 'db_slot_capacity',
              scenarioId: 'static_analysis',
              nodeId: toNode.id,
              value: dbCapacity,
              unit: 'count',
            },
          ],
          remediationId: 'ADD_INGESTION_QUEUE',
        });
      }
    }
  }

  return findings;
}

/**
 * 6. Cyclic synchronous dependencies
 */
function checkCyclicDependencies(topology: Topology): Finding[] {
  const findings: Finding[] = [];
  const cycles = findCyclicDependencies(topology);

  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    findings.push({
      id: `CYCLIC_DEPENDENCY_${i}`,
      category: 'static',
      severity: 'critical',
      title: `Cyclic synchronous dependency chain detected: ${cycle.join(' -> ')}`,
      description: `A circular request path exists (${cycle.join(' -> ')}). Synchronous circular calls create recursive amplification, distributed deadlocks, and cascading timeouts.`,
      nodeId: cycle[0],
      evidence: [
        {
          metric: 'cycle_hop_count',
          scenarioId: 'static_analysis',
          nodeId: cycle[0],
          value: cycle.length - 1,
          unit: 'count',
          threshold: 0,
        },
      ],
    });
  }

  return findings;
}

/**
 * Executes all 7 deterministic static graph and capacity checks on a topology.
 */
export function lintTopology(topology: Topology): readonly Finding[] {
  const findings: Finding[] = [
    ...checkDisconnectedStorage(topology),
    ...checkSinglePointsOfFailure(topology),
    ...checkUnprotectedLatencyEdges(topology),
    ...checkReadHeavyDatabases(topology),
    ...checkCacheMissAmplification(topology),
    ...generateStabilityFindings(topology, 1.0),
    ...checkCyclicDependencies(topology),
  ];

  return findings;
}

/**
 * Correlates static architectural risks with empirical simulation telemetry.
 * When a static vulnerability materializes as a measured bottleneck or request drop,
 * an empirical finding is produced with exact measured evidence.
 */
export function correlateTelemetryFindings(
  staticFindings: readonly Finding[],
  telemetries: readonly ScenarioTelemetry[],
): readonly Finding[] {
  const empiricalFindings: Finding[] = [];

  for (const t of telemetries) {
    if (t.bottleneckNodeId && t.lostRequests > 0) {
      const matchingStatic = staticFindings.find(
        (f) => f.nodeId === t.bottleneckNodeId,
      );
      const nodeLabel = t.bottleneckNodeId;

      const lossPct =
        t.totalRequests > 0 ? (t.lostRequests / t.totalRequests) * 100 : 0;
      const evidence: Evidence[] = [
        {
          metric: 'lost_requests',
          scenarioId: t.scenarioId,
          nodeId: t.bottleneckNodeId,
          value: t.lostRequests,
          unit: 'count',
          threshold: 0,
        },
        {
          metric: 'lost_requests_pct',
          scenarioId: t.scenarioId,
          nodeId: t.bottleneckNodeId,
          value: Math.round(lossPct * 10) / 10,
          unit: 'pct',
          threshold: 0.1,
        },
        {
          metric: 'p99_latency',
          scenarioId: t.scenarioId,
          nodeId: t.bottleneckNodeId,
          value: Math.round(t.p99Ms),
          unit: 'ms',
        },
      ];

      if (t.saturationTimeMs !== null) {
        evidence.push({
          metric: 'saturation_time',
          scenarioId: t.scenarioId,
          nodeId: t.bottleneckNodeId,
          value: t.saturationTimeMs,
          unit: 'ms',
        });
      }

      empiricalFindings.push({
        id: `EMPIRICAL_SATURATION_${t.scenarioId}_${t.bottleneckNodeId}`,
        category: 'empirical',
        severity: 'critical',
        title: `Observed saturation on "${nodeLabel}" during "${t.scenarioId}"`,
        description: `Node "${nodeLabel}" saturated at t=${t.saturationTimeMs ?? 'unknown'}ms during scenario "${t.scenarioId}", dropping ${t.lostRequests} requests (${lossPct.toFixed(1)}% drop rate). Measured p99 latency rose to ${Math.round(t.p99Ms)}ms.${matchingStatic ? ` Correlates with static risk: ${matchingStatic.title}.` : ''}`,
        nodeId: t.bottleneckNodeId,
        evidence,
        remediationId: matchingStatic?.remediationId,
      });
    }
  }

  return empiricalFindings;
}
