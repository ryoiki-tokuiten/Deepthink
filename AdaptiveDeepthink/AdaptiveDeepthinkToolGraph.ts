/** LangGraph shell for the Adaptive Deepthink orchestrator. */

import type { ToolDefinition } from '@langchain/core/language_models/base';
import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph, messagesStateReducer } from '@langchain/langgraph/web';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
    invokeToolCallingAgentTurn,
    resolveProviderForModel,
} from '../Core/LangGraphToolRuntime';
import {
    createAdaptiveDeepthinkState,
    executeAdaptiveDeepthinkTool,
    type AdaptiveDeepthinkState,
    type AdaptiveDeepthinkToolCall,
    type AdaptiveDeepthinkToolExecutionContext,
    type AdaptiveDeepthinkToolPrompts,
} from './AdaptiveDeepthinkCore';
import {
    isTerminalInferenceError,
    isUserAbortError,
} from '../Core/ProviderError';

const boundedCount = z.number().int().min(1).max(5);
const optionalProximityLoops = z.number().int().min(1).max(5).optional();
const optionalImpactReviewLoops = z.number().int().min(1).max(5).optional();
const optionalContext = z.string().trim().min(1).max(8_000).optional();
const strategyIds = z.array(z.string().trim().regex(/^S[1-5]$/)).min(1).max(5);
const moduleIds = z.array(z.string().trim().regex(/^M[1-5]$/)).min(1).max(5);

const executionRequestSchema = z.object({
    strategyId: z.string().trim().regex(/^S[1-5]$/),
    moduleIds: z.array(z.string().trim().regex(/^M[1-5]$/)).max(5),
    specialContext: optionalContext,
});

const generateStrategiesSchema = z.object({
    count: boundedCount,
    proximityLoops: optionalProximityLoops,
    specialContext: optionalContext,
    replaceStrategyIds: z.array(z.string().trim().regex(/^S[1-5]$/)).max(5).optional(),
});
const generateModulesSchema = z.object({ count: boundedCount, impactReviewLoops: optionalImpactReviewLoops, specialContext: optionalContext });
const testModulesSchema = z.object({ moduleIds });
const executeSchema = z.object({ executions: z.array(executionRequestSchema).min(1).max(5), specialContext: optionalContext });
const saveSchema = z.object({ strategyIds });
const readFilesSchema = z.object({ paths: z.array(z.string().trim().min(1).max(160)).min(1).max(12) });
const virtualEnvironmentSchema = z.object({ command: z.string().trim().min(1).max(12_000), timeoutMs: z.number().int().min(1_000).max(300_000).optional() });
const submitFinalOutputSchema = z.object({ response: z.string().trim().min(1).max(80_000) });

function definition(name: string, description: string, parameters: ToolDefinition['function']['parameters']): ToolDefinition {
    return { type: 'function', function: { name, description, parameters } };
}

