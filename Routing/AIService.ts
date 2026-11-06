import { ProviderManager } from './ProviderManager';
import { GenerateContentResponse, Part, ThinkingConfig } from './AIProvider';
import { executeWithInferenceRetry, withSilenceWatchdog } from '../Core/ProviderError';

export class ApiKeyManager {
    private providerManager = new ProviderManager();
    public hasValidApiKey(): boolean { return this.providerManager.hasAnyConfiguredProvider(); }
    public getProviderManager(): ProviderManager { return this.providerManager; }
}

let apiKeyManager: ApiKeyManager | null = null;

export function setApiKeyManager(manager: ApiKeyManager) {
    apiKeyManager = manager;
}

interface StructuredMessage {
    role: 'system' | 'assistant' | 'user';
    content: string;
    rawParts?: any[];
}

export interface CallAIOptions {
    abortSignal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    silenceTimeoutMs?: number;
    label?: string;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

export async function callAI(
    promptOrParts: string | Part[] | StructuredMessage[],
    modelToUse: string,
    systemInstruction?: string,
    isJsonOutput = false,
    thinkingConfig?: ThinkingConfig,
    options?: CallAIOptions
): Promise<GenerateContentResponse> {
    if (!apiKeyManager) throw new Error("API key manager not initialized.");
    const providerManager = apiKeyManager.getProviderManager();
    const aiProvider = providerManager.getProviderForModel(modelToUse);
    if (!aiProvider) throw new Error(`No configured provider found for model: ${modelToUse}`);

    const actualModelId = providerManager.getModelIdForSelection(modelToUse);
    const label = options?.label || `${aiProvider.getProviderName()}:${actualModelId}`;

    return await executeWithInferenceRetry(
        { label, retryDelaysMs: options?.retryDelaysMs, externalSignal: options?.abortSignal, onRetry: options?.onRetry },
        () => withSilenceWatchdog(
            { label, silenceTimeoutMs: options?.silenceTimeoutMs, externalSignal: options?.abortSignal },
            ({ signal, touch }) => aiProvider.generateContent(
                promptOrParts,
                actualModelId,
                systemInstruction,
                isJsonOutput,
                thinkingConfig,
                { abortSignal: signal, onChunkActivity: touch }
            )
        )
    );
}
