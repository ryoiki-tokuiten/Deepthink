import {
  createDefaultCustomPromptsDeepthink,
  type CustomizablePromptsDeepthink,
} from '../prompts/index.ts';

type DeepthinkSystemPromptKey = Extract<keyof CustomizablePromptsDeepthink, `sys_deepthink_${string}`>;
type DeepthinkModelKey = Extract<keyof CustomizablePromptsDeepthink, `model_${string}`>;

export const DEFAULT_DEEPTHINK_MAX_OUTPUT_TOKENS = 5000;

export const DEEPTHINK_AGENT_REGISTRY = {
  initialStrategy: {
    label: 'Strategy Generator',
    sandboxRole: 'Main Strategy Generation',
    systemPromptKey: 'sys_deepthink_initialStrategy',
    modelKey: 'model_initialStrategy',
    maxOutputTokens: 5000,
  },
  strategyProximity: {
    label: 'Strategies Proximity',
    sandboxRole: 'Main Strategy Generation',
    systemPromptKey: 'sys_deepthink_initialStrategy',
    modelKey: 'model_initialStrategy',
    maxOutputTokens: 5000,
  },
  modulesGeneration: {
    label: 'Modules Generator',
    sandboxRole: 'Modules Generator',
    systemPromptKey: 'sys_deepthink_modulesGeneration',
    modelKey: 'model_modulesGeneration',
    maxOutputTokens: 5000,
  },
  modulesImpactReview: {
    label: 'Modules Impact Reviewer',
    sandboxRole: 'Modules Generator',
    systemPromptKey: 'sys_deepthink_modulesGeneration',
    modelKey: 'model_modulesGeneration',
    maxOutputTokens: 5000,
  },
  modulesTester: {
    label: 'Modules Tester',
    sandboxRole: 'Modules Testing',
    systemPromptKey: 'sys_deepthink_modulesTester',
    modelKey: 'model_modulesTester',
    maxOutputTokens: 5000,
  },
  solutionCritique: {
    label: 'Solution Critique',
    sandboxRole: 'Solution Critique',
    systemPromptKey: 'sys_deepthink_solutionCritique',
    modelKey: 'model_solutionCritique',
    maxOutputTokens: 5000,
  },
  solutionCorrection: {
    label: 'Execution Agent',
    sandboxRole: 'Execution Agent',
    systemPromptKey: 'sys_deepthink_solutionCorrection',
    modelKey: 'model_solutionCorrection',
    maxOutputTokens: 10000,
  },
  memoryBank: {
    label: 'Memory Bank',
    sandboxRole: 'Memory Bank',
    systemPromptKey: 'sys_deepthink_memoryBank',
    modelKey: 'model_memoryBank',
    maxOutputTokens: 10000,
  },
  dos: {
    label: 'Dissected Observations Synthesis',
    sandboxRole: 'Dissected Observations Synthesis',
    systemPromptKey: 'sys_deepthink_dos',
    modelKey: 'model_dos',
    maxOutputTokens: 5000,
  },
  bsr: {
    label: 'Branch State Representation',
    sandboxRole: 'Branch State Representation',
    systemPromptKey: 'sys_deepthink_bsr',
    modelKey: 'model_bsr',
    maxOutputTokens: 5000,
  },
} as const satisfies Record<string, {
  label: string;
  sandboxRole: string;
  systemPromptKey: DeepthinkSystemPromptKey;
  modelKey: DeepthinkModelKey;
  maxOutputTokens: number;
}>;

export type DeepthinkAgentKind = keyof typeof DEEPTHINK_AGENT_REGISTRY;
export type DeepthinkSandboxRole =
  typeof DEEPTHINK_AGENT_REGISTRY[DeepthinkAgentKind]['sandboxRole'];

export function deepthinkAgentMaxOutputTokens(agentKind: DeepthinkAgentKind): number {
  const def = DEEPTHINK_AGENT_REGISTRY[agentKind];
  return def?.maxOutputTokens ?? DEFAULT_DEEPTHINK_MAX_OUTPUT_TOKENS;
}

export function deepthinkAgentModel(
  agentKind: DeepthinkAgentKind,
  prompts?: CustomizablePromptsDeepthink,
  configuredModel?: string
): string {
  const def = DEEPTHINK_AGENT_REGISTRY[agentKind];
  if (!def) {
    if (configuredModel && configuredModel.trim().length > 0) {
      return configuredModel.trim();
    }
    throw new Error(`Unregistered agent kind '${agentKind}' and no model configured.`);
  }
  const promptModel = prompts?.[def.modelKey];
  if (typeof promptModel === 'string' && promptModel.trim().length > 0) {
    return promptModel.trim();
  }
  if (configuredModel && configuredModel.trim().length > 0) {
    return configuredModel.trim();
  }
  throw new Error(
    `No model configured for agent '${agentKind}' (${def.modelKey}) and no base pipeline model provided.`
  );
}

export function deepthinkAgentSystemInstruction(
  agentKind: DeepthinkAgentKind,
  prompts?: CustomizablePromptsDeepthink
): string {
  const def = DEEPTHINK_AGENT_REGISTRY[agentKind];
  if (!def) {
    throw new Error(`Unregistered agent kind: ${agentKind}`);
  }
  const key = def.systemPromptKey;
  const prompt = prompts?.[key];
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt.trim();
  }
  const defaultPrompts = createDefaultCustomPromptsDeepthink();
  const defaultPrompt = defaultPrompts[key];
  if (typeof defaultPrompt === 'string' && defaultPrompt.trim().length > 0) {
    return defaultPrompt.trim();
  }
  throw new Error(`Missing system instruction for agent '${agentKind}' (${key}).`);
}
