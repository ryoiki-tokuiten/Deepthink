/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ModeLoader - Centralized lazy-loading and one-time initialization for heavy modes.
 */

import {
    routingManager,
    getSelectedModel,
    getSelectedStrategiesCount,
    getStrategyProximityLoops,
    getSelectedModulesCount,
    getModulesImpactReviewLoops,
    getDeepthinkDepth,
    getIsolateBranchesEnabled,
    callAI,
    getSelectedThinkingLevel
} from '../Routing';
import { parseJsonSafe } from './JsonParser';
import { globalState } from './State';
import { updateControlsState } from '../UI/Controls';
import { setupCodeExecutionToggle } from '../UI/setupCodeExecutionToggle';

type DeepthinkModule = typeof import('../Deepthink/ui/Deepthink');
type ContextualModule = typeof import('../Contextual/Contextual');
type AdaptiveDeepthinkModule = typeof import('../AdaptiveDeepthink/AdaptiveDeepthinkMode');

let deepthinkModule: DeepthinkModule | null = null;
let deepthinkModulePromise: Promise<DeepthinkModule> | null = null;
let deepthinkInitialized = false;

let contextualModule: ContextualModule | null = null;
let contextualModulePromise: Promise<ContextualModule> | null = null;
let contextualInitialized = false;

let adaptiveDeepthinkModule: AdaptiveDeepthinkModule | null = null;
let adaptiveDeepthinkModulePromise: Promise<AdaptiveDeepthinkModule> | null = null;

async function loadDeepthinkModule(): Promise<DeepthinkModule> {
    if (!deepthinkModulePromise) {
        deepthinkModulePromise = import('../Deepthink/ui/Deepthink').then((mod) => {
            deepthinkModule = mod;
            return mod;
        });
    }
    return deepthinkModulePromise;
}

async function loadContextualModule(): Promise<ContextualModule> {
    if (!contextualModulePromise) {
        contextualModulePromise = import('../Contextual/Contextual').then((mod) => {
            contextualModule = mod;
            return mod;
        });
    }
    return contextualModulePromise;
}

async function loadAdaptiveDeepthinkModule(): Promise<AdaptiveDeepthinkModule> {
    if (!adaptiveDeepthinkModulePromise) {
        adaptiveDeepthinkModulePromise = import('../AdaptiveDeepthink/AdaptiveDeepthinkMode').then((mod) => {
            adaptiveDeepthinkModule = mod;
            return mod;
        });
    }
    return adaptiveDeepthinkModulePromise;
}

export async function ensureDeepthinkInitialized(): Promise<DeepthinkModule> {
    const mod = await loadDeepthinkModule();
    if (!deepthinkInitialized) {
        mod.initializeDeepthinkModule({
            callAI,
            parseJsonSafe,
            updateControlsState,
            escapeHtml: (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
            getSelectedModel,
            getSelectedStrategiesCount,
            getStrategyProximityLoops,
            getSelectedModulesCount,
            getModulesImpactReviewLoops,
            getDeepthinkDepth,
            getI: () => routingManager.getDeepthinkConfigController().getI(),
            getJ: () => routingManager.getDeepthinkConfigController().getJ(),
            getK: () => routingManager.getDeepthinkConfigController().getK(),
            getIsolateBranchesEnabled,
            getDeepthinkCodeExecutionEnabled: () => routingManager.getDeepthinkConfigController().isCodeExecutionEnabled(),
            getBsrNoiseLevel: () => routingManager.getDeepthinkConfigController().getBsrNoiseLevel(),
            getBsrPressureFloor: () => routingManager.getDeepthinkConfigController().getBsrPressureFloor(),
            getBsrWeightSmall: () => routingManager.getDeepthinkConfigController().getBsrWeightSmall(),
            getBsrWeightMedium: () => routingManager.getDeepthinkConfigController().getBsrWeightMedium(),
            getBsrWeightLarge: () => routingManager.getDeepthinkConfigController().getBsrWeightLarge(),
            getBsrWeightPreset: () => routingManager.getDeepthinkConfigController().getBsrWeightPreset(),
            getSelectedThinkingLevel,
            getCustomPromptsDeepthinkState: () =>
                routingManager.getPromptsManager()?.getDeepthinkPrompts()
                || globalState.customPromptsDeepthinkState,
            tabsNavContainer: document.getElementById('tabs-nav-container'),
            pipelinesContentContainer: document.getElementById('pipelines-content-container'),
            setActiveDeepthinkPipeline: (pipeline: any) => {
                globalState.activeDeepthinkPipeline = pipeline as any;
            }
        });
        deepthinkInitialized = true;
    }
    return mod;
}

export async function ensureContextualInitialized(): Promise<ContextualModule> {
    const mod = await loadContextualModule();
    if (!contextualInitialized) {
        setupCodeExecutionToggle();
        contextualInitialized = true;
    }
    return mod;
}

export async function ensureAdaptiveDeepthinkInitialized(): Promise<AdaptiveDeepthinkModule> {
    return loadAdaptiveDeepthinkModule();
}

export function getLoadedDeepthinkModule(): DeepthinkModule | null {
    return deepthinkModule;
}

export function getLoadedContextualModule(): ContextualModule | null {
    return contextualModule;
}

export function getLoadedAdaptiveDeepthinkModule(): AdaptiveDeepthinkModule | null {
    return adaptiveDeepthinkModule;
}
