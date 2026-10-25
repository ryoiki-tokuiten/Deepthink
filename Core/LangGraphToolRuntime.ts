/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from '@langchain/core/language_models/base';
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { type Content as GeminiContent, type Part as GeminiPart } from '@google/genai';
import { ChatOpenAI } from '@langchain/openai';
import { nanoid } from 'nanoid';
import { getRoutingManager, callAI, type CallAIOptions } from '../Routing';
import { getProviderType, type ProviderConfig, type ProviderType } from '../Routing/ProviderManager';
import {
    getOpenAICompatibleProxyBaseURL,
    OPENAI_COMPATIBLE_ENDPOINT_HEADER,
} from '../Routing/OpenAICompatibleProxy';
import {
    executeWithInferenceRetry,
    normalizeOpenAICompatibleProviderError,
    withSilenceWatchdog,
} from './ProviderError';

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
    if (!providerConfig) {
        throw new Error(`No configured provider found for model: ${modelName}`);
    }

    const providerType = getProviderType(providerConfig);
    if (providerType === 'openai-compatible'
        && providerManager.getToolCallingSupportForModel(modelName) === false) {
        throw new Error(`Error: OpenAI-compatible model ${providerManager.getModelIdForSelection(modelName)} does not support tool calling.`);
    }

    return {
        providerName: providerType,
        providerConfig,
        modelName: providerManager.getModelIdForSelection(modelName),
        modelSelectionId: modelName,
    };
}

function normalizeLocalEndpoint(endpoint: string): string {
    if (endpoint.endsWith('/v1')) {
        return endpoint;
    }

    if (endpoint.endsWith('/')) {
        return `${endpoint}v1`;
    }

    return `${endpoint}/v1`;
}

function getAgentModelOptions(options: ToolCallingAgentOptions) {
    return {
        model: options.modelName
    };
}

function createOpenAICompatibleAgentModel(
    options: ToolCallingAgentOptions,
    apiKey: string,
    configuration: NonNullable<ConstructorParameters<typeof ChatOpenAI>[0]>['configuration']
): ChatOpenAI {
    return new ChatOpenAI({
        ...getAgentModelOptions(options),
        apiKey,
        configuration
    });
}

export function createToolCallingAgentModel(
    providerName: Exclude<ResolvedProvider['providerName'], 'gemini'>,
    providerConfig: ProviderConfig,
    options: ToolCallingAgentOptions,
    enableAnthropicThinking = true
): ToolCallingChatModel {
    const commonOptions = getAgentModelOptions(options);
    const browserSafeConfig = {
        dangerouslyAllowBrowser: true
    };

    switch (providerName) {
        case 'openai':
            return createOpenAICompatibleAgentModel(options, providerConfig.apiKey!, browserSafeConfig);

        case 'local':
            return createOpenAICompatibleAgentModel(options, 'not-needed', {
                ...browserSafeConfig,
                baseURL: normalizeLocalEndpoint(providerConfig.apiKey!)
            });

        case 'openai-compatible':
            if (!providerConfig.baseURL) {
                throw new Error('Error: OpenAI-compatible endpoint URL is missing.');
            }
            return createOpenAICompatibleAgentModel(options, providerConfig.apiKey || 'not-needed', {
                ...browserSafeConfig,
                baseURL: getOpenAICompatibleProxyBaseURL(),
                defaultHeaders: {
                    [OPENAI_COMPATIBLE_ENDPOINT_HEADER]: providerConfig.baseURL,
                },
            });

        case 'anthropic':
            return new ChatAnthropic({
                ...commonOptions,
                apiKey: providerConfig.apiKey!,
                maxTokens: 16384,
                ...(enableAnthropicThinking
                    ? {
                        thinking: {
                            type: 'enabled',
                            budget_tokens: 4096,
                        },
                    }
                    : {}),
                clientOptions: {
                    dangerouslyAllowBrowser: true
                }
            });

        default:
            throw new Error(`Unsupported tool-calling provider: ${providerName}`);
    }
}

function cloneGeminiPart(part: GeminiPart): GeminiPart {
    return JSON.parse(JSON.stringify(part)) as GeminiPart;
}

function isGeminiPart(value: unknown): value is GeminiPart {
    return !!value && typeof value === 'object';
}

