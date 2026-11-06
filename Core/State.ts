
import { ApplicationMode, DeepthinkPipelineState, FileData } from './Types';
import { createDefaultCustomPromptsDeepthink } from '../Deepthink/prompts';
import { createDefaultCustomPromptsAdaptiveDeepthink } from '../AdaptiveDeepthink/AdaptiveDeepthinkPrompt';
import { createDefaultCustomPromptsContextual } from '../Contextual/ContextualPrompts';

class GlobalStateManager {
    currentMode: ApplicationMode = 'deepthink';
    activeDeepthinkPipeline: DeepthinkPipelineState | null = null;
    isGenerating: boolean = false;
    directContextFiles: FileData[] = [];
    filesystemContextFiles: FileData[] = [];

    // Mode running states
    isContextualRunning: boolean = false;
    isAdaptiveDeepthinkRunning: boolean = false;

    virtualEnvironmentEnabled: boolean = false;

    // Thinking / Reasoning Level
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string = 'high';

    customPromptsDeepthinkState = createDefaultCustomPromptsDeepthink();
    customPromptsAdaptiveDeepthinkState = createDefaultCustomPromptsAdaptiveDeepthink();
    customPromptsContextualState = createDefaultCustomPromptsContextual();
}

export const globalState = new GlobalStateManager();
