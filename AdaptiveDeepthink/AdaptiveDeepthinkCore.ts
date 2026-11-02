/**
 * Adaptive Deepthink's pass-oriented orchestration tools.
 *
 * This mode intentionally reuses the independent Deepthink agents. The only
 * orchestration-specific behaviour lives here: strategy proximity / modules impact review
 * loops, pass compaction, saved branch immutability, and branch rollback.
 */

import { Part, GenerateContentResponse } from '../Routing/AIProvider';
import { HumanMessage } from '@langchain/core/messages';
import { nanoid } from 'nanoid';
import type {
    DeepthinkModuleData,
    DeepthinkLiveEvent,
    DeepthinkMainStrategyData,
    DeepthinkPipelineState,
    DeepthinkSolutionCritiqueData,
} from '../Deepthink/core/deepthinkCore';
import type { ProximityTurn } from '../Deepthink/core/types';

export interface AgentExecutionContext {
    callAI: any;
    cleanOutputByType: (raw: string, type?: string) => string;
    parseJsonSafe: (raw: string, context: string) => any;
    getSelectedModel: () => string;
    runPrompt: (args: {
        promptText: string;
        isJson: boolean;
        images: Array<{ base64: string; mimeType: string }>;
        systemPrompt?: string;
    }) => Promise<string>;
}

function normalizeProximityHistory(history?: ProximityTurn[]): ProximityTurn[] {
    return Array.isArray(history) ? history.filter(Boolean) : [];
}

async function refineWithProximity<T>(options: {
    loops: number;
    history: ProximityTurn[];
    version?: number;
    generate: (conversationHistory: string, revision: boolean) => Promise<{ candidates: T[]; output: string }>;
    review: (candidates: T[], conversationHistory: string, round: number) => Promise<string>;
    onHistory?: (history: ProximityTurn[]) => void;
}): Promise<{ candidates: T[]; history: ProximityTurn[] }> {
    const history = [...normalizeProximityHistory(options.history)];
    const formatHistory = () =>
        history.map(t => `<Turn role="${t.role}" turn="${t.turnNumber}">\n${t.content}\n</Turn>`).join('\n\n');
    const maxLoops = Math.max(0, Math.floor(options.loops || 0));
    let turnNumber = history.length + 1;
    let current = await options.generate(formatHistory(), false);
    history.push({ role: 'generator', content: current.output, turnNumber: turnNumber++, version: options.version });
    options.onHistory?.([...history]);
    for (let round = 1; round <= maxLoops; round++) {
        const reviewText = await options.review(current.candidates, formatHistory(), round);
        history.push({ role: 'proximity', content: reviewText, turnNumber: turnNumber++, version: options.version });
        options.onHistory?.([...history]);
        current = await options.generate(formatHistory(), true);
        history.push({ role: 'generator', content: current.output, turnNumber: turnNumber++, version: options.version });
        options.onHistory?.([...history]);
    }
    return { candidates: current.candidates, history };
}

async function generateStrategiesAgent(
    question: string,
    count: number,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { strategies: string[] }; error?: string }> {
    const promptText = `# Core Challenge\n${question}\n\nRequested Number of Strategies: ${count}\n\n${specialContext}\n\nImmediate Role: Strategy Generator`;
    const raw = await ctx.runPrompt({ promptText, isJson: true, images });
    const parsed = ctx.parseJsonSafe(raw, 'StrategyGenerator');
    const strategies = Array.isArray(parsed?.strategies) ? parsed.strategies.map(String) : [];
    return strategies.length ? { success: true, data: { strategies } } : { success: false, error: 'Failed to parse strategies JSON' };
}

async function strategiesProximityAgent(
    question: string,
    candidates: string[],
    conversationHistory: string,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { review: string }; error?: string }> {
    const promptText = [
        `# Core Challenge\n${question}`,
        `Current Candidate Strategies:\n${candidates.map((c, i) => `### Strategy ${i + 1}\n${c}`).join('\n\n')}`,
        conversationHistory,
        specialContext,
        'Immediate Role: Strategy Proximity Reviewer',
    ].filter(Boolean).join('\n\n');
    const review = await ctx.runPrompt({ promptText, isJson: false, images });
    return { success: true, data: { review } };
}

async function generateModulesAgent(
    question: string,
    count: number,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = [],
    _critiqueDriven = true
): Promise<{ success: boolean; data?: { modules: string[] }; error?: string }> {
    const promptText = `# Core Challenge\n${question}\n\nRequested Number of Modules: ${count}\n\n${specialContext}\n\nImmediate Role: Modules Generator`;
    const raw = await ctx.runPrompt({ promptText, isJson: true, images });
    const parsed = ctx.parseJsonSafe(raw, 'ModulesGenerator');
    const modules = Array.isArray(parsed?.modules)
        ? parsed.modules.map((m: any) => typeof m === 'string' ? m : String(m?.module ?? m?.text ?? JSON.stringify(m)))
        : [];
    return modules.length ? { success: true, data: { modules } } : { success: false, error: 'Failed to parse modules JSON' };
}

async function modulesImpactReviewAgent(
    question: string,
    candidates: string[],
    conversationHistory: string,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { review: string }; error?: string }> {
    const promptText = [
        `# Core Challenge\n${question}`,
        `Current Candidate Modules:\n${candidates.map((c, i) => `### Module ${i + 1}\n${c}`).join('\n\n')}`,
        conversationHistory,
        specialContext,
        'Immediate Role: Modules Impact Reviewer',
    ].filter(Boolean).join('\n\n');
    const review = await ctx.runPrompt({ promptText, isJson: false, images });
    return { success: true, data: { review } };
}

async function testModulesAgent(
    question: string,
    moduleIds: string[],
    modulesMap: Map<string, { text: string }>,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { results: Array<{ id: string; moduleText: string; testing: string; success: boolean; error?: string }> }; error?: string }> {
    const results = await Promise.all(moduleIds.map(async id => {
        const mod = modulesMap.get(id);
        if (!mod) return { id, moduleText: '', testing: '', success: false, error: 'Module not found' };
        const promptText = [`# Core Challenge\n${question}`, `<AssignedModule id="${id}">\n${mod.text}\n</AssignedModule>`, specialContext].filter(Boolean).join('\n\n');
        const testing = await ctx.runPrompt({ promptText, isJson: false, images });
        return { id, moduleText: mod.text, testing, success: true };
    }));
    return { success: true, data: { results } };
}

async function executeStrategiesAgent(
    question: string,
    requests: Array<{ strategyId: string; moduleIds: string[] }>,
    strategyMap: Map<string, { text: string }>,
    testMap: Map<string, { module: string; testing: string }>,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { results: Array<{ strategyId: string; execution: string; success: boolean; error?: string }> }; error?: string }> {
    const results = await Promise.all(requests.map(async req => {
        const strat = strategyMap.get(req.strategyId);
        if (!strat) return { strategyId: req.strategyId, execution: '', success: false, error: 'Strategy not found' };
        const modBlocks = req.moduleIds.map((mId, idx) => {
            const t = testMap.get(mId);
            return t ? `<Module ${idx + 1}>\nModule: ${t.module}\nModules Testing: ${t.testing}\n</Module ${idx + 1}>` : '';
        }).filter(Boolean).join('\n\n');
        const promptText = [
            `# Core Challenge\n${question}`,
            `<AssignedStrategy id="${req.strategyId}">\n${strat.text}\n</AssignedStrategy>`,
            modBlocks ? `<Full Information Packet>\n${modBlocks}\n</Full Information Packet>` : '',
            specialContext,
        ].filter(Boolean).join('\n\n');
        const execution = await ctx.runPrompt({ promptText, isJson: false, images });
        return { strategyId: req.strategyId, execution, success: true };
    }));
    return { success: true, data: { results } };
}

