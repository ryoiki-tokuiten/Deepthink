import type { CustomizablePromptsDeepthink } from '../prompts';

export type AgentStatus = 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';

export interface DeepthinkRunConfig {
    i: number;
    j: number;
    k: number;
    strategiesCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    isolateBranches: boolean;
    deepthinkCodeExecutionEnabled: boolean;
    thinkingLevel?: string;
    model?: string;
    bsrNoiseLevel?: number;
    bsrPressureFloor?: number;
    bsrWeightSmall?: number;
    bsrWeightMedium?: number;
    bsrWeightLarge?: number;
    bsrWeightPreset?: string;
}

export interface DeepthinkSolutionCritiqueData {
    id: string;
    mainStrategyId: string;
    critiqueResponse?: string;
    critiqueResponseDisplay?: string;
    status: AgentStatus;
    error?: string;
    globalIteration?: number;
    branchIteration?: number;
}

export interface DeepthinkBranchIteration {
    iterationNumber: number;
    globalIteration?: number;
    branchIteration?: number;
    critique: string;
    critiqueDisplay?: string;
    correctedSolution: string;
    correctedSolutionDisplay?: string;
    correctedSolutionExecutionTraceText?: string;
    critiqueExecutionTraceText?: string;
    timestamp: number;
    label?: string;
}

export interface DeepthinkMainStrategyData {
    id: string;
    strategyText: string;
    strategyTextHistory?: Array<{ iteration: number; text: string }>;
    solutionAttempt?: string;
    solutionAttemptDisplay?: string;
    solutionAttemptFinal?: string;
    solutionAttemptExecutionTraceText?: string;
    solutionCritique?: string;
    solutionCritiqueDisplay?: string;
    solutionCritiqueFinal?: string;
    solutionCritiqueExecutionTraceText?: string;
    solutionCritiqueStatus?: AgentStatus;
    refinedSolution?: string;
    refinedSolutionDisplay?: string;
    refinedSolutionFinal?: string;
    refinedSolutionExecutionTraceText?: string;
    correctionStatus?: AgentStatus | 'skipped';
    status: AgentStatus;
    error?: string;
    branchIterationCount?: number;
    iterationHistory?: {
        iterations: DeepthinkBranchIteration[];
        status: 'idle' | 'processing' | 'completed' | 'error';
    };
    memoryBank?: string;
}

export interface DeepthinkModuleData {
    id: string;
    moduleText: string;
    targetBranchIds?: string[];
    testerAttempt?: string;
    testerAttemptDisplay?: string;
    testerAttemptFinal?: string;
    testerAttemptExecutionTraceText?: string;
    testerStatus: AgentStatus;
    testerVerdict?: 'VALIDATED' | 'REJECTED' | 'INCONCLUSIVE';
    roundNumber?: number;
    globalIteration?: number;
}

export type BsrEventSize = 'small' | 'medium' | 'large';

export interface BsrEvent {
    iteration: number;
    size: BsrEventSize;
    reason: string;
}

export interface BsrLedgerEntry {
    iteration: number;
    direction: 'progress' | 'regression';
    size: BsrEventSize;
    weight: number;
    reason: string;
}

export interface BsrReport {
    branch_id: string;
    confirmed_progress: BsrEvent[];
    confirmed_regression: BsrEvent[];
    critique_alignment: { value: number; reason: string };
}

export type BsrWindowOutcome = 'PROGRESS' | 'STALL' | 'REGRESS';
export type BsrAction = 'CONTINUE' | 'EVOLVE' | 'PRUNE';
export type BsrEvolveForm = 'in_place' | 'rollback';

export interface BsrComputedScores {
    net: number;
    movement: number;
    window_outcome: BsrWindowOutcome;
    last_good_iteration: number | 'window_start';
    lost_ground: number;
    progress_kept: number;
    drift: number;
    stall_evidence: number;
    pressure: { CONTINUE: number; EVOLVE: number; PRUNE: number };
    decision: BsrAction;
    form?: BsrEvolveForm;
    rollback_to?: number | 'window_start';
}

export interface BsrGlobalUpdateRecord {
    updateNumber: number;
    iteration: number;
    branch_id: string;
    report: BsrReport;
    computed: BsrComputedScores;
}

export type ModuleUtilizationClassification = 'USED_CORRECTLY' | 'USED_PARTIALLY' | 'NOT_USED' | 'MISUSED';

export interface DosBranchUtilization {
    branch_id: string;
    utilization: { reason: string; classification: ModuleUtilizationClassification };
}

export interface DosCritiqueCounterevidence {
    branch_id: string;
    reason: string;
    classification: 'STRONG';
}

