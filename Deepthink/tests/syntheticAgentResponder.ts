import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
    deepthinkAgentMaxOutputTokens,
    type DeepthinkAgentKind,
} from '../core/agentRegistry.ts';
import type { PipelineExecutionCallbacks } from '../core/pipelineOrchestrator.ts';
import type { DeepthinkRunConfig } from '../core/types.ts';
import { countTextTokens, type SharedWorkspaceToolInput } from '../core/sharedWorkspace.ts';
import { SeededPRNG, type ForcedSlotBehavior } from './prngAndTokenCalibrator.ts';

export interface AgentInvocationRecord {
    seq: number;
    label: string;
    stepDescription: string;
    agentKind: DeepthinkAgentKind;
    mode: 'direct' | 'sandbox';
    iteration?: number;
    heartbeatNo?: number;
    updateNo?: number;
    turn?: number;
    branchId?: string;
    moduleId?: string;
    startTimeMs: number;
    endTimeMs: number;
    promptText: string;
    responseText: string;
    outputTokens: number;
    maxAllowedOutputTokens: number;
    initialMessagesCount?: number;
}

export interface PromptMemoryAuditRecord {
    label: string;
    iteration: number;
    branchId?: string;
    promptTokens: number;
    preUpdateIterationsCount: number;
    windowIterationsCount: number;
    distilledMemoryBankCount: number;
    curatedContextCount: number;
    hasCrossStrategyPeerIntel: boolean;
}

export interface FaultInjectionRule {
    labelPattern: RegExp | string;
    failAttempts: number;
    failureType: 'transient_error' | 'malformed_json' | 'contract_violation' | 'stop_request';
    onTrigger?: () => void;
}

function extractTextFromMessageContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
                    return (part as any).text;
                }
                return '';
            })
            .join('');
    }
    return '';
}

export class SyntheticAgentResponder {
    private readonly masterPrng: SeededPRNG;
    private readonly config: DeepthinkRunConfig;
    private readonly forcedSlotBehaviors: Record<string, ForcedSlotBehavior[]>;
    private readonly enableAsyncJitter: boolean;
    private readonly maxJitterMs: number;
    private readonly faultRules: FaultInjectionRule[];

    public readonly invocations: AgentInvocationRecord[] = [];
    public readonly memoryAudits: PromptMemoryAuditRecord[] = [];
    public readonly invariantViolations: string[] = [];
    private readonly attemptCountsByLabel = new Map<string, number>();
    private seqCounter = 0;
    private globalUpdateSurgicalRuns: number[] = [];

    private sandboxContextState = {
        seedSgTurn: 0,
        seedSpTurn: 0,
        guUpdateNo: 0,
        guSgTurn: 0,
        guSpTurn: 0,
        currentHeartbeatNo: 0,
        hbModGenTurn: 0,
        hbModRevTurn: 0,
        branchAttemptSeen: new Set<string>(),
        branchLatestIteration: new Map<string, number>(),
        bsrUpdateCountByBranch: new Map<string, number>(),
        memBankUpdateCountByBranch: new Map<string, number>(),
    };

    constructor(options: {
        seed: number;
        config: DeepthinkRunConfig;
        forcedSlotBehaviors?: Record<string, ForcedSlotBehavior[]>;
        enableAsyncJitter?: boolean;
        maxJitterMs?: number;
        faultRules?: FaultInjectionRule[];
    }) {
        this.masterPrng = new SeededPRNG(options.seed);
        this.config = options.config;
        this.forcedSlotBehaviors = options.forcedSlotBehaviors ?? {};
        this.enableAsyncJitter = options.enableAsyncJitter ?? true;
        this.maxJitterMs = options.maxJitterMs ?? 6;
        this.faultRules = options.faultRules ?? [];
    }

    public createCallbacks(extra?: {
        onStopCheck?: () => void;
        customRunSandboxToolAgent?: PipelineExecutionCallbacks['runSandboxToolAgent'];
    }): PipelineExecutionCallbacks {
        return {
            retryDelaysMs: [1, 2, 3],
            silenceTimeoutMs: 5000,
            callAI: async (callArgs) => {
                extra?.onStopCheck?.();
                const stepDesc = callArgs.stepDescription || 'unknown';
                const parsed = this.parseStepDescription(stepDesc, callArgs.agentKind, callArgs.prompt);
                const text = await this.handleInvocation({
                    parsed,
                    stepDescription: stepDesc,
                    mode: 'direct',
                    promptText: callArgs.prompt,
                    systemPrompt: callArgs.systemInstruction || '',
                });
                return text;
            },
            runSandboxToolAgent: extra?.customRunSandboxToolAgent ?? (async (opts: any) => {
                extra?.onStopCheck?.();
                const messages: BaseMessage[] = Array.isArray(opts.messages) ? opts.messages : [];
                const firstHumanText = messages.length > 0 ? extractTextFromMessageContent(messages[0].content) : '';
                const latestMsgText = messages.length > 0 ? extractTextFromMessageContent(messages[messages.length - 1].content) : '';
                const combinedPromptText = messages.length > 1 ? `${firstHumanText}\n${latestMsgText}` : firstHumanText;

                const parsed = this.inferSandboxInvocationMeta(
                    opts.agentName as DeepthinkAgentKind,
                    combinedPromptText,
                    messages,
                    opts.repositoryAccess?.agentDirectory
                );

                const text = await this.handleInvocation({
                    parsed,
                    stepDescription: parsed.label,
                    mode: 'sandbox',
                    promptText: combinedPromptText,
                    systemPrompt: opts.systemPrompt || '',
                    initialMessages: messages,
                    maxOutputTokens: opts.maxOutputTokens,
                    sharedWorkspaceHandler: opts.sharedWorkspaceHandler,
                    cwd: opts.repositoryAccess?.agentDirectory,
                });

                const callId = `call_final_${this.seqCounter}`;
                const aiMsg = new AIMessage({
                    content: [
                        {
                            text: '',
                            functionCall: {
                                id: callId,
                                name: 'final_output',
                                args: { response: text },
                            },
                        } as any,
                    ],
                    tool_calls: [
                        {
                            id: callId,
                            name: 'final_output',
                            args: { response: text },
                            type: 'tool_call',
                        },
                    ],
                });

                const outMessages = [...messages, aiMsg];
                const rawTrajectoryJsonl = JSON.stringify({
                    step: 1,
                    role: 'assistant',
                    label: parsed.label,
                    cwd: opts.repositoryAccess?.agentDirectory ?? '.',
                    tool: 'final_output',
                });

                return {
                    text,
                    finalText: text,
                    promptText: combinedPromptText,
                    messages: outMessages,
                    executionTraceText: `[trace:${parsed.label}:cwd=${opts.repositoryAccess?.agentDirectory ?? '.'}]`,
                    rawTrajectoryJsonl,
                };
            }),
        };
    }

    private latestGlobalUpdateNo = 0;

