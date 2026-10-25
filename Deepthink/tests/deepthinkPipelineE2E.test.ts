/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Comprehensive End-to-End Specification Verification Suite for Deepthink Mode.
 * Source of truth: Deepthink_Consolidated_Specification.md
 *
 * Verifies all programmatic, mathematical, and orchestration mechanics:
 * 1. Specification §6.9 Worked Mathematical Examples (Example 1, Example 2, Example 3)
 * 2. Module utilization formulas (§5.2)
 * 3. Loop controller schedules, barriers, gap rules, and bounds validation (§2, §3)
 * 4. Real-time shared workspace tool isolation and concurrent editing (§8.3, §8.4)
 * 5. Complete end-to-end DeepthinkPipelineOrchestrator execution with REALISTIC model outputs
 *    (simulating markdown code blocks, conversational preambles, and relaxed formatting),
 *    verifying durable repository files, branch state representations, barrier commits,
 *    prune archiving, rollback execution, and final judge constraints (§1-§9).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreWindow,
  computeWindowEvidence,
  computePressures,
  decideAction,
  calculateUtilizationVector,
} from '../core/formulas.ts';
import { BSR_WEIGHT_PRESETS, MAX_DEEPTHINK_DEPTH } from '../../Routing/ModelConfig.ts';
import {
  calculateDeepthinkTokenEstimate,
  buildDeepthinkTokenTrend,
  SANDBOX_PER_CALL,
  SANDBOX_ITERATION_NOISE,
} from '../../Routing/DeepthinkTokenEstimator.ts';
import {
  calculateDeepthinkApiCallsFromParams,
  SANDBOX_API_CALL_MULTIPLIER,
  formatApiCallCount,
} from '../../Routing/ApiCallEstimator.ts';

import {
  validateLoopBounds,
  determinePostIterationStep,
} from '../core/loopController.ts';

import {
  SharedWorkspaceManager,
} from '../core/sharedWorkspace.ts';

import {
  DeepthinkPipelineOrchestrator,
} from '../core/pipelineOrchestrator.ts';
import { extractJsonString } from '../../Core/JsonParser.ts';

import type {
  BsrEvent,
  BsrLedgerEntry,
  DeepthinkLiveEvent,
  DeepthinkPipelineState,
  DosBranchUtilization,
} from '../core/types.ts';
import type { DeepthinkAgentKind } from '../core/agentRegistry.ts';

// Helper to simulate realistic LLM output wrapped in markdown code blocks and conversational text
function wrapInRealisticLLMFence(payload: unknown, preamble = 'Here is the requested output:'): string {
  return `${preamble}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nHope this is helpful!`;
}

// ============================================================================
// SUITE 1: Specification §6.9 Mathematical Worked Examples
// ============================================================================

