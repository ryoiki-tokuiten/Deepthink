import { nanoid } from 'nanoid';
import { GenerateContentResponse, Part, ThinkingConfig } from '../../Routing/AIProvider';
import { CustomizablePromptsDeepthink } from '../prompts';
import {
    DeepthinkPipelineOrchestrator,
    PipelineStopRequestedError as OrchestratorStopRequestedError,
    extractJsonString,
} from './pipelineOrchestrator';
import { parsePromptToGeminiParts } from './contextBuilders';
import { globalState } from '../../Core/State';
import { isTerminalInferenceError } from '../../Core/ProviderError';
import type { CallAIOptions } from '../../Routing';
import type {
    DeepthinkRunConfig,
    DeepthinkPipelineState,
} from './types';

export type {
    DeepthinkRunConfig,
    DeepthinkSolutionCritiqueData,
    DeepthinkBranchIteration,
    DeepthinkMainStrategyData,
    DeepthinkModuleData,
    DeepthinkPipelineState,
    DeepthinkLiveEvent,
} from './types';

let activeDeepthinkPipeline: DeepthinkPipelineState | null = null;
let setActiveDeepthinkPipeline: ((pipeline: DeepthinkPipelineState | null) => void) | null = null;
let render: () => void = () => {};

export interface DeepthinkCoreDeps {
    callAI: (
        parts: Part[],
        modelToUse: string,
        systemInstruction?: string,
        isJson?: boolean,
        thinkingConfig?: ThinkingConfig,
        options?: CallAIOptions
    ) => Promise<GenerateContentResponse>;
    parseJsonSafe: (raw: string, context: string) => any;
    getSelectedModel: () => string;
    getSelectedStrategiesCount: () => number;
    getStrategyProximityLoops: () => number;
    getSelectedModulesCount: () => number;
    getModulesImpactReviewLoops: () => number;
    getDeepthinkDepth: () => number;
    getI?: () => number;
    getJ?: () => number;
    getK?: () => number;
    getIsolateBranchesEnabled: () => boolean;
    getDeepthinkCodeExecutionEnabled: () => boolean;
    updateControlsState: (newState: any) => void;
    getSelectedThinkingLevel?: () => string;
    getCustomPromptsDeepthinkState: () => CustomizablePromptsDeepthink;
    getBsrNoiseLevel?: () => number;
    getBsrPressureFloor?: () => number;
    getBsrWeightSmall?: () => number;
    getBsrWeightMedium?: () => number;
    getBsrWeightLarge?: () => number;
    getBsrWeightPreset?: () => string;
}

let deps: DeepthinkCoreDeps = null!;

function captureRunConfig(): DeepthinkRunConfig {
    const model = deps.getSelectedModel();
    if (!model?.trim()) throw new Error('No AI model selected for Deepthink execution.');
    return {
        i: Math.round(deps.getI?.() ?? (deps.getDeepthinkDepth ? deps.getDeepthinkDepth() : 10) ?? 10),
        j: Math.round(deps.getJ?.() ?? 4),
        k: Math.round(deps.getK?.() ?? 4),
        strategiesCount: deps.getSelectedStrategiesCount(),
        strategyProximityLoops: deps.getStrategyProximityLoops(),
        modulesCount: deps.getSelectedModulesCount(),
        modulesImpactReviewLoops: deps.getModulesImpactReviewLoops(),
        isolateBranches: Boolean(deps.getIsolateBranchesEnabled()),
        deepthinkCodeExecutionEnabled: Boolean(deps.getDeepthinkCodeExecutionEnabled()),
        thinkingLevel: deps.getSelectedThinkingLevel?.() || 'high',
        model: model.trim(),
        bsrNoiseLevel: deps.getBsrNoiseLevel?.() ?? 2,
        bsrPressureFloor: deps.getBsrPressureFloor?.() ?? 0.3,
        bsrWeightSmall: deps.getBsrWeightSmall?.() ?? 1,
        bsrWeightMedium: deps.getBsrWeightMedium?.() ?? 2,
        bsrWeightLarge: deps.getBsrWeightLarge?.() ?? 4,
        bsrWeightPreset: deps.getBsrWeightPreset?.() ?? 'standard',
    };
}

export function initializeDeepthinkCore(dependencies: DeepthinkCoreDeps & {
    setActiveDeepthinkPipeline: (pipeline: DeepthinkPipelineState | null) => void;
    renderActiveDeepthinkPipeline: () => void;
}) {
    const { setActiveDeepthinkPipeline: setFn, renderActiveDeepthinkPipeline: renderFn, ...coreDeps } = dependencies;
    deps = coreDeps as DeepthinkCoreDeps;
    setActiveDeepthinkPipeline = setFn;
    render = renderFn;
}

export function getActiveDeepthinkPipeline() {
    return activeDeepthinkPipeline;
}

