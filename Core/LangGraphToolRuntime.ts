import type { ToolDefinition } from '@langchain/core/language_models/base';
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { nanoid } from 'nanoid';
import { getRoutingManager, callAI, type CallAIOptions } from '../Routing';
import { getProviderType, type ProviderConfig, type ProviderType } from '../Routing/ProviderManager';
import { getOpenAICompatibleProxyBaseURL, OPENAI_COMPATIBLE_ENDPOINT_HEADER, type Content as GeminiContent, type Part as GeminiPart } from '../Routing/AIProvider';
import { executeWithInferenceRetry, normalizeOpenAICompatibleProviderError, withSilenceWatchdog } from './ProviderError';

export interface ToolCallingAgentOptions {
    modelName: string;
    abortSignal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    silenceTimeoutMs?: number;
    label?: string;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

export type ResolvedProvider = {
    providerName: ProviderType;
    providerConfig: ProviderConfig;
    modelName: string;
    modelSelectionId: string;
};

type ToolCallingChatModel = ChatAnthropic | ChatOpenAI;

export function resolveProviderForModel(modelName: string): ResolvedProvider {
    const providerManager = getRoutingManager().getApiKeyManager().getProviderManager();
    const providerConfig = providerManager.getProviderConfigForModel(modelName);
    if (!providerConfig) throw new Error(`No configured provider found for model: ${modelName}`);

    const providerType = getProviderType(providerConfig);
    if (providerType === 'openai-compatible' && providerManager.getToolCallingSupportForModel(modelName) === false) {
        throw new Error(`Error: OpenAI-compatible model ${providerManager.getModelIdForSelection(modelName)} does not support tool calling.`);
    }

    return {
        providerName: providerType,
        providerConfig,
        modelName: providerManager.getModelIdForSelection(modelName),
        modelSelectionId: modelName,
    };
}

export function createToolCallingAgentModel(
    providerName: Exclude<ResolvedProvider['providerName'], 'gemini'>,
    providerConfig: ProviderConfig,
    options: ToolCallingAgentOptions,
    enableAnthropicThinking = true
): ToolCallingChatModel {
    const model = options.modelName;
    const browserSafeConfig = { dangerouslyAllowBrowser: true };

    switch (providerName) {
        case 'openai':
            return new ChatOpenAI({ model, apiKey: providerConfig.apiKey!, configuration: browserSafeConfig });
        case 'local': {
            const ep = providerConfig.apiKey!;
            const baseURL = ep.endsWith('/v1') ? ep : ep.endsWith('/') ? `${ep}v1` : `${ep}/v1`;
            return new ChatOpenAI({ model, apiKey: 'not-needed', configuration: { ...browserSafeConfig, baseURL } });
        }
        case 'openai-compatible':
            if (!providerConfig.baseURL) throw new Error('Error: OpenAI-compatible endpoint URL is missing.');
            return new ChatOpenAI({
                model,
                apiKey: providerConfig.apiKey || 'not-needed',
                configuration: {
                    ...browserSafeConfig,
                    baseURL: getOpenAICompatibleProxyBaseURL(),
                    defaultHeaders: { [OPENAI_COMPATIBLE_ENDPOINT_HEADER]: providerConfig.baseURL },
                },
            });
        case 'anthropic':
            return new ChatAnthropic({
                model,
                apiKey: providerConfig.apiKey!,
                maxTokens: 16384,
                ...(enableAnthropicThinking ? { thinking: { type: 'enabled', budget_tokens: 4096 } } : {}),
                clientOptions: browserSafeConfig,
            });
        default:
            throw new Error(`Unsupported tool-calling provider: ${providerName}`);
    }
}

const cloneGeminiPart = (part: GeminiPart): GeminiPart => JSON.parse(JSON.stringify(part)) as GeminiPart;

function getGeminiPartsFromMessage(message: BaseMessage): GeminiPart[] {
    if (message instanceof ToolMessage) {
        if (!message.name) throw new Error('Gemini tool responses require the originating tool name.');
        const text = messageContentToText(message.content);
        return [{
            functionResponse: {
                name: message.name,
                response: message.status === 'error' ? { error: { details: text } } : { result: text },
                ...(message.tool_call_id ? { id: message.tool_call_id } : {})
            }
        }];
    }

    const parts: GeminiPart[] = [];
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (!part || typeof part !== 'object') continue;
            if ('thoughtSignature' in part || 'functionCall' in part || 'functionResponse' in part || 'thought' in part) {
                parts.push(cloneGeminiPart(part as GeminiPart));
                continue;
            }
            if ('text' in part && typeof part.text === 'string') parts.push({ text: part.text });
            if ('inlineData' in part && part.inlineData && typeof part.inlineData === 'object' && 'mimeType' in part.inlineData && 'data' in part.inlineData) {
                parts.push(cloneGeminiPart(part as GeminiPart));
            }
        }
    }
    if (parts.length === 0) {
        const text = messageContentToText(message.content);
        if (text) parts.push({ text });
    }
    if (message instanceof AIMessage && message.tool_calls?.length && !parts.some(p => !!p.functionCall)) {
        parts.push(...message.tool_calls.map(tc => ({
            functionCall: { id: tc.id, name: tc.name, args: tc.args ?? {} }
        })));
    }
    return parts;
}

