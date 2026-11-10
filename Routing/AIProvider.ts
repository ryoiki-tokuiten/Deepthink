import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, Output } from "ai";
import { globalState } from "../Core/State";
import { normalizeOpenAICompatibleProviderError } from "../Core/ProviderError";
import { getModelsDevModels, extractReasoningEffortOptions } from "./ProviderManager";

export interface Part {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    inlineData?: { mimeType: string; data: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, any> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, any> };
    [key: string]: any;
}

export interface Content {
    role?: string;
    parts?: Part[];
}

export interface GenerateContentResponse {
    text?: string;
    candidates?: Array<{ content?: Content; [key: string]: any }>;
    response?: { text: () => string; candidates?: Array<{ content?: Content }> };
    [key: string]: any;
}

export const OPENAI_COMPATIBLE_ENDPOINT_HEADER = 'x-openai-compatible-endpoint';

function getAppApiBaseURL(subPath: string): string {
    const configuredBase = (import.meta as any).env?.BASE_URL || '/';
    const appBase = configuredBase.endsWith('/') ? configuredBase.slice(0, -1) : configuredBase;
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    return `${origin}${appBase}${subPath}`;
}

export function getOpenAICompatibleProxyBaseURL(): string {
    return getAppApiBaseURL('/api/openai-compatible');
}

export function getGeminiApiBaseURL(): string {
    return getAppApiBaseURL('/api/gemini');
}

interface StructuredMessage {
    role: 'system' | 'assistant' | 'user';
    content: string;
    rawParts?: any[];
}

export interface ThinkingConfig {
    thinkingBudget?: number;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string;
    tools?: any[];
}

export interface AIProviderRequestOptions {
    abortSignal?: AbortSignal;
    onChunkActivity?: () => void;
}

export interface DiscoveredModel {
    id: string;
    displayName?: string;
    supportsImageInput?: boolean;
    supportsTools?: boolean;
    supportsStructuredOutputs?: boolean;
    supportsReasoning?: boolean;
    reasoningOptions?: string[];
}

type ListedModel = string | DiscoveredModel;

export interface AIProvider {
    initialize(apiKey: string): boolean;
    generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput?: boolean,
        thinkingConfig?: ThinkingConfig,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse>;
    isInitialized(): boolean;
    getProviderName(): string;
    listModels?(): Promise<ListedModel[]>;
}

const isStructuredMessages = (input: any): input is StructuredMessage[] =>
    Array.isArray(input) && input.length > 0 && 'role' in input[0] && 'content' in input[0];

const hasInlineData = (part: any): part is { inlineData: { mimeType: string; data: string } } =>
    Boolean(part?.inlineData?.mimeType && part?.inlineData?.data);

const hasText = (part: any): part is { text: string } => Boolean(part && typeof part.text === 'string');

const wrapAsGeminiResponse = (text: string): any => ({
    text,
    response: { text: () => text, candidates: [{ content: { parts: [{ text }] } }] }
});

function appendStreamedGeminiParts(accumulatedParts: any[], incomingParts: any[]): void {
    for (const part of incomingParts) {
        if (!part || typeof part !== 'object') continue;
        const cloned = JSON.parse(JSON.stringify(part));
        const prev = accumulatedParts[accumulatedParts.length - 1];
        const isPure = (p: any, thought: boolean) =>
            Boolean(p.thought) === thought && typeof p.text === 'string' &&
            !p.thoughtSignature && !p.functionCall && !p.functionResponse && !p.inlineData;

        if (prev && ((isPure(cloned, true) && isPure(prev, true)) || (isPure(cloned, false) && isPure(prev, false)))) {
            prev.text += cloned.text;
        } else {
            accumulatedParts.push(cloned);
        }
    }
}