async function solutionCritiqueAgent(
    question: string,
    executionIds: string[],
    executionMap: Map<string, { strategy: string; execution: string }>,
    specialContext: string,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { results: Array<{ executionId: string; critique: string; success: boolean; error?: string }> }; error?: string }> {
    const results = await Promise.all(executionIds.map(async execId => {
        const item = executionMap.get(execId);
        if (!item) return { executionId: execId, critique: '', success: false, error: 'Execution not found' };
        const promptText = [
            `# Core Challenge\n${question}`,
            `<Strategy>\n${item.strategy}\n</Strategy>`,
            `<SolutionAttempt>\n${item.execution}\n</SolutionAttempt>`,
            specialContext,
        ].filter(Boolean).join('\n\n');
        const critique = await ctx.runPrompt({ promptText, isJson: false, images });
        return { executionId: execId, critique, success: true };
    }));
    return { success: true, data: { results } };
}

async function correctedSolutionsAgent(
    question: string,
    executionIds: string[],
    executionMap: Map<string, { strategy: string; execution: string }>,
    critiqueMap: Map<string, { critique: string; modulePacket?: string }>,
    _systemPrompt: string,
    ctx: AgentExecutionContext,
    images: Array<{ base64: string; mimeType: string }> = []
): Promise<{ success: boolean; data?: { results: Array<{ executionId: string; correctedSolution: string; success: boolean; error?: string }> }; error?: string }> {
    const results = await Promise.all(executionIds.map(async execId => {
        const item = executionMap.get(execId);
        const crit = critiqueMap.get(execId);
        if (!item || !crit) return { executionId: execId, correctedSolution: '', success: false, error: 'Execution or critique not found' };
        const promptText = [
            `# Core Challenge\n${question}`,
            `<Strategy>\n${item.strategy}\n</Strategy>`,
            `<SolutionAttempt>\n${item.execution}\n</SolutionAttempt>`,
            `<SolutionCritique>\n${crit.critique}\n</SolutionCritique>`,
            crit.modulePacket || '',
        ].filter(Boolean).join('\n\n');
        const correctedSolution = await ctx.runPrompt({ promptText, isJson: false, images });
        return { executionId: execId, correctedSolution, success: true };
    }));
    return { success: true, data: { results } };
}
import {
    ensureDeepthinkResultsRepository,
    expandInlineReferenceMarkers,
    restoreSandboxRepositoryStrategy,
    runSandboxToolAgent,
    runVirtualEnvironmentCommand,
    snapshotDeepthinkResultsRepository,
    snapshotSandboxRepositoryById,
    type SandboxRepositoryAccess,
    type SeedFile,
} from '../Core/SandboxToolRuntime';
import {
    describeProviderError,
    isTerminalInferenceError,
    isUserAbortError,
} from '../Core/ProviderError';
import { globalState } from '../Core/State';
import type { CallAIOptions } from '../Routing';

export type AdaptiveAgentRole =
    | 'strategy-generator'
    | 'strategy-proximity'
    | 'modules-generator'
    | 'modules-impact-review'
    | 'modules-testing'
    | 'execution'
    | 'critique'
    | 'correction';

export type AdaptiveDeepthinkToolCall =
    | { type: 'generate_strategies'; count: number; proximityLoops?: number; specialContext?: string; replaceStrategyIds?: string[] }
    | { type: 'generate_modules'; count: number; impactReviewLoops?: number; specialContext?: string }
    | { type: 'test_modules'; moduleIds: string[] }
    | { type: 'execute'; executions: AdaptiveExecutionRequest[]; specialContext?: string }
    | { type: 'save'; strategyIds: string[] }
    | { type: 'finalize_pass_and_execute'; executions: AdaptiveExecutionRequest[]; specialContext?: string }
    | { type: 'read_files'; paths: string[] }
    | { type: 'virtual_environment'; command: string; timeoutMs?: number }
    | { type: 'submit_final_output'; response: string };

interface AdaptiveExecutionRequest {
    strategyId: string;
    moduleIds: string[];
    /** Branch-local instructions. Never forwarded to critique or correction. */
    specialContext?: string;
}

export interface AdaptiveDeepthinkToolPrompts {
    sys_deepthink_initialStrategy: string;
    sys_deepthink_modulesGeneration: string;
    sys_deepthink_modulesTester: string;
    sys_deepthink_solutionAttempt: string;
    sys_deepthink_solutionCritique: string;
    sys_deepthink_solutionCorrection: string;
}

interface AdaptiveStrategy {
    id: string;
    text: string;
    slotIndex: number;
    saved: boolean;
    createdPass: number;
    updatedPass: number;
    preCorrectionSnapshot?: { commit: string; passNumber: number };
}

interface AdaptiveModule {
    id: string;
    text: string;
    passNumber: number;
}

interface AdaptiveModuleTesting {
    moduleText: string;
    testing: string;
    passNumber: number;
}

interface AdaptiveExecutionRecord {
    id: string;
    passNumber: number;
    strategyId: string;
    strategy: string;
    moduleIds: string[];
    execution: string;
    critique: string;
    correction: string;
}

export interface AdaptivePassRecord {
    passNumber: number;
    finalized: boolean;
    compactedFiles: string[];
    completedAt?: number;
}

interface AdaptiveArtifact {
    path: string;
    content: string;
}

export interface AdaptiveDeepthinkState {
    id: string;
    question: string;
    status: 'idle' | 'processing' | 'completed' | 'error';
    error?: string;
    passNumber: number;
    strategies: Map<string, AdaptiveStrategy>;
    modules: Map<string, AdaptiveModule>;
    moduleTestings: Map<string, AdaptiveModuleTesting>;
    executions: Map<string, AdaptiveExecutionRecord>;
    passes: Map<number, AdaptivePassRecord>;
    artifacts: Map<string, AdaptiveArtifact>;
    strategyGenerationHistory: ProximityTurn[];
    modulesGenerationHistory: ProximityTurn[];
    compactedContextLinks: string[];
    compactionBoundary?: number;
    selectedSolution?: string;
}

export interface AdaptiveDeepthinkToolExecutionContext {
    pipeline: DeepthinkPipelineState;
    callAI: (
        parts: Part[],
        modelToUse: string,
        systemInstruction?: string,
        isJson?: boolean,
        thinkingConfig?: any,
        options?: CallAIOptions
    ) => Promise<GenerateContentResponse>;
    cleanOutputByType: (raw: string, type?: string) => string;
    parseJsonSafe: (raw: string, context: string) => any;
    getSelectedModel: () => string;
    getModelFor: (role: AdaptiveAgentRole) => string;
    sandboxEnabled: boolean;
    images?: Array<{ base64: string; mimeType: string }>;
    notifyUpdate?: () => void;
    abortSignal?: AbortSignal;
}

