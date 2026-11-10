import {
    MAX_MODULES_COUNT,
    MAX_STRATEGY_PROXIMITY_LOOPS,
    MAX_MODULES_IMPACT_REVIEW_LOOPS,
    MAX_DEEPTHINK_DEPTH,
    MAX_DEEPTHINK_STRATEGIES,
    ModelConfigManager,
    type ModelParameters,
} from './ModelConfig.ts';
import { determinePostIterationStep, calculateLoopSchedule } from '../Deepthink/core/types.ts';

export const SANDBOX_API_CALL_MULTIPLIER = { min: 12, max: 36 } as const;

export interface DeepthinkApiCallBreakdown {
    initialStrategy: { min: number; max: number };
    strategyProximity: { min: number; max: number };
    solutionCritique: { min: number; max: number };
    solutionCorrection: { min: number; max: number };
    dos: number;
    modulesGeneration: number;
    modulesImpactReview: number;
    modulesTester: number;
    bsr: number;
    memoryBank: { min: number; max: number };
    standaloneHeartbeats: number;
    globalUpdates: number;
    totalHeartbeats: number;
}

export interface DeepthinkApiCallEstimate {
    min: number;
    max: number;
    baseMin: number;
    baseMax: number;
    breakdown: DeepthinkApiCallBreakdown;
    sandboxMultiplier: { min: number; max: number };
}

export function formatApiCallCount(value: number): string {
    const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
    if (safeValue >= 1_000_000) {
        const millions = safeValue / 1_000_000;
        return (millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)).replace(/\.0$/, '') + 'M';
    }
    if (safeValue >= 1_000) {
        const thousands = safeValue / 1_000;
        return (thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)).replace(/\.0$/, '') + 'k';
    }
    return String(Math.round(safeValue));
}

