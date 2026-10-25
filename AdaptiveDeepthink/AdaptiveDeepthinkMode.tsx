/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Adaptive Deepthink Mode - UI Integration using Adaptive components
 * Uses REAL Deepthink rendering functions and styles from index.css
 */

import React, { useState, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentActivityPanel } from './AgentActivityPanel';
import { Icon } from '../UI/Icons';
import {
    AdaptiveDeepthinkStoreState,
    subscribeToAdaptiveDeepthinkState,
    getAdaptiveDeepthinkState,
    stopAdaptiveDeepthinkProcess,
    updateAdaptiveDeepthinkTab,
    updateAdaptiveDeepthinkStrategyTab
} from './AdaptiveDeepthink';
import {
    createDeepthinkTabContent,
    getVisibleDeepthinkTabs,
    setActiveDeepthinkPipelineForImport,
} from '../Deepthink/ui/Deepthink';

let adaptiveDeepthinkRoot: Root | null = null;

const DeepthinkEmbeddedPanel: React.FC<{ state: AdaptiveDeepthinkStoreState }> = ({ state }) => {
    const pipelineState = state.deepthinkPipelineState;
    const currentTab = state.navigationState.currentTab;
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
        document.getElementById('controls-sidebar')?.classList.contains('collapsed') ?? false
    );

    // Keep Deepthink module in sync with current pipeline state so modals render correctly
    setActiveDeepthinkPipelineForImport(pipelineState);
    if (pipelineState.activeTabId !== currentTab) {
        pipelineState.activeTabId = currentTab;
    }

    const allTabs = getVisibleDeepthinkTabs(pipelineState);
    const preferredTabId = currentTab === 'critique-history'
        ? 'modules-explorer'
        : currentTab;
    const activeTabId = allTabs.some(tab => tab.id === preferredTabId)
        ? preferredTabId
        : (allTabs[0]?.id || 'live');
    pipelineState.activeTabId = activeTabId;
    const deepthinkContent = createDeepthinkTabContent(pipelineState, {
        onStrategyTabClick: updateAdaptiveDeepthinkStrategyTab,
        hideStopButton: true
    });

    useEffect(() => {
        if (activeTabId !== currentTab) {
            updateAdaptiveDeepthinkTab(activeTabId);
        }
    }, [activeTabId, currentTab]);

    useEffect(() => {
        const sidebar = document.getElementById('controls-sidebar');
        if (!sidebar) {
            setIsSidebarCollapsed(false);
            return;
        }

        const syncCollapsedState = () => {
            setIsSidebarCollapsed(sidebar.classList.contains('collapsed'));
        };

        syncCollapsedState();

        const observer = new MutationObserver(syncCollapsedState);
        observer.observe(sidebar, {
            attributes: true,
            attributeFilter: ['class']
        });

        return () => observer.disconnect();
    }, []);

    const handleSidebarToggle = () => {
        const sidebar = document.getElementById('controls-sidebar');
        if (sidebar) {
            sidebar.classList.toggle('collapsed');
            setIsSidebarCollapsed(sidebar.classList.contains('collapsed'));
        }
    };

    return (
        <div className="adaptive-deepthink-embedded-panel">
            <div className="tabs-nav-container">
                {isSidebarCollapsed && (
                    <button
                        className="tab-button deepthink-mode-tab sidebar-toggle-button"
                        onClick={handleSidebarToggle}
                        title="Expand Sidebar"
                    >
                        <Icon name="dock_to_right" />
                    </button>
                )}
                {allTabs.map(tab => {
                    return (
                        <button
                            key={tab.id}
                            id={`deepthink-tab-${tab.id}`}
                            className={`tab-button deepthink-mode-tab ${activeTabId === tab.id ? 'active' : ''} ${tab.statusClass} ${tab.alignRight ? 'align-right' : ''}`}
                            onClick={() => {
                                updateAdaptiveDeepthinkTab(tab.id);
                                if (tab.id === 'live') {
                                    window.dispatchEvent(new CustomEvent('deepthinkLiveTabOpened'));
                                }
                            }}
                        >
                            <Icon name={tab.icon} />
                            {tab.label}
                        </button>
                    );
                })}
            </div>
            <div className="pipelines-content-container">{deepthinkContent}</div>
        </div>
    );
};

const AdaptiveDeepthinkUIView: React.FC = () => {
    const [state, setState] = useState<AdaptiveDeepthinkStoreState | null>(getAdaptiveDeepthinkState());

    useEffect(() => {
        const unsubscribe = subscribeToAdaptiveDeepthinkState(setState);
        return () => { unsubscribe(); };
    }, []);

    if (!state) return null;

    return (
        <div className="adaptive-deepthink-ui-container">
            <DeepthinkEmbeddedPanel state={state} />
            <div className="adaptive-deepthink-agent-panel-wrapper">
                <AgentActivityPanel
                    messages={state.messages}
                    isProcessing={state.isProcessing}
                    isComplete={state.isComplete}
                    error={state.error}
                    onStop={stopAdaptiveDeepthinkProcess}
                />
            </div>
        </div>
    );
};

// Render function
export function renderAdaptiveDeepthinkMode() {
    const container = document.getElementById('pipelines-content-container');
    const tabsContainer = document.getElementById('tabs-nav-container');
    const mainHeaderContent = document.querySelector('.main-header-content') as HTMLElement;

    if (!container || !tabsContainer) return;

    if (adaptiveDeepthinkRoot) {
        adaptiveDeepthinkRoot.unmount();
        adaptiveDeepthinkRoot = null;
    }

    // Clear existing content manually on mount because it isn't managed by this React root yet
    tabsContainer.innerHTML = '';
    container.innerHTML = '';

    if (mainHeaderContent) {
        mainHeaderContent.style.display = 'none';
    }

    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.style.padding = '0';

    const adaptiveDeepthinkContainer = document.createElement('div');
    adaptiveDeepthinkContainer.id = 'adaptive-deepthink-container';
    adaptiveDeepthinkContainer.className = 'pipeline-content active';
    adaptiveDeepthinkContainer.style.height = '100%';
    adaptiveDeepthinkContainer.style.display = 'flex';
    adaptiveDeepthinkContainer.style.flexDirection = 'column';
    container.appendChild(adaptiveDeepthinkContainer);

    adaptiveDeepthinkRoot = createRoot(adaptiveDeepthinkContainer);
    adaptiveDeepthinkRoot.render(<AdaptiveDeepthinkUIView />);
}

// Re-export methods for UI actions that were previously exposed natively
export {
    startAdaptiveDeepthinkProcess,
    stopAdaptiveDeepthinkProcess,
    cleanupAdaptiveDeepthinkMode,
    getAdaptiveDeepthinkState,
    setAdaptiveDeepthinkStateForImport
} from './AdaptiveDeepthink';
