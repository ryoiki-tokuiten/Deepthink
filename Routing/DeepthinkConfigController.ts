import {
    MAX_DEEPTHINK_STRATEGIES,
    MAX_MODULES_COUNT,
    MAX_STRATEGY_PROXIMITY_LOOPS,
    MAX_MODULES_IMPACT_REVIEW_LOOPS,
    ModelConfigManager,
    type BsrWeightPresetId,
} from './ModelConfig';

export interface DeepthinkConfigState {
    strategiesCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    modulesEnabled: boolean;
    deepthinkDepth: number;
    i: number;
    j: number;
    k: number;
    isolateBranches: boolean;
    codeExecutionEnabled: boolean;
    bsrNoiseLevel: number;
    bsrPressureFloor: number;
    bsrWeightSmall: number;
    bsrWeightMedium: number;
    bsrWeightLarge: number;
    bsrWeightPreset: BsrWeightPresetId;
}

type DeepthinkConfigChangeEvent = CustomEvent<{
    property: keyof DeepthinkConfigState | 'all';
    state: DeepthinkConfigState;
}>;

export class DeepthinkConfigController extends EventTarget {
    constructor(private readonly modelConfig: ModelConfigManager) {
        super();
    }

    public getState(): DeepthinkConfigState {
        return {
            strategiesCount: this.modelConfig.getStrategiesCount(),
            strategyProximityLoops: this.modelConfig.getStrategyProximityLoops(),
            modulesCount: this.modelConfig.getModulesCount(),
            modulesImpactReviewLoops: this.modelConfig.getModulesImpactReviewLoops(),
            modulesEnabled: this.modelConfig.getModulesCount() > 0,
            deepthinkDepth: this.modelConfig.getDeepthinkDepth(),
            i: this.modelConfig.getI(),
            j: this.modelConfig.getJ(),
            k: this.modelConfig.getK(),
            isolateBranches: this.modelConfig.isIsolateBranchesEnabled(),
            codeExecutionEnabled: this.modelConfig.isDeepthinkCodeExecutionEnabled(),
            bsrNoiseLevel: this.modelConfig.getBsrNoiseLevel(),
            bsrPressureFloor: this.modelConfig.getBsrPressureFloor(),
            bsrWeightSmall: this.modelConfig.getBsrWeightSmall(),
            bsrWeightMedium: this.modelConfig.getBsrWeightMedium(),
            bsrWeightLarge: this.modelConfig.getBsrWeightLarge(),
            bsrWeightPreset: this.modelConfig.getBsrWeightPreset(),
        };
    }

    public getStrategiesCount(): number { return this.modelConfig.getStrategiesCount(); }
    public getStrategyProximityLoops(): number { return this.modelConfig.getStrategyProximityLoops(); }
    public getModulesCount(): number { return this.modelConfig.getModulesCount(); }
    public getModulesImpactReviewLoops(): number { return this.modelConfig.getModulesImpactReviewLoops(); }
    public isModulesEnabled(): boolean { return this.getModulesCount() > 0; }
    public getDeepthinkDepth(): number { return this.modelConfig.getDeepthinkDepth(); }
    public getI(): number { return this.modelConfig.getI(); }
    public getJ(): number { return this.modelConfig.getJ(); }
    public getK(): number { return this.modelConfig.getK(); }
    public getMaxStrategies(): number { return MAX_DEEPTHINK_STRATEGIES; }
    public isIsolateBranchesEnabled(): boolean { return this.modelConfig.isIsolateBranchesEnabled(); }
    public isCodeExecutionEnabled(): boolean { return this.modelConfig.isDeepthinkCodeExecutionEnabled(); }
    public getBsrNoiseLevel(): number { return this.modelConfig.getBsrNoiseLevel(); }
    public getBsrPressureFloor(): number { return this.modelConfig.getBsrPressureFloor(); }
    public getBsrWeightSmall(): number { return this.modelConfig.getBsrWeightSmall(); }
    public getBsrWeightMedium(): number { return this.modelConfig.getBsrWeightMedium(); }
    public getBsrWeightLarge(): number { return this.modelConfig.getBsrWeightLarge(); }
    public getBsrWeightPreset(): BsrWeightPresetId { return this.modelConfig.getBsrWeightPreset(); }

