import { isOpenAICompatibleProvider, ProviderManager, ProviderConfig } from './ProviderManager';
import { renderIconMarkup } from '../UI/Icons';
import {
    deleteSandboxEnvSecret,
    fetchSandboxEnvSecrets,
    saveSandboxEnvSecret,
    type SandboxEnvSecretEntry,
} from '../Core/SandboxToolRuntime';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
const ATLAS_CLOUD_ENDPOINT = 'https://api.atlascloud.ai/v1';
const ATLAS_CLOUD_DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';

function isOpenRouterEndpoint(endpoint?: string): boolean {
    return endpoint?.trim().replace(/\/+$/, '') === OPENROUTER_ENDPOINT;
}

function isAtlasCloudEndpoint(endpoint?: string): boolean {
    return endpoint?.trim().replace(/\/+$/, '') === ATLAS_CLOUD_ENDPOINT;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export class ProviderManagementUI {
    private elements = {
        trigger: null as HTMLElement | null,
        promptsButton: null as HTMLElement | null,
        overlay: null as HTMLElement | null,
        closeButton: null as HTMLElement | null,
        content: null as HTMLElement | null,
    };
    private onModelsChangedCallback?: () => void;
    private envSecrets: SandboxEnvSecretEntry[] = [];

    constructor(private providerManager: ProviderManager, private promptsModal?: any) {
        this.createModal();
        const container = document.getElementById('provider-buttons-mount-point');
        if (container) this.mountButtons(container);

        this.providerManager.addModelUpdateListener(() => {
            if (this.elements.overlay?.style.display === 'flex') this.renderProviderCards();
        });
    }

    public mountButtons(container: HTMLElement): void {
        container.innerHTML = '';
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'provider-buttons-container';

        const triggerButton = document.createElement('button');
        triggerButton.id = 'add-providers-trigger';
        triggerButton.className = 'add-providers-button btn';
        triggerButton.innerHTML = `${renderIconMarkup('key_round')}<span>Providers</span>`;

        const promptsButton = document.createElement('button');
        promptsButton.id = 'prompts-trigger';
        promptsButton.className = 'prompts-button btn';
        promptsButton.innerHTML = `${renderIconMarkup('edit')}<span>Prompts</span>`;

        buttonsContainer.append(triggerButton, promptsButton);
        container.appendChild(buttonsContainer);

        this.elements.trigger = triggerButton;
        this.elements.promptsButton = promptsButton;

        triggerButton.addEventListener('click', () => this.show());
        promptsButton.addEventListener('click', () => this.openPromptsModal());
        this.updateTriggerState();
    }

    private createModal(): void {
        const overlay = document.createElement('div');
        overlay.id = 'provider-management-overlay';
        overlay.className = 'modal-overlay';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="provider-management-title">
                <header class="modal-header">
                    <h2 id="provider-management-title" class="modal-title">${renderIconMarkup('key')} Provider Management</h2>
                    <button id="provider-management-close" class="modal-close-button" aria-label="Close Provider Management">${renderIconMarkup('close')}</button>
                </header>
                <div class="modal-body">
                    <div id="provider-management-content" class="provider-management-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this.elements.overlay = overlay;
        this.elements.closeButton = overlay.querySelector('#provider-management-close');
        this.elements.content = overlay.querySelector('#provider-management-content');

        this.elements.closeButton?.addEventListener('click', () => this.hide());
        overlay.addEventListener('click', e => { if (e.target === overlay) this.hide(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display === 'flex') this.hide(); });
    }

    public show(): void {
        if (!this.elements.overlay) return;
        this.renderProviderCards();
        void this.refreshEnvSecrets();
        this.elements.overlay.style.display = 'flex';
        setTimeout(() => this.elements.overlay!.classList.add('is-visible'), 10);
    }

    public hide(): void {
        if (!this.elements.overlay) return;
        this.elements.overlay.classList.remove('is-visible');
        this.elements.overlay.addEventListener('transitionend', () => {
            if (!this.elements.overlay!.classList.contains('is-visible')) this.elements.overlay!.style.display = 'none';
        }, { once: true });
    }

    private renderProviderCards(): void {
        if (!this.elements.content) return;
        const providers = this.providerManager.getAllProviders().filter(p => !isOpenAICompatibleProvider(p));
        const openAICompatibleProviders = this.providerManager.getOpenAICompatibleProviders();

        this.elements.content.innerHTML = `
            <div class="provider-cards-grid">
                ${providers.map(p => this.renderProviderCard(p)).join('')}
                ${this.renderOpenAICompatibleCard(openAICompatibleProviders)}
                ${this.renderSecretStoreCard()}
            </div>
        `;
        providers.forEach(p => this.attachProviderCardListeners(p));
        openAICompatibleProviders.forEach(p => this.attachProviderCardListeners(p));
        this.attachOpenAICompatibleCardListeners();
        this.attachSecretStoreCardListeners();
    }

    private async refreshEnvSecrets(): Promise<void> {
        try {
            this.envSecrets = await fetchSandboxEnvSecrets();
            if (this.elements.overlay?.style.display === 'flex') {
                this.renderProviderCards();
            }
        } catch {
            // Ignore when backend is not active
        }
    }

    private renderSecretStoreCard(): string {
        const configuredCount = this.envSecrets.length;
        return `
            <div class="provider-card openai-compatible-card secret-store-card" data-provider-id="l3-secret-store" style="min-height: auto;">
                <div class="provider-card-header">
                    <div class="provider-info">
                        <h3 class="provider-name">Secret Store (Global .env)</h3>
                        <div class="provider-status ${configuredCount > 0 ? 'configured' : 'not-configured'}">
                            ${configuredCount > 0 ? `${configuredCount} Configured` : 'Add Secret Key'}
                        </div>
                    </div>
                    <div class="provider-icon">${renderIconMarkup('security')}</div>
                </div>
                <div class="provider-card-body openai-compatible-card-body">
                    <div class="openai-compatible-content">
                        <div class="openai-compatible-instances">
                            ${configuredCount > 0
                                ? this.envSecrets.map(s => this.renderSecretStoreInstance(s)).join('')
                                : '<div class="openai-compatible-empty">No global .env secret keys configured yet.</div>'}
                        </div>
                        <div class="openai-compatible-add-form secret-store-add-form">
                            <div class="openai-compatible-form-title-row">
                                <div class="openai-compatible-form-title">Add or update global .env environment key (L3 Secret Store)</div>
                            </div>
                            <div class="openai-compatible-form-fields">
                                <div class="input-group">
                                    <input type="text" class="secret-store-key-input" placeholder="Environment Key (e.g., HF_TOKEN, WANDB_API_KEY)">
                                    <small class="input-help">Saved in the root .env file (L3) and injected into the agent sandbox environment.</small>
                                </div>
                                <div class="input-group">
                                    <input type="password" class="secret-store-value-input" placeholder="Secret Value">
                                    <small class="input-help">Agents can use $KEY in commands, but cannot read or edit .env (values are redacted from output).</small>
                                </div>
                            </div>
                            <button class="configure-provider-btn add-secret-store-btn">
                                ${renderIconMarkup('add')} Save Secret Key to .env
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private renderSecretStoreInstance(secret: SandboxEnvSecretEntry): string {
        return `
            <div class="openai-compatible-instance" data-secret-key="${escapeHtml(secret.key)}">
                <div class="openai-compatible-instance-header">
                    <div>
                        <div class="openai-compatible-instance-name">${escapeHtml(secret.key)}</div>
                        <div class="openai-compatible-instance-endpoint">$${escapeHtml(secret.key)} · Root .env (L3)</div>
                    </div>
                    <span class="provider-status configured">Configured</span>
                </div>
                <div class="openai-compatible-instance-key">${escapeHtml(secret.maskedValue)}</div>
                <div class="add-model-section">
                    <div class="add-model-and-actions" style="justify-content: flex-end;">
                        <div class="provider-actions">
                            <button class="remove-provider-btn remove-secret-store-btn" data-secret-key="${escapeHtml(secret.key)}">Remove</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private renderOpenAICompatibleCard(providers: ProviderConfig[]): string {
        const configuredCount = providers.length;
        const hasOpenRouter = providers.some(p => isOpenRouterEndpoint(p.baseURL));
        const hasAtlasCloud = providers.some(p => isAtlasCloudEndpoint(p.baseURL));
        return `
            <div class="provider-card openai-compatible-card" data-provider-id="openai-compatible">
                <div class="provider-card-header">
                    <div class="provider-info">
                        <h3 class="provider-name">OpenAI Compatible APIs</h3>
                        <div class="provider-status ${configuredCount > 0 ? 'configured' : 'not-configured'}">
                            ${configuredCount > 0 ? `${configuredCount} Configured` : 'Add Endpoint'}
                        </div>
                    </div>
                    <div class="provider-icon">${renderIconMarkup('api')}</div>
                </div>
                <div class="provider-card-body openai-compatible-card-body">
                    <div class="openai-compatible-content">
                        <div class="openai-compatible-instances">
                            ${providers.length > 0
                                ? providers.map(p => this.renderOpenAICompatibleInstance(p)).join('')
                                : '<div class="openai-compatible-empty">No compatible endpoints configured yet.</div>'}
                        </div>
                        <div class="openai-compatible-add-form">
                            <div class="openai-compatible-form-title-row">
                                <div class="openai-compatible-form-title">Add endpoint</div>
                                <div class="openai-compatible-preset-actions">
                                    ${hasAtlasCloud ? '' : '<button type="button" class="openai-compatible-preset-btn" data-preset="atlas-cloud">Use Atlas Cloud</button>'}
                                    ${hasOpenRouter ? '' : '<button type="button" class="openai-compatible-preset-btn" data-preset="openrouter">Use OpenRouter</button>'}
                                </div>
                            </div>
                            <div class="openai-compatible-form-fields">
                                <div class="input-group"><input type="text" class="openai-compatible-name-input" placeholder="Name (optional)"></div>
                                <div class="input-group">
                                    <input type="url" class="openai-compatible-endpoint-input" placeholder="Endpoint URL (e.g., https://api.example.com/v1)">
                                    <small class="input-help">Use the API base URL that exposes /chat/completions.</small>
                                </div>
                                <div class="input-group"><input type="password" class="openai-compatible-api-key-input" placeholder="API key (optional)"></div>
                                <div class="input-group">
                                    <input type="text" class="openai-compatible-models-input" placeholder="Model IDs (comma-separated)">
                                    <small class="input-help">Leave empty only when the endpoint exposes /models or is listed in Models.dev.</small>
                                </div>
                            </div>
                            <button class="configure-provider-btn add-openai-compatible-btn">
                                ${renderIconMarkup('plus')} Add OpenAI Compatible Endpoint
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private renderOpenAICompatibleInstance(provider: ProviderConfig): string {
        const modelItems = provider.models.length > 0
            ? provider.models.map(model => `
                <div class="model-item custom-model">
                    <span class="model-name">${escapeHtml(model)}</span>
                    <button class="remove-model-btn" data-provider="${escapeHtml(provider.name)}" data-model="${escapeHtml(model)}" aria-label="Remove ${escapeHtml(model)}">
                        ${renderIconMarkup('close')}
                    </button>
                </div>
            `).join('')
            : '<div class="openai-compatible-empty">No models configured yet.</div>';
        const maskedKey = provider.apiKey ? `••••${provider.apiKey.slice(-4)}` : 'No API key';

        return `
            <div class="openai-compatible-instance" data-provider-id="${escapeHtml(provider.name)}">
                <div class="openai-compatible-instance-header">
                    <div>
                        <div class="openai-compatible-instance-name">${escapeHtml(provider.displayName)}</div>
                        <div class="openai-compatible-instance-endpoint">${escapeHtml(provider.baseURL || 'Endpoint URL missing')}</div>
                    </div>
                    <span class="provider-status configured">Configured</span>
                </div>
                <div class="openai-compatible-instance-key">${escapeHtml(maskedKey)}</div>
                <div class="models-section">
                    <h4>Available Models</h4>
                    <div class="models-list">${modelItems}</div>
                </div>
                <div class="add-model-section">
                    <div class="add-model-and-actions">
                        <div class="input-group">
                            <input type="text" class="add-model-input" placeholder="Add model ID" data-provider="${escapeHtml(provider.name)}">
                            <button class="add-model-btn" data-provider="${escapeHtml(provider.name)}">Add</button>
                        </div>
                        <div class="provider-actions">
                            <button class="remove-provider-btn" data-provider="${escapeHtml(provider.name)}">Remove</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private getProviderElement(providerName: string): Element | null {
        if (!this.elements.content) return null;
        return Array.from(this.elements.content.querySelectorAll('[data-provider-id]')).find(el => el.getAttribute('data-provider-id') === providerName) ?? null;
    }

    private renderProviderCard(provider: ProviderConfig): string {
        const isConfigured = provider.isConfigured;
        const isEnvironmentKey = this.isEnvironmentKey(provider.name);
        const icons: Record<string, string> = {
            gemini: '<img src="./Logos/Google.png" alt="Google Gemini" class="provider-logo">',
            openai: '<img src="./Logos/OpenAI.png" alt="OpenAI" class="provider-logo">',
            anthropic: '<img src="./Logos/Anthropic.png" alt="Anthropic" class="provider-logo">',
            local: '<img src="./Logos/Local.png" alt="Local Models" class="provider-logo">',
        };

        return `
            <div class="provider-card" data-provider-id="${provider.name}">
                <div class="provider-card-header">
                    <div class="provider-info">
                        <h3 class="provider-name">${provider.displayName}</h3>
                        <div class="provider-status ${isConfigured ? 'configured' : 'not-configured'}">
                            ${isConfigured ? 'Configured' : 'Not Configured'}
                        </div>
                    </div>
                    <div class="provider-icon">${icons[provider.name] || renderIconMarkup('api')}</div>
                </div>
                <div class="provider-card-body">
                    ${isConfigured ? this.renderConfiguredState(provider, isEnvironmentKey) : this.renderNotConfiguredState(provider)}
                </div>
            </div>
        `;
    }

    private renderConfiguredState(provider: ProviderConfig, isEnvironmentKey: boolean): string {
        const isLocal = provider.name === 'local';
        return `
            <div class="configured-content">
                ${isLocal && provider.apiKey ? `<div class="endpoint-info">${renderIconMarkup('link')}<span class="endpoint-url">Endpoint: ${provider.apiKey}</span></div>` : ''}
                <div class="models-section">
                    <h4>Available Models</h4>
                    <div class="models-list">
                        ${provider.models.map(model => `
                            <div class="model-item ${isLocal ? 'custom-model' : 'default-model'}">
                                <span class="model-name">${model}</span>
                                ${isLocal ? `<button class="remove-model-btn" data-provider="${provider.name}" data-model="${model}">${renderIconMarkup('close')}</button>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="add-model-section">
                    <div class="add-model-and-actions">
                        <div class="input-group">
                            <input type="text" class="add-model-input" placeholder="Add custom model ID" data-provider="${provider.name}">
                            <button class="add-model-btn" data-provider="${provider.name}">Add</button>
                        </div>
                        ${!isEnvironmentKey ? `<div class="provider-actions"><button class="remove-provider-btn" data-provider="${provider.name}">Clear Key</button></div>` : ''}
                    </div>
                    ${isEnvironmentKey ? `<div class="env-key-notice">${renderIconMarkup('info')} API key loaded from environment</div>` : ''}
                </div>
            </div>
        `;
    }

    private renderNotConfiguredState(provider: ProviderConfig): string {
        if (provider.name === 'local') {
            return `
                <div class="not-configured-content">
                    <div class="input-group">
                        <input type="text" class="api-key-input" placeholder="Enter endpoint URL (e.g., http://localhost:1234)" data-provider="${provider.name}">
                        <small class="input-help">The URL of your local model server (LM Studio, Ollama, etc.)</small>
                    </div>
                    <div class="input-group">
                        <input type="text" class="model-ids-input" placeholder="Model IDs (comma-separated, required)" data-provider="${provider.name}">
                        <small class="input-help">Enter the model IDs available on your local server</small>
                    </div>
                    <button class="configure-provider-btn" data-provider="${provider.name}">Configure Local Models</button>
                </div>
            `;
        }
        return `
            <div class="not-configured-content">
                <div class="input-group">
                    <input type="password" class="api-key-input" placeholder="Enter ${provider.displayName} API Key" data-provider="${provider.name}">
                </div>
                <div class="input-group">
                    <input type="text" class="model-ids-input" placeholder="Model IDs (comma-separated, optional)" data-provider="${provider.name}">
                    <small class="input-help">Leave empty to use default models only</small>
                </div>
                <button class="configure-provider-btn" data-provider="${provider.name}">Configure Provider</button>
            </div>
        `;
    }

    private attachProviderCardListeners(provider: ProviderConfig): void {
        const card = this.getProviderElement(provider.name);
        if (!card) return;
        card.querySelector('.configure-provider-btn')?.addEventListener('click', () => this.handleConfigureProvider(provider.name));
        card.querySelector('.remove-provider-btn')?.addEventListener('click', () => this.handleRemoveProvider(provider.name));
        card.querySelector('.add-model-btn')?.addEventListener('click', () => this.handleAddModel(provider.name));
        card.querySelector<HTMLInputElement>('.add-model-input')?.addEventListener('keypress', e => {
            if (e.key === 'Enter') this.handleAddModel(provider.name);
        });
        card.querySelectorAll('.remove-model-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                const button = (e.target as HTMLElement).closest('.remove-model-btn') as HTMLElement;
                this.handleRemoveModel(provider.name, button.dataset.model!);
            });
        });
    }

    private attachOpenAICompatibleCardListeners(): void {
        if (!this.elements.content) return;
        this.elements.content.querySelector('.add-openai-compatible-btn')?.addEventListener('click', () => this.handleAddOpenAICompatibleProvider());
        const form = this.elements.content.querySelector('.openai-compatible-add-form');
        const nameInput = form?.querySelector<HTMLInputElement>('.openai-compatible-name-input');
        const endpointInput = form?.querySelector<HTMLInputElement>('.openai-compatible-endpoint-input');
        const apiKeyInput = form?.querySelector<HTMLInputElement>('.openai-compatible-api-key-input');
        const modelsInput = form?.querySelector<HTMLInputElement>('.openai-compatible-models-input');
        form?.querySelectorAll<HTMLElement>('.openai-compatible-preset-btn').forEach(button => {
            button.addEventListener('click', () => {
                if (!endpointInput) return;
                if (button.dataset.preset === 'atlas-cloud') {
                    if (nameInput) nameInput.value = 'Atlas Cloud';
                    endpointInput.value = ATLAS_CLOUD_ENDPOINT;
                    if (modelsInput) modelsInput.value = ATLAS_CLOUD_DEFAULT_MODEL;
                    apiKeyInput?.focus();
                    return;
                }
                endpointInput.value = OPENROUTER_ENDPOINT;
                endpointInput.focus();
            });
        });
        form?.querySelectorAll('input').forEach(input => {
            input.addEventListener('keypress', event => { if (event.key === 'Enter') this.handleAddOpenAICompatibleProvider(); });
        });
    }

    private attachSecretStoreCardListeners(): void {
        if (!this.elements.content) return;
        const card = this.elements.content.querySelector('.secret-store-card');
        if (!card) return;
        card.querySelector('.add-secret-store-btn')?.addEventListener('click', () => {
            void this.handleAddSecretStoreKey();
        });
        card.querySelectorAll('.secret-store-add-form input').forEach(input => {
            input.addEventListener('keypress', event => {
                if ((event as KeyboardEvent).key === 'Enter') void this.handleAddSecretStoreKey();
            });
        });
        card.querySelectorAll('.remove-secret-store-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                const button = (e.target as HTMLElement).closest('.remove-secret-store-btn') as HTMLElement | null;
                const key = button?.dataset.secretKey;
                if (key) void this.handleRemoveSecretStoreKey(key);
            });
        });
    }

    private async handleAddSecretStoreKey(): Promise<void> {
        const card = this.elements.content?.querySelector('.secret-store-card');
        if (!card) return;
        const keyInput = card.querySelector('.secret-store-key-input') as HTMLInputElement | null;
        const valueInput = card.querySelector('.secret-store-value-input') as HTMLInputElement | null;
        const key = (keyInput?.value || '').trim();
        const value = (valueInput?.value || '').trim();

        if (!key) return this.showError(card, 'Error: Environment key name is required.');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            return this.showError(card, 'Error: Key must contain only letters, numbers, and underscores, and cannot start with a number.');
        }
        if (!value) return this.showError(card, 'Error: Secret value is required.');

        try {
            this.envSecrets = await saveSandboxEnvSecret(key, value);
            if (keyInput) keyInput.value = '';
            if (valueInput) valueInput.value = '';
            this.renderProviderCards();
        } catch (error) {
            this.showError(card, error instanceof Error ? error.message : 'Failed to save Secret Store key.');
        }
    }

    private async handleRemoveSecretStoreKey(key: string): Promise<void> {
        const card = this.elements.content?.querySelector('.secret-store-card');
        try {
            this.envSecrets = await deleteSandboxEnvSecret(key);
            this.renderProviderCards();
        } catch (error) {
            if (card) this.showError(card, error instanceof Error ? error.message : 'Failed to remove Secret Store key.');
        }
    }

    private handleConfigureProvider(providerName: string): void {
        const card = this.getProviderElement(providerName);
        if (!card) return;
        const apiKey = (card.querySelector('.api-key-input') as HTMLInputElement).value.trim();
        const customModels = (card.querySelector('.model-ids-input') as HTMLInputElement).value.split(',').map(m => m.trim()).filter(Boolean);

        if (providerName === 'local') {
            if (!apiKey) return this.showError(card, 'Please enter an endpoint URL');
            if (!customModels.length) return this.showError(card, 'Please enter at least one model ID');
        } else if (!apiKey) {
            return this.showError(card, 'Please enter an API key');
        }

        if (this.providerManager.configureProvider(providerName, apiKey, customModels)) {
            this.updateTriggerState();
            this.renderProviderCards();
            this.onModelsChangedCallback?.();
        } else {
            this.showError(card, providerName === 'local' ? 'Failed to configure local models. Please check your endpoint URL.' : 'Failed to configure provider. Please check your API key.');
        }
    }

    private handleAddOpenAICompatibleProvider(): void {
        const card = this.elements.content?.querySelector('.openai-compatible-card');
        if (!card) return;
        const nameInput = card.querySelector('.openai-compatible-name-input') as HTMLInputElement;
        const endpointInput = card.querySelector('.openai-compatible-endpoint-input') as HTMLInputElement;
        const apiKeyInput = card.querySelector('.openai-compatible-api-key-input') as HTMLInputElement;
        const modelsInput = card.querySelector('.openai-compatible-models-input') as HTMLInputElement;
        const endpoint = endpointInput.value.trim();
        const models = modelsInput.value.split(',').map(m => m.trim()).filter(Boolean);

        if (!endpoint) return this.showError(card, 'Error: Endpoint URL is required.');
        if (isOpenRouterEndpoint(endpoint) && !apiKeyInput.value.trim()) return this.showError(card, 'Error: OpenRouter API key is required.');
        if (!models.length) {
            try {
                if (!new URL(endpoint).hostname) throw new Error();
            } catch {
                return this.showError(card, 'Error: Endpoint URL is invalid.');
            }
        }

        const result = this.providerManager.configureOpenAICompatibleProvider(endpoint, apiKeyInput.value, models, nameInput.value);
        if (!result.success) return this.showError(card, result.error || 'Error: Endpoint URL or API compatibility could not be initialized.');

        nameInput.value = '';
        endpointInput.value = '';
        apiKeyInput.value = '';
        modelsInput.value = '';
        this.updateTriggerState();
        this.renderProviderCards();
        this.onModelsChangedCallback?.();
    }

    private handleRemoveProvider(providerName: string): void {
        const provider = this.providerManager.getProviderConfig(providerName);
        if (confirm(`Are you sure you want to remove the ${provider?.displayName || providerName} provider?`)) {
            this.providerManager.removeProvider(providerName);
            this.updateTriggerState();
            this.renderProviderCards();
            this.onModelsChangedCallback?.();
        }
    }

    private handleAddModel(providerName: string): void {
        const card = this.getProviderElement(providerName);
        if (!card) return;
        const input = card.querySelector('.add-model-input') as HTMLInputElement;
        const modelId = input.value.trim();
        if (!modelId) return this.showError(card, 'Please enter a model ID');
        if (this.providerManager.addCustomModel(providerName, modelId)) {
            input.value = '';
            this.renderProviderCards();
            this.onModelsChangedCallback?.();
        } else {
            this.showError(card, 'Failed to add model or model already exists');
        }
    }

    private handleRemoveModel(providerName: string, modelId: string): void {
        this.providerManager.removeCustomModel(providerName, modelId);
        this.renderProviderCards();
        this.onModelsChangedCallback?.();
    }

    private showError(card: Element, message: string): void {
        card.querySelector('.error-message')?.remove();
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        card.appendChild(errorDiv);
        setTimeout(() => errorDiv.remove(), 3000);
    }

    private isEnvironmentKey(providerName: string): boolean {
        const provider = this.providerManager.getAllProviders().find(p => p.name === providerName);
        if (!provider?.apiKey) return false;
        if (providerName === 'gemini') return provider.apiKey === '__SERVER_ENV__';
        if (providerName === 'openai') return provider.apiKey === process.env.OPENAI_API_KEY;
        if (providerName === 'anthropic') return provider.apiKey === process.env.ANTHROPIC_API_KEY;
        return false;
    }

    public updateTriggerState(): void {
        this.elements.trigger?.classList.toggle('configured', this.providerManager.hasAnyConfiguredProvider());
    }

    public setOnModelsChangedCallback(callback: () => void): void {
        this.onModelsChangedCallback = callback;
    }

    public openPromptsModal(): void {
        this.promptsModal?.show();
    }
}
