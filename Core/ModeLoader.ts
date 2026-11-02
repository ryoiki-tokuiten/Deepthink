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
    getSelectedThinkingLevel,
} from '../Routing';
import { parseJsonSafe } from './JsonParser';
import { globalState } from './State';
import { updateControlsState } from '../UI/Controls';

type DeepthinkModule = typeof import('../Deepthink/ui/Deepthink');
type ContextualModule = typeof import('../Contextual/Contextual');
type AdaptiveDeepthinkModule = typeof import('../AdaptiveDeepthink/AdaptiveDeepthinkMode');

let deepthinkModule: DeepthinkModule | null = null;
let deepthinkModulePromise: Promise<DeepthinkModule> | null = null;
let deepthinkInitialized = false;

let contextualModule: ContextualModule | null = null;
let contextualModulePromise: Promise<ContextualModule> | null = null;

let adaptiveDeepthinkModule: AdaptiveDeepthinkModule | null = null;
let adaptiveDeepthinkModulePromise: Promise<AdaptiveDeepthinkModule> | null = null;

export async function ensureDeepthinkInitialized(): Promise<DeepthinkModule> {
    if (!deepthinkModulePromise) {
        deepthinkModulePromise = import('../Deepthink/ui/Deepthink').then(mod => (deepthinkModule = mod));
    }
    const mod = await deepthinkModulePromise;
    if (!deepthinkInitialized) {
        const ctrl = routingManager.getDeepthinkConfigController();
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
            getI: () => ctrl.getI(),
            getJ: () => ctrl.getJ(),
            getK: () => ctrl.getK(),
            getIsolateBranchesEnabled,
            getDeepthinkCodeExecutionEnabled: () => ctrl.isCodeExecutionEnabled(),
            getBsrNoiseLevel: () => ctrl.getBsrNoiseLevel(),
            getBsrPressureFloor: () => ctrl.getBsrPressureFloor(),
            getBsrWeightSmall: () => ctrl.getBsrWeightSmall(),
            getBsrWeightMedium: () => ctrl.getBsrWeightMedium(),
            getBsrWeightLarge: () => ctrl.getBsrWeightLarge(),
            getBsrWeightPreset: () => ctrl.getBsrWeightPreset(),
            getSelectedThinkingLevel,
            getCustomPromptsDeepthinkState: () => routingManager.getPromptsManager()?.getDeepthinkPrompts() || globalState.customPromptsDeepthinkState,
            tabsNavContainer: document.getElementById('tabs-nav-container'),
            pipelinesContentContainer: document.getElementById('pipelines-content-container'),
            setActiveDeepthinkPipeline: (pipeline: any) => { globalState.activeDeepthinkPipeline = pipeline; },
        });
        deepthinkInitialized = true;
    }
    return mod;
}

export async function ensureContextualInitialized(): Promise<ContextualModule> {
    if (!contextualModulePromise) {
        contextualModulePromise = import('../Contextual/Contextual').then(mod => (contextualModule = mod));
    }
    return contextualModulePromise;
}

export async function ensureAdaptiveDeepthinkInitialized(): Promise<AdaptiveDeepthinkModule> {
    if (!adaptiveDeepthinkModulePromise) {
        adaptiveDeepthinkModulePromise = import('../AdaptiveDeepthink/AdaptiveDeepthinkMode').then(mod => (adaptiveDeepthinkModule = mod));
    }
    return adaptiveDeepthinkModulePromise;
}

export function getLoadedDeepthinkModule(): DeepthinkModule | null { return deepthinkModule; }
export function getLoadedContextualModule(): ContextualModule | null { return contextualModule; }
export function getLoadedAdaptiveDeepthinkModule(): AdaptiveDeepthinkModule | null { return adaptiveDeepthinkModule; }
