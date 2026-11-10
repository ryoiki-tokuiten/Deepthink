import { nanoid } from 'nanoid';
import { AIProvider, createAIProvider, DiscoveredModel } from './AIProvider';

export interface ModelsDevReasoningOption {
    type?: string;
    options?: string[];
    values?: string[];
    min?: number;
    max?: number;
    default?: string | number;
}

export interface ModelsDevModel {
    id: string;
    name?: string;
    description?: string;
    tool_call?: boolean;
    structured_output?: boolean;
    reasoning?: boolean;
    reasoning_options?: ModelsDevReasoningOption[];
    modalities?: { input?: string[]; output?: string[] };
}

interface ModelsDevProvider {
    id?: string;
    name?: string;
    api?: string;
    models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;
interface CachedCatalog { fetchedAt: number; catalog: ModelsDevCatalog; }

const MODELS_DEV_URL = 'https://models.dev/api.json';
const STORAGE_KEY = 'models-dev-catalog-v1';
const FRESH_FOR_MS = 6 * 60 * 60 * 1000;
const ACCEPT_STALE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

let memoryCache: CachedCatalog | null = null;
let inFlightRequest: Promise<ModelsDevCatalog | null> | null = null;

function normalizeEndpoint(endpoint: string): string {
    return endpoint.trim().replace(/\/+$/, '').toLowerCase();
}

function readStoredCatalog(): CachedCatalog | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedCatalog;
        return parsed && typeof parsed.fetchedAt === 'number' && parsed.catalog && typeof parsed.catalog === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

async function fetchCatalog(): Promise<ModelsDevCatalog | null> {
    try {
        const response = await fetch(MODELS_DEV_URL, { headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        const catalog = await response.json();
        if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: Date.now(), catalog }));
        } catch {  }
        memoryCache = { fetchedAt: Date.now(), catalog };
        return catalog;
    } catch {
        return null;
    }
}

export async function loadCatalog(): Promise<ModelsDevCatalog | null> {
    const now = Date.now();
    const cached = memoryCache ?? readStoredCatalog();
    if (cached) {
        memoryCache = cached;
        if (now - cached.fetchedAt < FRESH_FOR_MS) return cached.catalog;
        if (now - cached.fetchedAt < ACCEPT_STALE_FOR_MS) {
            if (!inFlightRequest) inFlightRequest = fetchCatalog().finally(() => { inFlightRequest = null; });
            return cached.catalog;
        }
    }
    if (!inFlightRequest) inFlightRequest = fetchCatalog().finally(() => { inFlightRequest = null; });
    return inFlightRequest;
}

export function findModelsDevProvider(catalog: ModelsDevCatalog, providerOrEndpoint: string): ModelsDevProvider | null {
    if (!providerOrEndpoint) return null;
    const target = providerOrEndpoint.trim().toLowerCase();
    const normalizedEndpoint = normalizeEndpoint(providerOrEndpoint);
    if (catalog[target]) return catalog[target];
    return Object.values(catalog).find(entry => typeof entry.id === 'string' && entry.id.toLowerCase() === target)
        || Object.values(catalog).find(entry => typeof entry.api === 'string' && normalizeEndpoint(entry.api) === normalizedEndpoint)
        || null;
}

export async function getModelsDevModels(endpointOrProvider: string): Promise<ModelsDevModel[]> {
    const catalog = await loadCatalog();
    if (!catalog) return [];
    const provider = findModelsDevProvider(catalog, endpointOrProvider);
    if (!provider?.models || typeof provider.models !== 'object') return [];
    return Object.entries(provider.models).map(([id, model]) => ({ ...model, id: model.id || id }));
}

export async function getModelsDevModel(providerOrEndpoint: string, modelId: string): Promise<ModelsDevModel | null> {
    const catalog = await loadCatalog();
    if (!catalog) return null;
    const cleanModelId = modelId.includes('::') ? modelId.slice(modelId.indexOf('::') + 2) : modelId;
    const targetProvider = findModelsDevProvider(catalog, providerOrEndpoint);
    if (targetProvider?.models) {
        const found = targetProvider.models[cleanModelId] || Object.values(targetProvider.models).find(m => m.id === cleanModelId);
        if (found) return { ...found, id: found.id || cleanModelId };
    }
    return null;
}

