/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * DeepthinkConfigPanel — the fixed Deepthink configuration surface.
 * The original panel layout and visual primitives are retained; only the
 * retired execution choices have been removed from the rendered controls.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { getDeepthinkConfigController } from '../../Routing';
import { calculateDeepthinkTokenEstimate } from '../../Routing/DeepthinkTokenEstimator';
import { TotalLLMCallsTokenEstimationModal } from './TotalLLMCallsTokenEstimationModal';
import {
    MAX_MODULES_COUNT,
    MAX_STRATEGY_PROXIMITY_LOOPS,
    MAX_MODULES_IMPACT_REVIEW_LOOPS,
    BSR_WEIGHT_PRESETS,
    type BsrWeightPresetId,
} from '../../Routing/ModelConfig';
import { Icon } from '../../UI/Icons';
import { disableSidebarCollapseButton } from '../../UI/LayoutController';
import '../styles/DeepthinkConfigPanel.css';

type DeepthinkController = ReturnType<typeof getDeepthinkConfigController>;

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

interface SectionFrameProps {
    containerClass: string;
    headerClass: string;
    icon: string;
    title: string;
    children: React.ReactNode;
}

interface SliderWithFillProps {
    id: string;
    value: number;
    min: number;
    max: number;
    color: string;
    disabled?: boolean;
    onChange: (value: number) => void;
}

interface ToggleSwitchProps {
    id: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    className?: string;
    inputClassName?: string;
    sliderClassName?: string;
    disabled?: boolean;
}




const classNames = (...parts: Array<string | false | null | undefined>): string => (
    parts.filter(Boolean).join(' ')
);

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
);

const toInteger = (value: string): number => Number.parseInt(value, 10);

const range = <T,>(length: number, mapper: (index: number) => T): T[] => (
    Array.from({ length: Math.max(0, length) }, (_, index) => mapper(index))
);

const percentBetween = (value: number, min: number, max: number): number => (
    max > min ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0
);

const filledTrack = (percentage: number, color: string): string => (
    'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + percentage + '%, var(--slider-track-color) ' + percentage + '%, var(--slider-track-color) 100%)'
);



const SectionFrame: React.FC<SectionFrameProps> = ({ containerClass, headerClass, icon, title, children }) => (
    <div className={containerClass}>
        <div className={classNames('section-header', headerClass)}>
            <div className="section-title-wrapper">
                <Icon name={icon} />
                <span className="section-title">{title}</span>
            </div>
        </div>
        <div className="section-body">
            {children}
        </div>
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

const SliderWithFill: React.FC<SliderWithFillProps> = ({ id, value, min, max, color, disabled, onChange }) => {
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
            onPointerDown={() => {
                if (!disabled) requestConfigWarning();
            }}
            onChange={event => {
                requestConfigWarning();
                onChange(toInteger(event.currentTarget.value));
            }}
        />
    );
};

const VerticalBar: React.FC<{ id?: string, value: number, min: number, max: number, color: string, disabled?: boolean, onChange: (val: number) => void }> = ({ id, value, min, max, color, disabled, onChange }) => {
    const safeValue = clamp(value, min, max);
    const percentage = percentBetween(safeValue, min, max);

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
                onPointerDown={() => {
                    if (!disabled) requestConfigWarning();
                }}
                onChange={event => {
                    requestConfigWarning();
                    onChange(toInteger(event.currentTarget.value));
                }}
            />
            <div className="vertical-bar-visual-track">
                <div className="vertical-bar-visual-fill" style={{ height: `${percentage}%`, backgroundColor: color }} />
            </div>
        </div>
    );
};

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
    id,
    checked,
    onChange,
    className = 'toggle-switch',
    inputClassName = 'toggle-input',
    sliderClassName = 'toggle-slider',
    disabled,
}) => (
    <label className={className}>
        <input
            type="checkbox"
            id={id}
            className={inputClassName}
            checked={checked}
            disabled={disabled}
            onChange={event => onChange(event.currentTarget.checked)}
        />
        <span className={sliderClassName} />
    </label>
);

