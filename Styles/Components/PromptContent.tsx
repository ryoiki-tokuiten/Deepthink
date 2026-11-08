import React, { useEffect, useState } from 'react';
import { PromptStylingEditor } from './PromptStyling';
import { Icon } from '../../UI/Icons';
import { DEEPTHINK_PROMPT_PANES } from '../../Routing/PromptsModal';
import { getRoutingManager } from '../../Routing';

interface PromptContentManager<T extends object> {
    getPrompts(): T;
    subscribe(listener: (state: T) => void): () => void;
    updatePrompt(key: keyof T, value: string): void;
    updateModel?(key: keyof T, value: string): void;
}

export interface PromptPaneConfig<T extends object> {
    key: string;
    title: string;
    promptKey: keyof T;
    modelKey: keyof T;
    rows?: number;
    placeholder?: string;
    textareaId?: string;
    agentName?: string;
    showAvailableModels?: boolean;
}

interface PromptContentProps<T extends object> {
    containerId: string;
    panes: readonly PromptPaneConfig<T>[];
    manager: PromptContentManager<T>;
    availableModels?: string[];
}

function promptValue<T extends object>(prompts: T, key: keyof T): string {
    const value = prompts[key];
    return typeof value === 'string' ? value : '';
}

export function PromptContent<T extends object>({
    containerId,
    panes,
    manager,
    availableModels = []
}: PromptContentProps<T>): React.ReactElement {
    const [prompts, setPrompts] = useState<T>(() => manager.getPrompts());
    useEffect(() => manager.subscribe(setPrompts), [manager]);

    return (
        <div id={containerId} className="prompts-mode-container">
            {panes.map(pane => {
                const models = pane.showAvailableModels !== false ? availableModels : [];
                return (
                    <div key={pane.key} className="prompt-content-pane" data-prompt-key={pane.key}>
                        <h4 className="prompt-pane-title">{pane.title}</h4>
                        <div className="prompt-card">
                            <div className="prompt-card-header">
                                <span className="prompt-card-title">System Instruction</span>
                                <div className="prompt-model-selector">
                                    <select
                                        className="prompt-model-select"
                                        data-agent={pane.agentName}
                                        value={promptValue(prompts, pane.modelKey)}
                                        onChange={e => (manager.updateModel ? manager.updateModel(pane.modelKey, e.target.value) : manager.updatePrompt(pane.modelKey, e.target.value))}
                                    >
                                        <option value="">Use Global Model</option>
                                        {models.map(model => (
                                            <option key={model} value={model}>{model}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="prompt-card-body">
                                <PromptStylingEditor
                                    id={pane.textareaId}
                                    className="prompt-textarea"
                                    rows={pane.rows ?? 8}
                                    value={promptValue(prompts, pane.promptKey)}
                                    placeholder={pane.placeholder}
                                    onChange={val => manager.updatePrompt(pane.promptKey, val)}
                                />
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export const PromptsModalManager: React.FC = () => {
    const [promptsManager, setPromptsManager] = useState(() => getRoutingManager().getPromptsManager());

    useEffect(() => {
        if (promptsManager) return;
        const retry = window.setInterval(() => {
            const manager = getRoutingManager().getPromptsManager();
            if (manager) setPromptsManager(manager);
        }, 25);
        return () => window.clearInterval(retry);
    }, [promptsManager]);

    if (!promptsManager) return null;

    const modelConfigManager = getRoutingManager().getModelConfigManager();
    const availableModels = modelConfigManager ? modelConfigManager.getAvailableModels().map((m: any) => m.value) : [];

    return (
        <div id="prompts-modal-overlay" className="modal-overlay">
            <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="prompts-modal-title">
                <header className="modal-header">
                    <h2 id="prompts-modal-title" className="modal-title">Customize Prompts</h2>
                    <button id="prompts-modal-close-button" className="modal-close-button" aria-label="Close Custom Prompts">
                        <Icon name="close" />
                    </button>
                </header>
                <div id="prompts-modal-body" className="modal-body">
                    <div id="prompts-modal-layout" className="prompts-modal-layout">
                        <nav id="prompts-modal-nav" className="prompts-nav custom-scrollbar"></nav>
                        <div id="prompts-modal-content" className="prompts-content custom-scrollbar">
                            <PromptContent
                                containerId="deepthink-prompts-container"
                                panes={DEEPTHINK_PROMPT_PANES}
                                manager={promptsManager.getDeepthinkPromptsManager()}
                                availableModels={availableModels}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