const MAX_BATCH_SIZE = 5;
const DEFAULT_PROXIMITY_LOOPS = 2;

/**
 * Adaptive owns its embedded React tree. Mutating the shared pipeline without
 * invoking DeepthinkCore's renderer keeps that tree intact while still feeding
 * the exact event shape consumed by DeepthinkLiveTab on the next state sync.
 */
function addAdaptiveLiveEvent(
    context: AdaptiveDeepthinkToolExecutionContext,
    agentName: string,
    stepDescription: string,
    eventType: DeepthinkLiveEvent['eventType'],
    details: Partial<DeepthinkLiveEvent> = {}
): void {
    const pipeline = context.pipeline;
    if (!pipeline.liveEvents) pipeline.liveEvents = [];
    pipeline.liveEvents.push({
        id: `adaptive-ev-${nanoid(8)}`,
        timestamp: Date.now(),
        agentName,
        stepDescription,
        eventType,
        ...details,
    });
    if (context.notifyUpdate) {
        context.notifyUpdate();
    }
}

function seedFiles(): SeedFile[] {
    return globalState.directContextFiles.map((file, index) => ({
        name: file.name || `adaptive-upload-${index + 1}`,
        mimeType: file.mimeType,
        base64: file.base64,
    }));
}

function roleLabel(role: AdaptiveAgentRole): string {
    return {
        'strategy-generator': 'Strategy Generator',
        'strategy-proximity': 'Strategies Proximity',
        'modules-generator': 'Modules Generator',
        'modules-impact-review': 'Modules Impact Reviewer',
        'modules-testing': 'Modules Testing',
        execution: 'Execution',
        critique: 'Critique',
        correction: 'Correction',
    }[role];
}

function safeSegment(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'run';
}

function pathFor(state: AdaptiveDeepthinkState, strategyId: string | undefined, role: AdaptiveAgentRole, suffix = ''): string {
    const pass = String(state.passNumber).padStart(2, '0');
    const agent = roleLabel(role).replace(/\s+/g, '-');
    return `Pass-${pass}${strategyId ? `-${strategyId}` : ''}-${agent}${suffix}`;
}

function recordArtifact(state: AdaptiveDeepthinkState, path: string, content: string): void {
    state.artifacts.set(path, { path, content });
}

function nextArtifactPath(state: AdaptiveDeepthinkState, basePath: string): string {
    if (!state.artifacts.has(basePath)) return basePath;
    const extensionIndex = basePath.lastIndexOf('.');
    const stem = extensionIndex >= 0 ? basePath.slice(0, extensionIndex) : basePath;
    const extension = extensionIndex >= 0 ? basePath.slice(extensionIndex) : '';
    let version = 2;
    while (state.artifacts.has(`${stem}-v${version}${extension}`)) version++;
    return `${stem}-v${version}${extension}`;
}

function artifactOutputPath(state: AdaptiveDeepthinkState, strategyId: string | undefined, role: AdaptiveAgentRole): string {
    return `${pathFor(state, strategyId, role)}.md`;
}

function strategyDirectory(strategy: AdaptiveStrategy): string {
    return `Strategy-${strategy.slotIndex + 1}`;
}

function moduleLabel(id: string): string {
    return id.replace(/^M/i, '') || '1';
}

function repositoryAccess(
    state: AdaptiveDeepthinkState,
    role: AdaptiveAgentRole,
    strategy?: AdaptiveStrategy,
    moduleId?: string,
    _selectedModuleIds: string[] = []
): SandboxRepositoryAccess {
    if (role === 'modules-testing') {
        const label = moduleLabel(moduleId || '1');
        return {
            repositoryId: state.id,
            agentDirectory: `Modules/Heartbeat-${state.passNumber}/Module-${label}`,
            fullRepositoryRead: true,
        };
    }

    if (strategy) {
        return {
            repositoryId: state.id,
            agentDirectory: strategyDirectory(strategy),
            fullRepositoryRead: true,
        };
    }

    return {
        repositoryId: state.id,
        fullRepositoryRead: true,
    };
}

