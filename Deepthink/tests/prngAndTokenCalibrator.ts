import { countTextTokens } from '../core/sharedWorkspace.ts';
import type { DeepthinkRunConfig } from '../core/types.ts';
import { BSR_WEIGHT_PRESETS, type BsrWeightPresetId } from '../../Routing/ModelConfig.ts';

export type DeepthinkOrchestratorConfig = DeepthinkRunConfig;

export class SeededPRNG {
    private state: number;
    public readonly initialSeed: number;

    constructor(seed: number) {
        this.initialSeed = seed >>> 0;
        this.state = this.initialSeed === 0 ? 0x6d2b79f5 : this.initialSeed;
    }

    public next(): number {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    public nextUint32(): number {
        return Math.floor(this.next() * 0x100000000) >>> 0;
    }

    public nextInt(minInclusive: number, maxInclusive: number): number {
        if (maxInclusive <= minInclusive) return minInclusive;
        const span = maxInclusive - minInclusive + 1;
        return minInclusive + Math.floor(this.next() * span);
    }

    public nextFloat(minInclusive: number, maxInclusive: number, decimals = 2): number {
        const raw = minInclusive + this.next() * (maxInclusive - minInclusive);
        const factor = Math.pow(10, decimals);
        return Math.round(raw * factor) / factor;
    }

    public nextBool(probabilityTrue = 0.5): boolean {
        return this.next() < probabilityTrue;
    }

    public pick<T>(items: readonly T[]): T {
        if (items.length === 0) {
            throw new Error('Cannot pick from an empty array.');
        }
        return items[this.nextInt(0, items.length - 1)];
    }

    public shuffle<T>(items: readonly T[]): T[] {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = this.nextInt(0, i);
            const tmp = copy[i];
            copy[i] = copy[j];
            copy[j] = tmp;
        }
        return copy;
    }

    public forkForCoordinate(...parts: Array<string | number | boolean | undefined>): SeededPRNG {
        const key = parts.map(p => String(p ?? '')).join('|');
        const hashed = fnv1a32(key, this.initialSeed);
        return new SeededPRNG(hashed);
    }
}