describe('Deepthink Consolidated Specification §6.9: Mathematical Worked Examples', () => {

  it('Example 1: Healthy branch produces PROGRESS, lost_ground = 0, and CONTINUE decision', () => {
    // Window: iterations 6 to 10
    // Events: it6 progress medium (2), it8 progress large (4), it9 regression small (-1), it10 progress small (1)
    const progressEvents: BsrEvent[] = [
      { iteration: 6, size: 'medium', reason: 'Resolved sub-lemma' },
      { iteration: 8, size: 'large', reason: 'Decisive breakthrough on main term' },
      { iteration: 10, size: 'small', reason: 'Notation and boundary cleanup' },
    ];
    const regressionEvents: BsrEvent[] = [
      { iteration: 9, size: 'small', reason: 'Minor sign flip in index' },
    ];

    // Ledger before window: net 6, movement 8
    const ledgerBefore: BsrLedgerEntry[] = [
      { iteration: 2, direction: 'progress', size: 'large', weight: 4, reason: 'Setup' },
      { iteration: 3, direction: 'progress', size: 'medium', weight: 2, reason: 'Bound' },
      { iteration: 4, direction: 'regression', size: 'small', weight: 1, reason: 'Oversight' },
      { iteration: 5, direction: 'progress', size: 'small', weight: 1, reason: 'Fix' },
    ];

    const windowScoring = scoreWindow(6, 10, progressEvents, regressionEvents, ledgerBefore);

    // 1. Running totals: +2, 0, +4, -1, +1 => totals: 2, 2, 6, 5, 6
    assert.equal(windowScoring.net, 6, 'Net change should equal 6');
    assert.equal(windowScoring.movement, 8, 'Total movement should equal 8');
    assert.equal(windowScoring.windowOutcome, 'PROGRESS', 'net >= 2 so windowOutcome is PROGRESS');
    assert.equal(windowScoring.bestTotal, 6, 'Best total reached is 6');
    assert.equal(windowScoring.lastGoodIteration, 10, 'Last good iteration is 10');

    // 2. Lost ground: (6 - 6) / (8 + 2) = 0
    assert.equal(windowScoring.lostGround, 0, 'Lost ground must be 0');

    // 3. Progress kept: net_life = 6 + 6 = 12, movement_life = 8 + 8 = 16 => 12 / (16 + 2) = 12/18 = 0.667
    assert.ok(Math.abs(windowScoring.progressKept - (12 / 18)) < 1e-4, 'Progress kept should be 12/18 ≈ 0.667');

    // 4. Window evidence: drift = 6 / (8 + 2) = 0.60, stall_evidence = (1 - 0.60) * 0.8 = 0.32
    const evidence = computeWindowEvidence(windowScoring.net, windowScoring.movement, 0.8);
    assert.ok(Math.abs(evidence.drift - 0.60) < 1e-4, 'Drift should be +0.60');
    assert.ok(Math.abs(evidence.stallEvidence - 0.32) < 1e-4, 'Stall evidence should be 0.32');

    // 5. Pressures: CONTINUE = 0.60, EVOLVE = max(0, 0.32 * 0.667) = 0.213, PRUNE = 0.32 * (1 - 0.667) * 1 = 0.107
    const pressures = computePressures(evidence.drift, windowScoring.lostGround, windowScoring.progressKept, evidence.stallEvidence);
    assert.ok(Math.abs(pressures.CONTINUE - 0.60) < 1e-4, 'CONTINUE pressure should be 0.60');
    assert.ok(Math.abs(pressures.EVOLVE - 0.213) < 0.005, 'EVOLVE pressure should be ≈ 0.213');
    assert.ok(Math.abs(pressures.PRUNE - 0.107) < 0.005, 'PRUNE pressure should be ≈ 0.107');

    // 6. Decision: Both EVOLVE and PRUNE are below theta (0.3) and CONTINUE beats both => CONTINUE
    const decisionResult = decideAction(pressures, windowScoring.lostGround, evidence.stallEvidence, windowScoring.progressKept, windowScoring.lastGoodIteration);
    assert.equal(decisionResult.decision, 'CONTINUE', 'Decision must be CONTINUE');
  });

  it('Example 2: Oscillating branch produces REGRESS, high lost_ground, and EVOLVE with rollback', () => {
    // Window: iterations 6 to 10
    // Events: it6 progress large (4), it7 progress small (1), it9 regression large (-4), it10 regression large (-4)
    const progressEvents: BsrEvent[] = [
      { iteration: 6, size: 'large', reason: 'Promising module exploration' },
      { iteration: 7, size: 'small', reason: 'Incremental bound tightening' },
    ];
    const regressionEvents: BsrEvent[] = [
      { iteration: 9, size: 'large', reason: 'Fatal counterexample encountered' },
      { iteration: 10, size: 'large', reason: 'Cascading contradiction throughout derivation' },
    ];

    // Ledger before window: net 6, movement 8
    const ledgerBefore: BsrLedgerEntry[] = [
      { iteration: 2, direction: 'progress', size: 'large', weight: 4, reason: 'Initial foundation' },
      { iteration: 3, direction: 'progress', size: 'medium', weight: 2, reason: 'Structure' },
      { iteration: 4, direction: 'regression', size: 'small', weight: 1, reason: 'Correction' },
      { iteration: 5, direction: 'progress', size: 'small', weight: 1, reason: 'Recovery' },
    ];

    const windowScoring = scoreWindow(6, 10, progressEvents, regressionEvents, ledgerBefore);

    // 1. Running totals: +4, +1, 0, -4, -4 => totals: 4, 5, 5, 1, -3
    assert.equal(windowScoring.net, -3, 'Net change should equal -3');
    assert.equal(windowScoring.movement, 13, 'Total movement should equal 4+1+4+4 = 13');
    assert.equal(windowScoring.windowOutcome, 'REGRESS', 'net <= -2 so windowOutcome is REGRESS');
    assert.equal(windowScoring.bestTotal, 5, 'Best total reached is 5');
    assert.equal(windowScoring.lastGoodIteration, 8, 'Last good iteration is 8 (maintained through iteration 8)');

    // 2. Lost ground: (5 - (-3)) / (13 + 2) = 8 / 15 = 0.533
    assert.ok(Math.abs(windowScoring.lostGround - (8 / 15)) < 1e-4, 'Lost ground must be 8/15 ≈ 0.533');

    // 3. Progress kept: net_life = 6 - 3 = 3, movement_life = 8 + 13 = 21 => 3 / (21 + 2) = 3/23 ≈ 0.130
    assert.ok(Math.abs(windowScoring.progressKept - (3 / 23)) < 1e-4, 'Progress kept should be 3/23 ≈ 0.130');

    // 4. Window evidence: drift = -3 / (13 + 2) = -0.20, stall_evidence = (1 - 0) * 0.6 = 0.60
    const evidence = computeWindowEvidence(windowScoring.net, windowScoring.movement, 0.6);
    assert.ok(Math.abs(evidence.drift - (-0.20)) < 0.005, 'Drift should be -0.20');
    assert.ok(Math.abs(evidence.stallEvidence - 0.60) < 0.005, 'Stall evidence should be 0.60');

    // 5. Pressures: CONTINUE = 0, EVOLVE = max(0.533, 0.60 * 0.130) = 0.533, PRUNE = 0.60 * (1 - 0.130) * (1 - 0.533) = 0.243
    const pressures = computePressures(evidence.drift, windowScoring.lostGround, windowScoring.progressKept, evidence.stallEvidence);
    assert.equal(pressures.CONTINUE, 0.0, 'CONTINUE pressure must be 0');
    assert.ok(Math.abs(pressures.EVOLVE - 0.533) < 0.005, 'EVOLVE pressure should be ≈ 0.533');
    assert.ok(Math.abs(pressures.PRUNE - 0.243) < 0.005, 'PRUNE pressure should be ≈ 0.243');

    // 6. Decision: EVOLVE clears theta (0.3) and beats PRUNE. lost_ground > stall_evidence * progress_kept => rollback to 8
    const decisionResult = decideAction(pressures, windowScoring.lostGround, evidence.stallEvidence, windowScoring.progressKept, windowScoring.lastGoodIteration);
    assert.equal(decisionResult.decision, 'EVOLVE', 'Decision must be EVOLVE');
    assert.equal(decisionResult.form, 'rollback', 'Form must be rollback');
    assert.equal(decisionResult.rollbackTo, 8, 'Rollback target must be iteration 8');
  });

  it('Example 3: Stalled branches distinguish EVOLVE in place (saturated) vs PRUNE (failed)', () => {
    // Shared setup for main3 and main4:
    // Events: it6 progress small (1), it8 regression small (-1), it10 progress small (1)
    const progressEvents: BsrEvent[] = [
      { iteration: 6, size: 'small', reason: 'Tweak' },
      { iteration: 10, size: 'small', reason: 'Tweak 2' },
    ];
    const regressionEvents: BsrEvent[] = [
      { iteration: 8, size: 'small', reason: 'Minor slip' },
    ];

    // Shared window totals: changes +1, 0, -1, 0, +1 => totals: 1, 1, 0, 0, 1. net = 1 => STALL. movement = 3
    // drift = 1 / (3 + 2) = 0.20, stall_evidence = (1 - 0.20) * 0.9 = 0.72
    const evidence = computeWindowEvidence(1, 3, 0.9);
    assert.ok(Math.abs(evidence.drift - 0.20) < 0.005, 'Drift should be 0.20');
    assert.ok(Math.abs(evidence.stallEvidence - 0.72) < 0.005, 'Stall evidence should be 0.72');

    // Branch main3: High progress standing (net_life = 15, movement_life = 17 => progress_kept = 15/19 ≈ 0.789)
    const ledgerMain3: BsrLedgerEntry[] = [
      { iteration: 2, direction: 'progress', size: 'large', weight: 4, reason: 'P1' },
      { iteration: 3, direction: 'progress', size: 'large', weight: 4, reason: 'P2' },
      { iteration: 4, direction: 'progress', size: 'large', weight: 4, reason: 'P3' },
      { iteration: 5, direction: 'progress', size: 'medium', weight: 2, reason: 'P4' },
    ];
    const scoringMain3 = scoreWindow(6, 10, progressEvents, regressionEvents, ledgerMain3);
    assert.ok(Math.abs(scoringMain3.progressKept - (15 / 19)) < 1e-4);

    const pressuresMain3 = computePressures(evidence.drift, scoringMain3.lostGround, scoringMain3.progressKept, evidence.stallEvidence);
    // EVOLVE = max(0, 0.72 * 0.7895) = 0.568
    // PRUNE = 0.72 * (1 - 0.7895) * (1 - 0) = 0.152
    assert.ok(Math.abs(pressuresMain3.EVOLVE - 0.568) < 0.005);
    assert.ok(Math.abs(pressuresMain3.PRUNE - 0.152) < 0.005);
    const decisionMain3 = decideAction(pressuresMain3, scoringMain3.lostGround, evidence.stallEvidence, scoringMain3.progressKept, scoringMain3.lastGoodIteration);
    assert.equal(decisionMain3.decision, 'EVOLVE', 'main3 must be EVOLVE');
    assert.equal(decisionMain3.form, 'in_place', 'main3 form must be in_place (saturation re-aim)');

    // Branch main4: Failed branch with near-zero progress (net_life = 1, movement_life = 7 => progress_kept = 1/9 ≈ 0.111)
    const ledgerMain4: BsrLedgerEntry[] = [
      { iteration: 2, direction: 'progress', size: 'small', weight: 1, reason: 'P1' },
      { iteration: 3, direction: 'regression', size: 'small', weight: 1, reason: 'R1' },
      { iteration: 4, direction: 'progress', size: 'small', weight: 1, reason: 'P2' },
      { iteration: 5, direction: 'regression', size: 'small', weight: 1, reason: 'R2' },
    ];
    const scoringMain4 = scoreWindow(6, 10, progressEvents, regressionEvents, ledgerMain4);
    assert.ok(Math.abs(scoringMain4.progressKept - (1 / 9)) < 1e-4);

    const pressuresMain4 = computePressures(evidence.drift, scoringMain4.lostGround, scoringMain4.progressKept, evidence.stallEvidence);
    // EVOLVE = max(0, 0.72 * 0.111) = 0.080
    // PRUNE = 0.72 * (1 - 0.111) * 1 = 0.640
    assert.ok(Math.abs(pressuresMain4.EVOLVE - 0.080) < 0.005);
    assert.ok(Math.abs(pressuresMain4.PRUNE - 0.640) < 0.005);
    const decisionMain4 = decideAction(pressuresMain4, scoringMain4.lostGround, evidence.stallEvidence, scoringMain4.progressKept, scoringMain4.lastGoodIteration);
    assert.equal(decisionMain4.decision, 'PRUNE', 'main4 must be PRUNE (failure exhaustion)');
  });
});

// ============================================================================
// SUITE 2: Module Feedback (§5.2)
// ============================================================================

describe('Deepthink Consolidated Specification §5.2: Module Feedback Formulas', () => {

  it('computes utilization vector U(h) = [C/T, P/T, N/T, M/T] without collapsing', () => {
    const feedbackAssignments: DosBranchUtilization[] = [
      { branch_id: 'main1', utilization: { classification: 'USED_CORRECTLY', reason: 'Direct application' } },
      { branch_id: 'main2', utilization: { classification: 'USED_PARTIALLY', reason: 'Used auxiliary bound' } },
      { branch_id: 'main3', utilization: { classification: 'NOT_USED', reason: 'Ignored entirely' } },
      { branch_id: 'main4', utilization: { classification: 'USED_CORRECTLY', reason: 'Verified in solution' } },
    ];

    const u = calculateUtilizationVector(feedbackAssignments);
    assert.ok(u !== undefined, 'Utilization vector must be generated');
    assert.equal(u!.correct_use, 0.50, '2/4 = 0.50 correct_use');
    assert.equal(u!.partial_use, 0.25, '1/4 = 0.25 partial_use');
    assert.equal(u!.not_used, 0.25, '1/4 = 0.25 not_used');
    assert.equal(u!.misused, 0.00, '0/4 = 0.00 misused');
  });
});

// ============================================================================
// SUITE 3: Loop Schedules, Barriers, and Gap Calculations (§2, §3)
// ============================================================================