function buildChatMessages(promptOrParts: string | Part[] | StructuredMessage[], systemInstruction?: string, visionSupport = false): any[] {
    const messages: any[] = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    if (isStructuredMessages(promptOrParts)) {
        for (const msg of promptOrParts) messages.push({ role: msg.role, content: msg.content });
        return messages;
    }
    if (visionSupport && Array.isArray(promptOrParts) && promptOrParts.length > 0) {
        const contentParts: any[] = [];
        for (const part of promptOrParts) {
            if (hasText(part)) contentParts.push({ type: 'text', text: part.text });
            else if (hasInlineData(part) && part.inlineData.mimeType.startsWith('image/')) {
                contentParts.push({ type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } });
            }
        }
        if (contentParts.length > 0) messages.push({ role: 'user', content: contentParts });
        return messages;
    }
    const userContent = typeof promptOrParts === 'string'
        ? promptOrParts
        : Array.isArray(promptOrParts) ? promptOrParts.map((p: any) => p.text).filter(Boolean).join('\n') : String(promptOrParts);
    messages.push({ role: 'user', content: userContent });
    return messages;
}

function buildLanguageModelPrompt(promptOrParts: string | Part[] | StructuredMessage[], systemInstruction?: string): { messages: any[]; instructions?: string } {
    const instructions: string[] = systemInstruction ? [systemInstruction] : [];
    let messages: any[];
    if (isStructuredMessages(promptOrParts)) {
        messages = promptOrParts.flatMap(m => {
            if (m.role === 'system') { instructions.push(m.content); return []; }
            return [{ role: m.role, content: m.content }];
        });
    } else if (Array.isArray(promptOrParts) && promptOrParts.length > 0) {
        const content: any[] = [];
        for (const part of promptOrParts) {
            if (hasText(part)) content.push({ type: 'text', text: part.text });
            else if (hasInlineData(part) && part.inlineData.mimeType.startsWith('image/')) {
                content.push({ type: 'image', image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` });
            }
        }
        messages = [{ role: 'user', content: content.length > 0 ? content : '' }];
    } else {
        messages = [{ role: 'user', content: typeof promptOrParts === 'string' ? promptOrParts : String(promptOrParts) }];
    }
    return { messages, ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}) };
}

function buildAnthropicMessages(promptOrParts: string | Part[] | StructuredMessage[], systemInstruction?: string): { messages: any[]; systemPrompt: string | undefined } {
    let messages: any[] = [];
    let systemPrompt = systemInstruction;
    if (isStructuredMessages(promptOrParts)) {
        const sys: string[] = systemInstruction ? [systemInstruction] : [];
        for (const msg of promptOrParts) {
            if (msg.role === 'system') sys.push(msg.content);
            else messages.push({ role: msg.role, content: msg.content });
        }
        if (sys.length > 0) systemPrompt = sys.join('\n\n');
    } else if (Array.isArray(promptOrParts) && promptOrParts.length > 0) {
        const contentParts: any[] = [];
        for (const part of promptOrParts) {
            if (hasText(part)) contentParts.push({ type: 'text', text: part.text });
            else if (hasInlineData(part) && part.inlineData.mimeType.startsWith('image/')) {
                contentParts.push({ type: 'image', source: { type: 'base64', media_type: part.inlineData.mimeType, data: part.inlineData.data } });
            }
        }
        if (contentParts.length > 0) messages = [{ role: 'user', content: contentParts }];
    } else {
        messages = [{ role: 'user', content: typeof promptOrParts === 'string' ? promptOrParts : String(promptOrParts) }];
    }
    return { messages, systemPrompt };
}

function sanitizeContentsForApi(contents: any[]): any[] {
    if (!Array.isArray(contents)) return contents;
    return contents.map(entry => {
        if (!Array.isArray(entry?.parts)) return entry;
        return {
            ...entry,
            parts: entry.parts.map((part: any) => (
                part && typeof part.text === 'string' && part.text.includes('<!-- EXECUTION_IMAGE_START -->')
                    ? { ...part, text: part.text.replace(/\n?<!-- EXECUTION_IMAGE_START -->\s*(?:<!-- MIME_TYPE:\s*\S+\s*-->\s*)?[\s\S]*?<!-- EXECUTION_IMAGE_END -->\n?/g, '\n[Code-generated image omitted from prompt]\n') }
                    : part
            ))
        };
    });
}

function normalizeGoogleApiError(error: any, modelToUse: string): Error {
    const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const tryParse = (s: string) => {
        try {
            const p = JSON.parse(s);
            if (p?.error) return { code: typeof p.error.code === 'number' ? p.error.code : undefined, status: typeof p.error.status === 'string' ? p.error.status : undefined, message: typeof p.error.message === 'string' ? p.error.message : undefined };
        } catch {}
        return null;
    };
    const parsed = tryParse(rawMessage) || (rawMessage.match(/(\{[\s\S]*"error"[\s\S]*\})/) ? tryParse(rawMessage.match(/(\{[\s\S]*"error"[\s\S]*\})/)![1]) : null);
    const code = parsed?.code ?? (typeof error?.status === 'number' ? error.status : undefined);
    const status = parsed?.status ? ` ${parsed.status}` : '';
    let message = `Gemini API error (${code ?? 'unknown'}${status}) while using ${modelToUse}: ${parsed?.message || rawMessage || 'Request failed.'}`;
    if (code === 500 || code === 503 || parsed?.status === 'INTERNAL' || parsed?.status === 'UNAVAILABLE' || parsed?.status === 'DEADLINE_EXCEEDED') {
        message += ' This is a provider-side failure. Retry the run, and if it repeats switch to a stable non-preview Gemini model.';
    }
    const norm: any = new Error(message);
    norm.cause = error;
    norm.status = code;
    norm.providerStatus = parsed?.status;
    norm.rawProviderMessage = rawMessage;
    return norm;
}

class GoogleAIProvider implements AIProvider {
    private initialized = false;
    private apiKey = '';

    initialize(apiKey: string): boolean {
        this.apiKey = apiKey.trim();
        this.initialized = Boolean(this.apiKey);
        return this.initialized;
    }

    async listModels(): Promise<string[]> {
        if (!this.initialized) return [];
        try {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (this.apiKey && this.apiKey !== '__SERVER_ENV__') {
                headers['x-gemini-api-key'] = this.apiKey;
            }
            const res = await fetch(`${getGeminiApiBaseURL()}/models`, { headers });
            if (!res.ok) throw new Error(`Failed to list models: ${res.statusText}`);
            const data = await res.json();
            return Array.isArray(data?.models) ? data.models : [];
        } catch (e) {
            console.error("Failed to fetch Gemini models:", e);
            return [];
        }
    }

    async generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput = false,
        thinkingConfig?: any,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse> {
        if (!this.initialized) throw new Error("Google AI client not initialized.");

        let contents: any;
        if (Array.isArray(promptOrParts) && promptOrParts.length > 0 && typeof promptOrParts[0] === 'object' && 'role' in promptOrParts[0] && 'parts' in promptOrParts[0]) {
            contents = promptOrParts;
        } else if (isStructuredMessages(promptOrParts)) {
            const normalizedContents: any[] = [];
            for (const msg of promptOrParts) {
                const role = msg.role === 'assistant' ? 'model' : 'user';
                const parts = msg.role === 'assistant' && msg.rawParts?.length ? msg.rawParts : [{ text: String(msg.content) }];
                const last = normalizedContents[normalizedContents.length - 1];
                if (last?.role === role) last.parts.push(...parts);
                else normalizedContents.push({ role, parts: [...parts] });
            }
            contents = normalizedContents;
        } else {
            contents = [{ role: 'user', parts: typeof promptOrParts === 'string' ? [{ text: promptOrParts }] : promptOrParts }];
        }

        const sanitizedContents = sanitizeContentsForApi(contents);
        const selectedLevel = (thinkingConfig?.thinkingLevel || globalState.thinkingLevel || 'high').toLowerCase();

        try {
            const response = await fetch(`${getGeminiApiBaseURL()}/generate-stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey && this.apiKey !== '__SERVER_ENV__' ? { 'x-gemini-api-key': this.apiKey } : {}),
                },
                body: JSON.stringify({
                    model: modelToUse,
                    contents: sanitizedContents,
                    systemInstruction,
                    isJsonOutput,
                    thinkingConfig: {
                        ...thinkingConfig,
                        thinkingLevel: selectedLevel,
                    },
                }),
                signal: requestMeta?.abortSignal,
            });

            if (!response.ok) {
                const errPayload = await response.json().catch(() => ({}));
                const err: any = new Error(errPayload?.error?.message || `HTTP ${response.status}`);
                err.status = errPayload?.error?.status ?? response.status;
                err.providerStatus = errPayload?.error?.providerStatus;
                throw err;
            }

            if (!response.body) {
                throw new Error('Empty response stream from server.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const accumulatedParts: any[] = [];
            let lastCandidate: any = null;
            let buffer = '';

            const processLine = (line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const event = JSON.parse(trimmed);
                if (event.type === 'error') {
                    const err: any = new Error(event.error?.message || 'Gemini stream error');
                    err.status = event.error?.status;
                    err.providerStatus = event.error?.providerStatus;
                    throw err;
                }
                if (event.type === 'chunk') {
                    requestMeta?.onChunkActivity?.();
                    if (event.candidate) lastCandidate = event.candidate;
                    if (Array.isArray(event.parts) && event.parts.length > 0) {
                        appendStreamedGeminiParts(accumulatedParts, event.parts);
                    } else if (typeof event.text === 'string' && event.text.length > 0) {
                        appendStreamedGeminiParts(accumulatedParts, [{ text: event.text }]);
                    }
                }
            };

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIdx = buffer.indexOf('\n');
                while (newlineIdx !== -1) {
                    const line = buffer.slice(0, newlineIdx);
                    buffer = buffer.slice(newlineIdx + 1);
                    processLine(line);
                    newlineIdx = buffer.indexOf('\n');
                }
            }
            buffer += decoder.decode();
            if (buffer.trim()) {
                for (const line of buffer.split('\n')) {
                    processLine(line);
                }
            }

            const combinedText = accumulatedParts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text).join('');
            const hasFunctionCalls = accumulatedParts.some(p => !!p?.functionCall?.name);
            if (!combinedText.trim() && !hasFunctionCalls) {
                throw new Error('Empty response received from model.');
            }
            const candidateContent = { role: 'model', parts: accumulatedParts };
            return {
                text: combinedText,
                candidates: [{ ...(lastCandidate || {}), content: candidateContent }],
                response: { text: () => combinedText, candidates: [{ content: candidateContent }] },
            } as any;
        } catch (error: any) {
            throw normalizeGoogleApiError(error, modelToUse);
        }
    }

    isInitialized(): boolean { return this.initialized; }
    getProviderName(): string { return 'gemini'; }
}