    private parseStepDescription(
        stepDescription: string,
        explicitKind?: DeepthinkAgentKind,
        promptText = ''
    ): {
        label: string;
        agentKind: DeepthinkAgentKind;
        iteration?: number;
        heartbeatNo?: number;
        updateNo?: number;
        turn?: number;
        branchId?: string;
        moduleId?: string;
        isPrunedReplacement?: boolean;
        dosSubKind?: 'heartbeat' | 'step_i' | 'step_ii';
    } {
        let m: RegExpMatchArray | null;

        if ((m = stepDescription.match(/^Seed Strategy Generator \(Turn (\d+)\)$/))) {
            const turn = Number(m[1]);
            return { label: `initialStrategy:turn${turn}`, agentKind: 'initialStrategy', turn };
        }
        if ((m = stepDescription.match(/^Strategy Proximity Review \(Turn (\d+)\)$/))) {
            const turn = Number(m[1]);
            return { label: `strategyProximity:turn${turn}`, agentKind: 'strategyProximity', turn };
        }
        if ((m = stepDescription.match(/^Strategy Generator Update \(Global Update (\d+), Turn (\d+)\)$/))) {
            const updateNo = Number(m[1]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const turn = Number(m[2]);
            const iteration = updateNo * this.config.j;
            return {
                label: `strategyGeneration:update:iter${iteration}:turn${turn}`,
                agentKind: 'initialStrategy',
                updateNo,
                iteration,
                turn,
            };
        }
        if ((m = stepDescription.match(/^Strategy Proximity Review \(Global Update (\d+), Turn (\d+)\)$/))) {
            const updateNo = Number(m[1]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const turn = Number(m[2]);
            const iteration = updateNo * this.config.j;
            return {
                label: `strategyProximity:update:iter${iteration}:turn${turn}`,
                agentKind: 'strategyProximity',
                updateNo,
                iteration,
                turn,
            };
        }
        if ((m = stepDescription.match(/^Solution Attempt for ([^\s]+) \(Iteration (\d+)\)$/))) {
            const branchId = m[1];
            const iteration = Number(m[2]);
            return {
                label: `solutionAttempt:${branchId}:iter${iteration}`,
                agentKind: 'solutionAttempt',
                branchId,
                iteration,
                isPrunedReplacement: false,
            };
        }
        if ((m = stepDescription.match(/^First Execution for New Branch in ([^\s]+)$/))) {
            const branchId = m[1];
            const iteration = Math.max(1, this.latestGlobalUpdateNo) * this.config.j;
            return {
                label: `solutionAttempt:${branchId}:iter${iteration}:pruned`,
                agentKind: 'solutionAttempt',
                branchId,
                iteration,
                isPrunedReplacement: true,
            };
        }
        if ((m = stepDescription.match(/^Solution Correction for ([^\s]+) \(Iteration (\d+)\)$/))) {
            const branchId = m[1];
            const iteration = Number(m[2]);
            return {
                label: `solutionCorrection:${branchId}:iter${iteration}`,
                agentKind: 'solutionCorrection',
                branchId,
                iteration,
            };
        }
        if ((m = stepDescription.match(/^Solution Critique for ([^\s]+) \(Iteration (\d+)\)$/))) {
            const branchId = m[1];
            const iteration = Number(m[2]);
            return {
                label: `solutionCritique:${branchId}:iter${iteration}`,
                agentKind: 'solutionCritique',
                branchId,
                iteration,
                isPrunedReplacement: false,
            };
        }
        if ((m = stepDescription.match(/^First Critique for New Branch in ([^\s]+)$/))) {
            const branchId = m[1];
            const iteration = Math.max(1, this.latestGlobalUpdateNo) * this.config.j;
            return {
                label: `solutionCritique:${branchId}:iter${iteration}:pruned`,
                agentKind: 'solutionCritique',
                branchId,
                iteration,
                isPrunedReplacement: true,
            };
        }
        if ((m = stepDescription.match(/^Heartbeat DOS \(Heartbeat (\d+)\)$/))) {
            const heartbeatNo = Number(m[1]);
            const iterMatches = [...promptText.matchAll(/<Iteration n="(\d+)">/g)];
            const iteration = iterMatches.length > 0 ? Math.max(...iterMatches.map(x => Number(x[1]))) : heartbeatNo * this.config.k;
            return {
                label: `dos:heartbeat:hb${heartbeatNo}:iter${iteration}`,
                agentKind: 'dos',
                heartbeatNo,
                iteration,
                dosSubKind: 'heartbeat',
            };
        }
        if ((m = stepDescription.match(/^Step-i DOS \(Global Update (\d+)\)$/))) {
            const updateNo = Number(m[1]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const iteration = updateNo * this.config.j;
            return {
                label: `dos:step_i:iter${iteration}`,
                agentKind: 'dos',
                updateNo,
                iteration,
                dosSubKind: 'step_i',
            };
        }
        if ((m = stepDescription.match(/^Step-ii DOS \(Global Update (\d+)\)$/))) {
            const updateNo = Number(m[1]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const iteration = updateNo * this.config.j;
            return {
                label: `dos:step_ii:iter${iteration}`,
                agentKind: 'dos',
                updateNo,
                iteration,
                dosSubKind: 'step_ii',
            };
        }
        if ((m = stepDescription.match(/^Modules Generator \(Heartbeat (\d+), Turn (\d+)\)$/))) {
            const heartbeatNo = Number(m[1]);
            const turn = Number(m[2]);
            return {
                label: `modulesGeneration:hb${heartbeatNo}:turn${turn}`,
                agentKind: 'modulesGeneration',
                heartbeatNo,
                turn,
            };
        }
        if ((m = stepDescription.match(/^Modules Impact Reviewer \(Heartbeat H|Heartbeat (\d+), Turn (\d+)\)$/)) ||
            (m = stepDescription.match(/^Modules Impact Reviewer \(Heartbeat (\d+), Turn (\d+)\)$/))) {
            const heartbeatNo = Number(m[1]);
            const turn = Number(m[2]);
            return {
                label: `modulesImpactReview:hb${heartbeatNo}:turn${turn}`,
                agentKind: 'modulesImpactReview',
                heartbeatNo,
                turn,
            };
        }
        if ((m = stepDescription.match(/^Modules Tester for ([^\s]+)$/))) {
            const moduleId = m[1];
            const hbMatch = promptText.match(/Heartbeat\s+(\d+)/i);
            const heartbeatNo = hbMatch ? Number(hbMatch[1]) : 1;
            return {
                label: `modulesTester:hb${heartbeatNo}:${moduleId}`,
                agentKind: 'modulesTester',
                heartbeatNo,
                moduleId,
            };
        }
        if ((m = stepDescription.match(/^BSR for ([^\s]+) \(Global Update (\d+)\)$/))) {
            const branchId = m[1];
            const updateNo = Number(m[2]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const iteration = updateNo * this.config.j;
            return {
                label: `bsr:${branchId}:iter${iteration}`,
                agentKind: 'bsr',
                branchId,
                updateNo,
                iteration,
            };
        }
        if ((m = stepDescription.match(/^Memory Bank Distillation for ([^\s]+) \(Update (\d+)\)$/))) {
            const branchId = m[1];
            const updateNo = Number(m[2]);
            this.latestGlobalUpdateNo = Math.max(this.latestGlobalUpdateNo, updateNo);
            const iteration = updateNo * this.config.j;
            return {
                label: `memoryBank:${branchId}:iter${iteration}`,
                agentKind: 'memoryBank',
                branchId,
                updateNo,
                iteration,
            };
        }

        return {
            label: stepDescription,
            agentKind: explicitKind ?? 'solutionAttempt',
        };
    }

    private inferSandboxInvocationMeta(
        agentKind: DeepthinkAgentKind,
        promptText: string,
        messages: BaseMessage[],
        agentDirectory?: string
    ): ReturnType<SyntheticAgentResponder['parseStepDescription']> {
        const slotIdxMatch = agentDirectory?.match(/^Strategy-(\d+)/);
        const branchId = slotIdxMatch ? `main${slotIdxMatch[1]}` : 'main1';

        const aiTurnCount = messages.filter(m => m instanceof AIMessage).length + 1;

        if (agentKind === 'initialStrategy') {
            if (promptText.includes('<ConsolidatedBsrDecisions>')) {
                if (aiTurnCount === 1) {
                    this.sandboxContextState.guUpdateNo++;
                }
                const updateNo = this.sandboxContextState.guUpdateNo;
                const iteration = updateNo * this.config.j;
                return {
                    label: `strategyGeneration:update:iter${iteration}:turn${aiTurnCount}`,
                    agentKind: 'initialStrategy',
                    updateNo,
                    iteration,
                    turn: aiTurnCount,
                };
            }
            return {
                label: `initialStrategy:turn${aiTurnCount}`,
                agentKind: 'initialStrategy',
                turn: aiTurnCount,
            };
        }

        if (agentKind === 'strategyProximity') {
            if (promptText.includes('<ConsolidatedBsrDecisions>')) {
                const updateNo = Math.max(1, this.sandboxContextState.guUpdateNo);
                const iteration = updateNo * this.config.j;
                return {
                    label: `strategyProximity:update:iter${iteration}:turn${aiTurnCount}`,
                    agentKind: 'strategyProximity',
                    updateNo,
                    iteration,
                    turn: aiTurnCount,
                };
            }
            return {
                label: `strategyProximity:turn${aiTurnCount}`,
                agentKind: 'strategyProximity',
                turn: aiTurnCount,
            };
        }

        if (agentKind === 'solutionAttempt') {
            const alreadySeen = this.sandboxContextState.branchAttemptSeen.has(branchId);
            this.sandboxContextState.branchAttemptSeen.add(branchId);
            if (!alreadySeen) {
                this.sandboxContextState.branchLatestIteration.set(branchId, 1);
                return {
                    label: `solutionAttempt:${branchId}:iter1`,
                    agentKind: 'solutionAttempt',
                    branchId,
                    iteration: 1,
                    isPrunedReplacement: false,
                };
            }
            const iteration = Math.max(1, this.sandboxContextState.guUpdateNo) * this.config.j;
            this.sandboxContextState.branchLatestIteration.set(branchId, iteration);
            return {
                label: `solutionAttempt:${branchId}:iter${iteration}:pruned`,
                agentKind: 'solutionAttempt',
                branchId,
                iteration,
                isPrunedReplacement: true,
            };
        }

        if (agentKind === 'solutionCorrection') {
            const prevIter = this.sandboxContextState.branchLatestIteration.get(branchId) ?? 1;
            const iteration = prevIter + 1;
            this.sandboxContextState.branchLatestIteration.set(branchId, iteration);
            return {
                label: `solutionCorrection:${branchId}:iter${iteration}`,
                agentKind: 'solutionCorrection',
                branchId,
                iteration,
            };
        }

        if (agentKind === 'solutionCritique') {
            const iterMatches = [...promptText.matchAll(/<Iteration n="(\d+)">/g)];
            const fromPromptIter = iterMatches.length > 0 ? Number(iterMatches[iterMatches.length - 1][1]) : undefined;
            const iteration = fromPromptIter ?? this.sandboxContextState.branchLatestIteration.get(branchId) ?? 1;
            this.sandboxContextState.branchLatestIteration.set(branchId, iteration);
            const isPrunedReplacement = promptText.includes(`[REPLACEMENT_ITER_${iteration}_SOLUTION:`);
            return {
                label: isPrunedReplacement
                    ? `solutionCritique:${branchId}:iter${iteration}:pruned`
                    : `solutionCritique:${branchId}:iter${iteration}`,
                agentKind: 'solutionCritique',
                branchId,
                iteration,
                isPrunedReplacement,
            };
        }

        if (agentKind === 'dos') {
            const iterMatches = [...promptText.matchAll(/\[(?:REPLACEMENT_)?ITER(?:ATION)?_(\d+)_(?:SOLUTION|CRITIQUE):/g)];
            const iteration = iterMatches.length > 0 ? Math.max(...iterMatches.map(x => Number(x[1]))) : this.config.j;
            if (promptText.includes('# Dissected Observations Synthesis - Global Update (Step-ii)')) {
                const updateNo = Math.max(1, Math.floor(iteration / this.config.j));
                this.sandboxContextState.currentHeartbeatNo++;
                return {
                    label: `dos:step_ii:iter${iteration}`,
                    agentKind: 'dos',
                    updateNo,
                    iteration,
                    dosSubKind: 'step_ii',
                };
            }
            if (promptText.includes('# Dissected Observations Synthesis - Global Update (Step-i)')) {
                const updateNo = Math.max(1, Math.floor(iteration / this.config.j));
                return {
                    label: `dos:step_i:iter${iteration}`,
                    agentKind: 'dos',
                    updateNo,
                    iteration,
                    dosSubKind: 'step_i',
                };
            }
            this.sandboxContextState.currentHeartbeatNo++;
            return {
                label: `dos:heartbeat:hb${this.sandboxContextState.currentHeartbeatNo}:iter${iteration}`,
                agentKind: 'dos',
                heartbeatNo: this.sandboxContextState.currentHeartbeatNo,
                iteration,
                dosSubKind: 'heartbeat',
            };
        }

        if (agentKind === 'modulesGeneration') {
            const hbMatch = promptText.match(/# Modules Generator Context for Heartbeat (\d+)/);
            const hbNo = hbMatch ? Number(hbMatch[1]) : Math.max(1, this.sandboxContextState.currentHeartbeatNo);
            this.sandboxContextState.currentHeartbeatNo = hbNo;
            return {
                label: `modulesGeneration:hb${hbNo}:turn${aiTurnCount}`,
                agentKind: 'modulesGeneration',
                heartbeatNo: hbNo,
                turn: aiTurnCount,
            };
        }

        if (agentKind === 'modulesImpactReview') {
            const hbMatch = promptText.match(/# Modules Generator Context for Heartbeat (\d+)/);
            const hbNo = hbMatch ? Number(hbMatch[1]) : Math.max(1, this.sandboxContextState.currentHeartbeatNo);
            this.sandboxContextState.currentHeartbeatNo = hbNo;
            return {
                label: `modulesImpactReview:hb${hbNo}:turn${aiTurnCount}`,
                agentKind: 'modulesImpactReview',
                heartbeatNo: hbNo,
                turn: aiTurnCount,
            };
        }

        if (agentKind === 'modulesTester') {
            const dirMatch = agentDirectory?.match(/^Modules\/Heartbeat-(\d+)\/Module-(\d+)/);
            const hbNo = dirMatch ? Number(dirMatch[1]) : Math.max(1, this.sandboxContextState.currentHeartbeatNo);
            const modIdx = dirMatch ? Number(dirMatch[2]) : 1;
            const moduleId = `m${modIdx}`;
            return {
                label: `modulesTester:hb${hbNo}:${moduleId}`,
                agentKind: 'modulesTester',
                heartbeatNo: hbNo,
                moduleId,
            };
        }

        if (agentKind === 'bsr') {
            const count = (this.sandboxContextState.bsrUpdateCountByBranch.get(branchId) ?? 0) + 1;
            this.sandboxContextState.bsrUpdateCountByBranch.set(branchId, count);
            const iteration = count * this.config.j;
            this.sandboxContextState.branchLatestIteration.set(branchId, iteration);
            return {
                label: `bsr:${branchId}:iter${iteration}`,
                agentKind: 'bsr',
                branchId,
                updateNo: count,
                iteration,
            };
        }

        if (agentKind === 'memoryBank') {
            const count = Math.max(1, this.sandboxContextState.bsrUpdateCountByBranch.get(branchId) ?? 1);
            const iteration = count * this.config.j;
            return {
                label: `memoryBank:${branchId}:iter${iteration}`,
                agentKind: 'memoryBank',
                branchId,
                updateNo: count,
                iteration,
            };
        }

        return { label: agentKind, agentKind };
    }

    private async handleInvocation(args: {
        parsed: ReturnType<SyntheticAgentResponder['parseStepDescription']>;
        stepDescription: string;
        mode: 'direct' | 'sandbox';
        promptText: string;
        systemPrompt: string;
        initialMessages?: BaseMessage[];
        maxOutputTokens?: number;
        sharedWorkspaceHandler?: (input: SharedWorkspaceToolInput) => Promise<string>;
        cwd?: string;
    }): Promise<string> {
        const { parsed } = args;
        const label = parsed.label;
        const startTimeMs = performance.now();
        const attemptNo = (this.attemptCountsByLabel.get(label) ?? 0) + 1;
        this.attemptCountsByLabel.set(label, attemptNo);

        const coordPrng = this.masterPrng.forkForCoordinate(label, attemptNo);

        if (this.enableAsyncJitter && this.maxJitterMs > 0) {
            const delayMs = coordPrng.nextInt(1, this.maxJitterMs);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        for (const rule of this.faultRules) {
            const matches =
                typeof rule.labelPattern === 'string'
                    ? label === rule.labelPattern || args.stepDescription === rule.labelPattern
                    : rule.labelPattern.test(label) || rule.labelPattern.test(args.stepDescription);
            if (matches && attemptNo <= rule.failAttempts) {
                rule.onTrigger?.();
                if (rule.failureType === 'transient_error') {
                    throw new Error(`503 Service Unavailable: Synthetic transient fault on ${label} (attempt ${attemptNo})`);
                }
                if (rule.failureType === 'malformed_json') {
                    return '{ malformed_json_missing_closing_brace: true ';
                }
                if (rule.failureType === 'contract_violation') {
                    return JSON.stringify({ invalid_contract_field: 'synthetic_violation' });
                }
                if (rule.failureType === 'stop_request') {
                    throw new Error(`Synthetic stop triggered at ${label}`);
                }
            }
        }

        if (args.mode === 'sandbox' && args.sharedWorkspaceHandler && coordPrng.nextBool(0.3)) {
            try {
                const currentWs = await args.sharedWorkspaceHandler({ action: 'read' });
                if (countTextTokens(currentWs) < 4200) {
                    await args.sharedWorkspaceHandler({
                        action: 'append',
                        content: `[note:${label}] verified in ${args.cwd ?? '.'}`,
                    });
                }
            } catch {
            }
        }

        this.auditPromptInvariants(label, parsed, args.promptText, args.mode, args.initialMessages, args.maxOutputTokens);

        const responseText = this.generateResponseText(label, parsed, args.promptText, coordPrng);
        const endTimeMs = performance.now();

        const expectedMaxTokens = deepthinkAgentMaxOutputTokens(parsed.agentKind);
        const outputTokens = countTextTokens(responseText);
        if (outputTokens > expectedMaxTokens) {
            this.invariantViolations.push(
                `[${label}] Synthetic response exceeded role token cap: ${outputTokens} > ${expectedMaxTokens}`
            );
        }

        this.seqCounter++;
        this.invocations.push({
            seq: this.seqCounter,
            label,
            stepDescription: args.stepDescription,
            agentKind: parsed.agentKind,
            mode: args.mode,
            iteration: parsed.iteration,
            heartbeatNo: parsed.heartbeatNo,
            updateNo: parsed.updateNo,
            turn: parsed.turn,
            branchId: parsed.branchId,
            moduleId: parsed.moduleId,
            startTimeMs,
            endTimeMs,
            promptText: args.promptText,
            responseText,
            outputTokens,
            maxAllowedOutputTokens: expectedMaxTokens,
            initialMessagesCount: args.initialMessages?.length,
        });

        return responseText;
    }

    private auditPromptInvariants(
        label: string,
        parsed: ReturnType<SyntheticAgentResponder['parseStepDescription']>,
        promptText: string,
        mode: 'direct' | 'sandbox',
        initialMessages?: BaseMessage[],
        maxOutputTokens?: number
    ): void {
        const expectedMaxTokens = deepthinkAgentMaxOutputTokens(parsed.agentKind);
        if (mode === 'sandbox' && maxOutputTokens !== expectedMaxTokens) {
            this.invariantViolations.push(
                `[${label}] Sandbox maxOutputTokens mismatch: received ${maxOutputTokens}, expected ${expectedMaxTokens}`
            );
        }

        if (
            mode === 'sandbox' &&
            (parsed.agentKind === 'initialStrategy' ||
                parsed.agentKind === 'strategyProximity' ||
                parsed.agentKind === 'modulesGeneration' ||
                parsed.agentKind === 'modulesImpactReview')
        ) {
            const turn = parsed.turn ?? 1;
            const msgCount = initialMessages?.length ?? 0;
            if (turn === 1) {
                if (msgCount !== 1 || !(initialMessages?.[0] instanceof HumanMessage)) {
                    this.invariantViolations.push(
                        `[${label}] Turn 1 sandbox loop conversation must start with exactly 1 HumanMessage (got ${msgCount} messages)`
                    );
                }
            } else {
                if (msgCount < 3) {
                    this.invariantViolations.push(
                        `[${label}] Turn ${turn} sandbox loop conversation must continue prior trajectory (>= 3 messages, got ${msgCount})`
                    );
                } else {
                    const lastMsg = initialMessages![msgCount - 1];
                    const lastContent = extractTextFromMessageContent(lastMsg.content);
                    if (
                        !(lastMsg instanceof ToolMessage) ||
                        !lastContent.includes('final_output accepted.') ||
                        !lastContent.includes('Immediate Role:')
                    ) {
                        this.invariantViolations.push(
                            `[${label}] Turn ${turn} sandbox loop conversation must end with peer ToolMessage from appendPeerSubmission`
                        );
                    }
                }
            }
        }

        if (
            (parsed.agentKind === 'solutionCorrection' || parsed.agentKind === 'solutionCritique') &&
            !parsed.isPrunedReplacement
        ) {
            const iteration = parsed.iteration ?? 1;
            const j = this.config.j;
            const currentWindowStart = Math.floor((iteration - 1) / j) * j + 1;

            const memBanks = (promptText.match(/<DistilledMemoryBank>/g) || []).length;
            const curatedContexts = (promptText.match(/<LatestCustomCuratedContext>/g) || []).length;
            const hasPeerIntel = promptText.includes('<CrossStrategyPeerIntelligence>');

            if (iteration <= j && memBanks > 0) {
                this.invariantViolations.push(
                    `[${label}] Window 1 (iter ${iteration} <= j=${j}) must not contain <DistilledMemoryBank>`
                );
            }
            if (memBanks > 1) {
                this.invariantViolations.push(
                    `[${label}] Prompt contains ${memBanks} <DistilledMemoryBank> blocks (must be at most 1)`
                );
            }

            if (parsed.agentKind === 'solutionCritique' && curatedContexts > 0) {
                this.invariantViolations.push(
                    `[${label}] solutionCritique must never receive <LatestCustomCuratedContext>`
                );
            }
            if (parsed.agentKind === 'solutionCorrection' && curatedContexts > 1) {
                this.invariantViolations.push(
                    `[${label}] solutionCorrection contains ${curatedContexts} <LatestCustomCuratedContext> blocks (must be at most 1)`
                );
            }
            if (this.config.modulesCount === 0 && curatedContexts > 0) {
                this.invariantViolations.push(
                    `[${label}] modulesCount=0 but <LatestCustomCuratedContext> was present`
                );
            }

            const historyBlockMatch = promptText.match(/<BranchHistoryAndMemory>([\s\S]*?)<\/BranchHistoryAndMemory>/);
            let preUpdateIterationsCount = 0;
            let windowIterationsCount = 0;

            if (historyBlockMatch) {
                const historyBlock = historyBlockMatch[1];
                const windowBlockMatch = historyBlock.match(
                    /<WindowCorrectionCritiqueHistory>([\s\S]*?)<\/WindowCorrectionCritiqueHistory>/
                );
                const windowBlock = windowBlockMatch ? windowBlockMatch[1] : '';
                const outsideWindowBlock = historyBlock.replace(
                    /<WindowCorrectionCritiqueHistory>[\s\S]*?<\/WindowCorrectionCritiqueHistory>/,
                    ''
                );

                const preUpdateMatches = [...outsideWindowBlock.matchAll(/<Iteration n="(\d+)">/g)];
                preUpdateIterationsCount = preUpdateMatches.length;
                if (preUpdateIterationsCount > 1) {
                    this.invariantViolations.push(
                        `[${label}] Expected at most 1 pre-update <Iteration> outside <WindowCorrectionCritiqueHistory>, found ${preUpdateIterationsCount}`
                    );
                }
                for (const m of preUpdateMatches) {
                    const iterN = Number(m[1]);
                    if (iterN >= currentWindowStart) {
                        this.invariantViolations.push(
                            `[${label}] Pre-update <Iteration n="${iterN}"> is not < currentWindowStart (${currentWindowStart})`
                        );
                    }
                }

                const windowMatches = [...windowBlock.matchAll(/<Iteration n="(\d+)">/g)];
                windowIterationsCount = windowMatches.length;
                if (windowIterationsCount > j) {
                    this.invariantViolations.push(
                        `[${label}] Window history exceeded j=${j} iterations (found ${windowIterationsCount})`
                    );
                }
                for (const m of windowMatches) {
                    const iterN = Number(m[1]);
                    const maxAllowed = parsed.agentKind === 'solutionCritique' ? iteration : iteration - 1;
                    if (iterN < currentWindowStart || iterN > maxAllowed) {
                        this.invariantViolations.push(
                            `[${label}] Window <Iteration n="${iterN}"> out of current window bounds [${currentWindowStart}, ${maxAllowed}]`
                        );
                    }
                }
            }

            if (parsed.agentKind === 'solutionCorrection') {
                if ((this.config.isolateBranches || this.config.strategiesCount === 1) && hasPeerIntel) {
                    this.invariantViolations.push(
                        `[${label}] <CrossStrategyPeerIntelligence> must be absent when isolateBranches=${this.config.isolateBranches} or strategiesCount=${this.config.strategiesCount}`
                    );
                }
                if (!this.config.isolateBranches && this.config.strategiesCount > 1 && !hasPeerIntel) {
                    this.invariantViolations.push(
                        `[${label}] <CrossStrategyPeerIntelligence> missing when isolateBranches=false and strategiesCount=${this.config.strategiesCount}`
                    );
                }
                if (hasPeerIntel) {
                    const peerBlockMatch = promptText.match(
                        /<CrossStrategyPeerIntelligence>([\s\S]*?)<\/CrossStrategyPeerIntelligence>/
                    );
                    const peerBlock = peerBlockMatch ? peerBlockMatch[1] : '';
                    if (peerBlock.includes(`[ITERATION_${iteration}_SOLUTION`)) {
                        this.invariantViolations.push(
                            `[${label}] Race condition detected: <CrossStrategyPeerIntelligence> leaked same-iteration (${iteration}) solution from a faster parallel peer!`
                        );
                    }
                }
            }

            if (
                promptText.includes('<StandingEventLedger>') ||
                promptText.includes('<ConsolidatedBsrDecisions>') ||
                promptText.includes('<DosCoreSynthesis>')
            ) {
                this.invariantViolations.push(
                    `[${label}] Branch agent prompt leaked internal BSR/DOS blocks`
                );
            }

            this.memoryAudits.push({
                label,
                iteration,
                branchId: parsed.branchId,
                promptTokens: countTextTokens(promptText),
                preUpdateIterationsCount,
                windowIterationsCount,
                distilledMemoryBankCount: memBanks,
                curatedContextCount: curatedContexts,
                hasCrossStrategyPeerIntel: hasPeerIntel,
            });
        }

        if (label.startsWith('strategyGeneration:update:iter') || label.startsWith('strategyProximity:update:iter')) {
            const updateNo = parsed.updateNo ?? 1;
            if (parsed.turn === 1 && label.startsWith('strategyGeneration:update:iter')) {
                if (!this.globalUpdateSurgicalRuns.includes(updateNo)) {
                    this.globalUpdateSurgicalRuns.push(updateNo);
                }
            }

            if (!promptText.includes('# Seed Strategy Generation History')) {
                this.invariantViolations.push(`[${label}] Missing "# Seed Strategy Generation History" in <StrategyProximityHistory>`);
            }

            for (const priorU of this.globalUpdateSurgicalRuns) {
                if (priorU >= updateNo) continue;
                const padded = String(priorU).padStart(2, '0');
                const expectedReframedPath = `DOS_history/DOS_global_update_${padded}_step_i.md`;
                if (!promptText.includes(expectedReframedPath)) {
                    this.invariantViolations.push(
                        `[${label}] Missing GU reframed note path ${expectedReframedPath} for prior Global Update ${priorU}`
                    );
                }
            }

            const bsrDecisionBlocks = (promptText.match(/<ConsolidatedBsrDecisions>/g) || []).length;
            if (bsrDecisionBlocks !== 1) {
                this.invariantViolations.push(
                    `[${label}] Expected exactly 1 <ConsolidatedBsrDecisions> block (prior updates reframed), found ${bsrDecisionBlocks}`
                );
            }

            const bsrSectionMatch = promptText.match(
                /<ConsolidatedBsrDecisions>([\s\S]*?)<\/ConsolidatedBsrDecisions>/
            );
            if (bsrSectionMatch) {
                const bsrSection = bsrSectionMatch[1];
                for (const forbidden of ['lost_ground', 'progress_kept', 'stall_evidence', 'continue_pressure', 'evolve_pressure', 'prune_pressure']) {
                    if (bsrSection.includes(forbidden)) {
                        this.invariantViolations.push(
                            `[${label}] <ConsolidatedBsrDecisions> leaked numeric BSR metric "${forbidden}"`
                        );
                    }
                }
            }

            if (promptText.includes('<RealizedModuleFeedback>') || promptText.includes('critique_counterevidence')) {
                this.invariantViolations.push(
                    `[${label}] Strategy prompt leaked module feedback or critique_counterevidence`
                );
            }
        }

        if (parsed.agentKind === 'modulesGeneration' || parsed.agentKind === 'modulesImpactReview') {
            const hbNo = parsed.heartbeatNo ?? 1;
            if (hbNo >= 2) {
                for (let m = 1; m < hbNo; m++) {
                    const expectedHeading = `# Heartbeat ${m} Modules Generator History`;
                    if (!promptText.includes(expectedHeading)) {
                        this.invariantViolations.push(
                            `[${label}] Missing "${expectedHeading}" in Heartbeat ${hbNo}`
                        );
                    }
                    const expectedReframeMarker =
                        m === 1
                            ? 'In Heartbeat 1, you received the initial DOS synthesis'
                            : `For Heartbeat ${m}, you received the DOS synthesis inside`;
                    if (!promptText.includes(expectedReframeMarker)) {
                        this.invariantViolations.push(
                            `[${label}] Missing {HB_Reframed_Note(${m})} in Heartbeat ${hbNo}`
                        );
                    }
                }
                const feedbackBlocks = (promptText.match(/<RealizedModuleFeedback>/g) || []).length;
                if (feedbackBlocks > 1) {
                    this.invariantViolations.push(
                        `[${label}] Expected at most 1 live <RealizedModuleFeedback> block, found ${feedbackBlocks}`
                    );
                }
            }
        }
    }

    private generateResponseText(
        label: string,
        parsed: ReturnType<SyntheticAgentResponder['parseStepDescription']>,
        promptText: string,
        prng: SeededPRNG
    ): string {
        switch (parsed.agentKind) {
            case 'initialStrategy': {
                if (label.startsWith('strategyGeneration:update:iter')) {
                    const bsrMatch = promptText.match(
                        /<ConsolidatedBsrDecisions>([\s\S]*?)<\/ConsolidatedBsrDecisions>/
                    );
                    const bsrText = bsrMatch ? bsrMatch[1] : promptText;
                    const evolvedSlots: Array<{ slot_id: string; updated_strategy_text: string }> = [];
                    const prunedSlots: Array<{ slot_id: string; new_strategy_text: string }> = [];

                    for (let idx = 1; idx <= this.config.strategiesCount; idx++) {
                        const slotId = `main${idx}`;
                        const slotRegex = new RegExp(`###\\s+${slotId}[\\s\\S]*?Decision:\\s*([^\\n]+)`);
                        const m = bsrText.match(slotRegex);
                        const decisionLine = m ? m[1].trim() : '';
                        if (decisionLine.startsWith('EVOLVE')) {
                            evolvedSlots.push({
                                slot_id: slotId,
                                updated_strategy_text: `Evolved Strategy for ${slotId} at iter ${parsed.iteration} (turn ${parsed.turn}, seed ${prng.nextUint32()}): pivot away from prior bottleneck and verify invariants.`,
                            });
                        } else if (decisionLine.startsWith('PRUNE')) {
                            prunedSlots.push({
                                slot_id: slotId,
                                new_strategy_text: `Replacement Strategy for ${slotId} at iter ${parsed.iteration} (turn ${parsed.turn}, seed ${prng.nextUint32()}): fresh orthogonal formulation.`,
                            });
                        }
                    }

                    return JSON.stringify({
                        evolved_slots: evolvedSlots,
                        pruned_slots: prunedSlots,
                    });
                }

                const strategies: string[] = [];
                for (let idx = 1; idx <= this.config.strategiesCount; idx++) {
                    strategies.push(
                        `Strategy ${idx} (turn ${parsed.turn}, tag ${prng.nextUint32()}): Orthogonal mathematical and empirical verification trajectory for main${idx}.`
                    );
                }
                return JSON.stringify({ strategies });
            }

            case 'strategyProximity': {
                return `Strategy Proximity Audit (${label}, seed ${prng.nextUint32()}): Verified pairwise orthogonality across active slots and flagged any shared boundary assumptions for refinement.`;
            }

            case 'solutionAttempt': {
                const tag = parsed.isPrunedReplacement
                    ? `[REPLACEMENT_ITER_${parsed.iteration}_SOLUTION:${parsed.branchId}]`
                    : `[ITERATION_1_SOLUTION:${parsed.branchId}]`;
                return `${tag}\nBaseline verified implementation for ${parsed.branchId} (seed ${prng.nextUint32()}).\n- Core invariant check: PASS\n- Scratch verification: /tmp/${parsed.branchId}/verify.py`;
            }

            case 'solutionCorrection': {
                const tag = `[ITERATION_${parsed.iteration}_SOLUTION:${parsed.branchId}]`;
                return `**Revision approach:**\nResolved critique obligations for ${parsed.branchId} at iteration ${parsed.iteration} (seed ${prng.nextUint32()}), absorbed curated modules, and verified zero regression.\n\n**Corrected artifact:**\n${tag}\nComplete standalone deliverable for ${parsed.branchId} at iteration ${parsed.iteration}.`;
            }

            case 'solutionCritique': {
                const tag = parsed.isPrunedReplacement
                    ? `[REPLACEMENT_ITER_${parsed.iteration}_CRITIQUE:${parsed.branchId}]`
                    : `[ITERATION_${parsed.iteration}_CRITIQUE:${parsed.branchId}]`;
                return `## Critique\n${tag}\n### Verified Progress & Confirmed Fixes\nConfirmed resolution of prior boundary condition on ${parsed.branchId} (seed ${prng.nextUint32()}).\n### Regressions & Critical Flaws\nIdentified edge-case precision gap under high-load stress.\n### Verification Harness & Testing Gaps\nTightened /tmp/${parsed.branchId}/verify.py assertions.\n### Concrete Obligations for Next Correction\nRepair edge-case precision gap while keeping core module intact.\n### Preserve\nKeep verified baseline invariants intact.`;
            }

            case 'dos': {
                const isStepI = parsed.dosSubKind === 'step_i';
                const isStepII = parsed.dosSubKind === 'step_ii';
                const coreSynthesis = {
                    branch_diagnostics: `Diagnostics across ${this.config.strategiesCount} branches at ${label} (seed ${prng.nextUint32()}).`,
                    shared_strengths: 'Baseline verification harnesses established.',
                    common_failure_modes: 'Boundary precision under extreme parameter regimes.',
                    verification_and_harness_gaps: 'Need stronger invariant fuzzing in /tmp/shared_harness/.',
                    high_leverage_offload_targets: 'Standalone boundary verifier and constructive sub-component.',
                };

                if (isStepI) {
                    return JSON.stringify({ core_synthesis: coreSynthesis });
                }

                const prevModMatch = promptText.match(
                    /<PreviousHeartbeatModulesAndTests>\s*([\s\S]*?)\s*<\/PreviousHeartbeatModulesAndTests>/
                );
                const prevModRaw = prevModMatch ? prevModMatch[1].trim() : 'None.';
                if (!prevModRaw || prevModRaw === 'None.') {
                    return JSON.stringify({ core_synthesis: coreSynthesis });
                }

                let prevModules: Array<{ module_id: string; target_branches: string[] }> = [];
                try {
                    const parsedMods = JSON.parse(prevModRaw);
                    prevModules = Array.isArray(parsedMods)
                        ? parsedMods
                        : Array.isArray(parsedMods?.modules)
                          ? parsedMods.modules
                          : [];
                } catch {
                    prevModules = [];
                }
                if (prevModules.length === 0) {
                    return JSON.stringify({ core_synthesis: coreSynthesis });
                }

                const survivingBranches: string[] = [];
                if (isStepII) {
                    for (let idx = 1; idx <= this.config.strategiesCount; idx++) {
                        const slotId = `main${idx}`;
                        if (!promptText.includes(`- ${slotId}: PRUNE`)) {
                            survivingBranches.push(slotId);
                        }
                    }
                } else {
                    for (let idx = 1; idx <= this.config.strategiesCount; idx++) {
                        survivingBranches.push(`main${idx}`);
                    }
                }

                const classifications = ['USED_CORRECTLY', 'USED_PARTIALLY', 'NOT_USED', 'MISUSED'] as const;
                const moduleFeedback = prevModules.map(mod => {
                    const candidateTargets =
                        mod.target_branches && mod.target_branches.length > 0
                            ? mod.target_branches.filter(b => survivingBranches.includes(b))
                            : survivingBranches;

                    const branchUtilization = candidateTargets.map(branchId => ({
                        branch_id: branchId,
                        utilization: {
                            classification: prng.pick(classifications),
                            reason: `Observed utilization in ${branchId}'s latest correction and critique.`,
                        },
                    }));

                    const hasCounterevidence = candidateTargets.length > 0 && prng.nextBool(0.25);
                    return {
                        module_id: mod.module_id,
                        branch_utilization: branchUtilization,
                        ...(hasCounterevidence
                            ? {
                                  critique_counterevidence: [
                                      {
                                          branch_id: candidateTargets[0],
                                          classification: 'STRONG' as const,
                                          reason: `Downstream critique in ${candidateTargets[0]} exposed an edge case in ${mod.module_id}.`,
                                      },
                                  ],
                              }
                            : {}),
                    };
                });

                return JSON.stringify({
                    core_synthesis: coreSynthesis,
                    module_feedback: moduleFeedback,
                });
            }

            case 'modulesGeneration': {
                const modules = [];
                for (let m = 1; m <= this.config.modulesCount; m++) {
                    const targetAll = prng.nextBool(0.4);
                    const targetBranches: string[] = [];
                    if (!targetAll) {
                        const pickedIdx = prng.nextInt(1, this.config.strategiesCount);
                        targetBranches.push(`main${pickedIdx}`);
                    }
                    modules.push({
                        module_id: `m${m}`,
                        text: `Self-contained specification for Module m${m} in Heartbeat ${parsed.heartbeatNo} (turn ${parsed.turn}, seed ${prng.nextUint32()}): build and verify standalone helper in Modules/Heartbeat-${parsed.heartbeatNo}/Module-${m}/.`,
                        target_branches: targetBranches,
                    });
                }
                return JSON.stringify({ modules });
            }

            case 'modulesImpactReview': {
                return `Modules Impact Review (${label}, seed ${prng.nextUint32()}): Audited proposed modules against DosCoreSynthesis and RealizedModuleFeedback to ensure direct branch usability.`;
            }

            case 'modulesTester': {
                const outcomes = ['VALIDATED', 'REJECTED', 'INCONCLUSIVE'] as const;
                const verdict = prng.pick(outcomes);
                return `Standalone module production & verification report for ${parsed.moduleId} in Heartbeat ${parsed.heartbeatNo} (seed ${prng.nextUint32()}).\nSaved verified script to Modules/Heartbeat-${parsed.heartbeatNo}/.\n\nCLASSIFICATION: ${verdict}`;
            }

            case 'bsr': {
                const branchId = parsed.branchId ?? 'main1';
                const iteration = parsed.iteration ?? this.config.j;
                const j = this.config.j;
                const windowStart = iteration - j + 1;
                const updateIdx = Math.max(0, (parsed.updateNo ?? 1) - 1);
                const forced = this.forcedSlotBehaviors[branchId]?.[updateIdx] ?? 'AUTO';

                if (forced === 'FORCE_CONTINUE') {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [
                            { iteration: windowStart, size: 'large', reason: 'Major breakthrough verified by critique.' },
                            { iteration: iteration, size: 'large', reason: 'All edge cases verified in harness.' },
                        ],
                        confirmed_regression: [],
                        critique_alignment: { value: 0.95, reason: 'Systematically resolved all critique points.' },
                    });
                }

                if (forced === 'FORCE_EVOLVE_IN_PLACE') {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [],
                        confirmed_regression: [],
                        critique_alignment: { value: 1.0, reason: 'Followed critique closely despite plateau.' },
                    });
                }

                if (forced === 'FORCE_EVOLVE_SCROLLBACK') {
                    const regressions = [];
                    for (let it = windowStart + 1; it <= iteration; it++) {
                        regressions.push({
                            iteration: it,
                            size: 'large' as const,
                            reason: `Regression introduced at iteration ${it}.`,
                        });
                    }
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [
                            { iteration: windowStart, size: 'large', reason: 'Strong verified checkpoint at window start.' },
                        ],
                        confirmed_regression: regressions,
                        critique_alignment: { value: 0.2, reason: 'Regressed after windowStart checkpoint.' },
                    });
                }

                if (forced === 'FORCE_EVOLVE_WINDOW_START') {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [],
                        confirmed_regression: [
                            { iteration: windowStart, size: 'large', reason: 'Immediate regression at start of window.' },
                            { iteration: iteration, size: 'large', reason: 'Continued regression across window.' },
                        ],
                        critique_alignment: { value: 0.0, reason: 'Bypassed critique findings throughout window.' },
                    });
                }

                if (forced === 'FORCE_PRUNE') {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [],
                        confirmed_regression: [],
                        critique_alignment: { value: 1.0, reason: 'Addressed local critique items but achieved zero confirmed progress.' },
                    });
                }

                const behaviorRoll = prng.nextInt(0, 4);
                const sizes = ['small', 'medium', 'large'] as const;
                if (behaviorRoll === 0) {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [
                            { iteration: windowStart, size: prng.pick(sizes), reason: 'Verified progress at window start.' },
                            { iteration: iteration, size: 'large', reason: 'Verified progress at window end.' },
                        ],
                        confirmed_regression: [],
                        critique_alignment: { value: prng.nextFloat(0.6, 1.0), reason: 'Strong alignment.' },
                    });
                }
                if (behaviorRoll === 1) {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [],
                        confirmed_regression: [],
                        critique_alignment: { value: 0.95, reason: 'Stalled despite following critique.' },
                    });
                }
                if (behaviorRoll === 2) {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [
                            { iteration: windowStart, size: 'medium', reason: 'Verified fix at window start.' },
                        ],
                        confirmed_regression: [
                            { iteration: iteration, size: 'large', reason: 'Severe regression at end of window.' },
                        ],
                        critique_alignment: { value: 0.3, reason: 'Partial alignment with regression.' },
                    });
                }
                if (behaviorRoll === 3) {
                    return JSON.stringify({
                        branch_id: branchId,
                        confirmed_progress: [],
                        confirmed_regression: [
                            { iteration: windowStart, size: 'large', reason: 'Immediate regression at window start.' },
                            { iteration: iteration, size: 'medium', reason: 'Additional regression at window end.' },
                        ],
                        critique_alignment: { value: 0.0, reason: 'Ignored critique constraints.' },
                    });
                }
                const midIter = Math.min(iteration, windowStart + 1);
                return JSON.stringify({
                    branch_id: branchId,
                    confirmed_progress: [
                        { iteration: windowStart, size: 'small', reason: 'Initial step.' },
                        { iteration: midIter, size: 'large', reason: 'Peak checkpoint at mid-window.' },
                    ],
                    confirmed_regression: [
                        ...(iteration > midIter
                            ? [{ iteration, size: 'large' as const, reason: 'Late-window regression.' }]
                            : []),
                    ],
                    critique_alignment: { value: prng.nextFloat(-0.4, 0.9), reason: 'Mixed critique alignment.' },
                });
            }

            case 'memoryBank': {
                return `## Verified Facts, Equations & Theorems\n- [${label}] Retained verified results up to cutoff for ${parsed.branchId} (seed ${prng.nextUint32()}).\n\n## Confirmed Dead Ends & Falsified Hypotheses\n- Eliminated boundary-violating formulation.\n\n## Active Constraints & Edge Cases\n- Enforce strict positivity on boundary invariants.\n\n## Reusable Sub-Components & Verification Harnesses\n- Preserved /tmp/${parsed.branchId}/verify.py.`;
            }
        }
    }

    public verifyPhaseBarriers(): string[] {
        const errors: string[] = [];

        const byIter = new Map<number, AgentInvocationRecord[]>();
        for (const inv of this.invocations) {
            if (inv.iteration !== undefined) {
                const list = byIter.get(inv.iteration) ?? [];
                list.push(inv);
                byIter.set(inv.iteration, list);
            }
        }

        for (const [iter, records] of byIter.entries()) {
            const regularSolutions = records.filter(
                r =>
                    (r.agentKind === 'solutionAttempt' || r.agentKind === 'solutionCorrection') &&
                    !r.label.endsWith(':pruned')
            );
            const regularCritiques = records.filter(
                r => r.agentKind === 'solutionCritique' && !r.label.endsWith(':pruned')
            );

            if (regularSolutions.length > 0 && regularCritiques.length > 0) {
                const maxSolEnd = Math.max(...regularSolutions.map(r => r.endTimeMs));
                const minCritStart = Math.min(...regularCritiques.map(r => r.startTimeMs));
                if (maxSolEnd > minCritStart + 1e-6) {
                    errors.push(
                        `Barrier violation at iter ${iter}: Solution phase ended at ${maxSolEnd.toFixed(2)}ms after Critique phase started at ${minCritStart.toFixed(2)}ms`
                    );
                }
            }

            const stepIDos = records.filter(r => r.label.startsWith(`dos:step_i:iter${iter}`));
            const bsrCalls = records.filter(r => r.agentKind === 'bsr');
            const surgicalSg = records.filter(
                r =>
                    r.label.startsWith(`strategyGeneration:update:iter${iter}`) ||
                    r.label.startsWith(`strategyProximity:update:iter${iter}`)
            );
            const prunedAttempts = records.filter(
                r => r.agentKind === 'solutionAttempt' && r.label.endsWith(':pruned')
            );
            const prunedCritiques = records.filter(
                r => r.agentKind === 'solutionCritique' && r.label.endsWith(':pruned')
            );
            const memBanks = records.filter(r => r.agentKind === 'memoryBank');
            const stepIIDos = records.filter(r => r.label.startsWith(`dos:step_ii:iter${iter}`));

            const stepIAndBsr = [...stepIDos, ...bsrCalls];
            if (stepIAndBsr.length > 0 && surgicalSg.length > 0) {
                const maxStepIEnd = Math.max(...stepIAndBsr.map(r => r.endTimeMs));
                const minSgStart = Math.min(...surgicalSg.map(r => r.startTimeMs));
                if (maxStepIEnd > minSgStart + 1e-6) {
                    errors.push(
                        `Global Update barrier violation at iter ${iter}: Step-i DOS/BSR ended (${maxStepIEnd.toFixed(2)}ms) after Surgical Strategy Gen started (${minSgStart.toFixed(2)}ms)`
                    );
                }
            }

            if (surgicalSg.length > 0 && prunedAttempts.length > 0) {
                const maxSgEnd = Math.max(...surgicalSg.map(r => r.endTimeMs));
                const minPrunedAttStart = Math.min(...prunedAttempts.map(r => r.startTimeMs));
                if (maxSgEnd > minPrunedAttStart + 1e-6) {
                    errors.push(
                        `Global Update barrier violation at iter ${iter}: Surgical Strategy Gen ended (${maxSgEnd.toFixed(2)}ms) after Pruned Replacement Attempt started (${minPrunedAttStart.toFixed(2)}ms)`
                    );
                }
            }

            for (const att of prunedAttempts) {
                const matchingCrit = prunedCritiques.find(c => c.branchId === att.branchId);
                if (matchingCrit && att.endTimeMs > matchingCrit.startTimeMs + 1e-6) {
                    errors.push(
                        `Global Update barrier violation at iter ${iter} (${att.branchId}): Pruned Replacement Attempt ended (${att.endTimeMs.toFixed(2)}ms) after Pruned Replacement Critique started (${matchingCrit.startTimeMs.toFixed(2)}ms)`
                    );
                }
            }

            const preStepII = [...memBanks, ...prunedAttempts, ...prunedCritiques];
            if (preStepII.length > 0 && stepIIDos.length > 0) {
                const maxPreEnd = Math.max(...preStepII.map(r => r.endTimeMs));
                const minStepIIStart = Math.min(...stepIIDos.map(r => r.startTimeMs));
                if (maxPreEnd > minStepIIStart + 1e-6) {
                    errors.push(
                        `Global Update barrier violation at iter ${iter}: MemoryBank/PrunedCritique ended (${maxPreEnd.toFixed(2)}ms) after Step-ii DOS started (${minStepIIStart.toFixed(2)}ms)`
                    );
                }
            }
        }

        const byHb = new Map<number, AgentInvocationRecord[]>();
        for (const inv of this.invocations) {
            if (inv.heartbeatNo !== undefined) {
                const list = byHb.get(inv.heartbeatNo) ?? [];
                list.push(inv);
                byHb.set(inv.heartbeatNo, list);
            }
        }

        for (const [hbNo, records] of byHb.entries()) {
            const genAndReview = records.filter(
                r => r.agentKind === 'modulesGeneration' || r.agentKind === 'modulesImpactReview'
            );
            const testers = records.filter(r => r.agentKind === 'modulesTester');
            if (genAndReview.length > 0 && testers.length > 0) {
                const maxGenEnd = Math.max(...genAndReview.map(r => r.endTimeMs));
                const minTesterStart = Math.min(...testers.map(r => r.startTimeMs));
                if (maxGenEnd > minTesterStart + 1e-6) {
                    errors.push(
                        `Heartbeat ${hbNo} barrier violation: Modules Gen/Review ended (${maxGenEnd.toFixed(2)}ms) after Modules Tester started (${minTesterStart.toFixed(2)}ms)`
                    );
                }
            }
        }

        return errors;
    }
}