describe('Deepthink Consolidated Specification §2 & §3: Loop Schedules & Barriers', () => {

  it('enforces inclusive loop parameter bounds 5 <= i <= 20, 3 <= j <= 8, 2 <= k <= j (§2)', () => {
    assert.equal(validateLoopBounds(10, 5, 3).valid, true);
    assert.equal(validateLoopBounds(4, 5, 3).valid, false, 'i < 5 must fail');
    assert.equal(validateLoopBounds(21, 5, 3).valid, false, 'i > 20 must fail');
    assert.equal(validateLoopBounds(10, 2, 2).valid, false, 'j < 3 must fail');
    assert.equal(validateLoopBounds(10, 9, 3).valid, false, 'j > 8 must fail');
    assert.equal(validateLoopBounds(10, 5, 1).valid, false, 'k < 2 must fail');
    assert.equal(validateLoopBounds(10, 5, 6).valid, false, 'k > j must fail');
  });

  it('matches worked schedule example: i = 15, j = 5, k = 3 (§3 table)', () => {
    const config = { i: 15, j: 5, k: 3 };
    let sinceHeartbeat = 0;
    const scheduleTrace: Array<{ it: number; step: string; sinceAfter: number }> = [];

    for (let it = 1; it <= config.i; it++) {
      const step = determinePostIterationStep(it, sinceHeartbeat, config.i, config.j, config.k, true);
      if (step.action.type === 'FINAL_JUDGE') {
        scheduleTrace.push({ it, step: 'final_judge', sinceAfter: step.nextSinceHeartbeat });
      } else if (step.action.type === 'GLOBAL_UPDATE') {
        sinceHeartbeat = 0;
        scheduleTrace.push({ it, step: 'global_update', sinceAfter: step.nextSinceHeartbeat });
      } else if (step.action.type === 'HEARTBEAT') {
        sinceHeartbeat = 0;
        scheduleTrace.push({ it, step: 'heartbeat', sinceAfter: step.nextSinceHeartbeat });
      } else {
        sinceHeartbeat = step.nextSinceHeartbeat;
        scheduleTrace.push({ it, step: 'none', sinceAfter: step.nextSinceHeartbeat });
      }
    }

    assert.equal(scheduleTrace[2].step, 'heartbeat', 'Iteration 3 runs heartbeat');
    assert.equal(scheduleTrace[2].sinceAfter, 0);

    assert.equal(scheduleTrace[4].step, 'global_update', 'Iteration 5 runs global update');
    assert.equal(scheduleTrace[4].sinceAfter, 0);

    assert.equal(scheduleTrace[7].step, 'heartbeat', 'Iteration 8 runs heartbeat');
    assert.equal(scheduleTrace[7].sinceAfter, 0);

    assert.equal(scheduleTrace[9].step, 'global_update', 'Iteration 10 runs global update');
    assert.equal(scheduleTrace[9].sinceAfter, 0);

    assert.equal(scheduleTrace[12].step, 'heartbeat', 'Iteration 13 runs heartbeat');
    assert.equal(scheduleTrace[12].sinceAfter, 0);

    assert.equal(scheduleTrace[14].step, 'final_judge', 'Iteration 15 stops for final judge (no heartbeat)');
  });

  it('skips heartbeat when G - n < 2 (skip example: i = 14, j = 6, k = 5) (§3)', () => {
    // After iteration 5, since_heartbeat reaches 5 (k = 5). Next global update is iteration 6 (G = 6).
    // G - n = 6 - 5 = 1 < 2 => heartbeat_due(5) is false.
    const step = determinePostIterationStep(5, 4, 14, 6, 5, true);
    assert.equal(step.action.type, 'NONE', 'Heartbeat after iteration 5 must be skipped because G - n < 2');
  });
});

// ============================================================================
// SUITE 4: Shared Workspace Tool & Real-Time Isolation (§8.3, §8.4)
// ============================================================================

describe('Deepthink Consolidated Specification §8.3 & §8.4: Shared Workspace Concurrency', () => {

  it('supports real-time concurrent reads, appends, surgical edits, and enforces the 5000-token cap', async () => {
    const workspace = new SharedWorkspaceManager();
    await workspace.write('# Initial Workspace Setup\n');

    // Simulate concurrent agent contributions
    await Promise.all([
      workspace.handleToolCall({ action: 'append', content: 'Agent 1: Verified convex hull constraint.\n' }),
      workspace.handleToolCall({ action: 'append', content: 'Agent 2: Checked boundary condition.\n' }),
      workspace.handleToolCall({ action: 'append', content: 'Agent 3: Contact graph has 3 mutual tangencies.\n' }),
    ]);

    const readResult = await workspace.handleToolCall({ action: 'read' });
    assert.ok(readResult.includes('Agent 1'));
    assert.ok(readResult.includes('Agent 2'));
    assert.ok(readResult.includes('Agent 3'));

    // Surgical edit works cleanly without wiping peer agents' work
    await workspace.handleToolCall({
      action: 'edit',
      old_string: 'Agent 2: Checked boundary condition.',
      new_string: 'Agent 2: Confirmed strict boundary tangency.',
    });
    const editedResult = await workspace.read();
    assert.ok(editedResult.includes('Agent 2: Confirmed strict boundary tangency.'));
    assert.ok(editedResult.includes('Agent 1: Verified convex hull constraint.'));

    // Full-file write via tool call is rejected to prevent wiping peer findings
    await assert.rejects(
      () => workspace.handleToolCall({ action: 'write' as any, content: '# Wiped\n' }),
      /Full-file "write" is disabled/
    );

    // Token limit gate rejects appends/edits that would exceed 5000 tokens and preserves existing content
    const hugeContent = 'token '.repeat(5200);
    await assert.rejects(
      () => workspace.handleToolCall({ action: 'append', content: hugeContent }),
      /5000 tokens/
    );
    const preservedResult = await workspace.read();
    assert.equal(preservedResult, editedResult);
  });
});

// ============================================================================
// SUITE 5: Full DeepthinkPipelineOrchestrator End-to-End Execution (§1-§9)
// ============================================================================

