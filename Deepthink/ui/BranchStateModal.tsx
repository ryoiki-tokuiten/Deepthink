/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Branch State & BSR Inspection Modal.
 * Provides complete mathematical and operational transparency into:
 * - Standing Event Ledger (confirmed progress/regression events)
 * - Deterministic decision rules & computed pressures (CONTINUE, EVOLVE, PRUNE)
 * - Window evidence: drift, critique alignment, and stall evidence
 * - Full raw BSR schema output
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeepthinkPipelineState } from '../core/deepthinkCore';
import type { BsrGlobalUpdateRecord } from '../core/types';
import { Icon } from '../../UI/Icons';

interface BranchStateModalProps {
  branchId: string;
  process: DeepthinkPipelineState;
  onClose: () => void;
}

export const BranchStateModal: React.FC<BranchStateModalProps> = ({
  branchId,
  process,
  onClose,
}) => {
  const branch = process.initialStrategies.find(s => s.id === branchId);
  const ledger = (process.branchLedgers && process.branchLedgers[branchId]) || [];
  const records = (process.bsrRecords || []).filter(r => r.branch_id === branchId);

  const [selectedUpdateIdx, setSelectedUpdateIdx] = useState<number>(
    Math.max(0, records.length - 1)
  );
  const [showRawJson, setShowRawJson] = useState(false);

  const activeRecord: BsrGlobalUpdateRecord | undefined = records[selectedUpdateIdx];
  const computed = activeRecord?.computed;
  const report = activeRecord?.report;

  // Window bounds
  const updateIteration = activeRecord?.iteration || 0;
  const windowInterval = process.runConfig?.j || 5;
  const windowStart = Math.max(1, updateIteration - windowInterval + 1);
  const windowEnd = updateIteration;

  // Parameters from runConfig
  const tau = process.runConfig?.bsrNoiseLevel ?? 2;
  const theta = process.runConfig?.bsrPressureFloor ?? 0.3;

  // Ledger summary
  let netLife = 0;
  let movementLife = 0;
  ledger.forEach(entry => {
    if (entry.direction === 'progress') netLife += entry.weight;
    else netLife -= entry.weight;
    movementLife += entry.weight;
  });
  const progressKept = movementLife > 0 ? (netLife / (movementLife + tau)).toFixed(3) : '0.000';

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content bsr-modal-content custom-scrollbar"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="bsr-modal-title"
      >
        {/* Header */}
        <div className="modal-header bsr-modal-header">
          <div className="bsr-header-title-group">
            <Icon name="insights" className="bsr-header-icon" />
            <div>
              <h3 id="bsr-modal-title">
                Branch State Representation & Decision — {branchId}
              </h3>
              <p className="bsr-header-strategy-text">
                {branch?.strategyText || 'No strategy text available.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            aria-label="Close modal"
          >
            <Icon name="close" />
          </button>
        </div>

        {/* Body */}
        <div className="bsr-modal-body">
          {/* Standing Ledger Overview */}
          <section className="bsr-section">
            <div className="bsr-section-header">
              <Icon name="receipt_long" />
              <h4>Standing Event Ledger</h4>
              <div className="bsr-ledger-metrics">
                <span className="bsr-metric-pill">Net: {netLife >= 0 ? `+${netLife}` : netLife}</span>
                <span className="bsr-metric-pill">Movement: {movementLife}</span>
                <span className="bsr-metric-pill">Progress Kept: {progressKept}</span>
              </div>
            </div>

            {ledger.length === 0 ? (
              <p className="bsr-empty-note">
                Ledger is currently empty. Confirmed progress and regression events are recorded at each global update.
              </p>
            ) : (
              <div className="bsr-table-container">
                <table className="bsr-table">
                  <thead>
                    <tr>
                      <th>Iter</th>
                      <th>Direction</th>
                      <th>Size</th>
                      <th>Weight</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry, idx) => (
                      <tr key={idx}>
                        <td>{entry.iteration}</td>
                        <td>
                          <span className={`bsr-direction-badge ${entry.direction}`}>
                            {entry.direction.toUpperCase()}
                          </span>
                        </td>
                        <td>{entry.size}</td>
                        <td>{entry.weight}</td>
                        <td className="bsr-reason-cell">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Global Update Selector */}
          {records.length > 0 && (
            <div className="bsr-update-selector-bar">
              <span className="bsr-selector-label">Global Update Evaluation:</span>
              <div className="bsr-selector-pills">
                {records.map((r, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`bsr-selector-pill ${idx === selectedUpdateIdx ? 'active' : ''}`}
                    onClick={() => setSelectedUpdateIdx(idx)}
                  >
                    Update #{r.updateNumber} (Iter {r.iteration})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Active Record Details */}
          {activeRecord && computed && (
            <>
              {/* Decision Card */}
              <section className="bsr-decision-card">
                <div className="bsr-decision-top">
                  <div className="bsr-decision-badge-group">
                    <span className="bsr-decision-label">Deterministic Decision:</span>
                    <span className={`bsr-action-badge action-${computed.decision.toLowerCase()}`}>
                      {computed.decision}
                    </span>
                    {computed.form && (
                      <span className="bsr-form-badge">
                        {computed.form === 'rollback'
                          ? `Rollback to ${computed.rollback_to === 'window_start' ? 'Window Start' : `Iter ${computed.rollback_to}`}`
                          : 'In Place'}
                      </span>
                    )}
                  </div>
                  <span className="bsr-outcome-pill">
                    Window Outcome: {computed.window_outcome}
                  </span>
                </div>

                <div className="bsr-decision-explanation">
                  <strong>Decision Rule Explanation:</strong>
                  {computed.decision === 'CONTINUE' && (
                    <p>
                      CONTINUE was chosen because pressures for EVOLVE ({computed.pressure.EVOLVE.toFixed(3)}) and PRUNE ({computed.pressure.PRUNE.toFixed(3)}) were below threshold θ ({theta.toFixed(2)}), or CONTINUE ({computed.pressure.CONTINUE.toFixed(3)}) had higher evidence of improvement in the window.
                    </p>
                  )}
                  {computed.decision === 'EVOLVE' && (
                    <p>
                      EVOLVE was selected because EVOLVE pressure ({computed.pressure.EVOLVE.toFixed(3)}) cleared threshold θ ({theta.toFixed(2)}) and beat both CONTINUE ({computed.pressure.CONTINUE.toFixed(3)}) and PRUNE ({computed.pressure.PRUNE.toFixed(3)}). Form is <strong>{computed.form}</strong> based on lost ground ({computed.lost_ground.toFixed(3)}) vs stall evidence ({computed.stall_evidence.toFixed(3)}).
                    </p>
                  )}
                  {computed.decision === 'PRUNE' && (
                    <p>
                      PRUNE was selected because the branch ran dry with little progress kept ({computed.progress_kept.toFixed(3)}), no ground to recover via rollback, and PRUNE pressure ({computed.pressure.PRUNE.toFixed(3)}) cleared threshold θ ({theta.toFixed(2)}).
                    </p>
                  )}
                </div>
              </section>

              {/* Mathematical Metrics Grid */}
              <section className="bsr-metrics-grid">
                {/* Window Metrics */}
                <div className="bsr-metric-box">
                  <h5>Running Window Metrics</h5>
                  <div className="bsr-metric-row">
                    <span>Window Interval:</span>
                    <strong>Iter {windowStart} – {windowEnd}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Net Change:</span>
                    <strong>{computed.net >= 0 ? `+${computed.net}` : computed.net}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Total Movement:</span>
                    <strong>{computed.movement}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Last Good Iteration:</span>
                    <strong>{computed.last_good_iteration}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Lost Ground:</span>
                    <strong>{computed.lost_ground.toFixed(3)}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Progress Kept:</span>
                    <strong>{computed.progress_kept.toFixed(3)}</strong>
                  </div>
                </div>

                {/* Window Evidence */}
                <div className="bsr-metric-box">
                  <h5>Window Evidence</h5>
                  <div className="bsr-metric-row">
                    <span>Drift:</span>
                    <strong>{computed.drift.toFixed(3)}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Critique Alignment:</span>
                    <strong>{report?.critique_alignment.value.toFixed(2) || '0.00'}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Stall Evidence:</span>
                    <strong>{computed.stall_evidence.toFixed(3)}</strong>
                  </div>
                </div>

                {/* Pressure Scores */}
                <div className="bsr-metric-box">
                  <h5>Action Pressures (θ = 0.30)</h5>
                  <div className="bsr-metric-row">
                    <span>Pressure [CONTINUE]:</span>
                    <strong>{computed.pressure.CONTINUE.toFixed(3)}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Pressure [EVOLVE]:</span>
                    <strong>{computed.pressure.EVOLVE.toFixed(3)}</strong>
                  </div>
                  <div className="bsr-metric-row">
                    <span>Pressure [PRUNE]:</span>
                    <strong>{computed.pressure.PRUNE.toFixed(3)}</strong>
                  </div>
                  <div className="bsr-pressure-bar-container">
                    <div
                      className="bsr-pressure-fill continue"
                      style={{ width: `${Math.min(100, computed.pressure.CONTINUE * 100)}%` }}
                      title={`CONTINUE: ${computed.pressure.CONTINUE.toFixed(3)}`}
                    />
                    <div
                      className="bsr-pressure-fill evolve"
                      style={{ width: `${Math.min(100, computed.pressure.EVOLVE * 100)}%` }}
                      title={`EVOLVE: ${computed.pressure.EVOLVE.toFixed(3)}`}
                    />
                    <div
                      className="bsr-pressure-fill prune"
                      style={{ width: `${Math.min(100, computed.pressure.PRUNE * 100)}%` }}
                      title={`PRUNE: ${computed.pressure.PRUNE.toFixed(3)}`}
                    />
                  </div>
                </div>
              </section>

              {/* Raw JSON Schema Toggle */}
              <section className="bsr-json-section">
                <button
                  type="button"
                  className="bsr-raw-json-toggle"
                  onClick={() => setShowRawJson(s => !s)}
                >
                  <Icon name={showRawJson ? 'expand_less' : 'code'} />
                  {showRawJson ? 'Hide Raw BSR JSON Schema' : 'Inspect Raw BSR JSON Schema'}
                </button>
                {showRawJson && (
                  <pre className="bsr-raw-json-block">
                    {JSON.stringify(activeRecord, null, 2)}
                  </pre>
                )}
              </section>
            </>
          )}

          {records.length === 0 && (
            <div className="bsr-no-records">
              <Icon name="hourglass_empty" />
              <p>
                No Global Updates completed yet for branch {branchId}. Global updates occur every {process.runConfig?.j || 5} iterations according to the loop schedule.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
