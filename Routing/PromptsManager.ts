import { CustomizablePromptsDeepthink } from '../Deepthink/prompts';

export class ScopedPromptsManager<T extends object> {
    private ref: { current: T };
    private listeners = new Set<(state: T) => void>();
    private getDefault?: () => T;

    constructor(ref: { current: T }, getDefault?: () => T) {
        this.ref = ref;
        this.getDefault = getDefault;
        if (getDefault && (!this.ref.current || Object.keys(this.ref.current).length === 0)) {
            this.ref.current = getDefault();
        }
    }

    public getPrompts(): T {
        return this.ref.current;
    }

    public setPrompts(prompts: T): void {
        this.ref.current = { ...prompts };
        this.notify();
    }

    public updatePrompt(key: keyof T, value: string | undefined): void {
        if (value === undefined) {
            delete this.ref.current[key];
        } else {
            (this.ref.current as any)[key] = value;
        }
        this.notify();
    }

    public updateModel(key: keyof T, value: string | undefined): void {
        if (!value) {
            delete this.ref.current[key];
        } else {
            (this.ref.current as any)[key] = value;
        }
        this.notify();
    }

    public resetToDefaults(): void {
        if (this.getDefault) this.setPrompts(this.getDefault());
    }

    public subscribe(listener: (state: T) => void): () => void {
        this.listeners.add(listener);
        listener(this.ref.current);
        return () => { this.listeners.delete(listener); };
    }

    private notify(): void {
        const snapshot = { ...this.ref.current };
        this.listeners.forEach(l => l(snapshot));
    }
}

export class PromptsManager {
    private deepthinkPromptsManager: ScopedPromptsManager<CustomizablePromptsDeepthink>;

    constructor(deepthinkPromptsRef: { current: CustomizablePromptsDeepthink }) {
        this.deepthinkPromptsManager = new ScopedPromptsManager(deepthinkPromptsRef);
    }

    public getDeepthinkPromptsManager() { return this.deepthinkPromptsManager; }
    public getDeepthinkPrompts() { return this.deepthinkPromptsManager.getPrompts(); }
}

