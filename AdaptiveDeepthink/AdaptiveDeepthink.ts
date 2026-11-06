import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { nanoid } from 'nanoid';
import { messageContentToText, resolveProviderForModel } from '../Core/LangGraphToolRuntime';
import { describeProviderError, isTerminalInferenceError, isUserAbortError } from '../Core/ProviderError';
import { globalState } from '../Core/State';
import type { DeepthinkPipelineState } from '../Deepthink/core/deepthinkCore';
import { setActiveDeepthinkPipelineForImport } from '../Deepthink/ui/Deepthink';
import { callAI, getSelectedModel } from '../Routing';
import { updateControlsState } from '../UI/Controls';
import {
    createAdaptiveDeepthinkState,
    getDirectTextContext,
    syncAdaptiveDeepthinkPipeline,
    type AdaptiveAgentRole,
    type AdaptiveDeepthinkState,
    type AdaptiveDeepthinkToolCall,
    type AdaptiveDeepthinkToolExecutionContext,
    type AdaptiveDeepthinkToolPrompts,
    type AdaptivePassRecord,
} from './AdaptiveDeepthinkCore';
import { CustomizablePromptsAdaptiveDeepthink } from './AdaptiveDeepthinkPrompt';
import {
    createAdaptiveDeepthinkGraph,
    normalizeAdaptiveDeepthinkToolCall,
    type AdaptiveDeepthinkGraphState,
    type AdaptiveDeepthinkToolResultArtifact,
} from './AdaptiveDeepthinkToolGraph';

export type ResponseSegment =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tool: { type: string; rawType?: string; args?: any } };

export type SystemBlock =
    | { kind: 'error'; message: string }
    | { kind: 'tool_result'; tool: string; result: string; toolCall?: { type: string; rawType?: string; args?: any } };

export interface AdaptiveMessage {
    id: string;
    role: 'agent' | 'system' | 'user';
    sender?: string;
    content: string;
    timestamp: number;
    status?: 'success' | 'error' | 'processing';
    segments?: ResponseSegment[];
    blocks?: SystemBlock[];
}

export interface AdaptiveDeepthinkStoreState {
    id: string;
    coreState: AdaptiveDeepthinkState;
    messages: AdaptiveMessage[];
    isProcessing: boolean;
    isComplete: boolean;
    error?: string;
    deepthinkPipelineState: DeepthinkPipelineState;
    navigationState: { currentTab: string };
}

let activeAdaptiveDeepthinkState: AdaptiveDeepthinkStoreState | null = null;
let abortController: AbortController | null = null;
const listeners = new Set<(state: AdaptiveDeepthinkStoreState | null) => void>();

const ROLE_MODEL_MAP: Record<AdaptiveAgentRole, keyof CustomizablePromptsAdaptiveDeepthink> = {
    'strategy-generator': 'model_strategyGeneration',
    'strategy-proximity': 'model_strategyGeneration',
    'modules-generator': 'model_modulesGeneration',
    'modules-impact-review': 'model_modulesGeneration',
    'modules-testing': 'model_modulesTesting',
    execution: 'model_execution',
    critique: 'model_solutionCritique',
    correction: 'model_corrector',
};

export function subscribeToAdaptiveDeepthinkState(listener: (state: AdaptiveDeepthinkStoreState | null) => void) {
    listeners.add(listener);
    listener(activeAdaptiveDeepthinkState);
    return () => listeners.delete(listener);
}

function notifyAdaptiveDeepthinkListeners() {
    listeners.forEach(listener => listener(activeAdaptiveDeepthinkState ? { ...activeAdaptiveDeepthinkState } : null));
}

export function updateAdaptiveDeepthinkTab(tabId: string) {
    if (!activeAdaptiveDeepthinkState) return;
    activeAdaptiveDeepthinkState.navigationState.currentTab = tabId;
    activeAdaptiveDeepthinkState.deepthinkPipelineState.activeTabId = tabId;
    notifyAdaptiveDeepthinkListeners();
}

export function updateAdaptiveDeepthinkStrategyTab(strategyIndex: number) {
    if (!activeAdaptiveDeepthinkState) return;
    activeAdaptiveDeepthinkState.deepthinkPipelineState.activeStrategyTab = strategyIndex;
    notifyAdaptiveDeepthinkListeners();
}

const newMsgId = (prefix = 'msg') => `${prefix}-${nanoid(8)}`;