function pushGeminiContent(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]) {
    if (parts.length === 0) {
        return;
    }

    const lastContent = contents[contents.length - 1];
    if (lastContent?.role === role) {
        lastContent.parts = [...(lastContent.parts ?? []), ...parts];
        return;
    }

    contents.push({ role, parts });
}

function buildGeminiFunctionDeclarations(tools: ToolDefinition[]) {
    return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parametersJsonSchema: tool.function.parameters
    }));
}

function getGeminiToolResponse(message: ToolMessage) {
    if (message.status === 'error') {
        return { error: { details: messageContentToText(message.content) } };
    }

    return { result: messageContentToText(message.content) };
}

function getGeminiPartsFromMessage(message: BaseMessage): GeminiPart[] {
    if (message instanceof ToolMessage) {
        if (!message.name) {
            throw new Error('Gemini tool responses require the originating tool name.');
        }

        return [{
            functionResponse: {
                name: message.name,
                response: getGeminiToolResponse(message),
                ...(message.tool_call_id ? { id: message.tool_call_id } : {})
            }
        }];
    }

    const parts: GeminiPart[] = [];

    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (!isGeminiPart(part)) {
                continue;
            }

            if ('thoughtSignature' in part || 'functionCall' in part || 'functionResponse' in part || 'thought' in part) {
                parts.push(cloneGeminiPart(part));
                continue;
            }

            if ('text' in part && typeof part.text === 'string') {
                parts.push({ text: part.text });
            }

            if (
                'inlineData' in part &&
                part.inlineData &&
                typeof part.inlineData === 'object' &&
                'mimeType' in part.inlineData &&
                'data' in part.inlineData
            ) {
                parts.push(cloneGeminiPart(part));
            }
        }
    }

    if (parts.length === 0) {
        const text = messageContentToText(message.content);
        if (text) {
            parts.push({ text });
        }
    }

    if (message instanceof AIMessage && message.tool_calls?.length && !parts.some(part => !!part.functionCall)) {
        parts.push(...message.tool_calls.map(toolCall => ({
            functionCall: {
                id: toolCall.id,
                name: toolCall.name,
                args: toolCall.args ?? {}
            }
        })));
    }

    return parts;
}

function buildGeminiContents(messages: BaseMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const message of messages) {
        pushGeminiContent(contents, message instanceof AIMessage ? 'model' : 'user', getGeminiPartsFromMessage(message));
    }

    return contents;
}

function createGeminiAiMessage(response: any): AIMessage {
    const parts: GeminiPart[] = Array.isArray(response?.candidates?.[0]?.content?.parts)
        ? response.candidates[0].content.parts.map((part: GeminiPart) => cloneGeminiPart(part))
        : [];

    const toolCalls = parts
        .filter(part => !!part.functionCall?.name)
        .map(part => ({
            id: part.functionCall?.id ?? nanoid(8),
            type: 'tool_call' as const,
            name: part.functionCall!.name!,
            args: part.functionCall?.args ?? {}
        }));

    return new AIMessage({
        content: parts,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    });
}

export async function invokeGeminiToolAgentTurn(
    _providerConfig: ProviderConfig,
    messages: BaseMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    options: ToolCallingAgentOptions
): Promise<AIMessage> {
    const contents = buildGeminiContents(messages);
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
                functionDeclarations: buildGeminiFunctionDeclarations(tools)
            }]
        },
        callOptions
    );

    return createGeminiAiMessage(response);
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
        return new AIMessage({ content: '' });
    }

    return new AIMessage({
        content: aggregated.content,
        tool_calls: aggregated.tool_calls,
        invalid_tool_calls: aggregated.invalid_tool_calls,
        additional_kwargs: aggregated.additional_kwargs,
        response_metadata: aggregated.response_metadata,
        id: aggregated.id,
        usage_metadata: aggregated.usage_metadata,
    });
}

