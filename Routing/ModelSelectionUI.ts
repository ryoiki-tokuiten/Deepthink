import { ModelConfigManager, type ModelOption } from './ModelConfig';
import { DeepthinkConfigController } from './DeepthinkConfigController';
import { ApiCallEstimator } from './DeepthinkTokenEstimator';
import { globalState } from '../Core/State';
import { renderIconMarkup } from '../UI/Icons';
import { ProviderManager } from './ProviderManager';

export interface ModelSelectionUIOptions {
    selectElement?: HTMLSelectElement;
    container?: HTMLElement;
    allowGlobalOption?: boolean;
    agentName?: string;
    onModelChange?: (model: string) => void;
}

const GOOGLE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;
const PROVIDER_CONFIG: Record<string, { logo: string; class: string; label: string }> = {
    google: { logo: GOOGLE_SVG, class: 'google', label: 'Google' },
    gemini: { logo: GOOGLE_SVG, class: 'google', label: 'Gemini' },
    openai: {
        logo: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
        class: 'openai',
        label: 'OpenAI'
    },
    anthropic: {
        logo: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.521zm4.132 10.501L8.453 7.687l-2.247 6.334h4.495z"/></svg>`,
        class: 'anthropic',
        label: 'Anthropic'
    },
    local: {
        logo: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>`,
        class: 'local',
        label: 'Local'
    },
    'openai-compatible': { logo: renderIconMarkup('api'), class: 'openai-compatible', label: 'OpenAI Compatible API' },
    meta: {
        logo: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a4.14 4.14 0 0 0 1.756 2.494c.893.593 2.123.893 3.912.893 1.738 0 3.075-.373 3.948-1.166.878-.798 1.317-1.96 1.317-3.439 0-.543-.032-1.089-.095-1.636a44.09 44.09 0 0 0-.26-1.636l-1.353.233c.095.606.171 1.214.228 1.822.057.606.085 1.145.085 1.616 0 1.073-.26 1.86-.778 2.363-.518.504-1.405.756-2.66.756-1.43 0-2.42-.23-2.968-.69-.548-.462-.822-1.158-.822-2.088 0-2.346.6-4.48 1.8-6.404 1.2-1.92 2.53-2.881 3.99-2.881.886 0 1.594.302 2.125.907.532.606.797 1.408.797 2.408 0 .315-.012.63-.036.945-.024.315-.06.63-.107.945l1.353-.233c.054-.315.093-.63.117-.945.024-.315.036-.63.036-.945 0-1.315-.373-2.36-1.12-3.134-.747-.775-1.756-1.162-3.026-1.162zM14.69 4.03c-1.269 0-2.278.388-3.026 1.162-.746.774-1.12 1.82-1.12 3.134 0 .315.012.63.037.945.024.315.063.63.116.945l1.353-.233a12.6 12.6 0 0 1-.107-.945 12.6 12.6 0 0 1-.036-.945c0-1 .265-1.802.797-2.408.531-.605 1.24-.907 2.126-.907 1.46 0 2.79.961 3.99 2.881 1.2 1.924 1.8 4.058 1.8 6.404 0 .93-.275 1.626-.823 2.088-.548.46-1.538.69-2.967.69-1.256 0-2.143-.252-2.66-.756-.52-.503-.78-1.29-.78-2.363 0-.47.029-1.01.086-1.616a44.09 44.09 0 0 1 .228-1.822l-1.353-.233a44.09 44.09 0 0 0-.26 1.636c-.063.547-.095 1.093-.095 1.636 0 1.479.439 2.64 1.317 3.44.873.792 2.21 1.165 3.948 1.165 1.789 0 3.019-.3 3.912-.893a4.14 4.14 0 0 0 1.756-2.494c.14-.604.21-1.267.21-1.973 0-2.566-.704-5.24-2.044-7.306-1.188-1.834-2.903-3.113-4.871-3.113z"/></svg>`,
        class: 'meta',
        label: 'Meta'
    },
    mistral: {
        logo: `<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="4" width="4" height="4" fill="currentColor"/><rect x="6" y="4" width="4" height="4" fill="currentColor" opacity="0.7"/><rect x="14" y="4" width="4" height="4" fill="currentColor" opacity="0.7"/><rect x="18" y="4" width="4" height="4" fill="currentColor"/><rect x="2" y="10" width="4" height="4" fill="currentColor"/><rect x="6" y="10" width="4" height="4" fill="currentColor"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/><rect x="14" y="10" width="4" height="4" fill="currentColor"/><rect x="18" y="10" width="4" height="4" fill="currentColor"/><rect x="2" y="16" width="4" height="4" fill="currentColor"/><rect x="10" y="16" width="4" height="4" fill="currentColor"/><rect x="18" y="16" width="4" height="4" fill="currentColor"/></svg>`,
        class: 'mistral',
        label: 'Mistral'
    }
};