export function calculateDeepthinkApiCallsFromParams(params: Partial<ModelParameters>): DeepthinkApiCallEstimate {
    const strategiesCount = Math.max(1, Math.min(params.strategiesCount ?? 3, 5));
    const i = Math.max(1, Math.min(params.i ?? params.deepthinkDepth ?? 10, MAX_DEEPTHINK_DEPTH));
    const j = Math.max(3, Math.min(params.j ?? 4, 8));
    const k = Math.max(2, Math.min(params.k ?? 4, j));
    const strategyProximityLoops = Math.max(0, Math.min(MAX_STRATEGY_PROXIMITY_LOOPS, params.strategyProximityLoops ?? 1));
    const modulesCount = Math.max(0, Math.min(MAX_MODULES_COUNT, params.modulesCount ?? 0));
    const modulesImpactReviewLoops = Math.max(0, Math.min(MAX_MODULES_IMPACT_REVIEW_LOOPS, params.modulesImpactReviewLoops ?? 1));

    const curatedContextEnabled = modulesCount > 0;
    const { standaloneHeartbeats, globalUpdates, totalHeartbeats } = calculateLoopSchedule(i, j, k, curatedContextEnabled);

    const seedStrategyCalls = 1 + 2 * strategyProximityLoops;
    const critiqueIterations = i > 1 ? i - 1 : 1;
    const branchIterationCalls = (i + critiqueIterations) * strategiesCount;
    const modCallsPerHeartbeat = modulesCount > 0 ? 1 + 2 * modulesImpactReviewLoops + modulesCount : 0;
    const standaloneHeartbeatCalls = standaloneHeartbeats * ((modulesCount > 0 ? 1 : 0) + modCallsPerHeartbeat);
    const guHeartbeatCalls = curatedContextEnabled ? globalUpdates * modCallsPerHeartbeat : 0;
    const guStepICalls = globalUpdates * (1 + strategiesCount);
    const guStepViCalls = globalUpdates * (modulesCount > 0 ? 1 : 0);
    const guMaintenanceMin = globalUpdates * strategiesCount;
    const guMaintenanceMax = globalUpdates * (seedStrategyCalls + 2 * strategiesCount);

    const commonBase = seedStrategyCalls + branchIterationCalls + standaloneHeartbeatCalls + guHeartbeatCalls + guStepICalls + guStepViCalls;
    const baseMin = commonBase + guMaintenanceMin;
    const baseMax = commonBase + guMaintenanceMax;

    const isSandboxEnabled = params.deepthinkCodeExecutionEnabled === true || (params as any).codeExecutionEnabled === true;
    const minMultiplier = isSandboxEnabled ? SANDBOX_API_CALL_MULTIPLIER.min : 1;
    const maxMultiplier = isSandboxEnabled ? SANDBOX_API_CALL_MULTIPLIER.max : 1;

    const totalHeartbeatsWithMod = modulesCount > 0 ? totalHeartbeats : 0;
    const breakdown: DeepthinkApiCallBreakdown = {
        initialStrategy: {
            min: 1 + strategyProximityLoops,
            max: (1 + strategyProximityLoops) * (1 + globalUpdates),
        },
        strategyProximity: {
            min: strategyProximityLoops,
            max: strategyProximityLoops * (1 + globalUpdates),
        },
        solutionCritique: {
            min: critiqueIterations * strategiesCount,
            max: (critiqueIterations + globalUpdates) * strategiesCount,
        },
        solutionCorrection: {
            min: i * strategiesCount,
            max: (i + globalUpdates) * strategiesCount,
        },
        dos: standaloneHeartbeats * (modulesCount > 0 ? 1 : 0) + globalUpdates * (1 + (modulesCount > 0 ? 1 : 0)),
        modulesGeneration: totalHeartbeatsWithMod * (1 + modulesImpactReviewLoops),
        modulesImpactReview: totalHeartbeatsWithMod * modulesImpactReviewLoops,
        modulesTester: totalHeartbeatsWithMod * modulesCount,
        bsr: globalUpdates * strategiesCount,
        memoryBank: { min: globalUpdates * strategiesCount, max: 0 },
        standaloneHeartbeats,
        globalUpdates,
        totalHeartbeats,
    };

    return {
        min: baseMin * minMultiplier,
        max: baseMax * maxMultiplier,
        baseMin,
        baseMax,
        breakdown,
        sandboxMultiplier: { min: minMultiplier, max: maxMultiplier },
    };
}

export class ApiCallEstimator {
    private readonly countElement: HTMLElement | null;
    constructor(private readonly modelConfig: ModelConfigManager) {
        this.countElement = document.getElementById('api-call-count');
    }

    public updateApiCallDisplay(): void {
        const countEl = (this.countElement && document.contains(this.countElement))
            ? this.countElement
            : document.getElementById('api-call-count');
        if (countEl) {
            const { min, max } = calculateDeepthinkApiCallsFromParams(this.modelConfig.getParameters());
            const formattedMin = formatApiCallCount(min);
            const formattedMax = formatApiCallCount(max);
            countEl.textContent = min === max ? `~${formattedMin}` : `~${formattedMin} to ${formattedMax}`;
        }
    }
}

export interface DeepthinkTokenEstimateInput {
    strategiesCount: number;
    strategyProximityLoops?: number;
    modulesCount: number;
    modulesImpactReviewLoops?: number;
    deepthinkDepth?: number;
    i?: number;
    j?: number;
    k?: number;
    isolateBranches?: boolean;
    codeExecutionEnabled?: boolean;
}

interface TokenRange {
    average: number;
    worst: number;
}

export interface ApiCallRange {
    min: number;
    max: number;
    baseMin?: number;
    baseMax?: number;
    breakdown?: DeepthinkApiCallBreakdown;
    sandboxMultiplier?: { min: number; max: number };
}

export interface DeepthinkTokenEstimate {
    depth: number;
    strategiesCount: number;
    modulesCount: number;
    input: TokenRange;
    output: TokenRange;
    total: TokenRange;
    apiCalls: ApiCallRange;
}

const DEFAULT_ROLE_MAX_OUTPUT_TOKENS = 5_000;
const EXTENDED_ROLE_MAX_OUTPUT_TOKENS = 10_000;

