import { updatePromptContent } from '../Styles/Components/PromptStyling';
import { globalState } from '../Core/State';
import { renderIconMarkup } from '../UI/Icons';
import { ModelSelectionUI } from './ModelSelectionUI';
import type { CustomizablePromptsAdaptiveDeepthink } from '../AdaptiveDeepthink/AdaptiveDeepthinkPrompt';
import type { CustomizablePromptsContextual } from '../Contextual/ContextualPrompts';
import type { CustomizablePromptsDeepthink } from '../Deepthink/prompts';
import { DEEPTHINK_AGENT_REGISTRY, type DeepthinkAgentKind } from '../Deepthink/core/agentRegistry';
import type { PromptPaneConfig } from '../Styles/Components/PromptContent';

function paneSlug(agentKind: DeepthinkAgentKind): string {
    return agentKind.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

export const DEEPTHINK_PROMPT_PANES: readonly PromptPaneConfig<CustomizablePromptsDeepthink>[] =
    (Object.keys(DEEPTHINK_AGENT_REGISTRY) as DeepthinkAgentKind[])
        .filter(k => k !== 'strategyProximity' && k !== 'modulesImpactReview')
        .map(agentKind => {
            const metadata = DEEPTHINK_AGENT_REGISTRY[agentKind];
            const slug = paneSlug(agentKind);
            return {
                key: `deepthink-${slug}`,
                title: metadata.label,
                promptKey: metadata.systemPromptKey,
                modelKey: metadata.modelKey,
                textareaId: `sys-deepthink-${slug}`,
                agentName: agentKind,
                showAvailableModels: true
            };
        });

export const ADAPTIVE_PROMPT_PANES: readonly PromptPaneConfig<CustomizablePromptsAdaptiveDeepthink>[] = [
    { key: 'adaptive-main', title: 'Main Orchestrator', modelKey: 'model_main', promptKey: 'sys_adaptiveDeepthink_main', textareaId: 'sys-adaptive-main', agentName: 'adaptive-main', rows: 12, placeholder: 'Main Adaptive Deepthink orchestrator system prompt...' },
    { key: 'adaptive-strategy-gen', title: 'Strategy Generator', modelKey: 'model_strategyGeneration', promptKey: 'sys_adaptiveDeepthink_strategyGeneration', textareaId: 'sys-adaptive-strategy-gen', agentName: 'adaptive-strategy-gen', rows: 10, placeholder: 'Strategy generation agent system prompt...' },
    { key: 'adaptive-modules-gen', title: 'Modules Generator', modelKey: 'model_modulesGeneration', promptKey: 'sys_adaptiveDeepthink_modulesGeneration', textareaId: 'sys-adaptive-modules-gen', agentName: 'adaptive-modules-gen', rows: 10, placeholder: 'Modules generator agent system prompt...' },
    { key: 'adaptive-modules-test', title: 'Modules Testing', modelKey: 'model_modulesTesting', promptKey: 'sys_adaptiveDeepthink_modulesTesting', textareaId: 'sys-adaptive-modules-test', agentName: 'adaptive-modules-test', rows: 10, placeholder: 'Modules testing agent system prompt...' },
    { key: 'adaptive-execution', title: 'Execution Agent', modelKey: 'model_execution', promptKey: 'sys_adaptiveDeepthink_execution', textareaId: 'sys-adaptive-execution', agentName: 'adaptive-execution', rows: 10, placeholder: 'Execution agent system prompt...' },
    { key: 'adaptive-critique', title: 'Solution Critique', modelKey: 'model_solutionCritique', promptKey: 'sys_adaptiveDeepthink_solutionCritique', textareaId: 'sys-adaptive-critique', agentName: 'adaptive-critique', rows: 10, placeholder: 'Solution critique agent system prompt...' },
    { key: 'adaptive-corrector', title: 'Corrector Agent', modelKey: 'model_corrector', promptKey: 'sys_adaptiveDeepthink_corrector', textareaId: 'sys-adaptive-corrector', agentName: 'adaptive-corrector', rows: 10, placeholder: 'Corrector agent system prompt...' }
];

export const CONTEXTUAL_PROMPT_PANES: readonly PromptPaneConfig<CustomizablePromptsContextual>[] = [
    { key: 'contextual-main-generator', title: 'Main Generation Agent', modelKey: 'model_mainGenerator', promptKey: 'sys_contextual_mainGenerator', textareaId: 'sys-contextual-main-generator', agentName: 'contextual-main-generator', rows: 12, placeholder: 'Main generation agent (self-corrector) system prompt...' },
    { key: 'contextual-iterative-agent', title: 'Iterative Agent', modelKey: 'model_iterativeAgent', promptKey: 'sys_contextual_iterativeAgent', textareaId: 'sys-contextual-iterative-agent', agentName: 'contextual-iterative-agent', rows: 12, placeholder: 'Iterative agent (solution critique) system prompt...' },
    { key: 'contextual-solution-pool', title: 'Structured Noise Agent', modelKey: 'model_solutionPoolAgent', promptKey: 'sys_contextual_solutionPoolAgent', textareaId: 'sys-contextual-solution-pool', agentName: 'contextual-solution-pool', rows: 12, placeholder: 'Structured noise / strategy pool agent system prompt...' },
    { key: 'contextual-memory', title: 'Memory Agent', modelKey: 'model_memoryAgent', promptKey: 'sys_contextual_memoryAgent', textareaId: 'sys-contextual-memory', agentName: 'contextual-memory', rows: 12, placeholder: 'Memory agent system prompt...' }
];

const NAV_STRUCTURE: Record<string, Array<{ groupTitle: string; prompts: string[] }>> = {
    deepthink: [
        { groupTitle: "1. STRATEGY GENERATION", prompts: ["deepthink-initial-strategy"] },
        { groupTitle: "2. SOLUTION DEVELOPMENT", prompts: ["deepthink-solution-attempt", "deepthink-solution-critique", "deepthink-solution-correction"] },
        { groupTitle: "3. MODULES EXPLORATION", prompts: ["deepthink-modules-generation", "deepthink-modules-tester"] },
        { groupTitle: "4. EVALUATION & JUDGMENT", prompts: ["deepthink-memory-bank", "deepthink-dos", "deepthink-bsr", "deepthink-final-judge"] }
    ],
    adaptiveDeepthink: [
        { groupTitle: "1. MAIN ORCHESTRATOR", prompts: ["adaptive-main"] },
        { groupTitle: "2. STRATEGY & MODULES", prompts: ["adaptive-strategy-gen", "adaptive-modules-gen", "adaptive-modules-test"] },
        { groupTitle: "3. EXECUTION & CORRECTION", prompts: ["adaptive-execution", "adaptive-critique", "adaptive-corrector"] }
    ],
    contextual: [
        { groupTitle: "CONTEXTUAL AGENTS", prompts: ["contextual-main-generator", "contextual-iterative-agent", "contextual-solution-pool", "contextual-memory"] }
    ]
};

export class PromptsModal {
    private elements = {
        overlay: null as HTMLElement | null,
        closeButton: null as HTMLButtonElement | null,
        trigger: null as HTMLElement | null,
        nav: null as HTMLElement | null,
        content: null as HTMLElement | null
    };
    private currentMode = 'deepthink';
    private modelConfig: any = null;
    private providerManager: any = null;
    private agentModelUIs = new Map<string, ModelSelectionUI>();
    private listenersInitialized = false;

    private ensureElements(): boolean {
        if (this.elements.overlay) return true;
        this.elements.overlay = document.getElementById('prompts-modal-overlay');
        this.elements.closeButton = document.getElementById('prompts-modal-close-button') as HTMLButtonElement;
        this.elements.nav = document.getElementById('prompts-modal-nav');
        this.elements.content = document.getElementById('prompts-modal-content');
        if (this.elements.overlay && !this.listenersInitialized) {
            this.initializeEventListeners();
            this.listenersInitialized = true;
        }
        return !!this.elements.overlay;
    }

    private closeAllDropdowns(): void {
        document.querySelectorAll('.prompt-model-dropdown-panel.is-open, .prompt-model-trigger.is-open').forEach(el => el.classList.remove('is-open'));
    }

    private initializeEventListeners(): void {
        this.elements.closeButton?.addEventListener('click', () => this.hide());
        this.elements.overlay?.addEventListener('click', e => {
            if (e.target === this.elements.overlay) this.hide();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (document.querySelector('.prompt-model-dropdown-panel.is-open')) {
                    this.closeAllDropdowns();
                    e.stopPropagation();
                    return;
                }
                if (this.elements.overlay?.classList.contains('is-visible')) this.hide();
            }
        });
        document.addEventListener('click', () => this.closeAllDropdowns());
        window.addEventListener('appModeChanged', () => {
            this.setCurrentMode(globalState.currentMode);
            if (this.elements.overlay?.classList.contains('is-visible')) this.initializeModal();
        });
    }

    public show(): void {
        if (!this.ensureElements() || !this.elements.overlay) return;
        this.initializeModal();
        this.elements.overlay.style.display = 'flex';
        setTimeout(() => {
            this.elements.overlay?.classList.add('is-visible');
            setTimeout(updatePromptContent, 60);
            setTimeout(updatePromptContent, 200);
        }, 10);
    }

    public hide(): void {
        this.ensureElements();
        if (!this.elements.overlay) return;
        this.elements.overlay.classList.remove('is-visible');
        this.elements.overlay.addEventListener('transitionend', () => {
            if (!this.elements.overlay?.classList.contains('is-visible')) {
                this.elements.overlay!.style.display = 'none';
            }
        }, { once: true });
    }

    public setCurrentMode(mode: string): void {
        this.currentMode = mode === 'adaptive-deepthink' ? 'adaptiveDeepthink' : mode;
    }

    public setModelConfig(modelConfig: any): void { this.modelConfig = modelConfig; }
    public setProviderManager(providerManager: any): void { this.providerManager = providerManager; }

    private initializeModal(): void {
        if (!this.elements.nav || !this.elements.content) return;
        this.elements.nav.innerHTML = '';
        this.elements.content.querySelectorAll('.prompts-mode-container, .prompt-content-pane').forEach(el => el.classList.remove('active'));

        const activeModeContainer = document.getElementById(`${this.currentMode}-prompts-container`);
        if (!activeModeContainer) return;
        activeModeContainer.classList.add('active');

        const modeTitle = document.createElement('h4');
        modeTitle.className = 'prompts-nav-mode-title';
        const display = this.currentMode === 'adaptiveDeepthink' ? 'Adaptive Deepthink' : (this.currentMode ? this.currentMode.charAt(0).toUpperCase() + this.currentMode.slice(1) : '');
        modeTitle.textContent = `${display} Mode Prompts`;
        this.elements.nav.appendChild(modeTitle);

        const navStructure = NAV_STRUCTURE[this.currentMode];
        if (!navStructure) return;

        let firstNavItem: HTMLElement | null = null;
        navStructure.forEach(group => {
            const groupTitleEl = document.createElement('h5');
            groupTitleEl.className = 'prompts-nav-group-title';
            groupTitleEl.textContent = group.groupTitle;
            this.elements.nav!.appendChild(groupTitleEl);

            group.prompts.forEach(promptKey => {
                const pane = activeModeContainer.querySelector<HTMLElement>(`.prompt-content-pane[data-prompt-key="${promptKey}"]`);
                if (!pane) return;
                const navItem = document.createElement('div');
                navItem.className = 'prompts-nav-item';
                navItem.textContent = pane.querySelector<HTMLHeadingElement>('.prompt-pane-title')?.textContent || 'Unnamed Section';
                navItem.dataset.targetPane = promptKey;
                this.elements.nav!.appendChild(navItem);
                if (!firstNavItem) firstNavItem = navItem;

                navItem.addEventListener('click', () => {
                    this.elements.nav?.querySelectorAll('.prompts-nav-item').forEach(item => item.classList.remove('active'));
                    navItem.classList.add('active');
                    activeModeContainer.querySelectorAll('.prompt-content-pane').forEach(p => p.classList.remove('active'));
                    const targetPane = activeModeContainer.querySelector(`.prompt-content-pane[data-prompt-key="${promptKey}"]`);
                    if (targetPane) {
                        targetPane.classList.add('active');
                        setTimeout(updatePromptContent, 50);
                        this.initializeModelSelectors();
                    }
                });
            });
        });

        (firstNavItem as HTMLElement | null)?.click();
        this.initializeModelSelectors();
    }

    private initializeModelSelectors(): void {
        if (!this.modelConfig) return;
        document.querySelectorAll<HTMLSelectElement>('.prompt-model-select').forEach(selectElement => {
            const container = selectElement.parentElement as HTMLElement;
            if (!container) return;
            const agentName = selectElement.dataset.agent || '';
            let trigger = container.querySelector<HTMLButtonElement>(`.prompt-model-trigger[data-agent="${agentName}"]`);
            let dropdownPanel = container.querySelector<HTMLDivElement>(`.prompt-model-dropdown-panel[data-agent="${agentName}"]`);

            if (!trigger) {
                selectElement.style.display = 'none';
                trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'prompt-model-trigger';
                trigger.dataset.agent = agentName;
                trigger.innerHTML = `<span class="prompt-model-trigger-text">${selectElement.value || 'Select Model'}</span>${renderIconMarkup('ChevronDown', 'prompt-model-trigger-arrow', {}, 14)}`;

                dropdownPanel = document.createElement('div');
                dropdownPanel.className = 'prompt-model-dropdown-panel';
                dropdownPanel.dataset.agent = agentName;
                container.append(trigger, dropdownPanel);

                dropdownPanel.addEventListener('click', e => e.stopPropagation());
                trigger.addEventListener('click', e => {
                    e.stopPropagation();
                    const isOpen = dropdownPanel!.classList.contains('is-open');
                    this.closeAllDropdowns();
                    if (!isOpen) {
                        dropdownPanel!.classList.add('is-open');
                        trigger!.classList.add('is-open');
                        this.agentModelUIs.get(agentName)?.updateModelOptions();
                    }
                });
            } else {
                const triggerText = trigger.querySelector('.prompt-model-trigger-text');
                if (triggerText) triggerText.textContent = selectElement.value || 'Select Model';
            }

            const existingUI = this.agentModelUIs.get(agentName);
            if (existingUI) {
                existingUI.updateModelOptions();
                return;
            }

            const ui = new ModelSelectionUI(this.modelConfig, null, this.providerManager, {
                selectElement,
                container: dropdownPanel!,
                allowGlobalOption: true,
                agentName,
                onModelChange: (model: string) => {
                    const triggerText = trigger?.querySelector('.prompt-model-trigger-text');
                    if (triggerText) triggerText.textContent = model || 'Select Model';
                    this.closeAllDropdowns();
                }
            });
            ui.initialize();
            if (agentName) this.agentModelUIs.set(agentName, ui);
        });

        setTimeout(() => this.setupChangeDetection(), 100);
    }

    private setupChangeDetection(): void {
        const agentMap: Record<string, string> = {};
        for (const pane of [...DEEPTHINK_PROMPT_PANES, ...ADAPTIVE_PROMPT_PANES, ...CONTEXTUAL_PROMPT_PANES]) {
            if (pane.textareaId) agentMap[pane.textareaId] = pane.textareaId;
        }
        document.querySelectorAll<HTMLTextAreaElement>('.prompt-textarea').forEach(textarea => {
            if (!agentMap[textarea.id]) return;
            if (!textarea.dataset.originalValue) textarea.dataset.originalValue = textarea.value;
            const check = () => textarea.classList.toggle('has-changes', textarea.value !== (textarea.dataset.originalValue ?? ''));
            textarea.addEventListener('input', check);
            check();
        });
    }

    public updateTriggerState(isGenerating: boolean): void {
        if (!this.elements.trigger) return;
        this.elements.trigger.closest('.sidebar-section')?.classList.toggle('disabled', isGenerating);
        this.elements.trigger.style.pointerEvents = isGenerating ? 'none' : 'auto';
        this.elements.trigger.style.opacity = isGenerating ? '0.6' : '1';
    }
}