function formatToolCallDisplay(toolCall: AdaptiveDeepthinkToolCall): string {
    switch (toolCall.type) {
        case 'generate_strategies': return `generate_strategies(${toolCall.count})`;
        case 'generate_modules': return `generate_modules(${toolCall.count})`;
        case 'test_modules': return `test_modules(${toolCall.moduleIds.length})`;
        case 'execute': return `execute(${toolCall.executions.length})`;
        case 'save': return `save(${toolCall.strategyIds.join(', ')})`;
        case 'finalize_pass_and_execute': return `finalize_pass_and_execute(${toolCall.executions.length})`;
        case 'read_files': return `read_files(${toolCall.paths.length})`;
        case 'virtual_environment': return 'virtual_environment()';
        case 'submit_final_output': return 'submit_final_output()';
    }
}

function buildAgentMessage(message: AIMessage): AdaptiveMessage | null {
    const segments: ResponseSegment[] = [];
    const thinking = Array.isArray(message.content)
        ? message.content
            .filter((p): p is { text: string; thought: true } => !!p && typeof p === 'object' && 'thought' in p && p.thought === true && 'text' in p && typeof p.text === 'string')
            .map(p => p.text).join('\n').trim()
        : '';
    const narrative = messageContentToText(message.content);
    if (thinking) segments.push({ kind: 'text', text: thinking });
    if (narrative) segments.push({ kind: 'text', text: narrative });
    for (const inv of message.tool_calls ?? []) {
        const tc = normalizeAdaptiveDeepthinkToolCall(inv.name, inv.args);
        segments.push({ kind: 'tool', tool: { type: tc ? formatToolCallDisplay(tc) : inv.name, rawType: inv.name, args: inv.args } });
    }
    if (!segments.length) return null;
    return {
        id: newMsgId('agent'),
        role: 'agent',
        content: segments.filter(s => s.kind === 'text').map(s => s.text).join('\n').trim(),
        timestamp: Date.now(),
        status: 'success',
        segments,
    };
}

function buildSystemMessage(message: ToolMessage): AdaptiveMessage {
    const content = messageContentToText(message.content);
    const artifact = message.artifact as AdaptiveDeepthinkToolResultArtifact | undefined;
    const tool = artifact?.tool || message.name || 'tool';
    const isError = message.status === 'error';
    const blocks: SystemBlock[] = isError
        ? [{ kind: 'error', message: content }]
        : [{ kind: 'tool_result', tool, result: tool === 'submit_final_output' ? 'Submitted' : content }];
    return { id: newMsgId('system'), role: 'system', content, timestamp: Date.now(), status: isError ? 'error' : 'success', blocks };
}

