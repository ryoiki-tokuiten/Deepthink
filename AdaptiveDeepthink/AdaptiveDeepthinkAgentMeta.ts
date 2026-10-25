/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const ADAPTIVE_DEEPTHINK_AGENT_META: Record<string, { displayName: string; icon: string }> = {
    generate_strategies: {
        displayName: 'Strategy Generation Agent',
        icon: 'psychology'
    },
    generate_modules: {
        displayName: 'Modules Generator Agent',
        icon: 'science'
    },
    test_modules: {
        displayName: 'Modules Testing Agent',
        icon: 'troubleshoot'
    },
    execute: {
        displayName: 'Execution / Critique / Correction',
        icon: 'settings_suggest'
    },
    finalize_pass_and_execute: {
        displayName: 'Finalize Pass / Execute',
        icon: 'forward'
    },
    save: {
        displayName: 'Save Strategy',
        icon: 'bookmark_added'
    },
    read_files: {
        displayName: 'Read Pass Artifacts',
        icon: 'description'
    },
    virtual_environment: {
        displayName: 'Virtual Environment',
        icon: 'terminal'
    },
    submit_final_output: {
        displayName: 'Orchestrator Final Output',
        icon: 'flag'
    }
};

export function isAdaptiveDeepthinkAgentTool(toolName: string): boolean {
    return toolName in ADAPTIVE_DEEPTHINK_AGENT_META;
}

export function getAdaptiveDeepthinkAgentDisplayName(toolName: string): string {
    return ADAPTIVE_DEEPTHINK_AGENT_META[toolName]?.displayName ?? toolName;
}

export function getAdaptiveDeepthinkAgentIcon(toolName: string): string {
    return ADAPTIVE_DEEPTHINK_AGENT_META[toolName]?.icon ?? 'smart_toy';
}