interface TokenProfile {
    promptBase: number;
    harnessNoteTokens: number;
    strategyGenerationOutputPerStrategy: number;
    modulesGenerationOutputPerModule: number;
    strategyProximityOutput: number;
    modulesImpactReviewOutput: number;
    solutionCorrectionOutput: number;
    critiqueOutput: number;
    memoryOutput: number;
    modulesTestOutput: number;
    dosStepIOutput: number;
    dosFullOutput: number;
    dosCoreSynthesisContext: number;
    bsrOutput: number;
    bsrLedgerGrowthPerUpdate: number;
    branchPacketShare: number;
}

export const SANDBOX_PER_CALL = {
    input: { average: 50_000, worst: 350_000 },
    output: { average: 30_000, worst: 250_000 },
};

export const SANDBOX_ITERATION_NOISE = { min: 256_000, max: 512_000 };

export function getRandomSandboxIterationNoise(): number {
    return Math.floor(Math.random() * (SANDBOX_ITERATION_NOISE.max - SANDBOX_ITERATION_NOISE.min + 1)) + SANDBOX_ITERATION_NOISE.min;
}

const WORST_PROFILE: TokenProfile = {
    promptBase: 5_000,
    harnessNoteTokens: 400,
    strategyGenerationOutputPerStrategy: 1_000,
    modulesGenerationOutputPerModule: 800,
    strategyProximityOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    modulesImpactReviewOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    solutionCorrectionOutput: EXTENDED_ROLE_MAX_OUTPUT_TOKENS,
    critiqueOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    memoryOutput: EXTENDED_ROLE_MAX_OUTPUT_TOKENS,
    modulesTestOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    dosStepIOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    dosFullOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    dosCoreSynthesisContext: 3_500,
    bsrOutput: DEFAULT_ROLE_MAX_OUTPUT_TOKENS,
    bsrLedgerGrowthPerUpdate: 800,
    branchPacketShare: 1.0,
};

const AVERAGE_PROFILE: TokenProfile = {
    promptBase: 3_500,
    harnessNoteTokens: 250,
    strategyGenerationOutputPerStrategy: 550,
    modulesGenerationOutputPerModule: 450,
    strategyProximityOutput: 2_000,
    modulesImpactReviewOutput: 2_000,
    solutionCorrectionOutput: 6_000,
    critiqueOutput: 2_400,
    memoryOutput: 5_500,
    modulesTestOutput: 2_800,
    dosStepIOutput: 2_200,
    dosFullOutput: 3_000,
    dosCoreSynthesisContext: 1_800,
    bsrOutput: 1_800,
    bsrLedgerGrowthPerUpdate: 400,
    branchPacketShare: 0.5,
};

type SampledBsrDecision = 'CONTINUE' | 'EVOLVE' | 'PRUNE';

function sampleGlobalUpdateDecisions(strategyCount: number): SampledBsrDecision[] {
    return Array.from({ length: strategyCount }, () => {
        const roll = Math.random();
        return roll < 0.35 ? 'CONTINUE' : roll < 0.70 ? 'EVOLVE' : 'PRUNE';
    });
}

function computeProximityLoopTokens(
    baseContextInput: number,
    proximityLoops: number,
    generatorTurnOutput: number,
    proximityTurnOutput: number
) {
    let inputTokens = 0, outputTokens = 0, accumulatedLoopTranscript = 0;
    for (let reviewIdx = 0; reviewIdx <= proximityLoops; reviewIdx++) {
        inputTokens += baseContextInput + accumulatedLoopTranscript;
        outputTokens += generatorTurnOutput;
        accumulatedLoopTranscript += generatorTurnOutput;
        if (reviewIdx < proximityLoops) {
            inputTokens += baseContextInput + accumulatedLoopTranscript;
            outputTokens += proximityTurnOutput;
            accumulatedLoopTranscript += proximityTurnOutput;
        }
    }
    return { inputTokens, outputTokens, transcriptTokens: accumulatedLoopTranscript };
}