const tools: ToolDefinition[] = [
    definition('generate_strategies', 'Generate or update up to five divergent strategies. The proximityLoops argument steers how diverse the strategies should be by controlling the shared generator/proximity revision loop; it defaults to 2 and may be set from 1 to 5. The loop always ends on a generator result. Saved IDs cannot be replaced.', {
        type: 'object', properties: {
            count: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of unsaved strategy candidates to produce.' },
            proximityLoops: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'How diverse the generated strategies should be. Higher values request more proximity revision rounds; defaults to 2.' },
            specialContext: { type: 'string', description: 'Failure analysis or desired orthogonal search direction.' },
            replaceStrategyIds: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Only these unsaved slots are replaced. Omit for a fresh unsaved batch.' },
        }, required: ['count'], additionalProperties: false,
    }),
    definition('generate_modules', 'Generate critique-driven modules through the shared Modules Generator / Modules Impact Reviewer revision loop. The impactReviewLoops argument steers how diverse and high-impact the modules should be; it defaults to 2 and may be set from 1 to 5. The loop always ends on a generator result. This replaces every prior module and test packet.', {
        type: 'object', properties: {
            count: { type: 'integer', minimum: 1, maximum: 5 },
            impactReviewLoops: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'How diverse and high-impact the generated modules should be. Higher values request more impact review rounds; defaults to 2.' },
            specialContext: { type: 'string', description: 'What the latest execution/critique evidence still fails to explain.' },
        }, required: ['count'], additionalProperties: false,
    }),
    definition('test_modules', 'Independently test the supplied current modules. Test agents see only the individual module and core challenge.', {
        type: 'object', properties: { moduleIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } }, required: ['moduleIds'], additionalProperties: false,
    }),
    definition('execute', 'Run each selected strategy in parallel through Execution -> Critique -> Correction. Each branch may receive a different specialContext; critiques deliberately do not receive module context.', {
        type: 'object', properties: {
            executions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: { strategyId: { type: 'string' }, moduleIds: { type: 'array', items: { type: 'string' }, maxItems: 5 }, specialContext: { type: 'string' } }, required: ['strategyId', 'moduleIds'], additionalProperties: false } },
            specialContext: { type: 'string', description: 'Shared execution-only guidance for this call.' },
        }, required: ['executions'], additionalProperties: false,
    }),
    definition('save', 'Permanently save strategy IDs whose correction properly addressed the critique. Saved slots are immutable, reserved, and never run again.', {
        type: 'object', properties: { strategyIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } }, required: ['strategyIds'], additionalProperties: false,
    }),
    definition('finalize_pass_and_execute', 'Finalize the current pass, compact its full outputs into file links, advance to a fresh pass, and immediately run execute with the same parameters.', {
        type: 'object', properties: {
            executions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: { strategyId: { type: 'string' }, moduleIds: { type: 'array', items: { type: 'string' }, maxItems: 5 }, specialContext: { type: 'string' } }, required: ['strategyId', 'moduleIds'], additionalProperties: false } },
            specialContext: { type: 'string' },
        }, required: ['executions'], additionalProperties: false,
    }),
    definition('read_files', 'Read full adaptive pass output files after compaction. Use this selectively when a linked result is materially relevant.', {
        type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } }, required: ['paths'], additionalProperties: false,
    }),
    definition('virtual_environment', 'Run one bash command in the same repository-backed virtual environment used by Deepthink. The orchestrator has root read/write access for this explicit command.', {
        type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 } }, required: ['command'], additionalProperties: false,
    }),
    definition('submit_final_output', 'Submit the final answer yourself once you have judged the saved/available corrections. There is no final judge agent.', {
        type: 'object', properties: { response: { type: 'string' } }, required: ['response'], additionalProperties: false,
    }),
];

const AdaptiveDeepthinkGraphAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
    coreState: Annotation<AdaptiveDeepthinkState>({ reducer: (_, value) => value, default: () => createAdaptiveDeepthinkState('') }),
    shouldExit: Annotation<boolean>({ reducer: (_, value) => value, default: () => false }),
});

export type AdaptiveDeepthinkGraphState = typeof AdaptiveDeepthinkGraphAnnotation.State;

export interface AdaptiveDeepthinkToolResultArtifact {
    tool: string;
    toolCall?: AdaptiveDeepthinkToolCall;
}

interface AdaptiveDeepthinkGraphOptions {
    modelName: string;
    systemPrompt: string;
    deepthinkPrompts: AdaptiveDeepthinkToolPrompts;
    createExecutionContext: (toolCall: AdaptiveDeepthinkToolCall) => AdaptiveDeepthinkToolExecutionContext;
    images?: Array<{ base64: string; mimeType: string }>;
    abortSignal?: AbortSignal;
}

interface ToolExecutionResult {
    content: string;
    status: 'success' | 'error';
    artifact: AdaptiveDeepthinkToolResultArtifact;
    statePatch?: Partial<Omit<AdaptiveDeepthinkGraphState, 'messages'>>;
}

function artifact(tool: string, toolCall?: AdaptiveDeepthinkToolCall): AdaptiveDeepthinkToolResultArtifact {
    return toolCall ? { tool, toolCall } : { tool };
}

