/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { updatePromptContent } from '../Styles/Components/PromptStyling';
import { globalState } from '../Core/State';
import { renderIconMarkup } from '../UI/Icons';
import { ModelSelectionUI } from './ModelSelectionUI';
import {
    ADAPTIVE_PROMPT_PANES,
    CONTEXTUAL_PROMPT_PANES,
    DEEPTHINK_PROMPT_PANES
} from './PromptsModal/PromptModeConfigs';

export class PromptsModal {
    private elements: {
        overlay: HTMLElement | null;
        closeButton: HTMLButtonElement | null;
        trigger: HTMLElement | null;
        nav: HTMLElement | null;
        content: HTMLElement | null;
    };

    private currentMode: string = 'deepthink';
    private modelConfig: any = null;
    private providerManager: any = null;
    private agentModelUIs: Map<string, ModelSelectionUI> = new Map();

    constructor() {
        this.elements = {
            overlay: null,
            closeButton: null,
            trigger: null,
            nav: null,
            content: null
        };

        // We can't initialize elements here because the DOM might not be ready
        // Elements will be initialized lazily in show() or ensureElements()
    }

    private listenersInitialized: boolean = false;

    private ensureElements(): boolean {
        if (this.elements.overlay) return true;

        this.elements.overlay = document.getElementById('prompts-modal-overlay');
        this.elements.closeButton = document.getElementById('prompts-modal-close-button') as HTMLButtonElement;
        this.elements.nav = document.getElementById('prompts-modal-nav');
        this.elements.content = document.getElementById('prompts-modal-content');

        if (this.elements.overlay) {
            if (!this.listenersInitialized) {
                this.initializeEventListeners();
                this.listenersInitialized = true;
            }
            return true;
        }
        return false;
    }

