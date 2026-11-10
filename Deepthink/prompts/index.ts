import { deepthinkSharedDocument } from './sharedDocument.ts';
import { strategyGeneratorPrompt } from './strategyGenerator.ts';
import { modulesGeneratorPrompt } from './modulesGenerator.ts';
import { modulesBuildingPrompt } from './modulesBuilding.ts';
import { critiqueAgentPrompt } from './critiqueAgent.ts';
import { executionAgentPrompt } from './executionAgent.ts';
import { memoryBankPrompt } from './memoryBank.ts';
import { stateSynthesisPrompt } from './stateSynthesis.ts';
import { bsrPrompt } from './bsr.ts';

export interface CustomizablePromptsDeepthink {
  sys_deepthink_initialStrategy: string;
  sys_deepthink_modulesGeneration: string;
  sys_deepthink_modulesBuilding: string;
  sys_deepthink_critiqueAgent: string;
  sys_deepthink_executionAgent: string;
  sys_deepthink_memoryBank: string;
  sys_deepthink_stateSynthesis: string;
  sys_deepthink_bsr: string;

  model_initialStrategy?: string | null;
  model_modulesGeneration?: string | null;
  model_modulesBuilding?: string | null;
  model_critiqueAgent?: string | null;
  model_executionAgent?: string | null;
  model_memoryBank?: string | null;
  model_stateSynthesis?: string | null;
  model_bsr?: string | null;
}

export function createDefaultCustomPromptsDeepthink(): CustomizablePromptsDeepthink {
  return {
    sys_deepthink_initialStrategy: strategyGeneratorPrompt,
    sys_deepthink_modulesGeneration: modulesGeneratorPrompt,
    sys_deepthink_modulesBuilding: modulesBuildingPrompt,
    sys_deepthink_critiqueAgent: critiqueAgentPrompt,
    sys_deepthink_executionAgent: executionAgentPrompt,
    sys_deepthink_memoryBank: memoryBankPrompt,
    sys_deepthink_stateSynthesis: stateSynthesisPrompt,
    sys_deepthink_bsr: bsrPrompt,
  };
}

export {
  deepthinkSharedDocument,
  strategyGeneratorPrompt,
  modulesGeneratorPrompt,
  modulesBuildingPrompt,
  critiqueAgentPrompt,
  executionAgentPrompt,
  memoryBankPrompt,
  stateSynthesisPrompt,
  bsrPrompt,
};
