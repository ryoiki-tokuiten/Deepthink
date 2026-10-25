/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BaseModal } from './Deepthink.tsx';
import { getDeepthinkConfigController } from '../../Routing';
import {
    calculateDeepthinkApiCallsFromParams,
    formatApiCallCount,
    type DeepthinkApiCallEstimate,
} from '../../Routing/ApiCallEstimator';
import {
    buildDeepthinkTokenTrend,
    calculateDeepthinkTokenEstimate,
    type DeepthinkTokenEstimate,
} from '../../Routing/DeepthinkTokenEstimator';
import { Icon } from '../../UI/Icons';
import '../styles/DeepthinkConfigPanel.css';

type TokenGraphFocus = 'total' | 'input' | 'output';

const TOKEN_SERIES = [
    { key: 'input-worst', label: 'Input worst', category: 'input', valueOf: (point: DeepthinkTokenEstimate) => point.input.worst },
    { key: 'input-average', label: 'Input avg', category: 'input', valueOf: (point: DeepthinkTokenEstimate) => point.input.average },
    { key: 'output-worst', label: 'Output worst', category: 'output', valueOf: (point: DeepthinkTokenEstimate) => point.output.worst },
    { key: 'output-average', label: 'Output avg', category: 'output', valueOf: (point: DeepthinkTokenEstimate) => point.output.average },
] as const;

const TOKEN_CHART = {
    width: 800,
    height: 320,
    padding: { top: 20, right: 24, bottom: 44, left: 64 },
} as const;

const classNames = (...parts: Array<string | false | null | undefined>): string => (
    parts.filter(Boolean).join(' ')
);

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
);

const range = <T,>(length: number, mapper: (index: number) => T): T[] => (
    Array.from({ length: Math.max(0, length) }, (_, index) => mapper(index))
);

const formatTokenCount = (value: number): string => {
    const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
    if (safeValue >= 1000000) {
        const millions = safeValue / 1000000;
        return String(millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)) + 'M';
    }
    if (safeValue >= 1000) {
        const thousands = safeValue / 1000;
        return String(thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)) + 'K';
    }
    return String(Math.round(safeValue));
};

const formatTokenRange = (rangeValue: { average: number; worst: number }): string => (
    formatTokenCount(rangeValue.average) + ' - ' + formatTokenCount(rangeValue.worst)
);