export async function invokeGeminiToolAgentTurn(
    _providerConfig: ProviderConfig,
    messages: BaseMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    options: ToolCallingAgentOptions
): Promise<AIMessage> {
    const contents: GeminiContent[] = [];
    for (const message of messages) {
        const role = message instanceof AIMessage ? 'model' : 'user';
        const parts = getGeminiPartsFromMessage(message);
        if (!parts.length) continue;
        const last = contents[contents.length - 1];
        if (last?.role === role) last.parts = [...(last.parts ?? []), ...parts];
        else contents.push({ role, parts });
    }

    const callOptions: CallAIOptions = {
        abortSignal: options.abortSignal,
        retryDelaysMs: options.retryDelaysMs,
        silenceTimeoutMs: options.silenceTimeoutMs,
        label: options.label || `gemini:${options.modelName}`,
        onRetry: options.onRetry,
    };
    const response = await callAI(
        contents as any,
        options.modelName,
        systemPrompt,
        false,
        {
            tools: [{
                functionDeclarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parametersJsonSchema: t.function.parameters
                }))
            }]
        },
        callOptions
    );

    const parts: GeminiPart[] = Array.isArray((response as any)?.candidates?.[0]?.content?.parts)
        ? (response as any).candidates[0].content.parts.map((p: GeminiPart) => cloneGeminiPart(p))
        : [];
    const toolCalls = parts.filter(p => !!p.functionCall?.name).map(p => ({
        id: p.functionCall?.id ?? nanoid(8),
        type: 'tool_call' as const,
        name: p.functionCall!.name!,
        args: p.functionCall?.args ?? {}
    }));
    const aiMessage = new AIMessage({ content: parts, tool_calls: toolCalls.length > 0 ? toolCalls : undefined });
    if (toolCalls.length === 0 && !messageContentToText(aiMessage.content).trim()) {
        throw new Error('Empty response received from model.');
    }
    return aiMessage;
}

async function streamLangChainModelTurn(
    boundModel: ReturnType<ToolCallingChatModel['bindTools']>,
    inputMessages: BaseMessage[],
    signal: AbortSignal,
    touch: () => void
): Promise<AIMessage> {
    if (typeof (boundModel as any).stream !== 'function') {
        const result = await boundModel.invoke(inputMessages, { signal });
        touch();
        return result as AIMessage;
    }
    const stream = await boundModel.stream(inputMessages, { signal });
    let aggregated: AIMessageChunk | null = null;
    for await (const chunk of stream) {
        touch();
        aggregated = aggregated ? aggregated.concat(chunk) : chunk;
    }
    if (!aggregated) {
        throw new Error('Empty response received from model.');
    }
    const aiMessage = new AIMessage({
        content: aggregated.content,
        tool_calls: aggregated.tool_calls,
        invalid_tool_calls: aggregated.invalid_tool_calls,
        additional_kwargs: aggregated.additional_kwargs,
        response_metadata: aggregated.response_metadata,
        id: aggregated.id,
        usage_metadata: aggregated.usage_metadata,
    });
    if ((!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) && !messageContentToText(aiMessage.content).trim()) {
        throw new Error('Empty response received from model.');
    }
    return aiMessage;
}