function syncAgentContext(
    state: AdaptiveDeepthinkState,
    context: AdaptiveDeepthinkToolExecutionContext,
    role: AdaptiveAgentRole,
    systemPrompt: string,
    strategy?: AdaptiveStrategy,
    moduleId?: string,
    selectedModuleIds: string[] = [],
    executionGroupId?: string,
    executionGroupName?: string
): AgentExecutionContext {
    const modelName = context.getModelFor(role);
    const agentName = roleLabel(role);
    const access = repositoryAccess(state, role, strategy, moduleId, selectedModuleIds);
    const strategyId = strategy?.id;

    return {
        callAI: context.callAI,
        cleanOutputByType: context.cleanOutputByType,
        parseJsonSafe: context.parseJsonSafe,
        getSelectedModel: () => modelName,
        runPrompt: async ({ promptText, isJson, images }) => {
            const executionId = nanoid(8);
            addAdaptiveLiveEvent(context, agentName, `Invoking ${agentName} agent`, 'agent_start', {
                systemInstruction: systemPrompt,
                prompt: promptText,
                modelName,
                codeExecutionEnabled: context.sandboxEnabled,
                executionId,
                executionGroupId,
                executionGroupName,
            });
            try {
                if (context.abortSignal?.aborted) throw new Error('Adaptive Deepthink process was stopped.');

                if (!context.sandboxEnabled) {
                    const nonSandboxSystemPrompt = [
                        systemPrompt,
                        '',
                        '<Runtime Tool Availability>',
                        'deepthinkCodeExecutionEnabled = false. Sandbox terminal execution and tool calling (sandbox_exec, shared_workspace, final_output) are DISABLED for this run.',
                        'Do NOT attempt to call sandbox_exec, shared_workspace, final_output, or any other tool or function.',
                        'Output your complete final response directly as normal text/markdown (or raw JSON when your role requires JSON).',
                        '</Runtime Tool Availability>',
                    ].join('\n');
                    const response = await context.callAI(
                        [...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } })), { text: promptText }],
                        modelName,
                        nonSandboxSystemPrompt,
                        isJson,
                        undefined,
                        {
                            abortSignal: context.abortSignal,
                            label: `${agentName} (${modelName})`,
                            onRetry: (attempt, maxRetries, delayMs, err) => {
                                const mins = Math.round((delayMs / 60_000) * 10) / 10;
                                addAdaptiveLiveEvent(
                                    context,
                                    agentName,
                                    `${agentName} call failed (attempt ${attempt}/${maxRetries + 1}): ${describeProviderError(err)}. Retrying in ${mins}m...`,
                                    'agent_retry',
                                    {
                                        error: describeProviderError(err),
                                        attempt,
                                        modelName,
                                        codeExecutionEnabled: false,
                                        executionId,
                                        executionGroupId,
                                        executionGroupName,
                                    }
                                );
                            },
                        }
                    );
                    const output = context.cleanOutputByType(response.text || '', isJson ? 'json' : undefined);
                    if (!output || !output.trim()) {
                        throw new Error(`Empty response received from ${agentName}.`);
                    }
                    const outputPath = nextArtifactPath(state, artifactOutputPath(state, strategyId, role));
                    recordArtifact(state, outputPath, output);
                    recordArtifact(state, outputPath.replace(/\.md$/, '.trace.json'), JSON.stringify({
                         schema: 'adaptive_deepthink_native_agent_trace.v1',
                         agent: agentName,
                         model: modelName,
                         prompt: promptText,
                         response: output,
                    }, null, 2));
                    addAdaptiveLiveEvent(context, agentName, `${agentName} agent completed`, 'agent_complete', {
                        response: output,
                        modelName,
                        codeExecutionEnabled: false,
                        executionId,
                        executionGroupId,
                        executionGroupName,
                    });
                    return output;
                }
                const result = await runSandboxToolAgent({
                    agentName,
                    sessionId: `adaptive-${safeSegment(state.id)}-${safeSegment(agentName)}-${safeSegment(strategyId || moduleId || `pass-${state.passNumber}`)}`,
                    messages: [new HumanMessage(promptText)],
                    systemPrompt,
                    modelName,
                    seedFiles: seedFiles(),
                    runScopeDescription: 'same Adaptive Deepthink run',
                    repositoryAccess: access,
                    abortSignal: context.abortSignal,
                    onRetry: (attempt, maxRetries, delayMs, err) => {
                        const mins = Math.round((delayMs / 60_000) * 10) / 10;
                        addAdaptiveLiveEvent(
                            context,
                            agentName,
                            `${agentName} sandbox turn failed (attempt ${attempt}/${maxRetries + 1}): ${describeProviderError(err)}. Retrying in ${mins}m...`,
                            'agent_retry',
                            {
                                error: describeProviderError(err),
                                attempt,
                                modelName,
                                codeExecutionEnabled: true,
                                executionId,
                                executionGroupId,
                                executionGroupName,
                            }
                        );
                    },
                    agentFilesystemRules: [
                        '- This agent is one independent role in Adaptive Deepthink.',
                        '- Its submitted final_output is passed only through the orchestration contract described in the prompt.',
                    ],
                });
                const output = isJson ? result.finalText : (result.promptText || result.finalText || result.text);
                if (!output || !output.trim()) {
                    throw new Error(`Empty response received from ${agentName}.`);
                }
                const outputPath = nextArtifactPath(state, artifactOutputPath(state, strategyId, role));
                recordArtifact(state, outputPath, output);
                recordArtifact(state, outputPath.replace(/\.md$/, '.trace.json'), result.executionTraceText || JSON.stringify({
                    schema: 'adaptive_deepthink_sandbox_agent_trace.v1',
                    agent: agentName,
                    model: modelName,
                    prompt: promptText,
                    response: output,
                }, null, 2));
                addAdaptiveLiveEvent(context, agentName, `${agentName} agent completed`, 'agent_complete', {
                    response: result.text,
                    executionTraceText: result.executionTraceText,
                    modelName,
                    codeExecutionEnabled: true,
                    executionId,
                    executionGroupId,
                    executionGroupName,
                });
                return output;
            } catch (error) {
                const message = error instanceof Error ? error.message : describeProviderError(error);
                addAdaptiveLiveEvent(context, agentName, `${agentName} agent failed: ${message}`, 'agent_error', {
                    error: message,
                    modelName,
                    codeExecutionEnabled: context.sandboxEnabled,
                    executionId,
                    executionGroupId,
                    executionGroupName,
                });
                throw error;
            }
        },
    };
}

function firstError(response: { success: boolean; error?: string }): string | null {
    return response.success ? null : (response.error || 'Agent call failed.');
}


function recentExecutionCritiques(state: AdaptiveDeepthinkState): string {
    const latestPass = Math.max(0, ...Array.from(state.executions.values()).map(record => record.passNumber));
    const records = Array.from(state.executions.values())
        .filter(record => record.passNumber === latestPass && !state.strategies.get(record.strategyId)?.saved)
        .map(record => `<Execution-Critique strategy="${record.strategyId}">\n<Execution>\n${record.execution}\n</Execution>\n<Critique>\n${record.critique}\n</Critique>\n</Execution-Critique>`);
    return records.join('\n\n') || 'No execution-critique packet exists yet.';
}

function previousExecutionCritiqueForStrategy(state: AdaptiveDeepthinkState, strategyId: string): string {
    const previous = Array.from(state.executions.values())
        .filter(record => record.strategyId === strategyId && record.passNumber < state.passNumber)
        .sort((left, right) => right.passNumber - left.passNumber)[0];
    if (!previous) return '';
    return [
        '<Previous Pass Execution-Critique>',
        '<Original Execution>',
        previous.execution,
        '</Original Execution>',
        '<Critique>',
        previous.critique,
        '</Critique>',
        '</Previous Pass Execution-Critique>',
        'Use this as diagnostic evidence. Do not reuse its correction or assume its files remain valid.',
    ].join('\n');
}

function nextStrategyId(state: AdaptiveDeepthinkState): { id: string; slotIndex: number } | null {
    for (let slotIndex = 0; slotIndex < MAX_BATCH_SIZE; slotIndex++) {
        const id = `S${slotIndex + 1}`;
        if (!state.strategies.has(id)) return { id, slotIndex };
    }
    return null;
}

function setStrategies(
    state: AdaptiveDeepthinkState,
    candidates: string[],
    replaceStrategyIds?: string[]
): string[] {
    const replacements = replaceStrategyIds?.length
        ? replaceStrategyIds
        : Array.from(state.strategies.values()).filter(strategy => !strategy.saved).map(strategy => strategy.id);
    const replacementSet = new Set(replacements);
    const oldById = new Map(state.strategies);
    replacements.forEach(id => {
        const strategy = state.strategies.get(id);
        if (strategy?.saved) throw new Error(`Saved strategy ${id} is immutable and cannot be replaced.`);
        state.strategies.delete(id);
    });

    const assigned: string[] = [];
    candidates.forEach((text, index) => {
        const replacementId = replacements[index];
        const previous = replacementId ? oldById.get(replacementId) : undefined;
        const next = previous
            ? { id: previous.id, slotIndex: previous.slotIndex }
            : nextStrategyId(state);
        if (!next) return;
        state.strategies.set(next.id, {
            id: next.id,
            text,
            slotIndex: next.slotIndex,
            saved: false,
            createdPass: previous?.createdPass || state.passNumber,
            updatedPass: state.passNumber,
        });
        assigned.push(next.id);
    });

    // Explicit replacements preserve untouched ongoing strategies. An initial
    // generation intentionally discards every unsaved candidate it replaced.
    if (!replaceStrategyIds?.length) {
        for (const [id, strategy] of state.strategies) {
            if (!strategy.saved && !assigned.includes(id) && !replacementSet.has(id)) state.strategies.delete(id);
        }
    }
    return assigned;
}

export function getDirectTextContext(): string {
    const textFiles = globalState.directContextFiles.filter(file => file.mimeType.startsWith('text/') || file.mimeType === 'application/json');
    if (!textFiles.length) return '';
    const decoder = new TextDecoder();
    const contents = textFiles.map(file => {
        try {
            const binary = atob(file.base64);
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            return `\n\n--- ${file.name || 'uploaded text file'} ---\n${decoder.decode(bytes)}\n--- end file ---`;
        } catch {
            return `\n\n--- ${file.name || 'uploaded text file'} ---\n[Unable to decode file]\n--- end file ---`;
        }
    });
    return `\n\nDirect context files:${contents.join('')}`;
}