export class ModelSelectionUI {
    private modelConfig: ModelConfigManager;
    private deepthinkConfig: DeepthinkConfigController | null;
    private providerManager: ProviderManager | null;
    private apiCallEstimator: ApiCallEstimator | null = null;
    private activeProvider = 'google';
    private searchQuery = '';
    private options?: ModelSelectionUIOptions;
    private customSelect: HTMLDivElement | null = null;
    private elements = {
        modelSelect: null as HTMLSelectElement | null,
        thinkingLevelSelect: null as HTMLSelectElement | null,
        thinkingLevelContainer: null as HTMLDivElement | null,
    };

    constructor(
        modelConfig: ModelConfigManager,
        deepthinkConfig?: DeepthinkConfigController | null,
        providerManager?: ProviderManager | null,
        options?: ModelSelectionUIOptions
    ) {
        this.modelConfig = modelConfig;
        this.deepthinkConfig = deepthinkConfig || null;
        this.providerManager = providerManager || null;
        this.options = options;
    }

    public initialize(): void {
        if (this.elements.modelSelect) return;
        if (this.options?.selectElement) {
            this.elements.modelSelect = this.options.selectElement;
        } else {
            this.elements.modelSelect = document.getElementById('model-select') as HTMLSelectElement;
            this.elements.thinkingLevelSelect = document.getElementById('thinking-level-select') as HTMLSelectElement;
            this.elements.thinkingLevelContainer = document.getElementById('thinking-level-container') as HTMLDivElement;
        }
        this.createCustomModelSelect();
        this.initializeModelOptions();
        this.initializeEventListeners();
        this.updateThinkingLevelVisibility();
        if (!this.options?.selectElement) {
            this.apiCallEstimator = new ApiCallEstimator(this.modelConfig);
            this.deepthinkConfig?.addEventListener('configchange', () => this.apiCallEstimator?.updateApiCallDisplay());
            this.apiCallEstimator.updateApiCallDisplay();
        }
    }

    private initializeModelOptions(): void {
        if (!this.elements.modelSelect) return;
        if (!this.options?.selectElement || this.elements.modelSelect.options.length === 0) {
            this.elements.modelSelect.innerHTML = '';
            if (this.options?.allowGlobalOption) {
                const globalOpt = document.createElement('option');
                globalOpt.value = '';
                globalOpt.textContent = 'Use Global Model';
                this.elements.modelSelect.appendChild(globalOpt);
            }
            this.modelConfig.getAvailableModels().forEach(model => {
                const option = document.createElement('option');
                option.value = model.value;
                option.textContent = model.label || model.value;
                if (model.description) option.title = model.description;
                this.elements.modelSelect!.appendChild(option);
            });
        }
        if (!this.options?.selectElement) {
            this.elements.modelSelect.value = this.modelConfig.getSelectedModel();
        }
        this.updateCustomSelectOptions();
    }

    public updateModelOptions(): void {
        this.initializeModelOptions();
    }

    private getSelectedModelValue(): string {
        return this.options?.selectElement ? (this.elements.modelSelect?.value || '') : this.modelConfig.getSelectedModel();
    }

