import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const ROUTE = '/api/gemini';
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const HTTP_OPTIONS = {
    headers: {
        'User-Agent': 'aistudio-build',
    },
};

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: HTTP_OPTIONS,
});

function getClient(customApiKey?: string): GoogleGenAI {
    const trimmed = customApiKey?.trim();
    if (trimmed && trimmed !== '__SERVER_ENV__') {
        return new GoogleGenAI({
            apiKey: trimmed,
            httpOptions: HTTP_OPTIONS,
        });
    }
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not configured on the server.');
    }
    return ai;
}

function getEffectiveApiKey(customApiKey?: string): string {
    const trimmed = customApiKey?.trim();
    if (trimmed && trimmed !== '__SERVER_ENV__') return trimmed;
    return process.env.GEMINI_API_KEY || '';
}

function readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Gemini request body is too large.'));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}

function buildGenerationConfig(body: any): any {
    const modelToUse = String(body.model || '');
    const config: any = { maxOutputTokens: 65536 };
    if (body.systemInstruction) config.systemInstruction = body.systemInstruction;
    if (body.isJsonOutput) config.responseMimeType = 'application/json';

    const selectedLevel = String(body.thinkingConfig?.thinkingLevel || 'high').toLowerCase();
    const levelMap: Record<string, ThinkingLevel> = {
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        minimal: ThinkingLevel.MINIMAL,
        high: ThinkingLevel.HIGH,
    };
    if (!modelToUse.toLowerCase().startsWith('gemma-')) {
        let resolvedLevel = levelMap[selectedLevel] ?? ThinkingLevel.HIGH;
        if (
            resolvedLevel === ThinkingLevel.MINIMAL &&
            (modelToUse.includes('gemini-3.8-flash') || modelToUse.includes('gemini-4-argon'))
        ) {
            resolvedLevel = ThinkingLevel.LOW;
        }
        config.thinkingConfig = {
            thinkingLevel: resolvedLevel,
            includeThoughts: true,
        };
    }
    if (Array.isArray(body.thinkingConfig?.tools) && body.thinkingConfig.tools.length > 0) {
        const toolsToPass = body.thinkingConfig.tools.filter(
            (t: any) => !(t.functionDeclarations?.length === 1 && t.functionDeclarations[0].name === 'internal_reasoning_continuation')
        );
        if (toolsToPass.length > 0) config.tools = [...toolsToPass];
    }
    return config;
}

function serializeError(error: any): { message: string; status?: number; providerStatus?: string } {
    const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const status = typeof error?.status === 'number' ? error.status : undefined;
    const providerStatus = typeof error?.providerStatus === 'string' ? error.providerStatus : undefined;
    return { message: rawMessage, status, providerStatus };
}