export function extractReasoningEffortOptions(model: ModelsDevModel): string[] | null {
    if (!Array.isArray(model.reasoning_options)) return null;
    for (const opt of model.reasoning_options) {
        if (Array.isArray(opt.values) && opt.values.length > 0) return opt.values;
        if (Array.isArray(opt.options) && opt.options.length > 0) return opt.options;
    }
    return null;
}

export type ProviderType = 'gemini' | 'openai' | 'anthropic' | 'local' | 'openai-compatible';

export interface ProviderCapabilityOverrides {
    supportsTools?: boolean;
    supportsImageInput?: boolean;
    supportsStructuredOutputs?: boolean;
    supportsReasoning?: boolean;
}

export interface ProviderConfig {
    name: string;
    displayName: string;
    providerType?: ProviderType;
    apiKey?: string;
    baseURL?: string;
    models: string[];
    capabilityOverrides?: ProviderCapabilityOverrides;
    isConfigured: boolean;
}

export interface ModelInfo {
    id: string;
    modelId?: string;
    provider: string;
    providerDisplayName?: string;
    displayName?: string;
}

const REMOTE_PROVIDER_TYPES = new Set<ProviderType>(['gemini', 'openai', 'anthropic', 'openai-compatible']);
const OPENAI_COMPATIBLE_PREFIX = 'openai-compatible:';
const MODEL_SELECTION_SEPARATOR = '::';