function clampInteger(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

interface BranchSimState {
    hasMemoryBank: boolean;
    preUpdatePairTokens: number;
    windowHistoryTokens: number;
    latestSolutionTokens: number;
    latestCritiqueTokens: number;
    updatesSurvived: number;
}

function simulatePipelineTokens(
    profile: TokenProfile,
    strategyCount: number,
    strategyProximityLoops: number,
    modulesCount: number,
    modulesImpactReviewLoops: number,
    i: number,
    j: number,
    k: number,
    isolateBranches: boolean,
    sampledDecisionsPerUpdate?: SampledBsrDecision[][]
): { input: number; output: number } {
    let totalInput = 0, totalOutput = 0;
    const strategyTextTokens = profile.strategyGenerationOutputPerStrategy;
    const moduleItemTokens = profile.modulesGenerationOutputPerModule;

    const seedGenTurnOutput = Math.min(DEFAULT_ROLE_MAX_OUTPUT_TOKENS, strategyCount * strategyTextTokens);
    const seedLoop = computeProximityLoopTokens(profile.promptBase, strategyProximityLoops, seedGenTurnOutput, profile.strategyProximityOutput);
    totalInput += seedLoop.inputTokens;
    totalOutput += seedLoop.outputTokens;

    let strategiesFinalizedAndUsedCount = strategyCount;
    let modulesFinalizedAndUsedCount = 0;

    const branches: BranchSimState[] = Array.from({ length: strategyCount }, () => ({
        hasMemoryBank: false,
        preUpdatePairTokens: 0,
        windowHistoryTokens: 0,
        latestSolutionTokens: 0,
        latestCritiqueTokens: 0,
        updatesSurvived: 0,
    }));

    const curatedContextEnabled = modulesCount > 0;
    let sinceHeartbeat = 0, heartbeatNo = 0, globalUpdateNo = 0;

    const runHeartbeatModulesAndTesters = (currentHbNo: number) => {
        let hbActiveContextTokens = profile.harnessNoteTokens;
        if (currentHbNo === 1) {
            const activeStrategiesTokens = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens, 0);
            hbActiveContextTokens += activeStrategiesTokens + profile.dosCoreSynthesisContext;
        } else {
            const prevModAndTestsTokens = modulesCount * (moduleItemTokens + profile.modulesTestOutput);
            const mappedPacketsSchemaTokens = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens + 80, 0);
            const realizedFeedbackTokens = modulesCount * 350;
            const usedSoFarTokens = modulesFinalizedAndUsedCount * moduleItemTokens;
            hbActiveContextTokens += prevModAndTestsTokens + mappedPacketsSchemaTokens + realizedFeedbackTokens + usedSoFarTokens + profile.dosCoreSynthesisContext;
        }

        const hbBaseInput = profile.promptBase + hbActiveContextTokens;
        const modGenTurnOutput = Math.min(DEFAULT_ROLE_MAX_OUTPUT_TOKENS, modulesCount * moduleItemTokens);
        const modLoop = computeProximityLoopTokens(hbBaseInput, modulesImpactReviewLoops, modGenTurnOutput, profile.modulesImpactReviewOutput);
        totalInput += modLoop.inputTokens;
        totalOutput += modLoop.outputTokens;

        modulesFinalizedAndUsedCount += modulesCount;

        totalInput += modulesCount * (profile.promptBase + moduleItemTokens);
        totalOutput += modulesCount * profile.modulesTestOutput;
    };

    for (let n = 1; n <= i; n++) {
        if (n === 1) {
            for (const branch of branches) {
                const execInput = profile.promptBase + strategyTextTokens;
                const execOutput = profile.solutionCorrectionOutput;
                const critiqueInput = profile.promptBase + strategyTextTokens + execOutput;
                const critiqueOutput = profile.critiqueOutput;
                totalInput += execInput + critiqueInput;
                totalOutput += execOutput + critiqueOutput;
                branch.latestSolutionTokens = execOutput;
                branch.latestCritiqueTokens = critiqueOutput;
                branch.windowHistoryTokens = execOutput + critiqueOutput;
            }
        } else {
            const totalAllBranchesLatestPairs = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens + b.latestCritiqueTokens, 0);
            const mappedPacketTokens = (curatedContextEnabled && heartbeatNo >= 1)
                ? modulesCount * profile.branchPacketShare * (moduleItemTokens + profile.modulesTestOutput)
                : 0;

            for (const branch of branches) {
                const ownLatestPair = strategyTextTokens + branch.latestSolutionTokens + branch.latestCritiqueTokens;
                const peerContextTokens = isolateBranches ? 0 : Math.max(0, totalAllBranchesLatestPairs - ownLatestPair);
                const memBankTokens = branch.hasMemoryBank ? profile.memoryOutput : 0;
                const preUpdateTokens = branch.preUpdatePairTokens;
                const windowTokens = branch.windowHistoryTokens;

                const correctionInput = profile.promptBase + strategyTextTokens + preUpdateTokens + memBankTokens + mappedPacketTokens + windowTokens + peerContextTokens;
                const correctionOutput = profile.solutionCorrectionOutput;
                totalInput += correctionInput;
                totalOutput += correctionOutput;
                branch.latestSolutionTokens = correctionOutput;
                branch.windowHistoryTokens += correctionOutput;

                if (n < i) {
                    const critiqueInput = profile.promptBase + strategyTextTokens + preUpdateTokens + memBankTokens + windowTokens + correctionOutput;
                    const critiqueOutput = profile.critiqueOutput;
                    totalInput += critiqueInput;
                    totalOutput += critiqueOutput;
                    branch.latestCritiqueTokens = critiqueOutput;
                    branch.windowHistoryTokens += critiqueOutput;
                }
            }
        }

        const step = determinePostIterationStep(n, sinceHeartbeat, i, j, k, curatedContextEnabled);
        sinceHeartbeat = step.nextSinceHeartbeat;

        if (n >= i) {
            break;
        } else if (step.action.type === 'HEARTBEAT') {
            heartbeatNo++;
            if (curatedContextEnabled) {
                const activeBranchesTokens = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens + b.latestCritiqueTokens, 0);
                const prevModAndTestsForDos = heartbeatNo >= 2 ? modulesCount * (moduleItemTokens + profile.modulesTestOutput) : 0;
                totalInput += profile.promptBase + profile.harnessNoteTokens + activeBranchesTokens + prevModAndTestsForDos;
                totalOutput += profile.dosFullOutput;
                runHeartbeatModulesAndTesters(heartbeatNo);
            }
            sinceHeartbeat = 0;
        } else if (step.action.type === 'GLOBAL_UPDATE') {
            globalUpdateNo++;
            const decisions = sampledDecisionsPerUpdate?.[globalUpdateNo - 1] ?? sampleGlobalUpdateDecisions(strategyCount);

            const activeBranchesTokens = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens + b.latestCritiqueTokens, 0);
            totalInput += profile.promptBase + profile.harnessNoteTokens + activeBranchesTokens;
            totalOutput += profile.dosStepIOutput;

            for (const branch of branches) {
                const memBeforeWindowTokens = branch.hasMemoryBank ? profile.memoryOutput : 0;
                const ledgerTokens = branch.updatesSurvived * profile.bsrLedgerGrowthPerUpdate;
                totalInput += profile.promptBase + strategyTextTokens + memBeforeWindowTokens + ledgerTokens + branch.windowHistoryTokens;
                totalOutput += profile.bsrOutput;
            }

            const changedCount = decisions.filter(d => d !== 'CONTINUE').length;
            if (changedCount > 0) {
                const activeStrategiesAndLatestCorrections = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens, 0);
                const consolidatedBsrDecisionsTokens = strategyCount * 250;
                const strategiesUsedSoFarTokens = strategiesFinalizedAndUsedCount * strategyTextTokens;
                const guContextTokens = profile.harnessNoteTokens + activeStrategiesAndLatestCorrections + consolidatedBsrDecisionsTokens + profile.dosCoreSynthesisContext + strategiesUsedSoFarTokens;
                const guStratBaseInput = profile.promptBase + guContextTokens;
                const guStratGenTurnOutput = Math.min(DEFAULT_ROLE_MAX_OUTPUT_TOKENS, changedCount * strategyTextTokens);
                const guStratLoop = computeProximityLoopTokens(guStratBaseInput, strategyProximityLoops, guStratGenTurnOutput, profile.strategyProximityOutput);
                totalInput += guStratLoop.inputTokens;
                totalOutput += guStratLoop.outputTokens;
                strategiesFinalizedAndUsedCount += changedCount;
            }

            for (let s = 0; s < strategyCount; s++) {
                const branch = branches[s];
                const decision = decisions[s];
                if (decision === 'CONTINUE' || decision === 'EVOLVE') {
                    const prevMemTokens = branch.hasMemoryBank ? profile.memoryOutput : 0;
                    totalInput += profile.promptBase + strategyTextTokens + prevMemTokens + branch.windowHistoryTokens;
                    totalOutput += profile.memoryOutput;
                    branch.hasMemoryBank = true;
                    branch.preUpdatePairTokens = branch.latestSolutionTokens + branch.latestCritiqueTokens;
                    branch.windowHistoryTokens = 0;
                    branch.updatesSurvived += 1;
                } else {
                    const execInput = profile.promptBase + strategyTextTokens;
                    const execOutput = profile.solutionCorrectionOutput;
                    const critiqueInput = profile.promptBase + strategyTextTokens + execOutput;
                    const critiqueOutput = profile.critiqueOutput;
                    totalInput += execInput + critiqueInput;
                    totalOutput += execOutput + critiqueOutput;
                    branch.hasMemoryBank = false;
                    branch.latestSolutionTokens = execOutput;
                    branch.latestCritiqueTokens = critiqueOutput;
                    branch.preUpdatePairTokens = execOutput + critiqueOutput;
                    branch.windowHistoryTokens = 0;
                    branch.updatesSurvived = 0;
                }
            }

            heartbeatNo++;
            if (curatedContextEnabled) {
                const postUpdateBranchesTokens = branches.reduce((acc, b) => acc + strategyTextTokens + b.latestSolutionTokens + b.latestCritiqueTokens, 0);
                const prevModAndTestsForStepIi = heartbeatNo >= 2 ? modulesCount * (moduleItemTokens + profile.modulesTestOutput) : 0;
                const slotStatusesTokens = strategyCount * 80;
                totalInput += profile.promptBase + profile.harnessNoteTokens + slotStatusesTokens + profile.dosStepIOutput + prevModAndTestsForStepIi + postUpdateBranchesTokens;
                totalOutput += profile.dosFullOutput;
                runHeartbeatModulesAndTesters(heartbeatNo);
            }
            sinceHeartbeat = 0;
        }
    }

    return { input: Math.round(totalInput), output: Math.round(totalOutput) };
}

