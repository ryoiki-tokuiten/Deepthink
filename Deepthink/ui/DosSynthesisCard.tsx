import React from 'react';
import type { DeepthinkPipelineState } from '../core/deepthinkCore';
import type { DosOutput } from '../core/types';
import { Icon } from '../../UI/Icons';
import MathHTML from '../../Styles/Components/RenderMathMarkdown';

interface DosSynthesisCardProps {
  process: DeepthinkPipelineState;
  heartbeatNo?: number;
  entry?: { callType: 'heartbeat' | 'step_i' | 'step_ii'; iteration: number; output: DosOutput };
}

function formatBranchLabel(id: string): string {
  if (id.startsWith('main')) {
    const num = id.slice(4).replace(/\D/g, '');
    return `Strategy ${num || id.slice(4)}`;
  }
  if (id.toLowerCase().startsWith('strategy')) {
    const num = id.replace(/\D/g, '');
    return `Strategy ${num || id}`;
  }
  return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export const DosSynthesisCard: React.FC<DosSynthesisCardProps> = ({ process, heartbeatNo, entry }) => {
  const heartbeatDosList = (process.dosOutputs || []).filter(d => d.callType !== 'step_i');

  const matchingHb = heartbeatNo !== undefined ? (process.heartbeats || []).find(h => h.heartbeat_no === heartbeatNo) : undefined;

  const resolvedSyncedEntry = entry || (heartbeatNo !== undefined
    ? (matchingHb ? heartbeatDosList.find(d => d.iteration === matchingHb.iteration) : undefined) || heartbeatDosList[heartbeatNo - 1]
    : undefined);

  const activeEntry = resolvedSyncedEntry || heartbeatDosList[heartbeatDosList.length - 1];

  if (!activeEntry) {
    return null;
  }

  const dos: DosOutput = activeEntry.output;
  const feedbackList = dos.module_feedback || [];

  // Collect branch utilization mappings
  const branchIds = new Set<string>();
  (process.initialStrategies || []).forEach(s => branchIds.add(s.id));
  feedbackList.forEach(fb => {
    (fb.branch_utilization || []).forEach(u => branchIds.add(u.branch_id));
  });

  const branchMappings = Array.from(branchIds).map(branchId => {
    let highestScore = 1;
    let statusClass = 'not-used';
    let badgeText = 'NOT USED';
    let tooltip = '';

    for (const fb of feedbackList) {
      const matchingUtil = (fb.branch_utilization || []).find(
        u => u.branch_id === branchId || u.branch_id.replace(/\D/g, '') === branchId.replace(/\D/g, '')
      );
      if (matchingUtil) {
        const cls = matchingUtil.utilization?.classification;
        tooltip = matchingUtil.utilization?.reason || '';
        if (cls === 'USED_CORRECTLY') {
          highestScore = 3;
          statusClass = 'strong';
          badgeText = 'STRONG';
          break;
        } else if (cls === 'USED_PARTIALLY' && highestScore < 2) {
          highestScore = 2;
          statusClass = 'partial';
          badgeText = 'PARTIAL';
        } else if (cls === 'MISUSED' && highestScore < 1) {
          highestScore = 0;
          statusClass = 'misused';
          badgeText = 'MISUSED';
        }
      }
    }

    if (feedbackList.length === 0) {
      highestScore = 2;
      statusClass = 'active';
      badgeText = 'ACTIVE';
      tooltip = 'Utilization tracking active';
    }

    return {
      branchId,
      label: formatBranchLabel(branchId),
      level: highestScore,
      statusClass,
      badgeText,
      tooltip,
    };
  });

  // Extract core synthesis entries into joined text paragraphs with bold, colorized titles
  const paragraphs: Array<{ title: string; color: string; content: React.ReactNode }> = [];
  if (dos.core_synthesis && Object.keys(dos.core_synthesis).length > 0) {
    Object.entries(dos.core_synthesis).forEach(([key, val]) => {
      const title = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) + ':';
      let color = '#a78bfa';
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('strength')) {
        color = '#10b981';
      } else if (lowerKey.includes('failure') || lowerKey.includes('mode') || lowerKey.includes('risk')) {
        color = '#f43f5e';
      } else if (lowerKey.includes('frontier') || lowerKey.includes('promising') || lowerKey.includes('direction')) {
        color = '#06b6d4';
      }

      let contentNode: React.ReactNode = null;
      if (typeof val === 'string') {
        contentNode = <MathHTML content={val} />;
      } else if (Array.isArray(val)) {
        contentNode = <span>{val.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}</span>;
      } else {
        contentNode = <span>{JSON.stringify(val)}</span>;
      }

      paragraphs.push({ title, color, content: contentNode });
    });
  }

  return (
    <div className="dos-container">
      {/* Header bar */}
      <div className="dos-header-bar">
        <div className="dos-title-group">
          <Icon name="psychology" className="dos-title-icon" />
          <h4 className="dos-pinned-title">
            Dissected Observations Synthesis (DOS){heartbeatNo !== undefined ? ` — Heartbeat ${heartbeatNo}` : ''}
          </h4>
        </div>
      </div>

      {/* Main split body: Joined scrollable text block on left, Branch Utilization Mapping on right */}
      <div className="dos-pinned-body">
        <div className="dos-unified-text-scroll">
          {paragraphs.length === 0 ? (
            <p className="dos-paragraph-item dos-muted-text">
              No core synthesis recorded for this heartbeat.
            </p>
          ) : (
            paragraphs.map((p, idx) => (
              <div key={idx} className="dos-paragraph-item">
                <span className="dos-paragraph-lead" style={{ color: p.color }}>
                  {p.title}
                </span>{' '}
                <span className="dos-paragraph-content">
                  {p.content}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Visual packet & branch utilization mapping */}
        <div className="dos-utilization-panel">
          <div className="dos-util-panel-title">
            <Icon name="hub" className="dos-panel-icon" />
            <span>Branch Utilization</span>
          </div>
          <div className="dos-branch-meter-list">
            {branchMappings.map(b => (
              <div key={b.branchId} className={`dos-branch-meter-row status-${b.statusClass}`} title={b.tooltip}>
                <span className="dos-branch-name">{b.label}</span>
                <div className="dos-meter-wrapper">
                  <div className="dos-signal-meter" aria-label={`Strength ${b.level} of 3`}>
                    <span className={`meter-segment seg-1 ${b.level >= 1 ? 'active' : ''}`} />
                    <span className={`meter-segment seg-2 ${b.level >= 2 ? 'active' : ''}`} />
                    <span className={`meter-segment seg-3 ${b.level >= 3 ? 'active' : ''}`} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