class OpenAIProvider implements AIProvider {
    private client: OpenAI | null = null;

    initialize(apiKey: string): boolean {
        try {
            this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
            return true;
        } catch (e) {
            console.error("Failed to initialize OpenAI:", e);
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        if (!this.client) return [];
        try {
            const response = await this.client.models.list();
            const allowedPrefixes = ['gpt-', 'o1-', 'o3-', 'chatgpt-'];
            return (response?.data || []).map((m: any) => m.id).filter((id: string) => allowedPrefixes.some(p => id.startsWith(p)) || id === 'o1');
        } catch (e) {
            console.error("Failed to fetch OpenAI models:", e);
            return [];
        }
    }

    async generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput = false,
        thinkingConfig?: any,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse> {
        if (!this.client) throw new Error("OpenAI client not initialized.");
        const requestOptions: any = {
            model: modelToUse,
            messages: buildChatMessages(promptOrParts, systemInstruction, true),
            reasoning_effort: (thinkingConfig?.thinkingLevel || globalState.thinkingLevel || 'high').toLowerCase(),
            stream: true,
            ...(isJsonOutput ? { response_format: { type: "json_object" } } : {})
        };
        const stream = await this.client.chat.completions.create(requestOptions, requestMeta?.abortSignal ? { signal: requestMeta.abortSignal } : undefined) as any;
        let fullText = '';
        for await (const chunk of stream) {
            requestMeta?.onChunkActivity?.();
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') fullText += delta;
        }
        if (!fullText.trim()) {
            throw new Error('Empty response received from model.');
        }
        return wrapAsGeminiResponse(fullText);
    }

    isInitialized(): boolean { return this.client !== null; }
    getProviderName(): string { return 'openai'; }
}

interface OpenAICompatibleInitialization {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
    capabilities?: {
        supportsTools?: boolean;
        supportsImageInput?: boolean;
        supportsStructuredOutputs?: boolean;
        supportsReasoning?: boolean;
    };
}

function parseOpenAICompatibleModel(model: any): DiscoveredModel | null {
    if (!model || typeof model.id !== 'string' || !model.id.trim()) return null;
    const inputModalities = model.architecture?.input_modalities ?? model.modalities?.input;
    return {
        id: model.id.trim(),
        displayName: typeof model.name === 'string' ? model.name : undefined,
        supportsImageInput: Array.isArray(inputModalities) ? inputModalities.includes('image') : undefined,
        supportsTools: [model.supports_tools, model.tool_call, model.capabilities?.tools].find(v => typeof v === 'boolean'),
        supportsStructuredOutputs: [model.supports_structured_outputs, model.structured_output, model.capabilities?.structured_outputs].find(v => typeof v === 'boolean'),
        supportsReasoning: [model.reasoning, model.capabilities?.reasoning, model.supports_reasoning].find(v => typeof v === 'boolean'),
        reasoningOptions: Array.isArray(model.reasoning_options) ? model.reasoning_options.find((opt: any) => Array.isArray(opt.options))?.options : undefined,
    };
}

class OpenAICompatibleProvider implements AIProvider {
    private client: ReturnType<typeof createOpenAICompatible> | null = null;
    private endpointUrl = '';
    private apiKey = '';
    private requestHeaders: Record<string, string> = {};
    private capabilities: OpenAICompatibleInitialization['capabilities'] = {};

