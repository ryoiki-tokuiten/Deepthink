/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deepthink — React components for the Deepthink pipeline UI.
 * All pure logic, state management, and event coordination lives in Deepthink.ts.
 */

import React, { useEffect, useState, useRef } from 'react';
import {
    DeepthinkPipelineState,
    DeepthinkMainStrategyData,
    DeepthinkModuleData,
} from '../core/deepthinkCore';
import MathHTML from '../../Styles/Components/RenderMathMarkdown';
import { Icon as MIcon } from '../../UI/Icons';
import type { BsrGlobalUpdateRecord } from '../core/types';
import { BranchStateModal } from './BranchStateModal';
import { DosSynthesisCard } from './DosSynthesisCard';

// ═══════════════════════════════════════════════════════════════════════
// Shared Primitives
// ═══════════════════════════════════════════════════════════════════════

const modulesTesterDisplay = (mod: DeepthinkModuleData): string =>
    mod.testerAttemptDisplay || mod.testerAttempt || '';

// ═══════════════════════════════════════════════════════════════════════
// Show More / Show Less Toggle
// ═══════════════════════════════════════════════════════════════════════

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
    const display = expanded || !isLong ? text : text.substring(0, maxLength) + '...';

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

// ═══════════════════════════════════════════════════════════════════════
// Solution Modals (embedded + fullscreen)
// ═══════════════════════════════════════════════════════════════════════

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
                    {title && (isEmbedded
                        ? <h4>{title}</h4>
                        : <h2 className="modal-title">{title}</h2>)}
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

// Default (non-iterative) solution modal body
export const EmbeddedModalContent: React.FC<{
    content: string;
    contentClass?: string;
}> = ({ content, contentClass = 'deepthink-response-content' }) => (
    <div className="deepthink-embedded-response">
        <div>
            <MathHTML content={content} className={contentClass} />
        </div>
    </div>
);

interface StructuredReasoningEvaluation {
    id: string;
    decision: string;
    reasoning: string;
}

interface StructuredReasoningViewModel {
    challenge?: string;
    analysisSummary?: string;
    narrative?: string;
    evaluations: StructuredReasoningEvaluation[];
}

function parseStructuredReasoning(reasoning: unknown): StructuredReasoningViewModel {
    const fallbackText = typeof reasoning === 'string'
        ? reasoning
        : reasoning
            ? JSON.stringify(reasoning, null, 2)
            : '';

    let parsed: Record<string, any> | null = null;
    if (typeof reasoning === 'string') {
        try {
            parsed = JSON.parse(reasoning);
        } catch {
            parsed = null;
        }
    } else if (reasoning && typeof reasoning === 'object') {
        parsed = reasoning as Record<string, any>;
    }

    const evaluationsSource = Array.isArray(parsed?.strategy_evaluations)
        ? parsed?.strategy_evaluations
        : Array.isArray(parsed?.strategies)
            ? parsed?.strategies
            : [];

    return {
        challenge: typeof parsed?.challenge === 'string' ? parsed.challenge : undefined,
        analysisSummary: typeof parsed?.analysis_summary === 'string' ? parsed.analysis_summary : undefined,
        narrative: typeof parsed?.reasoning === 'string'
            ? parsed.reasoning
            : typeof parsed?.explanation === 'string'
                ? parsed.explanation
                : typeof parsed?.analysis === 'string'
                    ? parsed.analysis
                    : fallbackText,
        evaluations: evaluationsSource
            .filter((evaluation: any) => evaluation && typeof evaluation === 'object')
            .map((evaluation: any) => ({
                id: String(evaluation.id || evaluation.strategy_id || 'Unknown ID'),
                decision: String(evaluation.decision || evaluation.verdict || evaluation.action || 'unknown'),
                reasoning: String(evaluation.reason || evaluation.reasoning || evaluation.explanation || 'No reasoning provided'),
            })),
    };
}

const StructuredReasoningContent: React.FC<{
    reasoning: unknown;
    wrapperClassName?: string;
    resultsClassName?: string;
    emptyMessage?: string;
}> = ({
    reasoning,
    wrapperClassName = 'agent-reasoning-display',
    resultsClassName = 'evaluation-results',
    emptyMessage = 'No analysis available',
}) => {
    const parsed = React.useMemo(() => parseStructuredReasoning(reasoning), [reasoning]);

    const body = parsed.evaluations.length > 0 || parsed.challenge || parsed.analysisSummary
        ? (
            <div className={resultsClassName}>
                {parsed.challenge && <h4>Challenge Evaluation: {parsed.challenge}</h4>}
                {parsed.analysisSummary && (
                    <>
                        <h4>Analysis Summary</h4>
                        <div className="evaluation-reason">
                            <MathHTML content={parsed.analysisSummary} />
                        </div>
                    </>
                )}
                {parsed.evaluations.map((evaluation, index) => (
                    <div key={`${evaluation.id}-${index}`} className="strategy-evaluation-item">
                        <div className="evaluation-header">
                            <span className="strategy-id">{evaluation.id}</span>
                            <span className={`decision-badge decision-${evaluation.decision.toLowerCase()}`}>{evaluation.decision}</span>
                        </div>
                        <div className="evaluation-reason">
                            <MathHTML content={evaluation.reasoning} />
                        </div>
                    </div>
                ))}
            </div>
        )
        : <MathHTML content={parsed.narrative || emptyMessage} className="agent-analysis" />;

    if (!wrapperClassName) {
        return <>{body}</>;
    }

    return <div className={wrapperClassName}>{body}</div>;
};