export async function handleGeminiBackendRequest(
    req: IncomingMessage,
    res: ServerResponse,
    basePath = ''
): Promise<boolean> {
    const requestURL = new URL(req.url || '/', 'http://localhost');
    const base = basePath && basePath !== '/' ? basePath.replace(/\/+$/, '') : '';
    const prefix = [`${base}${ROUTE}`, ROUTE].find(
        p => requestURL.pathname === p || requestURL.pathname.startsWith(`${p}/`)
    );
    if (!prefix) return false;

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const subPath = requestURL.pathname.slice(prefix.length).replace(/\/+$/, '') || '/';
    const headerApiKey = Array.isArray(req.headers['x-gemini-api-key'])
        ? req.headers['x-gemini-api-key'][0]
        : req.headers['x-gemini-api-key'];

    if (req.method === 'GET' && subPath === '/status') {
        sendJson(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY) });
        return true;
    }

    if (req.method === 'GET' && subPath === '/models') {
        const apiKey = getEffectiveApiKey(headerApiKey);
        if (!apiKey) {
            sendJson(res, 200, { configured: false, models: [] });
            return true;
        }
        try {
            const upstream = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
                { headers: HTTP_OPTIONS.headers }
            );
            if (!upstream.ok) {
                throw new Error(`Failed to list models: ${upstream.statusText}`);
            }
            const data: any = await upstream.json();
            const allowedSuffixes = [
                '-pro', '-flash', '-flash-lite',
                '-pro-preview', '-flash-preview', '-flash-lite-preview',
                '-it', '-argon',
            ];
            const models = (data.models || [])
                .map((m: any) => ({ id: String(m.name || '').replace(/^models\//, ''), methods: m.supportedGenerationMethods }))
                .filter(({ id, methods }: any) =>
                    (id.startsWith('gemini-') || id.startsWith('gemma-')) &&
                    methods?.includes('generateContent') &&
                    !/-\d{3}$/.test(id) &&
                    allowedSuffixes.some(s => id.endsWith(s))
                )
                .map(({ id }: any) => id);
            sendJson(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY), models });
        } catch (error) {
            sendJson(res, 502, { error: serializeError(error), configured: Boolean(process.env.GEMINI_API_KEY), models: [] });
        }
        return true;
    }

    if (req.method === 'POST' && subPath === '/generate-stream') {
        try {
            const body = await readJsonBody(req);
            const client = getClient(body.apiKey || headerApiKey);
            const modelToUse = String(body.model || '');
            const contents = body.contents;
            const config = buildGenerationConfig(body);

            const abortController = new AbortController();
            req.on('close', () => {
                if (!res.writableEnded) abortController.abort();
            });
            config.abortSignal = abortController.signal;

            const openStream = async (activeConfig: any) => {
                return await client.models.generateContentStream({
                    model: modelToUse,
                    contents,
                    config: activeConfig,
                });
            };

            let stream: AsyncGenerator<any, any, any>;
            try {
                stream = await openStream(config);
            } catch (error: any) {
                const rawMsg = String(error?.message || error || '').toLowerCase();
                if (
                    config.thinkingConfig &&
                    (rawMsg.includes('thinking') || rawMsg.includes('includethoughts') || rawMsg.includes('thinking_config'))
                ) {
                    const fallbackConfig = { ...config };
                    delete fallbackConfig.thinkingConfig;
                    stream = await openStream(fallbackConfig);
                } else {
                    throw error;
                }
            }

            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.setHeader('x-accel-buffering', 'no');

            try {
                for await (const chunk of stream) {
                    if (abortController.signal.aborted) break;
                    const candidate = chunk?.candidates?.[0];
                    const parts = candidate?.content?.parts;
                    const text = typeof chunk?.text === 'string' ? chunk.text : undefined;
                    res.write(JSON.stringify({ type: 'chunk', parts, text, candidate }) + '\n');
                }
                if (!abortController.signal.aborted) {
                    res.write(JSON.stringify({ type: 'done' }) + '\n');
                }
            } catch (streamError: any) {
                const rawMsg = String(streamError?.message || streamError || '').toLowerCase();
                if (
                    config.thinkingConfig &&
                    (rawMsg.includes('thinking') || rawMsg.includes('includethoughts') || rawMsg.includes('thinking_config'))
                ) {
                    try {
                        const fallbackConfig = { ...config };
                        delete fallbackConfig.thinkingConfig;
                        const fallbackStream = await openStream(fallbackConfig);
                        for await (const chunk of fallbackStream) {
                            if (abortController.signal.aborted) break;
                            const candidate = chunk?.candidates?.[0];
                            const parts = candidate?.content?.parts;
                            const text = typeof chunk?.text === 'string' ? chunk.text : undefined;
                            res.write(JSON.stringify({ type: 'chunk', parts, text, candidate }) + '\n');
                        }
                        if (!abortController.signal.aborted) {
                            res.write(JSON.stringify({ type: 'done' }) + '\n');
                        }
                        res.end();
                        return true;
                    } catch (fallbackErr: any) {
                        res.write(JSON.stringify({ type: 'error', error: serializeError(fallbackErr) }) + '\n');
                        res.end();
                        return true;
                    }
                }
                res.write(JSON.stringify({ type: 'error', error: serializeError(streamError) }) + '\n');
            }
            res.end();
        } catch (error: any) {
            sendJson(res, typeof error?.status === 'number' ? error.status : 500, {
                error: serializeError(error),
            });
        }
        return true;
    }

    if (req.method === 'POST' && subPath === '/generate') {
        try {
            const body = await readJsonBody(req);
            const client = getClient(body.apiKey || headerApiKey);
            const modelToUse = String(body.model || '');
            const contents = body.contents;
            const config = buildGenerationConfig(body);

            let response: any;
            try {
                response = await client.models.generateContent({
                    model: modelToUse,
                    contents,
                    config,
                });
            } catch (error: any) {
                const rawMsg = String(error?.message || error || '').toLowerCase();
                if (
                    config.thinkingConfig &&
                    (rawMsg.includes('thinking') || rawMsg.includes('includethoughts') || rawMsg.includes('thinking_config'))
                ) {
                    const fallbackConfig = { ...config };
                    delete fallbackConfig.thinkingConfig;
                    response = await client.models.generateContent({
                        model: modelToUse,
                        contents,
                        config: fallbackConfig,
                    });
                } else {
                    throw error;
                }
            }

            sendJson(res, 200, {
                text: response.text ?? '',
                candidates: response.candidates ?? [],
            });
        } catch (error: any) {
            sendJson(res, typeof error?.status === 'number' ? error.status : 500, {
                error: serializeError(error),
            });
        }
        return true;
    }

    sendJson(res, 404, { error: { message: 'Unsupported Gemini backend route.' } });
    return true;
}
