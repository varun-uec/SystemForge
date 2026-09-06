// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EvaluatorModal } from './EvaluatorModal';
import type { EvaluationDiff, EvaluationResult, Finding } from '../sim/evaluator/types';
import type { Topology } from '../sim/types';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(ui: React.ReactNode): void {
  act(() => root.render(ui));
}

const mockTopology: Topology = {
  nodes: [
    {
      id: 'db-1',
      kind: 'db',
      label: 'Primary Database',
      x: 0,
      y: 0,
      config: { capacity: 5, serviceMs: 30, readFraction: 0.85 } as any,
    },
  ],
  edges: [],
};

const mockFinding: Finding = {
  id: 'UNSCALED_READ_HEAVY_DB_db-1',
  category: 'static',
  severity: 'critical',
  title: 'Read-heavy datastore without read replicas',
  description: 'Database has heavy read load.',
  nodeId: 'db-1',
  evidence: [
    {
      metric: 'read_fraction',
      scenarioId: 'static_analysis',
      nodeId: 'db-1',
      value: 85,
      unit: 'pct',
      threshold: 75,
    },
  ],
  remediationId: 'ADD_READ_REPLICA_DB',
};

const mockResult: EvaluationResult = {
  version: '1.0',
  topologyHash: 'abcdef0123456789abcdef0123456789',
  simulatorVersion: '1.0',
  seed: 42,
  scenarios: [
    {
      scenarioId: 'baseline',
      p50Ms: 12,
      p95Ms: 25,
      p99Ms: 40,
      maxQueueDepth: { 'db-1': 0 },
      lostRequests: 0,
      totalRequests: 500,
      bottleneckNodeId: null,
      saturationTimeMs: null,
    },
  ],
  score: {
    resilience: 80,
    scalability: 60,
    costEfficiency: 90,
    simplicity: 85,
    correctness: 100,
    total: 81,
  },
  findings: [mockFinding],
  estimatedMonthlyCostUsd: 105,
  evaluatedAt: '2026-09-06T12:00:00.000Z',
};

const mockDiff: EvaluationDiff = {
  fromIterationId: 'iter-0',
  toIterationId: 'iter-1',
  scoreDelta: {
    resilience: 5,
    scalability: 20,
    costEfficiency: -10,
    simplicity: 0,
    correctness: 0,
    total: 8,
  },
  p99DeltaMs: -15,
  lostRequestsDeltaPct: -2.5,
  costDeltaUsd: 70,
  resolvedFindingIds: ['UNSCALED_READ_HEAVY_DB_db-1'],
  newFindingIds: [],
};

describe('EvaluatorModal component', () => {
  it('1. renders nothing when closed', () => {
    render(
      <EvaluatorModal
        open={false}
        onClose={vi.fn()}
        topology={mockTopology}
        result={mockResult}
        isEvaluating={false}
        history={[]}
        activeDiff={null}
        onApplyFix={vi.fn()}
        onSelectIteration={vi.fn()}
      />,
    );

    expect(document.querySelector('.eval-card')).toBeNull();
  });

  it('2. renders progress spinner and steps while isEvaluating is true', () => {
    render(
      <EvaluatorModal
        open={true}
        onClose={vi.fn()}
        topology={mockTopology}
        result={null}
        isEvaluating={true}
        history={[]}
        activeDiff={null}
        onApplyFix={vi.fn()}
        onSelectIteration={vi.fn()}
      />,
    );

    expect(document.querySelector('.eval-spinner')).not.toBeNull();
    expect(document.body.textContent).toContain('Simulating & Evaluating Topology');
    expect(document.body.textContent).toContain('Baseline Scenario');
  });

  it('3. renders scorecard, total score, and dimensions when result is present', () => {
    render(
      <EvaluatorModal
        open={true}
        onClose={vi.fn()}
        topology={mockTopology}
        result={mockResult}
        isEvaluating={false}
        history={[]}
        activeDiff={null}
        onApplyFix={vi.fn()}
        onSelectIteration={vi.fn()}
      />,
    );

    expect(document.querySelector('.eval-score-hero-num')?.textContent).toBe('81');
    expect(document.body.textContent).toContain('Availability & Resilience');
    expect(document.body.textContent).toContain('Scalability & Latency');
    expect(document.body.textContent).toContain(
      'Read-heavy datastore without read replicas',
    );
    expect(document.body.textContent).toContain('Observed Simulator Evidence');
    expect(document.body.textContent).toContain('Apply Fix');
  });

  it('4. triggers onApplyFix when user clicks Apply Fix button', () => {
    const onApplyFix = vi.fn();

    render(
      <EvaluatorModal
        open={true}
        onClose={vi.fn()}
        topology={mockTopology}
        result={mockResult}
        isEvaluating={false}
        history={[]}
        activeDiff={null}
        onApplyFix={onApplyFix}
        onSelectIteration={vi.fn()}
      />,
    );

    const applyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Apply Fix',
    );
    expect(applyBtn).toBeDefined();

    act(() => {
      applyBtn?.click();
    });

    expect(onApplyFix).toHaveBeenCalledWith(mockFinding, 'ADD_READ_REPLICA_DB');
  });

  it('5. renders before/after diff tab and deltas when activeDiff is present', () => {
    render(
      <EvaluatorModal
        open={true}
        onClose={vi.fn()}
        topology={mockTopology}
        result={mockResult}
        isEvaluating={false}
        history={[]}
        activeDiff={mockDiff}
        onApplyFix={vi.fn()}
        onSelectIteration={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain('Simulation Diff Comparison');
    expect(document.body.textContent).toContain('+8');
    expect(document.body.textContent).toContain('-15ms');
    expect(document.body.textContent).toContain('Resolved Findings (1)');
  });
});
