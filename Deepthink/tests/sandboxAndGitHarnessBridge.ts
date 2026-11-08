import { register } from 'node:module';
import { Readable } from 'node:stream';
import { rm, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

let hookInstalled = false;
let cachedHandleSandboxBackendRequest: ((req: any, res: any) => Promise<boolean>) | null = null;
let dockerShimPath: string | null = null;

async function ensureTestDockerShim(): Promise<string> {
    if (dockerShimPath) return dockerShimPath;
    const candidate = resolve(tmpdir(), 'deepthink-test-docker-shim.sh');
    const script = [
        '#!/usr/bin/env bash',
        'if [ "$1" = "rm" ] || [ "$1" = "--version" ]; then exit 0; fi',
        'last_arg="${@: -1}"',
        'exec bash -c "$last_arg"',
        '',
    ].join('\n');
    await writeFile(candidate, script, 'utf8');
    await chmod(candidate, 0o755);
    dockerShimPath = candidate;
    return candidate;
}

async function getHandleSandboxBackendRequest() {
    installNodeExtensionlessImportHook();
    if (!cachedHandleSandboxBackendRequest) {
        const mod = await import('../../Backend/sandboxToolBackend.ts');
        cachedHandleSandboxBackendRequest = mod.handleSandboxBackendRequest;
    }
    return cachedHandleSandboxBackendRequest;
}

export function installNodeExtensionlessImportHook(): void {
    if (hookInstalled) return;
    hookInstalled = true;

    const loaderCode = `
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(${JSON.stringify(import.meta.url)});
const { transform } = require('esbuild');

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) &&
        (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {}
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file://') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
    const filePath = fileURLToPath(url);
    const raw = await readFile(filePath, 'utf8');
    const result = await transform(raw, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'es2022',
      sourcemap: 'inline',
      sourcefile: filePath,
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: result.code,
    };
  }
  return nextLoad(url, context);
}
`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(loaderCode, 'utf8').toString('base64')}`;
    register(dataUrl, import.meta.url);
}

export interface InProcessSandboxResponse<T = any> {
    status: number;
    ok: boolean;
    body: T;
}

export interface InProcessSandboxTestApi {
    request<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<InProcessSandboxResponse<T>>;
    trackRepositoryForCleanup(repositoryName: string): void;
}

export async function invokeSandboxBackendInMemory<T = any>(
    urlPath: string,
    init?: { method?: string; body?: string }
): Promise<InProcessSandboxResponse<T>> {
    const handleSandboxBackendRequest = await getHandleSandboxBackendRequest();
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = init?.body ?? '';
    const chunks = rawBody ? [Buffer.from(rawBody, 'utf8')] : [];
    const req = Readable.from(chunks) as any;
    req.method = method;
    req.url = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    req.headers = { 'content-type': 'application/json' };

    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    let responsePayload = '';

    const res = {
        get statusCode() {
            return statusCode;
        },
        set statusCode(val: number) {
            statusCode = val;
        },
        setHeader(name: string, value: string) {
            responseHeaders[name.toLowerCase()] = value;
        },
        end(chunk?: string | Buffer) {
            if (chunk !== undefined) {
                responsePayload += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            }
        },
    } as any;

    const handled = await handleSandboxBackendRequest(req, res);
    if (!handled) {
        return {
            status: 404,
            ok: false,
            body: { error: `Unhandled sandbox route: ${method} ${urlPath}` } as any,
        };
    }

    let parsedBody: any = responsePayload;
    try {
        parsedBody = responsePayload ? JSON.parse(responsePayload) : {};
    } catch {
    }

    return {
        status: statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        body: parsedBody as T,
    };
}

export async function withInProcessSandboxBackend<T>(
    fn: (api: InProcessSandboxTestApi) => Promise<T>
): Promise<T> {
    installNodeExtensionlessImportHook();
    const shimExecutable = await ensureTestDockerShim();

    const prevWindow = (globalThis as any).window;
    const prevFetch = globalThis.fetch;
    const prevDockerEnv = process.env.ITERATIVE_STUDIO_DOCKER;
    const prevRuntimeEnv = process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME;
    process.env.ITERATIVE_STUDIO_DOCKER = shimExecutable;
    process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME = 'docker';
    const trackedRepos = new Set<string>();

    (globalThis as any).window = {
        location: {
            protocol: 'http:',
            hostname: 'localhost',
            origin: 'http://localhost:3000',
        },
        dispatchEvent: () => true,
        addEventListener: () => {},
        removeEventListener: () => {},
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const parsedUrl = new URL(urlStr, 'http://localhost:3000');

        if (parsedUrl.pathname.startsWith('/api/sandbox/')) {
            const pathWithSearch = `${parsedUrl.pathname}${parsedUrl.search}`;
            const rawBody = typeof init?.body === 'string' ? init.body : undefined;
            const result = await invokeSandboxBackendInMemory(pathWithSearch, {
                method: init?.method,
                body: rawBody,
            });

            if (result.body && typeof result.body === 'object') {
                if (typeof result.body.repositoryName === 'string') {
                    trackedRepos.add(result.body.repositoryName);
                }
                if (typeof result.body.resultPath === 'string') {
                    trackedRepos.add(result.body.resultPath);
                }
            }

            return new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (prevFetch) {
            return prevFetch(input, init);
        }
        throw new Error(`Unexpected external fetch in test: ${urlStr}`);
    }) as typeof fetch;

    const api: InProcessSandboxTestApi = {
        request: async <R = any>(path: string, init?: { method?: string; body?: unknown }) => {
            const res = await invokeSandboxBackendInMemory<R>(path, {
                method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
                body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
            });
            if (res.body && typeof res.body === 'object') {
                if (typeof (res.body as any).repositoryName === 'string') {
                    trackedRepos.add((res.body as any).repositoryName);
                }
                if (typeof (res.body as any).resultPath === 'string') {
                    trackedRepos.add((res.body as any).resultPath);
                }
            }
            return res;
        },
        trackRepositoryForCleanup: (repositoryName: string) => {
            if (repositoryName) trackedRepos.add(repositoryName);
        },
    };

    try {
        return await fn(api);
    } finally {
        if (prevWindow === undefined) {
            delete (globalThis as any).window;
        } else {
            (globalThis as any).window = prevWindow;
        }
        globalThis.fetch = prevFetch;
        if (prevDockerEnv === undefined) {
            delete process.env.ITERATIVE_STUDIO_DOCKER;
        } else {
            process.env.ITERATIVE_STUDIO_DOCKER = prevDockerEnv;
        }
        if (prevRuntimeEnv === undefined) {
            delete process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME;
        } else {
            process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME = prevRuntimeEnv;
        }

        const resultsRoot = resolve(process.cwd(), 'Results');
        for (const repoEntry of trackedRepos) {
            if (!repoEntry) continue;
            try {
                const candidate = repoEntry.startsWith('/') ? resolve(repoEntry) : resolve(resultsRoot, repoEntry);
                if (candidate.startsWith(resultsRoot + '/')) {
                    await rm(candidate, { recursive: true, force: true });
                }
            } catch {
            }
        }
    }
}

export interface SyntheticGeminiTurnContext {
    turnIndex: number;
    contents: any[];
    modelId: string;
    systemInstruction?: string;
    toolNames: string[];
}

export type SyntheticGeminiTurnHandler = (
    ctx: SyntheticGeminiTurnContext
) => Promise<Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, any> } }>>;

export async function withSyntheticToolCallingProvider<T>(
    turnHandler: SyntheticGeminiTurnHandler,
    fn: (sandboxRuntime: typeof import('../../Core/SandboxToolRuntime.ts')) => Promise<T>
): Promise<T> {
    return await withInProcessSandboxBackend(async () => {
        const routingMod = await import('../../Routing/index.ts');
        const aiServiceMod = await import('../../Routing/AIService.ts');
        const sandboxRuntime = await import('../../Core/SandboxToolRuntime.ts');
        const apiKeyManager = routingMod.getRoutingManager().getApiKeyManager();
        aiServiceMod.setApiKeyManager(apiKeyManager);
        const providerManager = apiKeyManager.getProviderManager() as any;

        const origGetConfig = providerManager.getProviderConfigForModel?.bind(providerManager);
        const origGetProvider = providerManager.getProviderForModel?.bind(providerManager);
        const origGetModelId = providerManager.getModelIdForSelection?.bind(providerManager);

        let turnIndex = 0;

        providerManager.getProviderConfigForModel = (modelName: string) => ({
            name: 'gemini',
            isConfigured: true,
            apiKey: 'synthetic-test-key',
            models: [{ id: modelName, name: modelName }],
        });

        providerManager.getModelIdForSelection = (modelName: string) => modelName;

        providerManager.getProviderForModel = (_modelName: string) => ({
            getProviderName: () => 'gemini',
            generateContent: async (
                promptOrParts: any,
                actualModelId: string,
                systemInstruction?: string,
                _isJsonOutput?: boolean,
                thinkingConfig?: any
            ) => {
                turnIndex++;
                const declarations = thinkingConfig?.tools?.[0]?.functionDeclarations ?? [];
                const toolNames = declarations.map((d: any) => String(d.name));
                const parts = await turnHandler({
                    turnIndex,
                    contents: Array.isArray(promptOrParts) ? promptOrParts : [{ role: 'user', parts: [{ text: String(promptOrParts) }] }],
                    modelId: actualModelId,
                    systemInstruction,
                    toolNames,
                });
                return {
                    candidates: [
                        {
                            content: {
                                role: 'model',
                                parts,
                            },
                        },
                    ],
                };
            },
        });

        try {
            return await fn(sandboxRuntime);
        } finally {
            if (origGetConfig) providerManager.getProviderConfigForModel = origGetConfig;
            if (origGetProvider) providerManager.getProviderForModel = origGetProvider;
            if (origGetModelId) providerManager.getModelIdForSelection = origGetModelId;
        }
    });
}
