import { describe, expect, it } from 'vitest';
import { hashTopology, canonicalizeTopology } from './hash';
import type { Topology } from '../types';
import { defaultConfig } from '../presets';

function makeTestTopology(): Topology {
  return {
    nodes: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Client',
        x: 100,
        y: 200,
        config: defaultConfig('client'),
      },
      {
        id: 'service-1',
        kind: 'service',
        label: 'API',
        x: 300,
        y: 200,
        config: defaultConfig('service'),
      },
    ],
    edges: [
      {
        id: 'e1',
        from: 'client-1',
        to: 'service-1',
        weight: 1,
      },
    ],
  };
}

describe('hashTopology deterministic provenance', () => {
  it('1. produces a 32-character hexadecimal string', () => {
    const topo = makeTestTopology();
    const hash = hashTopology(topo);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('2. is byte-identical across multiple invocations', () => {
    const topo = makeTestTopology();
    const h1 = hashTopology(topo);
    const h2 = hashTopology(topo);
    expect(h1).toBe(h2);
  });

  it('3. is invariant to node insertion order', () => {
    const topo1 = makeTestTopology();
    const topo2: Topology = {
      nodes: [topo1.nodes[1], topo1.nodes[0]],
      edges: [...topo1.edges],
    };
    expect(hashTopology(topo1)).toBe(hashTopology(topo2));
    expect(canonicalizeTopology(topo1)).toBe(canonicalizeTopology(topo2));
  });

  it('4. is invariant to edge insertion order', () => {
    const topo1: Topology = {
      nodes: [
        {
          id: 'a',
          kind: 'client',
          label: 'A',
          x: 0,
          y: 0,
          config: defaultConfig('client'),
        },
        {
          id: 'b',
          kind: 'service',
          label: 'B',
          x: 0,
          y: 0,
          config: defaultConfig('service'),
        },
        { id: 'c', kind: 'db', label: 'C', x: 0, y: 0, config: defaultConfig('db') },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', weight: 1 },
        { id: 'e2', from: 'b', to: 'c', weight: 1 },
      ],
    };

    const topo2: Topology = {
      nodes: [...topo1.nodes],
      edges: [topo1.edges[1], topo1.edges[0]],
    };

    expect(hashTopology(topo1)).toBe(hashTopology(topo2));
  });

  it('5. is invariant to config object key order', () => {
    const cfgA = { capacity: 10, serviceMs: 20, queueLimit: 50 };
    const cfgB = { queueLimit: 50, serviceMs: 20, capacity: 10 };

    const topo1: Topology = {
      nodes: [
        { id: 'n1', kind: 'service', label: 'N', x: 0, y: 0, config: cfgA as any },
      ],
      edges: [],
    };
    const topo2: Topology = {
      nodes: [
        { id: 'n1', kind: 'service', label: 'N', x: 0, y: 0, config: cfgB as any },
      ],
      edges: [],
    };

    expect(hashTopology(topo1)).toBe(hashTopology(topo2));
  });

  it('6. detects architectural alterations (config changes, kinds, weights)', () => {
    const base = makeTestTopology();
    const modifiedConfig: Topology = {
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], config: { ...base.nodes[1].config, capacity: 999 } },
      ],
      edges: [...base.edges],
    };
    const modifiedWeight: Topology = {
      nodes: [...base.nodes],
      edges: [{ ...base.edges[0], weight: 0.5 }],
    };
    const modifiedKind: Topology = {
      nodes: [base.nodes[0], { ...base.nodes[1], kind: 'db' }],
      edges: [...base.edges],
    };

    const baseHash = hashTopology(base);
    expect(hashTopology(modifiedConfig)).not.toBe(baseHash);
    expect(hashTopology(modifiedWeight)).not.toBe(baseHash);
    expect(hashTopology(modifiedKind)).not.toBe(baseHash);
  });

  it('7. ignores canvas coordinates by default, but respects them when configured', () => {
    const topo1 = makeTestTopology();
    const topo2: Topology = {
      nodes: [
        { ...topo1.nodes[0], x: 500, y: 600 },
        { ...topo1.nodes[1], x: 700, y: 800 },
      ],
      edges: [...topo1.edges],
    };

    // Default architectural hash ignores visual layout
    expect(hashTopology(topo1)).toBe(hashTopology(topo2));

    // When includeCoordinates is enabled, moving nodes changes the hash
    expect(hashTopology(topo1, { includeCoordinates: true })).not.toBe(
      hashTopology(topo2, { includeCoordinates: true }),
    );
  });
});
