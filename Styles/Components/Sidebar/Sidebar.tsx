import React, { useState, useEffect, useRef } from 'react';
import { FileUpload } from './FileUpload';
import { Icon } from '../../../UI/Icons';
import { globalState } from '../../../Core/State';
import { ApplicationMode } from '../../../Core/Types';
import { updateUIAfterModeChange } from '../../../Core/AppRouter';
import { App } from '../../../Core/App';
import { routingManager } from '../../../Routing';
import { getActiveDeepthinkPipeline, stopDeepthinkAnalysisProcess } from '../../../Deepthink/core/deepthinkCore';

const MODE_LABELS: Record<ApplicationMode, string> = {
    'deepthink': 'Deepthink',
    'adaptive-deepthink': 'Adaptive Deepthink',
    'contextual': 'Iterative Corrections',
};

const Sidebar: React.FC = () => {
    const [currentMode, setCurrentMode] = useState<ApplicationMode>(globalState.currentMode as ApplicationMode);
    const [pipelineStatus, setPipelineStatus] = useState<string | null>(() => getActiveDeepthinkPipeline()?.status ?? null);
    const importInputRef = useRef<HTMLInputElement>(null);
    const buttonsContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const attemptMount = () => {
            const ui = routingManager.getProviderManagementUI();
            if (ui && buttonsContainerRef.current) ui.mountButtons(buttonsContainerRef.current);
        };
        attemptMount();
        const intervalId = window.setInterval(() => {
            if (buttonsContainerRef.current && buttonsContainerRef.current.children.length === 0) attemptMount();
        }, 100);
        return () => clearInterval(intervalId);
    }, []);

    useEffect(() => {
        const handleModeChange = () => setCurrentMode(globalState.currentMode as ApplicationMode);
        const handlePipelineUpdate = () => setPipelineStatus(getActiveDeepthinkPipeline()?.status ?? null);
        window.addEventListener('appModeChanged', handleModeChange);
        window.addEventListener('deepthinkPipelineUpdated', handlePipelineUpdate);
        window.addEventListener('deepthinkPipelineStateChanged', handlePipelineUpdate);
        window.addEventListener('controlsStateUpdated', handlePipelineUpdate);
        return () => {
            window.removeEventListener('appModeChanged', handleModeChange);
            window.removeEventListener('deepthinkPipelineUpdated', handlePipelineUpdate);
            window.removeEventListener('deepthinkPipelineStateChanged', handlePipelineUpdate);
            window.removeEventListener('controlsStateUpdated', handlePipelineUpdate);
        };
    }, []);

    const labelText = currentMode === 'contextual' ? 'Initial User Request:' : 'Core Challenge:';
    const placeholderText = currentMode === 'contextual'
        ? 'E.g., "Write a comprehensive guide on machine learning basics", "Create a detailed business plan for a coffee shop"...'
        : currentMode === 'adaptive-deepthink'
            ? 'E.g., "Solve this mathematical problem", "Design a scalable database architecture", "Analyze this complex scenario"...'
            : 'E.g., "Design a sustainable urban transportation system", "Analyze the impact of remote work on company culture"...';

    const isDeepthinkRunning = currentMode === 'deepthink' && (pipelineStatus === 'processing' || pipelineStatus === 'stopping');
    const isDeepthinkPaused = currentMode === 'deepthink' && pipelineStatus === 'stopped';
    const generateButtonText = currentMode === 'contextual'
        ? 'Start Contextual Refinement'
        : currentMode === 'adaptive-deepthink'
            ? 'Adaptive Deepthink'
            : 'Start Deepthink';

    return (
        <aside id="controls-sidebar" className="inspector-panel custom-scrollbar" aria-labelledby="controls-sidebar-heading">
            <header className="sidebar-header">
                <div className="sidebar-header-content">
                    <div id="provider-buttons-mount-point" className="api-key-status-container sidebar-provider-actions" ref={buttonsContainerRef} />
                    <div className="sidebar-header-actions">
                        <button id="theme-toggle-button" className="theme-toggle-button" aria-label="Toggle Theme" title="Toggle Light/Dark Mode">
                            <Icon name="light_mode" />
                        </button>
                        <button id="sidebar-collapse-button" className="sidebar-collapse-button" aria-label="Collapse Sidebar" title="Collapse Sidebar">
                            <Icon name="dock_to_right" />
                        </button>
                    </div>
                </div>
            </header>

            <div className="sidebar-content">
                <div className="input-group">
                    <label htmlFor="initial-idea" id="initial-idea-label" className="input-label">
                        {labelText}
                    </label>
                    <textarea id="initial-idea" className="input-base" placeholder={placeholderText} rows={5} />
                    <FileUpload />
                </div>

                <div className="input-group">
                    <div id="app-mode-selector" className="mode-selector-container" role="radiogroup" aria-label="Select Application Mode">
                        <div className="mode-section">
                            <div className="app-mode-section-label">Application Mode</div>
                            <div className="mode-grid">
                                {(['deepthink', 'adaptive-deepthink', 'contextual'] as ApplicationMode[]).map(mode => {
                                    const isActive = currentMode === mode;
                                    return (
                                        <label key={mode} className={`mode-grid-button ${isActive ? 'active' : ''}`}>
                                            <input
                                                type="radio"
                                                name="app-mode"
                                                value={mode}
                                                checked={isActive}
                                                onChange={e => {
                                                    const newMode = e.target.value as ApplicationMode;
                                                    globalState.currentMode = newMode;
                                                    setCurrentMode(newMode);
                                                    updateUIAfterModeChange();
                                                }}
                                                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                                            />
                                            <span className="mode-button-text">{MODE_LABELS[mode]}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>

                <details className="sidebar-section" open>
                    <summary className="sidebar-section-header">Model & Parameters</summary>
                    <div className="sidebar-section-content">
                        <div id="model-selection-container" className="input-group-tight">
                            <select id="model-select" className="input-base" aria-label="Select AI Model" />
                        </div>

                        <div id="thinking-level-container" className="input-group-tight" style={{ display: 'none' }}>
                            <label htmlFor="thinking-level-select" className="input-label">Thinking / Reasoning Level</label>
                            <select id="thinking-level-select" className="input-base" aria-label="Select Thinking / Reasoning Level">
                                <option value="minimal">Minimal</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="xhigh">xHigh</option>
                                <option value="max">Max</option>
                                <option value="ultra">Ultra</option>
                            </select>
                        </div>

                        <div id="model-parameters-container" className="input-group-tight">
                            <div id="contextual-mode-controls" style={{ display: (currentMode === 'contextual' || currentMode === 'adaptive-deepthink') ? '' : 'none' }}>
                                <div className="code-execution-container">
                                    <div className="code-execution-header">
                                        <Icon name="code" />
                                        <span className="code-execution-title">Sandbox Terminal Environment</span>
                                    </div>
                                    <div className="code-execution-toggle-row">
                                        <label className="toggle-switch">
                                            <input
                                                type="checkbox"
                                                id="sandbox-code-execution-toggle"
                                                aria-label="Enable Sandbox Terminal Environment"
                                                defaultChecked={globalState.virtualEnvironmentEnabled}
                                                onChange={e => {
                                                    globalState.virtualEnvironmentEnabled = e.target.checked;
                                                    window.dispatchEvent(new CustomEvent('sandboxToggled'));
                                                }}
                                            />
                                            <span className="toggle-slider" />
                                        </label>
                                        <span className="toggle-label">Enable Sandbox Execution</span>
                                    </div>
                                    <div className="code-execution-description">
                                        Allow agents to use a persistent sandbox terminal for calculations, verification, scripts, plots, and image manipulation.
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </details>

                <details className="sidebar-section" open>
                    <summary className="sidebar-section-header">Configuration</summary>
                    <div className="sidebar-section-content">
                        <div className="config-buttons-container" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                            <button id="export-config-button" className="button" type="button" onClick={() => App.handleExportConfig()}>
                                <Icon name="upload" />
                                <span className="button-text">Export</span>
                            </button>
                            <input type="file" id="import-config-input" ref={importInputRef} className="sr-only" accept=".json,.gz,.msgpack,.msgpack.gz" onChange={e => App.handleImportConfig(e.nativeEvent)} />
                            <button id="import-config-button" className="button" type="button" onClick={() => importInputRef.current?.click()}>
                                <Icon name="download" />
                                <span className="button-text">Import</span>
                            </button>
                            <div className="config-button-separator" style={{ width: '1px', height: '22px', backgroundColor: 'var(--border-color)', margin: '0 0.1rem', opacity: 0.8 }} />
                            <button
                                id="open-results-button"
                                className="button"
                                type="button"
                                title="Open Results directory in file manager"
                                aria-label="Open Results directory in file manager"
                                style={{ padding: '0 0.65rem' }}
                                onClick={() => import('../../../Core/SandboxToolRuntime').then(m => m.openResultsDirectory())}
                            >
                                <Icon name="database" />
                            </button>
                        </div>
                    </div>
                </details>
            </div>

            <footer className="sidebar-footer">
                {isDeepthinkRunning ? (
                    <button
                        id="stop-button"
                        className="sidebar-stop-button"
                        type="button"
                        onClick={e => {
                            e.preventDefault();
                            stopDeepthinkAnalysisProcess();
                            setPipelineStatus('stopped');
                        }}
                        title="Stop Deepthink"
                    >
                        <Icon name="stop_circle" />
                        <span>Stop</span>
                    </button>
                ) : isDeepthinkPaused ? (
                    <button
                        id="resume-button"
                        className="sidebar-resume-button"
                        type="button"
                        onClick={async e => {
                            e.preventDefault();
                            await App.handleResumeDeepthink();
                        }}
                        title="Resume Deepthink"
                    >
                        <Icon name="play_arrow" />
                        <span>Resume</span>
                    </button>
                ) : (
                    <button
                        id="generate-button"
                        className="button primary-action"
                        type="button"
                        onClick={e => {
                            e.preventDefault();
                            const initialIdeaInput = document.getElementById('initial-idea') as HTMLTextAreaElement | null;
                            App.handleGenerate(initialIdeaInput?.value?.trim() || '');
                        }}
                    >
                        <span className="button-text" id="generate-button-text">{generateButtonText}</span>
                    </button>
                )}
            </footer>
        </aside>
    );
};

export default Sidebar;
