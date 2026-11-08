import React, { useEffect, useState, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { onHighlighterReady } from '../../Styles/Shiki';
import { Icon as MIcon, renderIconMarkup } from '../../UI/Icons';
import MathHTML from '../../Styles/Components/RenderMathMarkdown';
import { DeepthinkLiveTab } from './DeepthinkLiveTab';
import { DeepthinkFilesystemTab } from './DeepthinkFilesystemTab';
import {
    DeepthinkSolutionCritiqueData,
    DeepthinkModuleData,
    DeepthinkMainStrategyData,
    DeepthinkPipelineState,
    type DeepthinkCoreDeps,
    getActiveDeepthinkPipeline,
    setActiveDeepthinkPipelineForImport,
    initializeDeepthinkCore,
    startDeepthinkAnalysisProcess,
    resumeDeepthinkAnalysisProcess,
    stopDeepthinkAnalysisProcess,
    saveLatestDeepthinkState,
} from '../core/deepthinkCore';
import type { BsrGlobalUpdateRecord, DosOutput } from '../core/types';

export {
    resumeDeepthinkAnalysisProcess,
    stopDeepthinkAnalysisProcess,
    saveLatestDeepthinkState,
    startDeepthinkAnalysisProcess,
    getActiveDeepthinkPipeline,
    setActiveDeepthinkPipelineForImport,
};
export type {
    DeepthinkSolutionCritiqueData,
    DeepthinkModuleData,
    DeepthinkMainStrategyData,
    DeepthinkPipelineState,
};
export { DeepthinkPipelineOrchestrator } from '../core/pipelineOrchestrator';

function formatBranchLabel(id: string): string {
    if (id.startsWith('main')) return `Strategy ${id.slice(4).replace(/\D/g, '') || id.slice(4)}`;
    if (id.toLowerCase().startsWith('strategy')) return `Strategy ${id.replace(/\D/g, '') || id}`;
    return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export const DosSynthesisCard: React.FC<{
    process: DeepthinkPipelineState;
    heartbeatNo?: number;
    entry?: { callType: 'heartbeat' | 'step_i' | 'step_ii'; iteration: number; output: DosOutput };
}> = ({ process, heartbeatNo, entry }) => {
    const heartbeatDosList = (process.dosOutputs || []).filter(d => d.callType !== 'step_i');
    const matchingHb = heartbeatNo !== undefined ? (process.heartbeats || []).find(h => h.heartbeat_no === heartbeatNo) : undefined;
    const resolvedSyncedEntry = entry || (heartbeatNo !== undefined
        ? (matchingHb ? heartbeatDosList.find(d => d.iteration === matchingHb.iteration) : undefined) || heartbeatDosList[heartbeatNo - 1]
        : undefined);
    const activeEntry = resolvedSyncedEntry || heartbeatDosList[heartbeatDosList.length - 1];
    if (!activeEntry) return null;

    const dos: DosOutput = activeEntry.output;
    const feedbackList = dos.module_feedback || [];
    const branchIds = new Set<string>();
    (process.initialStrategies || []).forEach(s => branchIds.add(s.id));
    feedbackList.forEach(fb => (fb.branch_utilization || []).forEach(u => branchIds.add(u.branch_id)));

    const branchMappings = Array.from(branchIds).map(branchId => {
        let highestScore = 1, statusClass = 'not-used', tooltip = '';
        for (const fb of feedbackList) {
            const matchingUtil = (fb.branch_utilization || []).find(
                u => u.branch_id === branchId || u.branch_id.replace(/\D/g, '') === branchId.replace(/\D/g, '')
            );
            if (matchingUtil) {
                const cls = matchingUtil.utilization?.classification;
                tooltip = matchingUtil.utilization?.reason || '';
                if (cls === 'USED_CORRECTLY') { highestScore = 3; statusClass = 'strong'; break; }
                if (cls === 'USED_PARTIALLY' && highestScore < 2) { highestScore = 2; statusClass = 'partial'; }
                else if (cls === 'MISUSED' && highestScore < 1) { highestScore = 0; statusClass = 'misused'; }
            }
        }
        if (feedbackList.length === 0) {
            highestScore = 2;
            statusClass = 'active';
            tooltip = 'Utilization tracking active';
        }
        return { branchId, label: formatBranchLabel(branchId), level: highestScore, statusClass, tooltip };
    });

    const paragraphs: Array<{ title: string; color: string; content: React.ReactNode }> = [];
    if (dos.core_synthesis) {
        Object.entries(dos.core_synthesis).forEach(([key, val]) => {
            const title = `${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:`;
            const lowerKey = key.toLowerCase();
            const color = lowerKey.includes('strength') ? '#10b981'
                : (lowerKey.includes('failure') || lowerKey.includes('mode') || lowerKey.includes('risk')) ? '#f43f5e'
                : (lowerKey.includes('frontier') || lowerKey.includes('promising') || lowerKey.includes('direction')) ? '#06b6d4'
                : '#a78bfa';
            const content = typeof val === 'string'
                ? <MathHTML content={val} />
                : Array.isArray(val)
                    ? <span>{val.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}</span>
                    : <span>{JSON.stringify(val)}</span>;
            paragraphs.push({ title, color, content });
        });
    }

    return (
        <div className="dos-container">
            <div className="dos-header-bar">
                <div className="dos-title-group">
                    <MIcon name="psychology" className="dos-title-icon" />
                    <h4 className="dos-pinned-title">
                        Dissected Observations Synthesis (DOS){heartbeatNo !== undefined ? ` — Heartbeat ${heartbeatNo}` : ''}
                    </h4>
                </div>
            </div>
            <div className="dos-pinned-body">
                <div className="dos-unified-text-scroll">
                    {paragraphs.length === 0 ? (
                        <p className="dos-paragraph-item dos-muted-text">No core synthesis recorded for this heartbeat.</p>
                    ) : (
                        paragraphs.map((p, idx) => (
                            <div key={idx} className="dos-paragraph-item">
                                <span className="dos-paragraph-lead" style={{ color: p.color }}>{p.title}</span>{' '}
                                <span className="dos-paragraph-content">{p.content}</span>
                            </div>
                        ))
                    )}
                </div>
                <div className="dos-utilization-panel">
                    <div className="dos-util-panel-title">
                        <MIcon name="hub" className="dos-panel-icon" />
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

const ExpandableText: React.FC<{
    text: string;
    maxLength: number;
    containerClassName?: string;
    textClassName?: string;
    leftActions?: React.ReactNode;
    rightActions?: React.ReactNode;
}> = ({ text, maxLength, containerClassName, textClassName, leftActions, rightActions }) => {
    const [expanded, setExpanded] = useState(false);
    const isLong = text.length > maxLength;
    const display = expanded || !isLong ? text : `${text.substring(0, maxLength)}...`;

    return (
        <div className={containerClassName}>
            <MathHTML content={display} className={textClassName} />
            {(isLong || leftActions || rightActions) && (
                <div className="expandable-text-actions">
                    <div className="expandable-text-left-actions">{leftActions}</div>
                    <div className="expandable-text-right-actions">
                        {rightActions}
                        {isLong && (
                            <button className="show-more-btn" onClick={() => setExpanded(e => !e)}>
                                {expanded ? 'Show Less' : 'Show More'}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export const BaseModal: React.FC<{
    title: string;
    isEmbedded?: boolean;
    className?: string;
    noPadding?: boolean;
    onClose: () => void;
    children: React.ReactNode;
}> = ({ title, isEmbedded, className, noPadding, onClose, children }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const overlayClass = isEmbedded ? 'embedded-modal-overlay' : 'modal-overlay is-visible';
    const contentClass = isEmbedded ? 'embedded-modal-content' : 'modal-content';

    return (
        <div
            className={`${overlayClass}${className ? ` ${className}` : ''}`}
            style={isEmbedded ? { position: 'fixed', zIndex: 1000, pointerEvents: 'auto' } : { display: 'flex' }}
            onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className={contentClass} role={isEmbedded ? undefined : 'dialog'} aria-modal={isEmbedded ? undefined : true}>
                <div className="modal-header">
                    {title && (isEmbedded ? <h4>{title}</h4> : <h2 className="modal-title">{title}</h2>)}
                    <div className="embedded-modal-header-actions">
                        <button className={isEmbedded ? 'close-modal-btn' : 'modal-close-button'} onClick={onClose}>
                            <MIcon name="close" />
                        </button>
                    </div>
                </div>
                <div className={`modal-body${isEmbedded ? ' custom-scrollbar' : ''}`} style={noPadding ? { padding: 0 } : undefined}>
                    {children}
                </div>
            </div>
        </div>
    );
};

export const EmbeddedModalContent: React.FC<{ content: string; contentClass?: string }> = ({ content, contentClass = 'deepthink-response-content' }) => (
    <div className="deepthink-embedded-response">
        <div><MathHTML content={content} className={contentClass} /></div>
    </div>
);

const BranchVersionSwitcher: React.FC<{
    activeStrategy: any;
    prunedStrategies: any[];
    selectedBranchId: string;
    onSelect: (id: string) => void;
}> = ({ activeStrategy, prunedStrategies, selectedBranchId, onSelect }) => {
    if (prunedStrategies.length === 0) return null;
    return (
        <div className="strategy-branch-version-switcher custom-scrollbar">
            <button
                type="button"
                className={`action-btn strategy-version-button current${selectedBranchId === activeStrategy.id ? ' active' : ''}`}
                onClick={() => onSelect(activeStrategy.id)}
            >
                Current Active
            </button>
            {prunedStrategies.map(pb => (
                <button
                    key={pb.id}
                    type="button"
                    className={`action-btn strategy-version-button pruned${selectedBranchId === pb.id ? ' active' : ''}`}
                    onClick={() => onSelect(pb.id)}
                >
                    {pb.prunedAtIteration
                        ? `Pruned (After ${Math.max(1, pb.prunedAtIteration - (pb.strategyTextHistory?.[0]?.iteration ?? 0))} Iterations)`
                        : 'Pruned'}
                </button>
            ))}
        </div>
    );
};

export const StrategicSolverTab: React.FC<{
    process: DeepthinkPipelineState;
    escapeHtml: (s: string) => string;
    onStrategyTabClick: (idx: number) => void;
    onViewSolution: (strategyId: string) => void;
}> = ({ process, escapeHtml, onStrategyTabClick, onViewSolution }) => {
    const [selectedVersions, setSelectedVersions] = useState<Record<number, string>>({});

    if (process.status === 'error' && process.error) {
        return <div className="status-message error"><pre>{escapeHtml(process.error)}</pre></div>;
    }
    if (!process.initialStrategies?.length) {
        return <div className="loading">Generating strategic approaches...</div>;
    }

    const activeIndex = process.activeStrategyTab || 0;

    return (
        <div className="deepthink-strategic-solver">
            <div className="branch-tabs-container">
                <div className="branch-tabs-content">
                    {process.initialStrategies.map((strategy, index) => {
                        const slotPruned = (((process as any).prunedBranches || []) as any[]).filter(b => b.slotIndex === index);
                        const activeId = strategy.id;
                        const currentSelectedId = selectedVersions[index] || activeId;
                        const displayStrategy = currentSelectedId === activeId ? strategy : (slotPruned.find(p => p.id === currentSelectedId) || strategy);

                        return (
                            <div key={strategy.id} className={`branch-tab-content${index === activeIndex ? ' active' : ''}`}>
                                <div className="strategy-card">
                                    <div className="branch-tabs-nav">
                                        <div className="strategy-tab-number-grid">
                                            {process.initialStrategies.map((s, idx) => (
                                                <button
                                                    key={s.id}
                                                    className={`branch-tab-button${idx === activeIndex ? ' active' : ''}`}
                                                    title={`Strategy ${idx + 1}`}
                                                    onClick={() => onStrategyTabClick(idx)}
                                                >
                                                    {idx + 1}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <StrategyContent
                                        strategy={displayStrategy}
                                        process={process}
                                        escapeHtml={escapeHtml}
                                        onViewSolution={onViewSolution}
                                        belowTextActions={
                                            <BranchVersionSwitcher
                                                activeStrategy={strategy}
                                                prunedStrategies={slotPruned}
                                                selectedBranchId={currentSelectedId}
                                                onSelect={id => setSelectedVersions(prev => ({ ...prev, [index]: id }))}
                                            />
                                        }
                                        isPruned={currentSelectedId !== activeId}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

const StrategyContent: React.FC<{
    strategy: DeepthinkMainStrategyData;
    process: DeepthinkPipelineState;
    escapeHtml: (s: string) => string;
    onViewSolution: (id: string) => void;
    belowTextActions?: React.ReactNode;
    isPruned?: boolean;
}> = ({ strategy, process, escapeHtml, onViewSolution, belowTextActions, isPruned }) => {
    const branchRecords = (process.bsrRecords || []).filter(r => r.branch_id === strategy.id);
    const history = strategy.strategyTextHistory || [{ iteration: 0, text: strategy.strategyText }];
    const [historyIndex, setHistoryIndex] = useState(history.length - 1);

    useEffect(() => {
        setHistoryIndex(history.length - 1);
    }, [history.length]);

    const activeIndex = Math.min(Math.max(0, historyIndex), history.length - 1);
    const activeVersion = history[activeIndex];
    const activeVersionBsr = branchRecords.find(r => r.iteration === activeVersion.iteration);
    const isEvolvedVersion = activeVersionBsr?.computed?.decision === 'EVOLVE';
    const hasEvolvedHistory = history.some(v => branchRecords.some(r => r.iteration === v.iteration && r.computed?.decision === 'EVOLVE'));

    const historyControls = (history.length > 1 || isEvolvedVersion) && (
        <div className={`strategy-history-controls${hasEvolvedHistory ? ' is-evolved' : ''}`}>
            <button type="button" className="strategy-history-button" onClick={() => setHistoryIndex(prev => Math.max(0, prev - 1))} disabled={activeIndex === 0} aria-label="View previous strategy version">
                <MIcon name="chevron_left" />
            </button>
            {isEvolvedVersion ? (
                <span className="strategy-history-label strategy-history-label-evolved">
                    <span>EVOLVE · {activeVersionBsr.computed.form === 'rollback' ? 'Rollback' : 'In Place'}</span>
                    <span className="strategy-history-iteration">Iter {activeVersion.iteration}</span>
                </span>
            ) : (
                <span className="strategy-history-label">
                    {activeVersion.iteration === history[0].iteration ? `Original Baseline (Global Iter ${history[0].iteration})` : `Evolved (Global Iter ${activeVersion.iteration})`}
                </span>
            )}
            <button type="button" className="strategy-history-button" onClick={() => setHistoryIndex(prev => Math.min(history.length - 1, prev + 1))} disabled={activeIndex === history.length - 1} aria-label="View next strategy version">
                <MIcon name="chevron_right" />
            </button>
        </div>
    );

    return (
        <div className="strategy-content" style={{ opacity: isPruned ? 0.8 : 1 }}>
            <ExpandableText
                text={activeVersion.text}
                maxLength={200}
                containerClassName="strategy-text-container"
                textClassName="strategy-text"
                leftActions={(belowTextActions || historyControls) && (
                    <div className="strategy-text-context-controls">
                        {belowTextActions}
                        {historyControls}
                    </div>
                )}
                rightActions={strategy.id && (
                    <button type="button" className="view-solution-button" onClick={() => onViewSolution(strategy.id)}>
                        <MIcon name="visibility" /> View Solution
                    </button>
                )}
            />
            {strategy.error && <div className="error-message">{escapeHtml(strategy.error)}</div>}
            {branchRecords.length > 0 && <BranchVisualBsr branchId={strategy.id} records={branchRecords} process={process} />}
        </div>
    );
};

const SIZE_WEIGHTS: Record<string, number> = { small: 1, medium: 2, large: 4 };

const BranchVisualBsr: React.FC<{ branchId: string; records: BsrGlobalUpdateRecord[]; process: DeepthinkPipelineState }> = ({ branchId, records, process }) => {
    const [selectedIdx, setSelectedIdx] = useState(records.length - 1);
    const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
    const activeIdx = Math.min(Math.max(0, selectedIdx), records.length - 1);
    const activeRecord = records[activeIdx];
    if (!activeRecord) return null;

    const activeWeights: Record<string, number> = {
        small: process.runConfig?.bsrWeightSmall ?? SIZE_WEIGHTS.small,
        medium: process.runConfig?.bsrWeightMedium ?? SIZE_WEIGHTS.medium,
        large: process.runConfig?.bsrWeightLarge ?? SIZE_WEIGHTS.large,
    };

    const { computed, report } = activeRecord;
    const formLabel = computed.form === 'rollback'
        ? `Rollback to ${computed.rollback_to === 'window_start' ? 'Window Start' : `Iter ${computed.rollback_to}`}`
        : computed.form === 'in_place' ? 'In Place' : null;

    const pCont = computed.pressure.CONTINUE || 0;
    const pEvol = computed.pressure.EVOLVE || 0;
    const pPrun = computed.pressure.PRUNE || 0;

    let chainStartIdx = 0;
    for (let i = activeIdx - 1; i >= 0; i--) {
        if (records[i].computed?.decision === 'PRUNE') {
            chainStartIdx = i + 1;
            break;
        }
    }
    const chainedRecords = records.slice(chainStartIdx, activeIdx + 1);
    const j = process.runConfig?.j ?? 5;
    const seenIters = new Set<number>();
    const iterOrder: number[] = [];
    const iterProgMap = new Map<number, typeof report.confirmed_progress>();
    const iterRegrMap = new Map<number, typeof report.confirmed_regression>();

    chainedRecords.forEach(rec => {
        const recEnd = rec.iteration;
        const recStart = Math.max(1, recEnd - j + 1);
        const pEvts = rec.report?.confirmed_progress || [];
        const rEvts = rec.report?.confirmed_regression || [];

        for (let it = recStart; it <= recEnd; it++) {
            if (!seenIters.has(it)) {
                seenIters.add(it);
                iterOrder.push(it);
                iterProgMap.set(it, []);
                iterRegrMap.set(it, []);
            }
            const currentProg = iterProgMap.get(it)!;
            const currentRegr = iterRegrMap.get(it)!;
            pEvts.filter(e => e.iteration === it).forEach(e => {
                if (!currentProg.some(ex => ex.iteration === e.iteration && ex.reason === e.reason)) currentProg.push(e);
            });
            rEvts.filter(e => e.iteration === it).forEach(e => {
                if (!currentRegr.some(ex => ex.iteration === e.iteration && ex.reason === e.reason)) currentRegr.push(e);
            });
        }
    });

    iterOrder.sort((a, b) => a - b);

    const points: Array<{ label: string; iterVal: number | 'start'; change: number; total: number; progEvents: typeof report.confirmed_progress; regrEvents: typeof report.confirmed_regression }> = [
        { label: 'start', iterVal: 'start', change: 0, total: 0, progEvents: [], regrEvents: [] },
    ];
    let runningTotal = 0;
    iterOrder.forEach(it => {
        const pEvts = iterProgMap.get(it) || [];
        const rEvts = iterRegrMap.get(it) || [];
        const change = pEvts.reduce((s, e) => s + (activeWeights[e.size] || 1), 0) - rEvts.reduce((s, e) => s + (activeWeights[e.size] || 1), 0);
        runningTotal += change;
        points.push({ label: String(it), iterVal: it, change, total: runningTotal, progEvents: pEvts, regrEvents: rEvts });
    });

    const allTotals = points.map(p => p.total);
    const bestTotal = Math.max(0, ...allTotals);
    const finalTotal = points[points.length - 1].total;

    let lastGoodIdx = 0;
    const specLastGood = activeRecord.computed.last_good_iteration;
    if (typeof specLastGood === 'number') {
        const found = points.findIndex(p => p.iterVal === specLastGood);
        lastGoodIdx = found !== -1 ? found : points.reduce((best, p, idx) => p.total > points[best].total ? idx : best, 0);
    } else {
        lastGoodIdx = points.reduce((best, p, idx) => p.total > points[best].total ? idx : best, 0);
    }

    const graphCardRef = useRef<HTMLDivElement>(null);
    const [cardWidth, setCardWidth] = useState(900);

    useEffect(() => {
        if (!graphCardRef.current) return;
        const update = () => {
            const w = graphCardRef.current?.clientWidth || 0;
            if (w > 0) setCardWidth(w);
        };
        update();
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width || 0;
            if (w > 0) setCardWidth(w);
        });
        ro.observe(graphCardRef.current);
        return () => ro.disconnect();
    }, []);

    const padLeft = 60, padRight = 75, padTop = 24, padBottom = 26;
    const numSteps = Math.max(1, points.length - 1);
    const svgWidth = Math.max(Math.max(500, cardWidth - 28), padLeft + padRight + numSteps * 65);
    const svgHeight = 240;
    const minVal = Math.min(-4, Math.floor(Math.min(...allTotals, finalTotal) / 2) * 2);
    const maxVal = Math.max(6, Math.ceil(Math.max(...allTotals, bestTotal) / 2) * 2);
    const valRange = Math.max(1, maxVal - minVal);
    const getY = (val: number) => padTop + (1 - (val - minVal) / valRange) * (svgHeight - padTop - padBottom);
    const step = (svgWidth - padLeft - padRight) / numSteps;
    const getX = (idx: number) => padLeft + idx * step;
    const useMultiLineChangeLabels = Math.max(44, step - 6) < 80;
    const maxEventsAtIteration = points.slice(1).reduce((m, p) => Math.max(m, p.progEvents.length + p.regrEvents.length), 0);
    const changeOverlayHeight = Math.max(38, maxEventsAtIteration * (useMultiLineChangeLabels ? 32 : 22) + Math.max(0, maxEventsAtIteration - 1) * 2);

    const yTicks: number[] = [];
    for (let t = minVal; t <= maxVal; t += 2) yTicks.push(t);

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(p.total)}`).join(' ');
    const lastIdx = points.length - 1;
    const bestTotalY = getY(bestTotal);
    const finalTotalY = getY(finalTotal);
    const arrowX = svgWidth - padRight + 18;
    const hoveredIndex = hoveredPointIndex === null ? null : Math.min(lastIdx, Math.max(0, hoveredPointIndex));
    const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex];
    const hoveredX = hoveredIndex === null ? 0 : getX(hoveredIndex);
    const hoveredY = hoveredPoint ? getY(hoveredPoint.total) : 0;
    const tooltipWidth = 224, tooltipHeight = 82;
    const tooltipX = hoveredPoint ? Math.min(Math.max(padLeft, hoveredX + tooltipWidth + 14 <= svgWidth - padRight ? hoveredX + 14 : hoveredX - tooltipWidth - 14), svgWidth - padRight - tooltipWidth) : 0;
    const preferredTooltipY = hoveredY - tooltipHeight - 12;
    const tooltipY = hoveredPoint ? Math.min(Math.max(padTop, preferredTooltipY < padTop ? hoveredY + 12 : preferredTooltipY), svgHeight - padBottom - tooltipHeight) : 0;

    const allChainedEvents = [
        ...chainedRecords.flatMap(r => (r.report?.confirmed_progress || []).map(e => ({ ...e, type: 'progress' as const }))),
        ...chainedRecords.flatMap(r => (r.report?.confirmed_regression || []).map(e => ({ ...e, type: 'regression' as const }))),
    ].sort((a, b) => a.iteration - b.iteration);

    const pSum = (pCont + pEvol + pPrun) || 1;

    return (
        <div className="bsr-visual-container">
            <div className="bsr-side-by-side">
                <div className="bsr-side-panel bsr-action-pressure-panel" style={{ border: '1px solid rgba(255,255,255,0.1)', padding: '16px' }}>
                    <div className="bsr-panel-header" style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="bsr-panel-title">Previous Window (θ = 0.30)</span>
                        <div className="bsr-visual-legend" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                            <span className="bsr-decision-label" style={{ fontSize: '0.8rem', color: 'var(--text-secondary-color)', fontWeight: 500 }}>Outcome:</span>
                            <span className={`bsr-decision-chip action-${computed.decision.toLowerCase()}`} style={{ margin: 0, padding: '3px 10px', fontSize: '0.75rem', height: 'auto', borderRadius: '6px' }}>
                                {computed.decision} {formLabel ? `· ${formLabel}` : ''}
                            </span>
                        </div>
                    </div>
                    <div className="bsr-visual-bar-track" style={{ height: '28px', display: 'flex', borderRadius: '6px', overflow: 'hidden', position: 'relative' }}>
                        {[
                            { cls: 'continue', label: 'CONTINUE', p: pCont },
                            { cls: 'evolve', label: 'EVOLVE', p: pEvol },
                            { cls: 'prune', label: 'PRUNE', p: pPrun },
                        ].map(item => (
                            <div key={item.cls} className={`bar-fill ${item.cls}`} style={{ flex: item.p / pSum, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'min-content', padding: '0 12px' }} title={`${item.label}: ${(item.p * 100).toFixed(1)}%`}>
                                <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 4px rgba(0,0,0,0.9)', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{item.label} {(item.p * 100).toFixed(0)}%</span>
                            </div>
                        ))}
                    </div>
                    <div className="bsr-visual-telemetry-strip" style={{ marginTop: '20px' }}>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Net:</span>
                            <span className={`telemetry-val ${computed.net >= 0 ? 'pos' : 'neg'}`}>{computed.net >= 0 ? `+${computed.net}` : computed.net}</span>
                        </span>
                        <span className="telemetry-pill"><span className="telemetry-lbl">Lost Ground:</span><span className="telemetry-val">{computed.lost_ground.toFixed(3)}</span></span>
                        <span className="telemetry-pill"><span className="telemetry-lbl">Progress Kept:</span><span className="telemetry-val">{computed.progress_kept.toFixed(3)}</span></span>
                        <span className="telemetry-pill"><span className="telemetry-lbl">Drift:</span><span className="telemetry-val">{computed.drift.toFixed(3)}</span></span>
                        <span className="telemetry-pill"><span className="telemetry-lbl">Stall Evidence:</span><span className="telemetry-val">{computed.stall_evidence.toFixed(3)}</span></span>
                        <span className="telemetry-pill"><span className="telemetry-lbl">Critique Alignment:</span><span className="telemetry-val">{(report.critique_alignment.value * 100).toFixed(0)}%</span></span>
                    </div>
                </div>

                <div className="bsr-side-panel bsr-alignment-panel" style={{ border: '1px solid rgba(255,255,255,0.1)', padding: '16px' }}>
                    <div className="bsr-panel-header">
                        <span className="bsr-panel-title">Window Outcome: {computed.window_outcome}</span>
                        {records.length > 1 && (
                            <div className="bsr-update-tabs">
                                {records.map((r, idx) => (
                                    <button key={idx} type="button" className={`bsr-update-pill${idx === activeIdx ? ' active' : ''}`} onClick={() => setSelectedIdx(idx)}>
                                        Update #{r.updateNumber}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    {report.critique_alignment?.reason && (
                        <div className="bsr-alignment-note" style={{ textAlign: 'left', marginTop: '12px' }}>
                            <strong>Critique Alignment ({report.critique_alignment.value.toFixed(2)}):</strong> {report.critique_alignment.reason}
                        </div>
                    )}
                </div>
            </div>

            <div className="bsr-window-graph-card">
                <div className="bsr-graph-top-bar">
                    <span className="bsr-graph-heading">
                        {chainedRecords.length > 1 ? `Running total across surviving windows (${formatStrategyId(branchId)})` : `Running total in the window (${formatStrategyId(branchId)})`}
                    </span>
                    {chainedRecords.length > 1 && (
                        <span className="bsr-chain-badge">Updates #{chainedRecords[0].updateNumber}–#{activeRecord.updateNumber}</span>
                    )}
                </div>

                <div className="bsr-graph-content-layout">
                    <div className="bsr-graph-main-col" ref={graphCardRef}>
                        <div className="bsr-graph-scroll-container">
                            <div className="bsr-graph-scroll-content" style={{ width: `${svgWidth}px` }}>
                                <div className="bsr-svg-graph-container">
                                    <svg
                                        className="bsr-window-svg"
                                        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                                        width="100%"
                                        height={svgHeight}
                                        role="img"
                                        aria-label={`Running total graph for ${formatStrategyId(branchId)}`}
                                        onPointerMove={e => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            if (rect.width <= 0) return;
                                            const pointerX = ((e.clientX - rect.left) / rect.width) * svgWidth;
                                            setHoveredPointIndex(Math.min(lastIdx, Math.max(0, Math.round((pointerX - padLeft) / step))));
                                        }}
                                        onPointerLeave={() => setHoveredPointIndex(null)}
                                    >
                                        {yTicks.map(t => {
                                            const yPos = getY(t);
                                            const isZero = t === 0;
                                            return (
                                                <g key={t}>
                                                    <line className={`bsr-grid-line${isZero ? ' zero' : ''}`} x1={padLeft - 5} y1={yPos} x2={svgWidth - padRight + 28} y2={yPos} stroke={isZero ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.07)'} strokeWidth={isZero ? 1.2 : 0.8} />
                                                    <text x={padLeft - 10} y={yPos + 3.5} textAnchor="end" fill={isZero ? 'var(--text-color)' : 'var(--text-secondary-color)'} fontSize="10" fontWeight={isZero ? '600' : '400'}>{t}</text>
                                                </g>
                                            );
                                        })}
                                        {bestTotal > 0 && <line x1={getX(lastGoodIdx)} y1={bestTotalY} x2={arrowX + 10} y2={bestTotalY} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth="1.2" />}
                                        <line className="bsr-final-total-line" x1={getX(lastIdx)} y1={finalTotalY} x2={arrowX + 10} y2={finalTotalY} stroke="rgba(255, 255, 255, 0.45)" strokeDasharray="3 3" strokeWidth="1.2" />
                                        <text x={getX(lastIdx) - 8} y={finalTotalY + (finalTotal >= 0 ? 14 : -6)} textAnchor="end" fill="var(--text-secondary-color)" fontSize="10" fontFamily="monospace">net = {finalTotal}</text>
                                        {Math.abs(bestTotalY - finalTotalY) > 6 && (
                                            <g className="bsr-lost-ground-dimension">
                                                <line x1={arrowX} y1={bestTotalY} x2={arrowX} y2={finalTotalY} stroke="var(--text-secondary-color)" strokeWidth="1.2" />
                                                <text x={arrowX + 8} y={(bestTotalY + finalTotalY) / 2 + 4} fill="var(--text-color)" fontSize="11" fontWeight="700">{bestTotal - finalTotal}</text>
                                            </g>
                                        )}
                                        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2.2" />
                                        {points.map((pt, i) => {
                                            const cx = getX(i), cy = getY(pt.total);
                                            const isStart = pt.iterVal === 'start';
                                            return (
                                                <g key={i}>
                                                    <line className="bsr-x-axis-tick" x1={cx} y1={getY(minVal)} x2={cx} y2={getY(minVal) + 5} stroke="rgba(255, 255, 255, 0.25)" strokeWidth="1" />
                                                    <text x={cx} y={getY(minVal) + 16} textAnchor="middle" fill="var(--text-secondary-color)" fontSize="10.5">{pt.label}</text>
                                                    {i === lastGoodIdx && bestTotal > 0 && <circle cx={cx} cy={cy} r="8" fill="none" stroke="#f59e0b" strokeWidth="1.5" />}
                                                    {isStart
                                                        ? <circle className="bsr-start-point" cx={cx} cy={cy} r="4" fill="rgba(15, 23, 42, 0.9)" stroke="#6366f1" strokeWidth="2" />
                                                        : <circle cx={cx} cy={cy} r="4" fill="#6366f1" stroke="#818cf8" strokeWidth="1" />}
                                                </g>
                                            );
                                        })}
                                        {hoveredPoint && hoveredIndex !== null && (
                                            <g className="bsr-hover-layer" pointerEvents="none">
                                                <line className="bsr-hover-line" x1={hoveredX} y1={padTop} x2={hoveredX} y2={svgHeight - padBottom} />
                                                <circle cx={hoveredX} cy={hoveredY} r="6.5" fill={hoveredPoint.iterVal === 'start' ? '#312e81' : '#6366f1'} stroke="#c7d2fe" strokeWidth="2" />
                                                <rect className="bsr-hover-tooltip" x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="7" />
                                                <text className="bsr-hover-tooltip-title" x={tooltipX + 10} y={tooltipY + 18}>{hoveredPoint.iterVal === 'start' ? 'Window start' : `Iteration ${hoveredPoint.label}`}</text>
                                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 37}>Running total: {hoveredPoint.total}</text>
                                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 54}>Change: {hoveredPoint.change > 0 ? '+' : ''}{hoveredPoint.change}</text>
                                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 71}>Confirmed: {hoveredPoint.progEvents.length} progress · {hoveredPoint.regrEvents.length} regression</text>
                                            </g>
                                        )}
                                    </svg>
                                </div>

                                <div className="bsr-change-overlay-row" style={{ width: '100%', position: 'relative', height: `${changeOverlayHeight}px` }}>
                                    <span className="bsr-change-tag-lead" style={{ position: 'absolute', left: 0, width: `${padLeft}px`, top: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', textAlign: 'right', paddingRight: '10px', boxSizing: 'border-box' }}>
                                        change
                                    </span>
                                    {points.slice(1).map((pt, i) => {
                                        const colCenterX = getX(i + 1);
                                        const colWidth = Math.max(44, step - 6);
                                        const hasEvents = pt.progEvents.length > 0 || pt.regrEvents.length > 0;
                                        return (
                                            <div key={i} className="bsr-change-col" style={{ position: 'absolute', left: `${colCenterX - colWidth / 2}px`, top: 0, width: `${colWidth}px`, height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                                {!hasEvents ? (
                                                    <span className="change-chip no-events">no events</span>
                                                ) : (
                                                    <div className="change-chips-cluster">
                                                        {pt.progEvents.map((pe, peIdx) => {
                                                            const weight = activeWeights[pe.size] || 1;
                                                            return (
                                                                <span key={`p-${peIdx}`} className={`change-chip progress${useMultiLineChangeLabels ? ' multiline' : ''}`} title={pe.reason}>
                                                                    {useMultiLineChangeLabels ? <><span className="chip-sign">+{weight}</span><span className="chip-size">{pe.size}</span></> : `+${weight} ${pe.size}`}
                                                                </span>
                                                            );
                                                        })}
                                                        {pt.regrEvents.map((re, reIdx) => {
                                                            const weight = activeWeights[re.size] || 1;
                                                            return (
                                                                <span key={`r-${reIdx}`} className={`change-chip regression${useMultiLineChangeLabels ? ' multiline' : ''}`} title={re.reason}>
                                                                    {useMultiLineChangeLabels ? <><span className="chip-sign">-{weight}</span><span className="chip-size">{re.size}</span></> : `-${weight} ${re.size}`}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>

                    {allChainedEvents.length > 0 && (
                        <div className="bsr-event-evidence-right-pane" style={{ height: `calc(${svgHeight + changeOverlayHeight}px + 0.95rem + 2px)` }}>
                            <div className="bsr-event-evidence-expand">
                                {allChainedEvents.map((evt, idx) => (
                                    <div key={idx} className={`bsr-graph-evidence-row ${evt.type}`}>
                                        <span className="evidence-iter-pill">Iter {evt.iteration}</span>
                                        <span className={`evidence-dir-tag ${evt.type}`}>{evt.type === 'progress' ? '+PROG' : '-REGR'}</span>
                                        <span className="evidence-size-pill">{evt.size}</span>
                                        <span className="evidence-content">
                                            {evt.reason ? evt.reason.replace(/^\[?\s*Evidence:\s*/i, '').replace(/\s*\]$/, '').trim() : 'Confirmed event'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const formatStrategyId = (id: string): string => id.startsWith('main') ? `Strategy ${id.slice(4)}` : id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const formatCompactStrategyId = (id: string): string => {
    const number = id.match(/(\d+)$/)?.[1];
    return number ? `S${number}` : formatStrategyId(id);
};

function buildModuleRoundViews(process: DeepthinkPipelineState) {
    const roundNumberSet = new Set<number>();
    (process.heartbeats || []).forEach(h => { if (h.heartbeat_no) roundNumberSet.add(h.heartbeat_no); });
    (process.moduleRounds || []).forEach(r => { if (r.roundNumber) roundNumberSet.add(r.roundNumber); });
    (process.modules || []).forEach(m => { if (m.roundNumber) roundNumberSet.add(m.roundNumber); });
    if (process.heartbeatNo && process.heartbeatNo > 0) {
        for (let i = 1; i <= process.heartbeatNo; i++) roundNumberSet.add(i);
    }
    (process.dosOutputs || []).forEach(d => {
        if (d.callType === 'heartbeat') {
            const matchingHb = (process.heartbeats || []).find(h => h.iteration === d.iteration);
            if (matchingHb?.heartbeat_no) roundNumberSet.add(matchingHb.heartbeat_no);
        }
    });

    if (roundNumberSet.size === 0) {
        const roundNumber = process.modules[0]?.roundNumber || 1;
        return [{ key: `round-${roundNumber}`, label: `Heartbeat ${roundNumber}`, roundNumber, modules: process.modules || [], packet: process.knowledgePacket || '' }];
    }

    const sortedRounds = Array.from(roundNumberSet).sort((a, b) => a - b);
    const history = process.modulesHistory || [];

    return sortedRounds.map(roundNumber => {
        const hbBlock = (process.heartbeats || []).find(h => h.heartbeat_no === roundNumber);
        const roundSnap = (process.moduleRounds || []).find(r => r.roundNumber === roundNumber);
        let modules: DeepthinkModuleData[] = [];
        if (hbBlock?.modules?.length) modules = hbBlock.modules;
        else if (roundSnap?.modules?.length) modules = roundSnap.modules;
        else if (history[roundNumber - 1]?.length) modules = history[roundNumber - 1];
        else {
            const filteredLive = (process.modules || []).filter(m => m.roundNumber === roundNumber);
            if (filteredLive.length > 0) modules = filteredLive;
            else if (roundNumber === (process.heartbeatNo || sortedRounds[sortedRounds.length - 1])) modules = process.modules || [];
        }
        return { key: `round-${roundNumber}`, label: `Heartbeat ${roundNumber}`, roundNumber, modules, packet: roundSnap?.packet || process.knowledgePacket || '' };
    });
}

export const ModulesExplorerTab: React.FC<{ process: DeepthinkPipelineState; onViewArgument: (moduleId: string) => void }> = ({ process, onViewArgument }) => {
    const roundViews = buildModuleRoundViews(process);
    const [activeRoundIndex, setActiveRoundIndex] = useState(Math.max(0, roundViews.length - 1));
    useEffect(() => {
        setActiveRoundIndex(Math.max(0, roundViews.length - 1));
    }, [roundViews.length]);
    const activeRound = roundViews[Math.min(activeRoundIndex, roundViews.length - 1)] || roundViews[0];
    const activeModules = activeRound?.modules || [];
    const modulesEnabled = process.runConfig?.modulesCount !== 0;
    const currentHeartbeatNo = activeRound?.roundNumber ?? (activeRoundIndex + 1);

    return (
        <div className="deepthink-modules-explorer">
            <div className="modules-round-layout">
                <div className="modules-round-pills" aria-label="Modules heartbeat rounds">
                    {roundViews.map((round, index) => (
                        <button key={round.key} type="button" className={`modules-round-pill${index === activeRoundIndex ? ' active' : ''}`} onClick={() => setActiveRoundIndex(index)}>
                            {round.label}
                        </button>
                    ))}
                </div>
                <div className="modules-round-content">
                    {modulesEnabled && <DosSynthesisCard process={process} heartbeatNo={currentHeartbeatNo} />}
                    <div className="curated-context-columns has-modules">
                        {modulesEnabled && (
                            <section className="curated-context-modules">
                                <div className="curated-modules-header"><h3>Modules</h3></div>
                                {activeModules.length === 0 ? (
                                    <div className="status-message">
                                        {process.modulesGenStatus === 'processing' ? `Generating modules for Heartbeat ${currentHeartbeatNo}…` : `No modules recorded for Heartbeat ${currentHeartbeatNo}.`}
                                    </div>
                                ) : (
                                    <div className="agent-grid modules-agent-grid">
                                        {activeModules.map((m, i) => {
                                            const testerDisplay = m.testerAttemptDisplay || m.testerAttempt || '';
                                            return (
                                                <div key={m.id} className="agent-card">
                                                    <div className="agent-header modules-card-header">
                                                        <h4 className="agent-title">Module {i + 1}</h4>
                                                        <div className="modules-target-circles" role="group" aria-label={`Targets ${m.targetBranchIds?.length ? m.targetBranchIds.map(formatCompactStrategyId).join(', ') : 'all branches'}`}>
                                                            {m.targetBranchIds?.length
                                                                ? m.targetBranchIds.map(id => <span key={id} className="modules-target-circle">{formatCompactStrategyId(id)}</span>)
                                                                : <span className="modules-target-circle">ALL</span>}
                                                        </div>
                                                    </div>
                                                    <div className="agent-results">
                                                        <div className="modules-text-container">
                                                            <MathHTML content={m.moduleText || 'No module text'} className="modules-text" />
                                                        </div>
                                                        {testerDisplay && (
                                                            <button type="button" className="view-argument-button" onClick={() => onViewArgument(m.id)}>
                                                                <MIcon name="article" /> View The Argument
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const moduleState = {
    tabsNavContainer: null as HTMLElement | null,
    pipelinesContentContainer: null as HTMLElement | null,
    escapeHtml: (s: string) => s,
};

let activeSolutionModalStrategyId: string | null = null;
let pipelineContentRoot: Root | null = null;
let pipelineContentContainerNode: HTMLElement | null = null;
let modalRoot: Root | null = null;
let modalContainer: HTMLElement | null = null;
let filesystemRedirectListenerRegistered = false;

interface DeepthinkModuleDependencies extends DeepthinkCoreDeps {
    escapeHtml: (unsafe: string) => string;
    tabsNavContainer: HTMLElement | null;
    pipelinesContentContainer: HTMLElement | null;
    setActiveDeepthinkPipeline: (pipeline: DeepthinkPipelineState | null) => void;
}

export function initializeDeepthinkModule(dependencies: DeepthinkModuleDependencies) {
    Object.assign(moduleState, {
        tabsNavContainer: dependencies.tabsNavContainer,
        pipelinesContentContainer: dependencies.pipelinesContentContainer,
        escapeHtml: dependencies.escapeHtml,
    });

    onHighlighterReady(() => {
        if (getActiveDeepthinkPipeline()) renderActiveDeepthinkPipeline();
    });

    if (!filesystemRedirectListenerRegistered) {
        filesystemRedirectListenerRegistered = true;
        window.addEventListener('openDeepthinkFilesystem', () => {
            const process = getActiveDeepthinkPipeline();
            if (!process) return;
            if (document.getElementById('solution-modal-overlay')) removeDeepthinkSolutionOverlay(true);
            process.activeTabId = 'filesystem';
            renderActiveDeepthinkPipeline();
        });
    }

    initializeDeepthinkCore({ ...dependencies, renderActiveDeepthinkPipeline });
    window.addEventListener('deepthinkPipelineUpdated', () => {
        if (getActiveDeepthinkPipeline()) renderActiveDeepthinkPipeline();
    });
}

function mountModal(element: React.ReactElement): void {
    if (!modalContainer) {
        modalContainer = document.createElement('div');
        modalContainer.id = 'deepthink-modal-portal';
        document.body.appendChild(modalContainer);
    }
    if (!modalRoot) modalRoot = createRoot(modalContainer);
    modalRoot.render(element);
}

function unmountModal(): void {
    modalRoot?.render(null);
    activeSolutionModalStrategyId = null;
}

function removeDeepthinkSolutionOverlay(immediate = true): void {
    const overlay = document.getElementById('solution-modal-overlay') as (HTMLElement & { cleanup?: () => void }) | null;
    if (!overlay) return;
    overlay.cleanup?.();
    if (immediate) overlay.remove();
    else {
        overlay.classList.remove('is-visible');
        setTimeout(() => { if (overlay.isConnected) overlay.remove(); }, 200);
    }
    activeSolutionModalStrategyId = null;
}

function findSolutionModalStrategy(pipeline: DeepthinkPipelineState, strategyId: string): DeepthinkMainStrategyData | undefined {
    return pipeline.initialStrategies?.find(c => c.id === strategyId)
        ?? pipeline.prunedBranches?.find((c: DeepthinkMainStrategyData) => c.id === strategyId);
}

async function openDeepthinkSolutionModal(strategyId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    const strategy = pipeline && findSolutionModalStrategy(pipeline, strategyId);
    if (!strategy) return;

    removeDeepthinkSolutionOverlay(true);
    unmountModal();
    activeSolutionModalStrategyId = strategyId;

    const overlay = document.createElement('div') as HTMLElement & { cleanup?: () => void };
    overlay.className = 'modal-overlay';
    overlay.id = 'solution-modal-overlay';
    overlay.style.display = 'flex';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = strategy.id.startsWith('main') ? `Strategy ${strategy.id.slice(4)}` : `Branch ${strategy.id}`;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-button';
    closeBtn.innerHTML = renderIconMarkup('close');
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body branch-history-modal-container';
    body.style.padding = '0';
    body.style.height = 'calc(100vh - 80px)';
    body.style.overflow = 'hidden';

    content.appendChild(header);
    content.appendChild(body);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const close = () => removeDeepthinkSolutionOverlay(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    overlay.cleanup = () => document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.classList.add('is-visible'), 10);

    await updateSolutionModalContent(body, strategyId);
}

function openModuleArgumentModal(moduleId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    const allModules = [...((pipeline?.modulesHistory || []).flat()), ...(pipeline?.modules || [])];
    const mod = allModules.find(m => m.id === moduleId);
    if (!mod || document.querySelector('.embedded-modal-overlay')) return;

    mountModal(
        <BaseModal title="Module Argument" isEmbedded onClose={unmountModal}>
            <EmbeddedModalContent content={mod.testerAttemptDisplay || mod.testerAttempt || 'No argument available'} contentClass="module-argument-content" />
        </BaseModal>
    );
}

async function updateSolutionModalContent(modalBody: HTMLElement, strategyId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    const strategy = pipeline && findSolutionModalStrategy(pipeline, strategyId);
    if (!strategy) return;

    const laterIterations = (strategy.iterationHistory?.iterations || []).map((it: any, index: number) => ({
        ...it,
        iterationNumber: it.iterationNumber === 1 ? index + 2 : (it.iterationNumber || index + 2),
        critique: it.critiqueDisplay || it.critique,
        correctedSolution: it.correctedSolutionDisplay || it.correctedSolution,
    }));

    const iter1 = {
        iterationNumber: laterIterations.length > 0 ? Math.max(1, laterIterations[0].iterationNumber - 1) : 1,
        correctedSolution: strategy.solutionAttemptDisplay || strategy.solutionAttempt || '',
        correctedSolutionExecutionTraceText: strategy.solutionAttemptExecutionTraceText,
        critique: strategy.solutionCritiqueDisplay || strategy.solutionCritique || '',
        critiqueExecutionTraceText: strategy.solutionCritiqueExecutionTraceText,
        timestamp: Date.now() - 10000,
    };

    const allIterations = [iter1, ...laterIterations].filter(it => it.correctedSolution || it.critique);
    const originalSolution = allIterations[0]?.correctedSolution || 'Processing...';
    const currentBestSolution = (allIterations.length > 0 ? allIterations[allIterations.length - 1]?.correctedSolution : null) || originalSolution;
    const isProcessing = ['processing', 'pending'].includes(strategy.status)
        || ['processing', 'pending'].includes(strategy.solutionCritiqueStatus || '')
        || ['processing', 'pending'].includes(strategy.correctionStatus || '')
        || strategy.iterationHistory?.status === 'processing';

    const { renderBranchHistoryUI } = await import('./DeepthinkBranchHistoryModal');
    await renderBranchHistoryUI(modalBody, originalSolution, currentBestSolution, allIterations, isProcessing);
}

export function activateDeepthinkStrategyTab(strategyIndex: number) {
    const pipeline = getActiveDeepthinkPipeline();
    if (!pipeline) return;
    pipeline.activeStrategyTab = strategyIndex;
    renderActiveDeepthinkPipeline();
}

export function renderActiveDeepthinkPipeline() {
    const deepthinkProcess = getActiveDeepthinkPipeline();
    moduleState.tabsNavContainer = document.getElementById('tabs-nav-container');
    moduleState.pipelinesContentContainer = document.getElementById('pipelines-content-container');
    const { tabsNavContainer, pipelinesContentContainer } = moduleState;
    if (!deepthinkProcess || !tabsNavContainer || !pipelinesContentContainer) return;

    const sidebarBtn = document.getElementById('sidebar-collapse-button') as HTMLButtonElement | null;
    if (sidebarBtn) {
        sidebarBtn.disabled = false;
        sidebarBtn.style.opacity = '';
        sidebarBtn.style.cursor = '';
    }

    const header = document.querySelector('.main-header-content') as HTMLElement | null;
    if (header) header.style.display = '';
    tabsNavContainer.style.display = '';

    if (activeSolutionModalStrategyId && document.getElementById('solution-modal-overlay')) {
        const modalBody = document.querySelector('#solution-modal-overlay .modal-body') as HTMLElement | null;
        if (modalBody) void updateSolutionModalContent(modalBody, activeSolutionModalStrategyId).catch(() => {});
    }

    tabsNavContainer.innerHTML = '';
    const tabs = getVisibleDeepthinkTabs(deepthinkProcess);

    if (!tabs.some(t => t.id === deepthinkProcess.activeTabId) && tabs.length > 0) {
        const wasRemovedCritiqueTab = deepthinkProcess.activeTabId === 'critique-history';
        const contextTab = tabs.find(tab => tab.id === 'modules-explorer');
        deepthinkProcess.activeTabId = wasRemovedCritiqueTab && contextTab ? contextTab.id : tabs[0].id;
    }

    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.id = `deepthink-tab-${tab.id}`;
        btn.className = `tab-button deepthink-mode-tab ${deepthinkProcess.activeTabId === tab.id ? 'active' : ''} ${tab.statusClass}`;
        btn.innerHTML = `${renderIconMarkup(tab.icon)}${tab.label}`;
        btn.addEventListener('click', () => {
            deepthinkProcess.activeTabId = tab.id;
            if (tab.id === 'live') window.dispatchEvent(new CustomEvent('deepthinkLiveTabOpened'));
            renderActiveDeepthinkPipeline();
        });
        tabsNavContainer.appendChild(btn);
    });

    if (pipelineContentRoot && pipelineContentContainerNode && !document.contains(pipelineContentContainerNode)) {
        const oldRoot = pipelineContentRoot;
        setTimeout(() => oldRoot.unmount(), 0);
        pipelineContentRoot = null;
        pipelineContentContainerNode = null;
    }

    if (!pipelineContentRoot) {
        pipelinesContentContainer.innerHTML = '';
        pipelineContentContainerNode = document.createElement('div');
        pipelineContentContainerNode.className = 'deepthink-pipeline-react-root';
        pipelinesContentContainer.appendChild(pipelineContentContainerNode);
        pipelineContentRoot = createRoot(pipelineContentContainerNode);
    }

    const tabContent = createDeepthinkTabContent(deepthinkProcess);
    window.dispatchEvent(new CustomEvent('deepthinkPipelineStateChanged'));
    pipelineContentRoot.render(tabContent);
}

function getVisibleDeepthinkTabs(process: DeepthinkPipelineState) {
    const showCuratedContext = process.runConfig ? process.runConfig.modulesCount > 0 : true;
    return [
        { id: 'live', label: 'Live', icon: 'terminal', visible: true },
        { id: 'filesystem', label: 'Filesystem', icon: 'folder', visible: true },
        { id: 'strategic-solver', label: 'Branches', icon: 'psychology', visible: true },
        { id: 'modules-explorer', label: 'Curated Context', icon: 'science', visible: showCuratedContext },
    ]
        .filter(tab => tab.visible)
        .map(({ visible, ...tab }) => ({ ...tab, statusClass: getTabStatusClass(tab.id, process) }));
}

function createDeepthinkTabContent(process: DeepthinkPipelineState): React.ReactElement {
    const onStrategyTabClick = (idx: number) => {
        process.activeStrategyTab = idx;
        renderActiveDeepthinkPipeline();
    };
    const onViewSolution = (id: string) => openDeepthinkSolutionModal(id);
    const onViewArgument = (id: string) => openModuleArgumentModal(id);

    switch (process.activeTabId) {
        case 'live':
            return <DeepthinkLiveTab process={process} />;
        case 'filesystem':
            return <DeepthinkFilesystemTab key={process.id} repositoryId={process.id} />;
        case 'strategic-solver':
            return <StrategicSolverTab process={process} escapeHtml={moduleState.escapeHtml} onStrategyTabClick={onStrategyTabClick} onViewSolution={onViewSolution} />;
        case 'modules-explorer':
            return <ModulesExplorerTab process={process} onViewArgument={onViewArgument} />;
        default:
            return <DeepthinkLiveTab process={process} />;
    }
}

function getTabStatusClass(tabId: string, process: DeepthinkPipelineState): string {
    switch (tabId) {
        case 'live':
            return process.status === 'error' ? 'status-deepthink-error'
                : process.status === 'completed' ? 'status-deepthink-completed'
                : process.status === 'processing' ? 'status-deepthink-processing' : '';
        case 'strategic-solver':
            return process.status === 'error' ? 'status-deepthink-error'
                : process.initialStrategies?.some(s => s.status === 'completed') ? 'status-deepthink-completed'
                : process.initialStrategies?.some(s => s.status === 'processing') ? 'status-deepthink-processing' : '';
        case 'modules-explorer':
            return process.modules?.some(m => m.testerStatus === 'error') ? 'status-deepthink-error'
                : process.modules?.some(m => m.testerStatus === 'processing') ? 'status-deepthink-processing'
                : process.modules?.some(m => m.testerStatus === 'completed') || process.modulesExplorerComplete ? 'status-deepthink-completed' : '';
        default:
            return '';
    }
}
