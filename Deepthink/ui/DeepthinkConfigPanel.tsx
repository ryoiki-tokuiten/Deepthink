import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { BaseModal } from './Deepthink';
import { getDeepthinkConfigController } from '../../Routing';
import {
    buildDeepthinkTokenTrend,
    calculateDeepthinkApiCallsFromParams,
    calculateDeepthinkTokenEstimate,
    formatApiCallCount,
    type DeepthinkApiCallEstimate,
    type DeepthinkTokenEstimate,
} from '../../Routing/DeepthinkTokenEstimator';
import {
    MAX_MODULES_COUNT,
    MAX_STRATEGY_PROXIMITY_LOOPS,
    MAX_MODULES_IMPACT_REVIEW_LOOPS,
    BSR_WEIGHT_PRESETS,
    type BsrWeightPresetId,
} from '../../Routing/ModelConfig';
import { Icon } from '../../UI/Icons';
import { disableSidebarCollapseButton } from '../../UI/LayoutController';

type DeepthinkController = ReturnType<typeof getDeepthinkConfigController>;
type TokenGraphFocus = 'total' | 'input' | 'output';

const TOKEN_SERIES = [
    { key: 'input-worst', label: 'Input worst', category: 'input', valueOf: (p: DeepthinkTokenEstimate) => p.input.worst },
    { key: 'input-average', label: 'Input avg', category: 'input', valueOf: (p: DeepthinkTokenEstimate) => p.input.average },
    { key: 'output-worst', label: 'Output worst', category: 'output', valueOf: (p: DeepthinkTokenEstimate) => p.output.worst },
    { key: 'output-average', label: 'Output avg', category: 'output', valueOf: (p: DeepthinkTokenEstimate) => p.output.average },
] as const;

const TOKEN_CHART = { width: 800, height: 320, padding: { top: 20, right: 24, bottom: 44, left: 64 } } as const;

const classNames = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const toInteger = (value: string): number => Number.parseInt(value, 10);
const range = <T,>(length: number, mapper: (index: number) => T): T[] => Array.from({ length: Math.max(0, length) }, (_, i) => mapper(i));
const percentBetween = (value: number, min: number, max: number): number => max > min ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0;
const filledTrack = (pct: number, color: string): string => `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, var(--slider-track-color) ${pct}%, var(--slider-track-color) 100%)`;