async function executeWithRetry<T extends { success: boolean; error?: string }>(
    agentCall: () => Promise<T>,
    context: AdaptiveDeepthinkToolExecutionContext,
    agentRole: string,
    maxRetries = 2
): Promise<T> {
    let lastResponse: T | null = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (context.abortSignal?.aborted) {
            throw new Error('Adaptive Deepthink process was stopped.');
        }
        try {
            const response = await agentCall();
            if (response.success && (response as any).data) {
                return response;
            }
            lastResponse = response;
            const errorMsg = response.error || 'Unknown agent error';
            console.warn(`[Retry Warning] Agent ${agentRole} attempt ${attempt} failed: ${errorMsg}`);
            addAdaptiveLiveEvent(context, 'Orchestrator' as any, `Agent ${agentRole} attempt ${attempt} failed internally. Retrying... (Error: ${errorMsg})`, 'info');
        } catch (err: any) {
            if (isTerminalInferenceError(err) || isUserAbortError(err) || context.abortSignal?.aborted) {
                throw err;
            }
            const errorMsg = err?.message || String(err);
            console.warn(`[Retry Warning] Agent ${agentRole} attempt ${attempt} threw error: ${errorMsg}`);
            addAdaptiveLiveEvent(context, 'Orchestrator' as any, `Agent ${agentRole} attempt ${attempt} threw error internally. Retrying... (Error: ${errorMsg})`, 'info');
            lastResponse = { success: false, error: errorMsg } as unknown as T;
        }
    }
    const terminalErr = new Error(lastResponse?.error || `Agent ${agentRole} failed after ${maxRetries + 1} attempts.`) as Error & { isTerminalInferenceError?: boolean };
    terminalErr.isTerminalInferenceError = true;
    throw terminalErr;
}

async function generateStrategyBatch(
    state: AdaptiveDeepthinkState,
    toolCall: Extract<AdaptiveDeepthinkToolCall, { type: 'generate_strategies' }>,
    context: AdaptiveDeepthinkToolExecutionContext,
    prompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }>
): Promise<string> {
    const replaceCount = toolCall.replaceStrategyIds?.length
        ? toolCall.replaceStrategyIds.filter(id => !state.strategies.get(id)?.saved).length
        : Array.from(state.strategies.values()).filter(strategy => !strategy.saved).length;
    const occupiedAfterReplacement = state.strategies.size - replaceCount;
    const count = Math.min(toolCall.count, MAX_BATCH_SIZE - occupiedAfterReplacement);
    if (count < 1) return '[ERROR: All five strategy slots are permanently saved.]';

    const executionGroupId = `group-${nanoid(8)}`;
    const executionGroupName = 'Strategy Generation Loop';
    const taskContext = toolCall.specialContext || 'Generate the requested strategy batch.';
    state.strategyGenerationHistory = normalizeProximityHistory(state.strategyGenerationHistory);
    const generatorContext = syncAgentContext(state, context, 'strategy-generator', prompts.sys_deepthink_initialStrategy, undefined, undefined, [], executionGroupId, executionGroupName);
    const proximityContext = syncAgentContext(state, context, 'strategy-proximity', prompts.sys_deepthink_initialStrategy, undefined, undefined, [], executionGroupId, executionGroupName);
    const result = await refineWithProximity<string>({
        loops: toolCall.proximityLoops ?? DEFAULT_PROXIMITY_LOOPS,
        history: state.strategyGenerationHistory,
        generate: async (conversationHistory, revision) => {
            const generationContext = [
                taskContext,
                conversationHistory,
                revision
                    ? 'Revise the current strategies in response to the latest proximity review. Preserve valuable coverage, replace convergent or structurally weak ideas, and return the same number of distinct strategies.'
                    : '',
            ].filter(Boolean).join('\n\n');
            const response = await executeWithRetry(
                () => generateStrategiesAgent(state.question + getDirectTextContext(), count, generationContext, prompts.sys_deepthink_initialStrategy, generatorContext, images),
                context,
                'strategy-generator'
            );
            const error = firstError(response);
            if (error || !response.data) throw new Error(error || 'Strategy generator returned no data.');
            const candidates = (response.data.strategies as unknown[]).slice(0, count).map(value => String(value));
            if (!candidates.length) throw new Error('Strategy generator returned no strategies.');
            return {
                candidates,
                output: JSON.stringify({ strategies: candidates }, null, 2),
            };
        },
        review: async (candidates, conversationHistory, round) => {
            if (context.abortSignal?.aborted) throw new Error('Adaptive Deepthink process was stopped.');
            const response = await executeWithRetry(
                () => strategiesProximityAgent(
                    state.question + getDirectTextContext(),
                    candidates,
                    conversationHistory,
                    taskContext,
                    prompts.sys_deepthink_initialStrategy,
                    proximityContext,
                    images,
                ),
                context,
                'strategy-proximity'
            );
            const error = firstError(response);
            if (error || !response.data) throw new Error(error || 'Strategies proximity returned no data.');
            const review = String(response.data.review);
            recordArtifact(state, `${pathFor(state, undefined, 'strategy-proximity', `-Round-${round}`)}.md`, review);
            return review;
        },
        onHistory: history => {
            state.strategyGenerationHistory = history;
            context.notifyUpdate?.();
        },
    });

    const candidates = result.candidates;
    const assigned = setStrategies(state, candidates, toolCall.replaceStrategyIds);
    state.strategyGenerationHistory = result.history;
    recordArtifact(state, `${pathFor(state, undefined, 'strategy-generator', '-Final-Strategies')}.md`, candidates.map((strategy, index) => `## ${assigned[index] || `S${index + 1}`}\n\n${strategy}`).join('\n\n'));
    return `<Strategies pass="${state.passNumber}">\n${assigned.map(id => `<Strategy id="${id}">\n${state.strategies.get(id)?.text}\n</Strategy>`).join('\n\n')}\n</Strategies>`;
}

