/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deepthink — Module logic, state management, initialization, and event coordination.
 * All rendering (JSX) lives in Deepthink.tsx. This file contains ZERO innerHTML/HTML strings.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { onHighlighterReady } from '../../Styles/Shiki';
import { renderIconMarkup } from '../../UI/Icons';

// React component imports
import {
    BaseModal,
    EmbeddedModalContent,
    StrategicSolverTab,
    ModulesExplorerTab,
    FinalResultTab,
} from './Deepthink.tsx';

import { DeepthinkLiveTab } from './DeepthinkLiveTab.tsx';
import { DeepthinkFilesystemTab } from './DeepthinkFilesystemTab.tsx';

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
    saveLatestDeepthinkState
} from '../core/deepthinkCore';

export { resumeDeepthinkAnalysisProcess, stopDeepthinkAnalysisProcess, saveLatestDeepthinkState };

// ============================================================================ 
// Types & Re-exports
// ============================================================================ 

export type {
    DeepthinkSolutionCritiqueData,
    DeepthinkModuleData,
    DeepthinkMainStrategyData,
    DeepthinkPipelineState
};

export {
    startDeepthinkAnalysisProcess,
    getActiveDeepthinkPipeline,
    setActiveDeepthinkPipelineForImport
};

export { DeepthinkPipelineOrchestrator } from '../core/pipelineOrchestrator';

interface DeepthinkTabDefinition {
    id: string;
    label: string;
    icon: string;
    alignRight?: boolean;
    statusClass: string;
}

// ============================================================================ 
// Module State
// ============================================================================ 

interface DeepthinkModuleState {
    tabsNavContainer: HTMLElement | null;
    pipelinesContentContainer: HTMLElement | null;
    escapeHtml: (unsafe: string) => string;
}

const moduleState: DeepthinkModuleState = {
    tabsNavContainer: null,
    pipelinesContentContainer: null,
    escapeHtml: (s) => s,
};

let activeSolutionModalStrategyId: string | null = null;

// React roots for React-rendered content
let pipelineContentRoot: Root | null = null;
let pipelineContentContainerNode: HTMLElement | null = null;
let modalRoot: Root | null = null;
let modalContainer: HTMLElement | null = null;
let filesystemRedirectListenerRegistered = false;

// ============================================================================ 
// Initialization
// ============================================================================ 

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
        if (getActiveDeepthinkPipeline()) {
            renderActiveDeepthinkPipeline();
        }
    });

    if (!filesystemRedirectListenerRegistered) {
        filesystemRedirectListenerRegistered = true;
        window.addEventListener('openDeepthinkFilesystem', () => {
            const process = getActiveDeepthinkPipeline();
            if (!process) return;
            if (document.getElementById('solution-modal-overlay')) {
                removeDeepthinkSolutionOverlay(true);
            }
            process.activeTabId = 'filesystem';
            renderActiveDeepthinkPipeline();
        });
    }

    initializeDeepthinkCore({
        ...dependencies,
        renderActiveDeepthinkPipeline
    });

    window.addEventListener('deepthinkPipelineUpdated', () => {
        if (getActiveDeepthinkPipeline()) {
            renderActiveDeepthinkPipeline();
        }
    });
}

// ============================================================================ 
// Modal Logic (React-rendered)
// ============================================================================ 

function ensureModalContainer(): HTMLElement {
    if (!modalContainer) {
        modalContainer = document.createElement('div');
        modalContainer.id = 'deepthink-modal-portal';
        document.body.appendChild(modalContainer);
    }
    return modalContainer;
}

function ensureModalRoot(): Root {
    const container = ensureModalContainer();
    if (!modalRoot) {
        modalRoot = createRoot(container);
    }
    return modalRoot;
}

function mountModal(element: React.ReactElement): void {
    ensureModalRoot().render(element);
}

function unmountModal(): void {
    if (modalRoot) {
        modalRoot.render(null);
    }
    activeSolutionModalStrategyId = null;
}

function removeDeepthinkSolutionOverlay(immediate = true): void {
    const overlay = document.getElementById('solution-modal-overlay') as (HTMLElement & {
        cleanup?: () => void;
    }) | null;

    if (!overlay) {
        return;
    }

    overlay.cleanup?.();

    if (immediate) {
        overlay.remove();
    } else {
        overlay.classList.remove('is-visible');
        setTimeout(() => {
            if (overlay.isConnected) {
                overlay.remove();
            }
        }, 200);
    }

    activeSolutionModalStrategyId = null;
}