const StrategyExecutionSection: React.FC<{
    strategiesCount: number;
    strategyProximityLoops: number;
    onStrategiesChange: (count: number) => void;
    onStrategyProximityLoopsChange: (count: number) => void;
}> = ({ strategiesCount, strategyProximityLoops, onStrategiesChange, onStrategyProximityLoopsChange }) => (
    <div className="strategy-execution-container">
        <div className="strategy-execution-card">
            <div className="strategy-execution-section">
                <div className="slider-pair-row proximity-pair">
                    <div className="input-group-tight">
                        <label htmlFor="dt-strategies-slider" className="input-label">
                            Strategies: <span id="dt-strategies-value">{strategiesCount}</span>
                        </label>
                        <SliderWithFill
                            id="dt-strategies-slider"
                            value={strategiesCount}
                            min={1}
                            max={5}
                            color="var(--accent-purple)"
                            onChange={onStrategiesChange}
                        />
                    </div>
                    <div className="input-group-tight">
                        <label htmlFor="dt-strategy-proximity-slider" className="input-label">
                            Proximity loops: <span id="dt-strategy-proximity-value">{strategyProximityLoops}</span>
                        </label>
                        <SliderWithFill
                            id="dt-strategy-proximity-slider"
                            value={strategyProximityLoops}
                            min={1}
                            max={MAX_STRATEGY_PROXIMITY_LOOPS}
                            color="var(--accent-purple)"
                            onChange={onStrategyProximityLoopsChange}
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>
);

const LoopScheduleSection: React.FC<{
    i: number;
    j: number;
    k: number;
    curatedContextEnabled: boolean;
    onIChange: (i: number) => void;
    onJChange: (j: number) => void;
    onKChange: (k: number) => void;
}> = ({ i, j, k, curatedContextEnabled, onIChange, onJChange, onKChange }) => {
    const errorI = i < 5 || i > 20 ? 'Total iterations (i) must be between 5 and 20.' : null;
    const errorJ = j < 3 || j > 8 ? 'Global update interval (j) must be between 3 and 8.' : null;

    const maxK = Math.max(2, Math.min(8, j));
    const effectiveK = Math.min(k, maxK);
    const errorK = curatedContextEnabled && (k < 2 || k > j)
        ? `Heartbeat interval (k) must be between 2 and j (${j}).`
        : null;

    // Calculate update points (multiples of j strictly less than i)
    const updatePoints: number[] = [];
    for (let it = j; it < i; it += j) {
        updatePoints.push(it);
    }

    // Calculate curated context heartbeat points (every k iterations between global updates)
    // Spec rule: "A due heartbeat is skipped when it would feed fewer than 2 iterations before the next global update."
    const heartbeatPoints: number[] = [];
    if (curatedContextEnabled && k >= 2) {
        for (let it = 1; it < i; it++) {
            if (updatePoints.includes(it)) continue; // global update takes precedence
            const nextBarrier = updatePoints.find(p => p > it) ?? i;
            const prevBarrier = [...updatePoints].reverse().find(p => p < it) ?? 0;
            const cycleOffset = it - prevBarrier;
            if (cycleOffset > 0 && cycleOffset % k === 0) {
                const remainingBeforeBarrier = nextBarrier - it;
                if (remainingBeforeBarrier >= 2) {
                    heartbeatPoints.push(it);
                }
            }
        }
    }

    return (
        <SectionFrame
            containerClass="evolution-filter-options-container"
            headerClass="evolution-filter-options-header dt-title-red"
            icon="event_repeat"
            title="Loop Schedule & Global Updates"
        >
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
                                    className={classNames(
                                        'timeline-step',
                                        isUpdate && 'update-step',
                                        hasHeartbeatAtUpdate && 'with-heartbeat',
                                        isFinal && 'final-step',
                                        isHeartbeat && 'heartbeat-step',
                                    )}
                                    title={`Iteration ${itNum}${isUpdate ? `: Global Update + BSR${hasHeartbeatAtUpdate ? ' (Curated Heartbeat synchronized)' : ''}` :
                                        isFinal ? ': Final Evaluation' :
                                            isHeartbeat ? `: Curated Context Heartbeat (k=${k})` : ''
                                        }`}
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
                        <label htmlFor="dt-i-slider" className="input-label">
                            Total Iterations (i): <span id="dt-i-value">{i}</span>
                        </label>
                        <SliderWithFill
                            id="dt-i-slider"
                            value={i}
                            min={5}
                            max={20}
                            color="var(--accent-pink)"
                            onChange={onIChange}
                        />
                        {errorI && <div className="config-error-text">{errorI}</div>}
                    </div>

                    <div className="input-group-tight">
                        <label htmlFor="dt-j-slider" className="input-label">
                            Global Update Interval (j): <span id="dt-j-value">{j}</span>
                        </label>
                        <SliderWithFill
                            id="dt-j-slider"
                            value={j}
                            min={3}
                            max={8}
                            color="var(--accent-pink)"
                            onChange={onJChange}
                        />
                        {errorJ && <div className="config-error-text">{errorJ}</div>}
                    </div>

                    {curatedContextEnabled && (
                        <div className="input-group-tight">
                            <label htmlFor="dt-k-slider" className="input-label">
                                Heartbeat Interval (k): <span id="dt-k-value">{effectiveK}</span> iterations
                            </label>
                            <SliderWithFill
                                id="dt-k-slider"
                                value={effectiveK}
                                min={2}
                                max={maxK}
                                color="var(--accent-pink)"
                                onChange={onKChange}
                            />
                            {errorK && <div className="config-error-text">{errorK}</div>}
                        </div>
                    )}
                </div>
            </div>
        </SectionFrame>
    );
};


