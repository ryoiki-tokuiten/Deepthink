/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { globalState } from './State';
import { routingManager } from '../Routing';
import {
    ensureAdaptiveDeepthinkInitialized,
    ensureContextualInitialized,
    ensureDeepthinkInitialized,
    getLoadedAdaptiveDeepthinkModule,
    getLoadedContextualModule,
    getLoadedDeepthinkModule
} from './ModeLoader';

let renderToken = 0;

export function activateTab(idToActivate: string | number) {
    if (globalState.currentMode === 'deepthink' && globalState.activeDeepthinkPipeline) {
        globalState.activeDeepthinkPipeline.activeTabId = idToActivate as string;

        // Dispatch event for UI to update tab styles
        window.dispatchEvent(new CustomEvent('updateDeepthinkTabUI', { detail: { id: idToActivate } }));

        if (idToActivate === 'strategic-solver' && globalState.activeDeepthinkPipeline.initialStrategies.length > 0) {
            const deepthink = getLoadedDeepthinkModule();
            if (deepthink) {
                deepthink.activateDeepthinkStrategyTab(globalState.activeDeepthinkPipeline.activeStrategyTab ?? 0);
            } else {
                void ensureDeepthinkInitialized().then(mod => {
                    mod.activateDeepthinkStrategyTab(globalState.activeDeepthinkPipeline!.activeStrategyTab ?? 0);
                });
            }
        }

    }
}

function renderActiveMode() {
    const token = ++renderToken;
    const mode = globalState.currentMode;


    // Dispatch event to allow UI components (like MainContent) to manage their visibility state
    window.dispatchEvent(new CustomEvent('beforeRenderActiveMode', { detail: { mode } }));

    void (async () => {
        if (mode === 'contextual') {
            const mod = await ensureContextualInitialized();
            if (mode !== globalState.currentMode || token !== renderToken) return;
            mod.renderContextualMode();
            return;
        } else if (mode === 'adaptive-deepthink') {
            const mod = await ensureAdaptiveDeepthinkInitialized();
            if (mode !== globalState.currentMode || token !== renderToken) return;
            mod.renderAdaptiveDeepthinkMode();
            return;
        } else if (mode === 'deepthink') {
            const mod = await ensureDeepthinkInitialized();
            if (mode !== globalState.currentMode || token !== renderToken) return;
            if (globalState.activeDeepthinkPipeline) {
                mod.renderActiveDeepthinkPipeline();
            } else {
                const pipelinesContentContainer = document.getElementById('pipelines-content-container');
                if (pipelinesContentContainer) {
                    const panel = await import('../Deepthink/ui/DeepthinkConfigPanel');
                    if (mode !== globalState.currentMode || token !== renderToken) return;
                    if (globalState.activeDeepthinkPipeline) {
                        mod.renderActiveDeepthinkPipeline();
                        return;
                    }
                    panel.renderDeepthinkConfigPanelInContainer(pipelinesContentContainer);
                }
            }
            return;
        }

        throw new Error(`Unknown or unsupported mode in active renderer: ${mode}`);
    })();
}

export function updateUIAfterModeChange() {
    routingManager.setCurrentMode(globalState.currentMode);

    // Notify UI components of mode change
    window.dispatchEvent(new CustomEvent('appModeChanged', { detail: { mode: globalState.currentMode } }));

    setTimeout(() => {
        if ((window as any).reinitializeSidebarControls) {
            (window as any).reinitializeSidebarControls();
        }
    }, 100);



    if (!globalState.isGenerating) {

        if (globalState.currentMode === 'contextual') {
            const contextual = getLoadedContextualModule();
            if (contextual) contextual.stopContextualProcess();
        } else if (globalState.currentMode === 'adaptive-deepthink') {
            const adaptive = getLoadedAdaptiveDeepthinkModule();
            if (adaptive) adaptive.cleanupAdaptiveDeepthinkMode();
        }
    }

    renderActiveMode();
}
