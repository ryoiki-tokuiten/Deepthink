/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MANDATORY REFERENCE: Read Deepthink_Consolidated_Specification.md before modifying!
 * The specification document (Deepthink/docs/Deepthink_Consolidated_Specification.md)
 * is the absolute source of truth (§1, §2, §3, §5, §6, §7, §8).
 */

import type { CustomizablePromptsDeepthink } from '../prompts';

export type AgentStatus = 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';

export interface DeepthinkRunConfig {
  /** Total iterations (5 to 20, default 10) */
  i: number;
  /** Iterations between global updates (3 to 8, default 5) */
  j: number;
  /** Iterations between curated-context heartbeats (2 to j, default 3) */
  k: number;
  /** Number of active strategy branches (1 to 5) */
  strategiesCount: number;
  /** Strategy generator/proximity turns */
  strategyProximityLoops: number;
  /** Modules per heartbeat (0 disables modules) */
  modulesCount: number;
  /** Modules Generator / Modules Impact Reviewer turns */
  modulesImpactReviewLoops: number;
  /** Correction agents receive no peer-branch context (enforced by prompt) */
  isolateBranches: boolean;
  /** Enables role-scoped sandbox tools */
  deepthinkCodeExecutionEnabled: boolean;
  /** Provider reasoning effort */
  thinkingLevel?: string;
  /** Optional custom model overrides */
  model?: string;
  /** Noise level tau for BSR (smallest net change called a trend) */
  bsrNoiseLevel?: number;
  /** Pressure floor theta for BSR (least pressure triggering EVOLVE or PRUNE) */
  bsrPressureFloor?: number;
  /** Event size weight for small events */
  bsrWeightSmall?: number;
  /** Event size weight for medium events */
  bsrWeightMedium?: number;
  /** Event size weight for large events */
  bsrWeightLarge?: number;
  /** Weight preset key */
  bsrWeightPreset?: string;
}

export interface DeepthinkBranchIteration {
  iterationNumber: number;
  critique: string;
  critiqueDisplay?: string;
  correctedSolution: string;
  correctedSolutionDisplay?: string;
  correctedSolutionExecutionTraceText?: string;
  critiqueExecutionTraceText?: string;
  timestamp: number;
}

export interface DeepthinkMainStrategyData {
  id: string;
  strategyText: string;
  strategyTextHistory?: Array<{ iteration: number; text: string }>;
  solutionAttempt?: string;
  solutionAttemptDisplay?: string;
  solutionAttemptExecutionTraceText?: string;
  solutionCritique?: string;
  solutionCritiqueDisplay?: string;
  solutionCritiqueExecutionTraceText?: string;
  solutionCritiqueStatus?: AgentStatus;
  refinedSolution?: string;
  refinedSolutionDisplay?: string;
  refinedSolutionExecutionTraceText?: string;
  correctionStatus?: AgentStatus | 'skipped';
  status: AgentStatus;
  error?: string;
  iterationHistory?: {
    iterations: DeepthinkBranchIteration[];
    status: 'idle' | 'processing' | 'completed' | 'error';
  };
  memoryBank?: string;
}

export interface DeepthinkModuleData {
  id: string;
  moduleText: string;
  targetBranchIds?: string[];
  testerAttempt?: string;
  testerAttemptDisplay?: string;
  testerAttemptExecutionTraceText?: string;
  testerStatus: AgentStatus;
  testerVerdict?: 'VALIDATED' | 'REJECTED' | 'INCONCLUSIVE';
  roundNumber?: number;
  globalIteration?: number;
}

// ============================================================================
// BSR (Branch State Representation) Data Structures (§6)
// ============================================================================

export type BsrEventSize = 'small' | 'medium' | 'large';

export interface BsrEvent {
  iteration: number;
  size: BsrEventSize;
  reason: string;
}

export interface BsrLedgerEntry {
  iteration: number;
  direction: 'progress' | 'regression';
  size: BsrEventSize;
  weight: number;
  reason: string;
}

export interface BsrReport {
  branch_id: string;
  confirmed_progress: BsrEvent[];
  confirmed_regression: BsrEvent[];
  critique_alignment: {
    value: number;
    reason: string;
  };
}

export type BsrWindowOutcome = 'PROGRESS' | 'STALL' | 'REGRESS';
export type BsrAction = 'CONTINUE' | 'EVOLVE' | 'PRUNE';
export type BsrEvolveForm = 'in_place' | 'rollback';

export interface BsrComputedScores {
  net: number;
  movement: number;
  window_outcome: BsrWindowOutcome;
  last_good_iteration: number | 'window_start';
  lost_ground: number;
  progress_kept: number;
  drift: number;
  stall_evidence: number;
  pressure: {
    CONTINUE: number;
    EVOLVE: number;
    PRUNE: number;
  };
  decision: BsrAction;
  form?: BsrEvolveForm;
  rollback_to?: number | 'window_start';
}