function normalizeHumanMessageForLangChain(message: BaseMessage, providerName: Exclude<ResolvedProvider['providerName'], 'gemini'>): BaseMessage {
    if (!(message instanceof HumanMessage) || !Array.isArray(message.content)) return message;
    if (!message.content.some((p: any) => p && typeof p === 'object' && (!('type' in p) || 'inlineData' in p))) return message;

    const normalizedContent: any[] = [];
    for (const part of message.content as any[]) {
        if (typeof part === 'string') { if (part) normalizedContent.push({ type: 'text', text: part }); continue; }
        if (!part || typeof part !== 'object') continue;
        if ('inlineData' in part && part.inlineData?.mimeType && part.inlineData?.data) {
            const { mimeType, data } = part.inlineData;
            normalizedContent.push(
                providerName === 'anthropic'
                    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data } }
                    : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
            );
        } else if ('text' in part && typeof part.text === 'string' && !('type' in part)) {
            normalizedContent.push({ type: 'text', text: part.text });
        } else {
            normalizedContent.push(part);
        }
    }
    return new HumanMessage({ content: normalizedContent.length === 1 && normalizedContent[0].type === 'text' ? normalizedContent[0].text : normalizedContent });
}

export async function invokeToolCallingAgentTurn(
    provider: ResolvedProvider,
    messages: BaseMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    options: ToolCallingAgentOptions
): Promise<AIMessage> {
    if (provider.providerName === 'gemini') {
        return invokeGeminiToolAgentTurn(provider.providerConfig, messages, systemPrompt, tools, { ...options, modelName: provider.modelSelectionId || provider.modelName });
    }

    const nonGeminiProvider = provider.providerName as Exclude<ResolvedProvider['providerName'], 'gemini'>;
    const label = options.label || `${provider.providerName}:${provider.modelName}`;
    const inputMessages: BaseMessage[] = [new SystemMessage(systemPrompt), ...messages.map(m => normalizeHumanMessageForLangChain(m, nonGeminiProvider))];

    return await executeWithInferenceRetry(
        { label, retryDelaysMs: options.retryDelaysMs, externalSignal: options.abortSignal, onRetry: options.onRetry },
        () => withSilenceWatchdog(
            { label, silenceTimeoutMs: options.silenceTimeoutMs, externalSignal: options.abortSignal },
            async ({ signal, touch }) => {
                try {
                    const model = createToolCallingAgentModel(nonGeminiProvider, provider.providerConfig, { ...options, modelName: provider.modelName }, true).bindTools(tools);
                    try {
                        return await streamLangChainModelTurn(model, inputMessages, signal, touch);
                    } catch (innerError: any) {
                        const msg = String(innerError?.message || innerError || '').toLowerCase();
                        if (provider.providerName === 'anthropic' && (msg.includes('thinking') || msg.includes('budget_tokens'))) {
                            const fallbackModel = createToolCallingAgentModel('anthropic', provider.providerConfig, { ...options, modelName: provider.modelName }, false).bindTools(tools);
                            return await streamLangChainModelTurn(fallbackModel, inputMessages, signal, touch);
                        }
                        throw innerError;
                    }
                } catch (error) {
                    if (provider.providerName === 'openai-compatible' && provider.providerConfig.baseURL) {
                        throw normalizeOpenAICompatibleProviderError(error, provider.providerConfig.baseURL, provider.modelName);
                    }
                    throw error;
                }
            }
        )
    );
}

export function messageContentToText(content: BaseMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content ?? '');
    return content
        .map(part => typeof part === 'string' ? part : (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' && (!('thought' in part) || part.thought !== true) ? part.text : ''))
        .join('')
        .trim();
}
