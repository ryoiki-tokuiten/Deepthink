import { globalState } from './State';
import {
    ensureDeepthinkInitialized,
    getLoadedDeepthinkModule
} from './ModeLoader';

let renderToken = 0;

export function activateTab(idToActivate: string | number) {
    if (globalState.activeDeepthinkPipeline) {
        globalState.activeDeepthinkPipeline.activeTabId = idToActivate as string;

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

    void (async () => {
        const mod = await ensureDeepthinkInitialized();
        if (token !== renderToken) return;
        if (globalState.activeDeepthinkPipeline) {
            mod.renderActiveDeepthinkPipeline();
        } else {
            const pipelinesContentContainer = document.getElementById('pipelines-content-container');
            if (pipelinesContentContainer) {
                const panel = await import('../Deepthink/ui/DeepthinkConfigPanel');
                if (token !== renderToken) return;
                if (globalState.activeDeepthinkPipeline) {
                    mod.renderActiveDeepthinkPipeline();
                    return;
                }
                panel.renderDeepthinkConfigPanelInContainer(pipelinesContentContainer);
            }
        }
    })();
}

export function updateUIAfterModeChange() {
    setTimeout(() => {
        if ((window as any).reinitializeSidebarControls) {
            (window as any).reinitializeSidebarControls();
        }
    }, 100);

    renderActiveMode();
}

