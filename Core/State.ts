import { DeepthinkPipelineState, FileData } from './Types';
import { createDefaultCustomPromptsDeepthink } from '../Deepthink/prompts';

class GlobalStateManager {
    activeDeepthinkPipeline: DeepthinkPipelineState | null = null;
    isGenerating: boolean = false;
    directContextFiles: FileData[] = [];
    filesystemContextFiles: FileData[] = [];

    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string = 'high';

    customPromptsDeepthinkState = createDefaultCustomPromptsDeepthink();
}

export const globalState = new GlobalStateManager();