export function normalizeAdaptiveDeepthinkToolCall(name: string, args: unknown): AdaptiveDeepthinkToolCall | null {
    switch (name) {
        case 'generate_strategies': { const parsed = generateStrategiesSchema.safeParse(args ?? {}); return parsed.success ? { type: 'generate_strategies', ...parsed.data } : null; }
        case 'generate_modules': { const parsed = generateModulesSchema.safeParse(args ?? {}); return parsed.success ? { type: 'generate_modules', ...parsed.data } : null; }
        case 'test_modules': { const parsed = testModulesSchema.safeParse(args ?? {}); return parsed.success ? { type: 'test_modules', ...parsed.data } : null; }
        case 'execute': { const parsed = executeSchema.safeParse(args ?? {}); return parsed.success ? { type: 'execute', ...parsed.data } : null; }
        case 'save': { const parsed = saveSchema.safeParse(args ?? {}); return parsed.success ? { type: 'save', ...parsed.data } : null; }
        case 'finalize_pass_and_execute': { const parsed = executeSchema.safeParse(args ?? {}); return parsed.success ? { type: 'finalize_pass_and_execute', ...parsed.data } : null; }
        case 'read_files': { const parsed = readFilesSchema.safeParse(args ?? {}); return parsed.success ? { type: 'read_files', ...parsed.data } : null; }
        case 'virtual_environment': { const parsed = virtualEnvironmentSchema.safeParse(args ?? {}); return parsed.success ? { type: 'virtual_environment', ...parsed.data } : null; }
        case 'submit_final_output': { const parsed = submitFinalOutputSchema.safeParse(args ?? {}); return parsed.success ? { type: 'submit_final_output', ...parsed.data } : null; }
        default: return null;
    }
}

function compactedContext(state: AdaptiveDeepthinkState): string {
    return state.compactedContextLinks.length
        ? `Completed pass outputs have been compacted. Read only needed files with read_files: ${state.compactedContextLinks.map(path => `[${path}]`).join(', ')}`
        : 'No pass has been compacted yet.';
}

function buildAdaptiveDeepthinkSystemPrompt(state: AdaptiveDeepthinkGraphState, systemPrompt: string): string {
    const strategies = Array.from(state.coreState.strategies.values()).map(strategy => `${strategy.id}${strategy.saved ? ' (saved)' : ''}`).join(', ') || 'none';
    const modules = Array.from(state.coreState.modules.keys()).join(', ') || 'none';
    return [
        systemPrompt,
        '',
        '<Runtime State>',
        `Current pass: ${state.coreState.passNumber}.`,
        `Strategies: ${strategies}.`,
        `Current modules: ${modules}.`,
        compactedContext(state.coreState),
        '</Runtime State>',
        '',
        'Use exactly one orchestration tool call per turn. Keep visible narration short and decision-oriented. Tool IDs are authoritative. Do not invent tool syntax, file content, or tool results.',
    ].join('\n');
}

function messagesForOrchestrator(state: AdaptiveDeepthinkGraphState): BaseMessage[] {
    const boundary = state.coreState.compactionBoundary;
    if (!boundary || state.messages.length <= boundary) return state.messages;
    // Keep the original challenge, discard the heavy prior pass conversations,
    // and retain only post-finalization reasoning/tool traffic.
    return [state.messages[0], ...state.messages.slice(boundary)].filter(Boolean) as BaseMessage[];
}

async function executeToolCall(
    state: AdaptiveDeepthinkGraphState,
    name: string,
    rawArgs: unknown,
    options: AdaptiveDeepthinkGraphOptions,
): Promise<ToolExecutionResult> {
    const toolCall = normalizeAdaptiveDeepthinkToolCall(name, rawArgs);
    if (!toolCall) return { content: `[TOOL_ERROR: Invalid arguments for ${name}]`, status: 'error', artifact: artifact(name) };
    const content = await executeAdaptiveDeepthinkTool(toolCall, state.coreState, options.createExecutionContext(toolCall), options.deepthinkPrompts, options.images ?? []);
    return {
        content,
        status: content.includes('[ERROR:') ? 'error' : 'success',
        artifact: artifact(name, toolCall),
        statePatch: {
            coreState: state.coreState,
            ...(toolCall.type === 'submit_final_output' ? { shouldExit: true } : {}),
        },
    };
}

