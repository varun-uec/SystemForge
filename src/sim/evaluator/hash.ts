import type { Topology } from '../types';

const FNV1A_64_PRIME = 0x100000001b3n;
const FNV1A_64_OFFSET_1 = 0xcbf29ce484222325n;
const FNV1A_64_OFFSET_2 = 0x84222325cbf29ce4n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a hash over a UTF-16 string.
 */
function fnv1a64(str: string, seed: bigint): bigint {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV1A_64_PRIME) & MASK_64;
  }
  return hash;
}

export interface HashOptions {
  /**
   * Whether to include canvas (x, y) coordinates.
   * Defaults to false (pure architectural/structural hash).
   */
  readonly includeCoordinates?: boolean;
}

/**
 * Canonicalizes an object by sorting keys alphabetically and omitting undefined values.
 */
function canonicalizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined) {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        result[key] = canonicalizeObject(val as Record<string, unknown>);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Serializes a topology into a deterministic canonical string.
 *
 * Guarantees:
 * - Invariant to node insertion order.
 * - Invariant to edge insertion order.
 * - Invariant to object key insertion order in node configs.
 * - By default invariant to visual canvas coordinates.
 */
export function canonicalizeTopology(
  topology: Topology,
  options?: HashOptions,
): string {
  const includeCoords = options?.includeCoordinates ?? false;

  const sortedNodes = [...topology.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      const canonicalNode: Record<string, unknown> = {
        id: node.id,
        kind: node.kind,
        label: node.label,
        config: canonicalizeObject(node.config as unknown as Record<string, unknown>),
      };
      if (includeCoords) {
        canonicalNode.x = node.x;
        canonicalNode.y = node.y;
      }
      return canonicalNode;
    });

  const sortedEdges = [...topology.edges]
    .sort((a, b) => {
      const fromCmp = a.from.localeCompare(b.from);
      if (fromCmp !== 0) return fromCmp;
      const toCmp = a.to.localeCompare(b.to);
      if (toCmp !== 0) return toCmp;
      return a.id.localeCompare(b.id);
    })
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      control: Boolean(edge.control),
      latencyMs: edge.latencyMs ?? 0,
      bandwidthRps: edge.bandwidthRps ?? 0,
      lossRate: edge.lossRate ?? 0,
    }));

  return JSON.stringify({ nodes: sortedNodes, edges: sortedEdges });
}

/**
 * Computes a deterministic 128-bit hex hash (32 lowercase hex chars) for a topology.
 *
 * Guaranteed:
 * - Pure TypeScript: zero dependencies, zero DOM, zero Node crypto, zero I/O.
 * - Synchronous and byte-identical across all JavaScript runtimes.
 * - Reproducible provenance artifact for EvaluationResult.
 */
export function hashTopology(topology: Topology, options?: HashOptions): string {
  const canonical = canonicalizeTopology(topology, options);
  const h1 = fnv1a64(canonical, FNV1A_64_OFFSET_1);
  const h2 = fnv1a64(canonical, FNV1A_64_OFFSET_2);
  const s1 = h1.toString(16).padStart(16, '0');
  const s2 = h2.toString(16).padStart(16, '0');
  return `${s1}${s2}`;
}