export const StructuredResponseModalContent: React.FC<{
    reasoning: unknown;
    resultsClassName?: string;
    emptyMessage?: string;
}> = ({ reasoning, resultsClassName, emptyMessage }) => (
    <div className="deepthink-embedded-response">
        <div>
            <StructuredReasoningContent
                reasoning={reasoning}
                resultsClassName={resultsClassName}
                emptyMessage={emptyMessage}
            />
        </div>
    </div>
);

// ═══════════════════════════════════════════════════════════════════════
// Tab Content Components
// ═══════════════════════════════════════════════════════════════════════

// Pruned Branch Switcher UI component
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
                    {(() => {
                        if (!pb.prunedAtIteration) return 'Pruned';
                        const startIter = pb.strategyTextHistory?.[0]?.iteration ?? 0;
                        const lifespan = Math.max(1, pb.prunedAtIteration - startIter);
                        return `Pruned (After ${lifespan} Iterations)`;
                    })()}
                </button>
            ))}
        </div>
    );
};

// StrategicSolverTab
export const StrategicSolverTab: React.FC<{
    process: DeepthinkPipelineState;
    escapeHtml: (s: string) => string;
    onStrategyTabClick: (idx: number) => void;
    onViewSolution: (strategyId: string) => void;
    onViewBsr?: (strategyId: string) => void;
}> = ({ process, escapeHtml, onStrategyTabClick, onViewSolution, onViewBsr }) => {
    const [bsrModalBranchId, setBsrModalBranchId] = useState<string | null>(null);

    if (process.status === 'error' && process.error) {
        return <div className="status-message error"><pre>{escapeHtml(process.error)}</pre></div>;
    }
    if (!process.initialStrategies?.length) {
        return <div className="loading">Generating strategic approaches...</div>;
    }

    const activeIndex = process.activeStrategyTab || 0;
    
    // Track selected branch ID per slot so switching tabs remembers what version you were looking at
    const [selectedVersions, setSelectedVersions] = useState<Record<number, string>>({});

    const handleViewBsr = (strategyId: string) => {
        if (onViewBsr) {
            onViewBsr(strategyId);
        } else {
            setBsrModalBranchId(strategyId);
        }
    };

    return (
        <div className="deepthink-strategic-solver">
            <div className="branch-tabs-container">
                <div className="branch-tabs-content">
                    {process.initialStrategies.map((strategy, index) => (
                        <div key={strategy.id} className={`branch-tab-content${index === activeIndex ? ' active' : ''}`}>
                            <div className="strategy-card">
                                {/* Nav buttons: Only strategy number buttons (proximity buttons removed) */}
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

                                {(() => {
                                    const slotPruned = (((process as any).prunedBranches || []) as any[]).filter(b => b.slotIndex === index);
                                    const activeId = strategy.id;
                                    const currentSelectedId = selectedVersions[index] || activeId;
                                    const displayStrategy = currentSelectedId === activeId 
                                        ? strategy 
                                        : (slotPruned.find(p => p.id === currentSelectedId) || strategy);
                                        
                                    return (
                                        <>
                                            <StrategyContent
                                                strategy={displayStrategy}
                                                process={process}
                                                escapeHtml={escapeHtml}
                                                onViewSolution={onViewSolution}
                                                onViewBsr={handleViewBsr}
                                                belowTextActions={(
                                                    <BranchVersionSwitcher
                                                        activeStrategy={strategy}
                                                        prunedStrategies={slotPruned}
                                                        selectedBranchId={currentSelectedId}
                                                        onSelect={(id) => setSelectedVersions(prev => ({ ...prev, [index]: id }))}
                                                    />
                                                )}
                                                isPruned={currentSelectedId !== activeId}
                                            />
                                        </>
                                    );
                                })()}

                            </div>
                            
                        </div>
                    ))}
                </div>
            </div>
            {bsrModalBranchId !== null && (
                <BranchStateModal
                    branchId={bsrModalBranchId}
                    process={process}
                    onClose={() => setBsrModalBranchId(null)}
                />
            )}
        </div>
    );
};

