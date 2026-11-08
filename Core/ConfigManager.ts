import { encode, decode } from '@msgpack/msgpack';
import { globalState } from './State';
import { activateTab, updateUIAfterModeChange } from './AppRouter';
import {
    ensureDeepthinkInitialized,
    getLoadedDeepthinkModule
} from './ModeLoader';
import { createDefaultCustomPromptsDeepthink } from '../Deepthink/prompts';
import {
    routingManager,
    getSelectedModel,
    getSelectedStrategiesCount,
    getStrategyProximityLoops,
    getSelectedModulesCount,
    getModulesImpactReviewLoops,
    getDeepthinkDepth,
    getIsolateBranchesEnabled,
    getSelectedThinkingLevel
} from '../Routing';
import { updateControlsState } from '../UI/Controls';

const CURRENT_STATE_VERSION = 4;

interface ExportedConfig {
    currentMode: 'deepthink';
    initialIdea: string;
    selectedModel: string;
    modeState: unknown;
    customPrompts: {
        deepthink?: unknown;
    };
    modelParameters: {
        strategiesCount: number;
        strategyProximityLoops: number;
        modulesCount: number;
        modulesImpactReviewLoops: number;
        deepthinkDepth: number;
        isolateBranches: boolean;
        deepthinkCodeExecutionEnabled: boolean;
        thinkingLevel: string;
    };
    directContextFiles?: unknown[];
}

interface VersionedState {
    _version: number;
    _exportedAt: string;
    _mode: 'deepthink';
    data: ExportedConfig;
}

interface SerializationOptions {
    format: 'json' | 'msgpack';
    compress: boolean;
    prettyPrint?: boolean;
}

interface ModeStateHandler<TState = any> {
    getFullState(): TState | null;
    restoreState(state: TState | null): void;
    renderAfterImport(): void;
}

const STATUS_RESET_MAP: Record<string, string> = {
    processing: 'pending',
    retrying: 'pending',
    running: 'stopped',
    stopping: 'stopped',
};

const BOOLEAN_RESET_PATTERNS = [/^is.*Running$/, /^is.*Processing$/, /^isStopRequested$/, /^isGenerating$/];
const NON_SERIALIZABLE_FIELDS = new Set([
    'abortController'
]);

function sanitizeRecursive(obj: unknown, seen = new WeakMap()): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (seen.has(obj as object)) return seen.get(obj as object);
    if (obj instanceof Date) return new Date(obj.getTime());
    if (Array.isArray(obj)) {
        const arr: unknown[] = [];
        seen.set(obj, arr);
        for (const item of obj) arr.push(sanitizeRecursive(item, seen));
        return arr;
    }
    const result: Record<string, unknown> = {};
    seen.set(obj as object, result);
    for (const [key, value] of Object.entries(obj)) {
        if (NON_SERIALIZABLE_FIELDS.has(key) || typeof value === 'function' || value instanceof Element) continue;
        if ((key.endsWith('Status') || key.endsWith('status')) && typeof value === 'string') {
            result[key] = STATUS_RESET_MAP[value] ?? value;
        } else if (typeof value === 'boolean' && BOOLEAN_RESET_PATTERNS.some(p => p.test(key))) {
            result[key] = false;
        } else {
            result[key] = sanitizeRecursive(value, seen);
        }
    }
    return result;
}

let pendingDeepthinkState: any = null;