    private createCustomModelSelect(): void {
        if (!this.elements.modelSelect) return;
        const container = this.options?.container || this.elements.modelSelect.parentElement;
        if (!container) return;

        const existing = container.querySelector('.model-selector');
        if (existing) {
            this.customSelect = existing as HTMLDivElement;
            return;
        }

        const customSelect = document.createElement('div');
        customSelect.className = 'model-selector';
        if (this.options?.agentName) customSelect.dataset.agent = this.options.agentName;
        else customSelect.id = 'model-selector';

        customSelect.innerHTML = `
            <div class="model-selector-providers"></div>
            <div class="model-selector-models-container">
                <div class="model-search-container">
                    ${renderIconMarkup('Search', 'model-search-icon')}
                    <input type="text" class="model-search-input" placeholder="Search models...">
                </div>
                <div class="model-selector-models"></div>
            </div>
        `;

        const searchInput = customSelect.querySelector<HTMLInputElement>('.model-search-input');
        searchInput?.addEventListener('input', () => {
            this.searchQuery = searchInput.value.trim().toLowerCase();
            this.renderModelsForProvider(this.activeProvider, this.groupAvailableModels(), this.getSelectedModelValue());
        });

        this.customSelect = customSelect;
        if (this.elements.modelSelect.parentElement === container) {
            container.insertBefore(customSelect, this.elements.modelSelect.nextSibling);
        } else {
            container.appendChild(customSelect);
        }
        this.elements.modelSelect.style.display = 'none';
    }

    private queryEl(cls: string, id: string): HTMLElement | null {
        return this.customSelect ? this.customSelect.querySelector<HTMLElement>(cls) : document.getElementById(id);
    }

    private updateCustomSelectOptions(): void {
        const providersContainer = this.queryEl('.model-selector-providers', 'model-selector-providers');
        const modelsContainer = this.queryEl('.model-selector-models', 'model-selector-models');
        if (!providersContainer || !modelsContainer) return;

        const availableModels = this.modelConfig.getAvailableModels();
        const selectedModel = this.getSelectedModelValue();
        const modelsByProvider = this.groupAvailableModels();

        const order = ['google', 'gemini', 'openai', 'anthropic', 'meta', 'mistral', 'local'];
        const allProviders = Array.from(new Set(['gemini', 'openai', 'anthropic', 'local', ...Object.keys(modelsByProvider).map(p => p.toLowerCase())]));
        const sortedProviders = allProviders.sort((a, b) => {
            const ai = order.indexOf(a.toLowerCase());
            const bi = order.indexOf(b.toLowerCase());
            if (ai === -1 && bi === -1) return a.localeCompare(b);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });

        const selectedModelData = availableModels.find(m => m.value === selectedModel);
        if (selectedModelData?.provider) this.activeProvider = selectedModelData.provider.toLowerCase();
        else if (sortedProviders.includes('gemini')) this.activeProvider = 'gemini';
        else if (sortedProviders.includes('google')) this.activeProvider = 'google';
        else if (sortedProviders.length > 0) this.activeProvider = sortedProviders[0].toLowerCase();

        providersContainer.innerHTML = '';
        sortedProviders.forEach(provider => {
            const configured = this.providerManager?.getProviderConfig(provider);
            const config = PROVIDER_CONFIG[provider.toLowerCase()] || {
                logo: configured?.providerType === 'openai-compatible' ? renderIconMarkup('api') : `<span class="provider-letter">${provider.charAt(0).toUpperCase()}</span>`,
                class: configured?.providerType === 'openai-compatible' ? 'openai-compatible' : 'default',
                label: configured?.displayName || provider.charAt(0).toUpperCase() + provider.slice(1)
            };
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = `provider-tab ${config.class} ${provider.toLowerCase() === this.activeProvider ? 'active' : ''}`.trim();
            tab.dataset.provider = provider;
            tab.innerHTML = `<span class="provider-logo">${config.logo}</span>`;
            tab.title = config.label;
            tab.addEventListener('click', () => this.setActiveProvider(provider));
            providersContainer.appendChild(tab);
        });

        this.renderModelsForProvider(this.activeProvider, modelsByProvider, selectedModel);
    }

    private setActiveProvider(provider: string): void {
        this.activeProvider = provider.toLowerCase();
        const searchInput = (this.customSelect ? this.customSelect.querySelector<HTMLInputElement>('.model-search-input') : document.getElementById('model-search-input')) as HTMLInputElement | null;
        if (searchInput) searchInput.value = '';
        this.searchQuery = '';

        const tabs = this.customSelect ? this.customSelect.querySelectorAll('.provider-tab') : document.querySelectorAll('.provider-tab');
        tabs.forEach(tab => tab.classList.toggle('active', (tab as HTMLElement).dataset.provider?.toLowerCase() === this.activeProvider));

        this.renderModelsForProvider(provider, this.groupAvailableModels(), this.getSelectedModelValue());
        this.updateThinkingLevelVisibility();
    }

