/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    MAX_MODULES_COUNT,
    MAX_STRATEGY_PROXIMITY_LOOPS,
    MAX_MODULES_IMPACT_REVIEW_LOOPS,
    MAX_DEEPTHINK_DEPTH,
    ModelConfigManager,
    type ModelParameters,
} from './ModelConfig.ts';
import { calculateLoopSchedule } from '../Deepthink/core/loopController.ts';

export const SANDBOX_API_CALL_MULTIPLIER = {
    min: 12,
    max: 36,
} as const;

export interface DeepthinkApiCallBreakdown {
    initialStrategy: { min: number; max: number };
    strategyProximity: { min: number; max: number };
    solutionAttempt: { min: number; max: number };
    solutionCritique: { min: number; max: number };
    solutionCorrection: number;
    dos: number;
    modulesGeneration: number;
    modulesImpactReview: number;
    modulesTester: number;
    bsr: number;
    memoryBank: { min: number; max: number };
    finalJudge: number;
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
        return (thousands >= 100 ? thousands.toFixed(0) : (thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1))).replace(/\.0$/, '') + 'k';
    }
    return String(Math.round(safeValue));
}

export function calculateDeepthinkApiCallsFromParams(params: ModelParameters): DeepthinkApiCallEstimate {
    const strategiesCount = Math.max(1, Math.min(params.strategiesCount ?? 3, 5));
    const i = Math.max(1, Math.min(params.i ?? params.deepthinkDepth ?? 10, MAX_DEEPTHINK_DEPTH));
    const j = Math.max(3, Math.min(params.j ?? 4, 8));
    const k = Math.max(2, Math.min(params.k ?? 4, j));
    const strategyProximityLoops = Math.max(0, Math.min(MAX_STRATEGY_PROXIMITY_LOOPS, params.strategyProximityLoops ?? 1));
    const modulesCount = Math.max(0, Math.min(MAX_MODULES_COUNT, params.modulesCount ?? 0));
    const modulesImpactReviewLoops = Math.max(0, Math.min(MAX_MODULES_IMPACT_REVIEW_LOOPS, params.modulesImpactReviewLoops ?? 1));

    const curatedContextEnabled = modulesCount > 0;
    const schedule = calculateLoopSchedule(i, j, k, curatedContextEnabled);
    const { standaloneHeartbeats, globalUpdates, totalHeartbeats } = schedule;

    // 1. Seed Strategy Generation (§4.1):
    // 1 generator + 2 * strategyProximityLoops turns (gen + prox)
    const seedStrategyCalls = 1 + (2 * strategyProximityLoops);

    // 2. Baseline Branch Iterations (§3):
    // Iteration 1: S attempts + S critiques = 2S
    // Iterations 2..i: S corrections + S critiques = 2S * (i - 1)
    // Total for all i iterations is 2i * S
    const branchIterationCalls = 2 * i * strategiesCount;

    // 3. Heartbeats (§4.5):
    // Per heartbeat with modules: (1 + 2 * modulesImpactReviewLoops) + modulesCount testers
    const modCallsPerHeartbeat = modulesCount > 0
        ? (1 + (2 * modulesImpactReviewLoops)) + modulesCount
        : 0;

    // Standalone heartbeats run their own Heartbeat DOS call when modules enabled (§5.1)
    const standaloneHeartbeatCalls = standaloneHeartbeats * (
        (modulesCount > 0 ? 1 : 0) +
        modCallsPerHeartbeat
    );

    // Heartbeat ending Global Update reuses Step-ii DOS (0 extra DOS calls per §4.5, §4.6 vii)
    const guHeartbeatCalls = curatedContextEnabled
        ? globalUpdates * modCallsPerHeartbeat
        : 0;

    // 4. Global Updates (§4.6):
    // Step i: 1 Step-i DOS + S BSR agents
    const guStepICalls = globalUpdates * (1 + strategiesCount);

    // Step vi: 1 Step-ii DOS (only when modules enabled)
    const guStepViCalls = globalUpdates * (modulesCount > 0 ? 1 : 0);

    // Step iii & Step v maintenance:
    // Min case: 0 strategy updates (all CONTINUE), S memory bank distillations
    const guMaintenanceMin = globalUpdates * strategiesCount;

    // Max case: changed slots run strategy generator + proximity (1 + 2 * strategyProximityLoops),
    // and pruned slots run first execution + critique (2 * S)
    const guMaintenanceMax = globalUpdates * (
        seedStrategyCalls +
        (2 * strategiesCount)
    );

    // 5. Final Judge (§7, §9): 1 call
    const finalJudgeCalls = 1;

    const baseMin = seedStrategyCalls +
        branchIterationCalls +
        standaloneHeartbeatCalls +
        guHeartbeatCalls +
        guStepICalls +
        guStepViCalls +
        guMaintenanceMin +
        finalJudgeCalls;

    const baseMax = seedStrategyCalls +
        branchIterationCalls +
        standaloneHeartbeatCalls +
        guHeartbeatCalls +
        guStepICalls +
        guStepViCalls +
        guMaintenanceMax +
        finalJudgeCalls;

    const isSandboxEnabled = params.deepthinkCodeExecutionEnabled === true || (params as any).codeExecutionEnabled === true;
    const minMultiplier = isSandboxEnabled ? SANDBOX_API_CALL_MULTIPLIER.min : 1;
    const maxMultiplier = isSandboxEnabled ? SANDBOX_API_CALL_MULTIPLIER.max : 1;

    const min = baseMin * minMultiplier;
    const max = baseMax * maxMultiplier;

    const totalHeartbeatsWithMod = modulesCount > 0 ? totalHeartbeats : 0;

    const breakdown: DeepthinkApiCallBreakdown = {
        initialStrategy: {
            min: 1 + strategyProximityLoops,
            max: (1 + strategyProximityLoops) + (globalUpdates * (1 + strategyProximityLoops)),
        },
        strategyProximity: {
            min: strategyProximityLoops,
            max: strategyProximityLoops + (globalUpdates * strategyProximityLoops),
        },
        solutionAttempt: {
            min: strategiesCount,
            max: strategiesCount + (globalUpdates * strategiesCount),
        },
        solutionCritique: {
            min: i * strategiesCount,
            max: (i * strategiesCount) + (globalUpdates * strategiesCount),
        },
        solutionCorrection: Math.max(0, i - 1) * strategiesCount,
        dos: (standaloneHeartbeats * (modulesCount > 0 ? 1 : 0)) +
            (globalUpdates * 1) +
            (globalUpdates * (modulesCount > 0 ? 1 : 0)),
        modulesGeneration: totalHeartbeatsWithMod * (1 + modulesImpactReviewLoops),
        modulesImpactReview: totalHeartbeatsWithMod * modulesImpactReviewLoops,
        modulesTester: totalHeartbeatsWithMod * modulesCount,
        bsr: globalUpdates * strategiesCount,
        memoryBank: {
            min: globalUpdates * strategiesCount,
            max: 0,
        },
        finalJudge: finalJudgeCalls,
        standaloneHeartbeats,
        globalUpdates,
        totalHeartbeats,
    };

    return {
        min,
        max,
        baseMin,
        baseMax,
        breakdown,
        sandboxMultiplier: { min: minMultiplier, max: maxMultiplier },
    };
}

export class ApiCallEstimator {
    private readonly countElement: HTMLElement | null;
    private readonly modelConfig: ModelConfigManager;

    constructor(modelConfig: ModelConfigManager) {
        this.modelConfig = modelConfig;
        this.countElement = document.getElementById('api-call-count');
    }

    private calculateDeepthinkApiCalls(): { min: number; max: number } {
        return calculateDeepthinkApiCallsFromParams(this.modelConfig.getParameters());
    }

    public updateApiCallDisplay(): void {
        const countEl = (this.countElement && document.contains(this.countElement))
            ? this.countElement
            : document.getElementById('api-call-count');
        if (countEl) {
            const { min, max } = this.calculateDeepthinkApiCalls();
            const formattedMin = formatApiCallCount(min);
            const formattedMax = formatApiCallCount(max);
            countEl.textContent = min === max ? `~${formattedMin}` : `~${formattedMin} to ${formattedMax}`;
        }
    }
}