function findSolutionModalStrategy(pipeline: DeepthinkPipelineState, strategyId: string): DeepthinkMainStrategyData | undefined {
    return pipeline.initialStrategies?.find(candidate => candidate.id === strategyId)
        ?? pipeline.prunedBranches?.find((candidate: DeepthinkMainStrategyData) => candidate.id === strategyId);
}

async function openDeepthinkSolutionModal(strategyId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    const strategy = pipeline && findSolutionModalStrategy(pipeline, strategyId);
    if (!strategy) return;

    removeDeepthinkSolutionOverlay(true);
    unmountModal();
    activeSolutionModalStrategyId = strategyId;

    // The branch-history viewer owns an imperative rendering lifecycle.
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
    body.className = 'modal-body';
    body.style.padding = '0';
    body.style.height = 'calc(100vh - 80px)';
    body.style.overflow = 'hidden';
    body.classList.add('contextual-mode-container');

    content.appendChild(header);
    content.appendChild(body);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const close = () => removeDeepthinkSolutionOverlay(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    overlay.cleanup = () => document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.classList.add('is-visible'), 10);

    await updateSolutionModalContent(body, strategyId);
}

function openModuleArgumentModal(moduleId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    const allModules = [
        ...((pipeline?.modulesHistory || []).flat()),
        ...(pipeline?.modules || []),
    ];
    const mod = allModules.find(m => m.id === moduleId);
    if (!mod || document.querySelector('.embedded-modal-overlay')) return;

    const close = () => unmountModal();
    mountModal(
        React.createElement(BaseModal, {
            title: 'Module Argument',
            isEmbedded: true,
            onClose: close,
            children: React.createElement(EmbeddedModalContent, {
                content: mod.testerAttemptDisplay || mod.testerAttempt || 'No argument available',
                contentClass: 'module-argument-content',
            })
        })
    );
}

async function updateSolutionModalContent(modalBody: HTMLElement, strategyId: string) {
    const pipeline = getActiveDeepthinkPipeline();
    if (!pipeline) return;

    const strategy = findSolutionModalStrategy(pipeline, strategyId);
    if (!strategy) return;

    // Subsequent iterations
    const laterIterations = (strategy.iterationHistory?.iterations || []).map((iteration: any, index: number) => {
        const iterNum = iteration.iterationNumber === 1 ? (index + 2) : (iteration.iterationNumber || (index + 2));
        return {
            ...iteration,
            iterationNumber: iterNum,
            critique: iteration.critiqueDisplay || iteration.critique,
            correctedSolution: iteration.correctedSolutionDisplay || iteration.correctedSolution,
        };
    });

    // Iteration 1 (initial execution + critique)
    const iter1 = {
        iterationNumber: laterIterations.length > 0 ? Math.max(1, laterIterations[0].iterationNumber - 1) : 1,
        correctedSolution: strategy.solutionAttemptDisplay || strategy.solutionAttempt || '',
        correctedSolutionExecutionTraceText: strategy.solutionAttemptExecutionTraceText,
        critique: strategy.solutionCritiqueDisplay || strategy.solutionCritique || '',
        critiqueExecutionTraceText: strategy.solutionCritiqueExecutionTraceText,
        timestamp: Date.now() - 10000 // Arbitrary older timestamp to force order
    };

    // Exclude empty iterations
    const allIterations = [iter1, ...laterIterations].filter(it => it.correctedSolution || it.critique);

    const originalSolution = allIterations[0]?.correctedSolution || 'Processing...';
    const latestCorrection = allIterations.length > 0 ? allIterations[allIterations.length - 1]?.correctedSolution : null;
    const currentBestSolution = latestCorrection || originalSolution;
    
    const isProcessing = strategy.status === 'processing' ||
        strategy.status === 'pending' ||
        strategy.solutionCritiqueStatus === 'processing' ||
        strategy.solutionCritiqueStatus === 'pending' ||
        strategy.correctionStatus === 'processing' ||
        strategy.correctionStatus === 'pending' ||
        strategy.iterationHistory?.status === 'processing';

    const { renderBranchHistoryUI } = await import('../../Contextual/ContextualUI');
    await renderBranchHistoryUI(
        modalBody,
        originalSolution,
        currentBestSolution,
        allIterations,
        isProcessing
    );
}

