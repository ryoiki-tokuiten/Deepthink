import { updatePromptContent } from '../Styles/Components/PromptStyling';
import { renderIconMarkup } from '../UI/Icons';
import { ModelSelectionUI } from './ModelSelectionUI';
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

const DEEPTHINK_NAV_STRUCTURE: ReadonlyArray<{ groupTitle: string; prompts: string[] }> = [
    { groupTitle: "1. STRATEGY GENERATION", prompts: ["deepthink-initial-strategy"] },
    { groupTitle: "2. SOLUTION DEVELOPMENT", prompts: ["deepthink-solution-attempt", "deepthink-solution-critique", "deepthink-solution-correction"] },
    { groupTitle: "3. MODULES EXPLORATION", prompts: ["deepthink-modules-generation", "deepthink-modules-tester"] },
    { groupTitle: "4. EVALUATION", prompts: ["deepthink-memory-bank", "deepthink-dos", "deepthink-bsr"] }
];

export class PromptsModal {
    private elements = {
        overlay: null as HTMLElement | null,
        closeButton: null as HTMLButtonElement | null,
        trigger: null as HTMLElement | null,
        nav: null as HTMLElement | null,
        content: null as HTMLElement | null
    };
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

    public setModelConfig(modelConfig: any): void { this.modelConfig = modelConfig; }
    public setProviderManager(providerManager: any): void { this.providerManager = providerManager; }

    private initializeModal(): void {
        if (!this.elements.nav || !this.elements.content) return;
        this.elements.nav.innerHTML = '';
        this.elements.content.querySelectorAll('.prompts-mode-container, .prompt-content-pane').forEach(el => el.classList.remove('active'));

        const activeModeContainer = document.getElementById('deepthink-prompts-container');
        if (!activeModeContainer) return;
        activeModeContainer.classList.add('active');

        const modeTitle = document.createElement('h4');
        modeTitle.className = 'prompts-nav-mode-title';
        modeTitle.textContent = 'Deepthink Prompts';
        this.elements.nav.appendChild(modeTitle);

        let firstNavItem: HTMLElement | null = null;
        DEEPTHINK_NAV_STRUCTURE.forEach(group => {
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
        for (const pane of DEEPTHINK_PROMPT_PANES) {
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

