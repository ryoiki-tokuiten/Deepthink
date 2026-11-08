export interface ModelOption {
    value: string;
    label: string;
    description?: string;
    provider?: string;
    providerLabel?: string;
}

export const MAX_DEEPTHINK_STRATEGIES = 5;
export const MAX_STRATEGY_PROXIMITY_LOOPS = 2;
export const MAX_MODULES_COUNT = 6;
export const MAX_MODULES_IMPACT_REVIEW_LOOPS = 2;
export const MAX_DEEPTHINK_DEPTH = 20;
export const MIN_BSR_NOISE_LEVEL = 1;
export const MAX_BSR_NOISE_LEVEL = 4;
export const MIN_BSR_PRESSURE_FLOOR = 0.10;
export const MAX_BSR_PRESSURE_FLOOR = 0.60;

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string;

export type BsrWeightPresetId = 'standard' | 'flattened' | 'steepened';

export interface BsrWeightPreset {
    id: BsrWeightPresetId;
    label: string;
    ratio: string;
    tag: string;
    weights: { small: number; medium: number; large: number };
    shortDescription: string;
    detailedDescription: string;
}

export const BSR_WEIGHT_PRESETS: BsrWeightPreset[] = [
    {
        id: 'standard',
        label: 'Standard',
        ratio: '1 : 2 : 4',
        tag: 'Balanced',
        weights: { small: 1, medium: 2, large: 4 },
        shortDescription: 'Exponential scale (1, 2, 4)',
        detailedDescription: 'One large breakthrough exactly cancels out four small setbacks. Balanced operational default.'
    },
    {
        id: 'flattened',
        label: 'Flattened',
        ratio: '1 : 2 : 3',
        tag: 'Linear',
        weights: { small: 1, medium: 2, large: 3 },
        shortDescription: 'Linear scale (1, 2, 3)',
        detailedDescription: 'Event frequency matters more than size. A massive architectural fix can be outweighed by three minor typos or small setbacks.'
    },
    {
        id: 'steepened',
        label: 'Steepened',
        ratio: '1 : 3 : 10',
        tag: 'Breakthrough',
        weights: { small: 1, medium: 3, large: 10 },
        shortDescription: 'Steep scale (1, 3, 10)',
        detailedDescription: 'A large breakthrough acts like a total reset. One big win makes the system completely ignore cycles of slow regressions.'
    }
];

export interface ModelParameters {
    strategiesCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    deepthinkDepth: number;
    i?: number;
    j?: number;
    k?: number;
    isolateBranches: boolean;
    deepthinkCodeExecutionEnabled: boolean;
    thinkingLevel: ThinkingLevel;
    bsrNoiseLevel: number;
    bsrPressureFloor: number;
    bsrWeightSmall: number;
    bsrWeightMedium: number;
    bsrWeightLarge: number;
    bsrWeightPreset: BsrWeightPresetId;
}

const DEFAULT_MODEL_PARAMETERS: ModelParameters = {
    strategiesCount: 3,
    strategyProximityLoops: 1,
    modulesCount: 4,
    modulesImpactReviewLoops: 1,
    deepthinkDepth: 10,
    i: 10,
    j: 4,
    k: 4,
    isolateBranches: false,
    deepthinkCodeExecutionEnabled: false,
    thinkingLevel: 'high',
    bsrNoiseLevel: 2,
    bsrPressureFloor: 0.3,
    bsrWeightSmall: 1,
    bsrWeightMedium: 2,
    bsrWeightLarge: 4,
    bsrWeightPreset: 'standard',
};

export class ModelConfigManager {
    private parameters: ModelParameters;
    private selectedModel: string;
    private availableModels: ModelOption[] = [];

    constructor() {
        this.parameters = { ...DEFAULT_MODEL_PARAMETERS };
        this.selectedModel = 'gemini-3.5-flash';
    }

    public getSelectedModel(): string {
        return this.selectedModel;
    }

    public setSelectedModel(model: string): void {
        this.selectedModel = model;
        window.dispatchEvent(new CustomEvent('selectedModelChanged', { detail: { model } }));
    }

    public getParameters(): ModelParameters {
        return { ...this.parameters };
    }

    public updateParameter<K extends keyof ModelParameters>(key: K, value: ModelParameters[K]): void {
        if (key === 'deepthinkCodeExecutionEnabled' && value === true) {
            this.parameters.isolateBranches = true;
        }
        if (key === 'isolateBranches' && this.parameters.deepthinkCodeExecutionEnabled) {
            this.parameters.isolateBranches = true;
            return;
        }
        this.parameters[key] = value;
    }

