/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { RoutingManager } from './RoutingManager';

export { callAI, type CallAIOptions } from './AIService';


// Global routing manager instance - initialized lazily
let routingManagerInstance: RoutingManager | null = null;

// Get or create the routing manager instance
export function getRoutingManager(): RoutingManager {
    if (!routingManagerInstance) {
        routingManagerInstance = new RoutingManager();
    }
    return routingManagerInstance;
}

// Initialize routing when this module is imported
export function initializeRouting(): void {
    const manager = getRoutingManager();
    manager.initialize();
}

// Export the routing manager for direct access
export const routingManager = getRoutingManager();

// Get the DeepthinkConfigController for centralized Deepthink config management
export function getDeepthinkConfigController() {
    return getRoutingManager().getDeepthinkConfigController();
}

// Convenience functions for shared routing consumers
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

    // Get provider from the model's configuration
    // getModelProvider returns the provider string (e.g., 'gemini', 'openai', 'anthropic')
    const provider = modelConfigManager.getModelProvider(selectedModel);

    // Normalize 'google' to 'gemini' for consistency
    return provider === 'google' ? 'gemini' : provider;
}