export interface DosModuleFeedbackItem {
    module_id: string;
    branch_utilization: DosBranchUtilization[];
    critique_counterevidence?: DosCritiqueCounterevidence[];
}

export interface DosOutput {
    core_synthesis: Record<string, unknown>;
    module_feedback?: DosModuleFeedbackItem[];
}

export interface RealizedModuleFeedback {
    module_id: string;
    observed_test_outcome: 'VALIDATED' | 'REJECTED' | 'INCONCLUSIVE';
    utilization?: {
        correct_use: number;
        partial_use: number;
        not_used: number;
        misused: number;
    };
    utilization_note?: string;
    critique_counterevidence?: Array<{
        branch_id: string;
        classification: 'STRONG';
        reason: string;
    }>;
}

export interface HeartbeatBlock {
    heartbeat_no: number;
    iteration: number;
    dosFilePath?: string;
    modules: DeepthinkModuleData[];
    realized_feedback: RealizedModuleFeedback[];
}

export interface DeepthinkLiveEvent {
    id: string;
    timestamp: number;
    agentName: string;
    stepDescription: string;
    eventType: 'info' | 'agent_start' | 'agent_complete' | 'agent_error' | 'agent_retry';
    systemInstruction?: string;
    prompt?: string;
    response?: string;
    executionTraceText?: string;
    error?: string;
    attempt?: number;
    modelName?: string;
    codeExecutionEnabled?: boolean;
    executionId?: string;
    executionGroupId?: string;
    executionGroupName?: string;
}

export interface ProximityTurn {
    role: 'generator' | 'proximity';
    content: string;
    timestamp?: number;
    turnNumber?: number;
    roundNumber?: number;
    version?: number;
}

export interface ModuleRoundSnapshot {
    roundNumber: number;
    packet: string;
    modules?: DeepthinkModuleData[];
}

export interface DeepthinkResultsContextFile {
    path: string;
    content: string;
}

export interface SandboxRepositoryAccess {
    repositoryId: string;
    agentDirectory?: string;
    agentDirectoryReadOnly?: boolean;
    readableDirectories?: string[];
    liveReadableDirectories?: string[];
    blockedDirectories?: string[];
    fullRepositoryRead?: boolean;
}

export interface DeepthinkPipelineState {
    id: string;
    challenge: string;
    status: 'idle' | 'processing' | 'completed' | 'error' | 'stopping' | 'stopped' | 'cancelled';
    error?: string;
    activeTabId: string;
    activeStrategyTab?: number;
    isStopRequested?: boolean;
    runConfig: DeepthinkRunConfig;
    customPrompts?: CustomizablePromptsDeepthink;
    strategyGenerationHistory?: ProximityTurn[];
    initialStrategies: DeepthinkMainStrategyData[];
    strategyProximityHistory: ProximityTurn[];
    modulesGenerationHistory: ProximityTurn[];
    modules: DeepthinkModuleData[];
    modulesHistory?: DeepthinkModuleData[][];
    moduleRounds?: ModuleRoundSnapshot[];
    modulesGenStatus?: AgentStatus;
    knowledgePacket?: string;
    solutionCritiques: DeepthinkSolutionCritiqueData[];
    solutionCritiquesStatus?: AgentStatus;
    memoryBankAgents?: Array<{ mainStrategyId: string; memoryBank?: string; globalIteration: number }>;
    modulesExplorerComplete?: boolean;
    strategySpecificKnowledgePackets?: Record<string, string>;
    liveEvents?: DeepthinkLiveEvent[];
    currentIteration?: number;
    heartbeatNo?: number;
    prunedBranches?: any[];
    repositoryRevision?: string;
    bsrRecords: BsrGlobalUpdateRecord[];
    branchLedgers: Record<string, BsrLedgerEntry[]>;
    dosOutputs: Array<{
        callType: 'heartbeat' | 'step_i' | 'step_ii';
        iteration: number;
        output: DosOutput;
    }>;
    heartbeats: HeartbeatBlock[];
    modulesImpactReviewHistory: ProximityTurn[];
}

export const SIZE_WEIGHTS: Record<BsrEventSize, number> = { small: 1, medium: 2, large: 4 };
export const TAU = 2;
export const THETA = 0.3;

export interface BsrConfigOptions {
    tau?: number;
    theta?: number;
    weights?: Record<BsrEventSize, number>;
}

export interface WindowScoringResult {
    net: number;
    movement: number;
    windowOutcome: BsrWindowOutcome;
    bestTotal: number;
    lastGoodIteration: number | 'window_start';
    lostGround: number;
    progressKept: number;
}