const StrategyContent: React.FC<{
    strategy: DeepthinkMainStrategyData;
    process: DeepthinkPipelineState;
    escapeHtml: (s: string) => string;
    onViewSolution: (id: string) => void;
    onViewBsr: (id: string) => void;
    belowTextActions?: React.ReactNode;
    isPruned?: boolean;
}> = ({ strategy, process, escapeHtml, onViewSolution, onViewBsr, belowTextActions, isPruned }) => {
    const branchRecords = (process.bsrRecords || []).filter(r => r.branch_id === strategy.id);
    const hasBsr = branchRecords.length > 0;
    
    const history = strategy.strategyTextHistory || [{ iteration: 0, text: strategy.strategyText }];
    const [historyIndex, setHistoryIndex] = useState(history.length - 1);
    
    // Make sure we select the latest if history grows and user hasn't explicitly navigated backwards
    useEffect(() => {
        setHistoryIndex(history.length - 1);
    }, [history.length]);
    
    const activeIndex = Math.min(Math.max(0, historyIndex), history.length - 1);
    const activeText = history[activeIndex].text;
    const activeVersion = history[activeIndex];
    const activeVersionBsr = branchRecords.find(record => record.iteration === activeVersion.iteration);
    const isEvolvedVersion = activeVersionBsr?.computed?.decision === 'EVOLVE';
    const hasEvolvedHistory = history.some(version =>
        branchRecords.some(record => record.iteration === version.iteration && record.computed?.decision === 'EVOLVE')
    );
    const historyControls = (history.length > 1 || isEvolvedVersion) && (
        <div className={`strategy-history-controls${hasEvolvedHistory ? ' is-evolved' : ''}`}>
            <button
                type="button"
                className="strategy-history-button"
                onClick={() => setHistoryIndex(prev => Math.max(0, prev - 1))}
                disabled={activeIndex === 0}
                aria-label="View previous strategy version"
            >
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
            <button
                type="button"
                className="strategy-history-button"
                onClick={() => setHistoryIndex(prev => Math.min(history.length - 1, prev + 1))}
                disabled={activeIndex === history.length - 1}
                aria-label="View next strategy version"
            >
                <MIcon name="chevron_right" />
            </button>
        </div>
    );

    return (
        <div className="strategy-content" style={{ opacity: isPruned ? 0.8 : 1 }}>
            <ExpandableText
                text={activeText}
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
                    <button
                        type="button"
                        className="view-solution-button"
                        onClick={() => onViewSolution(strategy.id)}
                    >
                        <MIcon name="visibility" /> View Solution
                    </button>
                )}
            />
            {strategy.error && <div className="error-message">{escapeHtml(strategy.error)}</div>}

            {/* Integrated Visual BSR Display (shown only when BSR output is ready for this branch) */}
            {hasBsr && (
                <BranchVisualBsr
                    branchId={strategy.id}
                    records={branchRecords}
                    process={process}
                    onInspectBsr={() => onViewBsr(strategy.id)}
                />
            )}
        </div>
    );
};

const SIZE_WEIGHTS: Record<string, number> = { small: 1, medium: 2, large: 4 };