export function fnv1a32(input: string, seed = 0x811c9dc5): number {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export function synthesizeExactTokenPayload(targetTokens: number, prefix = 'VERIFIED_SECTION:'): string {
    if (targetTokens <= 0) return '';

    const cleanPrefix = prefix.trim();
    const prefixTokens = countTextTokens(cleanPrefix);
    if (prefixTokens >= targetTokens) {
        const unit = ' alpha';
        let acc = 'alpha';
        while (countTextTokens(acc) < targetTokens) {
            const remaining = targetTokens - countTextTokens(acc);
            acc += unit.repeat(Math.max(1, remaining));
        }
        while (countTextTokens(acc) > targetTokens) {
            acc = acc.slice(0, acc.lastIndexOf(' '));
        }
        return acc;
    }

    const fillerWord = ' alpha';
    const base = cleanPrefix;
    const needed = targetTokens - prefixTokens;
    let candidate = base + fillerWord.repeat(needed);
    let current = countTextTokens(candidate);

    while (current < targetTokens) {
        candidate += fillerWord.repeat(targetTokens - current);
        current = countTextTokens(candidate);
    }
    while (current > targetTokens) {
        const lastSpace = candidate.lastIndexOf(' alpha');
        if (lastSpace <= cleanPrefix.length) break;
        candidate = candidate.slice(0, lastSpace);
        current = countTextTokens(candidate);
    }

    if (current !== targetTokens) {
        throw new Error(`Token calibrator failed to hit exact target ${targetTokens} (got ${current})`);
    }
    return candidate;
}

export type ForcedSlotBehavior = 'AUTO' | 'FORCE_CONTINUE' | 'FORCE_EVOLVE_IN_PLACE' | 'FORCE_EVOLVE_SCROLLBACK' | 'FORCE_EVOLVE_WINDOW_START' | 'FORCE_PRUNE';

export interface SeededRunSpec {
    runIndex: number;
    seed: number;
    label: string;
    config: DeepthinkRunConfig;
    forcedSlotBehaviors?: Record<string, ForcedSlotBehavior[]>;
    enableAsyncJitter: boolean;
    maxJitterMs: number;
}

export function buildOrchestratorConfigFromParams(params: {
    i: number;
    j: number;
    k: number;
    strategiesCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    isolateBranches: boolean;
    deepthinkCodeExecutionEnabled: boolean;
    bsrWeightPreset?: BsrWeightPresetId;
    bsrNoiseLevel?: number;
    bsrPressureFloor?: number;
}): DeepthinkRunConfig {
    const presetId = params.bsrWeightPreset ?? 'standard';
    const preset = BSR_WEIGHT_PRESETS.find(p => p.id === presetId) ?? BSR_WEIGHT_PRESETS[0];
    return {
        model: 'gemini-3.5-flash-synthetic',
        i: params.i,
        j: params.j,
        k: params.k,
        strategiesCount: params.strategiesCount,
        strategyProximityLoops: params.strategyProximityLoops,
        modulesCount: params.modulesCount,
        modulesImpactReviewLoops: params.modulesImpactReviewLoops,
        isolateBranches: params.deepthinkCodeExecutionEnabled ? true : params.isolateBranches,
        deepthinkCodeExecutionEnabled: params.deepthinkCodeExecutionEnabled,
        bsrNoiseLevel: params.bsrNoiseLevel ?? 2,
        bsrPressureFloor: params.bsrPressureFloor ?? 0.3,
        bsrWeightSmall: preset.weights.small,
        bsrWeightMedium: preset.weights.medium,
        bsrWeightLarge: preset.weights.large,
        bsrWeightPreset: preset.id,
    };
}

export function generateSeededConfigMatrix(
    masterSeed = Number(process.env.DEEPTHINK_TEST_SEED || 0xDEADBEEF),
    requestedRuns = Number(process.env.DEEPTHINK_TEST_RUNS || 36)
): SeededRunSpec[] {
    const totalRuns = Math.max(1, Math.min(200, requestedRuns));
    const prng = new SeededPRNG(masterSeed);
    const specs: SeededRunSpec[] = [];

    const curatedConfigs: Array<{
        label: string;
        params: Parameters<typeof buildOrchestratorConfigFromParams>[0];
        forcedSlotBehaviors?: Record<string, ForcedSlotBehavior[]>;
    }> = [
        {
            label: 'boundary-no-global-update-j-gt-i',
            params: {
                i: 5, j: 8, k: 2,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
        },
        {
            label: 'boundary-skipped-heartbeat-i14-j6-k5',
            params: {
                i: 14, j: 6, k: 5,
                strategiesCount: 3, strategyProximityLoops: 1,
                modulesCount: 3, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_CONTINUE', 'FORCE_EVOLVE_IN_PLACE'],
                main2: ['FORCE_EVOLVE_SCROLLBACK', 'FORCE_CONTINUE'],
                main3: ['FORCE_PRUNE', 'FORCE_PRUNE'],
            },
        },
        {
            label: 'boundary-zero-modules-m0-multi-update',
            params: {
                i: 9, j: 3, k: 2,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 0, modulesImpactReviewLoops: 1,
                isolateBranches: true, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'flattened',
            },
        },
        {
            label: 'boundary-all-continue-skip-surgical-sg',
            params: {
                i: 7, j: 3, k: 3,
                strategiesCount: 3, strategyProximityLoops: 2,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'steepened',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_CONTINUE', 'FORCE_CONTINUE'],
                main2: ['FORCE_CONTINUE', 'FORCE_CONTINUE'],
                main3: ['FORCE_CONTINUE', 'FORCE_CONTINUE'],
            },
        },
        {
            label: 'boundary-rollback-window-start-update1-and-update2',
            params: {
                i: 9, j: 4, k: 2,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_EVOLVE_WINDOW_START', 'FORCE_CONTINUE'],
                main2: ['FORCE_CONTINUE', 'FORCE_EVOLVE_WINDOW_START'],
            },
        },
        {
            label: 'boundary-sandbox-enabled-continuous-loops',
            params: {
                i: 7, j: 3, k: 2,
                strategiesCount: 2, strategyProximityLoops: 2,
                modulesCount: 2, modulesImpactReviewLoops: 2,
                isolateBranches: true, deepthinkCodeExecutionEnabled: true,
                bsrWeightPreset: 'standard',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_CONTINUE', 'FORCE_EVOLVE_IN_PLACE'],
                main2: ['FORCE_PRUNE', 'FORCE_EVOLVE_SCROLLBACK'],
            },
        },
        {
            label: 'boundary-single-strategy-n1-no-peers',
            params: {
                i: 6, j: 3, k: 2,
                strategiesCount: 1, strategyProximityLoops: 1,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
        },
        {
            label: 'boundary-max-strategies-n5-max-modules-m6',
            params: {
                i: 6, j: 3, k: 3,
                strategiesCount: 5, strategyProximityLoops: 1,
                modulesCount: 6, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
        },
        {
            label: 'boundary-max-depth-i20-four-global-updates-reframed-notes',
            params: {
                i: 20, j: 4, k: 2,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_CONTINUE', 'FORCE_EVOLVE_IN_PLACE', 'FORCE_EVOLVE_SCROLLBACK', 'FORCE_CONTINUE'],
                main2: ['FORCE_PRUNE', 'FORCE_EVOLVE_IN_PLACE', 'FORCE_PRUNE', 'FORCE_EVOLVE_WINDOW_START'],
            },
        },
        {
            label: 'boundary-zero-proximity-and-impact-loops',
            params: {
                i: 7, j: 3, k: 2,
                strategiesCount: 2, strategyProximityLoops: 0,
                modulesCount: 2, modulesImpactReviewLoops: 0,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'flattened',
            },
        },
        {
            label: 'boundary-all-prune-every-update',
            params: {
                i: 8, j: 3, k: 3,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 2, modulesImpactReviewLoops: 1,
                isolateBranches: false, deepthinkCodeExecutionEnabled: false,
                bsrWeightPreset: 'standard',
            },
            forcedSlotBehaviors: {
                main1: ['FORCE_PRUNE', 'FORCE_PRUNE'],
                main2: ['FORCE_PRUNE', 'FORCE_PRUNE'],
            },
        },
        {
            label: 'boundary-sandbox-zero-modules-isolated',
            params: {
                i: 6, j: 3, k: 2,
                strategiesCount: 2, strategyProximityLoops: 1,
                modulesCount: 0, modulesImpactReviewLoops: 1,
                isolateBranches: true, deepthinkCodeExecutionEnabled: true,
                bsrWeightPreset: 'steepened',
            },
        },
    ];

    const presets: BsrWeightPresetId[] = ['standard', 'flattened', 'steepened'];
    for (let idx = 0; idx < totalRuns; idx++) {
        const runSeed = prng.nextUint32();
        const runPrng = new SeededPRNG(runSeed);

        if (idx < curatedConfigs.length) {
            const curated = curatedConfigs[idx];
            specs.push({
                runIndex: idx,
                seed: runSeed,
                label: curated.label,
                config: buildOrchestratorConfigFromParams(curated.params),
                forcedSlotBehaviors: curated.forcedSlotBehaviors,
                enableAsyncJitter: true,
                maxJitterMs: 8,
            });
            continue;
        }

        const i = runPrng.nextInt(5, 16);
        const j = runPrng.nextInt(3, 8);
        const k = runPrng.nextInt(2, j);
        const strategiesCount = runPrng.nextInt(1, 4);
        const strategyProximityLoops = runPrng.nextInt(0, 2);
        const modulesCount = runPrng.nextBool(0.2) ? 0 : runPrng.nextInt(1, 4);
        const modulesImpactReviewLoops = runPrng.nextInt(0, 2);
        const deepthinkCodeExecutionEnabled = runPrng.nextBool(0.3);
        const isolateBranches = deepthinkCodeExecutionEnabled ? true : runPrng.nextBool(0.4);
        const bsrWeightPreset = runPrng.pick(presets);
        const bsrNoiseLevel = runPrng.nextInt(1, 4);
        const bsrPressureFloor = runPrng.nextFloat(0.1, 0.6, 2);

        specs.push({
            runIndex: idx,
            seed: runSeed,
            label: `seeded-fuzz-${idx}-i${i}-j${j}-k${k}-n${strategiesCount}-m${modulesCount}-${deepthinkCodeExecutionEnabled ? 'sandbox' : 'direct'}`,
            config: buildOrchestratorConfigFromParams({
                i,
                j,
                k,
                strategiesCount,
                strategyProximityLoops,
                modulesCount,
                modulesImpactReviewLoops,
                isolateBranches,
                deepthinkCodeExecutionEnabled,
                bsrWeightPreset,
                bsrNoiseLevel,
                bsrPressureFloor,
            }),
            enableAsyncJitter: true,
            maxJitterMs: 6,
        });
    }

    return specs;
}