    private initializeEventListeners(): void {
        // Trigger event listener will be set externally by ProviderManagementUI

        if (this.elements.closeButton) {
            this.elements.closeButton.addEventListener('click', () => this.hide());
        }

        if (this.elements.overlay) {
            this.elements.overlay.addEventListener('click', (e) => {
                if (e.target === this.elements.overlay) {
                    this.hide();
                }
            });
        }

        // Add Escape key handler to close open model dropdowns first, then modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const openPanel = document.querySelector('.prompt-model-dropdown-panel.is-open');
                if (openPanel) {
                    openPanel.classList.remove('is-open');
                    document.querySelectorAll('.prompt-model-trigger.is-open').forEach(t => {
                        t.classList.remove('is-open');
                    });
                    e.stopPropagation();
                    return;
                }
                if (this.elements.overlay?.classList.contains('is-visible')) {
                    this.hide();
                }
            }
        });

        // Close open model dropdowns on click outside
        document.addEventListener('click', () => {
            const openPanels = document.querySelectorAll('.prompt-model-dropdown-panel.is-open');
            if (openPanels.length > 0) {
                openPanels.forEach(p => p.classList.remove('is-open'));
                document.querySelectorAll('.prompt-model-trigger.is-open').forEach(t => {
                    t.classList.remove('is-open');
                });
            }
        });

        // Listen for mode changes to update the modal
        window.addEventListener('appModeChanged', () => {
            this.setCurrentMode(globalState.currentMode);
            if (this.elements.overlay?.classList.contains('is-visible')) {
                this.initializeModal();
            }
        });
    }

    public show(): void {
        if (!this.ensureElements()) {
            console.error('Prompts modal elements not found in DOM');
            return;
        }

        if (this.elements.overlay) {
            this.initializeModal(); // Re-initialize on open to reflect current mode
            this.elements.overlay.style.display = 'flex';
            setTimeout(() => {
                this.elements.overlay!.classList.add('is-visible');
                // Force initial content sync after editors are enhanced
                setTimeout(() => updatePromptContent(), 60);
                // Safety: run once more after layout settles
                setTimeout(() => updatePromptContent(), 200);
            }, 10);
        }
    }

    public hide(): void {
        // Try to ensure elements exist, but don't fail if they don't (modal might not be open)
        this.ensureElements();

        if (this.elements.overlay) {
            this.elements.overlay.classList.remove('is-visible');
            this.elements.overlay.addEventListener('transitionend', () => {
                if (!this.elements.overlay!.classList.contains('is-visible')) {
                    this.elements.overlay!.style.display = 'none';
                }
            }, { once: true });
        }
    }

    public setCurrentMode(mode: string): void {
        this.currentMode = this.normalizeModeKey(mode);
    }

    public setModelConfig(modelConfig: any): void {
        this.modelConfig = modelConfig;
    }

    public setProviderManager(providerManager: any): void {
        this.providerManager = providerManager;
    }

    private initializeModal(): void {
        if (!this.elements.nav || !this.elements.content) return;

        // Clear previous state
        this.elements.nav.innerHTML = '';
        this.elements.content.querySelectorAll('.prompts-mode-container').forEach(el => el.classList.remove('active'));
        this.elements.content.querySelectorAll('.prompt-content-pane').forEach(el => el.classList.remove('active'));

        const activeModeContainer = document.getElementById(`${this.currentMode}-prompts-container`);
        if (!activeModeContainer) return;

        activeModeContainer.classList.add('active');

        // Display current mode at the top of nav
        const modeTitle = document.createElement('h4');
        modeTitle.className = 'prompts-nav-mode-title';
        modeTitle.textContent = `${this.getModeDisplayName(this.currentMode)} Mode Prompts`;
        this.elements.nav.appendChild(modeTitle);

        const navStructure = this.getPromptNavStructure()[this.currentMode as keyof ReturnType<typeof this.getPromptNavStructure>];
        if (!navStructure) return;

        let firstNavItem: HTMLElement | null = null;

        navStructure.forEach((group: any) => {
            const groupTitleEl = document.createElement('h5');
            groupTitleEl.className = 'prompts-nav-group-title';
            groupTitleEl.textContent = group.groupTitle;
            this.elements.nav!.appendChild(groupTitleEl);

            group.prompts.forEach((promptKey: string) => {
                const pane = activeModeContainer.querySelector<HTMLElement>(`.prompt-content-pane[data-prompt-key="${promptKey}"]`);
                if (!pane) return;

                const titleElement = pane.querySelector<HTMLHeadingElement>('.prompt-pane-title');
                const title = titleElement ? titleElement.textContent : 'Unnamed Section';

                const navItem = document.createElement('div');
                navItem.className = 'prompts-nav-item';
                navItem.textContent = title;
                navItem.dataset.targetPane = promptKey;
                this.elements.nav!.appendChild(navItem);

                if (!firstNavItem) {
                    firstNavItem = navItem;
                }

                navItem.addEventListener('click', () => {
                    // Remove active class from all nav items
                    this.elements.nav?.querySelectorAll('.prompts-nav-item').forEach(item => {
                        item.classList.remove('active');
                    });

                    // Add active class to clicked item
                    navItem.classList.add('active');

                    // Hide all content panes
                    activeModeContainer.querySelectorAll('.prompt-content-pane').forEach(pane => {
                        pane.classList.remove('active');
                    });

                    // Show corresponding content pane
                    const targetPane = activeModeContainer.querySelector(`.prompt-content-pane[data-prompt-key="${promptKey}"]`);
                    if (targetPane) {
                        targetPane.classList.add('active');

                        // Update prompt content when switching panes
                        setTimeout(() => updatePromptContent(), 50);
                        this.initializeModelSelectors();
                    }
                });
            });
        });

        // Activate the first one by default
        if (firstNavItem) {
            (firstNavItem as HTMLElement).click();
        }

        // Initialize model selectors after navigation is set up
        this.initializeModelSelectors();

    }

    private getPromptNavStructure() {
        return {
            deepthink: [
                {
                    groupTitle: "1. STRATEGY GENERATION",
                    prompts: ["deepthink-initial-strategy"]
                },
                {
                    groupTitle: "2. SOLUTION DEVELOPMENT",
                    prompts: ["deepthink-solution-attempt", "deepthink-solution-critique", "deepthink-solution-correction"]
                },
                {
                    groupTitle: "3. MODULES EXPLORATION",
                    prompts: ["deepthink-modules-generation", "deepthink-modules-tester"]
                },
                {
                    groupTitle: "4. EVALUATION & JUDGMENT",
                    prompts: ["deepthink-memory-bank", "deepthink-dos", "deepthink-bsr", "deepthink-final-judge"]
                }
            ],
            adaptiveDeepthink: [
                {
                    groupTitle: "1. MAIN ORCHESTRATOR",
                    prompts: ["adaptive-main"]
                },
                {
                    groupTitle: "2. STRATEGY & MODULES",
                    prompts: ["adaptive-strategy-gen", "adaptive-modules-gen", "adaptive-modules-test"]
                },
                {
                    groupTitle: "3. EXECUTION & CORRECTION",
                    prompts: ["adaptive-execution", "adaptive-critique", "adaptive-corrector"]
                }
            ],
            contextual: [
                {
                    groupTitle: "CONTEXTUAL AGENTS",
                    prompts: ["contextual-main-generator", "contextual-iterative-agent", "contextual-solution-pool", "contextual-memory"]
                }
            ]
        };
    }

    private normalizeModeKey(mode: string): string {
        const mapping: Record<string, string> = {
            'adaptive-deepthink': 'adaptiveDeepthink'
        };
        return mapping[mode] || mode;
    }

    private getModeDisplayName(normalizedMode: string): string {
        const mapping: Record<string, string> = {
            adaptiveDeepthink: 'Adaptive Deepthink'
        };
        const display = mapping[normalizedMode];
        if (display) {
            return display;
        }

        if (!normalizedMode) {
            return '';
        }

        return normalizedMode.charAt(0).toUpperCase() + normalizedMode.slice(1);
    }

    private initializeModelSelectors(): void {
        if (!this.modelConfig) return;

        const modelSelectors = document.querySelectorAll('.prompt-model-select');
        modelSelectors.forEach((selector: Element) => {
            const selectElement = selector as HTMLSelectElement;
            const container = selectElement.parentElement as HTMLElement;
            if (!container) return;

            const agentName = selectElement.dataset.agent || '';

            // Check if trigger and dropdown panel are already created
            let trigger = container.querySelector<HTMLButtonElement>(`.prompt-model-trigger[data-agent="${agentName}"]`);
            let dropdownPanel = container.querySelector<HTMLDivElement>(`.prompt-model-dropdown-panel[data-agent="${agentName}"]`);

            if (!trigger) {
                // Hide native select
                selectElement.style.display = 'none';

                // Create the "Select Model" trigger button
                trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'prompt-model-trigger';
                trigger.dataset.agent = agentName;
                const currentVal = selectElement.value;
                trigger.innerHTML = `
                    <span class="prompt-model-trigger-text">${currentVal || 'Select Model'}</span>
                    ${renderIconMarkup('ChevronDown', 'prompt-model-trigger-arrow', {}, 14)}
                `;

                // Create the floating connected dropdown panel
                dropdownPanel = document.createElement('div');
                dropdownPanel.className = 'prompt-model-dropdown-panel';
                dropdownPanel.dataset.agent = agentName;

                container.appendChild(trigger);
                container.appendChild(dropdownPanel);

                // Prevent clicks inside floating panel from propagating to document (which would close it)
                dropdownPanel.addEventListener('click', (e) => {
                    e.stopPropagation();
                });

                // Toggle dropdown panel on trigger click
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isOpen = dropdownPanel!.classList.contains('is-open');

                    // Close all other open dropdowns
                    document.querySelectorAll('.prompt-model-dropdown-panel.is-open').forEach(p => {
                        if (p !== dropdownPanel) p.classList.remove('is-open');
                    });
                    document.querySelectorAll('.prompt-model-trigger.is-open').forEach(t => {
                        if (t !== trigger) t.classList.remove('is-open');
                    });

                    if (isOpen) {
                        dropdownPanel!.classList.remove('is-open');
                        trigger!.classList.remove('is-open');
                    } else {
                        dropdownPanel!.classList.add('is-open');
                        trigger!.classList.add('is-open');
                        const ui = this.agentModelUIs.get(agentName);
                        ui?.updateModelOptions();
                    }
                });
            } else {
                // Sync trigger text with current select element value
                const triggerText = trigger.querySelector('.prompt-model-trigger-text');
                if (triggerText) {
                    triggerText.textContent = selectElement.value || 'Select Model';
                }
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
                    if (triggerText) {
                        triggerText.textContent = model || 'Select Model';
                    }
                    // Close floating panel on selection
                    dropdownPanel?.classList.remove('is-open');
                    trigger?.classList.remove('is-open');
                }
            });
            ui.initialize();
            if (agentName) {
                this.agentModelUIs.set(agentName, ui);
            }
        });

        // Set up change detection for all textareas
        setTimeout(() => {
            this.setupChangeDetection();
        }, 100);
    }

    private setupChangeDetection(): void {
        // Get all prompt textareas
        const textareas = document.querySelectorAll('.prompt-textarea');

        textareas.forEach((textarea) => {
            const textareaElement = textarea as HTMLTextAreaElement;
            const textareaId = textareaElement.id;

            // Find the corresponding agent name from the textarea ID
            const agentName = this.getAgentNameFromTextareaId(textareaId);
            if (!agentName) return;

            // Store original value on first load
            if (!textareaElement.dataset.originalValue) {
                textareaElement.dataset.originalValue = textareaElement.value;
            }

            // Add input listener to check for changes
            textareaElement.addEventListener('input', () => {
                this.checkPromptChanges(agentName);
            });

            // Initial check
            this.checkPromptChanges(agentName);
        });
    }

    private getAgentNameFromTextareaId(textareaId: string): string | null {
        // Reverse mapping from textarea ID to agent name
        for (const [agentName, id] of Object.entries(this.getPromptAgentMap())) {
            if (id === textareaId) {
                return agentName;
            }
        }

        return null;
    }



    private getPromptAgentMap(): Record<string, string> {
        const map: Record<string, string> = {};

        for (const pane of [
            ...DEEPTHINK_PROMPT_PANES,
            ...ADAPTIVE_PROMPT_PANES,
            ...CONTEXTUAL_PROMPT_PANES
        ]) {
            if (pane.textareaId) {
                map[pane.agentName ?? pane.key] = pane.textareaId;
            }
        }

        return map;
    }



    private getTextareaIdForAgent(agentName: string): string | null {
        return this.getPromptAgentMap()[agentName] || null;
    }

    private checkPromptChanges(agentName: string): void {
        const textareaId = this.getTextareaIdForAgent(agentName);
        if (!textareaId) return;
        const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
        if (!textarea) return;
        const isChanged = textarea.value !== (textarea.dataset.originalValue ?? '');
        textarea.classList.toggle('has-changes', isChanged);
    }

    public updateTriggerState(isGenerating: boolean): void {
        if (this.elements.trigger) {
            const parentSection = this.elements.trigger.closest('.sidebar-section');
            if (parentSection) {
                parentSection.classList.toggle('disabled', isGenerating);
            }
            this.elements.trigger.style.pointerEvents = isGenerating ? 'none' : 'auto';
            this.elements.trigger.style.opacity = isGenerating ? '0.6' : '1';
        }
    }
}