async function updateActiveSolutionModal() {
    if (activeSolutionModalStrategyId && document.getElementById('solution-modal-overlay')) {
        const modalBody = document.querySelector('#solution-modal-overlay .modal-body') as HTMLElement;
        if (modalBody) {
            await updateSolutionModalContent(modalBody, activeSolutionModalStrategyId);
        }
    }
}

export function activateDeepthinkStrategyTab(strategyIndex: number) {
    const pipeline = getActiveDeepthinkPipeline();
    if (!pipeline) return;
    pipeline.activeStrategyTab = strategyIndex;
    renderActiveDeepthinkPipeline();
}

function syncDeepthinkDomReferences() {
    const nextTabsNavContainer = document.getElementById('tabs-nav-container');
    const nextPipelinesContentContainer = document.getElementById('pipelines-content-container');

    moduleState.tabsNavContainer = nextTabsNavContainer;
    moduleState.pipelinesContentContainer = nextPipelinesContentContainer;
}

// ============================================================================ 
// Main Pipeline Render
// ============================================================================ 

export function renderActiveDeepthinkPipeline() {
    const deepthinkProcess = getActiveDeepthinkPipeline();
    syncDeepthinkDomReferences();
    const { tabsNavContainer, pipelinesContentContainer } = moduleState;

    if (!deepthinkProcess || !tabsNavContainer || !pipelinesContentContainer) return;

    // Restore UI state
    const sidebarBtn = document.getElementById('sidebar-collapse-button') as HTMLButtonElement;
    if (sidebarBtn) {
        sidebarBtn.disabled = false;
        sidebarBtn.style.opacity = '';
        sidebarBtn.style.cursor = '';
    }

    const header = document.querySelector('.main-header-content') as HTMLElement;
    if (header) header.style.display = '';
    moduleState.tabsNavContainer!.style.display = '';

    updateActiveSolutionModal().catch(() => { });

    // Clear Previous
    moduleState.tabsNavContainer!.innerHTML = '';

    // Unmount existing React content root ONLY if the container is different (which shouldn't happen)
    // We want to reuse the root for React 18 update semantics to avoid synchronous unmount errors

    const tabs = getVisibleDeepthinkTabs(deepthinkProcess);

    if (!tabs.some(t => t.id === deepthinkProcess.activeTabId) && tabs.length > 0) {
        const wasRemovedCritiqueTab = deepthinkProcess.activeTabId === 'critique-history';
        const contextTab = tabs.find(tab => tab.id === 'modules-explorer');
        deepthinkProcess.activeTabId = wasRemovedCritiqueTab && contextTab
            ? contextTab.id
            : tabs[0].id;
    }

    // Render Tab buttons (imperative — lightweight DOM, React overhead not needed here)
    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.id = `deepthink-tab-${tab.id}`;
        btn.className = `tab-button deepthink-mode-tab ${deepthinkProcess.activeTabId === tab.id ? 'active' : ''} ${tab.statusClass} ${tab.alignRight ? 'align-right' : ''}`;
        btn.innerHTML = `${renderIconMarkup(tab.icon)}${tab.label}`;
        btn.addEventListener('click', () => {
            deepthinkProcess.activeTabId = tab.id;
            if (tab.id === 'live') {
                window.dispatchEvent(new CustomEvent('deepthinkLiveTabOpened'));
            }
            renderActiveDeepthinkPipeline();
        });
        moduleState.tabsNavContainer!.appendChild(btn);
    });

    // Mount or update React content root
    const contentContainer = moduleState.pipelinesContentContainer!;

    // Unmount explicitly if the DOM node was wiped by the AppRouter
    if (pipelineContentRoot && pipelineContentContainerNode && !document.contains(pipelineContentContainerNode)) {
        const oldRoot = pipelineContentRoot;
        setTimeout(() => oldRoot.unmount(), 0);
        pipelineContentRoot = null;
        pipelineContentContainerNode = null;
    }

    if (!pipelineContentRoot) {
        contentContainer.innerHTML = '';
        pipelineContentContainerNode = document.createElement('div');
        pipelineContentContainerNode.className = 'deepthink-pipeline-react-root';
        contentContainer.appendChild(pipelineContentContainerNode);

        pipelineContentRoot = createRoot(pipelineContentContainerNode);
    }

    const tabContent = createDeepthinkTabContent(deepthinkProcess);
    window.dispatchEvent(new CustomEvent('deepthinkPipelineStateChanged'));
    pipelineContentRoot.render(tabContent);

}