const SandboxEnvironmentPanel: React.FC<{
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
}> = ({ enabled, onToggle }) => (
    <div className="code-execution-toggle-container" id="dt-code-execution-container">
        <ToggleSwitch
            id="dt-code-execution-toggle"
            checked={enabled}
            onChange={onToggle}
        />
        <div className="code-execution-toggle-info">
            <span className="code-execution-toggle-title">Sandbox Terminal Environment</span>
            <span className="code-execution-toggle-subtitle">Persistent secure workspace for every Deepthink agent</span>
        </div>
    </div>
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

const TotalLLMCallsButton: React.FC<{
    sandboxEnabled: boolean;
    tokenSummaryText: string;
    onClick: () => void;
}> = ({ sandboxEnabled, tokenSummaryText, onClick }) => (
    <button
        type="button"
        id="total-llm-calls-token-estimation-button"
        className={`code-execution-toggle-container total-llm-calls-toggle-btn ${sandboxEnabled ? 'sandbox-enabled' : ''}`}
        onClick={onClick}
        title="Total LLM Calls & Token Estimation"
        aria-label="Total LLM Calls & Token Estimation"
    >
        <span className="total-llm-calls-icon-wrapper">
            <Icon name="chart-no-axes-combined" />
        </span>
        <div className="code-execution-toggle-info">
            <span className="code-execution-toggle-title">Total LLM Calls &amp; Token Estimation</span>
            <span className="code-execution-toggle-subtitle">
                {tokenSummaryText}
            </span>
        </div>
    </button>
);

const Figure4Visualization: React.FC<{ modulesEnabled: boolean }> = ({ modulesEnabled }) => {
    const B = (k: 'g' | 't' | 'c' | 'p', x: number, y: number, w: number, h: number, a: string, b?: string, m?: boolean) => {
        const cx = x + w / 2;
        const cy = y + h / 2;
        return (
            <g className={`vis-box vis-theme-${k}`} key={`box-${x}-${y}`}>
                <rect x={x} y={y} width={w} height={h} rx={8} />
                <text className={m ? 'ts m' : 'th'} x={cx} y={b ? cy - 12 : cy} textAnchor="middle" dominantBaseline="central">{a}</text>
                {b && <text className="ts" x={cx} y={cy + 12} textAnchor="middle" dominantBaseline="central">{b}</text>}
            </g>
        );
    };

    const P = (d: string, k: number = 0) => (
        <path
            key={`path-${d}`}
            d={d}
            className="vis-path"
            strokeDasharray={k & 1 ? "4 4" : undefined}
            markerStart={k & 2 ? "url(#arrow)" : undefined}
            markerEnd={k & 4 ? undefined : "url(#arrow)"}
        />
    );

    const dimMod = !modulesEnabled ? 'vis-dimmed' : '';

    return (
        <div className="figure4-container">
            <svg
                viewBox="22 38 626 438"
                preserveAspectRatio="xMidYMid meet"
                className="figure4-visualization"
                role="img"
                aria-label="Modules generator architecture"
            >
                <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M2 1L8 5L2 9" className="vis-arrow-path" />
                    </marker>
                </defs>
                <g className={dimMod}>
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
    modulesEnabled: boolean;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    onModulesToggle: (enabled: boolean) => void;
    onModulesChange: (count: number) => void;
    onModulesImpactReviewLoopsChange: (count: number) => void;
}> = ({
    modulesEnabled,
    modulesCount,
    modulesImpactReviewLoops,
    onModulesToggle,
    onModulesChange,
    onModulesImpactReviewLoopsChange,
}) => {
        const toggleModules = (enabled: boolean) => {
            onModulesToggle(enabled);
            if (!enabled) onModulesChange(0);
        };

        return (
            <div className="information-packet-window" id="dt-information-packet-window">
                <div className="window-header">
                    <div className="window-left dt-title-blue">
                        <Icon name="refresh" />
                        <div className="window-title">Customize Curated Context</div>
                    </div>
                </div>

                <div className="window-content" id="dt-information-packet-content">
                    {/* 2. Modules Generation sub-section (Toggle + in-sync Visual + in-sync Sliders) */}
                    <div className={classNames('curated-subfeature-card', !modulesEnabled && 'collapsed')}>
                        <div className="curated-subfeature-header">
                            <label htmlFor="dt-modules-toggle" className="curated-toggle-label">
                                Modules Generation & Independent Testing
                            </label>
                            <ToggleSwitch
                                id="dt-modules-toggle"
                                checked={modulesEnabled}
                                onChange={toggleModules}
                            />
                        </div>

                        {modulesEnabled && (
                            <div className="curated-subfeature-body">
                                <div className="modules-controls">
                                    <div className="slider-pair-row proximity-pair">
                                        <div className="input-group-tight">
                                            <label htmlFor="dt-modules-slider" className="input-label">
                                                Modules Count: <span id="dt-modules-value">{modulesCount}</span>
                                            </label>
                                            <SliderWithFill
                                                id="dt-modules-slider"
                                                value={modulesCount > 0 ? modulesCount : 1}
                                                min={1}
                                                max={MAX_MODULES_COUNT}
                                                color="var(--accent-blue)"
                                                onChange={onModulesChange}
                                            />
                                        </div>
                                        <div className="input-group-tight">
                                            <label htmlFor="dt-modules-impact-review-slider" className="input-label">
                                                Impact review loops: <span id="dt-modules-impact-review-value">{modulesImpactReviewLoops}</span>
                                            </label>
                                            <SliderWithFill
                                                id="dt-modules-impact-review-slider"
                                                value={modulesImpactReviewLoops}
                                                min={1}
                                                max={MAX_MODULES_IMPACT_REVIEW_LOOPS}
                                                color="var(--accent-blue)"
                                                onChange={onModulesImpactReviewLoopsChange}
                                            />
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
    };




const EventSizeWeightsSection: React.FC<{
    bsrWeightPreset: BsrWeightPresetId;
    onBsrWeightPresetChange: (presetId: BsrWeightPresetId) => void;
}> = props => {
    const activePreset = BSR_WEIGHT_PRESETS.find(p => p.id === props.bsrWeightPreset) || BSR_WEIGHT_PRESETS[0];

    return (
        <div className="bsr-presets-integrated" style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '0.96rem', fontWeight: 600, marginBottom: '12px', color: 'var(--foreground-primary)' }}>
                Event Size Weights Presets (w):
            </div>
            <div className="bsr-preset-grid" id="dt-bsr-presets-grid">
                {BSR_WEIGHT_PRESETS.map(preset => {
                    const isSelected = props.bsrWeightPreset === preset.id;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            className={`bsr-preset-card ${isSelected ? 'active' : ''}`}
                            onClick={() => props.onBsrWeightPresetChange(preset.id)}
                            title={preset.shortDescription}
                        >
                            <div className="bsr-preset-top">
                                <span className="bsr-preset-name">{preset.label}</span>
                                <span className="bsr-preset-ratio">{preset.ratio}</span>
                            </div>
                            <span className="bsr-preset-subtitle">{preset.tag}</span>
                        </button>
                    );
                })}
            </div>
            <div className="bsr-change-description bsr-preset-description" id="dt-bsr-preset-desc" style={{ marginTop: '10px' }}>
                <strong>{activePreset.label} ({activePreset.ratio}):</strong> {activePreset.detailedDescription}
            </div>
        </div>
    );
};

const BsrParametersSection: React.FC<{
    bsrNoiseLevel: number;
    bsrPressureFloor: number;
    bsrWeightPreset: BsrWeightPresetId;
    onBsrNoiseLevelChange: (val: number) => void;
    onBsrPressureFloorChange: (val: number) => void;
    onBsrWeightPresetChange: (presetId: BsrWeightPresetId) => void;
}> = props => {
    const getNoiseDescription = (tau: number) => {
        if (tau === 1) {
            return 'Twitchy & sensitive (τ = 1): A single minor typo fix counts as progress; risks keeping dead branches alive on technicalities.';
        }
        if (tau === 2) {
            return 'Balanced default (τ = 2): Requires 1 medium event (or 2 small) of net movement to prove the branch is moving.';
        }
        if (tau === 3) {
            return 'Skeptical (τ = 3): Requires 1 large breakthrough or multiple medium wins to establish a trend.';
        }
        return 'Strict & skeptical (τ = 4): Demands continuous breakthroughs; classifies slow exploration windows as stalls.';
    };

    const getPressureDescription = (theta: number) => {
        if (theta <= 0.15) {
            return `Ruthless & aggressive (θ = ${theta.toFixed(2)}): At the first mathematical hint of slowing down, aggressively wipes or rewrites branches.`;
        }
        if (theta < 0.28) {
            return `Active & decisive (θ = ${theta.toFixed(2)}): Swiftly prunes or evolves drifting branches without burning extra cycles.`;
        }
        if (theta <= 0.35) {
            return `Balanced default (θ = ${theta.toFixed(2)}): Standard trigger floor. Pressures below this are ignored (CONTINUE).`;
        }
        if (theta <= 0.48) {
            return `Patient & cautious (θ = ${theta.toFixed(2)}): Gives slowing branches extra time; requires higher stall/regression evidence.`;
        }
        return `Highly conservative (θ = ${theta.toFixed(2)}): Demands overwhelming evidence of failure before PRUNE or EVOLVE (burns much more compute).`;
    };


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
                    {/* 1. Noise Level (tau) */}
                    <div className="bsr-vertical-bar-col">
                        <div className="bsr-bar-layout">
                            <label htmlFor="dt-bsr-noise-slider" className="input-label bsr-side-label">
                                Noise (τ): <span id="dt-bsr-noise-value" className="bsr-value-highlight">{props.bsrNoiseLevel}</span>
                            </label>
                            <VerticalBar
                                id="dt-bsr-noise-slider"
                                value={props.bsrNoiseLevel}
                                min={1}
                                max={4}
                                color="var(--accent-red, #ff5f56)"
                                onChange={props.onBsrNoiseLevelChange}
                            />
                        </div>
                        <div className="bsr-change-description" id="dt-bsr-noise-desc">
                            {getNoiseDescription(props.bsrNoiseLevel)}
                        </div>
                    </div>

                    {/* 2. Pressure Floor (theta) */}
                    <div className="bsr-vertical-bar-col">
                        <div className="bsr-bar-layout">
                            <label htmlFor="dt-bsr-pressure-slider" className="input-label bsr-side-label">
                                Pressure (θ): <span id="dt-bsr-pressure-value" className="bsr-value-highlight">{(props.bsrPressureFloor).toFixed(2)}</span>
                            </label>
                            <VerticalBar
                                id="dt-bsr-pressure-slider"
                                value={Math.round(props.bsrPressureFloor * 100)}
                                min={10}
                                max={60}
                                color="var(--accent-red, #ff5f56)"
                                onChange={val => props.onBsrPressureFloorChange(val / 100)}
                            />
                        </div>
                        <div className="bsr-change-description" id="dt-bsr-pressure-desc">
                            {getPressureDescription(props.bsrPressureFloor)}
                        </div>
                    </div>
                </div>
                <EventSizeWeightsSection
                    bsrWeightPreset={props.bsrWeightPreset}
                    onBsrWeightPresetChange={props.onBsrWeightPresetChange}
                />
            </div>
        </div>
    );
};

const CONFIG_WARNING_TEXT =
    'The current default configuration is optimal for most of the situations and is finalized after doing a lot of experiments. Change the configuration only if you know exactly what you are doing and how it will impact the overall state, and, more importantly the costs. This is very sensitive configuration (doesnt matter whether you are using it with local models or with the frontier models). Small tweaks can waste your compute significantly.';

const ConfigSensitivityWarningModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const openedAtRef = useRef(Date.now());
    const pointerDownOnBackdropRef = useRef(false);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return createPortal(
        <div
            className="dt-config-warning-overlay"
            onPointerDown={event => {
                pointerDownOnBackdropRef.current =
                    event.target === event.currentTarget && Date.now() - openedAtRef.current > 200;
            }}
            onClick={event => {
                if (pointerDownOnBackdropRef.current && event.target === event.currentTarget) {
                    pointerDownOnBackdropRef.current = false;
                    onClose();
                }
            }}
        >
            <div
                className="dt-config-warning-popup"
                role="alertdialog"
                aria-modal="true"
                aria-describedby="dt-config-warning-message"
            >
                <button
                    type="button"
                    className="dt-config-warning-close"
                    onClick={onClose}
                    aria-label="Close"
                >
                    <Icon name="close" size={16} />
                </button>
                <div className="dt-config-warning-icon-circle">
                    <Icon name="circle_alert" size={24} />
                </div>
                <p id="dt-config-warning-message" className="dt-config-warning-text">
                    {CONFIG_WARNING_TEXT}
                </p>
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
        const syncWarningModal = () => {
            setIsConfigWarningOpen(isConfigWarningModalOpen);
        };
        notifyConfigWarningListeners = syncWarningModal;
        return () => {
            if (notifyConfigWarningListeners === syncWarningModal) {
                notifyConfigWarningListeners = null;
            }
        };
    }, []);

    const withConfigWarning = <T extends (...args: any[]) => void>(handler: T): T => (
        ((...args: Parameters<T>) => {
            requestConfigWarning();
            handler(...args);
        }) as T
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
    }), [
        props.strategiesCount,
        props.strategyProximityLoops,
        props.modulesEnabled,
        props.modulesCount,
        props.modulesImpactReviewLoops,
        safeDepth,
        props.j,
        props.k,
        props.isolateBranches,
        props.codeExecutionEnabled,
    ]);

    return (
        <div className="deepthink-config-panel">
            <div className="deepthink-config-scroll-container">
                <div className="config-top-row">
                    <StrategyExecutionSection
                        strategiesCount={props.strategiesCount}
                        strategyProximityLoops={props.strategyProximityLoops}
                        onStrategiesChange={withConfigWarning(props.onStrategiesChange)}
                        onStrategyProximityLoopsChange={withConfigWarning(props.onStrategyProximityLoopsChange)}
                    />
                    <SandboxEnvironmentPanel enabled={props.codeExecutionEnabled} onToggle={props.onCodeExecutionToggle} />
                    <TotalLLMCallsButton
                        sandboxEnabled={props.codeExecutionEnabled}
                        tokenSummaryText={`${formatTokenRange(tokenSummary.total)} Tokens`}
                        onClick={() => setIsEstimationModalOpen(true)}
                    />
                </div>
                <div className="config-middle-row" style={{ marginBottom: '1rem' }}>
                    <LoopScheduleSection
                        i={props.i}
                        j={props.j}
                        k={props.k}
                        curatedContextEnabled={props.modulesEnabled}
                        onIChange={withConfigWarning(props.onIChange)}
                        onJChange={withConfigWarning(props.onJChange)}
                        onKChange={withConfigWarning(props.onKChange)}
                    />
                </div>
                <div className="config-bottom-grid">
                    <div className="config-left-col">
                        <CuratedContextSection
                            modulesEnabled={props.modulesEnabled}
                            modulesCount={props.modulesCount}
                            modulesImpactReviewLoops={props.modulesImpactReviewLoops}
                            onModulesToggle={withConfigWarning(props.onModulesToggle)}
                            onModulesChange={withConfigWarning(props.onModulesChange)}
                            onModulesImpactReviewLoopsChange={withConfigWarning(props.onModulesImpactReviewLoopsChange)}
                        />
                        <div className="curated-subfeature-card">
                            <div className="curated-subfeature-header">
                                <label htmlFor="dt-isolate-branches-toggle" className="curated-toggle-label">
                                    Isolate Branches
                                </label>
                                <ToggleSwitch
                                    id="dt-isolate-branches-toggle"
                                    checked={props.isolateBranches}
                                    onChange={props.onIsolateBranchesToggle}
                                />
                            </div>
                        </div>
                    </div>
                    <div className="config-right-col">
                        <BsrParametersSection
                            bsrNoiseLevel={props.bsrNoiseLevel}
                            bsrPressureFloor={props.bsrPressureFloor}
                            bsrWeightPreset={props.bsrWeightPreset}
                            onBsrNoiseLevelChange={withConfigWarning(props.onBsrNoiseLevelChange)}
                            onBsrPressureFloorChange={withConfigWarning(props.onBsrPressureFloorChange)}
                            onBsrWeightPresetChange={withConfigWarning(props.onBsrWeightPresetChange)}
                        />
                    </div>
                </div>

            </div>
            {isEstimationModalOpen && (
                <TotalLLMCallsTokenEstimationModal
                    onClose={() => setIsEstimationModalOpen(false)}
                />
            )}
            {isConfigWarningOpen && (
                <ConfigSensitivityWarningModal
                    onClose={dismissConfigWarning}
                />
            )}
        </div>
    );
};

