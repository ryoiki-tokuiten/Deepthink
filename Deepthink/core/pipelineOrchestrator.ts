/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MANDATORY REFERENCE: Read Deepthink_Consolidated_Specification.md before modifying!
 * The specification document (Deepthink/docs/Deepthink_Consolidated_Specification.md)
 * is the absolute source of truth for the entire pipeline, all loop barriers,
 * and data structures (§1, §2, §3, §4, §5, §6, §7, §8, §9).
 * NOTE: For ANY minor inconvenience or uncertainty during execution, ALWAYS consult
 * Deepthink_Consolidated_Specification.md first. It contains critical operational
 * details (failure policies, window_start rollbacks, etc.)
 * that must never be altered or ignored.
 */

import { nanoid } from 'nanoid';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type {
  BsrAction,
  BsrComputedScores,
  BsrEvolveForm,
  BsrReport,
  DeepthinkModuleData,
  DeepthinkLiveEvent,
  DeepthinkMainStrategyData,
  DeepthinkPipelineState,
  DosModuleFeedbackItem,
  DosOutput,
  HeartbeatBlock,
  ProximityTurn,
  RealizedModuleFeedback,
} from './types.ts';
import {
  evaluateBranchState,
  calculateUtilizationVector,
  SIZE_WEIGHTS,
  TAU,
  THETA,
  type BsrConfigOptions,
} from './formulas.ts';
import {
  determinePostIterationStep,
  validateLoopBounds,
} from './loopController.ts';
import {
  buildContextForBsr,
  buildContextForCorrectionAgent,
  buildContextForCritiqueAgent,
  buildContextForDos,
  buildContextForFinalJudge,
  buildContextForModulesGenerate,
  buildContextForStrategyGlobalUpdate,
  buildContextForStrategySeed,
  buildCritiqueCorrectionMemoryBankHistory,
  buildCrossStrategyLatestCorrectionCritique,
  parsePromptToGeminiParts,
} from './contextBuilders.ts';
import {
  DEEPTHINK_AGENT_REGISTRY,
  deepthinkAgentMaxOutputTokens,
  deepthinkAgentModel,
  deepthinkAgentSystemInstruction,
  type DeepthinkAgentKind,
} from './agentRegistry.ts';
import { createDefaultCustomPromptsDeepthink } from '../prompts/index.ts';
import { GitRepositoryHarness } from './gitRepository.ts';
import { SharedWorkspaceManager, type SharedWorkspaceToolInput } from './sharedWorkspace.ts';
import {
  buildModulesImpactReviewHistoryWithNotes,
  buildStrategyProximityHistoryWithNotes,
} from './harnessNotes.ts';
import type {
  SandboxRepositoryAccess,
  DeepthinkResultsContextFile,
} from './types.ts';

import {
  DEFAULT_NORMALIZATION_BOUNDS,
  normalizeTranscript,
  validateTranscript,
} from '@letta-ai/trajectory';
import {
  INFERENCE_RETRY_DELAYS_MS,
  InferenceSilenceTimeoutError,
  isTerminalInferenceError,
  withSilenceWatchdog,
} from '../../Core/ProviderError.ts';

export const INCLUDE_REASONING_IN_TRAJECTORY_JSONL = false;

export function sanitizeTrajectoryRecordsForJsonl(
  records: ReadonlyArray<Record<string, any>>,
  includeReasoning = INCLUDE_REASONING_IN_TRAJECTORY_JSONL
): Array<Record<string, unknown>> {
  let firstUserDropped = false;
  const cleaned: Array<Record<string, unknown>> = [];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const roleOrKind = record.role ?? record.kind;

    if (roleOrKind === 'system') continue;
    if (roleOrKind === 'user' && !firstUserDropped) {
      firstUserDropped = true;
      continue;
    }
    if (roleOrKind === 'reasoning' && !includeReasoning) continue;

    const copy: Record<string, unknown> = { ...record };
    delete copy.timestamp;
    delete copy.captured_at;
    delete copy.id;
    delete copy.tool_call_id;
    delete copy.source_message_id;
    delete copy.source_line_id;

    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = copy.tool_calls.map((tc: any) => {
        if (!tc || typeof tc !== 'object') return tc;
        const tcCopy: Record<string, unknown> = { ...tc };
        delete tcCopy.id;
        return tcCopy;
      });
    }

    cleaned.push(copy);
  }

  return cleaned;
}

export function formatDirectCallTrajectoryJsonl(args: {
  systemInstruction?: string;
  userPrompt?: string;
  assistantResponse: string;
}): string {
  const baseMs = Date.now();
  const rows = [
    {
      kind: 'user',
      text: args.userPrompt?.trim() || '[agent invocation]',
      captured_at: new Date(baseMs).toISOString(),
    },
    {
      kind: 'assistant',
      text: args.assistantResponse?.trim() || '[completed]',
      captured_at: new Date(baseMs + 1_000).toISOString(),
    },
  ];
  try {
    const normalized = normalizeTranscript({
      source: 'letta-code',
      transcript: rows.map(row => JSON.stringify(row)).join('\n'),
      bounds: {
        ...DEFAULT_NORMALIZATION_BOUNDS,
        toolResults: { maxCharacters: null, strategy: 'head-tail' },
      },
      filters: {
        systemMessages: 'omit',
        toolResults: 'include',
      },
    });
    validateTranscript(normalized.records);
    return sanitizeTrajectoryRecordsForJsonl(normalized.records)
      .map(record => JSON.stringify(record))
      .join('\n');
  } catch {
    return sanitizeTrajectoryRecordsForJsonl(rows)
      .map(row => JSON.stringify(row))
      .join('\n');
  }
}

async function getSandboxToolAgentRunner() {
  try {
    const mod = await import('../../Core/SandboxToolRuntime.ts');
    return mod.runSandboxToolAgent;
  } catch {
    return null;
  }
}

/**
 * One continuous sandbox trajectory for one agent of a generator ⇄ reviewer loop
 * (Strategy Generator, Strategy Proximity Reviewer, Modules Generator, Modules Impact Reviewer).
 * It lives for a single seed, global update, or heartbeat invocation. `messages` is empty until
 * the agent's first round; afterwards it ends with the agent's accepted final_output call.
 */
interface LoopAgentConversation {
  sessionId: string;
  messages: BaseMessage[];
}

function createLoopAgentConversation(runId: string, agentKind: DeepthinkAgentKind): LoopAgentConversation {
  return { sessionId: `dtsb-${runId}-${agentKind}-${nanoid(6)}`, messages: [] };
}

/**
 * Appends the peer's latest round output as the tool result of the agent's previous final_output
 * call, followed by the agent's Immediate Role line, so its next round continues the exact same
 * append-only trajectory. Does nothing before the agent's first sandbox invocation.
 */
function appendPeerSubmission(
  conversation: LoopAgentConversation,
  peerHeading: string,
  peerContent: string,
  immediateRole: string
): void {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!(last instanceof AIMessage)) return;
  const content = [
    'final_output accepted.',
    '',
    peerHeading,
    peerContent,
    '',
    `Immediate Role: ${immediateRole}`,
  ].join('\n');
  for (const call of last.tool_calls ?? []) {
    if (!call.id) call.id = nanoid(8);
    const isFinalOutput = call.name === 'final_output';
    conversation.messages.push(new ToolMessage({
      name: call.name,
      tool_call_id: call.id,
      content: isFinalOutput ? content : 'Not executed: final_output was submitted in the same turn.',
      status: isFinalOutput ? 'success' : 'error',
    }));
  }
}

function buildLoopRoleTrajectoryJsonl(
  turns: Array<{ role: 'generator' | 'proximity'; content: string; turnNumber?: number; trajectoryJsonl?: string }>,
  isContinuousSandbox: boolean
): string {
  if (turns.length === 0) return '';
  if (isContinuousSandbox) {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn.trajectoryJsonl) return lastTurn.trajectoryJsonl;
  }
  return turns
    .map(h => h.trajectoryJsonl || JSON.stringify({
      role: 'assistant',
      message_type: 'ai',
      turn_role: h.role,
      turn_number: h.turnNumber,
      content: h.content,
    }))
    .filter(Boolean)
    .join('\n');
}

// ============================================================================
// Constants & Failure Policy (§9)
// ============================================================================

/** Delays for 4 total attempts: 1m, 3m, 5m */
const RETRY_DELAYS_MS = INFERENCE_RETRY_DELAYS_MS;
const MAX_API_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 4 attempts total

export interface PipelineExecutionCallbacks {
  callAI: (args: {
    prompt: string;
    model: string;
    systemInstruction?: string;
    thinkingConfig?: { thinkingLevel?: string };
    responseSchema?: Record<string, unknown> | boolean;
    agentKind?: DeepthinkAgentKind;
    stepDescription?: string;
    abortSignal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    silenceTimeoutMs?: number;
    onChunkActivity?: () => void;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
  }) => Promise<string>;
  parseJsonStrict?: <T>(text: string) => T;
  parseJsonSafe?: <T>(text: string, fallback?: T) => T;
  onLiveEvent?: (event: DeepthinkLiveEvent) => void;
  onStateChange?: (state: DeepthinkPipelineState) => void;
  retryDelaysMs?: number[];
  silenceTimeoutMs?: number;
  runSandboxToolAgent?: typeof import('../../Core/SandboxToolRuntime.ts').runSandboxToolAgent;
}

export class PipelineStopRequestedError extends Error {
  constructor(message = 'Deepthink run stopped by user request.') {
    super(message);
    this.name = 'PipelineStopRequestedError';
  }
}

export interface OutputValidationContract<T> {
  name: string;
  validate: (parsed: T) => void;
}

/**
 * Extracts a candidate JSON string from markdown code blocks or surrounding text.
 */