describe('Deepthink Consolidated Specification: Complete End-to-End Pipeline Orchestration', () => {

  it('runs full 6-iteration pipeline with realistic fenced model outputs, barrier commits, and durable git artifacts', async () => {
    // Pipeline configuration:
    // i = 6 total iterations
    // j = 3 iterations per global update (update at iteration 3)
    // k = 2 iterations between curated context heartbeats
    // 3 strategies (main1, main2, main3)
    const testChallenge = 'Solve the extremal configuration for the 3-circle packing problem in an equilateral triangle.';

    const state: DeepthinkPipelineState = {
      id: 'spec-test-pipeline-e2e',
      challenge: testChallenge,
      status: 'idle',
      activeTabId: 'live',
      runConfig: {
        i: 6,
        j: 3,
        k: 2,
        strategiesCount: 3,
        strategyProximityLoops: 2,
        modulesCount: 2,
        modulesImpactReviewLoops: 1,
        isolateBranches: false,
        deepthinkCodeExecutionEnabled: false,
        thinkingLevel: 'high',
        model: 'gemini-2.5-pro',
      } as any,
      initialStrategies: [],
      strategyGenerationHistory: [],
      strategyProximityHistory: [],
      modulesGenerationHistory: [],
      modules: [],
      modulesHistory: [],
      moduleRounds: [],
      solutionCritiques: [],
      memoryBankAgents: [],
      heartbeats: [],
      modulesImpactReviewHistory: [],
      bsrRecords: [],
      branchLedgers: {},
      dosOutputs: [],
      liveEvents: [],
    } as any;

    let bsrCallCount = 0;
    let finalJudgeCalled = false;
    let finalCritiqueAttempted = false;

    // Realistic LLM response simulator: wraps structured payloads in conversational text and markdown code blocks!
    const simulatedCallAI = async (args: {
      prompt: string;
      model: string;
      systemInstruction?: string;
      responseSchema?: unknown;
      thinkingConfig?: { thinkingLevel?: string };
      agentKind?: DeepthinkAgentKind;
      stepDescription?: string;
    }): Promise<string> => {
      const p = args.prompt;
      const kind = args.agentKind;
      const desc = args.stepDescription || '';

      // High-fidelity validation: assert that orchestrator always delivers a non-empty system instruction (§7, §8.5)
      assert.ok(
        args.systemInstruction && args.systemInstruction.trim().length > 0,
        `System instruction must never be empty for agent ${kind} (${desc})`
      );

      // 1. Initial Strategy Seed Generation (Turn 1 & 2)
      if (kind === 'initialStrategy' && desc.includes('Seed Strategy Generator')) {
        assert.ok(
          args.systemInstruction.includes('strategies'),
          'Seed strategy generator must receive seed schema system prompt'
        );
        assert.ok(p.includes('# Core Challenge'), 'Seed SG must receive # Core Challenge');
        assert.ok(p.includes('Requested Number of Strategies: 3'), 'Seed SG must receive strategiesCount');
        if (!desc.includes('(Turn 1)')) {
          assert.ok(p.includes('<SeedStrategyProximityTurns>'), 'Seed SG revision turns must receive <SeedStrategyProximityTurns>');
        }
        return wrapInRealisticLLMFence({
          strategies: [
            'Strategy main1: Symmetry-based algebraic parameterization',
            'Strategy main2: Variational optimization via Lagrange multipliers',
            'Strategy main3: Geometric constraint propagation and contact graph analysis',
          ],
        }, 'Here are the seed strategies for the challenge:');
      }

      // 2. Surgical Strategy Generator for Global Update (§4.1, §4.6)
      if (kind === 'initialStrategy' && desc.includes('Strategy Generator Update')) {
        assert.ok(
          args.systemInstruction.includes('evolved_slots') && args.systemInstruction.includes('pruned_slots'),
          'Unified strategy generator must include surgical schema in system prompt'
        );
        assert.ok(p.includes('# Core Challenge'), 'GU SG must receive # Core Challenge');
        assert.ok(p.includes('# Strategy Generation Context for Global Update 1'), 'GU SG must receive # Strategy Generation Context for Global Update 1');
        assert.ok(p.includes('Requested Number of Strategies: 3'), 'GU SG must receive strategiesCount');
        assert.ok(p.includes('<StrategyProximityHistory>'), 'GU SG must receive <StrategyProximityHistory>');
        assert.ok(p.includes('<HarnessNote>'), 'GU SG must receive <HarnessNote>');
        assert.ok(p.includes('<CurrentActiveStrategies>'), 'GU SG must receive <CurrentActiveStrategies>');
        assert.ok(p.includes('<ConsolidatedBsrDecisions>'), 'GU SG must receive <ConsolidatedBsrDecisions>');
        assert.ok(p.includes('<DosSynthesisForStrategies>'), 'GU SG must receive <DosSynthesisForStrategies>');
        assert.ok(p.includes('<StrategiesFinalizedAndUsedSoFar>'), 'GU SG must receive <StrategiesFinalizedAndUsedSoFar>');
        return wrapInRealisticLLMFence({
          evolved_slots: [
            { slot_id: 'main2', updated_strategy_text: 'Evolved main2: Constrained gradient projection avoiding boundary singularities' },
          ],
          pruned_slots: [
            { slot_id: 'main3', new_strategy_text: 'New main3: Delaunay triangulation dual graph optimization' },
          ],
        }, 'Here are the changed slots for Global Update:');
      }

      // 3. Strategy Proximity Review
      if (kind === 'strategyProximity') {
        assert.ok(
          args.systemInstruction.includes('You are the Strategy Generation and Strategy Proximity Review engine of the Deepthink pipeline.'),
          'Strategy Proximity must share the unified strategy system prompt'
        );
        assert.ok(p.includes('# Core Challenge'), 'Strategy Proximity must receive full # Core Challenge');
        assert.ok(p.includes('Requested Number of Strategies: 3'), 'Strategy Proximity must receive strategiesCount');
        if (desc.includes('Global Update')) {
          assert.ok(
            args.systemInstruction.includes('evolved_slots') && args.systemInstruction.includes('pruned_slots'),
            'GU Strategy Proximity must share the Global Update Strategy Generator system prompt'
          );
          assert.ok(p.includes('<StrategyProximityHistory>'), 'GU Strategy Proximity must receive <StrategyProximityHistory>');
          assert.ok(p.includes('<HarnessNote>'), 'GU Strategy Proximity must receive <HarnessNote>');
          assert.ok(p.includes('<CurrentActiveStrategies>'), 'GU Strategy Proximity must receive <CurrentActiveStrategies>');
          assert.ok(p.includes('<ConsolidatedBsrDecisions>'), 'GU Strategy Proximity must receive <ConsolidatedBsrDecisions>');
          assert.ok(p.includes('<DosSynthesisForStrategies>'), 'GU Strategy Proximity must receive <DosSynthesisForStrategies>');
          assert.ok(p.includes('<CurrentGlobalUpdateProximityTurns>'), 'GU Strategy Proximity must receive <CurrentGlobalUpdateProximityTurns>');
          return 'Proximity: Evolved main2 and New main3 maintain complete orthogonality from main1.';
        }
        assert.ok(p.includes('<SeedStrategyProximityTurns>'), 'Seed Strategy Proximity must receive <SeedStrategyProximityTurns>');
        return 'Proximity: All 3 strategies explore diverse, non-overlapping solution domains.';
      }

      // 4. Solution Attempt (Iteration 1 or First execution of new branch)
      if (kind === 'solutionAttempt' || desc.includes('Solution Attempt') || desc.includes('First Execution')) {
        return '# Iteration 1 Solution Attempt\nRadius relation derived: r = s / (2 + 2*sqrt(3)). Contact graph validated.';
      }

      // 5. Solution Critique
      if (kind === 'solutionCritique') {
        assert.equal(p.includes('<CorrectionToCritique>'), false, 'Critique must NOT receive separate <CorrectionToCritique> block');
        assert.ok(p.includes('<WindowCorrectionCritiqueHistory>'), 'Critique must receive <WindowCorrectionCritiqueHistory> with current iteration solution');
        if (desc.includes('Iteration 6')) {
          finalCritiqueAttempted = true;
        }
        return '# Solution Critique\nVerified algebraic bound. Check corner tangencies for boundary slack.';
      }

      // 6. Solution Correction
      if (kind === 'solutionCorrection') {
        if (desc.includes('main1') && desc.includes('Iteration 4')) {
          const iter3Idx = p.indexOf('<Iteration n="3">');
          const memBankIdx = p.indexOf('<DistilledMemoryBank>');
          assert.ok(iter3Idx >= 0 && memBankIdx > iter3Idx, 'Iteration 4 (after GU 1) must have [Iter 3] before <DistilledMemoryBank>');
        }
        if (desc.includes('main1') && desc.includes('Iteration 5')) {
          const iter3Idx = p.indexOf('<Iteration n="3">');
          const memBankIdx = p.indexOf('<DistilledMemoryBank>');
          const winHistIdx = p.indexOf('<WindowCorrectionCritiqueHistory>');
          assert.ok(
            iter3Idx >= 0 && memBankIdx > iter3Idx && winHistIdx > memBankIdx,
            'Iteration 5 must have [Iter 3] + <DistilledMemoryBank> + <WindowCorrectionCritiqueHistory>'
          );
        }
        if (p.includes('<LatestCustomCuratedContext>')) {
          assert.ok(p.includes('Testing of that Module:'), 'Curated context must include Testing of that Module');
          assert.equal(p.includes('Verdict:'), false, 'Curated context must not include regex Verdict line');
        }
        if (desc.includes('Iteration 6')) {
          assert.ok(
            p.includes('<LatestCustomCuratedContext>'),
            'Final iteration i correction must naturally receive <LatestCustomCuratedContext> from the latest heartbeat'
          );
        }
        return '# Corrected Solution\nRefined corner tangency condition. Packing density strictly equals pi / (2 * sqrt(3)).';
      }

      // 7. Dissected Observations Synthesis (DOS) (§5.1)
      if (kind === 'dos') {
        if (desc.includes('Step-i DOS')) {
          return wrapInRealisticLLMFence({
            core_synthesis: { status: 'All branches show valid progress on radius computation.' },
          }, 'Step-i DOS synthesis:');
        }
        if (desc.includes('Step-ii DOS')) {
          return wrapInRealisticLLMFence({
            core_synthesis: { status: 'Post-update branches stabilized.' },
            module_feedback: [
              {
                module_id: 'm1',
                branch_utilization: [
                  { branch_id: 'main1', utilization: { classification: 'USED_CORRECTLY', reason: 'Applied tested bound' } },
                ],
                critique_counterevidence: [
                  { branch_id: 'main1', classification: 'STRONG', reason: 'Verified in sandbox derivation' },
                ],
              },
            ],
          }, 'Step-ii DOS post-update synthesis:');
        }
        // Heartbeat DOS
        return wrapInRealisticLLMFence({
          core_synthesis: { heartbeat: 'Synthesis of active branches.' },
          module_feedback: [],
        });
      }

      // 8. Branch State Representation (BSR) (§6.2)
      if (kind === 'bsr') {
        bsrCallCount++;
        const ledgerIdx = p.indexOf('<StandingEventLedger>');
        const memBeforeIdx = p.indexOf('<MemoryBankBeforeWindow>');
        const winHistIdx = p.indexOf('<WindowCorrectionCritiqueHistory>');
        assert.ok(
          ledgerIdx >= 0 && memBeforeIdx > ledgerIdx && winHistIdx > memBeforeIdx,
          'BSR context must order <StandingEventLedger> -> <MemoryBankBeforeWindow> -> <WindowCorrectionCritiqueHistory>'
        );
        assert.equal(p.includes('<EarlierGradedPredictionsHistory>'), false, 'BSR context must NOT include <EarlierGradedPredictionsHistory>');
        if (desc.includes('main1') || p.includes('Branch ID: main1')) {
          // main1: Healthy branch => CONTINUE
          return wrapInRealisticLLMFence({
            branch_id: 'main1',
            confirmed_progress: [
              { iteration: 2, size: 'large', reason: 'Proved boundary tangency' },
              { iteration: 3, size: 'medium', reason: 'Tightened density estimate' },
            ],
            confirmed_regression: [],
            critique_alignment: { value: 0.85, reason: 'Followed critique points closely' },
          }, 'BSR report for main1:');
        }
        if (desc.includes('main2') || p.includes('Branch ID: main2')) {
          // main2: Regressed branch => EVOLVE with rollback to iteration 2
          return wrapInRealisticLLMFence({
            branch_id: 'main2',
            confirmed_progress: [
              { iteration: 2, size: 'large', reason: 'Found initial constraint' },
            ],
            confirmed_regression: [
              { iteration: 3, size: 'large', reason: 'Lagrangian degenerated at boundaries' },
            ],
            critique_alignment: { value: 0.6, reason: 'Partial adherence' },
          }, 'BSR report for main2:');
        }
        // main3: Stall on failing branch with no progress => PRUNE (§6.5, §6.9 Example 3)
        return wrapInRealisticLLMFence({
          branch_id: 'main3',
          confirmed_progress: [
            { iteration: 3, size: 'small', reason: 'Minor format adjustment' },
          ],
          confirmed_regression: [
            { iteration: 3, size: 'small', reason: 'Offsetting geometric error' },
          ],
          critique_alignment: { value: 0.90, reason: 'Followed critique recommendations' },
        }, 'BSR report for main3:');
      }

      // 9. Modules Generator (§4.2)
      if (kind === 'modulesGeneration' || desc.includes('Modules Generator')) {
        assert.ok(p.includes('# Core Challenge'), 'MG must receive # Core Challenge');
        assert.ok(p.includes('Requested Number of Modules: 2'), 'MG must receive modulesCount');
        assert.ok(p.includes('<HarnessNote>'), 'MG must receive <HarnessNote>');
        assert.ok(p.includes('<DosCoreSynthesis>'), 'MG must receive <DosCoreSynthesis>');
        assert.equal(p.includes('Latest Critique:'), false, 'MG must NOT receive raw branch critiques');
        if (desc.includes('Heartbeat 1')) {
          assert.ok(p.includes('<ActiveRunningStrategies>'), 'HB1 MG must receive <ActiveRunningStrategies>');
          assert.ok(p.includes('Latest Correction:'), 'HB1 MG must receive Latest Correction from active branches');
        }
        if (desc.includes('Heartbeat 2')) {
          assert.ok(p.includes('<ModulesImpactReviewHistory>'), 'HB2 MG must receive <ModulesImpactReviewHistory>');
          assert.ok(
            p.includes('DOS_history/DOS_global_update_01_step_ii.md'),
            'HB2 must include reframed note for HB1 (which ran at end of GU 1) pointing to DOS_global_update_01_step_ii.md'
          );
          assert.ok(p.includes('<PreviousHeartbeatModulesAndTests>'), 'HB2 must include <PreviousHeartbeatModulesAndTests>');
          assert.ok(p.includes('<MappedBranchPackets>'), 'HB2 must include <MappedBranchPackets>');
          assert.ok(p.includes('"latest_correction"'), 'HB2 <MappedBranchPackets> must include latest_correction from all active branches');
          assert.ok(p.includes('<RealizedModuleFeedback>'), 'HB2 must include <RealizedModuleFeedback>');
          assert.equal(p.includes('"surprise_note"'), false, 'HB2 <RealizedModuleFeedback> must NOT include surprise_note');
          assert.ok(p.includes('<ModulesFinalizedAndUsedSoFar>'), 'HB2 must include <ModulesFinalizedAndUsedSoFar>');
        }
        return wrapInRealisticLLMFence({
          modules: [
            {
              module_id: 'm1',
              text: 'The optimal 3-circle center points form an equilateral triangle homothetic to the container.',
              target_branches: ['main1'],
            },
            {
              module_id: 'm2',
              text: 'Any arrangement with 2 non-touching circles has strictly lower packing density.',
              target_branches: [], // Global module (§4.2)
            },
          ],
        }, 'Generated modules:');
      }

      // 10. Modules Impact Reviewer
      if (kind === 'modulesImpactReview') {
        assert.ok(
          args.systemInstruction.includes('You are the Curated Context (Modules Generator and Modules Impact Reviewer) engine of the Deepthink pipeline.'),
          'Modules Impact Reviewer must share the unified modules generator system prompt'
        );
        assert.ok(p.includes('# Core Challenge'), 'MIR must receive # Core Challenge');
        assert.ok(p.includes('Requested Number of Modules: 2'), 'MIR must receive modulesCount');
        assert.ok(p.includes('<HarnessNote>'), 'MIR must receive <HarnessNote>');
        assert.ok(p.includes('<DosCoreSynthesis>'), 'MIR must receive <DosCoreSynthesis>');
        assert.ok(p.includes('<CurrentHeartbeatImpactReviewTurns>'), 'MIR must receive <CurrentHeartbeatImpactReviewTurns>');
        assert.ok(
          p.includes('Latest Correction:') || p.includes('"latest_correction"'),
          'MIR must receive the latest corrections from all active branches'
        );
        assert.equal(p.includes('Latest Critique:'), false, 'MIR must NOT receive raw branch critiques');
        return 'Impact Review: Modules m1 and m2 are crisp, falsifiable, and orthogonal.';
      }

      // 11. Modules Tester (§4.3)
      if (kind === 'modulesTester') {
        return 'Tested analytically. Result confirms centers form an equilateral triangle.\n\nCLASSIFICATION: VALIDATED';
      }

      // 12. Memory Bank Distillation (§4.6 v, §9)
      if (kind === 'memoryBank') {
        return '# Memory Bank Distillation\nDurable invariant: Center homothety holds. Inscribed radius r = s / (2 + 2*sqrt(3)). Avoid boundary singularities.';
      }

      // 13. Final Judge (§7, §9)
      if (kind === 'finalJudge') {
        finalJudgeCalled = true;
        // Verify final judge receives candidate final correction-critique pairs (<FinalSolution> and <FinalCritique>), no memory banks (§7, §8.3)
        assert.ok(p.includes('<FinalSolution>'), 'Final judge must receive <FinalSolution>');
        assert.ok(p.includes('<FinalCritique>'), 'Final judge must receive <FinalCritique>');
        assert.equal(p.includes('## Memory Bank'), false, 'Final judge must NOT receive memory banks');

        return wrapInRealisticLLMFence({
          best_solution_id: 'main1',
          final_reasoning: 'main1 provides the complete, mathematically rigorous proof with optimal packing ratio.',
        }, 'Final Judge selection:');
      }

      throw new Error(`Unexpected simulated AI call for agentKind=${args.agentKind}, step=${args.stepDescription}`);
    };

    const orchestrator = new DeepthinkPipelineOrchestrator(state, {
      callAI: simulatedCallAI,
      parseJsonStrict: <T>(raw: string): T => {
        const extracted = extractJsonString(raw);
        return JSON.parse(extracted) as T;
      },
      retryDelaysMs: [10, 10, 10],
      onLiveEvent: (event: DeepthinkLiveEvent) => {
        if (event.eventType === 'agent_error') {
          process.stderr.write(`[UNEXPECTED AGENT ERROR] ${event.stepDescription}: ${event.error ?? ''}\n`);
        }
      },
    });

    // Execute the complete pipeline run
    await orchestrator.run();

    // ========================================================================
    // Post-Execution Invariant Verification
    // ========================================================================

    // 1. Pipeline status completed
    assert.equal(state.status, 'completed', 'Pipeline must successfully complete');

    // 2. Exactly 3 initial strategies generated with slot IDs main1, main2, main3 (§1 Invariant 1)
    assert.equal(state.initialStrategies.length, 3);
    assert.equal(state.initialStrategies[0].id, 'main1');
    assert.equal(state.initialStrategies[1].id, 'main2');
    assert.equal(state.initialStrategies[2].id, 'main3');

    // 3. Seed proximity history recorded
    assert.ok(state.strategyProximityHistory && state.strategyProximityHistory.length >= 2);

    // 4. BSR ran at Global Update (iteration 3) across all 3 branches
    assert.equal(bsrCallCount, 3, 'BSR must execute once per branch at global update');
    assert.equal(state.bsrRecords.length, 3, 'Exactly 3 BSR records stored outside repository');

    // 5. Verify BSR decisions:
    // main1 => CONTINUE
    const bsrMain1 = state.bsrRecords.find(r => r.branch_id === 'main1');
    assert.equal(bsrMain1?.computed.decision, 'CONTINUE', 'main1 must be CONTINUE');

    // main2 => EVOLVE with rollback to iteration 2
    const bsrMain2 = state.bsrRecords.find(r => r.branch_id === 'main2');
    assert.equal(bsrMain2?.computed.decision, 'EVOLVE', 'main2 must be EVOLVE');
    assert.equal(bsrMain2?.computed.form, 'rollback', 'main2 form must be rollback');
    assert.equal(bsrMain2?.computed.rollback_to, 2, 'main2 rollback must target iteration 2');

    // main3 => PRUNE
    const bsrMain3 = state.bsrRecords.find(r => r.branch_id === 'main3');
    assert.equal(bsrMain3?.computed.decision, 'PRUNE', 'main3 must be PRUNE');

    // 6. Surgical strategy updates applied (§4.1):
    // main1 strategy text untouched
    assert.ok(state.initialStrategies[0].strategyText.includes('Symmetry-based algebraic parameterization'));
    // main2 strategy text updated
    assert.ok(state.initialStrategies[1].strategyText.includes('Constrained gradient projection'));
    // main3 new branch strategy text updated
    assert.ok(state.initialStrategies[2].strategyText.includes('Delaunay triangulation dual graph'));

    // 7. Check final iteration 6 behavior (§3):
    // Iteration 6 runs standard correction + critique like every other iteration!
    assert.equal(finalCritiqueAttempted, true, 'Final iteration i critique MUST run like any other iteration');
    const main1History = state.initialStrategies[0].iterationHistory?.iterations || [];
    const it6Record = main1History.find(it => it.iterationNumber === 6);
    assert.ok(it6Record, 'Iteration 6 correction record must exist');
    assert.ok(it6Record.critique.includes('# Solution Critique'), 'Iteration 6 critique must be recorded');

    // 8. Final Judge executed and selected winner (§7, §9)
    assert.equal(finalJudgeCalled, true, 'Final judge must be called at iteration i barrier');
    assert.equal(state.finalJudgingStatus, 'completed');
    assert.ok(state.finalJudgedBestSolution, 'Final judged solution must be set');
    assert.ok(state.finalJudgingResponseText?.includes('main1'), 'Final judge reason must reference winning branch');

    // 9. Curated Context Heartbeat artifacts exist (§4.5)
    assert.ok(state.heartbeats.length > 0, 'Heartbeats must be recorded');
    assert.ok(state.dosOutputs.length >= 2, 'Step-i and Step-ii DOS outputs must be recorded');

    // 10. Realized module feedback attached (§5.1, §5.4)
    const hb1 = state.heartbeats[0];
    assert.ok(hb1, 'Heartbeat 1 must exist');
    const realizedM1 = hb1.realized_feedback.find(rf => rf.module_id === 'm1');
    assert.ok(realizedM1, 'Realized feedback for m1 must be present');
    assert.equal(realizedM1.observed_test_outcome, 'VALIDATED');

    // 11. Durable Repository Files Verification (§8.1, §8.2)
    const git = orchestrator.getGitHarness();
    const files = git.getCommittedFiles();

    // Verify seed strategies generator & proximity reviewer files and their companion .jsonl trajectory files
    assert.ok(files.has('strategies_history/seed_strategies.md'), 'Seed strategies generator history must be committed');
    assert.ok(files.has('strategies_history/seed_strategies.jsonl'), 'Seed strategies generator trajectory .jsonl must be committed');
    assert.ok(files.has('strategies_history/seed_strategies_proximity_review.md'), 'Seed strategies proximity review history must be committed');
    assert.ok(files.has('strategies_history/seed_strategies_proximity_review.jsonl'), 'Seed strategies proximity review trajectory .jsonl must be committed');
    assert.ok(files.get('strategies_history/seed_strategies.md')!.includes('Strategy main1'));

    // Verify global update strategies generator & proximity reviewer files and their companion .jsonl trajectory files
    assert.ok(files.has('strategies_history/strategies_global_update01.md'), 'Global update 1 strategy generator history must be committed');
    assert.ok(files.has('strategies_history/strategies_global_update01.jsonl'), 'Global update 1 strategy generator trajectory .jsonl must be committed');
    assert.ok(files.has('strategies_history/strategies_global_update01_proximity_review.md'), 'Global update 1 strategy proximity review history must be committed');
    assert.ok(files.has('strategies_history/strategies_global_update01_proximity_review.jsonl'), 'Global update 1 strategy proximity review trajectory .jsonl must be committed');

    // Verify strategies finalized and used so far (.md only, no .jsonl)
    assert.ok(files.has('strategies_history/strategies_finalized_and_used_so_far.md'), 'strategies_finalized_and_used_so_far.md must be committed');
    assert.equal(files.has('strategies_history/strategies_finalized_and_used_so_far.jsonl'), false, 'strategies_finalized_and_used_so_far.jsonl must NOT exist');

    // Verify modules finalized and used so far (.md only, no .jsonl) and Heartbeat directory layout (2 .md and 2 .jsonl)
    assert.ok(files.has('Modules/modules_finalized_and_used_so_far.md'), 'modules_finalized_and_used_so_far.md must be committed');
    assert.equal(files.has('Modules/modules_finalized_and_used_so_far.jsonl'), false, 'modules_finalized_and_used_so_far.jsonl must NOT exist');
    assert.ok(files.has('Modules/Heartbeat-1/generation_history.md'), 'Modules/Heartbeat-1/generation_history.md must be committed');
    assert.ok(files.has('Modules/Heartbeat-1/generation_history.jsonl'), 'Modules/Heartbeat-1/generation_history.jsonl must be committed');
    assert.ok(files.has('Modules/Heartbeat-1/modules_impact_review_history_heartbeat_01.md'), 'Modules/Heartbeat-1/modules_impact_review_history_heartbeat_01.md must be committed');
    assert.ok(files.has('Modules/Heartbeat-1/modules_impact_review_history_heartbeat_01.jsonl'), 'Modules/Heartbeat-1/modules_impact_review_history_heartbeat_01.jsonl must be committed');
    assert.ok(files.has('Modules/Heartbeat-1/Module-1/module.md'), 'Modules/Heartbeat-1/Module-1/module.md must be committed');

    // Verify DOS history files (§8.1) (.md and .jsonl)
    assert.ok(files.has('DOS_history/DOS_global_update_01_step_i.md'), 'Step-i DOS must be recorded in repository');
    assert.ok(files.has('DOS_history/DOS_global_update_01_step_i.jsonl'), 'Step-i DOS trajectory .jsonl must be recorded in repository');
    assert.ok(files.has('DOS_history/DOS_global_update_01_step_ii.md'), 'Step-ii DOS must be recorded in repository');
    assert.ok(files.has('DOS_history/DOS_global_update_01_step_ii.jsonl'), 'Step-ii DOS trajectory .jsonl must be recorded in repository');

    // Verify per-iteration history files (§8.1, §12.13) (.md and .jsonl)
    assert.ok(files.has('Strategy-1/history/iteration_01.md'), 'Iteration 1 history must be recorded');
    assert.ok(files.has('Strategy-1/history/iteration_01.jsonl'), 'Iteration 1 trajectory .jsonl must be recorded');
    assert.ok(files.has('Strategy-1/history/iteration_02.md'), 'Iteration 2 history must be recorded');
    assert.ok(files.has('Strategy-1/history/iteration_02.jsonl'), 'Iteration 2 trajectory .jsonl must be recorded');

    // Verify memory bank distillation file for surviving branch (§8.1) (.md and .jsonl)
    assert.ok(files.has('Strategy-1/history/memory_bank_01.md'), 'Memory bank distillation must be committed');
    assert.ok(files.has('Strategy-1/history/memory_bank_01.jsonl'), 'Memory bank distillation trajectory .jsonl must be committed');

    // Verify PRUNE archived directory (§8.2)
    const archived = git.getArchivedDirectories();
    assert.ok(archived.some(dir => dir.includes('Strategy-3_pruned')), 'Strategy-3 must be archived to Pruned_Strategies');

    // Verify EVOLVE rollback was recorded (§8.2)
    const rollbacks = git.getRollbacks();
    assert.ok(rollbacks.some(rb => rb.slotIndex === 1), 'Rollback must be recorded for slot 1 (main2)');
  });
});

