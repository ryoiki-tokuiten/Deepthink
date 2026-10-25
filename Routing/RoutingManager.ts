/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApiKeyManager } from './ApiConfig';
import { ModelConfigManager, ModelOption } from './ModelConfig';
import { ModelSelectionUI } from './ModelSelectionUI';
import { PromptsManager } from './PromptsManager';
import { PromptsModal } from './PromptsModal';
import { ProviderManager } from './ProviderManager';
import { ProviderManagementUI } from './ProviderManagementUI';
import { setApiKeyManager } from './AIService';
import { DeepthinkConfigController } from './DeepthinkConfigController';

export class RoutingManager {
    private apiKeyManager: ApiKeyManager;
    private modelConfigManager: ModelConfigManager;
    private deepthinkConfigController: DeepthinkConfigController;
    private promptsManager: PromptsManager | null = null;
    private promptsModal: PromptsModal | null = null;
    private modelSelectionUI: ModelSelectionUI | null = null;
    private providerManager: ProviderManager;
    private providerManagementUI: ProviderManagementUI | null = null;

    constructor() {
        this.apiKeyManager = new ApiKeyManager();
        this.modelConfigManager = new ModelConfigManager();
        this.deepthinkConfigController = new DeepthinkConfigController(this.modelConfigManager);
        this.providerManager = this.apiKeyManager.getProviderManager();
        // Initialize AI service with the API key manager
        setApiKeyManager(this.apiKeyManager);
    }

    public initialize(): void {
        // Initialize prompts modal first
        if (!this.promptsModal) {
            this.promptsModal = new PromptsModal();
            this.promptsModal.setModelConfig(this.modelConfigManager);
            this.promptsModal.setProviderManager(this.providerManager);
        }

        // Initialize provider management UI with prompts modal
        if (!this.providerManagementUI) {
            this.providerManagementUI = new ProviderManagementUI(this.providerManager, this.promptsModal);
            // Set up callback to refresh models when providers change
            this.providerManagementUI.setOnModelsChangedCallback(() => {
                this.refreshProviders();
            });
        }

        // Subscribe to provider manager updates
        this.providerManager.addModelUpdateListener(() => {
            this.updateAvailableModels();
        });

        // Initialize UI components only when DOM is ready
        if (!this.modelSelectionUI) {
            this.modelSelectionUI = new ModelSelectionUI(this.modelConfigManager, this.deepthinkConfigController, this.providerManager);
        }

        // Update available models from provider manager
        this.updateAvailableModels();

        // Initialize model selection UI
        this.modelSelectionUI.initialize();
    }

    public getThinkingLevel(): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string {
        return this.modelConfigManager.getThinkingLevel();
    }



    private updateAvailableModels(): void {
        const allModels = this.providerManager.getAllModels();
        const modelOptions: ModelOption[] = allModels.map(model => ({
            value: model.id,
            label: model.displayName || model.modelId || model.id,
            description: `${model.providerDisplayName || model.provider} model`,
            provider: model.provider,
            providerLabel: model.providerDisplayName || model.provider,
        }));

        this.modelConfigManager.setAvailableModels(modelOptions);

        // Update model selection UI if it exists
        if (this.modelSelectionUI) {
            this.modelSelectionUI.updateModelOptions();
        }
    }

    public refreshProviders(): void {
        this.updateAvailableModels();
        if (this.providerManagementUI) {
            this.providerManagementUI.updateTriggerState();
        }
    }

    public getApiKeyManager(): ApiKeyManager {
        return this.apiKeyManager;
    }

    public getModelConfigManager(): ModelConfigManager {
        return this.modelConfigManager;
    }

    public getDeepthinkConfigController(): DeepthinkConfigController {
        return this.deepthinkConfigController;
    }

    public getProviderManagementUI(): ProviderManagementUI | null {
        return this.providerManagementUI;
    }

    public getModelSelectionUI(): ModelSelectionUI | null {
        return this.modelSelectionUI;
    }

    public getPromptsManager(): PromptsManager | null {
        return this.promptsManager;
    }

    public initializePromptsManager(
        deepthinkPromptsRef: { current: any },
        contextualPromptsRef?: { current: any }
    ): void {
        this.promptsManager = new PromptsManager(
            deepthinkPromptsRef,
            contextualPromptsRef
        );
    }

    // Convenience methods for accessing common functionality
    public getSelectedModel(): string {
        return this.modelConfigManager.getSelectedModel();
    }

    public getStrategiesCount(): number {
        return this.modelConfigManager.getStrategiesCount();
    }

    public getStrategyProximityLoops(): number {
        return this.modelConfigManager.getStrategyProximityLoops();
    }

    public getModulesImpactReviewLoops(): number {
        return this.modelConfigManager.getModulesImpactReviewLoops();
    }

    public getModulesCount(): number {
        return this.modelConfigManager.getModulesCount();
    }

    public getDeepthinkDepth(): number {
        return this.modelConfigManager.getDeepthinkDepth();
    }

    public isIsolateBranchesEnabled(): boolean {
        return this.modelConfigManager.isIsolateBranchesEnabled();
    }

    public getBsrNoiseLevel(): number {
        return this.modelConfigManager.getBsrNoiseLevel();
    }

    public getBsrPressureFloor(): number {
        return this.modelConfigManager.getBsrPressureFloor();
    }

    public getBsrWeightSmall(): number {
        return this.modelConfigManager.getBsrWeightSmall();
    }

    public getBsrWeightMedium(): number {
        return this.modelConfigManager.getBsrWeightMedium();
    }

    public getBsrWeightLarge(): number {
        return this.modelConfigManager.getBsrWeightLarge();
    }

    public getBsrWeightPreset(): string {
        return this.modelConfigManager.getBsrWeightPreset();
    }

    public hasValidApiKey(): boolean {
        return this.apiKeyManager.hasValidApiKey();
    }

    public setCurrentMode(mode: string) {
        if (this.promptsModal) {
            this.promptsModal.setCurrentMode(mode);
        }
    }

    public updatePromptsModalState(isGenerating: boolean) {
        if (this.promptsModal) {
            this.promptsModal.updateTriggerState(isGenerating);
        }
    }
}
