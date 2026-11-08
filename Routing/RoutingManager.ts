import { ApiKeyManager, setApiKeyManager } from './AIService';
import { ModelConfigManager, ModelOption } from './ModelConfig';
import { ModelSelectionUI } from './ModelSelectionUI';
import { PromptsManager } from './PromptsManager';
import { PromptsModal } from './PromptsModal';
import { ProviderManager } from './ProviderManager';
import { ProviderManagementUI } from './ProviderManagementUI';
import { DeepthinkConfigController } from './DeepthinkConfigController';

export class RoutingManager {
    private apiKeyManager = new ApiKeyManager();
    private modelConfigManager = new ModelConfigManager();
    private deepthinkConfigController = new DeepthinkConfigController(this.modelConfigManager);
    private promptsManager: PromptsManager | null = null;
    private promptsModal: PromptsModal | null = null;
    private modelSelectionUI: ModelSelectionUI | null = null;
    private providerManager: ProviderManager = this.apiKeyManager.getProviderManager();
    private providerManagementUI: ProviderManagementUI | null = null;

    constructor() {
        setApiKeyManager(this.apiKeyManager);
    }

    public initialize(): void {
        if (!this.promptsModal) {
            this.promptsModal = new PromptsModal();
            this.promptsModal.setModelConfig(this.modelConfigManager);
            this.promptsModal.setProviderManager(this.providerManager);
        }
        if (!this.providerManagementUI) {
            this.providerManagementUI = new ProviderManagementUI(this.providerManager, this.promptsModal);
            this.providerManagementUI.setOnModelsChangedCallback(() => this.refreshProviders());
        }
        this.providerManager.addModelUpdateListener(() => this.updateAvailableModels());
        if (!this.modelSelectionUI) {
            this.modelSelectionUI = new ModelSelectionUI(this.modelConfigManager, this.deepthinkConfigController, this.providerManager);
        }
        this.updateAvailableModels();
        this.modelSelectionUI.initialize();
    }

    private updateAvailableModels(): void {
        const modelOptions: ModelOption[] = this.providerManager.getAllModels().map(m => ({
            value: m.id,
            label: m.displayName || m.modelId || m.id,
            description: `${m.providerDisplayName || m.provider} model`,
            provider: m.provider,
            providerLabel: m.providerDisplayName || m.provider,
        }));
        this.modelConfigManager.setAvailableModels(modelOptions);
        this.modelSelectionUI?.updateModelOptions();
    }

    public refreshProviders(): void {
        this.updateAvailableModels();
        this.providerManagementUI?.updateTriggerState();
    }

    public getThinkingLevel() { return this.modelConfigManager.getThinkingLevel(); }
    public getApiKeyManager() { return this.apiKeyManager; }
    public getModelConfigManager() { return this.modelConfigManager; }
    public getDeepthinkConfigController() { return this.deepthinkConfigController; }
    public getProviderManagementUI() { return this.providerManagementUI; }
    public getModelSelectionUI() { return this.modelSelectionUI; }
    public getPromptsManager() { return this.promptsManager; }

    public initializePromptsManager(deepthinkPromptsRef: { current: any }): void {
        this.promptsManager = new PromptsManager(deepthinkPromptsRef);
    }

    public getSelectedModel() { return this.modelConfigManager.getSelectedModel(); }
    public getStrategiesCount() { return this.modelConfigManager.getStrategiesCount(); }
    public getStrategyProximityLoops() { return this.modelConfigManager.getStrategyProximityLoops(); }
    public getModulesImpactReviewLoops() { return this.modelConfigManager.getModulesImpactReviewLoops(); }
    public getModulesCount() { return this.modelConfigManager.getModulesCount(); }
    public getDeepthinkDepth() { return this.modelConfigManager.getDeepthinkDepth(); }
    public isIsolateBranchesEnabled() { return this.modelConfigManager.isIsolateBranchesEnabled(); }
    public getBsrNoiseLevel() { return this.modelConfigManager.getBsrNoiseLevel(); }
    public getBsrPressureFloor() { return this.modelConfigManager.getBsrPressureFloor(); }
    public getBsrWeightSmall() { return this.modelConfigManager.getBsrWeightSmall(); }
    public getBsrWeightMedium() { return this.modelConfigManager.getBsrWeightMedium(); }
    public getBsrWeightLarge() { return this.modelConfigManager.getBsrWeightLarge(); }
    public getBsrWeightPreset() { return this.modelConfigManager.getBsrWeightPreset(); }
    public hasValidApiKey() { return this.apiKeyManager.hasValidApiKey(); }
    public updatePromptsModalState(isGenerating: boolean) { this.promptsModal?.updateTriggerState(isGenerating); }
}