function isAbortError(error: unknown): boolean {
    if (isTerminalInferenceError(error)) return false;
    return isUserAbortError(error) || (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted'));
}

function createInitialDeepthinkPipelineState(id: string, question: string): DeepthinkPipelineState {
    return {
        id,
        challenge: question,
        status: 'processing',
        activeTabId: 'live',
        activeStrategyTab: 0,
        initialStrategies: [],
        modules: [],
        solutionCritiques: [],
        modulesExplorerComplete: false,
        knowledgePacket: '',
        finalJudgingStatus: 'pending',
        isStopRequested: false,
        modulesGenStatus: 'pending',
        solutionCritiquesStatus: 'pending',
        liveEvents: [],
    } as unknown as DeepthinkPipelineState;
}

function createDeepthinkPrompts(prompts: CustomizablePromptsAdaptiveDeepthink): AdaptiveDeepthinkToolPrompts {
    return {
        sys_deepthink_initialStrategy: prompts.sys_adaptiveDeepthink_strategyGeneration,
        sys_deepthink_modulesGeneration: prompts.sys_adaptiveDeepthink_modulesGeneration,
        sys_deepthink_modulesTester: prompts.sys_adaptiveDeepthink_modulesTesting,
        sys_deepthink_solutionAttempt: prompts.sys_adaptiveDeepthink_execution,
        sys_deepthink_solutionCritique: prompts.sys_adaptiveDeepthink_solutionCritique,
        sys_deepthink_solutionCorrection: prompts.sys_adaptiveDeepthink_corrector,
    };
}

function extractJsonSlice(raw: string): string {
    const trimmed = raw.trim().replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start !== -1 && end !== -1 && start < end ? trimmed.slice(start, end + 1) : trimmed;
}

function createToolExecutionContext(
    pipeline: DeepthinkPipelineState,
    customPrompts: CustomizablePromptsAdaptiveDeepthink,
): AdaptiveDeepthinkToolExecutionContext {
    return {
        pipeline,
        callAI: callAI as any,
        cleanOutputByType: (raw: string, type?: string) => type === 'json' ? extractJsonSlice(raw) : raw,
        parseJsonSafe: (raw: string) => {
            try { return JSON.parse(raw); } catch {
                try { return JSON.parse(extractJsonSlice(raw)); } catch { return null; }
            }
        },
        getSelectedModel,
        getModelFor: role => customPrompts[ROLE_MODEL_MAP[role]] || getSelectedModel(),
        sandboxEnabled: globalState.virtualEnvironmentEnabled || globalState.directContextFiles.length > 0 || globalState.filesystemContextFiles.length > 0,
        notifyUpdate: notifyAdaptiveDeepthinkListeners,
        abortSignal: abortController?.signal,
    };
}

async function syncGraphState(graphState: AdaptiveDeepthinkGraphState, processedMessages: number) {
    if (!activeAdaptiveDeepthinkState) return;
    const nextMessages = [...activeAdaptiveDeepthinkState.messages];
    for (const message of graphState.messages.slice(processedMessages)) {
        const mapped = message instanceof AIMessage ? buildAgentMessage(message) : message instanceof ToolMessage ? buildSystemMessage(message) : null;
        if (mapped) nextMessages.push(mapped);
    }
    activeAdaptiveDeepthinkState.messages = nextMessages;
    activeAdaptiveDeepthinkState.coreState = graphState.coreState;
    syncAdaptiveDeepthinkPipeline(graphState.coreState, activeAdaptiveDeepthinkState.deepthinkPipelineState);
    setActiveDeepthinkPipelineForImport(activeAdaptiveDeepthinkState.deepthinkPipelineState);
    notifyAdaptiveDeepthinkListeners();
}

export async function startAdaptiveDeepthinkProcess(
    question: string,
    customPrompts: CustomizablePromptsAdaptiveDeepthink,
    images: Array<{ base64: string; mimeType: string }> = [],
) {
    if (activeAdaptiveDeepthinkState) stopAdaptiveDeepthinkProcess();
    if (!question || globalState.isAdaptiveDeepthinkRunning) return;
    const coreState = createAdaptiveDeepthinkState(question);
    coreState.status = 'processing';
    const pipeline = createInitialDeepthinkPipelineState(coreState.id, question);
    activeAdaptiveDeepthinkState = {
        id: coreState.id,
        coreState,
        messages: [],
        isProcessing: true,
        isComplete: false,
        deepthinkPipelineState: pipeline,
        navigationState: { currentTab: 'live' },
    };
    setActiveDeepthinkPipelineForImport(pipeline);
    globalState.isAdaptiveDeepthinkRunning = true;
    updateControlsState();
    abortController = new AbortController();
    notifyAdaptiveDeepthinkListeners();
    void runAdaptiveDeepthinkGraph(question, customPrompts, images).catch(error => console.error('Adaptive Deepthink Error:', error));
}

async function runAdaptiveDeepthinkGraph(question: string, customPrompts: CustomizablePromptsAdaptiveDeepthink, images: Array<{ base64: string; mimeType: string }>) {
    if (!activeAdaptiveDeepthinkState || !globalState.isAdaptiveDeepthinkRunning) return;
    let finalGraphState: AdaptiveDeepthinkGraphState | null = null;
    try {
        const pipeline = activeAdaptiveDeepthinkState.deepthinkPipelineState;
        const graph = createAdaptiveDeepthinkGraph({
            modelName: customPrompts.model_main || getSelectedModel(),
            systemPrompt: customPrompts.sys_adaptiveDeepthink_main,
            deepthinkPrompts: createDeepthinkPrompts(customPrompts),
            images,
            abortSignal: abortController?.signal,
            createExecutionContext: () => createToolExecutionContext(pipeline, customPrompts),
        });
        const challengeText = `Core Challenge:\n${question}${getDirectTextContext()}`;
        const { providerName } = resolveProviderForModel(customPrompts.model_main || getSelectedModel());
        const initialMessage = images.length === 0
            ? new HumanMessage(challengeText)
            : new HumanMessage({
                content: providerName === 'openai-compatible'
                    ? [...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })), { type: 'text', text: challengeText }]
                    : [...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })), { text: challengeText }]
            });
        const stream = await graph.stream({
            messages: [initialMessage],
            coreState: activeAdaptiveDeepthinkState.coreState,
            shouldExit: false,
        }, {
            streamMode: 'values',
            recursionLimit: 10_000,
            signal: abortController?.signal,
        });
        let processedMessages = 0;
        for await (const graphState of stream) {
            finalGraphState = graphState as AdaptiveDeepthinkGraphState;
            await syncGraphState(finalGraphState, processedMessages);
            processedMessages = finalGraphState.messages.length;
            if (abortController?.signal.aborted || !activeAdaptiveDeepthinkState) break;
        }
        if (!activeAdaptiveDeepthinkState) return;
        activeAdaptiveDeepthinkState.coreState = finalGraphState?.coreState || activeAdaptiveDeepthinkState.coreState;
        const submitted = !!activeAdaptiveDeepthinkState.coreState.selectedSolution;
        activeAdaptiveDeepthinkState.coreState.status = submitted ? 'completed' : 'error';
        activeAdaptiveDeepthinkState.isProcessing = false;
        activeAdaptiveDeepthinkState.isComplete = true;
        activeAdaptiveDeepthinkState.error = submitted ? undefined : 'The orchestrator stopped without submit_final_output.';
        if (!submitted) activeAdaptiveDeepthinkState.coreState.error = activeAdaptiveDeepthinkState.error;
        if (submitted) pipeline.status = 'completed';
        notifyAdaptiveDeepthinkListeners();
    } catch (error) {
        const userAborted = abortController?.signal.aborted && isAbortError(error) && !isTerminalInferenceError(error);
        if (!userAborted && activeAdaptiveDeepthinkState) {
            abortController?.abort();
            const message = error instanceof Error ? error.message : describeProviderError(error);
            activeAdaptiveDeepthinkState.messages.push({ id: newMsgId('system'), role: 'system', content: message, timestamp: Date.now(), status: 'error', blocks: [{ kind: 'error', message }] });
            activeAdaptiveDeepthinkState.coreState.status = 'error';
            activeAdaptiveDeepthinkState.coreState.error = message;
            activeAdaptiveDeepthinkState.isProcessing = false;
            activeAdaptiveDeepthinkState.isComplete = true;
            activeAdaptiveDeepthinkState.error = message;
            activeAdaptiveDeepthinkState.deepthinkPipelineState.status = 'error';
            notifyAdaptiveDeepthinkListeners();
        }
    } finally {
        globalState.isAdaptiveDeepthinkRunning = false;
        updateControlsState();
        abortController = null;
    }
}