function normalizeHumanMessageForLangChain(
    message: BaseMessage,
    providerName: Exclude<ResolvedProvider['providerName'], 'gemini'>
): BaseMessage {
    if (!(message instanceof HumanMessage) || !Array.isArray(message.content)) {
        return message;
    }

    const needsNormalization = message.content.some(
        (part: any) => part && typeof part === 'object' && (!('type' in part) || 'inlineData' in part)
    );
    if (!needsNormalization) {
        return message;
    }

    const normalizedContent: any[] = [];
    for (const part of message.content as any[]) {
        if (typeof part === 'string') {
            if (part) normalizedContent.push({ type: 'text', text: part });
            continue;
        }
        if (!part || typeof part !== 'object') continue;

        if ('inlineData' in part && part.inlineData?.mimeType && part.inlineData?.data) {
            const { mimeType, data } = part.inlineData;
            if (providerName === 'anthropic') {
                normalizedContent.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mimeType,
                        data,
                    },
                });
            } else {
                normalizedContent.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${mimeType};base64,${data}`,
                    },
                });
            }
            continue;
        }

        if ('text' in part && typeof part.text === 'string' && !('type' in part)) {
            normalizedContent.push({ type: 'text', text: part.text });
            continue;
        }

        normalizedContent.push(part);
    }

    return new HumanMessage({
        content: normalizedContent.length === 1 && normalizedContent[0].type === 'text'
            ? normalizedContent[0].text
            : normalizedContent,
    });
}

/**
 * Unified tool-calling turn invocation across all providers:
 * - Streams responses with reasoning/thought traces enabled
 * - Resets a 5-minute rolling silence watchdog on every chunk
 * - Retries transient provider errors with 1m -> 3m -> 5m backoff (fast-failing permanent 4xx errors)
 */
export async function invokeToolCallingAgentTurn(
    provider: ResolvedProvider,
    messages: BaseMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    options: ToolCallingAgentOptions
): Promise<AIMessage> {
    if (provider.providerName === 'gemini') {
        return invokeGeminiToolAgentTurn(
            provider.providerConfig,
            messages,
            systemPrompt,
            tools,
            {
                ...options,
                modelName: provider.modelSelectionId || provider.modelName,
            }
        );
    }

    const nonGeminiProvider = provider.providerName as Exclude<ResolvedProvider['providerName'], 'gemini'>;
    const label = options.label || `${provider.providerName}:${provider.modelName}`;
    const inputMessages: BaseMessage[] = [
        new SystemMessage(systemPrompt),
        ...messages.map(m => normalizeHumanMessageForLangChain(m, nonGeminiProvider)),
    ];

    return await executeWithInferenceRetry(
        {
            label,
            retryDelaysMs: options.retryDelaysMs,
            externalSignal: options.abortSignal,
            onRetry: options.onRetry,
        },
        async () => {
            return await withSilenceWatchdog(
                {
                    label,
                    silenceTimeoutMs: options.silenceTimeoutMs,
                    externalSignal: options.abortSignal,
                },
                async ({ signal, touch }) => {
                    try {
                        const model = createToolCallingAgentModel(
                            provider.providerName as Exclude<ResolvedProvider['providerName'], 'gemini'>,
                            provider.providerConfig,
                            {
                                ...options,
                                modelName: provider.modelName,
                            },
                            true
                        ).bindTools(tools);

                        try {
                            return await streamLangChainModelTurn(model, inputMessages, signal, touch);
                        } catch (innerError: any) {
                            const msg = String(innerError?.message || innerError || '').toLowerCase();
                            if (
                                provider.providerName === 'anthropic' &&
                                (msg.includes('thinking') || msg.includes('budget_tokens'))
                            ) {
                                const fallbackModel = createToolCallingAgentModel(
                                    'anthropic',
                                    provider.providerConfig,
                                    {
                                        ...options,
                                        modelName: provider.modelName,
                                    },
                                    false
                                ).bindTools(tools);
                                return await streamLangChainModelTurn(fallbackModel, inputMessages, signal, touch);
                            }
                            throw innerError;
                        }
                    } catch (error) {
                        if (provider.providerName === 'openai-compatible' && provider.providerConfig.baseURL) {
                            throw normalizeOpenAICompatibleProviderError(
                                error,
                                provider.providerConfig.baseURL,
                                provider.modelName
                            );
                        }
                        throw error;
                    }
                }
            );
        }
    );
}

export function messageContentToText(content: BaseMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return String(content ?? '');
    }

    return content
        .map(part => {
            if (typeof part === 'string') {
                return part;
            }
            if (
                part &&
                typeof part === 'object' &&
                'text' in part &&
                typeof part.text === 'string' &&
                (!('thought' in part) || part.thought !== true)
            ) {
                return part.text;
            }
            return '';
        })
        .join('')
        .trim();
}