// ============================================================================
// SUITE 6: Configurable BSR Parameters & Preset Integration
// ============================================================================

describe('Deepthink BSR Configurable Parameters & Presets', () => {
  it('Noise level (tau) correctly distinguishes trends vs stalls based on threshold', () => {
    // 1 progress event of size medium = weight 2
    const progress: BsrEvent[] = [{ iteration: 1, size: 'medium', reason: 'partial breakthrough' }];
    const regression: BsrEvent[] = [];

    // Under tau = 2: net 2 >= 2 -> PROGRESS
    const resDefault = scoreWindow(1, 2, progress, regression, [], { tau: 2 });
    assert.strictEqual(resDefault.windowOutcome, 'PROGRESS');

    // Under strict tau = 4: net 2 < 4 -> STALL (system is skeptical)
    const resStrict = scoreWindow(1, 2, progress, regression, [], { tau: 4 });
    assert.strictEqual(resStrict.windowOutcome, 'STALL');

    // Under twitchy tau = 1 with only a small event (weight 1):
    const smallProg: BsrEvent[] = [{ iteration: 1, size: 'small', reason: 'minor tweak' }];
    const resTwitchy = scoreWindow(1, 2, smallProg, regression, [], { tau: 1 });
    assert.strictEqual(resTwitchy.windowOutcome, 'PROGRESS');
  });

  it('Pressure floor (theta) governs destructive action triggering', () => {
    const pressures = { CONTINUE: 0.1, EVOLVE: 0.35, PRUNE: 0.2 };

    // With default theta = 0.3: EVOLVE (0.35 >= 0.30) triggers
    const resDefault = decideAction(pressures, 0.4, 0.2, 0.5, 1, { theta: 0.3 });
    assert.strictEqual(resDefault.decision, 'EVOLVE');

    // With conservative theta = 0.5: pressures (0.35, 0.2) are below theta -> CONTINUE
    const resConservative = decideAction(pressures, 0.4, 0.2, 0.5, 1, { theta: 0.5 });
    assert.strictEqual(resConservative.decision, 'CONTINUE');

    // With ruthless theta = 0.1: EVOLVE triggers easily
    const lowPressures = { CONTINUE: 0.05, EVOLVE: 0.15, PRUNE: 0.08 };
    const resRuthless = decideAction(lowPressures, 0.2, 0.1, 0.5, 1, { theta: 0.1 });
    assert.strictEqual(resRuthless.decision, 'EVOLVE');
  });

  it('Verifies the 3 genuinely interesting BSR weight presets apply accurate mathematical scaling', () => {
    assert.strictEqual(BSR_WEIGHT_PRESETS.length, 3);

    const [std, flat, steep] = BSR_WEIGHT_PRESETS;
    assert.deepStrictEqual(std.weights, { small: 1, medium: 2, large: 4 });
    assert.deepStrictEqual(flat.weights, { small: 1, medium: 2, large: 3 });
    assert.deepStrictEqual(steep.weights, { small: 1, medium: 3, large: 10 });

    // Under steepened weights: 1 large breakthrough (10) outweighs 3 medium regressions (-9) -> Net +1
    const steepProg: BsrEvent[] = [{ iteration: 1, size: 'large', reason: 'major leap' }];
    const steepRegr: BsrEvent[] = [
      { iteration: 1, size: 'medium', reason: 'regr 1' },
      { iteration: 1, size: 'medium', reason: 'regr 2' },
      { iteration: 1, size: 'medium', reason: 'regr 3' },
    ];
    const scoreSteep = scoreWindow(1, 2, steepProg, steepRegr, [], { weights: steep.weights });
    assert.strictEqual(scoreSteep.net, 10 - 9); // +1 net

    // Under standard weights: 1 large breakthrough (4) is outweighed by 3 medium regressions (-6) -> Net -2
    const scoreStd = scoreWindow(1, 2, steepProg, steepRegr, [], { weights: std.weights });
    assert.strictEqual(scoreStd.net, 4 - 6); // -2 net
  });
});

