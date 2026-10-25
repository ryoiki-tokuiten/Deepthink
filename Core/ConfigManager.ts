/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * ConfigManager - Configuration export/import using the new StateSerializer infrastructure.
 * 
 * Features:
 * - MessagePack binary serialization (faster, smaller)
 * - Gzip compression (70-90% size reduction)
 * - Automatic state sanitization (resets processing states)
 * - Strict versioned state imports
 */

import { globalState } from './State';
import {
    getModeHandler,
    sanitizeState,
    serialize,
    deserialize,
    downloadBlob,
    getFileExtension,
    formatBytes,
    estimateSerializedSize,
    CURRENT_STATE_VERSION,
    type VersionedState,
    type ExportedConfig,
    isVersionedState,
    type SerializationOptions,
} from './StateSerializer';

import { updateUIAfterModeChange } from './AppRouter';
import { createDefaultCustomPromptsDeepthink } from '../Deepthink/prompts';
import { createDefaultCustomPromptsContextual } from '../Contextual/ContextualPrompts';
import { createDefaultCustomPromptsAdaptiveDeepthink } from '../AdaptiveDeepthink/AdaptiveDeepthinkPrompt';
import {
    routingManager,
    getSelectedModel,
    getSelectedStrategiesCount,
    getStrategyProximityLoops,
    getSelectedModulesCount,
    getModulesImpactReviewLoops,
    getDeepthinkDepth,
    getIsolateBranchesEnabled,
    getSelectedThinkingLevel
} from '../Routing';
import { updateControlsState } from '../UI/Controls';

// DOM Elements Helpers
const getInitialIdeaInput = () => document.getElementById('initial-idea') as HTMLTextAreaElement;

/**
 * Export format options.
 */
type ExportFormat = 'auto' | 'json' | 'msgpack';

/**
 * Export configuration to a file.
 * 
 * @param format Export format: 'auto' (msgpack+gzip), 'json' (human-readable), 'msgpack' (binary)
 */
export async function exportConfiguration(format: ExportFormat = 'auto'): Promise<void> {
    if (globalState.isGenerating) {
        alert("Cannot export configuration while generation is in progress.");
        return;
    }

    const initialIdeaInput = getInitialIdeaInput();
    const handler = getModeHandler(globalState.currentMode);

    // Get mode-specific state via handler
    const modeState = handler?.getFullState() ?? null;

    // Get embedded state if handler supports it
    let embeddedStates: Record<string, unknown> | undefined;
    if (handler && 'getEmbeddedState' in handler && typeof handler.getEmbeddedState === 'function') {
        const embedded = await handler.getEmbeddedState();
        if (embedded) {
            embeddedStates = { [`${globalState.currentMode}Embedded`]: embedded };
        }
    }

    // Build the versioned config
    const config: VersionedState = {
        _version: CURRENT_STATE_VERSION,
        _exportedAt: new Date().toISOString(),
        _mode: globalState.currentMode,
        data: {
            currentMode: globalState.currentMode,
            initialIdea: initialIdeaInput?.value ?? '',
            selectedModel: getSelectedModel(),
            modeState,
            embeddedStates,
            customPrompts: {
                deepthink: globalState.customPromptsDeepthinkState,
                contextual: globalState.customPromptsContextualState,
                adaptiveDeepthink: globalState.customPromptsAdaptiveDeepthinkState,
            },
            modelParameters: {
                strategiesCount: getSelectedStrategiesCount(),
                strategyProximityLoops: getStrategyProximityLoops(),
                modulesCount: getSelectedModulesCount(),
                modulesImpactReviewLoops: getModulesImpactReviewLoops(),
                deepthinkDepth: getDeepthinkDepth(),
                isolateBranches: getIsolateBranchesEnabled(),
                deepthinkCodeExecutionEnabled: routingManager.getDeepthinkConfigController().isCodeExecutionEnabled(),
                thinkingLevel: getSelectedThinkingLevel(),
            },
            directContextFiles: globalState.directContextFiles || [],
        },
    };

    // Determine serialization options based on format
    const options: SerializationOptions = {
        format: format === 'json' ? 'json' : 'msgpack',
        compress: format !== 'json', // Compress unless explicitly JSON
        prettyPrint: format === 'json',
    };

    // Show estimated size for large exports
    const estimatedSize = estimateSerializedSize(config);
    if (estimatedSize > 10 * 1024 * 1024) { // >10MB
        console.log(`Exporting large configuration (~${formatBytes(estimatedSize)}), this may take a moment...`);
    }

    // Serialize and download
    const blob = await serialize(config, options);
    const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];
    const extension = getFileExtension(options);
    const filename = `iterative-studio-config-${timestamp}.${extension}`;

    downloadBlob(blob, filename);

    console.log(`Configuration exported: ${filename} (${formatBytes(blob.size)})`);
}

/**
 * Handle importing a configuration file.
 */