    public getStrategiesCount(): number {
        return Math.max(1, Math.min(MAX_DEEPTHINK_STRATEGIES, this.parameters.strategiesCount));
    }

    public getStrategyProximityLoops(): number {
        return Math.max(1, Math.min(MAX_STRATEGY_PROXIMITY_LOOPS, Math.round(this.parameters.strategyProximityLoops || 1)));
    }

    public getModulesCount(): number {
        return Math.max(0, Math.min(MAX_MODULES_COUNT, this.parameters.modulesCount));
    }

    public getModulesImpactReviewLoops(): number {
        return Math.max(1, Math.min(MAX_MODULES_IMPACT_REVIEW_LOOPS, Math.round(this.parameters.modulesImpactReviewLoops || 1)));
    }

    public getDeepthinkDepth(): number {
        return this.getI();
    }

    public getI(): number {
        return Math.max(5, Math.min(20, Math.round(this.parameters.i ?? this.parameters.deepthinkDepth ?? 10)));
    }

    public setI(i: number): void {
        const val = Math.max(5, Math.min(20, Math.round(i)));
        this.parameters.i = val;
        this.parameters.deepthinkDepth = val;
    }

    public getJ(): number {
        return Math.max(3, Math.min(8, Math.round(this.parameters.j ?? 4)));
    }

    public setJ(j: number): void {
        this.parameters.j = Math.max(3, Math.min(8, Math.round(j)));
    }

    public getK(): number {
        const j = this.getJ();
        return Math.max(2, Math.min(j, Math.round(this.parameters.k ?? 4)));
    }

    public setK(k: number): void {
        const j = this.getJ();
        this.parameters.k = Math.max(2, Math.min(j, Math.round(k)));
    }

    public isIsolateBranchesEnabled(): boolean {
        return this.parameters.deepthinkCodeExecutionEnabled || this.parameters.isolateBranches === true;
    }

    public isDeepthinkCodeExecutionEnabled(): boolean {
        return this.parameters.deepthinkCodeExecutionEnabled;
    }

    public getThinkingLevel(): ThinkingLevel {
        return this.parameters.thinkingLevel || 'high';
    }

    public getBsrNoiseLevel(): number {
        return this.parameters.bsrNoiseLevel ?? 2;
    }

    public setBsrNoiseLevel(val: number): void {
        this.parameters.bsrNoiseLevel = Math.max(MIN_BSR_NOISE_LEVEL, Math.min(MAX_BSR_NOISE_LEVEL, Math.round(val)));
    }

    public getBsrPressureFloor(): number {
        return this.parameters.bsrPressureFloor ?? 0.3;
    }

    public setBsrPressureFloor(val: number): void {
        const rounded = Math.round(val * 100) / 100;
        this.parameters.bsrPressureFloor = Math.max(MIN_BSR_PRESSURE_FLOOR, Math.min(MAX_BSR_PRESSURE_FLOOR, rounded));
    }

    public getBsrWeightSmall(): number {
        return this.parameters.bsrWeightSmall ?? 1;
    }

    public setBsrWeightSmall(val: number): void {
        this.parameters.bsrWeightSmall = val;
    }

    public getBsrWeightMedium(): number {
        return this.parameters.bsrWeightMedium ?? 2;
    }

    public setBsrWeightMedium(val: number): void {
        this.parameters.bsrWeightMedium = val;
    }

    public getBsrWeightLarge(): number {
        return this.parameters.bsrWeightLarge ?? 4;
    }

    public setBsrWeightLarge(val: number): void {
        this.parameters.bsrWeightLarge = val;
    }

    public getBsrWeightPreset(): BsrWeightPresetId {
        return this.parameters.bsrWeightPreset ?? 'standard';
    }

    public setBsrWeightPreset(presetId: BsrWeightPresetId): void {
        const found = BSR_WEIGHT_PRESETS.find(p => p.id === presetId) || BSR_WEIGHT_PRESETS[0];
        this.parameters.bsrWeightPreset = found.id;
        this.parameters.bsrWeightSmall = found.weights.small;
        this.parameters.bsrWeightMedium = found.weights.medium;
        this.parameters.bsrWeightLarge = found.weights.large;
    }

    public getModelProvider(modelValue?: string): string {
        const model = this.availableModels.find(candidate => candidate.value === (modelValue || this.selectedModel));
        return model?.provider || 'google';
    }

    public setAvailableModels(models: ModelOption[]): void {
        this.availableModels = models;
        if (!models.some(model => model.value === this.selectedModel) && models.length > 0) {
            this.setSelectedModel(models[0].value);
        }
    }

    public getAvailableModels(): ModelOption[] {
        return [...this.availableModels];
    }
}