function deriveProps(controller: DeepthinkController): DeepthinkConfigPanelProps {
    const state = controller.getState();
    const currentJ = state.j ?? 4;
    return {
        ...state,
        i: state.i ?? 10,
        j: currentJ,
        k: state.k ?? 4,
        onStrategiesChange: value => controller.setStrategiesCount(value),
        onStrategyProximityLoopsChange: value => controller.setStrategyProximityLoops(value),
        onModulesChange: value => controller.setModulesCount(value),
        onModulesImpactReviewLoopsChange: value => controller.setModulesImpactReviewLoops(value),
        onModulesToggle: value => controller.setModulesEnabled(value),
        onIChange: value => {
            const clamped = Math.max(5, Math.min(20, Math.round(value)));
            controller.setI(clamped);
        },
        onJChange: value => {
            const clampedJ = Math.max(3, Math.min(8, Math.round(value)));
            controller.setJ(clampedJ);
            if (controller.getK() > clampedJ) {
                controller.setK(clampedJ);
            }
        },
        onKChange: value => {
            const maxK = Math.max(2, Math.min(8, controller.getJ()));
            const clampedK = Math.max(2, Math.min(maxK, Math.round(value)));
            controller.setK(clampedK);
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

function deferUnmount(root: Root): void {
    const unmount = () => root.unmount();
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(unmount);
    } else {
        setTimeout(unmount, 0);
    }
}

function renderPanel(controller: DeepthinkController): void {
    configPanelRoot?.render(<DeepthinkConfigPanelComponent {...deriveProps(controller)} />);
}

function hideMainHeader(): void {
    const mainHeaderContent = document.querySelector<HTMLElement>('.main-header-content');
    if (mainHeaderContent) mainHeaderContent.style.display = 'none';
}

function disposeRoot(): void {
    if (!configPanelRoot) return;
    const rootToUnmount = configPanelRoot;
    configPanelRoot = null;
    configPanelContainerNode = null;
    deferUnmount(rootToUnmount);
}

function ensureRoot(container: HTMLElement): void {
    if (configPanelRoot && configPanelContainerNode && !document.contains(configPanelContainerNode)) {
        disposeRoot();
    }
    if (configPanelRoot && configPanelContainerNode?.parentElement !== container) {
        disposeRoot();
    }
    if (configPanelRoot) return;

    container.innerHTML = '';
    configPanelContainerNode = document.createElement('div');
    configPanelContainerNode.className = 'deepthink-config-react-root';
    container.appendChild(configPanelContainerNode);
    configPanelRoot = createRoot(configPanelContainerNode);
}

function subscribeToController(controller: DeepthinkController): void {
    unsubscribeControllerEvents?.();
    const render = () => renderPanel(controller);
    const unsubscribe = () => {
        controller.removeEventListener('configchange', render);
        window.removeEventListener('selectedModelChanged', render);
        if (unsubscribeControllerEvents === unsubscribe) unsubscribeControllerEvents = null;
    };
    controller.addEventListener('configchange', render);
    window.addEventListener('selectedModelChanged', render);
    unsubscribeControllerEvents = unsubscribe;
}

export function renderDeepthinkConfigPanelInContainer(pipelinesContentContainer: HTMLElement): void {
    if (!pipelinesContentContainer) return;
    const controller = getDeepthinkConfigController();
    hideMainHeader();
    disableSidebarCollapseButton('Sidebar collapse disabled in config view');
    ensureRoot(pipelinesContentContainer);
    renderPanel(controller);
    subscribeToController(controller);
}