function getLastAiMessage(state: AdaptiveDeepthinkGraphState): AIMessage | null {
    const last = state.messages[state.messages.length - 1];
    return last instanceof AIMessage ? last : null;
}

async function executeToolsNode(state: AdaptiveDeepthinkGraphState, options: AdaptiveDeepthinkGraphOptions): Promise<Partial<AdaptiveDeepthinkGraphState>> {
    const lastMessage = getLastAiMessage(state);
    if (!lastMessage?.tool_calls?.length) return {};
    let workingState = { ...state };
    const toolMessages: ToolMessage[] = [];

    for (const invocation of lastMessage.tool_calls) {
        let result: ToolExecutionResult;
        try {
            result = await executeToolCall(workingState, invocation.name, invocation.args, options);
        } catch (error) {
            if (isTerminalInferenceError(error) || isUserAbortError(error) || options.abortSignal?.aborted) {
                throw error;
            }
            result = { content: `[TOOL_ERROR: ${error instanceof Error ? error.message : 'Unknown tool error'}]`, status: 'error', artifact: artifact(invocation.name) };
        }
        workingState = { ...workingState, ...result.statePatch };
        toolMessages.push(new ToolMessage({
            name: invocation.name,
            content: result.content,
            tool_call_id: invocation.id ?? nanoid(8),
            status: result.status,
            artifact: result.artifact,
        }));
        if (result.artifact.toolCall?.type === 'finalize_pass_and_execute') {
            // The next agent turn receives the compact link summary from the
            // system prompt rather than all prior full execution blocks.
            // Keep this call's AI invocation and fresh execution result, but
            // remove every older pass conversation on the next orchestrator
            // turn. Tool messages remain paired with their AI tool call.
            workingState.coreState.compactionBoundary = Math.max(1, state.messages.length - 1);
        }
    }
    return { messages: toolMessages, coreState: workingState.coreState, shouldExit: workingState.shouldExit };
}

function shouldRunTools(state: AdaptiveDeepthinkGraphState) {
    return getLastAiMessage(state)?.tool_calls?.length ? 'tools' : END;
}

export function createAdaptiveDeepthinkGraph(options: AdaptiveDeepthinkGraphOptions) {
    const provider = resolveProviderForModel(options.modelName);
    const { providerName, providerConfig, modelName } = provider;
    if (!providerConfig?.isConfigured || (providerName === 'openai-compatible' ? !providerConfig.baseURL : !providerConfig.apiKey)) {
        throw new Error(`No configured provider found for model: ${options.modelName}`);
    }
    const agentNode = async (state: AdaptiveDeepthinkGraphState) => {
        const systemPrompt = buildAdaptiveDeepthinkSystemPrompt(state, options.systemPrompt);
        const messages = messagesForOrchestrator(state);
        const response = await invokeToolCallingAgentTurn(
            provider,
            messages,
            systemPrompt,
            tools,
            {
                modelName,
                abortSignal: options.abortSignal,
                label: `Adaptive Deepthink Orchestrator (${providerName}:${modelName})`,
            }
        );
        return { messages: [response] };
    };
    const afterTools = (state: AdaptiveDeepthinkGraphState) => state.shouldExit ? END : 'agent';
    return new StateGraph(AdaptiveDeepthinkGraphAnnotation)
        .addNode('agent', agentNode)
        .addNode('tools', (state: AdaptiveDeepthinkGraphState) => executeToolsNode(state, options))
        .addEdge(START, 'agent')
        .addConditionalEdges('agent', shouldRunTools)
        .addConditionalEdges('tools', afterTools)
        .compile();
}