    initialize(configString: string): boolean {
        try {
            const config = JSON.parse(configString) as OpenAICompatibleInitialization;
            const normalized = config.baseURL.trim().replace(/\/+$/, '');
            const parsed = new URL(normalized);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Endpoint URL must use http:// or https://.');
            this.endpointUrl = normalized;
            this.apiKey = config.apiKey?.trim() || '';
            this.requestHeaders = config.headers ?? {};
            this.capabilities = config.capabilities ?? {};
            this.client = createOpenAICompatible({
                name: 'openaiCompatible',
                baseURL: getOpenAICompatibleProxyBaseURL(),
                ...(this.apiKey ? { apiKey: this.apiKey } : {}),
                headers: { ...this.requestHeaders, [OPENAI_COMPATIBLE_ENDPOINT_HEADER]: this.endpointUrl },
                ...(typeof this.capabilities.supportsStructuredOutputs === 'boolean' ? { supportsStructuredOutputs: this.capabilities.supportsStructuredOutputs } : {}),
            });
            return true;
        } catch (error) {
            console.error('Failed to initialize OpenAI-compatible provider:', error);
            this.client = null;
            return false;
        }
    }

    async listModels(): Promise<DiscoveredModel[]> {
        if (!this.endpointUrl) return [];
        try {
            const response = await fetch(`${getOpenAICompatibleProxyBaseURL()}/models`, {
                headers: {
                    Accept: 'application/json',
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                    ...this.requestHeaders,
                    [OPENAI_COMPATIBLE_ENDPOINT_HEADER]: this.endpointUrl,
                },
            });
            if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}.`);
            const payload = await response.json();
            const rawList = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
            const models = rawList.map(parseOpenAICompatibleModel).filter(Boolean) as DiscoveredModel[];
            if (models.length > 0) {
                const advisoryModels = await getModelsDevModels(this.endpointUrl);
                const advisoryById = new Map(advisoryModels.map(m => [m.id, m]));
                return models.map(model => {
                    const adv = advisoryById.get(model.id);
                    return {
                        ...model,
                        displayName: model.displayName || adv?.name,
                        supportsImageInput: model.supportsImageInput ?? adv?.modalities?.input?.includes('image'),
                        supportsTools: model.supportsTools ?? adv?.tool_call,
                        supportsStructuredOutputs: model.supportsStructuredOutputs ?? adv?.structured_output,
                        supportsReasoning: model.supportsReasoning ?? adv?.reasoning,
                        reasoningOptions: model.reasoningOptions ?? (adv ? extractReasoningEffortOptions(adv) ?? undefined : undefined),
                    };
                });
            }
        } catch (error) {
            console.warn('OpenAI-compatible endpoint model discovery failed:', error);
        }

        const advisoryModels = await getModelsDevModels(this.endpointUrl);
        return advisoryModels.map(m => ({
            id: m.id,
            displayName: m.name,
            supportsImageInput: m.modalities?.input?.includes('image'),
            supportsTools: typeof m.tool_call === 'boolean' ? m.tool_call : undefined,
            supportsStructuredOutputs: typeof m.structured_output === 'boolean' ? m.structured_output : undefined,
            supportsReasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
            reasoningOptions: extractReasoningEffortOptions(m) ?? undefined,
        }));
    }

    async generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput = false,
        thinkingConfig?: ThinkingConfig,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse> {
        if (!this.client) throw new Error('Error: OpenAI-compatible endpoint is not initialized. Check the endpoint URL or API compatibility.');
        try {
            const { messages, instructions } = buildLanguageModelPrompt(promptOrParts, systemInstruction);
            const request: any = {
                model: this.client.chatModel(modelToUse),
                messages,
                ...(requestMeta?.abortSignal ? { abortSignal: requestMeta.abortSignal } : {}),
                ...(instructions ? { instructions } : {}),
                ...(isJsonOutput ? { output: Output.json() } : {}),
                providerOptions: { openaiCompatible: { reasoningEffort: (thinkingConfig?.thinkingLevel || globalState.thinkingLevel || 'high').toLowerCase() } },
            };

            const streamResult = streamText(request);
            let streamedText = '';
            for await (const part of streamResult.fullStream as any) {
                requestMeta?.onChunkActivity?.();
                if (part?.type === 'text-delta') {
                    streamedText += typeof part.textDelta === 'string' ? part.textDelta : typeof part.text === 'string' ? part.text : '';
                } else if (part?.type === 'error' && part.error) {
                    throw part.error;
                }
            }

            let text = streamedText;
            if (!text) { try { text = await streamResult.text; } catch {} }
            if (!text && isJsonOutput) {
                try {
                    const out = await (streamResult as any).output;
                    if (out !== undefined) text = JSON.stringify(out);
                } catch {
                    const fb = await generateText(request);
                    text = fb.text || (fb.output !== undefined ? JSON.stringify(fb.output) : '');
                }
            }
            if (!text || !text.trim()) {
                throw new Error('Empty response received from model.');
            }
            return wrapAsGeminiResponse(text);
        } catch (error) {
            throw normalizeOpenAICompatibleProviderError(error, this.endpointUrl, modelToUse);
        }
    }

    isInitialized(): boolean { return this.client !== null; }
    getProviderName(): string { return 'openai-compatible'; }
}

class AnthropicProvider implements AIProvider {
    private client: Anthropic | null = null;

    initialize(apiKey: string): boolean {
        try {
            this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
            return true;
        } catch (e) {
            console.error("Failed to initialize Anthropic:", e);
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        if (!this.client) return [];
        try {
            const response = await this.client.models.list({ limit: 1000 });
            return (response?.data || []).map((m: any) => m.id).filter((id: string) => id.startsWith('claude-'));
        } catch (e) {
            console.error("Failed to fetch Anthropic models:", e);
            return [];
        }
    }

    async generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput = false,
        thinkingConfig?: any,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse> {
        if (!this.client) throw new Error("Anthropic client not initialized.");
        const { messages, systemPrompt } = buildAnthropicMessages(promptOrParts, systemInstruction);
        const jsonRule = 'You must respond with valid JSON only. Do not include any text outside the JSON structure.';
        const requestOptions: any = {
            model: modelToUse,
            max_tokens: 16384,
            messages,
            thinking: { type: 'adaptive' },
            effort: (thinkingConfig?.thinkingLevel || globalState.thinkingLevel || 'high').toLowerCase(),
            stream: true,
            ...(isJsonOutput ? { system: systemPrompt ? `${systemPrompt}\n\n${jsonRule}` : jsonRule } : systemPrompt ? { system: systemPrompt } : {})
        };

        const consumeAnthropicStream = async (opts: any): Promise<GenerateContentResponse> => {
            const stream = await this.client!.messages.create(opts, requestMeta?.abortSignal ? { signal: requestMeta.abortSignal } : undefined) as any;
            let textContent = '';
            for await (const event of stream) {
                requestMeta?.onChunkActivity?.();
                if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
                    textContent += event.delta.text;
                }
            }
            if (!textContent.trim()) {
                throw new Error('Empty response received from model.');
            }
            return wrapAsGeminiResponse(textContent);
        };

        try {
            return await consumeAnthropicStream(requestOptions);
        } catch (error: any) {
            const msg = String(error?.message || error || '').toLowerCase();
            if (requestOptions.thinking && (msg.includes('thinking') || msg.includes('effort'))) {
                const fallbackOpts = { ...requestOptions };
                delete fallbackOpts.thinking;
                delete fallbackOpts.effort;
                return await consumeAnthropicStream(fallbackOpts);
            }
            throw error;
        }
    }

    isInitialized(): boolean { return this.client !== null; }
    getProviderName(): string { return 'anthropic'; }
}

class LocalModelsProvider implements AIProvider {
    private client: OpenAI | null = null;
    private endpointUrl = '';

    initialize(configString: string): boolean {
        try {
            const [endpoint] = configString.split('|');
            this.endpointUrl = endpoint.endsWith('/v1') ? endpoint : endpoint.endsWith('/') ? `${endpoint}v1` : `${endpoint}/v1`;
            this.client = new OpenAI({ apiKey: 'not-needed', baseURL: this.endpointUrl, dangerouslyAllowBrowser: true });
            return true;
        } catch (e) {
            console.error("Failed to initialize Local Models:", e);
            return false;
        }
    }

    async generateContent(
        promptOrParts: string | Part[] | StructuredMessage[],
        modelToUse: string,
        systemInstruction?: string,
        isJsonOutput = false,
        _thinkingConfig?: any,
        requestMeta?: AIProviderRequestOptions
    ): Promise<GenerateContentResponse> {
        if (!this.client) throw new Error("Local Models client not initialized.");
        const sys = isJsonOutput ? `${systemInstruction || ''}\n\nIMPORTANT: You must respond with valid JSON only, no other text.` : systemInstruction;
        const stream = await this.client.chat.completions.create(
            { model: modelToUse, messages: buildChatMessages(promptOrParts, sys, true), stream: true },
            requestMeta?.abortSignal ? { signal: requestMeta.abortSignal } : undefined
        ) as any;
        let fullText = '';
        for await (const chunk of stream) {
            requestMeta?.onChunkActivity?.();
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') fullText += delta;
        }
        if (!fullText.trim()) {
            throw new Error('Empty response received from model.');
        }
        return wrapAsGeminiResponse(fullText);
    }

    isInitialized(): boolean { return this.client !== null; }
    getProviderName(): string { return 'local'; }
}

export function createAIProvider(provider: string): AIProvider {
    switch (provider) {
        case 'openai': return new OpenAIProvider();
        case 'openai-compatible': return new OpenAICompatibleProvider();
        case 'anthropic': return new AnthropicProvider();
        case 'local': return new LocalModelsProvider();
        default: return new GoogleAIProvider();
    }
}