const pathForPoints = (points: Array<{ x: number; y: number }>): string => (
    points.map((point, index) => (index === 0 ? 'M' : 'L') + ' ' + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ')
);

interface TokenVolumeGraphProps {
    strategiesCount: number;
    strategyProximityLoops?: number;
    modulesCount: number;
    modulesImpactReviewLoops?: number;
    i: number;
    j?: number;
    k?: number;
    isolateBranches: boolean;
    codeExecutionEnabled?: boolean;
}

export const TokenVolumeGraph: React.FC<TokenVolumeGraphProps> = ({
    strategiesCount,
    strategyProximityLoops,
    modulesCount,
    modulesImpactReviewLoops,
    i,
    j,
    k,
    isolateBranches,
    codeExecutionEnabled,
}) => {
    const [focus, setFocus] = useState<TokenGraphFocus>('total');
    const [hoverDepth, setHoverDepth] = useState<number | null>(null);
    const safeDepth = Math.max(1, Math.round(i || 1));

    const trend = useMemo(() => buildDeepthinkTokenTrend({
        strategiesCount,
        strategyProximityLoops,
        modulesCount,
        modulesImpactReviewLoops,
        j,
        k,
        isolateBranches,
        codeExecutionEnabled,
        maxDepth: safeDepth,
    }), [strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, j, k, isolateBranches, codeExecutionEnabled, safeDepth]);

    const selected = useMemo(() => calculateDeepthinkTokenEstimate({
        strategiesCount,
        strategyProximityLoops,
        modulesCount,
        modulesImpactReviewLoops,
        deepthinkDepth: safeDepth,
        i: safeDepth,
        j,
        k,
        isolateBranches,
        codeExecutionEnabled,
    }), [strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, j, k, isolateBranches, codeExecutionEnabled, safeDepth]);

    const [chartSize, setChartSize] = useState<{ width: number; height: number }>({
        width: TOKEN_CHART.width,
        height: TOKEN_CHART.height,
    });
    const shellRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!shellRef.current) return;
        const observer = new ResizeObserver(entries => {
            if (entries[0]) {
                const { width, height } = entries[0].contentRect;
                if (width > 0 && height > 0) {
                    setChartSize({ width, height });
                }
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
    const selectedX = maxDepth === 1
        ? padding.left + plotWidth / 2
        : padding.left + ((selectedDepth - 1) / (maxDepth - 1)) * plotWidth;
    const visibleSeries = focus === 'total' ? TOKEN_SERIES : TOKEN_SERIES.filter(item => item.category === focus);
    const allValues = visibleSeries.flatMap(item => trend.map(point => item.valueOf(point))).filter(value => value > 0);
    const maxValue = Math.max(...allValues, 1) * 1.1;
    const minPositive = allValues.length ? Math.max(1, Math.min(...allValues)) : 1;
    const minValue = Math.max(1, minPositive * 0.72);
    const xForDepth = (depth: number): number => (
        maxDepth === 1 ? padding.left + plotWidth / 2 : padding.left + ((depth - 1) / (maxDepth - 1)) * plotWidth
    );
    const yForValue = (value: number): number => {
        const logMin = Math.log10(minValue);
        const logMax = Math.log10(maxValue);
        const normalizedValue = (Math.log10(Math.max(value, minValue)) - logMin) / (logMax - logMin || 1);
        return padding.top + plotHeight - normalizedValue * plotHeight;
    };
    const pathForSeries = (valueOf: (point: DeepthinkTokenEstimate) => number): string => (
        pathForPoints(trend.map(point => ({ x: xForDepth(point.depth), y: yForValue(valueOf(point)) })))
    );
    const areaPathForFocus = (category: 'input' | 'output'): string => {
        const high = category === 'input'
            ? (point: DeepthinkTokenEstimate) => point.input.worst
            : (point: DeepthinkTokenEstimate) => point.output.worst;
        const low = category === 'input'
            ? (point: DeepthinkTokenEstimate) => point.input.average
            : (point: DeepthinkTokenEstimate) => point.output.average;
        const upper = trend.map(point => ({ x: xForDepth(point.depth), y: yForValue(high(point)) }));
        const lower = [...trend].reverse().map(point => ({ x: xForDepth(point.depth), y: yForValue(low(point)) }));
        return pathForPoints(upper) + ' ' + lower.map(point => 'L ' + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ') + ' Z';
    };
    const logMin = Math.log10(minValue);
    const logMax = Math.log10(maxValue);
    const yTicks = range(5, i => Math.pow(10, logMin + (logMax - logMin) * (i / 4)));
    
    let xTicks: number[];
    if (maxDepth <= 10) {
        xTicks = range(maxDepth, index => index + 1);
    } else {
        const step = Math.ceil(maxDepth / 10);
        xTicks = range(Math.floor(maxDepth / step) + 1, index => index * step + 1);
        if (xTicks[xTicks.length - 1] !== maxDepth) {
            xTicks.push(maxDepth);
        }
    }

    const hovered = hoverDepth == null ? null : trend.find(point => point.depth === hoverDepth) ?? null;
    const hoveredX = hovered ? xForDepth(hovered.depth) : 0;
    const hoverValues = hovered ? visibleSeries.map(item => item.valueOf(hovered)) : [];
    const hoveredY = hovered && hoverValues.length ? yForValue(Math.max(...hoverValues)) : padding.top;
    const tooltipWidth = focus === 'total' ? 198 : 168;
    const tooltipHeight = 30 + visibleSeries.length * 17;
    const tooltipX = hovered ? clamp(hoveredX + 12, padding.left, width - padding.right - tooltipWidth) : 0;
    const tooltipY = hovered ? clamp(hoveredY - 12, padding.top + 4, padding.top + plotHeight - tooltipHeight - 4) : 0;

    const setGraphFocus = (nextFocus: TokenGraphFocus) => {
        setFocus(current => current === nextFocus && nextFocus !== 'total' ? 'total' : nextFocus);
        setHoverDepth(null);
    };

    const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const svgX = ((event.clientX - rect.left) / rect.width) * width;
        const rawDepth = maxDepth === 1 ? 1 : 1 + ((svgX - padding.left) / plotWidth) * (maxDepth - 1);
        setHoverDepth(clamp(Math.round(rawDepth), 1, maxDepth));
    };

    return (
        <div className={'token-volume-estimator focus-' + focus}>
            <div className="token-estimator-layout">
                <div className="token-chart-column">
                    <div className="token-chart-shell" ref={shellRef}>
                        <svg
                            className="token-chart-svg"
                            viewBox={'0 0 ' + String(width) + ' ' + String(height)}
                            role="img"
                            aria-label={'Estimated token volume through iteration ' + String(selectedDepth)}
                            onPointerMove={handlePointerMove}
                            onPointerLeave={() => setHoverDepth(null)}
                        >
                            <rect className="token-chart-backdrop" x="0" y="0" width={width} height={height} rx="8" />
                            {yTicks.map((tick, index) => {
                                const y = yForValue(tick);
                                return (
                                    <g key={'y-' + String(index)}>
                                        <line className="token-grid-line" x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                                        <text className="token-axis-label token-y-label" x={padding.left - 8} y={y + 4} textAnchor="end">{formatTokenCount(tick)}</text>
                                    </g>
                                );
                            })}
                            {xTicks.map(tick => {
                                const x = xForDepth(tick);
                                return (
                                    <g key={'x-' + String(tick)}>
                                        <line className="token-x-tick" x1={x} y1={padding.top + plotHeight} x2={x} y2={padding.top + plotHeight + 5} />
                                        <text className="token-axis-label" x={x} y={height - 12} textAnchor="middle">{tick}</text>
                                    </g>
                                );
                            })}
                            <text className="token-axis-caption" x={padding.left + plotWidth / 2} y={height - 2} textAnchor="middle">Iterations (i)</text>
                            <text className="token-axis-caption token-y-axis-caption" x={-(padding.top + plotHeight / 2)} y="14" textAnchor="middle" transform="rotate(-90)">Total tokens</text>
                            <line className="token-selected-depth-line" x1={selectedX} y1={padding.top} x2={selectedX} y2={padding.top + plotHeight} />
                            {focus !== 'total' && <path className={'token-area-fill ' + focus} d={areaPathForFocus(focus)} />}
                            {visibleSeries.map(item => <path key={item.key} className={'token-series-line ' + item.key} d={pathForSeries(item.valueOf)} />)}
                            {visibleSeries.map(item => (
                                <circle key={item.key + '-point'} className={'token-selected-point ' + item.key} cx={selectedX} cy={yForValue(item.valueOf(selected))} r="3.4" />
                            ))}
                            {hovered && (
                                <g className="token-hover-layer">
                                    <line className="token-hover-line" x1={hoveredX} y1={padding.top} x2={hoveredX} y2={padding.top + plotHeight} />
                                    {visibleSeries.map(item => (
                                        <circle key={item.key + '-hover'} className={'token-hover-point ' + item.key} cx={hoveredX} cy={yForValue(item.valueOf(hovered))} r="4.2" />
                                    ))}
                                    <rect className="token-hover-tooltip" x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="7" />
                                    <text className="token-hover-title" x={tooltipX + 10} y={tooltipY + 18}>Iteration {hovered.depth}</text>
                                    {visibleSeries.map((item, index) => (
                                        <text key={item.key + '-hover-label'} className={'token-hover-label ' + item.key} x={tooltipX + 10} y={tooltipY + 38 + index * 17}>
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
                                <span className={'token-legend-swatch ' + item.key} />
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
                            onClick={() => setGraphFocus(item)}
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

export const TotalLLMCallsTokenEstimationModal: React.FC<{
    onClose: () => void;
}> = ({ onClose }) => {
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

    const apiCallsEstimate: DeepthinkApiCallEstimate = useMemo(() => {
        return calculateDeepthinkApiCallsFromParams({
            strategiesCount: configState.strategiesCount,
            strategyProximityLoops: configState.strategyProximityLoops,
            modulesCount: configState.modulesEnabled ? configState.modulesCount : 0,
            modulesImpactReviewLoops: configState.modulesImpactReviewLoops,
            i: configState.i,
            j: configState.j,
            k: configState.k,
            isolateBranches: configState.isolateBranches,
            codeExecutionEnabled: configState.codeExecutionEnabled,
            deepthinkCodeExecutionEnabled: configState.codeExecutionEnabled,
        });
    }, [configState]);

    const formattedMin = formatApiCallCount(apiCallsEstimate.min);
    const formattedMax = formatApiCallCount(apiCallsEstimate.max);
    const displayApiCalls = apiCallsEstimate.min === apiCallsEstimate.max
        ? `~${formattedMin}`
        : `~${formattedMin} to ${formattedMax}`;

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

    return createPortal(
        <BaseModal
            title="Total LLM Calls & Token Estimation"
            className="fullscreen-modal token-estimation-fullscreen-modal"
            onClose={onClose}
        >
            <div className="deepthink-config-react-root" style={{ width: '100%', height: '100%', zoom: 1, display: 'flex', flexDirection: 'column' }}>
                <div className="token-estimation-modal-content custom-scrollbar">
                    <div className="token-estimation-overview-grid">
                        <div className={`estimation-stat-card ${configState.codeExecutionEnabled ? 'sandbox-stat' : ''}`}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-purple">
                                    <Icon name="psychology" />
                                </span>
                                <span className="stat-card-title">Total LLM Calls</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value" id="api-call-count">
                                    {displayApiCalls}
                                </span>
                                <span className="stat-card-unit">Calls</span>
                            </div>
                            <div className="stat-card-footnote">
                                <span>Based on current configuration</span>
                            </div>
                        </div>

                        <div className={`estimation-stat-card ${configState.codeExecutionEnabled ? 'sandbox-stat' : ''}`}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-blue">
                                    <Icon name="data_usage" />
                                </span>
                                <span className="stat-card-title">Estimated Total Tokens</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value">
                                    {formatTokenRange(tokenSummary.total)}
                                </span>
                                <span className="stat-card-unit">Tokens</span>
                            </div>
                            <div className="stat-card-footnote">
                                <span>Input: {formatTokenRange(tokenSummary.input)} • Output: {formatTokenRange(tokenSummary.output)}</span>
                            </div>
                        </div>

                        <div className={`estimation-stat-card ${configState.codeExecutionEnabled ? 'sandbox-stat' : ''}`}>
                            <div className="stat-card-header">
                                <span className="stat-card-icon dt-title-red">
                                    <Icon name="terminal" />
                                </span>
                                <span className="stat-card-title">Sandbox Multiplier</span>
                            </div>
                            <div className="stat-card-body">
                                <span className="stat-card-value">
                                    {configState.codeExecutionEnabled ? '12x–36x' : '1x'}
                                </span>
                                <span className="stat-card-unit">Overhead</span>
                            </div>
                            <div className="stat-card-footnote">
                                {configState.codeExecutionEnabled ? (
                                    <span className="sandbox-active">Code execution significantly multiplies usage</span>
                                ) : (
                                    <span>Code execution is disabled</span>
                                )}
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

export default TotalLLMCallsTokenEstimationModal;