    private renderModelsForProvider(
        provider: string,
        modelsByProvider: Record<string, ModelOption[]>,
        selectedModel: string
    ): void {
        const modelsContainer = this.queryEl('.model-selector-models', 'model-selector-models');
        if (!modelsContainer) return;
        modelsContainer.innerHTML = '';

        if (this.options?.allowGlobalOption) {
            const isSelected = !selectedModel || selectedModel === '';
            const globalBtn = document.createElement('button');
            globalBtn.type = 'button';
            globalBtn.className = `model-option global-model-option ${isSelected ? 'selected' : ''}`.trim();
            globalBtn.dataset.value = '';
            globalBtn.innerHTML = `
                <div class="global-model-details">
                    <span class="model-name">Use Global Model</span>
                    <span class="global-model-badge">Current: ${this.modelConfig.getSelectedModel() || 'Default'}</span>
                </div>
                ${isSelected ? renderIconMarkup('CircleCheck', 'model-check-icon', {}, 14) : ''}
            `;
            globalBtn.addEventListener('click', () => this.selectModel(''));
            modelsContainer.appendChild(globalBtn);
        }

        const lookupProvider = provider.toLowerCase() === 'google' ? 'gemini' : provider.toLowerCase();
        const providerConfig = this.providerManager?.getProviderConfig(lookupProvider);
        if (!providerConfig?.isConfigured) {
            const displayName = providerConfig?.displayName || (provider.charAt(0).toUpperCase() + provider.slice(1));
            modelsContainer.innerHTML += `
                <div class="provider-unconfigured-container">
                    <div class="provider-unconfigured-icon">${renderIconMarkup('TriangleAlert', 'unconfigured-alert-icon', {}, 28)}</div>
                    <h4 class="provider-unconfigured-title">${displayName} Not Configured</h4>
                    <p class="provider-unconfigured-description">API key or credentials for ${displayName} are not configured in Iterative Studio.</p>
                    <button class="provider-configure-btn model-selector-configure-btn" id="model-selector-configure-btn">
                        ${renderIconMarkup('settings', 'configure-settings-icon', {}, 14)}
                        <span>Configure API Key</span>
                    </button>
                </div>
            `;
            modelsContainer.querySelector('.model-selector-configure-btn')?.addEventListener('click', () => document.getElementById('add-providers-trigger')?.click());
            return;
        }

        const providerKey = Object.keys(modelsByProvider).find(k => k.toLowerCase() === provider.toLowerCase());
        let models = providerKey ? modelsByProvider[providerKey] : [];
        if (this.searchQuery) {
            models = models.filter(m => m.value.toLowerCase().includes(this.searchQuery) || m.label?.toLowerCase().includes(this.searchQuery));
        }

        if (models.length === 0) {
            if (this.searchQuery) {
                modelsContainer.innerHTML += '<div class="no-models">No matching models found</div>';
            } else {
                modelsContainer.innerHTML += `
                    <div class="no-models">
                        No models found for ${providerConfig?.displayName || provider}.<br/>
                        <button class="provider-configure-btn refresh-models-btn model-selector-refresh-btn" id="model-selector-refresh-btn" style="margin-top: 12px; font-size: 11px; padding: 6px 10px;">
                            ${renderIconMarkup('RotateCcw', 'refresh-icon', {}, 12)}
                            <span>Fetch Models</span>
                        </button>
                    </div>
                `;
                const refreshBtn = modelsContainer.querySelector('.model-selector-refresh-btn');
                refreshBtn?.addEventListener('click', async () => {
                    const icon = refreshBtn.querySelector('.refresh-icon');
                    icon?.classList.add('spinning');
                    try { await this.providerManager?.fetchAndSetProviderModels(lookupProvider); }
                    catch (err) { console.error('Fetch failed:', err); }
                    finally { icon?.classList.remove('spinning'); }
                });
            }
            return;
        }

        [...models].sort((a, b) => a.value.localeCompare(b.value)).forEach(model => {
            const isSelected = model.value === selectedModel;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `model-option ${isSelected ? 'selected' : ''}`.trim();
            btn.dataset.value = model.value;
            btn.innerHTML = `<span class="model-name">${model.label || model.value}</span>${isSelected ? renderIconMarkup('CircleCheck', 'model-check-icon', {}, 14) : ''}`;
            btn.addEventListener('click', () => this.selectModel(model.value));
            modelsContainer.appendChild(btn);
        });
    }