describe('Deepthink Token Volume & API Call Estimations (Schedule 5..20 & Sandbox Delta)', () => {
  it('enforces depth scaling up to MAX_DEEPTHINK_DEPTH (20) without capping at 10', () => {
    assert.strictEqual(MAX_DEEPTHINK_DEPTH, 20);

    const est10 = calculateDeepthinkTokenEstimate({
      strategiesCount: 3,
      modulesCount: 2,
      deepthinkDepth: 10,
    });
    const est15 = calculateDeepthinkTokenEstimate({
      strategiesCount: 3,
      modulesCount: 2,
      deepthinkDepth: 15,
    });
    const est20 = calculateDeepthinkTokenEstimate({
      strategiesCount: 3,
      modulesCount: 2,
      deepthinkDepth: 20,
    });

    // Verify depths are accurately set without truncation
    assert.strictEqual(est10.depth, 10);
    assert.strictEqual(est15.depth, 15);
    assert.strictEqual(est20.depth, 20);

    // Verify token volumes strictly scale up as depth advances from 10 to 15 to 20
    assert.ok(est15.input.average > est10.input.average, 'depth 15 input avg > depth 10');
    assert.ok(est20.input.average > est15.input.average, 'depth 20 input avg > depth 15');
    assert.ok(est15.output.average > est10.output.average, 'depth 15 output avg > depth 10');
    assert.ok(est20.output.average > est15.output.average, 'depth 20 output avg > depth 15');
    assert.ok(est15.total.average > est10.total.average, 'depth 15 total avg > depth 10');
    assert.ok(est20.total.average > est15.total.average, 'depth 20 total avg > depth 15');

    // Verify API call predictions scale past 10
    assert.ok(est20.apiCalls.min > est10.apiCalls.min, 'depth 20 api calls min > depth 10');
    assert.ok(est20.apiCalls.max > est10.apiCalls.max, 'depth 20 api calls max > depth 10');

    // Verify buildDeepthinkTokenTrend produces full 20-point series
    const trend20 = buildDeepthinkTokenTrend({
      strategiesCount: 3,
      modulesCount: 2,
      maxDepth: 20,
    });
    assert.strictEqual(trend20.length, 20);
    assert.strictEqual(trend20[0].depth, 1);
    assert.strictEqual(trend20[19].depth, 20);

    // Verify ApiCallEstimator helper scales up to depth 20
    const apiCalls10 = calculateDeepthinkApiCallsFromParams({
      model: 'test',
      thinkingBudget: 0,
      thinkingLevel: 'medium',
      strategiesCount: 3,
      strategyProximityLoops: 1,
      modulesCount: 2,
      modulesImpactReviewLoops: 1,
      i: 10,
    });
    const apiCalls20 = calculateDeepthinkApiCallsFromParams({
      model: 'test',
      thinkingBudget: 0,
      thinkingLevel: 'medium',
      strategiesCount: 3,
      strategyProximityLoops: 1,
      modulesCount: 2,
      modulesImpactReviewLoops: 1,
      i: 20,
    });
    assert.ok(apiCalls20.min > apiCalls10.min, 'apiCalls20 min > apiCalls10 min');
    assert.ok(apiCalls20.max > apiCalls10.max, 'apiCalls20 max > apiCalls10 max');
  });

  it('correctly augments token counts with sandbox terminal environment per agent invoke (+50k/+350k in, +30k/+250k out) and random noise per iteration', () => {
    assert.strictEqual(SANDBOX_PER_CALL.input.average, 50_000);
    assert.strictEqual(SANDBOX_PER_CALL.input.worst, 350_000);
    assert.strictEqual(SANDBOX_PER_CALL.output.average, 30_000);
    assert.strictEqual(SANDBOX_PER_CALL.output.worst, 250_000);

    const testDepths = [1, 5, 10, 15, 20];
    for (const d of testDepths) {
      const base = calculateDeepthinkTokenEstimate({
        strategiesCount: 3,
        modulesCount: 2,
        deepthinkDepth: d,
        codeExecutionEnabled: false,
      });

      const withSandbox = calculateDeepthinkTokenEstimate({
        strategiesCount: 3,
        modulesCount: 2,
        deepthinkDepth: d,
        codeExecutionEnabled: true,
      });

      const expectedInputAvgDelta = base.apiCalls.min * SANDBOX_PER_CALL.input.average;
      const expectedInputWorstDelta = base.apiCalls.max * SANDBOX_PER_CALL.input.worst;
      const expectedOutputAvgDelta = base.apiCalls.min * SANDBOX_PER_CALL.output.average;
      const expectedOutputWorstDelta = base.apiCalls.max * SANDBOX_PER_CALL.output.worst;

      const actualInputAvgDelta = withSandbox.input.average - base.input.average;
      const actualInputWorstDelta = withSandbox.input.worst - base.input.worst;
      const noiseAvg = actualInputAvgDelta - expectedInputAvgDelta;
      const noiseWorst = actualInputWorstDelta - expectedInputWorstDelta;

      // Verify deliberate random noise per iteration between 256k and 512k
      assert.ok(
        noiseAvg >= d * SANDBOX_ITERATION_NOISE.min && noiseAvg <= d * SANDBOX_ITERATION_NOISE.max,
        `Depth ${d} input avg noise (${noiseAvg}) must be within [${d * SANDBOX_ITERATION_NOISE.min}, ${d * SANDBOX_ITERATION_NOISE.max}]`
      );
      assert.ok(
        noiseWorst >= d * SANDBOX_ITERATION_NOISE.min && noiseWorst <= d * SANDBOX_ITERATION_NOISE.max,
        `Depth ${d} input worst noise (${noiseWorst}) must be within [${d * SANDBOX_ITERATION_NOISE.min}, ${d * SANDBOX_ITERATION_NOISE.max}]`
      );
      assert.ok(
        noiseWorst >= noiseAvg,
        `Depth ${d} input worst noise (${noiseWorst}) must be >= avg noise (${noiseAvg})`
      );

      assert.strictEqual(
        withSandbox.output.average - base.output.average,
        expectedOutputAvgDelta,
        `Depth ${d} output average delta should be +${expectedOutputAvgDelta} (${base.apiCalls.min} base API calls * ${SANDBOX_PER_CALL.output.average})`
      );
      assert.strictEqual(
        withSandbox.output.worst - base.output.worst,
        expectedOutputWorstDelta,
        `Depth ${d} output worst delta should be +${expectedOutputWorstDelta} (${base.apiCalls.max} base API calls * ${SANDBOX_PER_CALL.output.worst})`
      );

      // Verify total api calls increase by factor of 12 (min) to 36 (max) when sandbox is enabled
      assert.strictEqual(
        withSandbox.apiCalls.min,
        base.apiCalls.min * SANDBOX_API_CALL_MULTIPLIER.min,
        `Depth ${d} min API calls must be multiplied by ${SANDBOX_API_CALL_MULTIPLIER.min}x when sandbox is enabled`
      );
      assert.strictEqual(
        withSandbox.apiCalls.max,
        base.apiCalls.max * SANDBOX_API_CALL_MULTIPLIER.max,
        `Depth ${d} max API calls must be multiplied by ${SANDBOX_API_CALL_MULTIPLIER.max}x when sandbox is enabled`
      );

      // Verify total is exactly input + output
      assert.strictEqual(
        withSandbox.total.average,
        withSandbox.input.average + withSandbox.output.average,
        `Depth ${d} total average must equal input + output`
      );
      assert.strictEqual(
        withSandbox.total.worst,
        withSandbox.input.worst + withSandbox.output.worst,
        `Depth ${d} total worst must equal input + output`
      );
    }

    // Verify formatApiCallCount formats thousands with k and millions with M
    assert.strictEqual(formatApiCallCount(30), '30');
    assert.strictEqual(formatApiCallCount(45), '45');
    assert.strictEqual(formatApiCallCount(600), '600');
    assert.strictEqual(formatApiCallCount(2200), '2.2k');
    assert.strictEqual(formatApiCallCount(2250), '2.3k');
    assert.strictEqual(formatApiCallCount(15000), '15k');
    assert.strictEqual(formatApiCallCount(1500000), '1.5M');
  });

  it('accurately accounts for every possible agent across heartbeats, global updates, and iterations', () => {
    // Test §3 worked example: i = 15, j = 5, k = 3
    // S = 3, strategyProx = 2, modCount = 4, modImpact = 1
    const res15 = calculateDeepthinkApiCallsFromParams({
      strategiesCount: 3,
      i: 15,
      j: 5,
      k: 3,
      strategyProximityLoops: 2,
      modulesCount: 4,
      modulesImpactReviewLoops: 1,
    });

    const b15 = res15.breakdown;
    assert.strictEqual(b15.standaloneHeartbeats, 3, 'Should have 3 standalone heartbeats (after 3, 8, 13)');
    assert.strictEqual(b15.globalUpdates, 2, 'Should have 2 global updates (after 5, 10)');
    assert.strictEqual(b15.totalHeartbeats, 5, 'Should have 5 total heartbeats (3 standalone + 2 GU ending)');

    // 1. Initial Strategy (Seed + Global Updates: min 1 + 2 = 3, max 3 + 2*(1 + 2) = 9)
    assert.strictEqual(b15.initialStrategy.min, 3);
    assert.strictEqual(b15.initialStrategy.max, 9);
    // 2. Strategy Proximity: min 2 (seed only), max 2 + 2*2 = 6
    assert.strictEqual(b15.strategyProximity.min, 2);
    assert.strictEqual(b15.strategyProximity.max, 6);
    // 3. Solution Attempt: min 3 (it1), max 3 + 2*3 = 9 (reseeded)
    assert.strictEqual(b15.solutionAttempt.min, 3);
    assert.strictEqual(b15.solutionAttempt.max, 9);
    // 4. Solution Critique: min 15 * 3 = 45 (runs on all 15 iterations), max 45 + 2*3 = 51
    assert.strictEqual(b15.solutionCritique.min, 45);
    assert.strictEqual(b15.solutionCritique.max, 51);
    // 5. Solution Correction: (15 - 1)*3 = 42
    assert.strictEqual(b15.solutionCorrection, 42);
    // 6. DOS: 3 standalone heartbeat DOS + 2 step-i DOS + 2 step-ii DOS = 7 calls
    assert.strictEqual(b15.dos, 7);
    // 7. Modules Generation: 5 heartbeats * (1 + 1 loops) = 10 calls
    assert.strictEqual(b15.modulesGeneration, 10);
    // 8. Modules Impact Review: 5 heartbeats * 1 loop = 5 calls
    assert.strictEqual(b15.modulesImpactReview, 5);
    // 9. Modules Tester: 5 heartbeats * 4 modules = 20 calls
    assert.strictEqual(b15.modulesTester, 20);
    // 10. BSR: 2 global updates * 3 branches = 6 calls
    assert.strictEqual(b15.bsr, 6);
    // 11. Memory Bank: min 2 GU * 3 branches = 6 calls, max 0
    assert.strictEqual(b15.memoryBank.min, 6);
    assert.strictEqual(b15.memoryBank.max, 0);
    // 12. Final Judge: exactly 1 call
    assert.strictEqual(b15.finalJudge, 1);

    // Verify mathematical identity: sum of breakdown equals min and max
    const minSum = b15.initialStrategy.min +
      b15.strategyProximity.min +
      b15.solutionAttempt.min +
      b15.solutionCritique.min +
      b15.solutionCorrection +
      b15.dos +
      b15.modulesGeneration +
      b15.modulesImpactReview +
      b15.modulesTester +
      b15.bsr +
      b15.memoryBank.min +
      b15.finalJudge;
    assert.strictEqual(minSum, res15.min, `Min sum (${minSum}) must match total min (${res15.min})`);

    const maxSum = b15.initialStrategy.max +
      b15.strategyProximity.max +
      b15.solutionAttempt.max +
      b15.solutionCritique.max +
      b15.solutionCorrection +
      b15.dos +
      b15.modulesGeneration +
      b15.modulesImpactReview +
      b15.modulesTester +
      b15.bsr +
      b15.memoryBank.max +
      b15.finalJudge;
    assert.strictEqual(maxSum, res15.max, `Max sum (${maxSum}) must match total max (${res15.max})`);

    // Verify when curated context is disabled: total heartbeats = 0, DOS = step-i only
    const resDisabled = calculateDeepthinkApiCallsFromParams({
      strategiesCount: 2,
      i: 10,
      j: 5,
      k: 3,
      modulesCount: 0,
    });
    assert.strictEqual(resDisabled.breakdown.standaloneHeartbeats, 0);
    assert.strictEqual(resDisabled.breakdown.totalHeartbeats, 0);
    assert.strictEqual(resDisabled.breakdown.modulesGeneration, 0);
    assert.strictEqual(resDisabled.breakdown.modulesTester, 0);
    assert.strictEqual(resDisabled.breakdown.dos, 1, 'Only Step-i DOS runs for 1 global update at iteration 5');
  });
});
