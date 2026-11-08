import { RoutingManager } from './RoutingManager';

export { callAI, type CallAIOptions } from './AIService';

let routingManagerInstance: RoutingManager | null = null;

export function getRoutingManager(): RoutingManager {
    if (!routingManagerInstance) {
        routingManagerInstance = new RoutingManager();
    }
    return routingManagerInstance;
}

export function initializeRouting(): void {
    const manager = getRoutingManager();
    manager.initialize();
}

export const routingManager = getRoutingManager();

export function getDeepthinkConfigController() {
    return getRoutingManager().getDeepthinkConfigController();
}

export function getSelectedModel(): string {
    return getRoutingManager().getSelectedModel();
}

export function getSelectedThinkingLevel(): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string {
    return getRoutingManager().getThinkingLevel();
}

export function getSelectedStrategiesCount(): number {
    return getRoutingManager().getStrategiesCount();
}

export function getStrategyProximityLoops(): number {
    return getRoutingManager().getStrategyProximityLoops();
}

export function getSelectedModulesCount(): number {
    return getRoutingManager().getModulesCount();
}

export function getModulesImpactReviewLoops(): number {
    return getRoutingManager().getModulesImpactReviewLoops();
}

export function getDeepthinkDepth(): number {
    return getRoutingManager().getDeepthinkDepth();
}

export function getIsolateBranchesEnabled(): boolean {
    return getRoutingManager().isIsolateBranchesEnabled();
}

export function getBsrNoiseLevel(): number {
    return getRoutingManager().getBsrNoiseLevel();
}

export function getBsrPressureFloor(): number {
    return getRoutingManager().getBsrPressureFloor();
}

export function getBsrWeightSmall(): number {
    return getRoutingManager().getBsrWeightSmall();
}

export function getBsrWeightMedium(): number {
    return getRoutingManager().getBsrWeightMedium();
}

export function getBsrWeightLarge(): number {
    return getRoutingManager().getBsrWeightLarge();
}

export function getBsrWeightPreset(): string {
    return getRoutingManager().getBsrWeightPreset();
}

export function hasValidApiKey(): boolean {
    return getRoutingManager().hasValidApiKey();
}

export function getProviderForCurrentModel(): string {
    const manager = getRoutingManager();
    const modelConfigManager = manager.getModelConfigManager();
    const selectedModel = modelConfigManager.getSelectedModel();

    const configuredProviderType = manager
        .getApiKeyManager()
        .getProviderManager()
        .getProviderTypeForModel(selectedModel);
    if (configuredProviderType) return configuredProviderType;

    const provider = modelConfigManager.getModelProvider(selectedModel);

    return provider === 'google' ? 'gemini' : provider;
}