async function generateModulesBatch(
    state: AdaptiveDeepthinkState,
    toolCall: Extract<AdaptiveDeepthinkToolCall, { type: 'generate_modules' }>,
    context: AdaptiveDeepthinkToolExecutionContext,
    prompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }>
): Promise<string> {
    if (!Array.from(state.executions.values()).some(record => !state.strategies.get(record.strategyId)?.saved)) {
        return '[ERROR: Modules must be critique-driven. Execute and critique at least one strategy before generating modules.]';
    }
    const count = Math.min(toolCall.count, MAX_BATCH_SIZE);
    const critiquePacket = recentExecutionCritiques(state);
    const baseContext = [
        toolCall.specialContext || '',
        '<Latest Execution-Critique Packet>',
        critiquePacket,
        '</Latest Execution-Critique Packet>',
        'Generate critique-driven modules only. Do not inspect strategies, prior module packets, or correction output.',
    ].filter(Boolean).join('\n\n');
    const executionGroupId = `group-${nanoid(8)}`;
    const executionGroupName = 'Modules Generation Loop';
    state.modulesGenerationHistory = normalizeProximityHistory(state.modulesGenerationHistory);
    const generatorContext = syncAgentContext(state, context, 'modules-generator', prompts.sys_deepthink_modulesGeneration, undefined, undefined, [], executionGroupId, executionGroupName);
    const impactReviewContext = syncAgentContext(state, context, 'modules-impact-review', prompts.sys_deepthink_modulesGeneration, undefined, undefined, [], executionGroupId, executionGroupName);
    const result = await refineWithProximity<string>({
        loops: toolCall.impactReviewLoops ?? DEFAULT_PROXIMITY_LOOPS,
        history: state.modulesGenerationHistory,
        version: state.passNumber,
        generate: async (conversationHistory, revision) => {
            const generationContext = [
                baseContext,
                conversationHistory,
                revision
                    ? 'Revise modules against the latest impact review. Keep them high-impact, orthogonal, and critique-driven.'
                    : '',
            ].filter(Boolean).join('\n\n');
            const response = await executeWithRetry(
                () => generateModulesAgent(
                    state.question + getDirectTextContext(),
                    count,
                    generationContext,
                    prompts.sys_deepthink_modulesGeneration,
                    generatorContext,
                    images,
                    true,
                ),
                context,
                'modules-generator'
            );
            const error = firstError(response);
            if (error || !response.data) throw new Error(error || 'Modules Generator returned no data.');
            const candidates = (response.data.modules as unknown[]).slice(0, count).map(value => String(value));
            if (!candidates.length) throw new Error('Modules Generator returned no modules.');
            return {
                candidates,
                output: JSON.stringify({ modules: candidates }, null, 2),
            };
        },
        review: async (candidates, conversationHistory, round) => {
            if (context.abortSignal?.aborted) throw new Error('Adaptive Deepthink process was stopped.');
            const response = await executeWithRetry(
                () => modulesImpactReviewAgent(
                    state.question + getDirectTextContext(),
                    candidates,
                    conversationHistory,
                    baseContext,
                    prompts.sys_deepthink_modulesGeneration,
                    impactReviewContext,
                    images,
                ),
                context,
                'modules-impact-review'
            );
            const error = firstError(response);
            if (error || !response.data) throw new Error(error || 'Modules Impact Reviewer returned no data.');
            const review = String(response.data.review);
            recordArtifact(state, `${pathFor(state, undefined, 'modules-impact-review', `-Round-${round}`)}.md`, review);
            return review;
        },
        onHistory: history => {
            state.modulesGenerationHistory = history;
            context.notifyUpdate?.();
        },
    });
    const candidates = result.candidates;

    // Modules are intentionally ephemeral. A new batch deletes the entire
    // previous batch and its tests; no stale corrective local minima survive.
    state.modules.clear();
    state.moduleTestings.clear();
    state.modulesGenerationHistory = result.history;
    const ids = candidates.map((text, index) => {
        const id = `M${index + 1}`;
        state.modules.set(id, { id, text, passNumber: state.passNumber });
        return id;
    });
    recordArtifact(state, `${pathFor(state, undefined, 'modules-generator', '-Final-Modules')}.md`, candidates.map((moduleText, index) => `## ${ids[index]}\n\n${moduleText}`).join('\n\n'));
    return `<Modules pass="${state.passNumber}">\n${ids.map(id => `<Module id="${id}">\n${state.modules.get(id)?.text}\n</Module>`).join('\n\n')}\n</Modules>`;
}

async function testModules(
    state: AdaptiveDeepthinkState,
    moduleIds: string[],
    context: AdaptiveDeepthinkToolExecutionContext,
    prompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }>
): Promise<string> {
    const executionGroupId = `group-${nanoid(8)}`;
    const executionGroupName = 'Modules Testing Phase';

    const results = await Promise.all(moduleIds.slice(0, MAX_BATCH_SIZE).map(async id => {
        const moduleItem = state.modules.get(id);
        if (!moduleItem) return { id, error: 'Module not found.' };
        const localModules = new Map([[id, { text: moduleItem.text }]]);
        const response = await executeWithRetry(
            () => testModulesAgent(
                state.question + getDirectTextContext(),
                [id],
                localModules,
                '',
                prompts.sys_deepthink_modulesTester,
                syncAgentContext(state, context, 'modules-testing', prompts.sys_deepthink_modulesTester, undefined, id, [], executionGroupId, executionGroupName),
                images,
            ),
            context,
            'modules-testing'
        );
        const error = firstError(response);
        const result = response.data?.results?.[0];
        if (error || !result?.success || !result.testing?.trim()) {
            const fatalErr = new Error(error || result?.error || `Module test for ${id} failed or returned empty output.`) as Error & { isTerminalInferenceError?: boolean };
            fatalErr.isTerminalInferenceError = true;
            throw fatalErr;
        }
        state.moduleTestings.set(id, { moduleText: result.moduleText, testing: result.testing, passNumber: state.passNumber });
        recordArtifact(state, `${pathFor(state, id, 'modules-testing')}.md`, result.testing);
        return { id, testing: result.testing };
    }));
    return `<ModuleTests pass="${state.passNumber}">\n${results.map(result => result.error
        ? `<ModuleTest id="${result.id}" status="error">${result.error}</ModuleTest>`
        : `<ModuleTest id="${result.id}">\n${result.testing}\n</ModuleTest>`).join('\n\n')}\n</ModuleTests>`;
}

async function restoreUnsavedStrategyIfNeeded(
    state: AdaptiveDeepthinkState,
    strategy: AdaptiveStrategy,
    context: AdaptiveDeepthinkToolExecutionContext
): Promise<void> {
    const checkpoint = strategy.preCorrectionSnapshot;
    if (!context.sandboxEnabled || strategy.saved || !checkpoint || checkpoint.passNumber >= state.passNumber) return;
    await restoreSandboxRepositoryStrategy(state.id, strategyDirectory(strategy), checkpoint.commit);
    strategy.preCorrectionSnapshot = undefined;
    addAdaptiveLiveEvent(context, 'Orchestrator', `Restored ${strategy.id} to its pre-correction snapshot for pass ${state.passNumber}`, 'info');
}