export function stopAdaptiveDeepthinkProcess() {
    globalState.isAdaptiveDeepthinkRunning = false;
    abortController?.abort();
    abortController = null;
    updateControlsState();
    if (!activeAdaptiveDeepthinkState) return;
    activeAdaptiveDeepthinkState.isProcessing = false;
    activeAdaptiveDeepthinkState.isComplete = true;
    activeAdaptiveDeepthinkState.coreState.status = 'completed';
    activeAdaptiveDeepthinkState.deepthinkPipelineState.status = 'stopped';
    notifyAdaptiveDeepthinkListeners();
}

export function cleanupAdaptiveDeepthinkMode() {
    stopAdaptiveDeepthinkProcess();
    activeAdaptiveDeepthinkState = null;
    notifyAdaptiveDeepthinkListeners();
}

export function getAdaptiveDeepthinkState(): AdaptiveDeepthinkStoreState | null {
    return activeAdaptiveDeepthinkState;
}

function restoreMap<T>(value: unknown): Map<string, T> {
    if (value instanceof Map) return new Map(value);
    if (Array.isArray(value)) return new Map(value as Array<[string, T]>);
    if (value && typeof value === 'object') return new Map(Object.entries(value as Record<string, T>));
    return new Map();
}

export function setAdaptiveDeepthinkStateForImport(state: AdaptiveDeepthinkStoreState | null) {
    if (!state) {
        activeAdaptiveDeepthinkState = null;
    } else {
        const question = state.coreState?.question || '';
        const coreState = state.coreState ?? createAdaptiveDeepthinkState(question);
        coreState.strategies = restoreMap(coreState.strategies);
        coreState.modules = restoreMap(coreState.modules);
        coreState.moduleTestings = restoreMap(coreState.moduleTestings);
        coreState.executions = restoreMap(coreState.executions);
        coreState.passes = new Map(Array.from(restoreMap<AdaptivePassRecord>(coreState.passes).entries()).map(([key, value]) => [Number(key), value]));
        coreState.artifacts = restoreMap(coreState.artifacts);
        const pipeline = state.deepthinkPipelineState ?? createInitialDeepthinkPipelineState(coreState.id, question);
        syncAdaptiveDeepthinkPipeline(coreState, pipeline);
        activeAdaptiveDeepthinkState = {
            ...state,
            coreState,
            messages: Array.isArray(state.messages) ? state.messages : [],
            deepthinkPipelineState: pipeline,
            navigationState: state.navigationState ?? { currentTab: pipeline.activeTabId || 'strategic-solver' },
            isProcessing: false
        };
        setActiveDeepthinkPipelineForImport(pipeline);
    }
    globalState.isAdaptiveDeepthinkRunning = false;
    notifyAdaptiveDeepthinkListeners();
}