const BranchVisualBsr: React.FC<{
    branchId: string;
    records: BsrGlobalUpdateRecord[];
    process: DeepthinkPipelineState;
    onInspectBsr?: () => void;
}> = ({ branchId, records, process }) => {
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
        : computed.form === 'in_place'
            ? 'In Place'
            : null;

    // Action Pressures: CONTINUE, EVOLVE, PRUNE
    const pCont = computed.pressure.CONTINUE || 0;
    const pEvol = computed.pressure.EVOLVE || 0;
    const pPrun = computed.pressure.PRUNE || 0;

    // Determine continuous chain of surviving records up to activeIdx
    // If a branch survived (CONTINUE or EVOLVE) in previous windows, chain them cleanly.
    // If it was PRUNED, it reset, so the chain starts after the last PRUNE.
    let chainStartIdx = 0;
    for (let i = activeIdx - 1; i >= 0; i--) {
        const prevDecision = records[i].computed?.decision;
        if (prevDecision === 'PRUNE') {
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
                if (!currentProg.some(ex => ex.iteration === e.iteration && ex.reason === e.reason)) {
                    currentProg.push(e);
                }
            });
            rEvts.filter(e => e.iteration === it).forEach(e => {
                if (!currentRegr.some(ex => ex.iteration === e.iteration && ex.reason === e.reason)) {
                    currentRegr.push(e);
                }
            });
        }
    });

    iterOrder.sort((a, b) => a - b);

    // Calculate iteration data points starting at 'start'
    interface ChartPoint {
        label: string;
        iterVal: number | 'start';
        change: number;
        total: number;
        progEvents: typeof report.confirmed_progress;
        regrEvents: typeof report.confirmed_regression;
    }

    const points: ChartPoint[] = [
        {
            label: 'start',
            iterVal: 'start',
            change: 0,
            total: 0,
            progEvents: [],
            regrEvents: [],
        }
    ];

    let runningTotal = 0;
    iterOrder.forEach(it => {
        const pEvts = iterProgMap.get(it) || [];
        const rEvts = iterRegrMap.get(it) || [];
        const pScore = pEvts.reduce((sum, e) => sum + (activeWeights[e.size] || 1), 0);
        const rScore = rEvts.reduce((sum, e) => sum + (activeWeights[e.size] || 1), 0);
        const change = pScore - rScore;
        runningTotal += change;
        points.push({
            label: String(it),
            iterVal: it,
            change,
            total: runningTotal,
            progEvents: pEvts,
            regrEvents: rEvts,
        });
    });

    const allTotals = points.map(p => p.total);
    const bestTotal = Math.max(0, ...allTotals);
    const finalTotal = points[points.length - 1].total;

    // Find last good point index
    let lastGoodIdx = 0;
    const specLastGood = activeRecord.computed.last_good_iteration;
    if (typeof specLastGood === 'number') {
        const found = points.findIndex(p => p.iterVal === specLastGood);
        if (found !== -1) {
            lastGoodIdx = found;
        } else {
            lastGoodIdx = points.reduce((bestIdx, p, idx) => p.total > points[bestIdx].total ? idx : bestIdx, 0);
        }
    } else {
        lastGoodIdx = points.reduce((bestIdx, p, idx) => p.total > points[bestIdx].total ? idx : bestIdx, 0);
    }
    const lastGoodVal = points[lastGoodIdx]?.iterVal;

    const graphCardRef = useRef<HTMLDivElement>(null);
    const [cardWidth, setCardWidth] = useState(900);

    useEffect(() => {
        if (!graphCardRef.current) return;
        const update = () => {
            if (graphCardRef.current) {
                const w = graphCardRef.current.clientWidth;
                if (w > 0) setCardWidth(w);
            }
        };
        update();
        const ro = new ResizeObserver(entries => {
            if (entries[0]) {
                const w = entries[0].contentRect.width;
                if (w > 0) setCardWidth(w);
            }
        });
        ro.observe(graphCardRef.current);
        return () => ro.disconnect();
    }, []);

    // Full width responsive SVG coordinate calculations
    const padLeft = 60;
    const padRight = 75;
    const padTop = 24;
    const padBottom = 26;

    const minStepWidth = 65; // Enforce minimum width per step
    const numSteps = Math.max(1, points.length - 1);
    const requiredGraphWidth = padLeft + padRight + (numSteps * minStepWidth);
    
    // svgWidth uses cardWidth if it fits, otherwise expands to requiredGraphWidth
    const svgWidth = Math.max(Math.max(500, cardWidth - 28), requiredGraphWidth);
    const svgHeight = 240;

    const minVal = Math.min(-4, Math.floor(Math.min(...allTotals, finalTotal) / 2) * 2);
    const maxVal = Math.max(6, Math.ceil(Math.max(...allTotals, bestTotal) / 2) * 2);
    const valRange = Math.max(1, maxVal - minVal);

    const getY = (val: number) => {
        const norm = (val - minVal) / valRange;
        return padTop + (1 - norm) * (svgHeight - padTop - padBottom);
    };

    const step = (svgWidth - padLeft - padRight) / numSteps;
    const getX = (idx: number) => padLeft + idx * step;
    const useMultiLineChangeLabels = Math.max(44, step - 6) < 80;
    const maxEventsAtIteration = points.slice(1).reduce(
        (maxCount, point) => Math.max(maxCount, point.progEvents.length + point.regrEvents.length),
        0
    );
    const changeOverlayHeight = Math.max(
        38,
        maxEventsAtIteration * (useMultiLineChangeLabels ? 32 : 22) + Math.max(0, maxEventsAtIteration - 1) * 2
    );

    // Y-axis tick marks (every 2 units)
    const yTicks: number[] = [];
    for (let t = minVal; t <= maxVal; t += 2) {
        yTicks.push(t);
    }

    // Path d
    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(p.total)}`).join(' ');

    const lastIdx = points.length - 1;
    const bestTotalY = getY(bestTotal);
    const finalTotalY = getY(finalTotal);
    const arrowX = svgWidth - padRight + 18;
    const hoveredIndex = hoveredPointIndex === null
        ? null
        : Math.min(lastIdx, Math.max(0, hoveredPointIndex));
    const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex];
    const hoveredX = hoveredIndex === null ? 0 : getX(hoveredIndex);
    const hoveredY = hoveredPoint ? getY(hoveredPoint.total) : 0;
    const tooltipWidth = 224;
    const tooltipHeight = 82;
    const tooltipX = hoveredPoint
        ? Math.min(
            Math.max(padLeft, hoveredX + tooltipWidth + 14 <= svgWidth - padRight ? hoveredX + 14 : hoveredX - tooltipWidth - 14),
            svgWidth - padRight - tooltipWidth
        )
        : 0;
    const preferredTooltipY = hoveredY - tooltipHeight - 12;
    const tooltipY = hoveredPoint
        ? Math.min(
            Math.max(padTop, preferredTooltipY < padTop ? hoveredY + 12 : preferredTooltipY),
            svgHeight - padBottom - tooltipHeight
        )
        : 0;

    const handleGraphPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const pointerX = ((event.clientX - rect.left) / rect.width) * svgWidth;
        const nearestIndex = Math.min(lastIdx, Math.max(0, Math.round((pointerX - padLeft) / step)));
        setHoveredPointIndex(nearestIndex);
    };

    const allChainedEvents = [
        ...chainedRecords.flatMap(r => (r.report?.confirmed_progress || []).map(e => ({ ...e, type: 'progress' as const }))),
        ...chainedRecords.flatMap(r => (r.report?.confirmed_regression || []).map(e => ({ ...e, type: 'regression' as const })))
    ].sort((a, b) => a.iteration - b.iteration);

    return (
        <div className="bsr-visual-container">
            {/* Top row: 2 side panels side by side */}
            <div className="bsr-side-by-side">
                {/* Left Panel: Action Pressures (Horizontal bar track with telemetry strip below) */}
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

                    {(() => {
                        const sum = (pCont + pEvol + pPrun) || 1;
                        const nCont = pCont / sum;
                        const nEvol = pEvol / sum;
                        const nPrun = pPrun / sum;
                        
                        return (
                            <div className="bsr-visual-bar-track" style={{ height: '28px', display: 'flex', borderRadius: '6px', overflow: 'hidden', position: 'relative' }}>
                                <div className="bar-fill continue" style={{ flex: nCont, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'min-content', padding: '0 12px' }} title={`CONTINUE: ${(pCont * 100).toFixed(1)}%`}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 4px rgba(0,0,0,0.9)', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>CONTINUE {(pCont * 100).toFixed(0)}%</span>
                                </div>
                                <div className="bar-fill evolve" style={{ flex: nEvol, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'min-content', padding: '0 12px' }} title={`EVOLVE: ${(pEvol * 100).toFixed(1)}%`}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 4px rgba(0,0,0,0.9)', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>EVOLVE {(pEvol * 100).toFixed(0)}%</span>
                                </div>
                                <div className="bar-fill prune" style={{ flex: nPrun, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'min-content', padding: '0 12px' }} title={`PRUNE: ${(pPrun * 100).toFixed(1)}%`}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 4px rgba(0,0,0,0.9)', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>PRUNE {(pPrun * 100).toFixed(0)}%</span>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Restored Telemetry Strip */}
                    <div className="bsr-visual-telemetry-strip" style={{ marginTop: '20px' }}>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Net:</span>
                            <span className={`telemetry-val ${computed.net >= 0 ? 'pos' : 'neg'}`}>
                                {computed.net >= 0 ? `+${computed.net}` : computed.net}
                            </span>
                        </span>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Lost Ground:</span>
                            <span className="telemetry-val">{computed.lost_ground.toFixed(3)}</span>
                        </span>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Progress Kept:</span>
                            <span className="telemetry-val">{computed.progress_kept.toFixed(3)}</span>
                        </span>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Drift:</span>
                            <span className="telemetry-val">{computed.drift.toFixed(3)}</span>
                        </span>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Stall Evidence:</span>
                            <span className="telemetry-val">{computed.stall_evidence.toFixed(3)}</span>
                        </span>
                        <span className="telemetry-pill">
                            <span className="telemetry-lbl">Critique Alignment:</span>
                            <span className="telemetry-val">{(report.critique_alignment.value * 100).toFixed(0)}%</span>
                        </span>
                    </div>
                </div>

                {/* Right Panel: Critique Alignment & Window Summary */}
                <div className="bsr-side-panel bsr-alignment-panel" style={{ border: '1px solid rgba(255,255,255,0.1)', padding: '16px' }}>
                    <div className="bsr-panel-header">
                        <span className="bsr-panel-title">Window Outcome: {computed.window_outcome}</span>
                        {records.length > 1 && (
                            <div className="bsr-update-tabs">
                                {records.map((r, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        className={`bsr-update-pill${idx === activeIdx ? ' active' : ''}`}
                                        onClick={() => setSelectedIdx(idx)}
                                    >
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

            {/* Running Total Window Graph & Overlayed Confirmed Events */}
            <div className="bsr-window-graph-card">
                <div className="bsr-graph-top-bar">
                    <span className="bsr-graph-heading">
                        {chainedRecords.length > 1
                            ? `Running total across surviving windows (${formatStrategyId(branchId)})`
                            : `Running total in the window (${formatStrategyId(branchId)})`}
                    </span>
                    {chainedRecords.length > 1 && (
                        <span className="bsr-chain-badge">
                            Updates #{chainedRecords[0].updateNumber}–#{activeRecord.updateNumber}
                        </span>
                    )}
                </div>

                <div className="bsr-graph-content-layout">
                    <div className="bsr-graph-main-col" ref={graphCardRef}>
                        <div className="bsr-graph-scroll-container">
                            <div className="bsr-graph-scroll-content" style={{ width: `${svgWidth}px` }}>
                                {/* SVG Graph stretching full horizontal space */}
                                <div className="bsr-svg-graph-container">
                    <svg
                        className="bsr-window-svg"
                        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                        width="100%"
                        height={svgHeight}
                        role="img"
                        aria-label={`Running total graph for ${formatStrategyId(branchId)}`}
                        onPointerMove={handleGraphPointerMove}
                        onPointerLeave={() => setHoveredPointIndex(null)}
                    >
                        {/* Horizontal Gridlines & Y-Axis values */}
                        {yTicks.map(t => {
                            const yPos = getY(t);
                            const isZero = t === 0;
                            return (
                                <g key={t}>
                                    <line
                                        className={`bsr-grid-line${isZero ? ' zero' : ''}`}
                                        x1={padLeft - 5}
                                        y1={yPos}
                                        x2={svgWidth - padRight + 28}
                                        y2={yPos}
                                        stroke={isZero ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.07)'}
                                        strokeWidth={isZero ? 1.2 : 0.8}
                                    />
                                    <text
                                        x={padLeft - 10}
                                        y={yPos + 3.5}
                                        textAnchor="end"
                                        fill={isZero ? 'var(--text-color)' : 'var(--text-secondary-color)'}
                                        fontSize="10"
                                        fontWeight={isZero ? '600' : '400'}
                                    >
                                        {t}
                                    </text>
                                </g>
                            );
                        })}

                        {/* Best Total dashed reference line */}
                        {bestTotal > 0 && (
                            <line
                                x1={getX(lastGoodIdx)}
                                y1={bestTotalY}
                                x2={arrowX + 10}
                                y2={bestTotalY}
                                stroke="#f59e0b"
                                strokeDasharray="3 3"
                                strokeWidth="1.2"
                            />
                        )}

                        {/* Final total dashed reference line */}
                        <line
                            className="bsr-final-total-line"
                            x1={getX(lastIdx)}
                            y1={finalTotalY}
                            x2={arrowX + 10}
                            y2={finalTotalY}
                            stroke="rgba(255, 255, 255, 0.45)"
                            strokeDasharray="3 3"
                            strokeWidth="1.2"
                        />
                        <text
                            x={getX(lastIdx) - 8}
                            y={finalTotalY + (finalTotal >= 0 ? 14 : -6)}
                            textAnchor="end"
                            fill="var(--text-secondary-color)"
                            fontSize="10"
                            fontFamily="monospace"
                        >
                            net = {finalTotal}
                        </text>

                        {/* Lost Ground Vertical Dimension Arrow */}
                        {Math.abs(bestTotalY - finalTotalY) > 6 && (
                            <g className="bsr-lost-ground-dimension">
                                <line
                                    x1={arrowX}
                                    y1={bestTotalY}
                                    x2={arrowX}
                                    y2={finalTotalY}
                                    stroke="var(--text-secondary-color)"
                                    strokeWidth="1.2"
                                />
                                <text
                                    x={arrowX + 8}
                                    y={(bestTotalY + finalTotalY) / 2 + 4}
                                    fill="var(--text-color)"
                                    fontSize="11"
                                    fontWeight="700"
                                >
                                    {bestTotal - finalTotal}
                                </text>
                            </g>
                        )}

                        {/* Running Total connecting line */}
                        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2.2" />

                        {/* Data Points */}
                        {points.map((pt, i) => {
                            const cx = getX(i);
                            const cy = getY(pt.total);
                            const isStart = pt.iterVal === 'start';
                            const isLastGood = i === lastGoodIdx && bestTotal > 0;

                            return (
                                <g key={i}>
                                    {/* X-axis tick */}
                                    <line
                                        className="bsr-x-axis-tick"
                                        x1={cx}
                                        y1={getY(minVal)}
                                        x2={cx}
                                        y2={getY(minVal) + 5}
                                        stroke="rgba(255, 255, 255, 0.25)"
                                        strokeWidth="1"
                                    />
                                    <text
                                        x={cx}
                                        y={getY(minVal) + 16}
                                        textAnchor="middle"
                                        fill="var(--text-secondary-color)"
                                        fontSize="10.5"
                                    >
                                        {pt.label}
                                    </text>

                                    {/* Highlight circle ring around last good iteration */}
                                    {isLastGood && (
                                        <circle cx={cx} cy={cy} r="8" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
                                    )}

                                    {/* Point marker */}
                                    {isStart ? (
                                        <circle className="bsr-start-point" cx={cx} cy={cy} r="4" fill="rgba(15, 23, 42, 0.9)" stroke="#6366f1" strokeWidth="2" />
                                    ) : (
                                        <circle cx={cx} cy={cy} r="4" fill="#6366f1" stroke="#818cf8" strokeWidth="1" />
                                    )}
                                </g>
                            );
                        })}

                        {hoveredPoint && hoveredIndex !== null && (
                            <g className="bsr-hover-layer" pointerEvents="none">
                                <line
                                    className="bsr-hover-line"
                                    x1={hoveredX}
                                    y1={padTop}
                                    x2={hoveredX}
                                    y2={svgHeight - padBottom}
                                />
                                <circle
                                    cx={hoveredX}
                                    cy={hoveredY}
                                    r="6.5"
                                    fill={hoveredPoint.iterVal === 'start' ? '#312e81' : '#6366f1'}
                                    stroke="#c7d2fe"
                                    strokeWidth="2"
                                />
                                <rect
                                    className="bsr-hover-tooltip"
                                    x={tooltipX}
                                    y={tooltipY}
                                    width={tooltipWidth}
                                    height={tooltipHeight}
                                    rx="7"
                                />
                                <text className="bsr-hover-tooltip-title" x={tooltipX + 10} y={tooltipY + 18}>
                                    {hoveredPoint.iterVal === 'start' ? 'Window start' : `Iteration ${hoveredPoint.label}`}
                                </text>
                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 37}>
                                    Running total: {hoveredPoint.total}
                                </text>
                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 54}>
                                    Change: {hoveredPoint.change > 0 ? '+' : ''}{hoveredPoint.change}
                                </text>
                                <text className="bsr-hover-tooltip-value" x={tooltipX + 10} y={tooltipY + 71}>
                                    Confirmed: {hoveredPoint.progEvents.length} progress · {hoveredPoint.regrEvents.length} regression
                                </text>
                            </g>
                        )}
                    </svg>
                </div>

                {/* Confirmed events change pills row aligned under columns */}
                <div className="bsr-change-overlay-row" style={{ width: '100%', position: 'relative', height: `${changeOverlayHeight}px` }}>
                    <span
                        className="bsr-change-tag-lead"
                        style={{
                            position: 'absolute',
                            left: 0,
                            width: `${padLeft}px`,
                            top: 0,
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            textAlign: 'right',
                            paddingRight: '10px',
                            boxSizing: 'border-box'
                        }}
                    >
                        change
                    </span>
                    {points.slice(1).map((pt, i) => {
                        const colIdx = i + 1;
                        const colCenterX = getX(colIdx);
                        const colWidth = Math.max(44, step - 6);
                        const hasEvents = pt.progEvents.length > 0 || pt.regrEvents.length > 0;
                        const useMultiLine = useMultiLineChangeLabels;

                        return (
                            <div
                                key={i}
                                className="bsr-change-col"
                                style={{
                                    position: 'absolute',
                                    left: `${colCenterX - colWidth / 2}px`,
                                    top: 0,
                                    width: `${colWidth}px`,
                                    height: '100%',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center'
                                }}
                            >
                                {!hasEvents ? (
                                    <span className="change-chip no-events">no events</span>
                                ) : (
                                    <div className="change-chips-cluster">
                                        {pt.progEvents.map((pe, peIdx) => {
                                            const weight = activeWeights[pe.size] || 1;
                                            return (
                                                <span
                                                    key={`p-${peIdx}`}
                                                    className={`change-chip progress${useMultiLine ? ' multiline' : ''}`}
                                                    title={pe.reason}
                                                >
                                                    {useMultiLine ? (
                                                        <>
                                                            <span className="chip-sign">+{weight}</span>
                                                            <span className="chip-size">{pe.size}</span>
                                                        </>
                                                    ) : (
                                                        `+${weight} ${pe.size}`
                                                    )}
                                                </span>
                                            );
                                        })}
                                        {pt.regrEvents.map((re, reIdx) => {
                                            const weight = activeWeights[re.size] || 1;
                                            return (
                                                <span
                                                    key={`r-${reIdx}`}
                                                    className={`change-chip regression${useMultiLine ? ' multiline' : ''}`}
                                                    title={re.reason}
                                                >
                                                    {useMultiLine ? (
                                                        <>
                                                            <span className="chip-sign">-{weight}</span>
                                                            <span className="chip-size">{re.size}</span>
                                                        </>
                                                    ) : (
                                                        `-${weight} ${re.size}`
                                                    )}
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

                {/* Match the graph and change-label lane; additional events scroll inside this viewport. */}
                {allChainedEvents.length > 0 && (
                    <div
                        className="bsr-event-evidence-right-pane"
                        style={{ height: `calc(${svgHeight + changeOverlayHeight}px + 0.95rem + 2px)` }}
                    >
                        <div className="bsr-event-evidence-expand">
                            {allChainedEvents.map((evt, idx) => {
                                const cleanEvidence = evt.reason
                                    ? evt.reason.replace(/^\[?\s*Evidence:\s*/i, '').replace(/\s*\]$/, '').trim()
                                    : 'Confirmed event';
                                return (
                                    <div key={idx} className={`bsr-graph-evidence-row ${evt.type}`}>
                                        <span className="evidence-iter-pill">Iter {evt.iteration}</span>
                                        <span className={`evidence-dir-tag ${evt.type}`}>{evt.type === 'progress' ? '+PROG' : '-REGR'}</span>
                                        <span className="evidence-size-pill">{evt.size}</span>
                                        <span className="evidence-content">{cleanEvidence}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
                </div>
            </div>
        </div>
    );
};

const formatStrategyId = (id: string): string => {
    if (id.startsWith('main')) {
        const num = id.slice(4);
        return `Strategy ${num}`;
    }
    return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const formatCompactStrategyId = (id: string): string => {
    const number = id.match(/(\d+)$/)?.[1];
    return number ? `S${number}` : formatStrategyId(id);
};

type ModuleRoundView = {
    key: string;
    label: string;
    roundNumber?: number;
    modules: DeepthinkModuleData[];
    packet: string;
};

function moduleRoundLabel(roundNumber: number): string {
    return `Heartbeat ${roundNumber}`;
}

function buildModuleRoundViews(process: DeepthinkPipelineState): ModuleRoundView[] {
    const roundNumberSet = new Set<number>();

    // 1. Collect all round numbers from heartbeats
    (process.heartbeats || []).forEach(h => {
        if (h.heartbeat_no) roundNumberSet.add(h.heartbeat_no);
    });

    // 2. Collect from moduleRounds
    (process.moduleRounds || []).forEach(r => {
        if (r.roundNumber) roundNumberSet.add(r.roundNumber);
    });

    // 3. Collect from modules
    (process.modules || []).forEach(m => {
        if (m.roundNumber) roundNumberSet.add(m.roundNumber);
    });

    // 4. Collect from heartbeatNo
    if (process.heartbeatNo && process.heartbeatNo > 0) {
        for (let i = 1; i <= process.heartbeatNo; i++) {
            roundNumberSet.add(i);
        }
    }

    // 5. Collect from DOS outputs
    (process.dosOutputs || []).forEach(d => {
        if (d.callType === 'heartbeat') {
            const matchingHb = (process.heartbeats || []).find(h => h.iteration === d.iteration);
            if (matchingHb?.heartbeat_no) roundNumberSet.add(matchingHb.heartbeat_no);
        }
    });

    if (roundNumberSet.size === 0) {
        const roundNumber = process.modules[0]?.roundNumber || 1;
        return [{
            key: `round-${roundNumber}`,
            label: moduleRoundLabel(roundNumber),
            roundNumber,
            modules: process.modules || [],
            packet: process.knowledgePacket || '',
        }];
    }

    const sortedRounds = Array.from(roundNumberSet).sort((a, b) => a - b);
    const history = process.modulesHistory || [];

    return sortedRounds.map((roundNumber) => {
        const hbBlock = (process.heartbeats || []).find(h => h.heartbeat_no === roundNumber);
        const roundSnap = (process.moduleRounds || []).find(r => r.roundNumber === roundNumber);

        let modules: DeepthinkModuleData[] = [];
        if (hbBlock?.modules && hbBlock.modules.length > 0) {
            modules = hbBlock.modules;
        } else if (roundSnap?.modules && roundSnap.modules.length > 0) {
            modules = roundSnap.modules;
        } else if (history[roundNumber - 1]?.length) {
            modules = history[roundNumber - 1];
        } else {
            const filteredLive = (process.modules || []).filter(m => m.roundNumber === roundNumber);
            if (filteredLive.length > 0) {
                modules = filteredLive;
            } else if (roundNumber === (process.heartbeatNo || sortedRounds[sortedRounds.length - 1])) {
                modules = process.modules || [];
            }
        }

        const packet = roundSnap?.packet || process.knowledgePacket || '';

        return {
            key: `round-${roundNumber}`,
            label: moduleRoundLabel(roundNumber),
            roundNumber,
            modules,
            packet,
        };
    });
}

// Curated Context Tab
export const ModulesExplorerTab: React.FC<{
    process: DeepthinkPipelineState;
    onViewArgument: (moduleId: string) => void;
}> = ({ process, onViewArgument }) => {
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
                        <button
                            key={round.key}
                            type="button"
                            className={`modules-round-pill${index === activeRoundIndex ? ' active' : ''}`}
                            onClick={() => setActiveRoundIndex(index)}
                        >
                            {round.label}
                        </button>
                    ))}
                </div>

                <div className="modules-round-content">
                    {/* Synchronized Heartbeat DOS (shown inside each heartbeat) */}
                    {modulesEnabled && (
                        <DosSynthesisCard
                            process={process}
                            heartbeatNo={currentHeartbeatNo}
                        />
                    )}

                    <div className="curated-context-columns has-modules">
                        {modulesEnabled && (
                            <section className="curated-context-modules">
                                <div className="curated-modules-header">
                                    <h3>Modules</h3>
                                </div>

                                {activeModules.length === 0 ? (
                                    <div className="status-message">
                                        {process.modulesGenStatus === 'processing'
                                            ? `Generating modules for Heartbeat ${currentHeartbeatNo}…`
                                            : `No modules recorded for Heartbeat ${currentHeartbeatNo}.`}
                                    </div>
                                ) : (
                                    <div className="agent-grid modules-agent-grid">
                                        {activeModules.map((m, i) => (
                                            <div key={m.id} className="agent-card">
                                                <div className="agent-header modules-card-header">
                                                    <h4 className="agent-title">Module {i + 1}</h4>
                                                    <div
                                                        className="modules-target-circles"
                                                        role="group"
                                                        aria-label={`Targets ${m.targetBranchIds?.length ? m.targetBranchIds.map(formatCompactStrategyId).join(', ') : 'all branches'}`}
                                                    >
                                                        {m.targetBranchIds && m.targetBranchIds.length > 0
                                                            ? m.targetBranchIds.map(id => (
                                                                <span key={id} className="modules-target-circle">{formatCompactStrategyId(id)}</span>
                                                            ))
                                                            : <span className="modules-target-circle">ALL</span>}
                                                    </div>
                                                </div>
                                                <div className="agent-results">
                                                    <div className="modules-text-container">
                                                        <MathHTML
                                                            content={m.moduleText || 'No module text'}
                                                            className="modules-text"
                                                        />
                                                    </div>
                                                    {modulesTesterDisplay(m) && (
                                                        <button
                                                            type="button"
                                                            className="view-argument-button"
                                                            onClick={() => onViewArgument(m.id)}
                                                        >
                                                            <MIcon name="article" /> View The Argument
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
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



// Branch State Surface Tab & Exports
export { BranchStateModal } from './BranchStateModal';
export { DosSynthesisCard } from './DosSynthesisCard';
export { HarnessNoteBanner } from './HarnessNoteBanner';



// Final Result Tab
export const FinalResultTab: React.FC<{
    process: DeepthinkPipelineState;
    escapeHtml: (s: string) => string;
}> = ({ process, escapeHtml }) => (
    <div className="deepthink-final-result">
        {process.finalJudgingStatus === 'completed' && process.finalJudgedBestSolution
            ? (
                <div className="judged-solution-container final-judged-solution">
                    <MathHTML content={process.finalJudgedBestSolution} />
                </div>
            )
            : process.finalJudgingStatus === 'processing'
                ? <div className="loading">Final judging in progress...</div>
                : process.finalJudgingStatus === 'error'
                    ? <div className="status-message error"><p>Error during final judging:</p><pre>{escapeHtml(process.finalJudgingError || 'Unknown error')}</pre></div>
                    : process.status === 'completed'
                        ? <div className="status-message">Final result not available</div>
                        : <div className="status-message">Waiting for solution completion...</div>}
    </div>
);