async function executeOneStrategy(
    state: AdaptiveDeepthinkState,
    request: AdaptiveExecutionRequest,
    globalSpecialContext: string,
    context: AdaptiveDeepthinkToolExecutionContext,
    prompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }>
): Promise<{ strategyId: string; error?: string; record?: AdaptiveExecutionRecord }> {
    const strategy = state.strategies.get(request.strategyId);
    if (!strategy) return { strategyId: request.strategyId, error: 'Strategy not found.' };
    if (strategy.saved) return { strategyId: request.strategyId, error: 'Saved strategies are permanent and cannot be executed again.' };
    const selectedModuleIds = request.moduleIds.filter(id => state.moduleTestings.has(id));
    await restoreUnsavedStrategyIfNeeded(state, strategy, context);

    const executionGroupId = `group-${nanoid(8)}`;
    const executionGroupName = `Strategy ${strategy.id} Execution Loop`;

    const strategyMap = new Map([[strategy.id, { text: strategy.text }]]);
    const testMap = new Map(selectedModuleIds.map(id => {
        const testing = state.moduleTestings.get(id)!;
        return [id, { module: testing.moduleText, testing: testing.testing }] as const;
    }));
    const execution = await executeWithRetry(
        () => executeStrategiesAgent(
            state.question + getDirectTextContext(),
            [{ strategyId: strategy.id, moduleIds: selectedModuleIds }],
            strategyMap,
            testMap,
            [
                previousExecutionCritiqueForStrategy(state, strategy.id),
                globalSpecialContext,
                request.specialContext || '',
            ].filter(Boolean).join('\n\n'),
            prompts.sys_deepthink_solutionAttempt,
            syncAgentContext(state, context, 'execution', prompts.sys_deepthink_solutionAttempt, strategy, undefined, selectedModuleIds, executionGroupId, executionGroupName),
            images,
        ),
        context,
        'execution'
    );
    const executionError = firstError(execution);
    const executionResult = execution.data?.results?.[0];
    if (executionError || !executionResult?.success || !executionResult.execution?.trim()) {
        const fatalErr = new Error(executionError || executionResult?.error || `Execution for ${strategy.id} failed or returned empty content.`) as Error & { isTerminalInferenceError?: boolean };
        fatalErr.isTerminalInferenceError = true;
        throw fatalErr;
    }
    recordArtifact(state, artifactOutputPath(state, strategy.id, 'execution'), executionResult.execution);

    const executionId = `P${state.passNumber}-${strategy.id}`;
    const executionMap = new Map([[executionId, { strategy: strategy.text, execution: executionResult.execution }]]);
    const critique = await executeWithRetry(
        () => solutionCritiqueAgent(
            state.question + getDirectTextContext(),
            [executionId],
            executionMap,
            '',
            prompts.sys_deepthink_solutionCritique,
            // The critique receives no module packet or branch special context.
            syncAgentContext(state, context, 'critique', prompts.sys_deepthink_solutionCritique, strategy, undefined, [], executionGroupId, executionGroupName),
            images,
        ),
        context,
        'critique'
    );
    const critiqueError = firstError(critique);
    const critiqueResult = critique.data?.results?.[0];
    if (critiqueError || !critiqueResult?.success || !critiqueResult.critique?.trim()) {
        const fatalErr = new Error(critiqueError || critiqueResult?.error || `Critique for ${strategy.id} failed or returned empty content.`) as Error & { isTerminalInferenceError?: boolean };
        fatalErr.isTerminalInferenceError = true;
        throw fatalErr;
    }
    recordArtifact(state, artifactOutputPath(state, strategy.id, 'critique'), critiqueResult.critique);

    if (context.sandboxEnabled) {
        const commit = await snapshotSandboxRepositoryById(state.id, `Adaptive pass ${state.passNumber} ${strategy.id} before correction`);
        if (commit) strategy.preCorrectionSnapshot = { commit, passNumber: state.passNumber };
    }
    const moduleEntries = selectedModuleIds
        .map((id, idx) => {
            const testing = state.moduleTestings.get(id);
            return testing
                ? `<Module ${idx + 1}>\nModule: ${testing.moduleText}\nModules Testing: ${testing.testing}\n</Module ${idx + 1}>\n`
                : '';
        })
        .filter(Boolean)
        .join('\n');
    const modulePacket = moduleEntries ? `<Full Information Packet>\n${moduleEntries}</Full Information Packet>` : undefined;

    const correction = await executeWithRetry(
        () => correctedSolutionsAgent(
            state.question + getDirectTextContext(),
            [executionId],
            executionMap,
            new Map([[executionId, { critique: critiqueResult.critique, modulePacket }]]),
            prompts.sys_deepthink_solutionCorrection,
            syncAgentContext(state, context, 'correction', prompts.sys_deepthink_solutionCorrection, strategy, undefined, selectedModuleIds, executionGroupId, executionGroupName),
            images,
        ),
        context,
        'correction'
    );
    const correctionError = firstError(correction);
    const correctionResult = correction.data?.results?.[0];
    if (correctionError || !correctionResult?.success || !correctionResult.correctedSolution?.trim()) {
        const fatalErr = new Error(correctionError || correctionResult?.error || `Correction for ${strategy.id} failed or returned empty content.`) as Error & { isTerminalInferenceError?: boolean };
        fatalErr.isTerminalInferenceError = true;
        throw fatalErr;
    }
    recordArtifact(state, artifactOutputPath(state, strategy.id, 'correction'), correctionResult.correctedSolution);

    const record: AdaptiveExecutionRecord = {
        id: executionId,
        passNumber: state.passNumber,
        strategyId: strategy.id,
        strategy: strategy.text,
        moduleIds: selectedModuleIds,
        execution: executionResult.execution,
        critique: critiqueResult.critique,
        correction: correctionResult.correctedSolution,
    };
    state.executions.set(executionId, record);
    return { strategyId: strategy.id, record };
}

async function executeStrategies(
    state: AdaptiveDeepthinkState,
    requests: AdaptiveExecutionRequest[],
    specialContext: string,
    context: AdaptiveDeepthinkToolExecutionContext,
    prompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }>
): Promise<string> {
    const unique = Array.from(new Map(requests.slice(0, MAX_BATCH_SIZE).map(request => [request.strategyId, request])).values());
    const results = await Promise.all(unique.map(request => executeOneStrategy(state, request, specialContext, context, prompts, images)));
    return `<StrategyPass pass="${state.passNumber}">\n${results.map(result => result.error
        ? `<StrategyResult id="${result.strategyId}" status="error">${result.error}</StrategyResult>`
        : `<StrategyResult id="${result.strategyId}">\n<Execution>\n${result.record!.execution}\n</Execution>\n<Critique>\n${result.record!.critique}\n</Critique>\n<Correction>\n${result.record!.correction}\n</Correction>\n</StrategyResult>`).join('\n\n')}\n</StrategyPass>`;
}

async function persistResults(
    state: AdaptiveDeepthinkState,
    context: AdaptiveDeepthinkToolExecutionContext,
    message: string
): Promise<void> {
    if (!context.sandboxEnabled) return;
    await ensureDeepthinkResultsRepository(state.id);
    await snapshotDeepthinkResultsRepository(
        state.id,
        message,
        Array.from(state.artifacts.values()).map(artifact => ({ path: artifact.path, content: artifact.content })),
    );
}

function finalizePass(state: AdaptiveDeepthinkState): string {
    const pass = state.passes.get(state.passNumber) || { passNumber: state.passNumber, finalized: false, compactedFiles: [] };
    const files = Array.from(state.artifacts.keys()).filter(path => path.startsWith(`Pass-${String(state.passNumber).padStart(2, '0')}-`));
    pass.finalized = true;
    pass.compactedFiles = files;
    pass.completedAt = Date.now();
    state.passes.set(state.passNumber, pass);
    state.compactedContextLinks = files;
    state.passNumber += 1;
    state.passes.set(state.passNumber, { passNumber: state.passNumber, finalized: false, compactedFiles: [] });
    return files.length
        ? `Pass ${pass.passNumber} finalized. Its full outputs were compacted into repository files: ${files.map(path => `[${path}]`).join(', ')}.`
        : `Pass ${pass.passNumber} finalized with no agent artifacts.`;
}

function readFiles(state: AdaptiveDeepthinkState, paths: string[]): string {
    return paths.map(path => {
        const artifact = state.artifacts.get(path);
        return artifact
            ? `<File path="${path}">\n${artifact.content}\n</File>`
            : `<File path="${path}" status="error">File not found in Adaptive Deepthink context.</File>`;
    }).join('\n\n');
}

