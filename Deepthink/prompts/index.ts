import { deepthinkSharedDocument } from './sharedDocument.ts';
import { strategyGeneratorPrompt } from './strategyGenerator.ts';
import { modulesGeneratorPrompt } from './modulesGenerator.ts';
import { modulesTesterPrompt } from './modulesTester.ts';
import { solutionAttemptPrompt } from './solutionAttempt.ts';
import { solutionCritiquePrompt } from './solutionCritique.ts';
import { solutionCorrectionPrompt } from './solutionCorrection.ts';
import { memoryBankPrompt } from './memoryBank.ts';
import { dosPrompt } from './dos.ts';
import { bsrPrompt } from './bsr.ts';

export interface CustomizablePromptsDeepthink {
  sys_deepthink_initialStrategy: string;
  sys_deepthink_modulesGeneration: string;
  sys_deepthink_modulesTester: string;
  sys_deepthink_solutionAttempt: string;
  sys_deepthink_solutionCritique: string;
  sys_deepthink_solutionCorrection: string;
  sys_deepthink_memoryBank: string;
  sys_deepthink_dos: string;
  sys_deepthink_bsr: string;

  model_initialStrategy?: string | null;
  model_modulesGeneration?: string | null;
  model_modulesTester?: string | null;
  model_solutionAttempt?: string | null;
  model_solutionCritique?: string | null;
  model_solutionCorrection?: string | null;
  model_memoryBank?: string | null;
  model_dos?: string | null;
  model_bsr?: string | null;
}

export function createDefaultCustomPromptsDeepthink(): CustomizablePromptsDeepthink {
  return {
    sys_deepthink_initialStrategy: strategyGeneratorPrompt,
    sys_deepthink_modulesGeneration: modulesGeneratorPrompt,
    sys_deepthink_modulesTester: modulesTesterPrompt,
    sys_deepthink_solutionAttempt: solutionAttemptPrompt,
    sys_deepthink_solutionCritique: solutionCritiquePrompt,
    sys_deepthink_solutionCorrection: solutionCorrectionPrompt,
    sys_deepthink_memoryBank: memoryBankPrompt,
    sys_deepthink_dos: dosPrompt,
    sys_deepthink_bsr: bsrPrompt,
  };
}

export {
  deepthinkSharedDocument,
  strategyGeneratorPrompt,
  modulesGeneratorPrompt,
  modulesTesterPrompt,
  solutionAttemptPrompt,
  solutionCritiquePrompt,
  solutionCorrectionPrompt,
  memoryBankPrompt,
  dosPrompt,
  bsrPrompt,
};