export interface BsrGlobalUpdateRecord {
  updateNumber: number;
  iteration: number;
  branch_id: string;
  report: BsrReport;
  computed: BsrComputedScores;
}

// ============================================================================
// DOS (Dissected Observations Synthesis) Data Structures (§5)
// ============================================================================

export type ModuleUtilizationClassification =
  | 'USED_CORRECTLY'
  | 'USED_PARTIALLY'
  | 'NOT_USED'
  | 'MISUSED';

export interface DosBranchUtilization {
  branch_id: string;
  utilization: {
    reason: string;
    classification: ModuleUtilizationClassification;
  };
}

export interface DosCritiqueCounterevidence {
  branch_id: string;
  reason: string;
  classification: 'STRONG';
}

export interface DosModuleFeedbackItem {
  module_id: string;
  branch_utilization: DosBranchUtilization[];
  critique_counterevidence?: DosCritiqueCounterevidence[];
}

export interface DosOutput {
  core_synthesis: Record<string, unknown>;
  module_feedback?: DosModuleFeedbackItem[];
}

export interface RealizedModuleFeedback {
  module_id: string;
  observed_test_outcome: 'VALIDATED' | 'REJECTED' | 'INCONCLUSIVE';
  utilization?: {
    correct_use: number;
    partial_use: number;
    not_used: number;
    misused: number;
  };
  utilization_note?: string;
  critique_counterevidence?: Array<{
    branch_id: string;
    classification: 'STRONG';
    reason: string;
  }>;
}

export interface HeartbeatBlock {
  heartbeat_no: number;
  iteration: number;
  dosFilePath?: string;
  modules: DeepthinkModuleData[];
  realized_feedback: RealizedModuleFeedback[];
}

// ============================================================================
// Pipeline State (§1)
// ============================================================================

export interface DeepthinkLiveEvent {
  id: string;
  timestamp: number;
  agentName: string;
  stepDescription: string;
  eventType: 'info' | 'agent_start' | 'agent_complete' | 'agent_error' | 'agent_retry';
  systemInstruction?: string;
  prompt?: string;
  response?: string;
  executionTraceText?: string;
  error?: string;
  attempt?: number;
  modelName?: string;
  codeExecutionEnabled?: boolean;
  executionId?: string;
  executionGroupId?: string;
  executionGroupName?: string;
}

export interface ProximityTurn {
  role: 'generator' | 'proximity';
  content: string;
  timestamp: number;
  turnNumber?: number;
  roundNumber?: number;
  version?: number;
}

export interface DeepthinkPipelineState {
  id: string;
  challenge: string;
  status: 'idle' | 'processing' | 'completed' | 'error' | 'stopping' | 'stopped' | 'cancelled';
  error?: string;
  activeTabId: string;
  activeStrategyTab?: number;
  isStopRequested?: boolean;

  // Run configuration
  runConfig: DeepthinkRunConfig;
  customPrompts?: CustomizablePromptsDeepthink;

  // Active branches (main1 to mainN)
  initialStrategies: DeepthinkMainStrategyData[];
  strategyProximityHistory: ProximityTurn[];

  // Curated Context & Heartbeats
  heartbeats: HeartbeatBlock[];
  modules: DeepthinkModuleData[];
  modulesImpactReviewHistory: ProximityTurn[];

  // BSR & Global Updates
  bsrRecords: BsrGlobalUpdateRecord[];
  branchLedgers: Record<string, BsrLedgerEntry[]>;

  // DOS
  dosOutputs: Array<{
    callType: 'heartbeat' | 'step_i' | 'step_ii';
    iteration: number;
    output: DosOutput;
  }>;

  // Final Results
  finalJudgedBestSolution?: string;
  finalJudgingResponseText?: string;
  finalJudgingExecutionTraceText?: string;
  finalJudgingStatus?: AgentStatus;
  finalJudgingError?: string;

  // Live event feed
  liveEvents?: DeepthinkLiveEvent[];
  repositoryRevision?: string;
  currentIteration?: number;
  heartbeatNo?: number;
  prunedBranches?: any[];

  // State tracking fields for UI panels
  solutionCritiques?: any[];
  solutionCritiquesStatus?: any;
  modulesExplorerComplete?: boolean;
}

/** A module packet captured for one heartbeat round. */
export interface ModuleRoundSnapshot {
    roundNumber: number;
    packet: string;
    modules?: DeepthinkModuleData[];
}

export interface DeepthinkResultsContextFile {
  path: string;
  content: string;
}

export interface SandboxRepositoryAccess {
  repositoryId: string;
  agentDirectory?: string;
  agentDirectoryReadOnly?: boolean;
  readableDirectories?: string[];
  liveReadableDirectories?: string[];
  blockedDirectories?: string[];
  fullRepositoryRead?: boolean;
}