export async function handleImportConfiguration(event: Event): Promise<void> {
    if (globalState.isGenerating) {
        alert("Cannot import configuration while generation is in progress.");
        return;
    }

    const fileInputTarget = event.target as HTMLInputElement;
    if (!fileInputTarget.files || fileInputTarget.files.length === 0) {
        return;
    }

    const file = fileInputTarget.files[0];

    try {
        // Deserialize the file (auto-detects format and compression)
        const rawConfig = await deserialize<unknown>(file);

        if (!isVersionedState(rawConfig)) {
            throw new Error('Unsupported configuration file. Import a versioned Iterative Studio export.');
        }
        if (rawConfig._version !== CURRENT_STATE_VERSION) {
            throw new Error(`Unsupported configuration version ${rawConfig._version}. Expected version ${CURRENT_STATE_VERSION}.`);
        }
        const versionedConfig = rawConfig;

        // Apply the configuration
        await applyConfiguration(versionedConfig);

        console.log(`Configuration imported successfully from ${file.name}`);
    } catch (error) {
        console.error('Failed to import configuration:', error);
        alert(`Failed to import configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
        // Reset the file input
        fileInputTarget.value = '';
    }
}

/**
 * Apply an imported configuration to the application state.
 */
async function applyConfiguration(config: VersionedState): Promise<void> {
    const { data } = config;

    // 1. Restore global mode
    globalState.currentMode = data.currentMode;
    const modeRadio = document.querySelector(`input[name="app-mode"][value="${globalState.currentMode}"]`) as HTMLInputElement;
    if (modeRadio) {
        modeRadio.checked = true;
    }

    // 2. Restore initial idea
    const initialIdeaInput = getInitialIdeaInput();
    if (initialIdeaInput) {
        initialIdeaInput.value = data.initialIdea || '';
    }

    // 3. Clear problem images for non-deepthink modes, or restore them if provided
    if (globalState.currentMode !== 'deepthink') {
        globalState.directContextFiles = [];
    } else if (Array.isArray((data as any).directContextFiles)) {
        globalState.directContextFiles = (data as any).directContextFiles;
    }

    // 4. Update UI for mode change
    updateUIAfterModeChange();

    // 5. Reinitialize sidebar controls
    if ((window as any).reinitializeSidebarControls) {
        (window as any).reinitializeSidebarControls();
    }

    // 6. Restore custom prompts
    restoreCustomPrompts(data.customPrompts);

    // 7. Restore model parameters (with delay for UI readiness)
    setTimeout(() => {
        restoreModelParameters(data.modelParameters);
    }, 150);

    // 8. Restore mode-specific state via handler
    const handler = getModeHandler(data.currentMode);
    if (handler && data.modeState) {
        const sanitizedState = sanitizeState(data.modeState);
        handler.restoreState(sanitizedState);

        // Restore embedded state if available
        if (data.embeddedStates && 'restoreEmbeddedState' in handler && typeof handler.restoreEmbeddedState === 'function') {
            const embeddedKey = `${data.currentMode}Embedded`;
            if (data.embeddedStates[embeddedKey]) {
                await handler.restoreEmbeddedState(data.embeddedStates[embeddedKey]);
            }
        }

        // Render after state restoration
        handler.renderAfterImport();
    }

    // 9. Update controls state
    updateControlsState();
}

/**
 * Restore custom prompts from imported configuration.
 */
function restoreCustomPrompts(prompts: ExportedConfig['customPrompts']): void {
    // Configuration map for restoring prompts
    // Maps the prompt key from export -> global state property -> default value generator
    const promptConfigs = [

        {
            key: 'deepthink' as const,
            target: 'customPromptsDeepthinkState' as const,
            getDefault: createDefaultCustomPromptsDeepthink
        },
        {
            key: 'adaptiveDeepthink' as const,
            target: 'customPromptsAdaptiveDeepthinkState' as const,
            getDefault: createDefaultCustomPromptsAdaptiveDeepthink
        },
        {
            key: 'contextual' as const,
            target: 'customPromptsContextualState' as const,
            getDefault: createDefaultCustomPromptsContextual
        }
    ];

    // Iterate and restore
    promptConfigs.forEach(({ key, target, getDefault }) => {
        const value = prompts[key] || getDefault();
        // Deep copy to ensure we don't hold references to export object or defaults
        globalState[target] = JSON.parse(JSON.stringify(value));
    });
}

/**
 * Restore model parameters from imported configuration.
 */
function restoreModelParameters(params: ExportedConfig['modelParameters']): void {
    const modelConfig = routingManager.getModelConfigManager();

    const modelParameterKeys: Array<keyof ExportedConfig['modelParameters']> = [
        'strategiesCount',
        'strategyProximityLoops',
        'modulesCount',
        'modulesImpactReviewLoops',
        'deepthinkDepth',
        'isolateBranches',
        'deepthinkCodeExecutionEnabled',
        'thinkingLevel',
    ];

    for (const key of modelParameterKeys) {
        const value = params[key];
        if (value !== undefined) {
            modelConfig.updateParameter(key as any, value);
        }
    }

    // Sync UI with restored parameters
    const modelSelectionUI = routingManager.getModelSelectionUI();
    if (modelSelectionUI) {
        modelSelectionUI.syncUIWithParameters();
    }
    routingManager.getDeepthinkConfigController().emitFullStateUpdate();
}