export function setActiveDeepthinkPipelineForImport(pipeline: DeepthinkPipelineState | null) {
    activeDeepthinkPipeline = pipeline;
    setActiveDeepthinkPipeline?.(pipeline);
}

export function prunePipelineForExport(pipeline: DeepthinkPipelineState): DeepthinkPipelineState {
    const cloned = JSON.parse(JSON.stringify(pipeline));
    const directFiles: any[] = cloned.directContextFiles || globalState.directContextFiles || [];
    const imageFiles = directFiles.filter((f: any) => f.mimeType?.startsWith('image/'));

    let imgIndex = 0;
    if (typeof cloned.challenge === 'string') {
        cloned.challenge = cloned.challenge.replace(
            /<!-- EXECUTION_IMAGE_START -->\s*<!-- MIME_TYPE:\s*([^\s]+)\s*-->\s*([\s\S]*?)<!-- EXECUTION_IMAGE_END -->/g,
            (_match: string, mime: string) => {
                const targetFile = imageFiles[imgIndex++];
                const refPath = targetFile?.relativePath || `user_uploaded/${targetFile?.name || 'problem_image'}`;
                return `<!-- EXECUTION_IMAGE_REF: ${refPath} | MIME_TYPE: ${mime} -->`;
            }
        );
    }

    if (Array.isArray(cloned.liveEvents)) {
        for (const ev of cloned.liveEvents) {
            if (typeof ev.prompt === 'string') {
                ev.prompt = ev.prompt.replace(/<!-- EXECUTION_IMAGE_START -->[\s\S]*?<!-- EXECUTION_IMAGE_END -->/g, '[Image attachment referenced in user_uploaded]');
            }
            if (typeof ev.response === 'string') {
                ev.response = ev.response.replace(/<!-- EXECUTION_IMAGE_START -->[\s\S]*?<!-- EXECUTION_IMAGE_END -->/g, '[Image attachment referenced in user_uploaded]');
            }
        }
    }

    if (cloned.status === 'processing' || cloned.status === 'stopping') cloned.status = 'stopped';
    cloned.isStopRequested = false;
    return cloned;
}

export async function saveLatestDeepthinkState(pipeline: DeepthinkPipelineState): Promise<void> {
    if (!pipeline?.id) return;
    try {
        const initialIdea = (document.getElementById('initial-idea') as HTMLTextAreaElement)?.value || pipeline.challenge || '';
        const referencedDirectFiles = (globalState.directContextFiles || []).map(file => ({
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            relativePath: (file as any).relativePath || `user_uploaded/${file.name}`,
        }));

        (pipeline as any).directContextFiles = referencedDirectFiles;
        const pruned = prunePipelineForExport(pipeline);
        (pruned as any).directContextFiles = referencedDirectFiles;

        const config = {
            _version: '2.0.0',
            _exportedAt: new Date().toISOString(),
            _mode: 'deepthink',
            data: {
                currentMode: 'deepthink',
                initialIdea,
                selectedModel: pipeline.runConfig?.model || deps?.getSelectedModel?.() || '',
                modeState: { pipeline: pruned, activeTabId: pruned.activeTabId || 'live' },
                customPrompts: {
                    deepthink: deps?.getCustomPromptsDeepthinkState?.() ?? globalState.customPromptsDeepthinkState,
                    contextual: globalState.customPromptsContextualState,
                    adaptiveDeepthink: globalState.customPromptsAdaptiveDeepthinkState,
                },
                modelParameters: {
                    strategiesCount: pipeline.runConfig?.strategiesCount ?? deps?.getSelectedStrategiesCount?.() ?? 3,
                    strategyProximityLoops: pipeline.runConfig?.strategyProximityLoops ?? deps?.getStrategyProximityLoops?.() ?? 1,
                    modulesCount: pipeline.runConfig?.modulesCount ?? deps?.getSelectedModulesCount?.() ?? 4,
                    modulesImpactReviewLoops: pipeline.runConfig?.modulesImpactReviewLoops ?? deps?.getModulesImpactReviewLoops?.() ?? 1,
                    deepthinkDepth: pipeline.runConfig?.i ?? deps?.getDeepthinkDepth?.() ?? 10,
                    isolateBranches: pipeline.runConfig?.isolateBranches ?? deps?.getIsolateBranchesEnabled?.() ?? false,
                    deepthinkCodeExecutionEnabled: pipeline.runConfig?.deepthinkCodeExecutionEnabled ?? deps?.getDeepthinkCodeExecutionEnabled?.() ?? false,
                    thinkingLevel: pipeline.runConfig?.thinkingLevel ?? deps?.getSelectedThinkingLevel?.() ?? 'high',
                },
                directContextFiles: referencedDirectFiles,
            } as any,
        };

        const rt = await import('../../Core/SandboxToolRuntime');
        await rt?.saveSandboxLatestGz?.(pipeline.id, config);
    } catch (err) {
        console.warn('Notice: could not update latest.gz snapshot:', err);
    }
}