export function scoreWindow(
    windowStartIteration: number,
    windowEndIteration: number,
    progressEvents: BsrEvent[],
    regressionEvents: BsrEvent[],
    ledgerBeforeWindow: BsrLedgerEntry[],
    options?: { tau?: number; weights?: Record<BsrEventSize, number> }
): WindowScoringResult {
    const tau = options?.tau ?? TAU;
    const weights = options?.weights ?? SIZE_WEIGHTS;
    const iterationChanges = new Map<number, number>();
    for (let it = windowStartIteration; it <= windowEndIteration; it++) iterationChanges.set(it, 0);

    let windowMovement = 0;
    for (const ev of progressEvents) {
        const w = weights[ev.size] ?? 1;
        iterationChanges.set(ev.iteration, (iterationChanges.get(ev.iteration) ?? 0) + w);
        windowMovement += w;
    }
    for (const ev of regressionEvents) {
        const w = weights[ev.size] ?? 1;
        iterationChanges.set(ev.iteration, (iterationChanges.get(ev.iteration) ?? 0) - w);
        windowMovement += w;
    }

    let currentTotal = 0;
    let bestTotal = 0;
    let lastGoodIteration: number | 'window_start' = 'window_start';
    for (let it = windowStartIteration; it <= windowEndIteration; it++) {
        currentTotal += iterationChanges.get(it) ?? 0;
        if (currentTotal > 0 && currentTotal >= bestTotal) {
            bestTotal = currentTotal;
            lastGoodIteration = it;
        }
    }

    const net = currentTotal;
    const windowOutcome: BsrWindowOutcome = net >= tau ? 'PROGRESS' : net <= -tau ? 'REGRESS' : 'STALL';
    const lostGround = windowMovement === 0 && bestTotal === 0 ? 0 : (bestTotal - net) / (windowMovement + tau);

    let netLife = net;
    let movementLife = windowMovement;
    for (const entry of ledgerBeforeWindow) {
        netLife += entry.direction === 'progress' ? entry.weight : -entry.weight;
        movementLife += entry.weight;
    }
    const progressKept = movementLife === 0 ? 0 : Math.max(0, netLife) / (movementLife + tau);

    return { net, movement: windowMovement, windowOutcome, bestTotal, lastGoodIteration, lostGround, progressKept };
}

export function computeWindowEvidence(net: number, movement: number, critiqueAlignmentValue: number, options?: { tau?: number }) {
    const tau = options?.tau ?? TAU;
    const drift = net / (movement + tau);
    const stallEvidence = (1 - Math.max(0, drift)) * Math.max(0, critiqueAlignmentValue);
    return { drift, stallEvidence };
}

export function computePressures(drift: number, lostGround: number, progressKept: number, stallEvidence: number) {
    return {
        CONTINUE: Math.max(0, drift),
        EVOLVE: Math.max(lostGround, stallEvidence * progressKept),
        PRUNE: stallEvidence * (1 - progressKept) * (1 - lostGround),
    };
}

export function decideAction(
    pressures: { CONTINUE: number; EVOLVE: number; PRUNE: number },
    lostGround: number,
    stallEvidence: number,
    progressKept: number,
    lastGoodIteration: number | 'window_start',
    options?: { theta?: number }
): { decision: BsrAction; form?: BsrEvolveForm; rollbackTo?: number | 'window_start' } {
    const theta = options?.theta ?? THETA;
    let decision: BsrAction = 'CONTINUE';
    if (pressures.EVOLVE >= theta || pressures.PRUNE >= theta) {
        if (pressures.CONTINUE >= Math.max(pressures.EVOLVE, pressures.PRUNE)) decision = 'CONTINUE';
        else if (pressures.EVOLVE >= pressures.PRUNE) decision = 'EVOLVE';
        else decision = 'PRUNE';
    }
    if (decision === 'EVOLVE') {
        return lostGround > stallEvidence * progressKept
            ? { decision: 'EVOLVE', form: 'rollback', rollbackTo: lastGoodIteration }
            : { decision: 'EVOLVE', form: 'in_place' };
    }
    return { decision };
}