export function calculateDeepthinkTokenEstimate(args: DeepthinkTokenEstimateInput): DeepthinkTokenEstimate {
    const strategiesCount = clampInteger(args.strategiesCount, 1, MAX_DEEPTHINK_STRATEGIES);
    const strategyProximityLoops = clampInteger(args.strategyProximityLoops ?? 1, 0, MAX_STRATEGY_PROXIMITY_LOOPS);
    const modulesCount = clampInteger(args.modulesCount, 0, MAX_MODULES_COUNT);
    const modulesImpactReviewLoops = clampInteger(args.modulesImpactReviewLoops ?? 1, 0, MAX_MODULES_IMPACT_REVIEW_LOOPS);
    const i = clampInteger(args.i ?? args.deepthinkDepth ?? 10, 1, MAX_DEEPTHINK_DEPTH);
    const j = clampInteger(args.j ?? 4, 3, 8);
    const k = clampInteger(args.k ?? 4, 2, j);
    const isolateBranches = args.codeExecutionEnabled === true || args.isolateBranches === true;

    const maxUpdates = Math.floor(Math.max(0, i - 1) / j);
    const sampledDecisionsPerUpdate = Array.from({ length: maxUpdates }, () => sampleGlobalUpdateDecisions(strategiesCount));

    const averageSim = simulatePipelineTokens(AVERAGE_PROFILE, strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, i, j, k, isolateBranches, sampledDecisionsPerUpdate);
    const worstSim = simulatePipelineTokens(WORST_PROFILE, strategiesCount, strategyProximityLoops, modulesCount, modulesImpactReviewLoops, i, j, k, isolateBranches, sampledDecisionsPerUpdate);

    const apiCalls = calculateDeepthinkApiCallsFromParams({
        strategiesCount,
        strategyProximityLoops,
        modulesCount,
        modulesImpactReviewLoops,
        i,
        j,
        k,
        codeExecutionEnabled: args.codeExecutionEnabled,
        deepthinkCodeExecutionEnabled: args.codeExecutionEnabled,
    } as any);

    const minMultiplier = args.codeExecutionEnabled ? (apiCalls.sandboxMultiplier?.min ?? 12) : 1;
    const maxMultiplier = args.codeExecutionEnabled ? (apiCalls.sandboxMultiplier?.max ?? 36) : 1;

    const sandboxInputAvg = args.codeExecutionEnabled && apiCalls.baseMin ? apiCalls.baseMin * SANDBOX_PER_CALL.input.average : 0;
    const sandboxInputWorst = args.codeExecutionEnabled && apiCalls.baseMax ? apiCalls.baseMax * SANDBOX_PER_CALL.input.worst : 0;
    const sandboxOutputAvg = args.codeExecutionEnabled && apiCalls.baseMin ? apiCalls.baseMin * SANDBOX_PER_CALL.output.average : 0;
    const sandboxOutputWorst = args.codeExecutionEnabled && apiCalls.baseMax ? apiCalls.baseMax * SANDBOX_PER_CALL.output.worst : 0;

    let sandboxIterationNoiseAvg = 0, sandboxIterationNoiseWorst = 0;
    if (args.codeExecutionEnabled) {
        for (let iter = 1; iter <= i; iter++) {
            sandboxIterationNoiseAvg += getRandomSandboxIterationNoise();
            sandboxIterationNoiseWorst += getRandomSandboxIterationNoise();
        }
        if (sandboxIterationNoiseWorst < sandboxIterationNoiseAvg) {
            [sandboxIterationNoiseAvg, sandboxIterationNoiseWorst] = [sandboxIterationNoiseWorst, sandboxIterationNoiseAvg];
        }
    }

    const totalAverageInput = averageSim.input * minMultiplier + sandboxInputAvg + sandboxIterationNoiseAvg;
    const totalWorstInput = worstSim.input * maxMultiplier + sandboxInputWorst + sandboxIterationNoiseWorst;
    const totalAverageOutput = averageSim.output + sandboxOutputAvg;
    const totalWorstOutput = worstSim.output + sandboxOutputWorst;

    return {
        depth: i,
        strategiesCount,
        modulesCount,
        input: { average: totalAverageInput, worst: totalWorstInput },
        output: { average: totalAverageOutput, worst: totalWorstOutput },
        total: { average: totalAverageInput + totalAverageOutput, worst: totalWorstInput + totalWorstOutput },
        apiCalls,
    };
}

export function buildDeepthinkTokenTrend(args: Omit<DeepthinkTokenEstimateInput, 'deepthinkDepth' | 'i'> & { maxDepth?: number }): DeepthinkTokenEstimate[] {
    const maxDepth = clampInteger(args.maxDepth ?? MAX_DEEPTHINK_DEPTH, 1, MAX_DEEPTHINK_DEPTH);
    return Array.from({ length: maxDepth }, (_, index) => calculateDeepthinkTokenEstimate({
        ...args,
        deepthinkDepth: index + 1,
        i: index + 1,
    }));
}