    public setStrategiesCount(count: number): void {
        this.modelConfig.updateParameter('strategiesCount', Math.max(1, Math.min(Math.round(count), MAX_DEEPTHINK_STRATEGIES)));
        this.emitChange('strategiesCount');
    }

    public setStrategyProximityLoops(count: number): void {
        this.modelConfig.updateParameter('strategyProximityLoops', Math.max(1, Math.min(MAX_STRATEGY_PROXIMITY_LOOPS, Math.round(count))));
        this.emitChange('strategyProximityLoops');
    }

    public setModulesCount(count: number): void {
        this.modelConfig.updateParameter('modulesCount', Math.max(0, Math.min(Math.round(count), MAX_MODULES_COUNT)));
        this.emitChange('modulesCount');
    }

    public setModulesImpactReviewLoops(count: number): void {
        this.modelConfig.updateParameter('modulesImpactReviewLoops', Math.max(1, Math.min(MAX_MODULES_IMPACT_REVIEW_LOOPS, Math.round(count))));
        this.emitChange('modulesImpactReviewLoops');
    }

    public setModulesEnabled(enabled: boolean): void {
        this.modelConfig.updateParameter('modulesCount', enabled && this.getModulesCount() === 0 ? 4 : enabled ? this.getModulesCount() : 0);
        this.emitChange('modulesEnabled');
    }

    public setDeepthinkDepth(depth: number): void {
        this.setI(depth);
    }

    public setI(i: number): void {
        this.modelConfig.setI(i);
        this.emitChange('i');
        this.emitChange('deepthinkDepth');
    }

    public setJ(j: number): void {
        this.modelConfig.setJ(j);
        this.emitChange('j');
    }

    public setK(k: number): void {
        this.modelConfig.setK(k);
        this.emitChange('k');
    }

    public setIsolateBranchesEnabled(enabled: boolean): void {
        if (this.modelConfig.isDeepthinkCodeExecutionEnabled()) {
            this.modelConfig.updateParameter('isolateBranches', true);
            return;
        }
        this.modelConfig.updateParameter('isolateBranches', enabled);
        this.emitChange('isolateBranches');
    }

    public setCodeExecutionEnabled(enabled: boolean): void {
        const wasIsolated = this.modelConfig.isIsolateBranchesEnabled();
        this.modelConfig.updateParameter('deepthinkCodeExecutionEnabled', enabled);
        if (enabled && !wasIsolated) {
            this.modelConfig.updateParameter('isolateBranches', true);
            this.emitChange('isolateBranches');
        }
        this.emitChange('codeExecutionEnabled');
        window.dispatchEvent(new CustomEvent('sandboxToggled', { detail: { enabled } }));
    }

    public setBsrNoiseLevel(val: number): void {
        this.modelConfig.updateParameter('bsrNoiseLevel', val);
        this.emitChange('bsrNoiseLevel');
    }

    public setBsrPressureFloor(val: number): void {
        this.modelConfig.updateParameter('bsrPressureFloor', val);
        this.emitChange('bsrPressureFloor');
    }

    public setBsrWeightSmall(val: number): void {
        this.modelConfig.updateParameter('bsrWeightSmall', val);
        this.emitChange('bsrWeightSmall');
    }

    public setBsrWeightMedium(val: number): void {
        this.modelConfig.updateParameter('bsrWeightMedium', val);
        this.emitChange('bsrWeightMedium');
    }

    public setBsrWeightLarge(val: number): void {
        this.modelConfig.updateParameter('bsrWeightLarge', val);
        this.emitChange('bsrWeightLarge');
    }

    public setBsrWeightPreset(presetId: BsrWeightPresetId): void {
        this.modelConfig.setBsrWeightPreset(presetId);
        this.emitChange('bsrWeightPreset');
        this.emitChange('all');
    }

    private emitChange(property: keyof DeepthinkConfigState | 'all'): void {
        this.dispatchEvent(new CustomEvent('configchange', {
            detail: { property, state: this.getState() },
        }) as DeepthinkConfigChangeEvent);
    }

    public emitFullStateUpdate(): void {
        this.emitChange('all');
    }
}
