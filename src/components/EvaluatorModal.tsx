import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import {
  createEvaluationBundle,
  generateFindingExplanation,
  type AIConfig,
  type AIProvider,
} from '../sim/evaluator/ai';
import { REMEDIATION_REGISTRY } from '../sim/evaluator/registry';
import type {
  AIRecommendation,
  EvaluationDiff,
  EvaluationResult,
  Finding,
  HistoryIteration,
  Severity,
} from '../sim/evaluator/types';
import type { Topology } from '../sim/types';
import './EvaluatorModal.css';

export interface EvaluatorModalProps {
  open: boolean;
  onClose: () => void;
  topology: Topology;
  result: EvaluationResult | null;
  isEvaluating: boolean;
  history: readonly HistoryIteration[];
  activeDiff: EvaluationDiff | null;
  onApplyFix: (finding: Finding, remediationId?: string) => void;
  onSelectIteration: (iterationId: string) => void;
  onSelectNodeOrEdge?: (target: { nodeId?: string; edgeId?: string }) => void;
}

type TabType = 'scorecard' | 'diff' | 'scenarios' | 'ai-settings';

function loadStoredAiConfig(): { provider: AIProvider; apiKey: string; model: string } {
  try {
    const stored =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('breakscale.evaluator.ai.v1')
        : null;
    if (stored) {
      const parsed = JSON.parse(stored) as {
        provider?: AIProvider;
        apiKey?: string;
        model?: string;
      };
      return {
        provider: parsed.provider ?? 'builtin',
        apiKey: parsed.apiKey ?? '',
        model: parsed.model ?? '',
      };
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return { provider: 'builtin', apiKey: '', model: '' };
}

export function EvaluatorModal({
  open,
  onClose,
  topology,
  result,
  isEvaluating,
  history,
  activeDiff,
  onApplyFix,
  onSelectIteration,
  onSelectNodeOrEdge,
}: EvaluatorModalProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const [activeTab, setActiveTab] = useState<TabType>(
    activeDiff ? 'diff' : 'scorecard',
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [copiedBundle, setCopiedBundle] = useState(false);

  const [storedAiConfig] = useState(loadStoredAiConfig);
  const [aiProvider, setAiProvider] = useState<AIProvider>(storedAiConfig.provider);
  const [aiKey, setAiKey] = useState<string>(storedAiConfig.apiKey);
  const [aiModel, setAiModel] = useState<string>(storedAiConfig.model);
  const [aiRecommendation, setAiRecommendation] = useState<AIRecommendation | null>(
    null,
  );

  // Focus management
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    card?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
    };
  }, [open]);

  const saveAiConfig = (provider: AIProvider, key: string, model: string) => {
    setAiProvider(provider);
    setAiKey(key);
    setAiModel(model);
    try {
      localStorage.setItem(
        'breakscale.evaluator.ai.v1',
        JSON.stringify({ provider, apiKey: key, model }),
      );
    } catch {
      // Ignore
    }
  };

  // Derived active finding
  const activeFinding =
    (selectedFindingId
      ? result?.findings.find((f) => f.id === selectedFindingId)
      : null) ??
    result?.findings.find((f) => f.severity === 'critical') ??
    result?.findings[0] ??
    null;

  const isLoadingAi =
    Boolean(activeFinding) &&
    (!aiRecommendation || aiRecommendation.findingId !== activeFinding?.id);

  useEffect(() => {
    if (!activeFinding || !result) return;

    let isSubscribed = true;
    const bundle = createEvaluationBundle(topology, result);
    const config: AIConfig = {
      provider: aiProvider,
      apiKey: aiKey || undefined,
      model: aiModel || undefined,
    };

    void generateFindingExplanation(activeFinding, bundle, config).then((rec) => {
      if (isSubscribed) {
        setAiRecommendation(rec);
      }
    });

    return () => {
      isSubscribed = false;
    };
  }, [activeFinding, result, topology, aiProvider, aiKey, aiModel]);

  if (!mounted) return null;

  const filteredFindings = (result?.findings ?? []).filter((f) => {
    if (severityFilter === 'all') return true;
    return f.severity === severityFilter;
  });

  const criticalFindings = (result?.findings ?? []).filter(
    (f) => f.severity === 'critical',
  );

  const handleExportBundle = () => {
    if (!result) return;
    const bundle = createEvaluationBundle(topology, result);
    const json = JSON.stringify(bundle, null, 2);
    void navigator.clipboard.writeText(json).then(() => {
      setCopiedBundle(true);
      setTimeout(() => setCopiedBundle(false), 2000);
    });
  };

  const handleDownloadBundle = () => {
    if (!result) return;
    const bundle = createEvaluationBundle(topology, result);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `breakscale-evaluation-${result.topologyHash.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFindingClick = (finding: Finding) => {
    setSelectedFindingId(finding.id);
    if (onSelectNodeOrEdge) {
      onSelectNodeOrEdge({ nodeId: finding.nodeId, edgeId: finding.edgeId });
    }
  };

  const scoreTotal = result?.score.total ?? 0;
  const scoreBadgeClass =
    scoreTotal >= 85 ? 'is-optimal' : scoreTotal >= 60 ? 'is-warning' : 'is-critical';
  const scoreBadgeText =
    scoreTotal >= 85
      ? 'Optimal'
      : scoreTotal >= 60
        ? 'Needs Attention'
        : 'Critical Risks';

  return createPortal(
    <div
      className={`eval-root${closing ? ' is-closing' : ''}`}
      data-chrome="evaluator"
      inert={closing || undefined}
    >
      <div className="eval-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="eval-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        {/* Header */}
        <header className="eval-header">
          <div className="eval-header-title-group">
            <h2 id={titleId} className="eval-title">
              System Design Evaluation
            </h2>
            {result && (
              <span
                className="eval-provenance-tag"
                title={`Simulation seed: ${result.seed}`}
              >
                hash:{result.topologyHash.slice(0, 8)} | v{result.simulatorVersion}
              </span>
            )}
          </div>
          <div className="eval-header-actions">
            {result && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleExportBundle}
                  title="Copy full evaluation bundle JSON to clipboard"
                >
                  {copiedBundle ? 'Copied Bundle!' : 'Copy Bundle'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleDownloadBundle}
                  title="Download evaluation bundle JSON file"
                >
                  Download JSON
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={onClose}
              aria-label="Close evaluation dialog"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {/* Experiment History Timeline */}
        {history.length > 0 && (
          <div className="eval-history-bar" aria-label="Experiment history">
            <span className="eval-history-label">Iterations:</span>
            {history.map((it, idx) => {
              const isCurrent = result?.topologyHash === it.result.topologyHash;
              return (
                <button
                  key={it.id}
                  type="button"
                  className={`eval-history-item${isCurrent ? ' is-active' : ''}`}
                  onClick={() => onSelectIteration(it.id)}
                >
                  <span>{it.label || `Iteration ${idx}`}</span>
                  <span className="eval-history-score">({it.result.score.total})</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Navigation Tabs */}
        {result && !isEvaluating && (
          <nav className="eval-nav-tabs" aria-label="Evaluation views">
            <button
              type="button"
              className={`eval-tab-btn${activeTab === 'scorecard' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('scorecard')}
            >
              Scorecard & Findings
            </button>
            <button
              type="button"
              className={`eval-tab-btn${activeTab === 'diff' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('diff')}
            >
              Before / After Diff {activeDiff ? '•' : ''}
            </button>
            <button
              type="button"
              className={`eval-tab-btn${activeTab === 'scenarios' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('scenarios')}
            >
              Measured Scenarios
            </button>
            <button
              type="button"
              className={`eval-tab-btn${activeTab === 'ai-settings' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('ai-settings')}
            >
              AI Settings ({aiProvider})
            </button>
          </nav>
        )}

        {/* Evaluating progress state */}
        {isEvaluating && (
          <div className="eval-progress-container">
            <div className="eval-spinner" aria-hidden="true" />
            <h3 className="eval-title">Simulating & Evaluating Topology...</h3>
            <p className="eval-prose">
              Executing discrete-event scenario suite and measuring exact latencies.
            </p>
            <div className="eval-progress-steps">
              <div className="eval-progress-step is-done">
                <span>1. Baseline Scenario (10s @ 1x load)</span>
                <span>Measured</span>
              </div>
              <div className="eval-progress-step is-done">
                <span>2. Traffic Spike (10s @ 3x load)</span>
                <span>Measured</span>
              </div>
              <div className="eval-progress-step is-done">
                <span>3. Cache Failure Scenario (Crash @ 2s)</span>
                <span>Measured</span>
              </div>
              <div className="eval-progress-step is-done">
                <span>4. Graph Linting & Stability Analysis</span>
                <span>Verified</span>
              </div>
              <div className="eval-progress-step is-done">
                <span>5. Deterministic Rubric Scoring</span>
                <span>Scored</span>
              </div>
            </div>
          </div>
        )}

        {/* Result views */}
        {!isEvaluating && result && (
          <div className="eval-body">
            {activeTab === 'scorecard' && (
              <>
                {/* Scorecard Hero Banner */}
                <div className="eval-scorecard-banner">
                  <div className="eval-score-hero-box">
                    <span className="eval-score-hero-label">System Design Score</span>
                    <div>
                      <span className="eval-score-hero-num">{result.score.total}</span>
                      <span className="eval-score-hero-max">/ 100</span>
                    </div>
                    <span className={`eval-score-hero-badge ${scoreBadgeClass}`}>
                      {scoreBadgeText}
                    </span>
                    <span className="eval-cost-pill">
                      Est. ${result.estimatedMonthlyCostUsd}/mo
                    </span>
                  </div>

                  <div className="eval-dimensions-grid">
                    <div className="eval-dim-row">
                      <div className="eval-dim-meta">
                        <span className="eval-dim-title">
                          Availability & Resilience
                          <span className="eval-dim-weight">(30%)</span>
                        </span>
                        <span className="eval-dim-score">
                          {result.score.resilience} / 100
                        </span>
                      </div>
                      <div className="eval-dim-track">
                        <div
                          className="eval-dim-fill"
                          style={{ width: `${result.score.resilience}%` }}
                        />
                      </div>
                    </div>

                    <div className="eval-dim-row">
                      <div className="eval-dim-meta">
                        <span className="eval-dim-title">
                          Scalability & Latency
                          <span className="eval-dim-weight">(25%)</span>
                        </span>
                        <span className="eval-dim-score">
                          {result.score.scalability} / 100
                        </span>
                      </div>
                      <div className="eval-dim-track">
                        <div
                          className="eval-dim-fill"
                          style={{ width: `${result.score.scalability}%` }}
                        />
                      </div>
                    </div>

                    <div className="eval-dim-row">
                      <div className="eval-dim-meta">
                        <span className="eval-dim-title">
                          Cost Efficiency
                          <span className="eval-dim-weight">(20%)</span>
                        </span>
                        <span className="eval-dim-score">
                          {result.score.costEfficiency} / 100
                        </span>
                      </div>
                      <div className="eval-dim-track">
                        <div
                          className="eval-dim-fill"
                          style={{ width: `${result.score.costEfficiency}%` }}
                        />
                      </div>
                    </div>

                    <div className="eval-dim-row">
                      <div className="eval-dim-meta">
                        <span className="eval-dim-title">
                          Operational Simplicity
                          <span className="eval-dim-weight">(15%)</span>
                        </span>
                        <span className="eval-dim-score">
                          {result.score.simplicity} / 100
                        </span>
                      </div>
                      <div className="eval-dim-track">
                        <div
                          className="eval-dim-fill"
                          style={{ width: `${result.score.simplicity}%` }}
                        />
                      </div>
                    </div>

                    <div className="eval-dim-row">
                      <div className="eval-dim-meta">
                        <span className="eval-dim-title">
                          Correctness & Consistency
                          <span className="eval-dim-weight">(10%)</span>
                        </span>
                        <span className="eval-dim-score">
                          {result.score.correctness} / 100
                        </span>
                      </div>
                      <div className="eval-dim-track">
                        <div
                          className="eval-dim-fill"
                          style={{ width: `${result.score.correctness}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Headline Alert */}
                {criticalFindings.length > 0 ? (
                  <div className="eval-headline-alert is-critical">
                    <strong>Critical Bottleneck:</strong>
                    <span>{criticalFindings[0].title}</span>
                  </div>
                ) : (
                  <div className="eval-headline-alert is-nominal">
                    <strong>System Nominal:</strong>
                    <span>
                      No critical architecture bottlenecks detected under tested loads.
                    </span>
                  </div>
                )}

                {/* Split Findings + Explainer */}
                <div className="eval-split-layout">
                  {/* Left: Findings List */}
                  <div className="eval-findings-panel">
                    <div className="eval-findings-header">
                      <h4 className="eval-findings-title">
                        Findings ({result.findings.length})
                      </h4>
                      <div className="eval-filter-chips">
                        <button
                          type="button"
                          className={`eval-chip${severityFilter === 'all' ? ' is-active' : ''}`}
                          onClick={() => setSeverityFilter('all')}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className={`eval-chip${severityFilter === 'critical' ? ' is-active' : ''}`}
                          onClick={() => setSeverityFilter('critical')}
                        >
                          Critical
                        </button>
                        <button
                          type="button"
                          className={`eval-chip${severityFilter === 'warning' ? ' is-active' : ''}`}
                          onClick={() => setSeverityFilter('warning')}
                        >
                          Warn
                        </button>
                      </div>
                    </div>

                    <div className="eval-findings-list">
                      {filteredFindings.length === 0 ? (
                        <p className="eval-prose" style={{ padding: '8px' }}>
                          No findings match the selected filter.
                        </p>
                      ) : (
                        filteredFindings.map((f) => {
                          const isSelected = f.id === selectedFindingId;
                          return (
                            <button
                              key={f.id}
                              type="button"
                              className={`eval-finding-card${isSelected ? ' is-selected' : ''}`}
                              onClick={() => handleFindingClick(f)}
                            >
                              <div className="eval-finding-top">
                                <div className="eval-finding-badges">
                                  <span className={`eval-badge sev-${f.severity}`}>
                                    {f.severity}
                                  </span>
                                  <span className={`eval-badge cat-${f.category}`}>
                                    {f.category}
                                  </span>
                                </div>
                              </div>
                              <p className="eval-finding-name">{f.title}</p>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Right: AI Explanation & Fix Card */}
                  <div className="eval-explainer-card">
                    {activeFinding ? (
                      <>
                        <div className="eval-explainer-head">
                          <div>
                            <h3 className="eval-explainer-title">
                              {activeFinding.title}
                            </h3>
                            <p className="eval-explainer-subtitle">
                              {activeFinding.description}
                            </p>
                          </div>
                          <span className={`eval-badge sev-${activeFinding.severity}`}>
                            {activeFinding.severity}
                          </span>
                        </div>

                        {/* Observed Evidence */}
                        <div className="eval-section">
                          <h4 className="eval-section-title">
                            Observed Simulator Evidence
                          </h4>
                          {activeFinding.evidence.length === 0 ? (
                            <p className="eval-prose">No discrete metrics recorded.</p>
                          ) : (
                            <table className="eval-evidence-table">
                              <thead>
                                <tr>
                                  <th>Metric</th>
                                  <th>Scenario</th>
                                  <th>Measured</th>
                                  <th>Threshold</th>
                                </tr>
                              </thead>
                              <tbody>
                                {activeFinding.evidence.map((ev, idx) => (
                                  <tr key={idx}>
                                    <td>{ev.metric}</td>
                                    <td>{ev.scenarioId}</td>
                                    <td className="eval-evidence-value">
                                      {ev.value} {ev.unit}
                                    </td>
                                    <td>
                                      {ev.threshold !== undefined
                                        ? `${ev.threshold} ${ev.unit}`
                                        : 'None'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>

                        {/* AI Root Cause */}
                        <div className="eval-section">
                          <h4 className="eval-section-title">Root Cause Diagnosis</h4>
                          <p className="eval-prose">
                            {isLoadingAi
                              ? 'Analyzing simulation telemetry...'
                              : aiRecommendation?.rationale ||
                                'No specific diagnosis available.'}
                          </p>
                        </div>

                        {/* Trade-offs */}
                        {aiRecommendation && aiRecommendation.tradeoffs.length > 0 && (
                          <div className="eval-section">
                            <h4 className="eval-section-title">
                              Architectural Trade-offs
                            </h4>
                            <ul className="eval-tradeoffs-list">
                              {aiRecommendation.tradeoffs.map((t, i) => (
                                <li key={i}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Fix Box */}
                        {activeFinding.remediationId &&
                          REMEDIATION_REGISTRY[activeFinding.remediationId] && (
                            <div className="eval-fix-box">
                              <div className="eval-fix-meta">
                                <span className="eval-fix-title">
                                  {
                                    REMEDIATION_REGISTRY[activeFinding.remediationId]
                                      .title
                                  }
                                </span>
                                <span className="eval-fix-desc">
                                  {
                                    REMEDIATION_REGISTRY[activeFinding.remediationId]
                                      .description
                                  }
                                </span>
                              </div>
                              <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => {
                                  setActiveTab('diff');
                                  onApplyFix(
                                    activeFinding,
                                    activeFinding.remediationId,
                                  );
                                }}
                              >
                                Apply Fix
                              </button>
                            </div>
                          )}
                      </>
                    ) : (
                      <p className="eval-prose">
                        Select a finding to inspect diagnosis.
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Before / After Diff View */}
            {activeTab === 'diff' && (
              <div className="eval-diff-view">
                {activeDiff ? (
                  <>
                    <h3 className="eval-title">Simulation Diff Comparison</h3>
                    <p className="eval-prose">
                      Measured verification comparing iteration before and after
                      applying the trusted patch.
                    </p>

                    <div className="eval-diff-metrics-grid">
                      <div className="eval-diff-card">
                        <span className="eval-diff-label">Total Score Delta</span>
                        <span className="eval-diff-value">
                          {activeDiff.scoreDelta.total >= 0 ? '+' : ''}
                          {activeDiff.scoreDelta.total}
                        </span>
                        <span
                          className={`eval-diff-delta ${activeDiff.scoreDelta.total >= 0 ? 'is-good' : 'is-bad'}`}
                        >
                          {activeDiff.scoreDelta.total >= 0
                            ? 'Score Improved'
                            : 'Score Regressed'}
                        </span>
                      </div>

                      <div className="eval-diff-card">
                        <span className="eval-diff-label">p99 Latency Delta</span>
                        <span className="eval-diff-value">
                          {activeDiff.p99DeltaMs >= 0 ? '+' : ''}
                          {activeDiff.p99DeltaMs}ms
                        </span>
                        <span
                          className={`eval-diff-delta ${activeDiff.p99DeltaMs <= 0 ? 'is-good' : 'is-bad'}`}
                        >
                          {activeDiff.p99DeltaMs <= 0
                            ? 'Latency Reduced'
                            : 'Latency Increased'}
                        </span>
                      </div>

                      <div className="eval-diff-card">
                        <span className="eval-diff-label">Lost Requests Delta</span>
                        <span className="eval-diff-value">
                          {activeDiff.lostRequestsDeltaPct >= 0 ? '+' : ''}
                          {activeDiff.lostRequestsDeltaPct}%
                        </span>
                        <span
                          className={`eval-diff-delta ${activeDiff.lostRequestsDeltaPct <= 0 ? 'is-good' : 'is-bad'}`}
                        >
                          {activeDiff.lostRequestsDeltaPct <= 0
                            ? 'Fewer Drops'
                            : 'More Drops'}
                        </span>
                      </div>

                      <div className="eval-diff-card">
                        <span className="eval-diff-label">Monthly Cost Delta</span>
                        <span className="eval-diff-value">
                          {activeDiff.costDeltaUsd >= 0 ? '+' : ''}$
                          {activeDiff.costDeltaUsd}
                        </span>
                        <span className="eval-diff-delta">Estimated spend change</span>
                      </div>
                    </div>

                    <div className="eval-diff-findings-split">
                      <div className="eval-diff-box">
                        <h4 className="eval-section-title" style={{ color: '#2d6b38' }}>
                          Resolved Findings ({activeDiff.resolvedFindingIds.length})
                        </h4>
                        {activeDiff.resolvedFindingIds.length === 0 ? (
                          <p className="eval-prose">No findings were resolved.</p>
                        ) : (
                          <ul className="eval-tradeoffs-list">
                            {activeDiff.resolvedFindingIds.map((id) => (
                              <li key={id}>{id}</li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="eval-diff-box">
                        <h4 className="eval-section-title" style={{ color: '#8f2020' }}>
                          New Findings ({activeDiff.newFindingIds.length})
                        </h4>
                        {activeDiff.newFindingIds.length === 0 ? (
                          <p className="eval-prose">No new findings introduced.</p>
                        ) : (
                          <ul className="eval-tradeoffs-list">
                            {activeDiff.newFindingIds.map((id) => (
                              <li key={id}>{id}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="eval-prose">
                    No active differential to display. Apply a fix to view before/after
                    comparison.
                  </p>
                )}
              </div>
            )}

            {/* Measured Scenarios View */}
            {activeTab === 'scenarios' && (
              <div className="eval-telemetry-grid">
                {result.scenarios.map((s) => (
                  <div key={s.scenarioId} className="eval-telemetry-card">
                    <div className="eval-telemetry-head">
                      <h4 className="eval-telemetry-name">{s.scenarioId}</h4>
                      <span className="eval-provenance-tag">
                        {s.lostRequests > 0 ? 'Unstable' : 'Stable'}
                      </span>
                    </div>
                    <div className="eval-telemetry-rows">
                      <div className="eval-telemetry-row">
                        <span>p50 Latency</span>
                        <span className="eval-evidence-value">
                          {Math.round(s.p50Ms)}ms
                        </span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>p95 Latency</span>
                        <span className="eval-evidence-value">
                          {Math.round(s.p95Ms)}ms
                        </span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>p99 Tail Latency</span>
                        <span className="eval-evidence-value">
                          {Math.round(s.p99Ms)}ms
                        </span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>Total Requests</span>
                        <span className="eval-evidence-value">{s.totalRequests}</span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>Lost Requests</span>
                        <span
                          className="eval-evidence-value"
                          style={{ color: s.lostRequests > 0 ? '#8f2020' : undefined }}
                        >
                          {s.lostRequests}
                        </span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>Bottleneck Node</span>
                        <span className="eval-evidence-value">
                          {s.bottleneckNodeId ?? 'None'}
                        </span>
                      </div>
                      <div className="eval-telemetry-row">
                        <span>Saturation Time</span>
                        <span className="eval-evidence-value">
                          {s.saturationTimeMs !== null
                            ? `${s.saturationTimeMs}ms`
                            : 'None'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* AI Provider Settings View */}
            {activeTab === 'ai-settings' && (
              <div className="eval-settings-form">
                <h3 className="eval-title">AI Explainer Privacy & Provider</h3>
                <p className="eval-prose">
                  Breakscale maintains a zero-backend architecture. All provider
                  requests execute directly from your browser without an intermediary
                  server.
                </p>

                <div className="eval-field">
                  <label htmlFor="ai-provider-select">Provider</label>
                  <select
                    id="ai-provider-select"
                    value={aiProvider}
                    onChange={(e) =>
                      saveAiConfig(e.target.value as AIProvider, aiKey, aiModel)
                    }
                  >
                    <option value="builtin">
                      Built-in (Deterministic Rules, Offline)
                    </option>
                    <option value="openai">OpenAI (BYOK)</option>
                    <option value="anthropic">Anthropic (BYOK)</option>
                    <option value="google">Google Gemini (BYOK)</option>
                  </select>
                  <span className="eval-field-hint">
                    Built-in requires no key and works completely offline.
                  </span>
                </div>

                {aiProvider !== 'builtin' && (
                  <>
                    <div className="eval-field">
                      <label htmlFor="ai-key-input">API Key</label>
                      <input
                        id="ai-key-input"
                        type="password"
                        placeholder="sk-..."
                        value={aiKey}
                        onChange={(e) =>
                          saveAiConfig(aiProvider, e.target.value, aiModel)
                        }
                      />
                      <span className="eval-field-hint">
                        Stored locally in browser localStorage.
                      </span>
                    </div>

                    <div className="eval-field">
                      <label htmlFor="ai-model-input">Model Override (Optional)</label>
                      <input
                        id="ai-model-input"
                        type="text"
                        placeholder="e.g. gpt-4o-mini, claude-3-5-haiku-latest, gemini-1.5-flash"
                        value={aiModel}
                        onChange={(e) =>
                          saveAiConfig(aiProvider, aiKey, e.target.value)
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
