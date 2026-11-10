import type { BsrAction, BsrEvolveForm } from './types.ts';

export function buildStrategyGlobalUpdateNote(j: number): string {
  return [
    `These strategies were actually finalized and were executed, critiqued, and corrected for ${j} iterations.`,
    `The State-Synthesis-For-Strategies output is a synthesis of the critique across each branch so that you understand where each branch is failing exactly.`,
    `For richer context, you have also received the latest corrections in every branch.`,
    `Finally, you will receive a BSR object calculated by the harness from each branch's observed window and standing event ledger, containing the decisions about what to continue, evolve, and prune.`,
    `Now generate the new strategies object for the changed slots only.`
  ].join(' ');
}

export function buildModuleHeartbeatNote(heartbeatNo: number): string {
  if (heartbeatNo <= 1) {
    return [
      `The branches have executed, critiqued, and completed the branch rollout and distillation for this first Global Update.`,
      `You have received the State-Synthesis-For-Modules synthesis of where each branch currently stands after the Global Update decisions, along with the currently running strategies and their latest corrections.`,
      `Now generate the initial modules object.`
    ].join(' ');
  }
  const prevHb = heartbeatNo - 1;
  return [
    `The modules from Global Update / Heartbeat ${prevHb} were finalized, built independently by dedicated Modules Building agents, and mapped as packets to the target branches, which then executed with them across the window.`,
    `Below is the context for Heartbeat ${heartbeatNo}: the finalized modules from Heartbeat ${prevHb} and their independent build/test outputs,`,
    `the mapped branch packets showing the current running strategies, their latest corrections, and which modules were routed to which branches,`,
    `the realized module feedback (observed test outcome, utilization across surviving branches, and critique counterevidence),`,
    `the ledger of modules finalized and used so far across prior heartbeats,`,
    `and the new State-Synthesis-For-Modules synthesis. Now generate the new modules object.`
  ].join(' ');
}

export const STATE_SYNTHESIS_FOR_STRATEGIES_NOTE = [
  'Your output is going to the strategy agents that are about to revise strategies for EVOLVE and PRUNE slots in this global update.',
  'So write it for them: where exactly each branch is failing, what the branches share, what looks worth keeping.',
  'Here you only receive the latest correction and critique of every branch, so there is no module feedback to produce in this call.'
].join(' ');

export function buildStateSynthesisForModulesNote(
  slotStatuses: Array<{
    slotId: string;
    action: BsrAction;
    form?: BsrEvolveForm;
    rollbackTo?: number | 'window_start';
  }>
): string {
  const formattedSlots = slotStatuses.map(s => {
    if (s.action === 'CONTINUE') {
      return `- ${s.slotId}: CONTINUE (surviving uninterrupted, memory bank distilled)`;
    }
    if (s.action === 'EVOLVE') {
      if (s.form === 'rollback' && s.rollbackTo !== undefined) {
        const targetStr = s.rollbackTo === 'window_start' ? 'window start' : `iteration ${s.rollbackTo}`;
        return `- ${s.slotId}: EVOLVE with rollback (reverted to ${targetStr}, discarded later iterations, memory bank distilled up to ${targetStr})`;
      }
      return `- ${s.slotId}: EVOLVE in place (re-aimed strategy text, progress standing, memory bank distilled)`;
    }
    return `- ${s.slotId}: PRUNE (archived, freed slot now holds a new branch starting with first execution + critique)`;
  }).join('\n');

  return [
    'This is State-Synthesis-For-Modules, your second call in this global update. Since your State-Synthesis-For-Strategies output, the branch decisions, memory bank distillations, rollbacks, and replacement branch executions were applied. The status of every slot is listed below:',
    formattedSlots,
    '',
    'Branches that were pruned are gone and their slots now hold new branches that only have a first execution and critique.',
    'A branch that was rolled back no longer contains the iterations after its rollback point.',
    'You also receive your own State-Synthesis-For-Strategies output from this global update as your baseline.',
    'If modules were generated at the previous global update, their definitions, build/test outputs, and mappings are included now: produce module feedback ONLY for assignments you can really observe, which means the branches that survived (CONTINUE and EVOLVE).',
    'You cannot say anything about the new replacement branches in PRUNE slots and that is fine, leave them out of module_feedback.',
    'Do not repeat your State-Synthesis-For-Strategies output verbatim: use it as a base and give a nuanced synthesis of the post-update state for the Modules Generator and Modules Impact Reviewer.'
  ].join('\n');
}