let isSavingLatestGz = false;
let pendingLatestGzPipeline: DeepthinkPipelineState | null = null;
let activeOrchestrator: DeepthinkPipelineOrchestrator | null = null;

export function resetInFlightPipelineExecution(pipeline: DeepthinkPipelineState): void {
    if (!pipeline) return;
    if (Array.isArray(pipeline.liveEvents)) {
        const completedIds = new Set<string>();
        for (const ev of pipeline.liveEvents) {
            if ((ev.eventType === 'agent_complete' || ev.eventType === 'agent_error') && ev.executionId) {
                completedIds.add(ev.executionId);
            }
        }
        pipeline.liveEvents = pipeline.liveEvents.filter(ev =>
            ev.eventType === 'info' || ev.eventType === 'agent_complete' || ev.eventType === 'agent_error' ||
            ((ev.eventType === 'agent_start' || ev.eventType === 'agent_retry') ? Boolean(ev.executionId && completedIds.has(ev.executionId)) : true)
        );
    }
    if (Array.isArray(pipeline.initialStrategies)) {
        for (const branch of pipeline.initialStrategies) {
            if (branch.status === 'processing') branch.status = branch.solutionAttempt ? 'completed' : 'pending';
            if (branch.correctionStatus === 'processing') branch.correctionStatus = 'pending';
            if (branch.solutionCritiqueStatus === 'processing') branch.solutionCritiqueStatus = branch.solutionCritique ? 'completed' : 'pending';
        }
    }
    if (pipeline.finalJudgingStatus === 'processing') pipeline.finalJudgingStatus = 'pending';
    if (pipeline.solutionCritiquesStatus === 'processing') pipeline.solutionCritiquesStatus = 'pending';
    if (pipeline.modulesGenStatus === 'processing') pipeline.modulesGenStatus = 'pending';
}

function notifyPipelineEvents(): void {
    window.dispatchEvent(new CustomEvent('deepthinkPipelineUpdated'));
    window.dispatchEvent(new CustomEvent('deepthinkPipelineStateChanged'));
    window.dispatchEvent(new CustomEvent('controlsStateUpdated'));
}

export function stopDeepthinkAnalysisProcess(): void {
    if (activeDeepthinkPipeline) {
        activeDeepthinkPipeline.isStopRequested = true;
        activeDeepthinkPipeline.status = 'stopped';
    }
    activeOrchestrator?.stop();
    if (activeDeepthinkPipeline) {
        resetInFlightPipelineExecution(activeDeepthinkPipeline);
        void saveLatestDeepthinkState(activeDeepthinkPipeline);
    }
    deps.updateControlsState({ isGenerating: false });
    render();
    notifyPipelineEvents();
}

export async function queueSaveLatestDeepthinkState(pipeline: DeepthinkPipelineState): Promise<void> {
    if (!pipeline?.id) return;
    if (isSavingLatestGz) {
        pendingLatestGzPipeline = pipeline;
        return;
    }
    isSavingLatestGz = true;
    try {
        await saveLatestDeepthinkState(pipeline);
    } finally {
        isSavingLatestGz = false;
        if (pendingLatestGzPipeline) {
            const next = pendingLatestGzPipeline;
            pendingLatestGzPipeline = null;
            void queueSaveLatestDeepthinkState(next);
        }
    }
}

async function executeOrchestrator(pipeline: DeepthinkPipelineState): Promise<void> {
    const orchestrator = new DeepthinkPipelineOrchestrator(pipeline as any, {
        callAI: async (args) => {
            const parts = parsePromptToGeminiParts(args.prompt) as any;
            const response = await deps.callAI(
                parts,
                args.model,
                args.systemInstruction,
                Boolean(args.responseSchema),
                args.thinkingConfig ? { thinkingLevel: args.thinkingConfig.thinkingLevel as any } : undefined,
                {
                    abortSignal: args.abortSignal,
                    retryDelaysMs: args.retryDelaysMs,
                    silenceTimeoutMs: args.silenceTimeoutMs,
                    label: args.stepDescription || `${args.agentKind || 'agent'}:${args.model}`,
                    onRetry: args.onRetry,
                }
            );
            return response.text || '';
        },
        parseJsonStrict: <T>(text: string): T => JSON.parse(extractJsonString(text)) as T,
        onLiveEvent: () => { render(); void queueSaveLatestDeepthinkState(pipeline); },
        onStateChange: () => { render(); void queueSaveLatestDeepthinkState(pipeline); },
    });
    activeOrchestrator = orchestrator;

    try {
        await orchestrator.run();
        pipeline.status = 'completed';
        await saveLatestDeepthinkState(pipeline);
    } catch (error: any) {
        if (
            error instanceof OrchestratorStopRequestedError ||
            error?.name === 'PipelineStopRequestedError' ||
            isTerminalInferenceError(error)
        ) {
            pipeline.status = 'stopped';
            pipeline.isStopRequested = false;
            resetInFlightPipelineExecution(pipeline);
            await saveLatestDeepthinkState(pipeline);
        } else {
            pipeline.status = 'error';
            pipeline.error = error.message || String(error);
            await saveLatestDeepthinkState(pipeline);
        }
    } finally {
        if (activeOrchestrator === orchestrator) activeOrchestrator = null;
        deps.updateControlsState({ isGenerating: false });
        render();
        notifyPipelineEvents();
    }
}