const deepthinkStateHandler: ModeStateHandler = {
    getFullState() {
        const pipeline = getLoadedDeepthinkModule()?.getActiveDeepthinkPipeline();
        return pipeline ? { pipeline, activeTabId: pipeline.activeTabId || 'strategic-solver' } : null;
    },
    restoreState(state) {
        if (state?.pipeline) {
            if (state.pipeline.status !== 'completed' && state.pipeline.status !== 'error') state.pipeline.status = 'stopped';
            state.pipeline.isStopRequested = false;
        }
        pendingDeepthinkState = state;
    },
    renderAfterImport() {
        void ensureDeepthinkInitialized().then(async mod => {
            const state = pendingDeepthinkState;
            pendingDeepthinkState = null;
            if (!state?.pipeline) {
                mod.setActiveDeepthinkPipelineForImport(null);
                ['deepthinkPipelineUpdated', 'deepthinkPipelineStateChanged', 'controlsStateUpdated'].forEach(ev => window.dispatchEvent(new CustomEvent(ev)));
                return;
            }
            if (state.pipeline.status !== 'completed' && state.pipeline.status !== 'error') state.pipeline.status = 'stopped';
            state.pipeline.isStopRequested = false;
            try {
                const files = state.pipeline.directContextFiles || globalState.directContextFiles || [];
                for (const file of files) {
                    if (!file.base64) {
                        const targetPath = file.relativePath || `user_uploaded/${file.name}`;
                        let res = await fetch(`/api/sandbox/workspace/file?repositoryId=${encodeURIComponent(state.pipeline.id)}&path=${encodeURIComponent(targetPath)}&scope=repository`);
                        if (!res.ok && targetPath.startsWith('direct_context/')) {
                            res = await fetch(`/api/sandbox/workspace/file?repositoryId=${encodeURIComponent(state.pipeline.id)}&path=${encodeURIComponent(targetPath.replace('direct_context/', 'user_uploaded/'))}&scope=repository`);
                        }
                        if (res.ok) {
                            const bytes = new Uint8Array(await res.arrayBuffer());
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                            file.base64 = btoa(binary);
                        }
                    }
                }
                globalState.directContextFiles = files;
                if (typeof state.pipeline.challenge === 'string') {
                    state.pipeline.challenge = state.pipeline.challenge.replace(
                        /<!-- EXECUTION_IMAGE_REF:\s*([^\s|]+)\s*\|\s*MIME_TYPE:\s*([^\s]+)\s*-->/g,
                        (match: string, refPath: string, mime: string) => {
                            const cleanName = refPath.replace(/^(user_uploaded|direct_context)\//, '');
                            const matched = files.find((f: any) => f.relativePath === refPath || f.name === cleanName);
                            return matched?.base64 ? `<!-- EXECUTION_IMAGE_START -->\n<!-- MIME_TYPE: ${mime} -->\n${matched.base64}\n<!-- EXECUTION_IMAGE_END -->` : match;
                        }
                    );
                }
            } catch {}
            mod.setActiveDeepthinkPipelineForImport(state.pipeline);
            mod.renderActiveDeepthinkPipeline();
            if (state.activeTabId) activateTab(state.activeTabId);
            ['deepthinkPipelineUpdated', 'deepthinkPipelineStateChanged', 'controlsStateUpdated'].forEach(ev => window.dispatchEvent(new CustomEvent(ev)));
        });
    }
};

async function pipeCompression(data: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
    const StreamCtor = mode === 'compress' ? globalThis.CompressionStream : globalThis.DecompressionStream;
    if (typeof StreamCtor === 'undefined') return data;
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const stream = new Blob([buffer]).stream().pipeThrough(new StreamCtor('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function serialize(data: unknown, options: SerializationOptions): Promise<Blob> {
    let encoded = options.format === 'msgpack'
        ? encode(data)
        : new TextEncoder().encode(options.prettyPrint ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    if (options.compress) {
        try { encoded = await pipeCompression(encoded, 'compress'); } catch {}
    }
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    const type = options.compress ? 'application/gzip' : (options.format === 'msgpack' ? 'application/msgpack' : 'application/json');
    return new Blob([buffer], { type });
}

async function deserialize<T = unknown>(blob: Blob): Promise<T> {
    let data = new Uint8Array(await blob.arrayBuffer());
    if (data[0] === 0x1f && data[1] === 0x8b) {
        data = await pipeCompression(data, 'decompress');
    }
    return (data[0] === 0x7b || data[0] === 0x5b)
        ? JSON.parse(new TextDecoder().decode(data)) as T
        : decode(data) as T;
}

export async function exportConfiguration(format: 'auto' | 'json' | 'msgpack' = 'auto'): Promise<void> {
    if (globalState.isGenerating) {
        alert("Cannot export configuration while generation is in progress.");
        return;
    }
    const initialIdeaInput = document.getElementById('initial-idea') as HTMLTextAreaElement | null;
    const config: VersionedState = {
        _version: CURRENT_STATE_VERSION,
        _exportedAt: new Date().toISOString(),
        _mode: 'deepthink',
        data: {
            currentMode: 'deepthink',
            initialIdea: initialIdeaInput?.value ?? '',
            selectedModel: getSelectedModel(),
            modeState: deepthinkStateHandler.getFullState(),
            customPrompts: {
                deepthink: globalState.customPromptsDeepthinkState,
            },
            modelParameters: {
                strategiesCount: getSelectedStrategiesCount(),
                strategyProximityLoops: getStrategyProximityLoops(),
                modulesCount: getSelectedModulesCount(),
                modulesImpactReviewLoops: getModulesImpactReviewLoops(),
                deepthinkDepth: getDeepthinkDepth(),
                isolateBranches: getIsolateBranchesEnabled(),
                deepthinkCodeExecutionEnabled: routingManager.getDeepthinkConfigController().isCodeExecutionEnabled(),
                thinkingLevel: getSelectedThinkingLevel(),
            },
            directContextFiles: globalState.directContextFiles || [],
        },
    };
    const options: SerializationOptions = {
        format: format === 'json' ? 'json' : 'msgpack',
        compress: format !== 'json',
        prettyPrint: format === 'json',
    };
    const blob = await serialize(config, options);
    const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];
    const ext = `${options.format === 'msgpack' ? 'msgpack' : 'json'}${options.compress ? '.gz' : ''}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iterative-studio-config-${timestamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function handleImportConfiguration(event: Event): Promise<void> {
    if (globalState.isGenerating) {
        alert("Cannot import configuration while generation is in progress.");
        return;
    }
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
        const raw = await deserialize<any>(file);
        if (!raw || typeof raw !== 'object' || typeof raw._version !== 'number' || !('data' in raw)) {
            throw new Error('Unsupported configuration file. Import a versioned Iterative Studio export.');
        }
        if (raw._version !== CURRENT_STATE_VERSION) {
            throw new Error(`Unsupported configuration version ${raw._version}. Expected version ${CURRENT_STATE_VERSION}.`);
        }
        const { data } = raw as VersionedState;
        const initialIdeaInput = document.getElementById('initial-idea') as HTMLTextAreaElement | null;
        if (initialIdeaInput) initialIdeaInput.value = data.initialIdea || '';
        globalState.directContextFiles = Array.isArray(data.directContextFiles) ? (data.directContextFiles as any) : [];
        updateUIAfterModeChange();
        (window as any).reinitializeSidebarControls?.();

        const prompts = data.customPrompts || {};
        globalState.customPromptsDeepthinkState = JSON.parse(JSON.stringify(prompts.deepthink || createDefaultCustomPromptsDeepthink()));

        setTimeout(() => {
            const modelConfig = routingManager.getModelConfigManager();
            for (const [k, v] of Object.entries(data.modelParameters || {})) {
                if (v !== undefined) modelConfig.updateParameter(k as any, v);
            }
            routingManager.getModelSelectionUI()?.syncUIWithParameters();
            routingManager.getDeepthinkConfigController().emitFullStateUpdate();
        }, 150);

        if (data.modeState) {
            deepthinkStateHandler.restoreState(sanitizeRecursive(data.modeState));
            deepthinkStateHandler.renderAfterImport();
        }
        updateControlsState();
    } catch (error) {
        alert(`Failed to import configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
        input.value = '';
    }
}