const formatTokenCount = (value: number): string => {
    const safe = Math.max(0, Number.isFinite(value) ? value : 0);
    if (safe >= 1000000) {
        const m = safe / 1000000;
        return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
    }
    if (safe >= 1000) {
        const k = safe / 1000;
        return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}K`;
    }
    return String(Math.round(safe));
};

const formatTokenRange = (r: { average: number; worst: number }): string => `${formatTokenCount(r.average)} - ${formatTokenCount(r.worst)}`;
const pathForPoints = (pts: Array<{ x: number; y: number }>): string => pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

export const TokenVolumeGraph: React.FC<{
    strategiesCount: number;
    strategyProximityLoops?: number;
    modulesCount: number;
    modulesImpactReviewLoops?: number;
    i: number;
    j?: number;
    k?: number;
    isolateBranches: boolean;
    codeExecutionEnabled?: boolean;
}> = ({ strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, i, j, k, isolateBranches, codeExecutionEnabled }) => {
    const [focus, setFocus] = useState<TokenGraphFocus>('total');
    const [hoverDepth, setHoverDepth] = useState<number | null>(null);
    const safeDepth = Math.max(1, Math.round(i || 1));

    const trend = useMemo(() => buildDeepthinkTokenTrend({
        strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, j, k, isolateBranches, codeExecutionEnabled, maxDepth: safeDepth,
    }), [strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, j, k, isolateBranches, codeExecutionEnabled, safeDepth]);

    const selected = useMemo(() => calculateDeepthinkTokenEstimate({
        strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, deepthinkDepth: safeDepth, i: safeDepth, j, k, isolateBranches, codeExecutionEnabled,
    }), [strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, j, k, isolateBranches, codeExecutionEnabled, safeDepth]);

    const [chartSize, setChartSize] = useState<{ width: number; height: number }>({ width: TOKEN_CHART.width, height: TOKEN_CHART.height });
    const shellRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!shellRef.current) return;
        const observer = new ResizeObserver(entries => {
            if (entries[0]) {
                const { width, height } = entries[0].contentRect;
                if (width > 0 && height > 0) setChartSize({ width, height });
            }
        });
        observer.observe(shellRef.current);
        return () => observer.disconnect();
    }, []);

    const { width, height } = chartSize;
    const padding = TOKEN_CHART.padding;
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxDepth = Math.max(1, trend.at(-1)?.depth ?? selected.depth);
    const selectedDepth = clamp(selected.depth, 1, maxDepth);
    const xForDepth = (depth: number): number => maxDepth === 1 ? padding.left + plotWidth / 2 : padding.left + ((depth - 1) / (maxDepth - 1)) * plotWidth;
    const selectedX = xForDepth(selectedDepth);
    const visibleSeries = focus === 'total' ? TOKEN_SERIES : TOKEN_SERIES.filter(item => item.category === focus);
    const allValues = visibleSeries.flatMap(item => trend.map(point => item.valueOf(point))).filter(v => v > 0);
    const maxValue = Math.max(...allValues, 1) * 1.1;
    const minValue = Math.max(1, (allValues.length ? Math.max(1, Math.min(...allValues)) : 1) * 0.72);
    const logMin = Math.log10(minValue);
    const logMax = Math.log10(maxValue);
    const yForValue = (value: number): number => padding.top + plotHeight - ((Math.log10(Math.max(value, minValue)) - logMin) / (logMax - logMin || 1)) * plotHeight;
    const pathForSeries = (valueOf: (p: DeepthinkTokenEstimate) => number): string => pathForPoints(trend.map(p => ({ x: xForDepth(p.depth), y: yForValue(valueOf(p)) })));
    const areaPathForFocus = (category: 'input' | 'output'): string => {
        const high = category === 'input' ? (p: DeepthinkTokenEstimate) => p.input.worst : (p: DeepthinkTokenEstimate) => p.output.worst;
        const low = category === 'input' ? (p: DeepthinkTokenEstimate) => p.input.average : (p: DeepthinkTokenEstimate) => p.output.average;
        const upper = trend.map(p => ({ x: xForDepth(p.depth), y: yForValue(high(p)) }));
        const lower = [...trend].reverse().map(p => ({ x: xForDepth(p.depth), y: yForValue(low(p)) }));
        return `${pathForPoints(upper)} ${lower.map(p => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')} Z`;
    };
    const yTicks = range(5, idx => Math.pow(10, logMin + (logMax - logMin) * (idx / 4)));
    const xTicks = maxDepth <= 10 ? range(maxDepth, idx => idx + 1) : (() => {
        const step = Math.ceil(maxDepth / 10);
        const ticks = range(Math.floor(maxDepth / step) + 1, idx => idx * step + 1);
        if (ticks[ticks.length - 1] !== maxDepth) ticks.push(maxDepth);
        return ticks;
    })();

    const hovered = hoverDepth == null ? null : trend.find(p => p.depth === hoverDepth) ?? null;
    const hoveredX = hovered ? xForDepth(hovered.depth) : 0;
    const hoverValues = hovered ? visibleSeries.map(item => item.valueOf(hovered)) : [];
    const hoveredY = hovered && hoverValues.length ? yForValue(Math.max(...hoverValues)) : padding.top;
    const tooltipWidth = focus === 'total' ? 198 : 168;
    const tooltipHeight = 30 + visibleSeries.length * 17;
    const tooltipX = hovered ? clamp(hoveredX + 12, padding.left, width - padding.right - tooltipWidth) : 0;
    const tooltipY = hovered ? clamp(hoveredY - 12, padding.top + 4, padding.top + plotHeight - tooltipHeight - 4) : 0;

    return (
        <div className={`token-volume-estimator focus-${focus}`}>
            <div className="token-estimator-layout">
                <div className="token-chart-column">
                    <div className="token-chart-shell" ref={shellRef}>
                        <svg
                            className="token-chart-svg"
                            viewBox={`0 0 ${width} ${height}`}
                            role="img"
                            aria-label={`Estimated token volume through iteration ${selectedDepth}`}
                            onPointerMove={e => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                if (rect.width <= 0) return;
                                const svgX = ((e.clientX - rect.left) / rect.width) * width;
                                setHoverDepth(clamp(Math.round(maxDepth === 1 ? 1 : 1 + ((svgX - padding.left) / plotWidth) * (maxDepth - 1)), 1, maxDepth));
                            }}
                            onPointerLeave={() => setHoverDepth(null)}
                        >
                            <rect className="token-chart-backdrop" x="0" y="0" width={width} height={height} rx="8" />
                            {yTicks.map((tick, idx) => {
                                const y = yForValue(tick);
                                return (
                                    <g key={`y-${idx}`}>
                                        <line className="token-grid-line" x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                                        <text className="token-axis-label token-y-label" x={padding.left - 8} y={y + 4} textAnchor="end">{formatTokenCount(tick)}</text>
                                    </g>
                                );
                            })}
                            {xTicks.map(tick => {
                                const x = xForDepth(tick);
                                return (
                                    <g key={`x-${tick}`}>
                                        <line className="token-x-tick" x1={x} y1={padding.top + plotHeight} x2={x} y2={padding.top + plotHeight + 5} />
                                        <text className="token-axis-label" x={x} y={height - 12} textAnchor="middle">{tick}</text>
                                    </g>
                                );
                            })}
                            <text className="token-axis-caption" x={padding.left + plotWidth / 2} y={height - 2} textAnchor="middle">Iterations (i)</text>
                            <text className="token-axis-caption token-y-axis-caption" x={-(padding.top + plotHeight / 2)} y="14" textAnchor="middle" transform="rotate(-90)">Total tokens</text>
                            <line className="token-selected-depth-line" x1={selectedX} y1={padding.top} x2={selectedX} y2={padding.top + plotHeight} />
                            {focus !== 'total' && <path className={`token-area-fill ${focus}`} d={areaPathForFocus(focus)} />}
                            {visibleSeries.map(item => <path key={item.key} className={`token-series-line ${item.key}`} d={pathForSeries(item.valueOf)} />)}
                            {visibleSeries.map(item => <circle key={`${item.key}-point`} className={`token-selected-point ${item.key}`} cx={selectedX} cy={yForValue(item.valueOf(selected))} r="3.4" />)}
                            {hovered && (
                                <g className="token-hover-layer">
                                    <line className="token-hover-line" x1={hoveredX} y1={padding.top} x2={hoveredX} y2={padding.top + plotHeight} />
                                    {visibleSeries.map(item => <circle key={`${item.key}-hover`} className={`token-hover-point ${item.key}`} cx={hoveredX} cy={yForValue(item.valueOf(hovered))} r="4.2" />)}
                                    <rect className="token-hover-tooltip" x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="7" />
                                    <text className="token-hover-title" x={tooltipX + 10} y={tooltipY + 18}>Iteration {hovered.depth}</text>
                                    {visibleSeries.map((item, idx) => (
                                        <text key={`${item.key}-hover-label`} className={`token-hover-label ${item.key}`} x={tooltipX + 10} y={tooltipY + 38 + idx * 17}>
                                            {item.label}: {formatTokenCount(item.valueOf(hovered))}
                                        </text>
                                    ))}
                                </g>
                            )}
                        </svg>
                    </div>
                    <div className="token-chart-legend">
                        {visibleSeries.map(item => (
                            <span key={item.key} className="token-legend-item">
                                <span className={`token-legend-swatch ${item.key}`} />
                                {item.label}
                            </span>
                        ))}
                    </div>
                </div>
                <div className="token-summary-column">
                    {(['input', 'output', 'total'] as const).map(item => (
                        <button
                            key={item}
                            type="button"
                            className={classNames('token-summary-item filterable', item, focus === item && 'active')}
                            aria-pressed={focus === item}
                            onClick={() => {
                                setFocus(cur => cur === item && item !== 'total' ? 'total' : item);
                                setHoverDepth(null);
                            }}
                        >
                            <span className="token-summary-label">{item[0].toUpperCase() + item.slice(1)}</span>
                            <span className="token-summary-value">{formatTokenRange(selected[item])}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

export const TotalLLMCallsTokenEstimationModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const controller = getDeepthinkConfigController();
    const [configState, setConfigState] = useState(() => controller.getState());

    useEffect(() => {
        const update = () => setConfigState(controller.getState());
        controller.addEventListener('configchange', update);
        window.addEventListener('sandboxToggled', update);
        window.addEventListener('selectedModelChanged', update);
        return () => {
            controller.removeEventListener('configchange', update);
            window.removeEventListener('sandboxToggled', update);
            window.removeEventListener('selectedModelChanged', update);
        };
    }, [controller]);

    const apiCallsEstimate: DeepthinkApiCallEstimate = useMemo(() => calculateDeepthinkApiCallsFromParams({
        strategiesCount: configState.strategiesCount,
        strategyProximityLoops: configState.strategyProximityLoops,
        modulesCount: configState.modulesEnabled ? configState.modulesCount : 0,
        modulesImpactReviewLoops: configState.modulesImpactReviewLoops,
        i: configState.i,
        j: configState.j,
        k: configState.k,
        isolateBranches: configState.isolateBranches,
    }), [configState]);

    const formattedMin = formatApiCallCount(apiCallsEstimate.min);
    const formattedMax = formatApiCallCount(apiCallsEstimate.max);
    const displayApiCalls = apiCallsEstimate.min === apiCallsEstimate.max ? `~${formattedMin}` : `~${formattedMin} to ${formattedMax}`;
    const safeDepth = Math.max(1, Math.round(configState.i || 1));

    const tokenSummary = useMemo(() => calculateDeepthinkTokenEstimate({
        strategiesCount: configState.strategiesCount,
        strategyProximityLoops: configState.strategyProximityLoops,
        modulesCount: configState.modulesEnabled ? configState.modulesCount : 0,
        modulesImpactReviewLoops: configState.modulesImpactReviewLoops,
        deepthinkDepth: safeDepth,
        i: safeDepth,
        j: configState.j,
        k: configState.k,
        isolateBranches: configState.isolateBranches,
        codeExecutionEnabled: configState.codeExecutionEnabled,
    }), [configState, safeDepth]);

    const statCardClass = `estimation-stat-card ${configState.codeExecutionEnabled ? 'sandbox-stat' : ''}`;

    return createPortal(
        <BaseModal title="Total LLM Calls & Token Estimation" className="fullscreen-modal token-estimation-fullscreen-modal" onClose={onClose}>
            <div className="deepthink-config-react-root" style={{ width: '100%', height: '100%', zoom: 1, display: 'flex', flexDirection: 'column' }}>
                <div className="token-estimation-modal-content custom-scrollbar">
                    <div className="token-estimation-overview-grid">
                        <div className={statCardClass}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-purple"><Icon name="psychology" /></span>
                                <span className="stat-card-title">Total LLM Calls</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value" id="api-call-count">{displayApiCalls}</span>
                                <span className="stat-card-unit">Calls</span>
                            </div>
                            <div className="stat-card-footnote"><span>Based on current configuration</span></div>
                        </div>
                        <div className={statCardClass}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-blue"><Icon name="data_usage" /></span>
                                <span className="stat-card-title">Estimated Total Tokens</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value">{formatTokenRange(tokenSummary.total)}</span>
                                <span className="stat-card-unit">Tokens</span>
                            </div>
                            <div className="stat-card-footnote">
                                <span>Input: {formatTokenRange(tokenSummary.input)} • Output: {formatTokenRange(tokenSummary.output)}</span>
                            </div>
                        </div>
                        <div className={statCardClass}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-red"><Icon name="terminal" /></span>
                                <span className="stat-card-title">Sandbox Multiplier</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value">{configState.codeExecutionEnabled ? '12x–36x' : '1x'}</span>
                                <span className="stat-card-unit">Overhead</span>
                            </div>
                            <div className="stat-card-footnote">
                                {configState.codeExecutionEnabled
                                    ? <span className="sandbox-active">Code execution significantly multiplies usage</span>
                                    : <span>Code execution is disabled</span>}
                            </div>
                        </div>
                    </div>
                    <div className="deepthink-options-container token-usage-graph-card">
                        <div className="window-header">
                            <div className="window-left dt-title-green">
                                <Icon name="sync" />
                                <div className="window-title">Approximate Token Usage</div>
                            </div>
                        </div>
                        <div className="window-content deepthink-window-content">
                            <TokenVolumeGraph
                                strategiesCount={configState.strategiesCount}
                                strategyProximityLoops={configState.strategyProximityLoops}
                                modulesCount={configState.modulesEnabled ? configState.modulesCount : 0}
                                modulesImpactReviewLoops={configState.modulesImpactReviewLoops}
                                i={configState.i}
                                j={configState.j}
                                k={configState.k}
                                isolateBranches={configState.isolateBranches}
                                codeExecutionEnabled={configState.codeExecutionEnabled}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </BaseModal>,
        document.body
    );
};

interface DeepthinkConfigPanelProps {
    strategiesCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    modulesEnabled: boolean;
    i: number;
    j: number;
    k: number;
    isolateBranches: boolean;
    codeExecutionEnabled: boolean;
    bsrNoiseLevel: number;
    bsrPressureFloor: number;
    bsrWeightSmall: number;
    bsrWeightMedium: number;
    bsrWeightLarge: number;
    bsrWeightPreset: BsrWeightPresetId;
    onStrategiesChange: (count: number) => void;
    onStrategyProximityLoopsChange: (count: number) => void;
    onModulesChange: (count: number) => void;
    onModulesImpactReviewLoopsChange: (count: number) => void;
    onModulesToggle: (enabled: boolean) => void;
    onIChange: (i: number) => void;
    onJChange: (j: number) => void;
    onKChange: (k: number) => void;
    onIsolateBranchesToggle: (enabled: boolean) => void;
    onCodeExecutionToggle: (enabled: boolean) => void;
    onBsrNoiseLevelChange: (val: number) => void;
    onBsrPressureFloorChange: (val: number) => void;
    onBsrWeightPresetChange: (presetId: BsrWeightPresetId) => void;
}

const SectionFrame: React.FC<{ containerClass: string; headerClass: string; icon: string; title: string; children: React.ReactNode }> = ({ containerClass, headerClass, icon, title, children }) => (
    <div className={containerClass}>
        <div className={classNames('section-header', headerClass)}>
            <div className="section-title-wrapper">
                <Icon name={icon} />
                <span className="section-title">{title}</span>
            </div>
        </div>
        <div className="section-body">{children}</div>
    </div>
);

let hasShownConfigWarning = false;
let isConfigWarningModalOpen = false;
let notifyConfigWarningListeners: (() => void) | null = null;

function requestConfigWarning(): void {
    if (hasShownConfigWarning) return;
    hasShownConfigWarning = true;
    isConfigWarningModalOpen = true;
    notifyConfigWarningListeners?.();
}

function dismissConfigWarning(): void {
    isConfigWarningModalOpen = false;
    notifyConfigWarningListeners?.();
}

const SliderWithFill: React.FC<{ id: string; value: number; min: number; max: number; color: string; disabled?: boolean; onChange: (value: number) => void }> = ({ id, value, min, max, color, disabled, onChange }) => {
    const safeValue = clamp(value, min, max);
    return (
        <input
            type="range"
            id={id}
            className="slider"
            min={min}
            max={max}
            step={1}
            value={safeValue}
            disabled={disabled}
            style={{ background: filledTrack(percentBetween(safeValue, min, max), color) }}
            onPointerDown={() => { if (!disabled) requestConfigWarning(); }}
            onChange={e => { requestConfigWarning(); onChange(toInteger(e.currentTarget.value)); }}
        />
    );
};

const VerticalBar: React.FC<{ id?: string; value: number; min: number; max: number; color: string; disabled?: boolean; onChange: (val: number) => void }> = ({ id, value, min, max, color, disabled, onChange }) => {
    const safeValue = clamp(value, min, max);
    return (
        <div className="vertical-bar-container">
            <input
                type="range"
                id={id}
                className="vertical-bar-input"
                {...{ orient: 'vertical' } as any}
                min={min}
                max={max}
                step={1}
                value={safeValue}
                disabled={disabled}
                onPointerDown={() => { if (!disabled) requestConfigWarning(); }}
                onChange={e => { requestConfigWarning(); onChange(toInteger(e.currentTarget.value)); }}
            />
            <div className="vertical-bar-visual-track">
                <div className="vertical-bar-visual-fill" style={{ height: `${percentBetween(safeValue, min, max)}%`, backgroundColor: color }} />
            </div>
        </div>
    );
};

const ToggleSwitch: React.FC<{ id: string; checked: boolean; onChange: (checked: boolean) => void; className?: string; inputClassName?: string; sliderClassName?: string; disabled?: boolean }> = ({
    id, checked, onChange, className = 'toggle-switch', inputClassName = 'toggle-input', sliderClassName = 'toggle-slider', disabled,
}) => (
    <label className={className}>
        <input type="checkbox" id={id} className={inputClassName} checked={checked} disabled={disabled} onChange={e => onChange(e.currentTarget.checked)} />
        <span className={sliderClassName} />
    </label>
);

const LoopScheduleSection: React.FC<{
    i: number; j: number; k: number; curatedContextEnabled: boolean;
    onIChange: (i: number) => void; onJChange: (j: number) => void; onKChange: (k: number) => void;
}> = ({ i, j, k, curatedContextEnabled, onIChange, onJChange, onKChange }) => {
    const errorI = i < 5 || i > 20 ? 'Total iterations (i) must be between 5 and 20.' : null;
    const errorJ = j < 3 || j > 8 ? 'Global update interval (j) must be between 3 and 8.' : null;
    const maxK = Math.max(2, Math.min(8, j));
    const effectiveK = Math.min(k, maxK);
    const errorK = curatedContextEnabled && (k < 2 || k > j) ? `Heartbeat interval (k) must be between 2 and j (${j}).` : null;

    const updatePoints: number[] = [];
    for (let it = j; it < i; it += j) updatePoints.push(it);

    const heartbeatPoints: number[] = [];
    if (curatedContextEnabled && k >= 2) {
        for (let it = 1; it < i; it++) {
            if (updatePoints.includes(it)) continue;
            const nextBarrier = updatePoints.find(p => p > it) ?? i;
            const prevBarrier = [...updatePoints].reverse().find(p => p < it) ?? 0;
            const cycleOffset = it - prevBarrier;
            if (cycleOffset > 0 && cycleOffset % k === 0 && nextBarrier - it >= 2) {
                heartbeatPoints.push(it);
            }
        }
    }

    return (
        <SectionFrame containerClass="evolution-filter-options-container" headerClass="evolution-filter-options-header dt-title-red" icon="event_repeat" title="Loop Schedule & Global Updates">
            <div className="loop-schedule-vis" style={{ marginTop: '2px', marginBottom: '24px' }}>
                <div className="loop-timeline-overview">
                    <div className="loop-timeline-bar">
                        {Array.from({ length: Math.min(20, Math.max(5, i)) }, (_, idx) => {
                            const itNum = idx + 1;
                            const isUpdate = updatePoints.includes(itNum);
                            const isFinal = itNum === i;
                            const isHeartbeat = heartbeatPoints.includes(itNum);
                            const hasHeartbeatAtUpdate = isUpdate && curatedContextEnabled;
                            return (
                                <div
                                    key={itNum}
                                    className={classNames('timeline-step', isUpdate && 'update-step', hasHeartbeatAtUpdate && 'with-heartbeat', isFinal && 'final-step', isHeartbeat && 'heartbeat-step')}
                                    title={`Iteration ${itNum}${isUpdate ? `: Global Update + BSR${hasHeartbeatAtUpdate ? ' (Curated Heartbeat synchronized)' : ''}` : isFinal ? ': Final Iteration (Corrections Only)' : isHeartbeat ? `: Curated Context Heartbeat (k=${k})` : ''}`}
                                >
                                    <span className="step-num">{itNum}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="loop-controls-inputs">
                <div className={classNames('slider-pair-row', curatedContextEnabled && 'slider-triple-row')}>
                    <div className="input-group-tight">
                        <label htmlFor="dt-i-slider" className="input-label">Total Iterations (i): <span id="dt-i-value">{i}</span></label>
                        <SliderWithFill id="dt-i-slider" value={i} min={5} max={20} color="var(--accent-pink)" onChange={onIChange} />
                        {errorI && <div className="config-error-text">{errorI}</div>}
                    </div>
                    <div className="input-group-tight">
                        <label htmlFor="dt-j-slider" className="input-label">Global Update Interval (j): <span id="dt-j-value">{j}</span></label>
                        <SliderWithFill id="dt-j-slider" value={j} min={3} max={8} color="var(--accent-pink)" onChange={onJChange} />
                        {errorJ && <div className="config-error-text">{errorJ}</div>}
                    </div>
                    {curatedContextEnabled && (
                        <div className="input-group-tight">
                            <label htmlFor="dt-k-slider" className="input-label">Heartbeat Interval (k): <span id="dt-k-value">{effectiveK}</span> iterations</label>
                            <SliderWithFill id="dt-k-slider" value={effectiveK} min={2} max={maxK} color="var(--accent-pink)" onChange={onKChange} />
                            {errorK && <div className="config-error-text">{errorK}</div>}
                        </div>
                    )}
                </div>
            </div>
        </SectionFrame>
    );
};

const Figure4Visualization: React.FC<{ modulesEnabled: boolean }> = ({ modulesEnabled }) => {
    const B = (k: 'g' | 't' | 'c' | 'p', x: number, y: number, w: number, h: number, a: string, b?: string, m?: boolean) => {
        const cx = x + w / 2, cy = y + h / 2;
        return (
            <g className={`vis-box vis-theme-${k}`} key={`box-${x}-${y}`}>
                <rect x={x} y={y} width={w} height={h} rx={8} />
                <text className={m ? 'ts m' : 'th'} x={cx} y={b ? cy - 12 : cy} textAnchor="middle" dominantBaseline="central">{a}</text>
                {b && <text className="ts" x={cx} y={cy + 12} textAnchor="middle" dominantBaseline="central">{b}</text>}
            </g>
        );
    };
    const P = (d: string, k = 0) => (
        <path key={`path-${d}`} d={d} className="vis-path" strokeDasharray={k & 1 ? '4 4' : undefined} markerStart={k & 2 ? 'url(#arrow)' : undefined} markerEnd={k & 4 ? undefined : 'url(#arrow)'} />
    );

    return (
        <div className="figure4-container">
            <svg viewBox="22 38 626 438" preserveAspectRatio="xMidYMid meet" className="figure4-visualization" role="img" aria-label="Modules generator architecture">
                <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M2 1L8 5L2 9" className="vis-arrow-path" />
                    </marker>
                </defs>
                <g className={!modulesEnabled ? 'vis-dimmed' : ''}>
                    {B('t', 28, 46, 136, 84, 'Critique Synthesis')}
                    {B('t', 188, 46, 164, 84, 'Modules Generator', 'with impact review')}
                    {B('t', 376, 46, 132, 84, 'Independent', 'Modules testing')}
                    {B('g', 532, 46, 110, 84, 'Map', 'to branches')}
                    {P('M164 88H186')}
                    {P('M352 88H374')}
                    {P('M508 88H530')}
                    {P('M260 130V384', 1)}
                    {P('M280 384V132', 1)}
                    {B('p', 120, 386, 440, 82, 'Back & forth impact review history saved', 'and added back to the next modules generation')}
                    {P('M587 130V258H484')}
                    {B('g', 298, 216, 184, 84, 'Branch context', 'mapped packet')}
                    {B('g', 36, 216, 206, 84, 'Next correction agents', 'read the branch context')}
                    {P('M298 258H244')}
                </g>
            </svg>
        </div>
    );
};

const CuratedContextSection: React.FC<{
    modulesEnabled: boolean; modulesCount: number; modulesImpactReviewLoops: number;
    onModulesToggle: (enabled: boolean) => void; onModulesChange: (count: number) => void; onModulesImpactReviewLoopsChange: (count: number) => void;
}> = ({ modulesEnabled, modulesCount, modulesImpactReviewLoops, onModulesToggle, onModulesChange, onModulesImpactReviewLoopsChange }) => (
    <div className="information-packet-window" id="dt-information-packet-window">
        <div className="window-header">
            <div className="window-left dt-title-blue">
                <Icon name="refresh" />
                <div className="window-title">Customize Curated Context</div>
            </div>
        </div>
        <div className="window-content" id="dt-information-packet-content">
            <div className={classNames('curated-subfeature-card', !modulesEnabled && 'collapsed')}>
                <div className="curated-subfeature-header">
                    <label htmlFor="dt-modules-toggle" className="curated-toggle-label">Modules Generation & Independent Testing</label>
                    <ToggleSwitch
                        id="dt-modules-toggle"
                        checked={modulesEnabled}
                        onChange={enabled => { onModulesToggle(enabled); if (!enabled) onModulesChange(0); }}
                    />
                </div>
                {modulesEnabled && (
                    <div className="curated-subfeature-body">
                        <div className="modules-controls">
                            <div className="slider-pair-row proximity-pair">
                                <div className="input-group-tight">
                                    <label htmlFor="dt-modules-slider" className="input-label">Modules Count: <span id="dt-modules-value">{modulesCount}</span></label>
                                    <SliderWithFill id="dt-modules-slider" value={modulesCount > 0 ? modulesCount : 1} min={1} max={MAX_MODULES_COUNT} color="var(--accent-blue)" onChange={onModulesChange} />
                                </div>
                                <div className="input-group-tight">
                                    <label htmlFor="dt-modules-impact-review-slider" className="input-label">Impact review loops: <span id="dt-modules-impact-review-value">{modulesImpactReviewLoops}</span></label>
                                    <SliderWithFill id="dt-modules-impact-review-slider" value={modulesImpactReviewLoops} min={1} max={MAX_MODULES_IMPACT_REVIEW_LOOPS} color="var(--accent-blue)" onChange={onModulesImpactReviewLoopsChange} />
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <Figure4Visualization modulesEnabled={modulesEnabled} />
        </div>
    </div>
);

const BsrParametersSection: React.FC<{
    bsrNoiseLevel: number; bsrPressureFloor: number; bsrWeightPreset: BsrWeightPresetId;
    onBsrNoiseLevelChange: (val: number) => void; onBsrPressureFloorChange: (val: number) => void; onBsrWeightPresetChange: (presetId: BsrWeightPresetId) => void;
}> = props => {
    const activePreset = BSR_WEIGHT_PRESETS.find(p => p.id === props.bsrWeightPreset) || BSR_WEIGHT_PRESETS[0];
    const getNoiseDescription = (tau: number) => (
        tau === 1 ? 'Twitchy & sensitive (τ = 1): A single minor typo fix counts as progress; risks keeping dead branches alive on technicalities.' :
        tau === 2 ? 'Balanced default (τ = 2): Requires 1 medium event (or 2 small) of net movement to prove the branch is moving.' :
        tau === 3 ? 'Skeptical (τ = 3): Requires 1 large breakthrough or multiple medium wins to establish a trend.' :
        'Strict & skeptical (τ = 4): Demands continuous breakthroughs; classifies slow exploration windows as stalls.'
    );
    const getPressureDescription = (theta: number) => (
        theta <= 0.15 ? `Ruthless & aggressive (θ = ${theta.toFixed(2)}): At the first mathematical hint of slowing down, aggressively wipes or rewrites branches.` :
        theta < 0.28 ? `Active & decisive (θ = ${theta.toFixed(2)}): Swiftly prunes or evolves drifting branches without burning extra cycles.` :
        theta <= 0.35 ? `Balanced default (θ = ${theta.toFixed(2)}): Standard trigger floor. Pressures below this are ignored (CONTINUE).` :
        theta <= 0.48 ? `Patient & cautious (θ = ${theta.toFixed(2)}): Gives slowing branches extra time; requires higher stall/regression evidence.` :
        `Highly conservative (θ = ${theta.toFixed(2)}): Demands overwhelming evidence of failure before PRUNE or EVOLVE (burns much more compute).`
    );

    return (
        <div className="information-packet-window bsr-parameters-window" id="dt-bsr-parameters-container">
            <div className="window-header">
                <div className="window-left dt-title-red">
                    <Icon name="sliders" />
                    <div className="window-title">BSR Parameters (steer the branch decision taken during global update)</div>
                </div>
            </div>
            <div className="window-content bsr-window-content">
                <div className="bsr-vertical-bars-row">
                    <div className="bsr-vertical-bar-col">
                        <div className="bsr-bar-layout">
                            <label htmlFor="dt-bsr-noise-slider" className="input-label bsr-side-label">
                                Noise (τ): <span id="dt-bsr-noise-value" className="bsr-value-highlight">{props.bsrNoiseLevel}</span>
                            </label>
                            <VerticalBar id="dt-bsr-noise-slider" value={props.bsrNoiseLevel} min={1} max={4} color="var(--accent-red, #ff5f56)" onChange={props.onBsrNoiseLevelChange} />
                        </div>
                        <div className="bsr-change-description" id="dt-bsr-noise-desc">{getNoiseDescription(props.bsrNoiseLevel)}</div>
                    </div>
                    <div className="bsr-vertical-bar-col">
                        <div className="bsr-bar-layout">
                            <label htmlFor="dt-bsr-pressure-slider" className="input-label bsr-side-label">
                                Pressure (θ): <span id="dt-bsr-pressure-value" className="bsr-value-highlight">{props.bsrPressureFloor.toFixed(2)}</span>
                            </label>
                            <VerticalBar id="dt-bsr-pressure-slider" value={Math.round(props.bsrPressureFloor * 100)} min={10} max={60} color="var(--accent-red, #ff5f56)" onChange={val => props.onBsrPressureFloorChange(val / 100)} />
                        </div>
                        <div className="bsr-change-description" id="dt-bsr-pressure-desc">{getPressureDescription(props.bsrPressureFloor)}</div>
                    </div>
                </div>
                <div className="bsr-presets-integrated" style={{ marginTop: '16px' }}>
                    <div style={{ fontSize: '0.96rem', fontWeight: 600, marginBottom: '12px', color: 'var(--foreground-primary)' }}>
                        Event Size Weights Presets (w):
                    </div>
                    <div className="bsr-preset-grid" id="dt-bsr-presets-grid">
                        {BSR_WEIGHT_PRESETS.map(preset => (
                            <button
                                key={preset.id}
                                type="button"
                                className={`bsr-preset-card ${props.bsrWeightPreset === preset.id ? 'active' : ''}`}
                                onClick={() => props.onBsrWeightPresetChange(preset.id)}
                                title={preset.shortDescription}
                            >
                                <div className="bsr-preset-top">
                                    <span className="bsr-preset-name">{preset.label}</span>
                                    <span className="bsr-preset-ratio">{preset.ratio}</span>
                                </div>
                                <span className="bsr-preset-subtitle">{preset.tag}</span>
                            </button>
                        ))}
                    </div>
                    <div className="bsr-change-description bsr-preset-description" id="dt-bsr-preset-desc" style={{ marginTop: '10px' }}>
                        <strong>{activePreset.label} ({activePreset.ratio}):</strong> {activePreset.detailedDescription}
                    </div>
                </div>
            </div>
        </div>
    );
};

const CONFIG_WARNING_TEXT =
    'The current default configuration is optimal for most of the situations and is finalized after doing a lot of experiments. Change the configuration only if you know exactly what you are doing and how it will impact the overall state, and, the costs. This is a very sensitive configuration (doesnt matter whether you are using it with local models or with the frontier models). Small tweaks can waste your money significantly.';

const ConfigSensitivityWarningModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const openedAtRef = useRef(Date.now());
    const pointerDownOnBackdropRef = useRef(false);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return createPortal(
        <div
            className="dt-config-warning-overlay"
            onPointerDown={e => { pointerDownOnBackdropRef.current = e.target === e.currentTarget && Date.now() - openedAtRef.current > 200; }}
            onClick={e => {
                if (pointerDownOnBackdropRef.current && e.target === e.currentTarget) {
                    pointerDownOnBackdropRef.current = false;
                    onClose();
                }
            }}
        >
            <div className="dt-config-warning-popup" role="alertdialog" aria-modal="true" aria-describedby="dt-config-warning-message">
                <button type="button" className="dt-config-warning-close" onClick={onClose} aria-label="Close">
                    <Icon name="close" size={16} />
                </button>
                <div className="dt-config-warning-icon-circle"><Icon name="circle_alert" size={24} /></div>
                <p id="dt-config-warning-message" className="dt-config-warning-text">{CONFIG_WARNING_TEXT}</p>
            </div>
        </div>,
        document.body
    );
};

const DeepthinkConfigPanelComponent: React.FC<DeepthinkConfigPanelProps> = props => {
    const [isEstimationModalOpen, setIsEstimationModalOpen] = useState(false);
    const [isConfigWarningOpen, setIsConfigWarningOpen] = useState(isConfigWarningModalOpen);
    const safeDepth = Math.max(1, Math.round(props.i || 1));

    useEffect(() => {
        const syncWarningModal = () => setIsConfigWarningOpen(isConfigWarningModalOpen);
        notifyConfigWarningListeners = syncWarningModal;
        return () => { if (notifyConfigWarningListeners === syncWarningModal) notifyConfigWarningListeners = null; };
    }, []);

    const withConfigWarning = <T extends (...args: any[]) => void>(handler: T): T => (
        ((...args: Parameters<T>) => { requestConfigWarning(); handler(...args); }) as T
    );

    const tokenSummary = useMemo(() => calculateDeepthinkTokenEstimate({
        strategiesCount: props.strategiesCount,
        strategyProximityLoops: props.strategyProximityLoops,
        modulesCount: props.modulesEnabled ? props.modulesCount : 0,
        modulesImpactReviewLoops: props.modulesImpactReviewLoops,
        deepthinkDepth: safeDepth,
        i: safeDepth,
        j: props.j,
        k: props.k,
        isolateBranches: props.isolateBranches,
        codeExecutionEnabled: props.codeExecutionEnabled,
    }), [props.strategiesCount, props.strategyProximityLoops, props.modulesEnabled, props.modulesCount, props.modulesImpactReviewLoops, safeDepth, props.j, props.k, props.isolateBranches, props.codeExecutionEnabled]);

    return (
        <div className="deepthink-config-panel">
            <div className="deepthink-config-scroll-container">
                <div className="config-top-row">
                    <div className="strategy-execution-container">
                        <div className="strategy-execution-card">
                            <div className="strategy-execution-section">
                                <div className="slider-pair-row proximity-pair">
                                    <div className="input-group-tight">
                                        <label htmlFor="dt-strategies-slider" className="input-label">Strategies: <span id="dt-strategies-value">{props.strategiesCount}</span></label>
                                        <SliderWithFill id="dt-strategies-slider" value={props.strategiesCount} min={1} max={5} color="var(--accent-purple)" onChange={withConfigWarning(props.onStrategiesChange)} />
                                    </div>
                                    <div className="input-group-tight">
                                        <label htmlFor="dt-strategy-proximity-slider" className="input-label">Proximity loops: <span id="dt-strategy-proximity-value">{props.strategyProximityLoops}</span></label>
                                        <SliderWithFill id="dt-strategy-proximity-slider" value={props.strategyProximityLoops} min={1} max={MAX_STRATEGY_PROXIMITY_LOOPS} color="var(--accent-purple)" onChange={withConfigWarning(props.onStrategyProximityLoopsChange)} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="code-execution-toggle-container" id="dt-code-execution-container">
                        <ToggleSwitch id="dt-code-execution-toggle" checked={props.codeExecutionEnabled} onChange={props.onCodeExecutionToggle} />
                        <div className="code-execution-toggle-info">
                            <span className="code-execution-toggle-title">Sandbox Terminal Environment</span>
                            <span className="code-execution-toggle-subtitle">Persistent secure workspace for every Deepthink agent</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        id="total-llm-calls-token-estimation-button"
                        className={`code-execution-toggle-container total-llm-calls-toggle-btn ${props.codeExecutionEnabled ? 'sandbox-enabled' : ''}`}
                        onClick={() => setIsEstimationModalOpen(true)}
                        title="Total LLM Calls & Token Estimation"
                        aria-label="Total LLM Calls & Token Estimation"
                    >
                        <span className="total-llm-calls-icon-wrapper"><Icon name="chart-no-axes-combined" /></span>
                        <div className="code-execution-toggle-info">
                            <span className="code-execution-toggle-title">Total LLM Calls &amp; Token Estimation</span>
                            <span className="code-execution-toggle-subtitle">{`${formatTokenRange(tokenSummary.total)} Tokens`}</span>
                        </div>
                    </button>
                </div>
                <div className="config-middle-row" style={{ marginBottom: '1rem' }}>
                    <LoopScheduleSection
                        i={props.i} j={props.j} k={props.k} curatedContextEnabled={props.modulesEnabled}
                        onIChange={withConfigWarning(props.onIChange)} onJChange={withConfigWarning(props.onJChange)} onKChange={withConfigWarning(props.onKChange)}
                    />
                </div>
                <div className="config-bottom-grid">
                    <div className="config-left-col">
                        <CuratedContextSection
                            modulesEnabled={props.modulesEnabled} modulesCount={props.modulesCount} modulesImpactReviewLoops={props.modulesImpactReviewLoops}
                            onModulesToggle={withConfigWarning(props.onModulesToggle)} onModulesChange={withConfigWarning(props.onModulesChange)} onModulesImpactReviewLoopsChange={withConfigWarning(props.onModulesImpactReviewLoopsChange)}
                        />
                        <div className="curated-subfeature-card">
                            <div className="curated-subfeature-header">
                                <label htmlFor="dt-isolate-branches-toggle" className="curated-toggle-label">
                                    Isolate Branches
                                    {props.codeExecutionEnabled && <span className="disabled-label">(Auto-enabled with Sandbox)</span>}
                                </label>
                                <ToggleSwitch id="dt-isolate-branches-toggle" checked={props.codeExecutionEnabled || props.isolateBranches} disabled={props.codeExecutionEnabled} onChange={props.onIsolateBranchesToggle} />
                            </div>
                        </div>
                    </div>
                    <div className="config-right-col">
                        <BsrParametersSection
                            bsrNoiseLevel={props.bsrNoiseLevel} bsrPressureFloor={props.bsrPressureFloor} bsrWeightPreset={props.bsrWeightPreset}
                            onBsrNoiseLevelChange={withConfigWarning(props.onBsrNoiseLevelChange)} onBsrPressureFloorChange={withConfigWarning(props.onBsrPressureFloorChange)} onBsrWeightPresetChange={withConfigWarning(props.onBsrWeightPresetChange)}
                        />
                    </div>
                </div>
            </div>
            {isEstimationModalOpen && <TotalLLMCallsTokenEstimationModal onClose={() => setIsEstimationModalOpen(false)} />}
            {isConfigWarningOpen && <ConfigSensitivityWarningModal onClose={dismissConfigWarning} />}
        </div>
    );
};

function deriveProps(controller: DeepthinkController): DeepthinkConfigPanelProps {
    const state = controller.getState();
    return {
        ...state,
        i: state.i ?? 10,
        j: state.j ?? 4,
        k: state.k ?? 4,
        onStrategiesChange: value => controller.setStrategiesCount(value),
        onStrategyProximityLoopsChange: value => controller.setStrategyProximityLoops(value),
        onModulesChange: value => controller.setModulesCount(value),
        onModulesImpactReviewLoopsChange: value => controller.setModulesImpactReviewLoops(value),
        onModulesToggle: value => controller.setModulesEnabled(value),
        onIChange: value => controller.setI(Math.max(5, Math.min(20, Math.round(value)))),
        onJChange: value => {
            const clampedJ = Math.max(3, Math.min(8, Math.round(value)));
            controller.setJ(clampedJ);
            if (controller.getK() > clampedJ) controller.setK(clampedJ);
        },
        onKChange: value => {
            const maxK = Math.max(2, Math.min(8, controller.getJ()));
            controller.setK(Math.max(2, Math.min(maxK, Math.round(value))));
        },
        onIsolateBranchesToggle: value => controller.setIsolateBranchesEnabled(value),
        onCodeExecutionToggle: value => controller.setCodeExecutionEnabled(value),
        onBsrNoiseLevelChange: value => controller.setBsrNoiseLevel(value),
        onBsrPressureFloorChange: value => controller.setBsrPressureFloor(value),
        onBsrWeightPresetChange: presetId => controller.setBsrWeightPreset(presetId),
    };
}

let configPanelRoot: Root | null = null;
let configPanelContainerNode: HTMLElement | null = null;
let unsubscribeControllerEvents: (() => void) | null = null;

function disposeRoot(): void {
    if (!configPanelRoot) return;
    const rootToUnmount = configPanelRoot;
    configPanelRoot = null;
    configPanelContainerNode = null;
    queueMicrotask(() => rootToUnmount.unmount());
}

export function renderDeepthinkConfigPanelInContainer(pipelinesContentContainer: HTMLElement): void {
    if (!pipelinesContentContainer) return;
    const controller = getDeepthinkConfigController();
    const mainHeaderContent = document.querySelector<HTMLElement>('.main-header-content');
    if (mainHeaderContent) mainHeaderContent.style.display = 'none';
    disableSidebarCollapseButton('Sidebar collapse disabled in config view');

    if (configPanelRoot && configPanelContainerNode && (!document.contains(configPanelContainerNode) || configPanelContainerNode.parentElement !== pipelinesContentContainer)) {
        disposeRoot();
    }
    if (!configPanelRoot) {
        pipelinesContentContainer.innerHTML = '';
        configPanelContainerNode = document.createElement('div');
        configPanelContainerNode.className = 'deepthink-config-react-root';
        pipelinesContentContainer.appendChild(configPanelContainerNode);
        configPanelRoot = createRoot(configPanelContainerNode);
    }

    const render = () => configPanelRoot?.render(<DeepthinkConfigPanelComponent {...deriveProps(controller)} />);
    render();

    unsubscribeControllerEvents?.();
    const unsubscribe = () => {
        controller.removeEventListener('configchange', render);
        window.removeEventListener('selectedModelChanged', render);
        if (unsubscribeControllerEvents === unsubscribe) unsubscribeControllerEvents = null;
    };
    controller.addEventListener('configchange', render);
    window.addEventListener('selectedModelChanged', render);
    unsubscribeControllerEvents = unsubscribe;
}