export function extractJsonString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  // 1. If wrapped in markdown code fence, extract the block
  const fenceMatch = text.match(/```(?:json|json5)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch && fenceMatch[1].trim()) {
    text = fenceMatch[1].trim();
  }

  // 2. If it already starts with { or [, return it
  if (text.startsWith('{') || text.startsWith('[')) {
    return text;
  }

  // 3. Find the outermost { ... } or [ ... ]
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx !== -1) {
    const isObject = text[startIdx] === '{';
    const closeChar = isObject ? '}' : ']';
    const lastIdx = text.lastIndexOf(closeChar);
    if (lastIdx > startIdx) {
      return text.substring(startIdx, lastIdx + 1).trim();
    }
  }

  return text;
}

/**
 * Clean, modular, functional orchestrator for the Deepthink Consolidated Specification.
 */
export class DeepthinkPipelineOrchestrator {
  private readonly gitHarness: GitRepositoryHarness;
  private readonly sharedWorkspace: SharedWorkspaceManager;
  private commitHashesPerIteration = new Map<string, string>(); // key: `slotIndex:iteration` or `slotIndex:start_${windowStart}`
  private strategiesUsedSoFar: Array<{ slotId: string; iterationFinalized: number; text: string }> = [];
  private modulesUsedSoFar: Array<{ heartbeatNo: number; iterationFinalized: number; moduleId: string; text: string }> = [];
  private globalUpdateStrategyHistories: Array<{ updateNumber: number; turns: ProximityTurn[] }> = [];
  private readonly state: DeepthinkPipelineState;
  private readonly callbacks: PipelineExecutionCallbacks;
  private abortController = new AbortController();

  public stop(): void {
    this.state.isStopRequested = true;
    this.state.status = 'stopped';
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new PipelineStopRequestedError());
    }
  }

  public get isStopRequested(): boolean {
    return Boolean(
      this.state.isStopRequested ||
      this.state.status === 'stopped' ||
      this.abortController.signal.aborted
    );
  }

  constructor(
    state: DeepthinkPipelineState,
    callbacks: PipelineExecutionCallbacks
  ) {
    this.state = state;
    this.callbacks = callbacks;
    this.gitHarness = new GitRepositoryHarness(state.id);
    this.sharedWorkspace = new SharedWorkspaceManager();

    if (Array.isArray((state as any).commitHashesPerIteration)) {
      this.commitHashesPerIteration = new Map((state as any).commitHashesPerIteration);
    } else if ((state as any).commitHashesPerIteration && typeof (state as any).commitHashesPerIteration === 'object') {
      this.commitHashesPerIteration = new Map(Object.entries((state as any).commitHashesPerIteration));
    }
    if (Array.isArray((state as any).strategiesUsedSoFar)) {
      this.strategiesUsedSoFar = [...(state as any).strategiesUsedSoFar];
    }
    if (Array.isArray((state as any).modulesUsedSoFar)) {
      this.modulesUsedSoFar = [...(state as any).modulesUsedSoFar];
    }
    if (Array.isArray((state as any).globalUpdateStrategyHistories)) {
      this.globalUpdateStrategyHistories = [...(state as any).globalUpdateStrategyHistories];
    }
  }

  public syncCheckpointState(iteration?: number, heartbeatNo?: number, sinceHeartbeat?: number): void {
    if (iteration !== undefined) (this.state as any).currentIteration = iteration;
    if (heartbeatNo !== undefined) (this.state as any).heartbeatNo = heartbeatNo;
    if (sinceHeartbeat !== undefined) (this.state as any).sinceHeartbeat = sinceHeartbeat;
    (this.state as any).commitHashesPerIteration = Array.from(this.commitHashesPerIteration.entries());
    (this.state as any).strategiesUsedSoFar = this.strategiesUsedSoFar;
    (this.state as any).modulesUsedSoFar = this.modulesUsedSoFar;
    (this.state as any).globalUpdateStrategyHistories = this.globalUpdateStrategyHistories;
    void this.sharedWorkspace.read().then(content => {
      (this.state as any).sharedWorkspaceContent = content;
    }).catch(() => {});
  }

  public getSharedWorkspace(): SharedWorkspaceManager {
    return this.sharedWorkspace;
  }

  public getGitHarness(): GitRepositoryHarness {
    return this.gitHarness;
  }

  /**
   * Strict JSON parsing helper: extracts code block / JSON payload
   * and parses strictly via standard JSON.parse.
   * If parsing fails, throws immediately (§9). No fallback values or dirty relaxed JSON.
   */
  public parseJsonStrict<T>(raw: string, context?: string): T {
    if (!raw || typeof raw !== 'string') {
      throw new Error(`Cannot parse JSON from empty or invalid raw input${context ? ` in ${context}` : ''}.`);
    }

    if (this.callbacks.parseJsonStrict) {
      return this.callbacks.parseJsonStrict<T>(raw);
    }

    const extracted = extractJsonString(raw);
    try {
      return JSON.parse(extracted) as T;
    } catch (err: any) {
      throw new Error(`Strict JSON parse failed${context ? ` in ${context}` : ''}: ${err?.message || String(err)}`);
    }
  }

  // ==========================================================================
  // Public Execution Entry Point (§1, §3)
  // ==========================================================================

  public async run(): Promise<void> {
    const config = this.state.runConfig;
    const boundsCheck = validateLoopBounds(config.i, config.j, config.k);
    if (!boundsCheck.valid) {
      throw new Error(`Invalid Deepthink loop configuration: ${boundsCheck.error}`);
    }

    this.emitEvent('Orchestrator', 'Initializing Deepthink repository and workspace', 'info');
    await this.gitHarness.initializeRepository(config.strategiesCount);

    // Initialize or restore shared workspace file (§8.1, §8.3)
    const existingShared = (this.state as any).sharedWorkspaceContent;
    if (existingShared) {
      await this.sharedWorkspace.write(existingShared);
    } else {
      await this.sharedWorkspace.write(`# Shared Workspace\nChallenge: ${this.state.challenge}\n`);
    }

    // 1. Initial Strategy Generation + Proximity (§4.1)
    const hasInitialStrategies = Array.isArray(this.state.initialStrategies) &&
      this.state.initialStrategies.length >= config.strategiesCount &&
      this.state.initialStrategies.every(s => typeof s.strategyText === 'string' && s.strategyText.trim().length > 0);

    if (!hasInitialStrategies) {
      await this.runInitialStrategyGeneration();
    } else {
      this.emitEvent('Orchestrator', 'Initial strategies already present; resuming execution loop', 'info');
    }

    // Checkpoint initial window start for window 1 (iterations 1 to j) (§6.3, §8.2)
    for (let slotIdx = 0; slotIdx < this.state.initialStrategies.length; slotIdx++) {
      const commitKey = `${slotIdx}:start_1`;
      if (!this.commitHashesPerIteration.has(commitKey)) {
        const strat = this.state.initialStrategies[slotIdx];
        const contextFiles: DeepthinkResultsContextFile[] = [
          {
            path: `Strategy-${slotIdx + 1}/strategy.md`,
            content: `# Strategy ${slotIdx + 1} (${strat.id})\n\n${strat.strategyText}\n`,
          },
        ];
        const commit = await this.gitHarness.commitWindowStart(slotIdx, 1, contextFiles);
        this.commitHashesPerIteration.set(commitKey, commit);
      }
    }

    let sinceHeartbeat = 0;
    let heartbeatNo = 0;
    const curatedContextEnabled = config.modulesCount > 0;

    // Helper to check if an iteration was fully completed
    const isIterationFullyComplete = (it: number, currentSinceHeartbeat: number): { complete: boolean; nextSinceHeartbeat: number; nextHeartbeatNo: number } => {
      const branches = this.state.initialStrategies || [];
      if (!branches.length) return { complete: false, nextSinceHeartbeat: currentSinceHeartbeat, nextHeartbeatNo: heartbeatNo };
      const allBranchesDone = branches.every(b => {
        const entry = b.iterationHistory?.iterations?.find(e => e.iterationNumber === it);
        if (!entry || !entry.correctedSolution || !entry.critique) return false;
        return true;
      });
      if (!allBranchesDone) return { complete: false, nextSinceHeartbeat: currentSinceHeartbeat, nextHeartbeatNo: heartbeatNo };

      const step = determinePostIterationStep(
        it,
        currentSinceHeartbeat,
        config.i,
        config.j,
        config.k,
        curatedContextEnabled
      );

      let stepDone = true;
      if (step.action.type === 'GLOBAL_UPDATE') {
        const guDone = this.state.bsrRecords?.some(r => r.iteration === it) &&
                       (!curatedContextEnabled || this.state.heartbeats?.some(h => (h as any).iteration === it));
        if (!guDone) stepDone = false;
      } else if (step.action.type === 'HEARTBEAT') {
        const hbDone = !curatedContextEnabled || this.state.heartbeats?.some(h => (h as any).iteration === it);
        if (!hbDone) stepDone = false;
      }

      if (!stepDone) {
        return { complete: false, nextSinceHeartbeat: currentSinceHeartbeat, nextHeartbeatNo: heartbeatNo };
      }

      let nextHbNo = heartbeatNo;
      let nextSince = step.nextSinceHeartbeat;
      if (step.action.type === 'GLOBAL_UPDATE' || step.action.type === 'HEARTBEAT') {
        nextHbNo++;
        nextSince = 0;
      }
      return { complete: true, nextSinceHeartbeat: nextSince, nextHeartbeatNo: nextHbNo };
    };

    // 2. Iteration Loop (§3)
    for (let iteration = 1; iteration <= config.i; iteration++) {
      this.checkStopRequested();

      const completionCheck = isIterationFullyComplete(iteration, sinceHeartbeat);
      if (completionCheck.complete) {
        this.emitEvent('Loop', `Iteration ${iteration} of ${config.i} already completed, advancing`, 'info');
        sinceHeartbeat = completionCheck.nextSinceHeartbeat;
        heartbeatNo = completionCheck.nextHeartbeatNo;
        continue;
      }

      this.syncCheckpointState(iteration, heartbeatNo, sinceHeartbeat);
      this.emitEvent('Loop', `Starting Iteration ${iteration} of ${config.i}`, 'info');

      if (iteration === 1) {
        // Iteration 1: Initial solution attempt + critique in parallel (§3)
        await this.runIterationOne();
      } else {
        // Iterations 2 .. i: Correction + critique in parallel (§3)
        await this.runCorrectionAndCritiqueIteration(iteration, heartbeatNo);
      }

      // Record barrier commits for rollback targets (§8.2)
      await this.commitIterationBarriers(iteration);

      // Post-iteration barrier actions (§3)
      const step = determinePostIterationStep(
        iteration,
        sinceHeartbeat,
        config.i,
        config.j,
        config.k,
        curatedContextEnabled
      );

      sinceHeartbeat = step.nextSinceHeartbeat;

      if (step.action.type === 'FINAL_JUDGE') {
        if (!this.state.finalJudgedBestSolution || this.state.finalJudgingStatus !== 'completed') {
          this.emitEvent('Loop', 'Reached final iteration barrier. Calling Final Judge.', 'info');
          await this.runFinalJudge();
        }
        break;
      } else if (step.action.type === 'GLOBAL_UPDATE') {
        const alreadyDone = this.state.bsrRecords?.some(r => r.iteration === iteration) &&
                            (!curatedContextEnabled || this.state.heartbeats?.some(h => (h as any).iteration === iteration));
        if (!alreadyDone) {
          this.emitEvent('Loop', `Running Global Update at iteration ${iteration}`, 'info');
          heartbeatNo++;
          this.syncCheckpointState(iteration, heartbeatNo, sinceHeartbeat);
          await this.performGlobalUpdate(iteration, heartbeatNo);
          sinceHeartbeat = 0; // GU ends with heartbeat, since_heartbeat resets (§3)
        }
      } else if (step.action.type === 'HEARTBEAT') {
        const alreadyDone = this.state.heartbeats?.some(h => (h as any).iteration === iteration);
        if (!alreadyDone) {
          this.emitEvent('Loop', `Running Curated Context Heartbeat at iteration ${iteration}`, 'info');
          heartbeatNo++;
          this.syncCheckpointState(iteration, heartbeatNo, sinceHeartbeat);
          await this.runCuratedContextHeartbeat(iteration, heartbeatNo);
          sinceHeartbeat = 0; // Heartbeat resets counter (§3)
        }
      }

      this.syncCheckpointState(iteration + 1, heartbeatNo, sinceHeartbeat);
      this.callbacks.onStateChange?.(this.state);
    }

    this.state.status = 'completed';
    this.syncCheckpointState();
    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Strategy Generation (§4.1)
  // ==========================================================================

  private async runInitialStrategyGeneration(): Promise<void> {
    const config = this.state.runConfig;

    this.emitEvent('Orchestrator', 'Starting seed strategy generation', 'info');

    const history: ProximityTurn[] = Array.isArray(this.state.strategyProximityHistory)
      ? [...this.state.strategyProximityHistory]
      : [];

    let currentStrategies: string[] = [];
    const lastGen = history.slice().reverse().find(h => h.role === 'generator');
    if (lastGen) {
      try {
        const parsed = this.parseJsonStrict<{ strategies: string[] }>(lastGen.content, 'Seed Strategy Generator');
        currentStrategies = parsed.strategies.slice(0, config.strategiesCount);
      } catch {}
    }

    const seedContract: OutputValidationContract<{ strategies: string[] }> = {
      name: 'SeedStrategiesContract',
      validate: (parsed) => {
        if (!parsed || !Array.isArray(parsed.strategies)) {
          throw new Error('Seed strategies output must contain a "strategies" array.');
        }
        if (parsed.strategies.length < config.strategiesCount) {
          throw new Error(`Expected at least ${config.strategiesCount} strategies, got ${parsed.strategies.length}.`);
        }
        for (let idx = 0; idx < config.strategiesCount; idx++) {
          if (typeof parsed.strategies[idx] !== 'string' || !parsed.strategies[idx].trim()) {
            throw new Error(`Strategy at index ${idx} is empty or invalid.`);
          }
        }
      },
    };

    const executionGroupId = 'group-seed-strategies';
    const executionGroupName = 'Seed Strategy Proximity Loop';

    const targetProximityReviews = Math.max(0, config.strategyProximityLoops ?? 1);
    const genConversation = createLoopAgentConversation(this.state.id, 'initialStrategy');
    const proxConversation = createLoopAgentConversation(this.state.id, 'strategyProximity');

    for (let reviewIndex = 0; reviewIndex <= targetProximityReviews; reviewIndex++) {
      const turn = reviewIndex + 1;
      this.checkStopRequested();

      const existingGen = history.find(h => h.role === 'generator' && h.turnNumber === turn);
      if (!existingGen) {
        const promptText = buildContextForStrategySeed(
          this.state.challenge,
          config.strategiesCount,
          history
        );

        // Generator turn with contract validation and retry policy (§9)
        let genTrajectoryJsonl = '';
        const genOutput = await this.callAgentModelWithRetry({
          kind: 'initialStrategy',
          promptText,
          stepDescription: `Seed Strategy Generator (Turn ${turn})`,
          jsonResponse: true,
          isCritical: true, // Strategy generation failure halts run (§9)
          contract: seedContract,
          executionGroupId,
          executionGroupName,
          conversation: genConversation,
          onTrajectoryJsonl: (jsonl) => {
            genTrajectoryJsonl = jsonl;
          },
        });

        const parsed = this.parseJsonStrict<{ strategies: string[] }>(genOutput, 'Seed Strategy Generator');
        currentStrategies = parsed.strategies.slice(0, config.strategiesCount);

        if (reviewIndex < targetProximityReviews) {
          appendPeerSubmission(
            proxConversation,
            `### Strategy Generator (Turn ${turn})`,
            genOutput,
            'Strategy Proximity Reviewer'
          );
        }

        history.push({
          role: 'generator',
          content: genOutput,
          timestamp: Date.now(),
          turnNumber: turn,
          trajectoryJsonl: genTrajectoryJsonl,
        } as any);
        this.state.strategyProximityHistory = [...history];
        this.callbacks.onStateChange?.(this.state);
      }

      if (reviewIndex < targetProximityReviews) {
        const existingProx = history.find(h => h.role === 'proximity' && h.turnNumber === turn);
        if (!existingProx) {
          // Proximity review turn receives the exact same full context as the generator (§4.1, §7)
          const proxPrompt = buildContextForStrategySeed(
            this.state.challenge,
            config.strategiesCount,
            history
          );
          let proxTrajectoryJsonl = '';
          const proxOutput = await this.callAgentModelWithRetry({
            kind: 'strategyProximity',
            promptText: proxPrompt,
            stepDescription: `Strategy Proximity Review (Turn ${turn})`,
            isCritical: true,
            executionGroupId,
            executionGroupName,
            conversation: proxConversation,
            onTrajectoryJsonl: (jsonl) => {
              proxTrajectoryJsonl = jsonl;
            },
          });

          appendPeerSubmission(
            genConversation,
            `### Strategy Proximity Reviewer (Turn ${turn})`,
            proxOutput,
            'Strategy Generator'
          );

          history.push({
            role: 'proximity',
            content: proxOutput,
            timestamp: Date.now(),
            turnNumber: turn,
            trajectoryJsonl: proxTrajectoryJsonl,
          } as any);
          this.state.strategyProximityHistory = [...history];
          this.callbacks.onStateChange?.(this.state);
        }
      }
    }

    this.state.strategyProximityHistory = history;

    // Initialize N branches (main1 to mainN) (§1 Invariant 1)
    this.state.initialStrategies = currentStrategies.map((text, idx) => {
      const slotId = `main${idx + 1}`;
      this.strategiesUsedSoFar.push({
        slotId,
        iterationFinalized: 0,
        text,
      });
      return {
        id: slotId,
        strategyText: text,
        strategyTextHistory: [{ iteration: 0, text }],
        status: 'pending',
      };
    });

    for (const strat of this.state.initialStrategies) {
      this.state.branchLedgers[strat.id] = [];
    }

    // Persist strategy generator and proximity review histories into repository (§8.1)
    const seedGenTurns = history.filter(h => h.role === 'generator');
    const seedProxTurns = history.filter(h => h.role === 'proximity');
    const seedGenMarkdown = [
      '# Seed Strategies Generation History',
      ...seedGenTurns.map(h => `### GENERATOR (Turn ${h.turnNumber})\n${h.content}`),
    ].join('\n\n');
    const seedProxMarkdown = [
      '# Seed Strategies Proximity Review History',
      ...seedProxTurns.map(h => `### PROXIMITY (Turn ${h.turnNumber})\n${h.content}`),
    ].join('\n\n');
    const seedGenJsonl = buildLoopRoleTrajectoryJsonl(seedGenTurns as any, !!config.deepthinkCodeExecutionEnabled);
    const seedProxJsonl = buildLoopRoleTrajectoryJsonl(seedProxTurns as any, !!config.deepthinkCodeExecutionEnabled);

    await this.gitHarness.commitStrategyHistory('seed_strategies.md', seedGenMarkdown, seedGenJsonl);
    await this.gitHarness.commitStrategyHistory('seed_strategies_proximity_review.md', seedProxMarkdown, seedProxJsonl);
    await this.updateStrategiesUsedSoFarFile();

    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Iteration 1 (§3)
  // ==========================================================================

  private async runIterationOne(): Promise<void> {
    const branches = this.state.initialStrategies;

    // Run Solution Attempt in parallel across all branches
    await Promise.all(branches.map(async (branch) => {
      this.checkStopRequested();
      if (branch.solutionAttempt && branch.status === 'completed') {
        return;
      }
      branch.status = 'processing';
      this.callbacks.onStateChange?.(this.state);

      const prompt = [
        `# Core Challenge\n${this.state.challenge}`,
        `Assigned Strategy: ${branch.id}\n${branch.strategyText}`,
        'Produce iteration 1 solution attempt.',
      ].join('\n\n');

      try {
        let attemptTrajectoryJsonl = '';
        const attemptOutput = await this.callAgentModelWithRetry({
          kind: 'solutionAttempt',
          promptText: prompt,
          stepDescription: `Solution Attempt for ${branch.id} (Iteration 1)`,
          workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
          isCritical: false, // Non-critical branch work records error (§9)
          executionGroupId: 'group-iter-1-attempt',
          executionGroupName: 'Iteration 1: Initial Solution Attempts (Parallel)',
          onTrajectoryJsonl: (jsonl) => {
            attemptTrajectoryJsonl = jsonl;
          },
        });

        branch.solutionAttempt = attemptOutput;
        branch.solutionAttemptDisplay = attemptOutput;
        branch.refinedSolution = attemptOutput;
        branch.status = 'completed';

        if (!branch.iterationHistory) {
          branch.iterationHistory = { iterations: [], status: 'completed' };
        }
        const existingIdx = branch.iterationHistory.iterations.findIndex(it => it.iterationNumber === 1);
        if (existingIdx >= 0) {
          branch.iterationHistory.iterations[existingIdx].correctedSolution = attemptOutput;
          (branch.iterationHistory.iterations[existingIdx] as any).solutionTrajectoryJsonl = attemptTrajectoryJsonl;
        } else {
          branch.iterationHistory.iterations.push({
            iterationNumber: 1,
            correctedSolution: attemptOutput,
            critique: '',
            timestamp: Date.now(),
            solutionTrajectoryJsonl: attemptTrajectoryJsonl,
          } as any);
        }
      } catch (err: any) {
        if (
          err instanceof PipelineStopRequestedError ||
          err?.name === 'PipelineStopRequestedError' ||
          this.isStopRequested
        ) {
          throw err;
        }
        return this.pausePipelineOnInferenceFailure(err?.message || String(err));
      }
    }));

    // Run Critique in parallel across all branches
    await Promise.all(branches.map(async (branch) => {
      this.checkStopRequested();
      if (branch.solutionCritique && branch.solutionCritiqueStatus === 'completed') {
        return;
      }
      branch.solutionCritiqueStatus = 'processing';
      this.callbacks.onStateChange?.(this.state);

      const windowIterations = (branch.iterationHistory?.iterations || []).filter(
        it => it.iterationNumber === 1
      );
      const historyContext = buildCritiqueCorrectionMemoryBankHistory(branch.memoryBank, windowIterations);
      const critiquePrompt = buildContextForCritiqueAgent(
        this.state.challenge,
        branch.id,
        branch.strategyText,
        historyContext
      );

      try {
        let critiqueTrajectoryJsonl = '';
        const critiqueOutput = await this.callAgentModelWithRetry({
          kind: 'solutionCritique',
          promptText: critiquePrompt,
          stepDescription: `Solution Critique for ${branch.id} (Iteration 1)`,
          workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
          isCritical: false,
          executionGroupId: 'group-iter-1-critique',
          executionGroupName: 'Iteration 1: Solution Critiques (Parallel)',
          onTrajectoryJsonl: (jsonl) => {
            critiqueTrajectoryJsonl = jsonl;
          },
        });

        branch.solutionCritique = critiqueOutput;
        branch.solutionCritiqueDisplay = critiqueOutput;
        branch.solutionCritiqueStatus = 'completed';

        if (!this.state.solutionCritiques) this.state.solutionCritiques = [];
        this.state.solutionCritiques.push({
          id: `critique-${branch.id}-1`,
          mainStrategyId: branch.id,
          globalIteration: 1,
          status: 'completed',
          critiqueResponse: critiqueOutput,
          critiqueResponseDisplay: critiqueOutput,
        });
        this.state.solutionCritiquesStatus = 'completed';

        // Record iteration 1 history
        if (!branch.iterationHistory) {
          branch.iterationHistory = { iterations: [], status: 'completed' };
        }
        const existingCritIdx = branch.iterationHistory.iterations.findIndex(it => it.iterationNumber === 1);
        if (existingCritIdx >= 0) {
          branch.iterationHistory.iterations[existingCritIdx].correctedSolution = branch.solutionAttempt || '';
          branch.iterationHistory.iterations[existingCritIdx].critique = critiqueOutput;
          branch.iterationHistory.iterations[existingCritIdx].timestamp = Date.now();
          (branch.iterationHistory.iterations[existingCritIdx] as any).critiqueTrajectoryJsonl = critiqueTrajectoryJsonl;
        } else {
          branch.iterationHistory.iterations.push({
            iterationNumber: 1,
            correctedSolution: branch.solutionAttempt || '',
            critique: critiqueOutput,
            timestamp: Date.now(),
            critiqueTrajectoryJsonl,
          } as any);
        }
      } catch (err: any) {
        if (
          err instanceof PipelineStopRequestedError ||
          err?.name === 'PipelineStopRequestedError' ||
          this.isStopRequested
        ) {
          throw err;
        }
        return this.pausePipelineOnInferenceFailure(err?.message || String(err));
      }
    }));

    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Iterations 2 .. i: Correction + Critique (§3)
  // ==========================================================================

  private async runCorrectionAndCritiqueIteration(iteration: number, _heartbeatNo: number): Promise<void> {
    const branches = this.state.initialStrategies;
    const config = this.state.runConfig;
    const currentWindowStart = Math.floor((iteration - 1) / config.j) * config.j + 1;

    // Snapshot peer state at the start of the iteration before parallel execution begins
    const peerBranchesSnapshot = branches.map(b => {
      const prevIter = (b.iterationHistory?.iterations || [])
        .filter(it => it.iterationNumber < iteration)
        .slice(-1)[0];
      return {
        ...b,
        refinedSolution: prevIter?.correctedSolution || b.refinedSolution || b.solutionAttempt,
        solutionCritique: prevIter?.critique || b.solutionCritique,
      };
    });

    // Run Correction in parallel
    await Promise.all(branches.map(async (branch) => {
      this.checkStopRequested();
      const existingIteration = branch.iterationHistory?.iterations?.find(it => it.iterationNumber === iteration);
      if (existingIteration && existingIteration.correctedSolution) {
        return;
      }
      branch.correctionStatus = 'processing';
      this.callbacks.onStateChange?.(this.state);

      const allBranchIterations = branch.iterationHistory?.iterations || [];
      const preUpdateIteration = currentWindowStart > 1
        ? allBranchIterations.filter(it => it.iterationNumber < currentWindowStart).slice(-1)[0]
        : undefined;
      const windowIterations = allBranchIterations.filter(
        it => it.iterationNumber >= currentWindowStart && it.iterationNumber < iteration
      );
      const historyContext = buildCritiqueCorrectionMemoryBankHistory(
        branch.memoryBank,
        windowIterations,
        preUpdateIteration
      );

      const peerCorrectionContext = buildCrossStrategyLatestCorrectionCritique(
        branch.id,
        peerBranchesSnapshot,
        config.isolateBranches
      );

      // Latest curated context packet from most recent heartbeat
      const latestHeartbeat = this.state.heartbeats[this.state.heartbeats.length - 1];
      const mappedPacket = latestHeartbeat
        ? latestHeartbeat.modules
            .filter(m => !m.targetBranchIds || m.targetBranchIds.length === 0 || m.targetBranchIds.includes(branch.id))
            .map(m => `Module ${m.id}: ${m.moduleText}\nTesting of that Module:\n${m.testerAttempt}`)
            .join('\n\n')
        : null;

      const correctionPrompt = buildContextForCorrectionAgent(this.state.challenge, 
        branch.id,
        branch.strategyText,
        historyContext,
        mappedPacket,
        peerCorrectionContext
      );

      try {
        let correctionTrajectoryJsonl = '';
        const correctedOutput = await this.callAgentModelWithRetry({
          kind: 'solutionCorrection',
          promptText: correctionPrompt,
          stepDescription: `Solution Correction for ${branch.id} (Iteration ${iteration})`,
          workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
          isCritical: false,
          executionGroupId: `group-iter-${iteration}-correction`,
          executionGroupName: `Iteration ${iteration}: Branch Corrections (Parallel)`,
          onTrajectoryJsonl: (jsonl) => {
            correctionTrajectoryJsonl = jsonl;
          },
        });

        branch.refinedSolution = correctedOutput;
        branch.refinedSolutionDisplay = correctedOutput;
        branch.correctionStatus = 'completed';

        if (!branch.iterationHistory) {
          branch.iterationHistory = { iterations: [], status: 'completed' };
        }
        const existingIdx = branch.iterationHistory.iterations.findIndex(it => it.iterationNumber === iteration);
        if (existingIdx >= 0) {
          branch.iterationHistory.iterations[existingIdx].correctedSolution = correctedOutput;
          branch.iterationHistory.iterations[existingIdx].timestamp = Date.now();
          (branch.iterationHistory.iterations[existingIdx] as any).solutionTrajectoryJsonl = correctionTrajectoryJsonl;
        } else {
          branch.iterationHistory.iterations.push({
            iterationNumber: iteration,
            correctedSolution: correctedOutput,
            critique: '',
            timestamp: Date.now(),
            solutionTrajectoryJsonl: correctionTrajectoryJsonl,
          } as any);
        }
      } catch (err: any) {
        if (
          err instanceof PipelineStopRequestedError ||
          err?.name === 'PipelineStopRequestedError' ||
          this.isStopRequested
        ) {
          throw err;
        }
        return this.pausePipelineOnInferenceFailure(err?.message || String(err));
      }
    }));

    // Run Critique in parallel
    await Promise.all(branches.map(async (branch) => {
      this.checkStopRequested();
      const existingIteration = branch.iterationHistory?.iterations?.find(it => it.iterationNumber === iteration);
      if (existingIteration && existingIteration.critique) {
        return;
      }
      branch.solutionCritiqueStatus = 'processing';
      this.callbacks.onStateChange?.(this.state);

      const allBranchIterations = branch.iterationHistory?.iterations || [];
      const preUpdateIteration = currentWindowStart > 1
        ? allBranchIterations.filter(it => it.iterationNumber < currentWindowStart).slice(-1)[0]
        : undefined;
      const windowIterations = allBranchIterations.filter(
        it => it.iterationNumber >= currentWindowStart && it.iterationNumber <= iteration
      );
      const historyContext = buildCritiqueCorrectionMemoryBankHistory(
        branch.memoryBank,
        windowIterations,
        preUpdateIteration
      );

      const critiquePrompt = buildContextForCritiqueAgent(
        this.state.challenge,
        branch.id,
        branch.strategyText,
        historyContext
      );

      try {
        let critiqueTrajectoryJsonl = '';
        const critiqueOutput = await this.callAgentModelWithRetry({
          kind: 'solutionCritique',
          promptText: critiquePrompt,
          stepDescription: `Solution Critique for ${branch.id} (Iteration ${iteration})`,
          workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
          isCritical: false,
          executionGroupId: `group-iter-${iteration}-critique`,
          executionGroupName: `Iteration ${iteration}: Branch Critiques (Parallel)`,
          onTrajectoryJsonl: (jsonl) => {
            critiqueTrajectoryJsonl = jsonl;
          },
        });

        branch.solutionCritique = critiqueOutput;
        branch.solutionCritiqueDisplay = critiqueOutput;
        branch.solutionCritiqueStatus = 'completed';

        if (!this.state.solutionCritiques) this.state.solutionCritiques = [];
        this.state.solutionCritiques.push({
          id: `critique-${branch.id}-${iteration}`,
          mainStrategyId: branch.id,
          globalIteration: iteration,
          status: 'completed',
          critiqueResponse: critiqueOutput,
          critiqueResponseDisplay: critiqueOutput,
        });
        this.state.solutionCritiquesStatus = 'completed';

        // Append or update iteration history
        if (!branch.iterationHistory) {
          branch.iterationHistory = { iterations: [], status: 'completed' };
        }
        const existingIdx = branch.iterationHistory.iterations.findIndex(it => it.iterationNumber === iteration);
        if (existingIdx >= 0) {
          branch.iterationHistory.iterations[existingIdx].correctedSolution = branch.refinedSolution || '';
          branch.iterationHistory.iterations[existingIdx].critique = critiqueOutput;
          branch.iterationHistory.iterations[existingIdx].timestamp = Date.now();
          (branch.iterationHistory.iterations[existingIdx] as any).critiqueTrajectoryJsonl = critiqueTrajectoryJsonl;
        } else {
          branch.iterationHistory.iterations.push({
            iterationNumber: iteration,
            correctedSolution: branch.refinedSolution || '',
            critique: critiqueOutput,
            timestamp: Date.now(),
            critiqueTrajectoryJsonl,
          } as any);
        }
      } catch (err: any) {
        if (
          err instanceof PipelineStopRequestedError ||
          err?.name === 'PipelineStopRequestedError' ||
          this.isStopRequested
        ) {
          throw err;
        }
        return this.pausePipelineOnInferenceFailure(err?.message || String(err));
      }
    }));

    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Curated Context Heartbeat (§4.5)
  // ==========================================================================

  public async runCuratedContextHeartbeat(
    iteration: number,
    heartbeatNo: number,
    reusedDos?: DosOutput,
    reusedDosFilePath?: string
  ): Promise<void> {
    const config = this.state.runConfig;
    if (config.modulesCount === 0) {
      return; // Curated context disabled (§3, §4.5)
    }

    const previousHeartbeat = this.state.heartbeats[this.state.heartbeats.length - 1];
    const currentDosFilePath = reusedDosFilePath || `DOS_history/DOS_heartbeat_${String(heartbeatNo).padStart(2, '0')}.md`;

    // 1. DOS (if modules are enabled)
    let dosOutput = reusedDos;
    if (!dosOutput && config.modulesCount > 0) {
      const existingDos = this.state.dosOutputs?.find(
        d => d.callType === 'heartbeat' && d.iteration === iteration
      );
      if (existingDos) {
        dosOutput = existingDos.output;
      }
    }
    if (!dosOutput && config.modulesCount > 0) {
      const activeState = this.state.initialStrategies.map(s => ({
        branchId: s.id,
        strategyText: s.strategyText,
        latestCorrection: s.refinedSolution || s.solutionAttempt || 'None',
        latestCritique: s.solutionCritique || 'None',
      }));

      const dosContract: OutputValidationContract<DosOutput> = {
        name: 'HeartbeatDosContract',
        validate: (parsed) => {
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('Heartbeat DOS output must be an object.');
          }
        },
      };

      const dosPrompt = buildContextForDos(this.state.challenge, 'heartbeat', activeState, { previousHeartbeat });
      let dosTrajectoryJsonl = '';
      const rawDos = await this.callAgentModelWithRetry({
        kind: 'dos',
        promptText: dosPrompt,
        stepDescription: `Heartbeat DOS (Heartbeat ${heartbeatNo})`,
        jsonResponse: true,
        isCritical: true,
        contract: dosContract,
        executionGroupId: `group-heartbeat-${heartbeatNo}-dos`,
        executionGroupName: `Heartbeat ${heartbeatNo}: DOS Synthesis`,
        onTrajectoryJsonl: (jsonl) => {
          dosTrajectoryJsonl = jsonl;
        },
      });

      dosOutput = this.parseJsonStrict<DosOutput>(rawDos, `Heartbeat DOS (Heartbeat ${heartbeatNo})`);
      this.state.dosOutputs.push({ callType: 'heartbeat', iteration, output: dosOutput });

      // Save DOS output and trajectory to repository (§8.1, §12.13)
      await this.gitHarness.writeFilesAndCommit(
        `Heartbeat ${heartbeatNo} DOS output`,
        [
          {
            path: currentDosFilePath,
            content: `# DOS Heartbeat ${heartbeatNo} Output\n\n\`\`\`json\n${JSON.stringify(dosOutput, null, 2)}\n\`\`\``,
          },
          {
            path: `DOS_history/DOS_heartbeat_${String(heartbeatNo).padStart(2, '0')}.jsonl`,
            content: dosTrajectoryJsonl,
          },
        ]
      );

      // Process and attach realized module feedback for the previous heartbeat (§5.1, §5.4)
      if (dosOutput.module_feedback && previousHeartbeat) {
        await this.attachRealizedDosFeedback(dosOutput.module_feedback, previousHeartbeat.heartbeat_no);
      }
    }

    // 2. Generate Modules + Impact Review (§4.2)
    const newModules: DeepthinkModuleData[] = [];
    const realizedFeedback: RealizedModuleFeedback[] = [];
    const heartbeatFiles: DeepthinkResultsContextFile[] = [];

    if (config.modulesCount > 0) {
      let parsedGen: {
        modules: Array<{
          module_id: string;
          text: string;
          target_branches: string[];
        }>;
      } = { modules: [] };

      const modContract: OutputValidationContract<{ modules: Array<{ module_id: string; text: string }> }> = {
        name: 'ModulesGenerationContract',
        validate: (parsed) => {
          if (!parsed || !Array.isArray(parsed.modules)) {
            throw new Error('Modules output must contain a "modules" array.');
          }
          for (const m of parsed.modules) {
            if (!m.module_id || !m.text) throw new Error('Module missing id or text.');
          }
        },
      };

      // Assemble reframed historical modules impact review transcript across prior heartbeats 1..heartbeatNo-1 (§7)
      const priorHeartbeatEntries: Array<{
        heartbeatNo: number;
        dosFilePath?: string;
        turns: ProximityTurn[];
      }> = [];
      for (let m = 1; m < heartbeatNo; m++) {
        const hbBlock = this.state.heartbeats.find(h => h.heartbeat_no === m);
        const defaultDosPath = hbBlock && hbBlock.iteration % config.j === 0
          ? `DOS_history/DOS_global_update_${String(Math.round(hbBlock.iteration / config.j)).padStart(2, '0')}_step_ii.md`
          : `DOS_history/DOS_heartbeat_${String(m).padStart(2, '0')}.md`;
        const turnsForHb = Array.isArray(this.state.modulesImpactReviewHistory)
          ? this.state.modulesImpactReviewHistory.filter(h => (h as any).roundNumber === m)
          : [];
        if (turnsForHb.length > 0) {
          priorHeartbeatEntries.push({
            heartbeatNo: m,
            dosFilePath: hbBlock?.dosFilePath || defaultDosPath,
            turns: turnsForHb,
          });
        }
      }
      const priorModImpactReviewHistory = buildModulesImpactReviewHistoryWithNotes(priorHeartbeatEntries);

      const modHistory: ProximityTurn[] = Array.isArray(this.state.modulesImpactReviewHistory)
        ? this.state.modulesImpactReviewHistory.filter(h => (h as any).roundNumber === heartbeatNo)
        : [];

      const targetModImpactReviews = Math.max(0, config.modulesImpactReviewLoops ?? 1);
      const modGenConversation = createLoopAgentConversation(this.state.id, 'modulesGeneration');
      const modProxConversation = createLoopAgentConversation(this.state.id, 'modulesImpactReview');

      for (let reviewIndex = 0; reviewIndex <= targetModImpactReviews; reviewIndex++) {
        const turn = reviewIndex + 1;
        this.checkStopRequested();

        let rawModGen: string;
        const existingGen = modHistory.find(h => h.role === 'generator' && h.turnNumber === turn);
        if (existingGen) {
          rawModGen = existingGen.content;
        } else {
          const modContext = buildContextForModulesGenerate(
            this.state.challenge,
            heartbeatNo,
            this.state.initialStrategies,
            dosOutput,
            previousHeartbeat,
            priorModImpactReviewHistory,
            modHistory,
            config.modulesCount,
            this.modulesUsedSoFar
          );

          let modGenTrajectoryJsonl = '';
          rawModGen = await this.callAgentModelWithRetry({
            kind: 'modulesGeneration',
            promptText: modContext,
            stepDescription: `Modules Generator (Heartbeat ${heartbeatNo}, Turn ${turn})`,
            jsonResponse: true,
            isCritical: true,
            contract: modContract,
            executionGroupId: `group-heartbeat-${heartbeatNo}-modules`,
            executionGroupName: `Heartbeat ${heartbeatNo}: Modules Generator & Impact Review Loop`,
            conversation: modGenConversation,
            onTrajectoryJsonl: (jsonl) => {
              modGenTrajectoryJsonl = jsonl;
            },
          });

          if (reviewIndex < targetModImpactReviews) {
            appendPeerSubmission(
              modProxConversation,
              `### Modules Generator (Turn ${turn})`,
              rawModGen,
              'Modules Impact Reviewer'
            );
          }

          modHistory.push({
            role: 'generator',
            content: rawModGen,
            timestamp: Date.now(),
            turnNumber: turn,
            roundNumber: heartbeatNo,
            trajectoryJsonl: modGenTrajectoryJsonl,
          } as any);

          this.state.modulesImpactReviewHistory = [
            ...(this.state.modulesImpactReviewHistory || []).filter(h => (h as any).roundNumber !== heartbeatNo),
            ...modHistory,
          ];
          this.callbacks.onStateChange?.(this.state);
        }

        parsedGen = this.parseJsonStrict<{
          modules: Array<{
            module_id: string;
            text: string;
            target_branches: string[];
          }>;
        }>(rawModGen, `Modules Generator (Heartbeat ${heartbeatNo}, Turn ${turn})`);

        if (reviewIndex < targetModImpactReviews) {
          const existingProx = modHistory.find(h => h.role === 'proximity' && h.turnNumber === turn);
          if (existingProx) {
            // Already completed impact review for this turn
          } else {
            // Impact review turn receives the exact same full context as the generator (§4.2, §7)
            const proxPrompt = buildContextForModulesGenerate(
              this.state.challenge,
              heartbeatNo,
              this.state.initialStrategies,
              dosOutput,
              previousHeartbeat,
              priorModImpactReviewHistory,
              modHistory,
              config.modulesCount,
              this.modulesUsedSoFar
            );

            let modProxTrajectoryJsonl = '';
            const proxOutput = await this.callAgentModelWithRetry({
              kind: 'modulesImpactReview',
              promptText: proxPrompt,
              stepDescription: `Modules Impact Reviewer (Heartbeat ${heartbeatNo}, Turn ${turn})`,
              isCritical: true,
              executionGroupId: `group-heartbeat-${heartbeatNo}-modules`,
              executionGroupName: `Heartbeat ${heartbeatNo}: Modules Generator & Impact Review Loop`,
              conversation: modProxConversation,
              onTrajectoryJsonl: (jsonl) => {
                modProxTrajectoryJsonl = jsonl;
              },
            });

            appendPeerSubmission(
              modGenConversation,
              `### Modules Impact Reviewer (Turn ${turn})`,
              proxOutput,
              'Modules Generator'
            );

            modHistory.push({
              role: 'proximity',
              content: proxOutput,
              timestamp: Date.now(),
              turnNumber: turn,
              roundNumber: heartbeatNo,
              trajectoryJsonl: modProxTrajectoryJsonl,
            } as any);

            this.state.modulesImpactReviewHistory = [
              ...(this.state.modulesImpactReviewHistory || []).filter(h => (h as any).roundNumber !== heartbeatNo),
              ...modHistory,
            ];
            this.callbacks.onStateChange?.(this.state);
          }
        }
      }

      this.state.modulesImpactReviewHistory = [
        ...(this.state.modulesImpactReviewHistory || []).filter(h => (h as any).roundNumber !== heartbeatNo),
        ...modHistory,
      ];

      for (const modItem of parsedGen.modules.slice(0, config.modulesCount)) {
        this.modulesUsedSoFar.push({
          heartbeatNo,
          iterationFinalized: iteration,
          moduleId: modItem.module_id,
          text: modItem.text,
        });
      }
      (this.state as any).modulesUsedSoFar = this.modulesUsedSoFar;

      const modUsedMarkdown = [
        '# Modules Finalized and Used So Far',
        ...this.modulesUsedSoFar.map(
          m => `## Heartbeat ${m.heartbeatNo} — ${m.moduleId} (Iteration ${m.iterationFinalized})\n${m.text}`
        ),
      ].join('\n\n');

      // Save generator & impact reviewer histories into repository (§8.1) along with their continuous .jsonl trajectories
      const modGenTurns = modHistory.filter(h => h.role === 'generator');
      const modProxTurns = modHistory.filter(h => h.role === 'proximity');
      const modGenHistoryMarkdown = [
        `# Modules Generator History (Heartbeat ${heartbeatNo})`,
        ...modGenTurns.map(h => `### GENERATOR (Turn ${h.turnNumber ?? 1})\n${h.content}`),
      ].join('\n\n');
      const modProxHistoryMarkdown = [
        `# Modules Impact Review History (Heartbeat ${heartbeatNo})`,
        ...modProxTurns.map(h => `### PROXIMITY (Turn ${h.turnNumber ?? 1})\n${h.content}`),
      ].join('\n\n');
      const genOnlyTrajectoriesJsonl = buildLoopRoleTrajectoryJsonl(
        modGenTurns as any,
        !!config.deepthinkCodeExecutionEnabled
      );
      const proxOnlyTrajectoriesJsonl = buildLoopRoleTrajectoryJsonl(
        modProxTurns as any,
        !!config.deepthinkCodeExecutionEnabled
      );

      heartbeatFiles.push(
        {
          path: `Modules/modules_finalized_and_used_so_far.md`,
          content: modUsedMarkdown,
        },
        {
          path: `Modules/Heartbeat-${heartbeatNo}/generation_history.md`,
          content: modGenHistoryMarkdown,
        },
        {
          path: `Modules/Heartbeat-${heartbeatNo}/generation_history.jsonl`,
          content: genOnlyTrajectoriesJsonl,
        },
        {
          path: `Modules/Heartbeat-${heartbeatNo}/modules_impact_review_history_heartbeat_${String(heartbeatNo).padStart(2, '0')}.md`,
          content: modProxHistoryMarkdown,
        },
        {
          path: `Modules/Heartbeat-${heartbeatNo}/modules_impact_review_history_heartbeat_${String(heartbeatNo).padStart(2, '0')}.jsonl`,
          content: proxOnlyTrajectoriesJsonl,
        }
      );

      // 3. Test Modules in parallel (§4.3)
      await Promise.all(parsedGen.modules.slice(0, config.modulesCount).map(async (modItem, idx) => {
        this.checkStopRequested();

        const testerPrompt = [
          `# Core Challenge\n${this.state.challenge}`,
          `Assigned Module ${modItem.module_id}:\n${modItem.text}`,
          'Test this module within your assigned folder.',
        ].join('\n\n');

        const folderIndex = idx + 1;
        let testerTrajectoryJsonl = '';
        const testResult = await this.callAgentModelWithRetry({
          kind: 'modulesTester',
          promptText: testerPrompt,
          stepDescription: `Modules Tester for ${modItem.module_id}`,
          workingDirectory: `Modules/Heartbeat-${heartbeatNo}/Module-${folderIndex}`,
          isCritical: false,
          executionGroupId: `group-heartbeat-${heartbeatNo}-testing`,
          executionGroupName: `Heartbeat ${heartbeatNo}: Independent Modules Testers (Parallel)`,
          onTrajectoryJsonl: (jsonl) => {
            testerTrajectoryJsonl = jsonl;
          },
        });

        // Parse verdict classification line (§4.3)
        let verdict: 'VALIDATED' | 'REJECTED' | 'INCONCLUSIVE' = 'INCONCLUSIVE';
        if (testResult.includes('CLASSIFICATION: VALIDATED')) verdict = 'VALIDATED';
        else if (testResult.includes('CLASSIFICATION: REFUTED') || testResult.includes('CLASSIFICATION: REJECTED')) verdict = 'REJECTED';
        else if (testResult.includes('CLASSIFICATION: INCONCLUSIVE')) verdict = 'INCONCLUSIVE';

        const modData: DeepthinkModuleData = {
          id: modItem.module_id,
          moduleText: modItem.text,
          targetBranchIds: modItem.target_branches,
          testerAttempt: testResult,
          testerStatus: 'completed',
          testerVerdict: verdict,
          roundNumber: heartbeatNo,
          globalIteration: iteration,
        };

        newModules.push(modData);

        // Record module file and .jsonl trajectory in repository (§8.1)
        heartbeatFiles.push(
          {
            path: `Modules/Heartbeat-${heartbeatNo}/Module-${folderIndex}/module.md`,
            content: [
              `# Module ${modItem.module_id}`,
              `**Claim**: ${modItem.text}`,
              `**Target Branches**: ${modItem.target_branches?.join(', ') || 'Global'}`,
              `**Verdict**: ${verdict}`,
              `\n## Tester Execution & Output\n${testResult}`,
            ].join('\n\n'),
          },
          {
            path: `Modules/Heartbeat-${heartbeatNo}/Module-${folderIndex}/module.jsonl`,
            content: testerTrajectoryJsonl,
          }
        );

        realizedFeedback.push({
          module_id: modItem.module_id,
          observed_test_outcome: verdict,
        });
      }));
    }

    // Record heartbeat block
    const heartbeatBlock: HeartbeatBlock = {
      heartbeat_no: heartbeatNo,
      iteration,
      dosFilePath: currentDosFilePath,
      modules: newModules,
      realized_feedback: realizedFeedback,
    };
    this.state.heartbeats.push(heartbeatBlock);
    this.state.modules = newModules;

    // Commit heartbeat artifacts to repository (§8.2)
    await this.gitHarness.commitHeartbeat(heartbeatNo, heartbeatFiles);
    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Perform Global Update (§4.6)
  // ==========================================================================

  public async performGlobalUpdate(iteration: number, heartbeatNo: number): Promise<void> {
    const config = this.state.runConfig;
    const windowStart = iteration - config.j + 1;
    const updateNumber = Math.round(iteration / config.j);

    this.emitEvent('GlobalUpdate', `Step i: Running Step-i DOS and BSR across branches`, 'info');

    // i. Step-i DOS and BSR in parallel (§4.6 i)
    const activeBranchesState = this.state.initialStrategies.map(s => ({
      branchId: s.id,
      strategyText: s.strategyText,
      latestCorrection: s.refinedSolution || s.solutionAttempt || 'None',
      latestCritique: s.solutionCritique || 'None',
    }));

    const stepIDosContract: OutputValidationContract<DosOutput> = {
      name: 'StepIDosContract',
      validate: (parsed) => {
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Step-i DOS response must be an object.');
        }
      },
    };

    const stepIDosPrompt = buildContextForDos(this.state.challenge, 'step_i', activeBranchesState);
    let stepIDosTrajectoryJsonl = '';
    const stepIDosPromise = this.callAgentModelWithRetry({
      kind: 'dos',
      promptText: stepIDosPrompt,
      stepDescription: `Step-i DOS (Global Update ${updateNumber})`,
      jsonResponse: true,
      isCritical: true,
      contract: stepIDosContract,
      executionGroupId: `group-global-update-${updateNumber}-step-i`,
      executionGroupName: `Global Update ${updateNumber}: Step-i DOS & BSR Evaluation (Parallel)`,
      onTrajectoryJsonl: (jsonl) => {
        stepIDosTrajectoryJsonl = jsonl;
      },
    });

    const bsrReportsPromise = Promise.all(this.state.initialStrategies.map(async (branch) => {
      const windowHistory = branch.iterationHistory?.iterations.filter(
        it => it.iterationNumber >= windowStart && it.iterationNumber <= iteration
      ) || [];

      const formattedWindow = windowHistory.map(it => (
        `Iteration ${it.iterationNumber}:\nCorrection: ${it.correctedSolution}\nCritique: ${it.critique}`
      )).join('\n\n');

      const ledger = this.state.branchLedgers[branch.id] || [];

      const bsrPrompt = buildContextForBsr(this.state.challenge, 
        branch.id,
        branch.strategyText,
        formattedWindow,
        branch.memoryBank,
        ledger
      );

      const bsrContract: OutputValidationContract<BsrReport> = {
        name: 'BsrReportContract',
        validate: (parsed) => {
          if (!parsed || parsed.branch_id !== branch.id) {
            throw new Error(`BSR report branch_id mismatch or missing: expected ${branch.id}`);
          }
          if (!Array.isArray(parsed.confirmed_progress) || !Array.isArray(parsed.confirmed_regression)) {
            throw new Error('BSR report missing progress/regression events arrays.');
          }
        },
      };

      const rawBsr = await this.callAgentModelWithRetry({
        kind: 'bsr',
        promptText: bsrPrompt,
        stepDescription: `BSR for ${branch.id} (Global Update ${updateNumber})`,
        workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
        jsonResponse: true,
        isCritical: true,
        contract: bsrContract,
        executionGroupId: `group-global-update-${updateNumber}-step-i`,
        executionGroupName: `Global Update ${updateNumber}: Step-i DOS & BSR Evaluation (Parallel)`,
      });

      return this.parseJsonStrict<BsrReport>(rawBsr, `BSR for ${branch.id}`);
    }));

    const [rawStepIDos, bsrReports] = await Promise.all([stepIDosPromise, bsrReportsPromise]);
    const stepIDosOutput = this.parseJsonStrict<DosOutput>(rawStepIDos, `Step-i DOS (Global Update ${updateNumber})`);
    this.state.dosOutputs.push({ callType: 'step_i', iteration, output: stepIDosOutput });

    // Persist Step-i DOS and trajectory in repository (§8.1, §12.13)
    await this.gitHarness.writeFilesAndCommit(
      `Step-i DOS for Global Update ${updateNumber}`,
      [
        {
          path: `DOS_history/DOS_global_update_${String(updateNumber).padStart(2, '0')}_step_i.md`,
          content: `# Step-i DOS Output (Global Update ${updateNumber})\n\n\`\`\`json\n${JSON.stringify(stepIDosOutput, null, 2)}\n\`\`\``,
        },
        {
          path: `DOS_history/DOS_global_update_${String(updateNumber).padStart(2, '0')}_step_i.jsonl`,
          content: stepIDosTrajectoryJsonl,
        },
      ]
    );

    // ii. Deterministic Code Computes Decisions (§4.6 ii, §6.3, §6.5)
    const evaluatedRecords: Array<{ report: BsrReport; computed: BsrComputedScores }> = [];
    const consolidatedDecisions: Array<{
      slotId: string;
      decision: BsrAction;
      form?: BsrEvolveForm;
      rollbackTo?: number | 'window_start';
      eventReasons: string[];
    }> = [];

    const runConfigWeights = {
      small: this.state.runConfig?.bsrWeightSmall ?? SIZE_WEIGHTS.small,
      medium: this.state.runConfig?.bsrWeightMedium ?? SIZE_WEIGHTS.medium,
      large: this.state.runConfig?.bsrWeightLarge ?? SIZE_WEIGHTS.large,
    };
    const bsrOptions: BsrConfigOptions = {
      tau: this.state.runConfig?.bsrNoiseLevel ?? TAU,
      theta: this.state.runConfig?.bsrPressureFloor ?? THETA,
      weights: runConfigWeights,
    };

    for (const report of bsrReports) {
      const ledger = this.state.branchLedgers[report.branch_id] || [];

      const computed = evaluateBranchState(
        report,
        windowStart,
        iteration,
        ledger,
        bsrOptions
      );

      evaluatedRecords.push({ report, computed });

      const allEventReasons = [
        ...report.confirmed_progress.map(e => `Progress (${e.size}): ${e.reason}`),
        ...report.confirmed_regression.map(e => `Regression (${e.size}): ${e.reason}`),
      ];

      consolidatedDecisions.push({
        slotId: report.branch_id,
        decision: computed.decision,
        form: computed.form,
        rollbackTo: computed.rollback_to,
        eventReasons: allEventReasons,
      });

      this.state.bsrRecords.push({
        updateNumber,
        iteration,
        branch_id: report.branch_id,
        report,
        computed,
      });
    }

    // iii. Strategy Generation for Changed Slots Only (§4.6 iii, §4.1)
    const changedSlots = consolidatedDecisions.filter(d => d.decision !== 'CONTINUE');
    if (changedSlots.length > 0) {
      const priorProximityHistory = buildStrategyProximityHistoryWithNotes(
        this.state.strategyProximityHistory || [],
        this.globalUpdateStrategyHistories,
        config.j
      );

      const evolveSlotIds = consolidatedDecisions.filter(d => d.decision === 'EVOLVE').map(d => d.slotId);
      const pruneSlotIds = consolidatedDecisions.filter(d => d.decision === 'PRUNE').map(d => d.slotId);

      const stratUpdateContract: OutputValidationContract<{
        evolved_slots?: Array<{ slot_id: string; updated_strategy_text: string }>;
        pruned_slots?: Array<{ slot_id: string; new_strategy_text: string }>;
      }> = {
        name: 'SurgicalGlobalUpdateStrategyContract',
        validate: (parsed) => {
          if (!parsed) throw new Error('Empty surgical strategy update.');
          const evolved = parsed.evolved_slots || [];
          const pruned = parsed.pruned_slots || [];

          for (const evId of evolveSlotIds) {
            if (!evolved.some(e => e.slot_id === evId && e.updated_strategy_text?.trim())) {
              throw new Error(`Missing required updated strategy for EVOLVE slot ${evId}.`);
            }
          }
          for (const prId of pruneSlotIds) {
            if (!pruned.some(p => p.slot_id === prId && p.new_strategy_text?.trim())) {
              throw new Error(`Missing required new strategy for PRUNE slot ${prId}.`);
            }
          }
          // Enforce: CONTINUE slots must not be present (§4.1, §4.6)
          const allTouched = [...evolved.map(e => e.slot_id), ...pruned.map(p => p.slot_id)];
          for (const id of allTouched) {
            if (!evolveSlotIds.includes(id) && !pruneSlotIds.includes(id)) {
              throw new Error(`Surgical update contained unexpected slot ID ${id}. CONTINUE slots cannot be modified.`);
            }
          }
        },
      };

      const existingGuHistory = this.globalUpdateStrategyHistories.find(h => h.updateNumber === updateNumber);
      const currentGuTurns: ProximityTurn[] = existingGuHistory ? [...existingGuHistory.turns] : [];
      let parsedStrat: {
        evolved_slots?: Array<{ slot_id: string; updated_strategy_text: string }>;
        pruned_slots?: Array<{ slot_id: string; new_strategy_text: string }>;
      } = {};

      const targetGuProximityReviews = Math.max(0, config.strategyProximityLoops ?? 1);
      const guGenConversation = createLoopAgentConversation(this.state.id, 'initialStrategy');
      const guProxConversation = createLoopAgentConversation(this.state.id, 'strategyProximity');

      for (let reviewIndex = 0; reviewIndex <= targetGuProximityReviews; reviewIndex++) {
        const turn = reviewIndex + 1;
        this.checkStopRequested();

        let rawStratUpdate: string;
        const existingGen = currentGuTurns.find(t => t.role === 'generator' && t.turnNumber === turn);
        if (existingGen) {
          rawStratUpdate = existingGen.content;
        } else {
          const stratPrompt = buildContextForStrategyGlobalUpdate(
            this.state.challenge,
            updateNumber,
            config.j,
            this.state.initialStrategies,
            consolidatedDecisions,
            stepIDosOutput,
            this.strategiesUsedSoFar,
            priorProximityHistory,
            currentGuTurns,
            config.strategiesCount
          );

          let guGenTrajectoryJsonl = '';
          rawStratUpdate = await this.callAgentModelWithRetry({
            kind: 'initialStrategy',
            promptText: stratPrompt,
            stepDescription: `Strategy Generator Update (Global Update ${updateNumber}, Turn ${turn})`,
            jsonResponse: true,
            isCritical: true,
            contract: stratUpdateContract,
            executionGroupId: `group-global-update-${updateNumber}-strategies`,
            executionGroupName: `Global Update ${updateNumber}: Strategy Revision Loop`,
            conversation: guGenConversation,
            onTrajectoryJsonl: (jsonl) => {
              guGenTrajectoryJsonl = jsonl;
            },
          });

          if (reviewIndex < targetGuProximityReviews) {
            appendPeerSubmission(
              guProxConversation,
              `### Strategy Generator (Turn ${turn})`,
              rawStratUpdate,
              'Strategy Proximity Reviewer'
            );
          }

          currentGuTurns.push({
            role: 'generator',
            content: rawStratUpdate,
            timestamp: Date.now(),
            turnNumber: turn,
            trajectoryJsonl: guGenTrajectoryJsonl,
          } as any);

          const histIdx = this.globalUpdateStrategyHistories.findIndex(h => h.updateNumber === updateNumber);
          if (histIdx >= 0) {
            this.globalUpdateStrategyHistories[histIdx].turns = [...currentGuTurns];
          } else {
            this.globalUpdateStrategyHistories.push({ updateNumber, turns: [...currentGuTurns] });
          }
          (this.state as any).globalUpdateStrategyHistories = this.globalUpdateStrategyHistories;
          this.callbacks.onStateChange?.(this.state);
        }

        parsedStrat = this.parseJsonStrict<{
          evolved_slots?: Array<{ slot_id: string; updated_strategy_text: string }>;
          pruned_slots?: Array<{ slot_id: string; new_strategy_text: string }>;
        }>(rawStratUpdate, `Strategy Generator Update (Global Update ${updateNumber}, Turn ${turn})`);

        if (reviewIndex < targetGuProximityReviews) {
          const existingProx = currentGuTurns.find(t => t.role === 'proximity' && t.turnNumber === turn);
          if (existingProx) {
            // Already completed proximity review for this turn
          } else {
            // Proximity review turn receives the exact same full context as the generator (§4.1, §7)
            const proxPrompt = buildContextForStrategyGlobalUpdate(
              this.state.challenge,
              updateNumber,
              config.j,
              this.state.initialStrategies,
              consolidatedDecisions,
              stepIDosOutput,
              this.strategiesUsedSoFar,
              priorProximityHistory,
              currentGuTurns,
              config.strategiesCount
            );

            let guProxTrajectoryJsonl = '';
            const proxOutput = await this.callAgentModelWithRetry({
              kind: 'strategyProximity',
              promptText: proxPrompt,
              stepDescription: `Strategy Proximity Review (Global Update ${updateNumber}, Turn ${turn})`,
              isCritical: true,
              executionGroupId: `group-global-update-${updateNumber}-strategies`,
              executionGroupName: `Global Update ${updateNumber}: Strategy Revision Loop`,
              conversation: guProxConversation,
              onTrajectoryJsonl: (jsonl) => {
                guProxTrajectoryJsonl = jsonl;
              },
            });

            appendPeerSubmission(
              guGenConversation,
              `### Strategy Proximity Reviewer (Turn ${turn})`,
              proxOutput,
              'Strategy Generator'
            );

            currentGuTurns.push({
              role: 'proximity',
              content: proxOutput,
              timestamp: Date.now(),
              turnNumber: turn,
              trajectoryJsonl: guProxTrajectoryJsonl,
            } as any);

            const histIdx = this.globalUpdateStrategyHistories.findIndex(h => h.updateNumber === updateNumber);
            if (histIdx >= 0) {
              this.globalUpdateStrategyHistories[histIdx].turns = [...currentGuTurns];
            } else {
              this.globalUpdateStrategyHistories.push({ updateNumber, turns: [...currentGuTurns] });
            }
            (this.state as any).globalUpdateStrategyHistories = this.globalUpdateStrategyHistories;
            this.callbacks.onStateChange?.(this.state);
          }
        }
      }

      const histIdx = this.globalUpdateStrategyHistories.findIndex(h => h.updateNumber === updateNumber);
      if (histIdx >= 0) {
        this.globalUpdateStrategyHistories[histIdx].turns = currentGuTurns;
      } else {
        this.globalUpdateStrategyHistories.push({
          updateNumber,
          turns: currentGuTurns,
        });
      }

      // Apply surgical slot changes onto active strategies (§4.1)
      if (parsedStrat.evolved_slots) {
        for (const ev of parsedStrat.evolved_slots) {
          const branch = this.state.initialStrategies.find(b => b.id === ev.slot_id);
          if (branch) {
            branch.strategyText = ev.updated_strategy_text;
            if (!branch.strategyTextHistory) branch.strategyTextHistory = [];
            branch.strategyTextHistory.push({ iteration, text: ev.updated_strategy_text });
            this.strategiesUsedSoFar.push({
              slotId: branch.id,
              iterationFinalized: iteration,
              text: ev.updated_strategy_text,
            });
          }
        }
      }

      if (parsedStrat.pruned_slots) {
        for (const pr of parsedStrat.pruned_slots) {
          const branch = this.state.initialStrategies.find(b => b.id === pr.slot_id);
          if (branch) {
            branch.strategyText = pr.new_strategy_text;
            branch.strategyTextHistory = [{ iteration: iteration, text: pr.new_strategy_text }];
            this.strategiesUsedSoFar.push({
              slotId: branch.id,
              iterationFinalized: iteration,
              text: pr.new_strategy_text,
            });
          }
        }
      }

      // Commit strategy generator and proximity review histories and strategies used so far (§8.1)
      const guGenTurns = currentGuTurns.filter(t => t.role === 'generator');
      const guProxTurns = currentGuTurns.filter(t => t.role === 'proximity');
      const guGenMarkdown = [
        `# Global Update ${updateNumber} Strategy Generation History`,
        ...guGenTurns.map(t => `### GENERATOR (Turn ${t.turnNumber ?? 1})\n${t.content}`),
      ].join('\n\n');
      const guProxMarkdown = [
        `# Global Update ${updateNumber} Strategy Proximity Review History`,
        ...guProxTurns.map(t => `### PROXIMITY (Turn ${t.turnNumber ?? 1})\n${t.content}`),
      ].join('\n\n');
      const guGenJsonl = buildLoopRoleTrajectoryJsonl(
        guGenTurns as any,
        !!config.deepthinkCodeExecutionEnabled
      );
      const guProxJsonl = buildLoopRoleTrajectoryJsonl(
        guProxTurns as any,
        !!config.deepthinkCodeExecutionEnabled
      );
      const paddedGu = String(updateNumber).padStart(2, '0');
      await this.gitHarness.commitStrategyHistory(
        `strategies_global_update${paddedGu}.md`,
        guGenMarkdown,
        guGenJsonl
      );
      await this.gitHarness.commitStrategyHistory(
        `strategies_global_update${paddedGu}_proximity_review.md`,
        guProxMarkdown,
        guProxJsonl
      );
      await this.updateStrategiesUsedSoFarFile();
    }

    // iv. Apply Decisions to Repository (§4.6 iv, §8.2)
    const newBranchSlotIds: string[] = [];
    const survivingBranches: DeepthinkMainStrategyData[] = [];

    for (let slotIdx = 0; slotIdx < this.state.initialStrategies.length; slotIdx++) {
      const branch = this.state.initialStrategies[slotIdx];
      const dec = consolidatedDecisions.find(d => d.slotId === branch.id);

      if (!dec || dec.decision === 'CONTINUE') {
        survivingBranches.push(branch);
        this.recordWindowEventsToLedger(branch.id, evaluatedRecords.find(r => r.report.branch_id === branch.id)?.report);
      } else if (dec.decision === 'EVOLVE') {
        survivingBranches.push(branch);
        if (dec.form === 'rollback' && dec.rollbackTo !== undefined) {
          this.recordWindowEventsToLedger(branch.id, evaluatedRecords.find(r => r.report.branch_id === branch.id)?.report);
          const cutoffIteration = dec.rollbackTo === 'window_start'
            ? windowStart - 1
            : (dec.rollbackTo as number);

          if (dec.rollbackTo === 'window_start') {
            // Rollback to window beginning (§6.3, §6.6, §8.2)
            const startCommit = this.commitHashesPerIteration.get(`${slotIdx}:start_${windowStart}`);
            if (startCommit) {
              await this.gitHarness.rollbackStrategy(slotIdx, startCommit);
            }
          } else {
            // Rollback to specific iteration
            const commitKey = `${slotIdx}:${dec.rollbackTo}`;
            const targetCommit = this.commitHashesPerIteration.get(commitKey);
            if (targetCommit) {
              await this.gitHarness.rollbackStrategy(slotIdx, targetCommit);
            }
          }

          // Drop discarded events after rollback point from ledger (§6.8)
          this.state.branchLedgers[branch.id] = (this.state.branchLedgers[branch.id] || []).filter(
            e => e.iteration <= cutoffIteration
          );

          // Trim branch iteration history and restore branch state to the rollback point
          if (branch.iterationHistory?.iterations) {
            branch.iterationHistory.iterations = branch.iterationHistory.iterations.filter(
              it => it.iterationNumber <= cutoffIteration
            );
          }
          if (this.state.solutionCritiques) {
            this.state.solutionCritiques = this.state.solutionCritiques.filter(
              c => c.mainStrategyId !== branch.id || (c.globalIteration ?? 0) <= cutoffIteration
            );
          }
          const lastRetained = branch.iterationHistory?.iterations?.[branch.iterationHistory.iterations.length - 1];
          branch.refinedSolution = lastRetained?.correctedSolution;
          branch.refinedSolutionDisplay = lastRetained?.correctedSolutionDisplay ?? lastRetained?.correctedSolution;
          branch.refinedSolutionExecutionTraceText = lastRetained?.correctedSolutionExecutionTraceText;
          branch.solutionCritique = lastRetained?.critique;
          branch.solutionCritiqueDisplay = lastRetained?.critiqueDisplay ?? lastRetained?.critique;
          branch.solutionCritiqueExecutionTraceText = lastRetained?.critiqueExecutionTraceText;
          if (cutoffIteration < 1) {
            branch.solutionAttempt = undefined;
            branch.solutionAttemptDisplay = undefined;
            branch.solutionAttemptExecutionTraceText = undefined;
          }
        } else {
          // In place: keep standing ledger
          this.recordWindowEventsToLedger(branch.id, evaluatedRecords.find(r => r.report.branch_id === branch.id)?.report);
        }
      } else if (dec.decision === 'PRUNE') {
        // Archive folder under ordinal name (§8.2)
        await this.gitHarness.pruneStrategy(slotIdx);
        // Archive pruned branch data for UI transparency before ledger is wiped
        if (!this.state.prunedBranches) this.state.prunedBranches = [];
        this.state.prunedBranches.push({
          id: `${branch.id}-pruned-it${iteration}`,
          originalId: branch.id,
          slotIndex: slotIdx,
          strategyText: branch.strategyText,
          strategyTextHistory: [...(branch.strategyTextHistory || [])],
          prunedAtIteration: iteration,
          reason: dec.eventReasons?.join('; ') || 'Pruned by BSR decision',
          status: 'completed',
          solutionAttempt: branch.solutionAttempt,
          solutionAttemptDisplay: branch.solutionAttemptDisplay,
          solutionAttemptExecutionTraceText: branch.solutionAttemptExecutionTraceText,
          solutionCritique: branch.solutionCritique,
          solutionCritiqueDisplay: branch.solutionCritiqueDisplay,
          solutionCritiqueExecutionTraceText: branch.solutionCritiqueExecutionTraceText,
          solutionCritiqueStatus: branch.solutionCritiqueStatus,
          correctionStatus: branch.correctionStatus,
          iterationHistory: {
            iterations: [...(branch.iterationHistory?.iterations || [])],
            status: 'completed',
          },
        });
        // PRUNE permanently closes ledger; new branch starts with empty ledger (§6.8)
        this.state.branchLedgers[branch.id] = [];
        branch.iterationHistory = { iterations: [], status: 'idle' };
        branch.memoryBank = undefined;
        newBranchSlotIds.push(branch.id);
      }
    }

    // v. Memory Bank Distillation on Survivors + First Execution & Critique on New Branches (§4.6 v)
    const distillationPromise = Promise.all(survivingBranches.map(async (branch) => {
      const dec = consolidatedDecisions.find(d => d.slotId === branch.id);
      // NOTE (§6.6): When none of the window is retained (rollbackTo === 'window_start'),
      // the previous memory bank stands and no new distillation runs.
      if (dec?.form === 'rollback' && dec.rollbackTo === 'window_start') {
        return;
      }

      const effectiveWindowEnd = dec?.form === 'rollback' && typeof dec.rollbackTo === 'number'
        ? dec.rollbackTo
        : iteration;

      const windowIterations = branch.iterationHistory?.iterations.filter(
        it => it.iterationNumber >= windowStart && it.iterationNumber <= effectiveWindowEnd
      ) || [];

      const memContext = [
        `# Core Challenge\n${this.state.challenge}`,
        `Branch ID: ${branch.id}`,
        `Strategy Text: ${branch.strategyText}`,
        branch.memoryBank ? `Previous Memory Bank:\n${branch.memoryBank}` : 'No previous memory bank.',
        `Window History:\n${windowIterations.map(it => `Iteration ${it.iterationNumber}:\nCorrection: ${it.correctedSolution}\nCritique: ${it.critique}`).join('\n\n')}`,
      ].join('\n\n');

      let memTrajectoryJsonl = '';
      const memOutput = await this.callAgentModelWithRetry({
        kind: 'memoryBank',
        promptText: memContext,
        stepDescription: `Memory Bank Distillation for ${branch.id} (Update ${updateNumber})`,
        workingDirectory: `Strategy-${branch.id.replace(/\D/g, '')}`,
        isCritical: false,
        executionGroupId: `group-global-update-${updateNumber}-distillation`,
        executionGroupName: `Global Update ${updateNumber}: Distillation & New Branch Seeding (Parallel)`,
        onTrajectoryJsonl: (jsonl) => {
          memTrajectoryJsonl = jsonl;
        },
      });

      branch.memoryBank = memOutput;

      // Write memory bank and trajectory to Strategy-N/history/memory_bank_NN.md & .jsonl (§8.1)
      await this.gitHarness.writeFilesAndCommit(
        `Memory Bank distillation for ${branch.id} at update ${updateNumber}`,
        [
          {
            path: `Strategy-${branch.id.replace(/\D/g, '')}/history/memory_bank_${String(updateNumber).padStart(2, '0')}.md`,
            content: memOutput,
          },
          {
            path: `Strategy-${branch.id.replace(/\D/g, '')}/history/memory_bank_${String(updateNumber).padStart(2, '0')}.jsonl`,
            content: memTrajectoryJsonl,
          },
        ]
      );
    }));

    const newBranchesPromise = Promise.all(newBranchSlotIds.map(async (slotId) => {
      const branch = this.state.initialStrategies.find(b => b.id === slotId)!;
      const slotIndex = this.state.initialStrategies.findIndex(b => b.id === slotId);

      // First execution
      const attemptPrompt = [
        `# Core Challenge\n${this.state.challenge}`,
        `Assigned Strategy: ${branch.id}\n${branch.strategyText}`,
        `First execution for replacement branch in slot ${slotId}.`,
      ].join('\n\n');

      let attemptTrajectoryJsonl = '';
      const attemptOutput = await this.callAgentModelWithRetry({
        kind: 'solutionAttempt',
        promptText: attemptPrompt,
        stepDescription: `First Execution for New Branch in ${slotId}`,
        workingDirectory: `Strategy-${slotIndex + 1}`,
        isCritical: false,
        executionGroupId: `group-global-update-${updateNumber}-distillation`,
        executionGroupName: `Global Update ${updateNumber}: Distillation & New Branch Seeding (Parallel)`,
        onTrajectoryJsonl: (jsonl) => {
          attemptTrajectoryJsonl = jsonl;
        },
      });

      branch.solutionAttempt = attemptOutput;
      branch.refinedSolution = attemptOutput;
      branch.iterationHistory = {
        iterations: [{
          iterationNumber: iteration, // Global iteration number (§3, §12.12)
          correctedSolution: attemptOutput,
          critique: '',
          timestamp: Date.now(),
          solutionTrajectoryJsonl: attemptTrajectoryJsonl,
        } as any],
        status: 'processing',
      };

      // Critique
      const historyContext = buildCritiqueCorrectionMemoryBankHistory(
        branch.memoryBank,
        branch.iterationHistory.iterations
      );
      const critiquePrompt = buildContextForCritiqueAgent(
        this.state.challenge,
        branch.id,
        branch.strategyText,
        historyContext
      );

      let critiqueTrajectoryJsonl = '';
      const critiqueOutput = await this.callAgentModelWithRetry({
        kind: 'solutionCritique',
        promptText: critiquePrompt,
        stepDescription: `First Critique for New Branch in ${slotId}`,
        workingDirectory: `Strategy-${slotIndex + 1}`,
        isCritical: false,
        executionGroupId: `group-global-update-${updateNumber}-distillation`,
        executionGroupName: `Global Update ${updateNumber}: Distillation & New Branch Seeding (Parallel)`,
        onTrajectoryJsonl: (jsonl) => {
          critiqueTrajectoryJsonl = jsonl;
        },
      });

      branch.solutionCritique = critiqueOutput;

      if (!this.state.solutionCritiques) this.state.solutionCritiques = [];
      this.state.solutionCritiques.push({
        id: `critique-${branch.id}-${iteration}`,
        mainStrategyId: branch.id,
        globalIteration: iteration,
        status: 'completed',
        critiqueResponse: critiqueOutput,
        critiqueResponseDisplay: critiqueOutput,
      });
      this.state.solutionCritiquesStatus = 'completed';

      branch.iterationHistory.iterations[0].critique = critiqueOutput;
      branch.iterationHistory.iterations[0].timestamp = Date.now();
      (branch.iterationHistory.iterations[0] as any).critiqueTrajectoryJsonl = critiqueTrajectoryJsonl;
      branch.iterationHistory.status = 'completed';
    }));

    await Promise.all([distillationPromise, newBranchesPromise]);

    // Checkpoint next window_start for every active strategy folder (§6.3, §8.2)
    const nextWindowStart = iteration + 1;
    for (let slotIdx = 0; slotIdx < this.state.initialStrategies.length; slotIdx++) {
      const strat = this.state.initialStrategies[slotIdx];
      const contextFiles: DeepthinkResultsContextFile[] = [
        {
          path: `Strategy-${slotIdx + 1}/strategy.md`,
          content: `# Strategy ${slotIdx + 1} (${strat.id})\n\n${strat.strategyText}\n`,
        },
      ];
      const commit = await this.gitHarness.commitWindowStart(slotIdx, nextWindowStart, contextFiles);
      this.commitHashesPerIteration.set(`${slotIdx}:start_${nextWindowStart}`, commit);
    }

    // vi. Step-ii DOS on Post-Update State (§4.6 vi, §5.1)
    let stepIiDosOutput: DosOutput | undefined;
    if (config.modulesCount > 0) {
      const postUpdateState = this.state.initialStrategies.map(s => ({
        branchId: s.id,
        strategyText: s.strategyText,
        latestCorrection: s.refinedSolution || s.solutionAttempt || 'None',
        latestCritique: s.solutionCritique || 'None',
      }));

      const stepIiPrompt = buildContextForDos(this.state.challenge, 'step_ii', postUpdateState, {
        previousHeartbeat: this.state.heartbeats[this.state.heartbeats.length - 1],
        slotStatuses: consolidatedDecisions.map(d => ({
          slotId: d.slotId,
          action: d.decision,
          form: d.form,
          rollbackTo: d.rollbackTo,
        })),
        stepIOutput: stepIDosOutput,
      });

      const stepIiDosContract: OutputValidationContract<DosOutput> = {
        name: 'StepIiDosContract',
        validate: (parsed) => {
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('Step-ii DOS response must be an object.');
          }
        },
      };

      let stepIiDosTrajectoryJsonl = '';
      const rawStepIiDos = await this.callAgentModelWithRetry({
        kind: 'dos',
        promptText: stepIiPrompt,
        stepDescription: `Step-ii DOS (Global Update ${updateNumber})`,
        jsonResponse: true,
        isCritical: true,
        contract: stepIiDosContract,
        executionGroupId: `group-global-update-${updateNumber}-step-ii`,
        executionGroupName: `Global Update ${updateNumber}: Step-ii DOS Synthesis`,
        onTrajectoryJsonl: (jsonl) => {
          stepIiDosTrajectoryJsonl = jsonl;
        },
      });

      stepIiDosOutput = this.parseJsonStrict<DosOutput>(rawStepIiDos, `Step-ii DOS (Global Update ${updateNumber})`);
      this.state.dosOutputs.push({ callType: 'step_ii', iteration, output: stepIiDosOutput });

      // Save Step-ii DOS and trajectory to repository (§8.1, §12.13)
      await this.gitHarness.writeFilesAndCommit(
        `Step-ii DOS for Global Update ${updateNumber}`,
        [
          {
            path: `DOS_history/DOS_global_update_${String(updateNumber).padStart(2, '0')}_step_ii.md`,
            content: `# Step-ii DOS Output (Global Update ${updateNumber})\n\n\`\`\`json\n${JSON.stringify(stepIiDosOutput, null, 2)}\n\`\`\``,
          },
          {
            path: `DOS_history/DOS_global_update_${String(updateNumber).padStart(2, '0')}_step_ii.jsonl`,
            content: stepIiDosTrajectoryJsonl,
          },
        ]
      );

      // Attach realized module feedback for the previous heartbeat (§5.1, §5.4)
      const previousHeartbeat = this.state.heartbeats[this.state.heartbeats.length - 1];
      if (stepIiDosOutput.module_feedback && previousHeartbeat) {
        await this.attachRealizedDosFeedback(stepIiDosOutput.module_feedback, previousHeartbeat.heartbeat_no);
      }
    }

    // vii. Run Curated Context Heartbeat, reusing Step-ii DOS (§4.6 vii, §4.5)
    const stepIiDosFilePath = `DOS_history/DOS_global_update_${String(updateNumber).padStart(2, '0')}_step_ii.md`;
    await this.runCuratedContextHeartbeat(iteration, heartbeatNo, stepIiDosOutput, stepIiDosFilePath);
  }

  // ==========================================================================
  // Final Judge (§7, §8.3, §9)
  // ==========================================================================

  private async runFinalJudge(): Promise<void> {
    const candidates = this.state.initialStrategies.map(s => {
      const latestIteration = s.iterationHistory?.iterations?.[s.iterationHistory.iterations.length - 1];
      return {
        branchId: s.id,
        strategyText: s.strategyText,
        finalSolution: s.refinedSolution || latestIteration?.correctedSolution || s.solutionAttempt || 'No solution recorded.',
        finalCritique: s.solutionCritique || latestIteration?.critique || 'No critique recorded.',
      };
    });

    // NOTE: Final judge direct context receives each active branch's final correction-critique pair (§7, §9)
    const judgePrompt = buildContextForFinalJudge(this.state.challenge, candidates);

    this.state.finalJudgingStatus = 'processing';
    this.callbacks.onStateChange?.(this.state);

    const validIds = candidates.map(c => c.branchId);
    const judgeContract: OutputValidationContract<{ best_solution_id: string; final_reasoning: string }> = {
      name: 'FinalJudgeContract',
      validate: (parsed) => {
        if (!parsed || !validIds.includes(parsed.best_solution_id)) {
          throw new Error(`Final judge selected invalid or unknown candidate ID: ${parsed?.best_solution_id}`);
        }
      },
    };

    const rawJudge = await this.callAgentModelWithRetry({
      kind: 'finalJudge',
      promptText: judgePrompt,
      stepDescription: 'Final Judge Evaluation',
      jsonResponse: true,
      isCritical: true,
      contract: judgeContract,
      executionGroupId: 'group-final-judge',
      executionGroupName: 'Final Judge Evaluation',
    });

    const parsed = this.parseJsonStrict<{
      best_solution_id: string;
      final_reasoning: string;
    }>(rawJudge, 'Final Judge Evaluation');

    const winningCandidate = candidates.find(c => c.branchId === parsed.best_solution_id);
    if (!winningCandidate) {
      throw new Error(`Final judge selected unknown candidate '${parsed.best_solution_id}'. Available candidates: ${candidates.map(c => c.branchId).join(', ')}`);
    }

    this.state.finalJudgingResponseText = parsed.final_reasoning;
    this.state.finalJudgedBestSolution = winningCandidate.finalSolution;
    this.state.finalJudgingStatus = 'completed';
    this.callbacks.onStateChange?.(this.state);
  }

  // ==========================================================================
  // Helpers & Execution with Retry (§9)
  // ==========================================================================

  private async attachRealizedDosFeedback(
    dosFeedback: DosModuleFeedbackItem[],
    targetHeartbeatNo: number
  ): Promise<void> {
    const heartbeatBlock = this.state.heartbeats.find(h => h.heartbeat_no === targetHeartbeatNo);
    if (!heartbeatBlock) return;

    const filesToWrite: DeepthinkResultsContextFile[] = [];

    for (const item of dosFeedback) {
      const existing = heartbeatBlock.realized_feedback.find(rf => rf.module_id === item.module_id);
      const targetMod = heartbeatBlock.modules.find(m => m.id === item.module_id);
      const modIdx = heartbeatBlock.modules.findIndex(m => m.id === item.module_id);
      const folderIndex = modIdx >= 0 ? modIdx + 1 : 1;

      const utilization = item.branch_utilization ? calculateUtilizationVector(item.branch_utilization) : undefined;

      if (existing) {
        if (utilization) {
          existing.utilization = utilization;
          existing.utilization_note = "Calculated programmatically from the DOS agent's observations.";
        }
        if (item.critique_counterevidence && item.critique_counterevidence.length > 0) {
          existing.critique_counterevidence = item.critique_counterevidence;
        }
        filesToWrite.push({
          path: `Modules/Heartbeat-${targetHeartbeatNo}/Module-${folderIndex}/feedback.json`,
          content: JSON.stringify(existing, null, 2),
        });
      } else if (targetMod) {
        const observedVerdict = targetMod.testerVerdict || 'INCONCLUSIVE';

        const newFeedback: RealizedModuleFeedback = {
          module_id: item.module_id,
          observed_test_outcome: observedVerdict,
          utilization,
          utilization_note: utilization ? "Calculated programmatically from the DOS agent's observations." : undefined,
          critique_counterevidence: item.critique_counterevidence,
        };

        heartbeatBlock.realized_feedback.push(newFeedback);
        filesToWrite.push({
          path: `Modules/Heartbeat-${targetHeartbeatNo}/Module-${folderIndex}/feedback.json`,
          content: JSON.stringify(newFeedback, null, 2),
        });
      }
    }

    if (filesToWrite.length > 0) {
      await this.gitHarness.writeFilesAndCommit(
        `Realized module feedback for Heartbeat ${targetHeartbeatNo}`,
        filesToWrite
      );
    }
  }

  private async updateStrategiesUsedSoFarFile(): Promise<void> {
    const markdown = [
      '# Strategies Finalized and Used So Far',
      ...this.strategiesUsedSoFar.map(s => `## Slot ${s.slotId} (Iteration ${s.iterationFinalized})\n${s.text}`),
    ].join('\n\n');

    await this.gitHarness.commitStrategyHistory('strategies_finalized_and_used_so_far.md', markdown);
  }

  private recordWindowEventsToLedger(branchId: string, report?: BsrReport): void {
    if (!report) return;
    const ledger = this.state.branchLedgers[branchId] || [];

    const weights = {
      small: this.state.runConfig?.bsrWeightSmall ?? SIZE_WEIGHTS.small,
      medium: this.state.runConfig?.bsrWeightMedium ?? SIZE_WEIGHTS.medium,
      large: this.state.runConfig?.bsrWeightLarge ?? SIZE_WEIGHTS.large,
    };

    for (const p of report.confirmed_progress) {
      ledger.push({
        iteration: p.iteration,
        direction: 'progress',
        size: p.size,
        weight: weights[p.size] ?? 1,
        reason: p.reason,
      });
    }

    for (const r of report.confirmed_regression) {
      ledger.push({
        iteration: r.iteration,
        direction: 'regression',
        size: r.size,
        weight: weights[r.size] ?? 1,
        reason: r.reason,
      });
    }

    this.state.branchLedgers[branchId] = ledger;
  }

  private async commitIterationBarriers(iteration: number): Promise<void> {
    for (let slotIdx = 0; slotIdx < this.state.initialStrategies.length; slotIdx++) {
      const commitKey = `${slotIdx}:${iteration}`;
      if (this.commitHashesPerIteration.has(commitKey)) {
        continue;
      }
      const branch = this.state.initialStrategies[slotIdx];
      const historyEntry = branch.iterationHistory?.iterations.find(it => it.iterationNumber === iteration);

      const files: DeepthinkResultsContextFile[] = [];
      if (historyEntry) {
        const paddedIter = String(iteration).padStart(2, '0');
        files.push({
          path: `Strategy-${slotIdx + 1}/history/iteration_${paddedIter}.md`,
          content: [
            `# Strategy ${branch.id} - Iteration ${iteration}`,
            `## Solution\n${historyEntry.correctedSolution}`,
            `\n## Critique\n${historyEntry.critique}`,
          ].join('\n\n'),
        });
        const solJsonl = (historyEntry as any).solutionTrajectoryJsonl || formatDirectCallTrajectoryJsonl({
          userPrompt: `[Strategy ${branch.id} Iteration ${iteration} Solution]`,
          assistantResponse: historyEntry.correctedSolution,
        });
        const critJsonl = (historyEntry as any).critiqueTrajectoryJsonl || (
          historyEntry.critique
            ? formatDirectCallTrajectoryJsonl({
                userPrompt: `[Strategy ${branch.id} Iteration ${iteration} Critique]`,
                assistantResponse: historyEntry.critique,
              })
            : ''
        );
        files.push({
          path: `Strategy-${slotIdx + 1}/history/iteration_${paddedIter}.jsonl`,
          content: [solJsonl, critJsonl].filter(Boolean).join('\n'),
        });
      }

      const commit = await this.gitHarness.commitStrategyIteration(slotIdx, iteration, files);
      this.commitHashesPerIteration.set(commitKey, commit);
    }
    this.syncCheckpointState(iteration);
  }

  /**
   * Dispatches an agent model call with the unified failure, watchdog, and retry policy:
   * - 4 total attempts (initial + 3m, 10m, 15m backoff retries on real errors)
   * - 5-minute rolling silence watchdog (stops/pauses immediately on 5m total silence)
   * - 1-hour wall-clock budget and 64 tool-call budget for sandboxed invocations
   * - On terminal failure, cleanly pauses the Deepthink pipeline instead of skipping branches
   */
  private async callAgentModelWithRetry<T = unknown>(args: {
    kind: DeepthinkAgentKind;
    promptText: string;
    stepDescription: string;
    workingDirectory?: string;
    jsonResponse?: boolean;
    isCritical?: boolean;
    contract?: OutputValidationContract<T>;
    executionId?: string;
    executionGroupId?: string;
    executionGroupName?: string;
    conversation?: LoopAgentConversation;
    onTrajectoryJsonl?: (jsonl: string) => void;
  }): Promise<string> {
    const config = this.state.runConfig;
    const prompts = this.state.customPrompts || (this.state.runConfig as any)?.prompts || createDefaultCustomPromptsDeepthink();
    const pairedAgentKind: DeepthinkAgentKind =
      args.kind === 'strategyProximity'
        ? 'initialStrategy'
        : args.kind === 'modulesImpactReview'
          ? 'modulesGeneration'
          : args.kind;
    const model = deepthinkAgentModel(pairedAgentKind, prompts, config.model);
    const systemInstruction = deepthinkAgentSystemInstruction(pairedAgentKind, prompts);
    const maxOutputTokens = deepthinkAgentMaxOutputTokens(args.kind);
    const metadata = DEEPTHINK_AGENT_REGISTRY[args.kind];
    const displayAgentName = metadata ? `${metadata.label} Agent` : `${args.kind} Agent`;
    const executionId = args.executionId || `inv-${nanoid(10)}`;

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
      this.checkStopRequested();

      this.emitEvent(displayAgentName, args.stepDescription, attempt === 1 ? 'agent_start' : 'agent_retry', {
        prompt: args.promptText,
        systemInstruction,
        modelName: model,
        attempt,
        executionId,
        executionGroupId: args.executionGroupId,
        executionGroupName: args.executionGroupName,
        codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
      });

      try {
        let outputText: string;
        let executionTraceText: string | undefined;
        let rawTrajectoryJsonl: string;

        const abortPromise = new Promise<never>((_, reject) => {
          if (this.isStopRequested) return reject(new PipelineStopRequestedError());
          this.abortController.signal.addEventListener('abort', () => {
            const reason = this.abortController.signal.reason;
            if (reason instanceof InferenceSilenceTimeoutError || isTerminalInferenceError(reason)) {
              reject(reason);
            } else {
              reject(new PipelineStopRequestedError());
            }
          }, { once: true });
        });

        const handleInnerRetry = (retryAttempt: number, maxRetries: number, delayMs: number, retryErr: unknown) => {
          const errText = (retryErr as any)?.message || String(retryErr);
          const delayMins = Math.round((delayMs / 60_000) * 10) / 10;
          this.emitEvent(
            displayAgentName,
            `${args.stepDescription} failed (attempt ${retryAttempt}/${maxRetries + 1}): ${errText}. Retrying in ${delayMins}m...`,
            'agent_retry',
            {
              error: errText,
              modelName: model,
              attempt: retryAttempt,
              executionId,
              executionGroupId: args.executionGroupId,
              executionGroupName: args.executionGroupName,
              codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
            }
          );
        };

        const executePromise = (async () => {
          if (config.deepthinkCodeExecutionEnabled) {
            const sessionId = args.conversation?.sessionId ?? `dtsb-${this.state.id}-${args.kind}-${nanoid(6)}`;
            const repositoryAccess: SandboxRepositoryAccess = {
              repositoryId: this.state.id,
              agentDirectory: args.workingDirectory,
              agentDirectoryReadOnly: args.kind === 'bsr' || args.kind === 'memoryBank',
              fullRepositoryRead: true,
            };

            const sharedWorkspaceHandler = (input: SharedWorkspaceToolInput) =>
              this.sharedWorkspace.handleToolCall(input);

            const runAgent = this.callbacks.runSandboxToolAgent ?? (await getSandboxToolAgentRunner());
            if (!runAgent) {
              throw new Error('Sandbox tool agent runtime is not available in this environment');
            }
            const inputMessages =
              args.conversation && args.conversation.messages.length > 0
                ? args.conversation.messages
                : [new HumanMessage({ content: parsePromptToGeminiParts(args.promptText) })];
            const result = await runAgent({
              agentName: args.kind,
              sessionId,
              messages: inputMessages,
              systemPrompt: systemInstruction,
              modelName: model,
              maxOutputTokens,
              finalOutputContract: args.contract
                ? {
                    name: args.contract.name,
                    validate: (payload: unknown) => args.contract!.validate(payload as T),
                  }
                : undefined,
              omitUploadedFileMessage: true,
              repositoryAccess,
              sharedWorkspaceHandler,
              abortSignal: this.abortController.signal,
              retryDelaysMs: this.callbacks.retryDelaysMs,
              silenceTimeoutMs: this.callbacks.silenceTimeoutMs,
              onRetry: handleInnerRetry,
            });

            const fallbackJsonl = formatDirectCallTrajectoryJsonl({
              systemInstruction,
              userPrompt: args.promptText,
              assistantResponse: result.text || result.finalText,
            });

            return {
              text: result.text || result.finalText,
              trace: result.executionTraceText,
              jsonl: result.rawTrajectoryJsonl || fallbackJsonl,
              messages: result.messages,
            };
          } else {
            const invokeDirectCall = async (signal?: AbortSignal, touch?: () => void) => {
              return await this.callbacks.callAI({
                prompt: args.promptText,
                model,
                systemInstruction,
                responseSchema: args.jsonResponse ? true : undefined,
                thinkingConfig: { thinkingLevel: config.thinkingLevel },
                agentKind: args.kind,
                stepDescription: args.stepDescription,
                abortSignal: signal ?? this.abortController.signal,
                retryDelaysMs: this.callbacks.retryDelaysMs,
                silenceTimeoutMs: this.callbacks.silenceTimeoutMs,
                onChunkActivity: touch,
                onRetry: handleInnerRetry,
              });
            };

            const text = this.callbacks.silenceTimeoutMs !== undefined
              ? await withSilenceWatchdog(
                  {
                    label: `${displayAgentName} (${args.stepDescription})`,
                    silenceTimeoutMs: this.callbacks.silenceTimeoutMs,
                    externalSignal: this.abortController.signal,
                  },
                  ({ signal, touch }) => invokeDirectCall(signal, touch)
                )
              : await invokeDirectCall();

            const jsonl = formatDirectCallTrajectoryJsonl({
              systemInstruction,
              userPrompt: args.promptText,
              assistantResponse: text,
            });
            return {
              text,
              trace: undefined,
              jsonl,
              messages: undefined,
            };
          }
        })();

        const executionResult = await Promise.race([executePromise, abortPromise]);
        outputText = executionResult.text;
        executionTraceText = executionResult.trace;
        rawTrajectoryJsonl = executionResult.jsonl;

        if (this.isStopRequested) {
          this.checkStopRequested();
          throw new PipelineStopRequestedError();
        }

        if (!outputText || !outputText.trim()) {
          throw new Error('Empty response received from model.');
        }

        // Validate structured output contract if present (§9)
        if (args.contract) {
          const parsed = this.parseJsonStrict<T>(outputText, args.contract.name);
          args.contract.validate(parsed);
        }

        if (args.conversation && executionResult.messages) {
          args.conversation.messages = executionResult.messages;
        }

        args.onTrajectoryJsonl?.(rawTrajectoryJsonl);

        this.emitEvent(displayAgentName, args.stepDescription, 'agent_complete', {
          response: outputText,
          executionTraceText,
          prompt: args.promptText,
          systemInstruction,
          modelName: model,
          executionId,
          executionGroupId: args.executionGroupId,
          executionGroupName: args.executionGroupName,
          codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
        });

        return outputText;
      } catch (err: any) {
        if (
          err instanceof PipelineStopRequestedError ||
          err?.name === 'PipelineStopRequestedError' ||
          (this.isStopRequested && !isTerminalInferenceError(err))
        ) {
          this.checkStopRequested();
          throw err;
        }

        lastError = err;
        const errMsg = err?.message || String(err);

        // If the underlying inference layer already exhausted its 1m/3m/5m retries,
        // fast-failed a permanent 4xx error, or hit the 5-minute silence timeout, pause Deepthink immediately.
        if (isTerminalInferenceError(err)) {
          this.emitEvent(displayAgentName, `${args.stepDescription} failed: ${errMsg}`, 'agent_error', {
            error: errMsg,
            modelName: model,
            attempt,
            executionId,
            executionGroupId: args.executionGroupId,
            executionGroupName: args.executionGroupName,
            codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
          });
          return this.pausePipelineOnInferenceFailure(`${args.stepDescription}: ${errMsg}`);
        }

        const shouldRetry = attempt < MAX_API_ATTEMPTS;

        this.emitEvent(displayAgentName, `${args.stepDescription} failed: ${errMsg}`, shouldRetry ? 'agent_retry' : 'agent_error', {
          error: errMsg,
          modelName: model,
          attempt,
          executionId,
          executionGroupId: args.executionGroupId,
          executionGroupName: args.executionGroupName,
          codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
        });

        if (!shouldRetry) break;

        const retryDelays = this.callbacks.retryDelaysMs ?? RETRY_DELAYS_MS;
        const delay = retryDelays[attempt - 1] ?? RETRY_DELAYS_MS[0];
        const step = 200;
        let elapsed = 0;
        while (elapsed < delay) {
          this.checkStopRequested();
          const waitTime = Math.min(step, delay - elapsed);
          await new Promise(res => setTimeout(res, waitTime));
          elapsed += waitTime;
        }
        this.checkStopRequested();
      }
    }

    const finalErrorMessage = `Agent call for ${args.stepDescription} exhausted all ${MAX_API_ATTEMPTS} attempts: ${String((lastError as any)?.message || lastError)}`;

    this.emitEvent(displayAgentName, finalErrorMessage, 'agent_error', {
      error: finalErrorMessage,
      executionId,
      executionGroupId: args.executionGroupId,
      executionGroupName: args.executionGroupName,
      codeExecutionEnabled: !!config.deepthinkCodeExecutionEnabled,
    });

    return this.pausePipelineOnInferenceFailure(finalErrorMessage);
  }

  private pausePipelineOnInferenceFailure(reason: string): never {
    const pauseMessage = `Deepthink pipeline paused due to terminal inference failure: ${reason}`;
    this.emitEvent('Orchestrator', pauseMessage, 'info', {
      error: reason,
    });
    this.state.status = 'stopped';
    this.state.isStopRequested = false;
    const stopErr = new PipelineStopRequestedError(pauseMessage);
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(stopErr);
    }
    this.syncCheckpointState();
    throw stopErr;
  }

  private checkStopRequested(): void {
    if (this.isStopRequested) {
      this.state.status = 'stopped';
      this.state.isStopRequested = false;
      if (!this.abortController.signal.aborted) {
        this.abortController.abort(new PipelineStopRequestedError());
      }
      this.syncCheckpointState();
      throw new PipelineStopRequestedError();
    }
  }

  private emitEvent(
    agentName: string,
    stepDescription: string,
    eventType: DeepthinkLiveEvent['eventType'],
    extra?: Partial<DeepthinkLiveEvent>
  ): void {
    const event: DeepthinkLiveEvent = {
      id: nanoid(10),
      timestamp: Date.now(),
      agentName,
      stepDescription,
      eventType,
      ...extra,
    };
    if (!this.state.liveEvents) this.state.liveEvents = [];
    this.state.liveEvents.push(event);
    this.callbacks.onLiveEvent?.(event);
  }
}