export function buildRemainingToolCallsHarnessNote(
  remainingTurns: number,
  maxToolTurns: number
): string {
  return `[HARNESS NOTE — ${remainingTurns} TOOL CALLS REMAINING]: You have ${remainingTurns} tool-call iterations remaining out of your maximum budget of ${maxToolTurns}. Begin wrapping up your verification and prepare to submit your complete response via final_output.`;
}

export function buildOvertimeFinalSubmitHarnessNote(
  maxToolTurns: number,
  graceTurns = 5
): string {
  return [
    '================================================================================',
    `[CRITICAL HARNESS WARNING — MAXIMUM TOOL CALL BUDGET (${maxToolTurns}) REACHED]`,
    'STOP ALL NEW EXPLORATION AND SUBMIT YOUR FINAL OUTPUT NOW!',
    `You have exhausted your full budget of ${maxToolTurns} tool-call iterations without submitting via final_output.`,
    `Your run is NOT being restarted—all of your sandbox work and conversation history remain intact—and you have been granted a strict final grace window of ${graceTurns} turns to wrap up and call final_output.`,
    `If you do not submit via final_output within these ${graceTurns} turns, all other tool access (sandbox_exec, shared_workspace) will be completely revoked and only final_output will remain available.`,
    'Synthesize your findings and call final_output immediately!',
    '================================================================================',
  ].join('\n');
}

export function buildRevokedToolsFinalSubmitHarnessNote(): string {
  return [
    '================================================================================',
    '[CRITICAL HARNESS ENFORCEMENT — ALL OTHER TOOL ACCESS REVOKED]',
    'You did not submit within the 5-turn grace window after reaching the maximum tool call budget.',
    'Access to sandbox_exec and shared_workspace has now been revoked.',
    'Only the final_output tool is available. Call final_output immediately with your complete response.',
    '================================================================================',
  ].join('\n');
}

export function buildRemainingSandboxTimeHarnessNote(
  remainingMinutes: number,
  maxMinutes = 60
): string {
  return `[HARNESS NOTE — ${remainingMinutes} MINUTES REMAINING]: You have ${remainingMinutes} minutes of wall-clock time remaining out of your maximum ${maxMinutes}-minute sandbox budget. Begin wrapping up your verification and prepare to submit your complete response via final_output.`;
}

export function buildSandboxTimeExpiredFinalSubmitHarnessNote(
  maxMinutes = 60
): string {
  return [
    '================================================================================',
    `[CRITICAL HARNESS ENFORCEMENT — MAXIMUM SANDBOX TIME BUDGET (${maxMinutes} MINUTES) REACHED]`,
    'STOP ALL NEW EXPLORATION AND SUBMIT YOUR FINAL OUTPUT NOW!',
    `You have reached the ${maxMinutes}-minute wall-clock time limit for this agent invocation without submitting via final_output.`,
    'Your run is NOT being restarted—all of your sandbox work and conversation history remain intact.',
    'Access to sandbox_exec and shared_workspace has now been revoked.',
    'Only the final_output tool is available. Call final_output immediately with your complete response.',
    '================================================================================',
  ].join('\n');
}

export function buildFinalOutputTokenGateHarnessNote(
  agentName: string,
  actualTokens: number,
  maxOutputTokens: number
): string {
  return `[HARNESS NOTE — FINAL OUTPUT TOKEN LIMIT EXCEEDED]: Your final_output submission for ${agentName} was ${actualTokens} tokens, which exceeds the maximum allowed limit of ${maxOutputTokens} output tokens. Your tool call and its error remain in history. Please output at most ${maxOutputTokens} max output tokens for ${agentName} by condensing and tightening your response, then call final_output again.`;
}

export function buildSharedWorkspaceTokenGateHarnessNote(
  actualTokens: number,
  maxTokens = 5000
): string {
  return `[HARNESS NOTE — SHARED WORKSPACE TOKEN LIMIT EXCEEDED]: Your shared_workspace update resulted in ${actualTokens} tokens, which exceeds the maximum limit of ${maxTokens} tokens for shared_workspace.md. Your tool call and its error remain in history. Please output and maintain at most ${maxTokens} total tokens in shared_workspace.md by using shared_workspace(action="edit", old_string=..., new_string=...) to condense or replace existing sections.`;
}