export function isOpenAICompatibleProvider(provider: ProviderConfig | string): boolean {
    return typeof provider === 'string'
        ? provider.toLowerCase().startsWith(OPENAI_COMPATIBLE_PREFIX)
        : provider.providerType === 'openai-compatible' || provider.name.toLowerCase().startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function getProviderType(provider: ProviderConfig | string): ProviderType {
    if (typeof provider === 'string') {
        return isOpenAICompatibleProvider(provider) ? 'openai-compatible' : provider as ProviderType;
    }
    return provider.providerType ?? getProviderType(provider.name);
}

export function getModelSelectionKey(providerName: string, modelId: string): string {
    return isOpenAICompatibleProvider(providerName) ? `${providerName}${MODEL_SELECTION_SEPARATOR}${modelId}` : modelId;
}

export function getModelIdFromSelection(selectionId: string): string {
    const idx = selectionId.indexOf(MODEL_SELECTION_SEPARATOR);
    return idx === -1 ? selectionId : selectionId.slice(idx + MODEL_SELECTION_SEPARATOR.length);
}

function getProviderNameFromSelection(selectionId: string): string | null {
    const idx = selectionId.indexOf(MODEL_SELECTION_SEPARATOR);
    if (idx === -1) return null;
    const providerName = selectionId.slice(0, idx);
    return isOpenAICompatibleProvider(providerName) ? providerName : null;
}

function getInitializationPayload(config: ProviderConfig): string {
    const type = getProviderType(config);
    if (type === 'openai-compatible') {
        return JSON.stringify({ baseURL: config.baseURL, apiKey: config.apiKey, capabilities: config.capabilityOverrides });
    }
    return type === 'local' ? `${config.apiKey ?? ''}|${config.models.join(',')}` : (config.apiKey ?? '');
}

function uniqueModels(models: string[]): string[] {
    return [...new Set(models.map(model => model.trim()).filter(Boolean))];
}

export class ProviderManager {
    private providers = new Map<string, ProviderConfig>();
    private activeProviders = new Map<string, AIProvider>();
    private imageInputSupportByModel = new Map<string, boolean>();
    private toolSupportByModel = new Map<string, boolean>();
    private structuredOutputSupportByModel = new Map<string, boolean>();
    private reasoningSupportByModel = new Map<string, boolean>();
    private reasoningOptionsByModel = new Map<string, string[]>();
    private modelUpdateListeners: (() => void)[] = [];

    constructor() {
        for (const [name, displayName] of [['gemini', 'Gemini'], ['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['local', 'Local Models']] as const) {
            this.providers.set(name, { name, displayName, models: [], isConfigured: false });
        }
        this.loadFromStorage();
    }

    private loadFromStorage(): void {
        const storedProviders = typeof localStorage !== 'undefined' ? localStorage.getItem('ai-providers') : null;
        if (storedProviders) {
            try {
                const parsed = JSON.parse(storedProviders);
                for (const [name, rawConfig] of Object.entries(parsed)) {
                    if (!rawConfig || typeof rawConfig !== 'object') continue;
                    const providerConfig = rawConfig as Partial<ProviderConfig>;
                    const providerType = providerConfig.providerType ?? getProviderType(name);
                    const existing = this.providers.get(name);
                    if (existing) {
                        this.providers.set(name, {
                            ...existing,
                            ...providerConfig,
                            providerType: existing.providerType ?? providerType,
                            models: uniqueModels([...(existing.models ?? []), ...(providerConfig.models ?? [])]),
                        });
                    } else if (providerType === 'openai-compatible' && providerConfig.baseURL) {
                        this.providers.set(name, {
                            name,
                            displayName: providerConfig.displayName || 'OpenAI Compatible API',
                            providerType,
                            apiKey: providerConfig.apiKey,
                            baseURL: providerConfig.baseURL,
                            models: uniqueModels(providerConfig.models ?? []),
                            capabilityOverrides: providerConfig.capabilityOverrides,
                            isConfigured: providerConfig.isConfigured !== false,
                        });
                    }
                }
            } catch (error) {
                console.error('Failed to load provider configurations:', error);
            }
        }

        const envKeys: Record<string, string | undefined> = {
            gemini: process.env.GEMINI_API_KEY?.trim() ? '__SERVER_ENV__' : undefined,
            openai: process.env.OPENAI_API_KEY?.trim() || undefined,
            anthropic: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
        };
        for (const [name, key] of Object.entries(envKeys)) {
            if (key) {
                const config = this.providers.get(name)!;
                if (!config.apiKey) {
                    config.apiKey = key;
                    config.isConfigured = true;
                }
            }
        }

        for (const [name, config] of this.providers) {
            const hasInit = getProviderType(config) === 'openai-compatible' ? !!config.baseURL : !!config.apiKey;
            if (!config.isConfigured || !hasInit) continue;
            try {
                const provider = createAIProvider(getProviderType(config));
                if (provider.initialize(getInitializationPayload(config))) {
                    this.activeProviders.set(name, provider);
                    if (REMOTE_PROVIDER_TYPES.has(getProviderType(config))) {
                        void this.fetchAndSetProviderModels(name).catch(error => console.error(`Async fetch of ${name} models failed:`, error));
                    }
                }
            } catch (error) {
                console.error(`Failed to initialize provider ${name}:`, error);
            }
        }
    }

    public saveToStorage(): void {
        if (typeof localStorage === 'undefined') return;
        const configsToSave: Record<string, Partial<ProviderConfig>> = {};
        for (const [name, config] of this.providers) {
            if (this.isEnvironmentKey(name) || (!config.apiKey && !config.baseURL)) continue;
            configsToSave[name] = {
                name: config.name,
                displayName: config.displayName,
                ...(config.providerType ? { providerType: config.providerType } : {}),
                ...(config.apiKey ? { apiKey: config.apiKey } : {}),
                ...(config.baseURL ? { baseURL: config.baseURL } : {}),
                models: uniqueModels(config.models),
                ...(config.capabilityOverrides ? { capabilityOverrides: config.capabilityOverrides } : {}),
                isConfigured: config.isConfigured,
            };
        }
        localStorage.setItem('ai-providers', JSON.stringify(configsToSave));
    }

    private isEnvironmentKey(providerName: string): boolean {
        const config = this.providers.get(providerName);
        if (!config?.apiKey || getProviderType(config) === 'openai-compatible') return false;
        if (providerName === 'gemini') return config.apiKey === '__SERVER_ENV__';
        if (providerName === 'openai') return config.apiKey === process.env.OPENAI_API_KEY;
        if (providerName === 'anthropic') return config.apiKey === process.env.ANTHROPIC_API_KEY;
        return false;
    }

    public configureProvider(providerName: string, apiKey: string, customModels: string[] = []): boolean {
        const config = this.providers.get(providerName);
        if (!config || getProviderType(config) === 'openai-compatible') return false;
        try {
            const provider = createAIProvider(getProviderType(config));
            const nextConfig: ProviderConfig = {
                ...config,
                apiKey,
                models: uniqueModels(customModels),
                isConfigured: true,
            };
            if (!provider.initialize(getInitializationPayload(nextConfig))) return false;
            this.providers.set(providerName, nextConfig);
            this.activeProviders.set(providerName, provider);
            this.saveToStorage();
            if (REMOTE_PROVIDER_TYPES.has(getProviderType(nextConfig))) {
                void this.fetchAndSetProviderModels(providerName).catch(error => console.error(`Async configure fetch of ${providerName} models failed:`, error));
            } else {
                this.notifyModelUpdateListeners();
            }
            return true;
        } catch (error) {
            console.error(`Failed to configure provider ${providerName}:`, error);
            return false;
        }
    }

    public configureOpenAICompatibleProvider(
        baseURL: string,
        apiKey: string,
        customModels: string[] = [],
        displayName?: string
    ): { success: boolean; providerName?: string; error?: string } {
        const endpoint = baseURL.trim();
        if (!endpoint) return { success: false, error: 'Error: Endpoint URL is required.' };
        try {
            const parsedEndpoint = new URL(endpoint);
            if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
                return { success: false, error: 'Error: Endpoint URL must use http:// or https://.' };
            }
            const providerName = `${OPENAI_COMPATIBLE_PREFIX}${nanoid(10)}`;
            const config: ProviderConfig = {
                name: providerName,
                displayName: displayName?.trim() || parsedEndpoint.hostname || 'OpenAI Compatible API',
                providerType: 'openai-compatible',
                apiKey: apiKey.trim() || undefined,
                baseURL: endpoint.replace(/\/+$/, ''),
                models: uniqueModels(customModels),
                isConfigured: true,
            };
            const provider = createAIProvider('openai-compatible');
            if (!provider.initialize(getInitializationPayload(config))) {
                return { success: false, error: 'Error: Endpoint URL or API compatibility could not be initialized.' };
            }
            this.providers.set(providerName, config);
            this.activeProviders.set(providerName, provider);
            this.saveToStorage();
            void this.fetchAndSetProviderModels(providerName).catch(error => console.error(`Async configure fetch of ${providerName} models failed:`, error));
            this.notifyModelUpdateListeners();
            return { success: true, providerName };
        } catch (error) {
            console.error('Failed to configure OpenAI-compatible provider:', error);
            return { success: false, error: 'Error: Endpoint URL or API compatibility is invalid.' };
        }
    }

    public removeProvider(providerName: string): void {
        const storedProviderName = this.resolveProviderName(providerName);
        if (!storedProviderName) return;
        const config = this.providers.get(storedProviderName);
        if (!config || this.isEnvironmentKey(storedProviderName)) return;

        this.activeProviders.delete(storedProviderName);
        this.clearModelCapabilities(storedProviderName);
        if (isOpenAICompatibleProvider(config)) {
            this.providers.delete(storedProviderName);
        } else {
            this.providers.set(storedProviderName, { ...config, apiKey: undefined, isConfigured: false, models: [] });
        }
        this.saveToStorage();
        this.notifyModelUpdateListeners();
    }

    public getProviderForModel(modelSelectionId: string): AIProvider | null {
        const providerName = this.getProviderNameForModel(modelSelectionId);
        return providerName ? this.activeProviders.get(providerName) ?? null : null;
    }

    public getProviderNameForModel(modelSelectionId: string): string | null {
        const explicitProviderName = getProviderNameFromSelection(modelSelectionId);
        const storedExplicit = explicitProviderName ? this.resolveProviderName(explicitProviderName) : null;
        if (storedExplicit && this.activeProviders.has(storedExplicit)) return storedExplicit;
        for (const [providerName, config] of this.providers) {
            if (config.models.includes(modelSelectionId) && this.activeProviders.has(providerName)) return providerName;
        }
        return null;
    }

    public getProviderConfig(providerName: string): ProviderConfig | null {
        const stored = this.resolveProviderName(providerName);
        return stored ? this.providers.get(stored) ?? null : null;
    }

    public getProviderConfigForModel(modelSelectionId: string): ProviderConfig | null {
        const providerName = this.getProviderNameForModel(modelSelectionId);
        return providerName ? this.getProviderConfig(providerName) : null;
    }

    public getModelIdForSelection(modelSelectionId: string): string {
        return getModelIdFromSelection(modelSelectionId);
    }

    public getProviderTypeForModel(modelSelectionId: string): ProviderType | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        return config ? getProviderType(config) : null;
    }

    public getProviderDisplayNameForModel(modelSelectionId: string): string | null {
        return this.getProviderConfigForModel(modelSelectionId)?.displayName ?? null;
    }

    public getImageInputSupportForModel(modelSelectionId: string): boolean | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        if (!config) return null;
        if (typeof config.capabilityOverrides?.supportsImageInput === 'boolean') return config.capabilityOverrides.supportsImageInput;
        return this.imageInputSupportByModel.get(`${config.name}:${this.getModelIdForSelection(modelSelectionId)}`) ?? null;
    }

    public getToolCallingSupportForModel(modelSelectionId: string): boolean | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        if (!config) return null;
        if (typeof config.capabilityOverrides?.supportsTools === 'boolean') return config.capabilityOverrides.supportsTools;
        return this.toolSupportByModel.get(`${config.name}:${this.getModelIdForSelection(modelSelectionId)}`) ?? null;
    }

    public getStructuredOutputSupportForModel(modelSelectionId: string): boolean | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        if (!config) return null;
        if (typeof config.capabilityOverrides?.supportsStructuredOutputs === 'boolean') return config.capabilityOverrides.supportsStructuredOutputs;
        return this.structuredOutputSupportByModel.get(`${config.name}:${this.getModelIdForSelection(modelSelectionId)}`) ?? null;
    }

    public getReasoningSupportForModel(modelSelectionId: string): boolean | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        if (!config) return null;
        if (typeof config.capabilityOverrides?.supportsReasoning === 'boolean') return config.capabilityOverrides.supportsReasoning;
        return this.reasoningSupportByModel.get(`${config.name}:${this.getModelIdForSelection(modelSelectionId)}`) ?? null;
    }

    public getReasoningOptionsForModel(modelSelectionId: string): string[] | null {
        const config = this.getProviderConfigForModel(modelSelectionId);
        return config ? this.reasoningOptionsByModel.get(`${config.name}:${this.getModelIdForSelection(modelSelectionId)}`) ?? null : null;
    }

    public getAllProviders(): ProviderConfig[] {
        return Array.from(this.providers.values());
    }

    public getOpenAICompatibleProviders(): ProviderConfig[] {
        return this.getAllProviders().filter(provider => isOpenAICompatibleProvider(provider));
    }

    public getAllModels(): ModelInfo[] {
        const models: ModelInfo[] = [];
        for (const config of this.providers.values()) {
            if (!config.isConfigured) continue;
            for (const modelId of config.models) {
                models.push({
                    id: getModelSelectionKey(config.name, modelId),
                    modelId,
                    provider: config.name,
                    providerDisplayName: config.displayName,
                    displayName: modelId,
                });
            }
        }
        return models;
    }

    public hasAnyConfiguredProvider(): boolean {
        return Array.from(this.providers.values()).some(config => config.isConfigured);
    }

    public addCustomModel(providerName: string, modelId: string): boolean {
        const config = this.providers.get(providerName);
        const normalizedModelId = getModelIdFromSelection(modelId).trim();
        if (config && config.isConfigured && normalizedModelId && !config.models.includes(normalizedModelId)) {
            config.models.push(normalizedModelId);
            this.saveToStorage();
            this.notifyModelUpdateListeners();
            return true;
        }
        return false;
    }

    public removeCustomModel(providerName: string, modelId: string): boolean {
        const config = this.providers.get(providerName);
        const normalizedModelId = getModelIdFromSelection(modelId);
        if (!config) return false;
        config.models = config.models.filter(model => model !== normalizedModelId);
        this.clearModelCapabilities(providerName, normalizedModelId);
        this.saveToStorage();
        this.notifyModelUpdateListeners();
        return true;
    }

    public async fetchAndSetProviderModels(providerName: string): Promise<void> {
        const storedProviderName = this.resolveProviderName(providerName);
        if (!storedProviderName) return;
        const provider = this.activeProviders.get(storedProviderName);
        const config = this.providers.get(storedProviderName);
        if (!provider || !config || typeof provider.listModels !== 'function') return;

        try {
            const models = await provider.listModels();
            if (!models?.length) return;
            this.clearModelCapabilities(storedProviderName);
            const discoveredIds: string[] = [];
            for (const model of models) {
                const normalized: DiscoveredModel = typeof model === 'string' ? { id: model } : { ...model };
                if (!normalized?.id) continue;
                const advisory = await getModelsDevModel(config.baseURL || providerName, normalized.id);
                if (advisory) {
                    if (typeof normalized.supportsReasoning !== 'boolean' && typeof advisory.reasoning === 'boolean') {
                        normalized.supportsReasoning = advisory.reasoning;
                    }
                    if (!normalized.reasoningOptions) {
                        normalized.reasoningOptions = extractReasoningEffortOptions(advisory) ?? undefined;
                    }
                    if (typeof normalized.supportsImageInput !== 'boolean' && advisory.modalities?.input?.includes('image')) {
                        normalized.supportsImageInput = true;
                    }
                    if (typeof normalized.supportsTools !== 'boolean' && typeof advisory.tool_call === 'boolean') {
                        normalized.supportsTools = advisory.tool_call;
                    }
                    if (typeof normalized.supportsStructuredOutputs !== 'boolean' && typeof advisory.structured_output === 'boolean') {
                        normalized.supportsStructuredOutputs = advisory.structured_output;
                    }
                }
                discoveredIds.push(normalized.id);
                this.recordModelCapabilities(storedProviderName, normalized);
            }
            if (discoveredIds.length > 0) {
                config.models = uniqueModels(discoveredIds);
                this.saveToStorage();
                this.notifyModelUpdateListeners();
            }
        } catch (error) {
            console.error(`Failed to fetch and update ${providerName} models:`, error);
        }
    }

    public addModelUpdateListener(listener: () => void): void {
        this.modelUpdateListeners.push(listener);
    }

    public removeModelUpdateListener(listener: () => void): void {
        this.modelUpdateListeners = this.modelUpdateListeners.filter(current => current !== listener);
    }

    private resolveProviderName(providerName: string): string | null {
        if (this.providers.has(providerName)) return providerName;
        const normalized = providerName.toLowerCase();
        return Array.from(this.providers.keys()).find(stored => stored.toLowerCase() === normalized) ?? null;
    }

    private recordModelCapabilities(providerName: string, model: DiscoveredModel): void {
        const key = `${providerName}:${model.id}`;
        if (typeof model.supportsImageInput === 'boolean') this.imageInputSupportByModel.set(key, model.supportsImageInput);
        if (typeof model.supportsTools === 'boolean') this.toolSupportByModel.set(key, model.supportsTools);
        if (typeof model.supportsStructuredOutputs === 'boolean') this.structuredOutputSupportByModel.set(key, model.supportsStructuredOutputs);
        if (typeof model.supportsReasoning === 'boolean') this.reasoningSupportByModel.set(key, model.supportsReasoning);
        if (Array.isArray(model.reasoningOptions) && model.reasoningOptions.length > 0) this.reasoningOptionsByModel.set(key, model.reasoningOptions);
    }

    private clearModelCapabilities(providerName: string, modelId?: string): void {
        const prefix = modelId ? `${providerName}:${modelId}` : `${providerName}:`;
        for (const map of [
            this.imageInputSupportByModel,
            this.toolSupportByModel,
            this.structuredOutputSupportByModel,
            this.reasoningSupportByModel,
            this.reasoningOptionsByModel,
        ]) {
            for (const key of map.keys()) {
                if (modelId ? key === prefix : key.startsWith(prefix)) map.delete(key);
            }
        }
    }

    private notifyModelUpdateListeners(): void {
        this.modelUpdateListeners.forEach(listener => {
            try { listener(); } catch (error) { console.error('Error notifying model update listener:', error); }
        });
    }
}
