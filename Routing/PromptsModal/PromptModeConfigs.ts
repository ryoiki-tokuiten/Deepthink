import type { CustomizablePromptsAdaptiveDeepthink } from '../../AdaptiveDeepthink/AdaptiveDeepthinkPrompt';
import type { CustomizablePromptsContextual } from '../../Contextual/ContextualPrompts';
import type { CustomizablePromptsDeepthink } from '../../Deepthink/prompts';
import {
    DEEPTHINK_AGENT_REGISTRY,
    type DeepthinkAgentKind
} from '../../Deepthink/core/agentRegistry';
import type { PromptPaneConfig } from '../../Styles/Components/PromptContent';

function paneSlug(agentKind: DeepthinkAgentKind): string {
    return agentKind.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

export const DEEPTHINK_PROMPT_PANES: readonly PromptPaneConfig<CustomizablePromptsDeepthink>[] =
    (Object.keys(DEEPTHINK_AGENT_REGISTRY) as DeepthinkAgentKind[])
        .filter(agentKind => agentKind !== 'strategyProximity' && agentKind !== 'modulesImpactReview')
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