type DeepthinkTabContentCallbacks = {
    onStrategyTabClick?: (idx: number) => void;
    onViewSolution?: (id: string) => void;
    onViewArgument?: (id: string) => void;
    onViewReasoning?: (id: string) => void;
    onViewBsr?: (id: string) => void;
    hideStopButton?: boolean;
};

function getDeepthinkTabVisibility(process: DeepthinkPipelineState): {
    showFilesystem: boolean;
    showCuratedContext: boolean;
} {
    const config = process.runConfig;
    return {
        showFilesystem: true,
        showCuratedContext: config ? config.modulesCount > 0 : true,
    };
}

export function getVisibleDeepthinkTabs(process: DeepthinkPipelineState): DeepthinkTabDefinition[] {
    const { showFilesystem, showCuratedContext } = getDeepthinkTabVisibility(process);
    return [
        { id: 'live', label: 'Live', icon: 'terminal', visible: true },
        { id: 'filesystem', label: 'Filesystem', icon: 'folder', visible: showFilesystem },
        { id: 'strategic-solver', label: 'Branches', icon: 'psychology', visible: true },
        { id: 'modules-explorer', label: 'Curated Context', icon: 'science', visible: showCuratedContext },
        { id: 'final-result', label: 'Final Result', icon: 'flag', visible: true, alignRight: true }
    ]
        .filter(tab => tab.visible)
        .map(({ visible, ...tab }) => ({
            ...tab,
            statusClass: getTabStatusClass(tab.id, process)
        }));
}

export function createDeepthinkTabContent(
    process: DeepthinkPipelineState,
    callbacks: DeepthinkTabContentCallbacks = {}
): React.ReactElement {
    const onStrategyTabClick = callbacks.onStrategyTabClick ?? ((idx: number) => {
        process.activeStrategyTab = idx;
        renderActiveDeepthinkPipeline();
    });
    const onViewSolution = callbacks.onViewSolution ?? ((id: string) => openDeepthinkSolutionModal(id));
    const onViewArgument = callbacks.onViewArgument ?? ((id: string) => openModuleArgumentModal(id));

    switch (process.activeTabId) {
        case 'live':
            return React.createElement(DeepthinkLiveTab, { process, hideStopButton: callbacks.hideStopButton });
        case 'filesystem':
            return React.createElement(DeepthinkFilesystemTab, {
                key: process.id,
                repositoryId: process.id,
            });
        case 'strategic-solver':
            return React.createElement(StrategicSolverTab, {
                process,
                escapeHtml: moduleState.escapeHtml,
                onStrategyTabClick,
                onViewSolution,
            });
        case 'modules-explorer':
            return React.createElement(ModulesExplorerTab, {
                process,
                onViewArgument,
            });
        case 'final-result':
            return React.createElement(FinalResultTab, {
                process,
                escapeHtml: moduleState.escapeHtml,
            });
        default:
            return React.createElement(DeepthinkLiveTab, { process });
    }
}

// ============================================================================ 
// Tab Status Helper
// ============================================================================ 

function getTabStatusClass(tabId: string, process: DeepthinkPipelineState): string {
    switch (tabId) {
        case 'live':
            if (process.status === 'error') return 'status-deepthink-error';
            if (process.status === 'completed') return 'status-deepthink-completed';
            if (process.status === 'processing') return 'status-deepthink-processing';
            return '';
        case 'strategic-solver':
            if (process.status === 'error') return 'status-deepthink-error';
            if (process.initialStrategies?.some(s => s.status === 'completed')) return 'status-deepthink-completed';
            if (process.initialStrategies?.some(s => s.status === 'processing')) return 'status-deepthink-processing';
            return '';
        case 'modules-explorer':
            if (process.modules?.some(m => m.testerStatus === 'error')) return 'status-deepthink-error';
            if (process.modules?.some(m => m.testerStatus === 'processing')) return 'status-deepthink-processing';
            if (process.modules?.some(m => m.testerStatus === 'completed')) return 'status-deepthink-completed';
            return process.modulesExplorerComplete ? 'status-deepthink-completed' : '';
        case 'final-result':
            if (process.finalJudgingStatus === 'completed') return 'status-deepthink-completed';
            if (process.finalJudgingStatus === 'error') return 'status-deepthink-error';
            if (process.finalJudgingStatus === 'processing') return 'status-deepthink-processing';
            return '';
        default: return '';
    }
}