export async function startDeepthinkAnalysisProcess(challengeText: string, directContextFiles: any[] = []) {
    const runConfig = captureRunConfig();
    const customPrompts = deps.getCustomPromptsDeepthinkState();
    let fullChallengeText = challengeText;

    if (directContextFiles.length > 0) {
        const textFiles = directContextFiles.filter(file => file.mimeType.startsWith('text/') || file.mimeType === 'application/json');
        const imageFiles = directContextFiles.filter(file => file.mimeType.startsWith('image/'));
        if (textFiles.length > 0) {
            const decoder = new TextDecoder();
            const contents = textFiles.map(file => {
                try {
                    const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
                    return `\n\n--- ${file.name || 'uploaded text file'} ---\n${decoder.decode(bytes)}\n--- end file ---`;
                } catch {
                    return `\n\n--- ${file.name || 'uploaded text file'} ---\n[Unable to decode file]\n--- end file ---`;
                }
            });
            fullChallengeText += `\n\nDirect context files:${contents.join('')}`;
        }
        if (imageFiles.length > 0) {
            fullChallengeText += `\n\n${imageFiles.map(file => `<!-- EXECUTION_IMAGE_START -->\n<!-- MIME_TYPE: ${file.mimeType} -->\n${file.base64}\n<!-- EXECUTION_IMAGE_END -->`).join('\n\n')}`;
        }
    }

    activeDeepthinkPipeline = {
        id: `deepthink-${nanoid(12)}`,
        challenge: fullChallengeText,
        status: 'processing',
        activeTabId: 'live',
        activeStrategyTab: 0,
        isStopRequested: false,
        runConfig,
        customPrompts,
        initialStrategies: [],
        strategyGenerationHistory: [],
        strategyProximityHistory: [],
        modulesGenerationHistory: [],
        modules: [],
        modulesHistory: [],
        moduleRounds: [],
        solutionCritiques: [],
        memoryBankAgents: [],
        heartbeats: [],
        modulesImpactReviewHistory: [],
        bsrRecords: [],
        branchLedgers: {},
        dosOutputs: [],
        liveEvents: [],
        directContextFiles: directContextFiles.map(f => ({
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            relativePath: `user_uploaded/${f.name}`,
        })),
    } as any;

    setActiveDeepthinkPipeline?.(activeDeepthinkPipeline);
    deps.updateControlsState({ isGenerating: true });
    render();

    const pipeline = activeDeepthinkPipeline!;
    if (directContextFiles.length > 0) {
        try {
            const rt = await import('../../Core/SandboxToolRuntime');
            await rt?.ensureDeepthinkResultsRepository?.(pipeline.id);
            if (rt?.snapshotDeepthinkResultsRepository) {
                const seedContextFiles: any[] = directContextFiles.map(file => {
                    const relativePath = `user_uploaded/${file.name || 'unnamed_file'}`;
                    (file as any).relativePath = relativePath;
                    if (file.mimeType.startsWith('image/')) return { path: relativePath, base64: file.base64 };
                    try {
                        const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
                        return { path: relativePath, content: new TextDecoder().decode(bytes) };
                    } catch {
                        return { path: relativePath, content: file.base64 };
                    }
                });
                await rt.snapshotDeepthinkResultsRepository(pipeline.id, 'Seed direct context files', seedContextFiles);
            }
        } catch (err) {
            console.warn('Notice: could not seed direct context files into repository:', err);
        }
    }

    await saveLatestDeepthinkState(pipeline);
    await executeOrchestrator(pipeline);
}

export async function resumeDeepthinkAnalysisProcess() {
    if (!activeDeepthinkPipeline) {
        alert('No paused Deepthink pipeline found to resume.');
        return;
    }
    const pipeline = activeDeepthinkPipeline;
    pipeline.status = 'processing';
    pipeline.isStopRequested = false;
    delete pipeline.error;

    setActiveDeepthinkPipeline?.(pipeline);
    deps.updateControlsState({ isGenerating: true });
    render();
    notifyPipelineEvents();
    await executeOrchestrator(pipeline);
}