export async function executeAdaptiveDeepthinkTool(
    toolCall: AdaptiveDeepthinkToolCall,
    state: AdaptiveDeepthinkState,
    context: AdaptiveDeepthinkToolExecutionContext,
    deepthinkPrompts: AdaptiveDeepthinkToolPrompts,
    images: Array<{ base64: string; mimeType: string }> = [],
): Promise<string> {
    try {
        let output: string;
        switch (toolCall.type) {
            case 'generate_strategies':
                output = await generateStrategyBatch(state, toolCall, context, deepthinkPrompts, images);
                break;
            case 'generate_modules':
                output = await generateModulesBatch(state, toolCall, context, deepthinkPrompts, images);
                break;
            case 'test_modules':
                output = await testModules(state, toolCall.moduleIds, context, deepthinkPrompts, images);
                break;
            case 'execute':
                output = await executeStrategies(state, toolCall.executions, toolCall.specialContext || '', context, deepthinkPrompts, images);
                break;
            case 'save': {
                const saved: string[] = [];
                for (const id of toolCall.strategyIds) {
                    const strategy = state.strategies.get(id);
                    if (!strategy) continue;
                    strategy.saved = true;
                    saved.push(id);
                }
                output = saved.length
                    ? `<SavedStrategies>${saved.map(id => `<Strategy id="${id}" />`).join('')}</SavedStrategies>`
                    : '[ERROR: No supplied strategy IDs were available to save.]';
                break;
            }
            case 'finalize_pass_and_execute': {
                const finalized = finalizePass(state);
                await persistResults(state, context, `Adaptive Deepthink pass ${state.passNumber - 1} finalized`);
                output = `${finalized}\n\n${await executeStrategies(state, toolCall.executions, toolCall.specialContext || '', context, deepthinkPrompts, images)}`;
                break;
            }
            case 'read_files':
                output = readFiles(state, toolCall.paths);
                break;
            case 'virtual_environment': {
                if (!context.sandboxEnabled) {
                    output = '[ERROR: Virtual Environment is disabled. Enable Sandbox Terminal Environment in the Deepthink configuration.]';
                    break;
                }
                const result = await runVirtualEnvironmentCommand({
                    sessionId: `adaptive-${safeSegment(state.id)}-orchestrator`,
                    command: toolCall.command,
                    timeoutMs: toolCall.timeoutMs,
                    seedFiles: [...seedFiles(), ...globalState.filesystemContextFiles],
                    repositoryAccess: { repositoryId: state.id, fullRepositoryRead: true, fullRepositoryWrite: true },
                });
                output = `<VirtualEnvironment exitCode="${result.exitCode}" durationMs="${result.durationMs}">\n${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}${result.error ? `\nERROR:\n${result.error}` : ''}\n</VirtualEnvironment>`;
                break;
            }
            case 'submit_final_output': {
                const sessionId = `adaptive-${safeSegment(state.id)}-orchestrator`;
                state.selectedSolution = expandInlineReferenceMarkers(
                    toolCall.response,
                    sessionId,
                    { repositoryId: state.id, fullRepositoryRead: true, fullRepositoryWrite: true }
                );
                state.status = 'completed';
                output = '<FinalOutputSubmitted />';
                break;
            }
        }
        await persistResults(state, context, `Adaptive Deepthink pass ${state.passNumber} update`);
        syncAdaptiveDeepthinkPipeline(state, context.pipeline);
        return output;
    } catch (error) {
        throw error;
    }
}

export function createAdaptiveDeepthinkState(question: string): AdaptiveDeepthinkState {
    return {
        id: `adaptive-deepthink-${Date.now()}`,
        question,
        status: 'idle',
        passNumber: 1,
        strategies: new Map(),
        modules: new Map(),
        moduleTestings: new Map(),
        executions: new Map(),
        passes: new Map([[1, { passNumber: 1, finalized: false, compactedFiles: [] }]]),
        artifacts: new Map(),
        strategyGenerationHistory: [],
        modulesGenerationHistory: [],
        compactedContextLinks: [],
    };
}

/** Project adaptive state into the existing Deepthink tabs and modals. */
export function syncAdaptiveDeepthinkPipeline(state: AdaptiveDeepthinkState, pipeline: DeepthinkPipelineState): void {
    pipeline.strategyGenerationHistory = normalizeProximityHistory(state.strategyGenerationHistory);
    pipeline.modulesGenerationHistory = normalizeProximityHistory(state.modulesGenerationHistory);
    const strategies = Array.from(state.strategies.values()).sort((left, right) => left.slotIndex - right.slotIndex);
    pipeline.initialStrategies = strategies.map(strategy => {
        const latest = Array.from(state.executions.values())
            .filter(record => record.strategyId === strategy.id)
            .sort((left, right) => right.passNumber - left.passNumber)[0];
        return {
            id: strategy.id,
            strategyText: `${strategy.text}${strategy.saved ? '\n\n> Permanently saved.' : ''}`,
            status: latest || strategy.saved ? 'completed' : 'pending',
            solutionAttempt: latest?.execution,
            solutionAttemptDisplay: latest?.execution,
            refinedSolution: latest?.correction,
            refinedSolutionDisplay: latest?.correction,
            correctionStatus: latest?.correction ? 'completed' : latest ? 'skipped' : undefined,
            solutionCritique: latest?.critique,
            solutionCritiqueDisplay: latest?.critique,
            branchVersion: 1,
            branchIterationCount: Math.max(0, ...Array.from(state.executions.values()).filter(record => record.strategyId === strategy.id).map(record => record.passNumber)),
        } as DeepthinkMainStrategyData;
    });
    pipeline.modules = Array.from(state.modules.values()).map(moduleItem => {
        const testing = state.moduleTestings.get(moduleItem.id);
        return {
            id: moduleItem.id,
            moduleText: moduleItem.text,
            testerAttempt: testing?.testing,
            testerAttemptDisplay: testing?.testing,
            testerStatus: testing ? 'completed' : 'pending',
            roundNumber: moduleItem.passNumber,
            globalIteration: moduleItem.passNumber,
        } as DeepthinkModuleData;
    });
    pipeline.solutionCritiques = Array.from(state.executions.values()).map(record => ({
        id: `critique-${record.id}`,
        mainStrategyId: record.strategyId,
        critiqueResponse: record.critique,
        critiqueResponseDisplay: record.critique,
        status: 'completed',
    } as DeepthinkSolutionCritiqueData));
    pipeline.modulesGenStatus = pipeline.modules.length ? 'completed' : 'pending';
    pipeline.modulesExplorerComplete = pipeline.modules.length > 0 && pipeline.modules.every(m => m.testerStatus === 'completed');
    pipeline.knowledgePacket = Array.from(state.moduleTestings.entries()).map(([id, testing]) => `<Module id="${id}">\n${testing.moduleText}\n\n${testing.testing}\n</Module>`).join('\n\n');
    pipeline.solutionCritiquesStatus = pipeline.solutionCritiques.length ? 'completed' : 'pending';
    if (state.selectedSolution) {
        pipeline.finalJudgedBestSolution = state.selectedSolution;
        pipeline.finalJudgingResponseText = state.selectedSolution;
        pipeline.finalJudgingStatus = 'completed';
        pipeline.status = 'completed';
    }
}