    private selectModel(value: string): void {
        if (this.options?.selectElement) {
            if (this.elements.modelSelect) {
                const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
                if (setter) setter.call(this.elements.modelSelect, value);
                else this.elements.modelSelect.value = value;
                this.elements.modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            this.options.onModelChange?.(value);
            this.renderModelsForProvider(this.activeProvider, this.groupAvailableModels(), value);
            return;
        }
        if (this.elements.modelSelect) this.elements.modelSelect.value = value;
        this.modelConfig.setSelectedModel(value);
        this.renderModelsForProvider(this.activeProvider, this.groupAvailableModels(), value);
        this.updateThinkingLevelVisibility();
    }

    private groupAvailableModels(): Record<string, ModelOption[]> {
        return this.modelConfig.getAvailableModels().reduce<Record<string, ModelOption[]>>((acc, model) => {
            const key = (model.provider || 'unknown').toLowerCase();
            (acc[key] ??= []).push(model);
            return acc;
        }, {});
    }

    private initializeEventListeners(): void {
        if (this.elements.modelSelect && !this.options?.selectElement) {
            this.elements.modelSelect.addEventListener('change', () => {
                this.modelConfig.setSelectedModel(this.elements.modelSelect!.value);
                this.updateThinkingLevelVisibility();
            });
        }
        this.elements.thinkingLevelSelect?.addEventListener('change', () => {
            const value = this.elements.thinkingLevelSelect!.value as any;
            globalState.thinkingLevel = value;
            this.modelConfig.updateParameter('thinkingLevel', value);
        });
    }

    public syncUIWithParameters(): void {
        this.updateThinkingLevelVisibility();
        this.apiCallEstimator?.updateApiCallDisplay();
    }

    private updateThinkingLevelVisibility(): void {
        if (!this.elements.thinkingLevelContainer) return;
        const selectedModel = this.modelConfig.getSelectedModel();
        if (this.activeProvider === 'local') {
            this.elements.thinkingLevelContainer.style.display = 'none';
            return;
        }
        const show = this.providerManager?.getReasoningSupportForModel(selectedModel) !== false;
        this.elements.thinkingLevelContainer.style.display = show ? '' : 'none';
        if (show && this.elements.thinkingLevelSelect) {
            this.updateThinkingSelectOptions(this.providerManager?.getReasoningOptionsForModel(selectedModel));
            this.elements.thinkingLevelSelect.value = globalState.thinkingLevel;
        }
    }

    private updateThinkingSelectOptions(customOptions?: string[] | null): void {
        const select = this.elements.thinkingLevelSelect;
        if (!select) return;
        const norm = this.activeProvider.toLowerCase();
        const defaultOpts = (norm === 'google' || norm === 'gemini')
            ? [{ value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]
            : [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }];
        const optionsToRender = customOptions?.length
            ? customOptions.map(opt => ({ value: opt.toLowerCase(), label: opt.toLowerCase() === 'xhigh' ? 'xHigh' : opt.charAt(0).toUpperCase() + opt.slice(1) }))
            : defaultOpts;

        const currentVal = (globalState.thinkingLevel || 'high').toLowerCase();
        select.innerHTML = '';
        optionsToRender.forEach(opt => {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            select.appendChild(el);
        });
        if (optionsToRender.some(opt => opt.value === currentVal)) {
            select.value = currentVal;
        } else if (optionsToRender.length > 0) {
            select.value = optionsToRender.find(opt => opt.value === 'high')?.value || optionsToRender[optionsToRender.length - 1].value;
            globalState.thinkingLevel = select.value as any;
            this.modelConfig.updateParameter('thinkingLevel', select.value as any);
        }
    }
}