export function evaluateBranchState(
    report: BsrReport,
    windowStartIteration: number,
    windowEndIteration: number,
    ledgerBeforeWindow: BsrLedgerEntry[],
    options?: BsrConfigOptions
): BsrComputedScores {
    const scoring = scoreWindow(
        windowStartIteration,
        windowEndIteration,
        report.confirmed_progress,
        report.confirmed_regression,
        ledgerBeforeWindow,
        { tau: options?.tau, weights: options?.weights }
    );
    const evidence = computeWindowEvidence(scoring.net, scoring.movement, report.critique_alignment.value, { tau: options?.tau });
    const pressures = computePressures(evidence.drift, scoring.lostGround, scoring.progressKept, evidence.stallEvidence);
    const actionDecision = decideAction(pressures, scoring.lostGround, evidence.stallEvidence, scoring.progressKept, scoring.lastGoodIteration, { theta: options?.theta });
    return {
        net: scoring.net,
        movement: scoring.movement,
        window_outcome: scoring.windowOutcome,
        last_good_iteration: scoring.lastGoodIteration,
        lost_ground: scoring.lostGround,
        progress_kept: scoring.progressKept,
        drift: evidence.drift,
        stall_evidence: evidence.stallEvidence,
        pressure: pressures,
        decision: actionDecision.decision,
        form: actionDecision.form,
        rollback_to: actionDecision.rollbackTo,
    };
}

export function calculateUtilizationVector(branchUtilizations: DosBranchUtilization[]) {
    let c = 0, p = 0, n = 0, m = 0;
    for (const bu of branchUtilizations) {
        if (bu.utilization.classification === 'USED_CORRECTLY') c++;
        else if (bu.utilization.classification === 'USED_PARTIALLY') p++;
        else if (bu.utilization.classification === 'NOT_USED') n++;
        else if (bu.utilization.classification === 'MISUSED') m++;
    }
    const total = c + p + n + m;
    return total === 0 ? undefined : { correct_use: c / total, partial_use: p / total, not_used: n / total, misused: m / total };
}

export type PostIterationAction = { type: 'GLOBAL_UPDATE' } | { type: 'HEARTBEAT' } | { type: 'NONE' };

export function validateLoopBounds(i: number, j: number, k: number): { valid: boolean; error?: string } {
    if (i < 5 || i > 20) return { valid: false, error: `Iteration count i must be between 5 and 20 (got ${i}).` };
    if (j < 3 || j > 8) return { valid: false, error: `Global update frequency j must be between 3 and 8 (got ${j}).` };
    if (k < 2 || k > j) return { valid: false, error: `Heartbeat interval k must be between 2 and j (${j}) (got ${k}).` };
    return { valid: true };
}

export function isHeartbeatDue(n: number, since_heartbeat: number, k: number, j: number, i: number): boolean {
    if (since_heartbeat !== k) return false;
    const nextGlobalUpdate = Math.ceil((n + 0.0001) / j) * j;
    if (nextGlobalUpdate < i && nextGlobalUpdate - n < 2) return false;
    return true;
}

export function determinePostIterationStep(
    n: number,
    currentSinceHeartbeat: number,
    i: number,
    j: number,
    k: number,
    curatedContextEnabled: boolean
): { action: PostIterationAction; nextSinceHeartbeat: number } {
    if (n >= i) return { action: { type: 'NONE' }, nextSinceHeartbeat: currentSinceHeartbeat };
    if (n % j === 0) return { action: { type: 'GLOBAL_UPDATE' }, nextSinceHeartbeat: 0 };
    const incrementedSinceHeartbeat = currentSinceHeartbeat + 1;
    if (curatedContextEnabled && isHeartbeatDue(n, incrementedSinceHeartbeat, k, j, i)) {
        return { action: { type: 'HEARTBEAT' }, nextSinceHeartbeat: 0 };
    }
    return { action: { type: 'NONE' }, nextSinceHeartbeat: incrementedSinceHeartbeat };
}

export interface LoopScheduleSummary {
    standaloneHeartbeats: number;
    globalUpdates: number;
    totalHeartbeats: number;
    heartbeatIterations: number[];
    globalUpdateIterations: number[];
}

export function calculateLoopSchedule(i: number, j: number, k: number, curatedContextEnabled: boolean): LoopScheduleSummary {
    let sinceHeartbeat = 0, standaloneHeartbeats = 0, globalUpdates = 0;
    const heartbeatIterations: number[] = [];
    const globalUpdateIterations: number[] = [];
    for (let n = 1; n <= i; n++) {
        const step = determinePostIterationStep(n, sinceHeartbeat, i, j, k, curatedContextEnabled);
        sinceHeartbeat = step.nextSinceHeartbeat;
        if (step.action.type === 'GLOBAL_UPDATE') {
            globalUpdates++;
            globalUpdateIterations.push(n);
            sinceHeartbeat = 0;
        } else if (step.action.type === 'HEARTBEAT') {
            standaloneHeartbeats++;
            heartbeatIterations.push(n);
            sinceHeartbeat = 0;
        }
    }
    return {
        standaloneHeartbeats,
        globalUpdates,
        totalHeartbeats: standaloneHeartbeats + (curatedContextEnabled ? globalUpdates : 0),
        heartbeatIterations,
        globalUpdateIterations,
    };
}
