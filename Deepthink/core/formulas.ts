/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MANDATORY REFERENCE: Read Deepthink_Consolidated_Specification.md before modifying!
 * The specification document (Deepthink/docs/Deepthink_Consolidated_Specification.md)
 * is the absolute source of truth (§5.2, §6.2, §6.3, §6.4, §6.5, §6.9).
 */

import type {
  BsrAction,
  BsrComputedScores,
  BsrEvent,
  BsrEventSize,
  BsrEvolveForm,
  BsrLedgerEntry,
  BsrReport,
  BsrWindowOutcome,
  DosBranchUtilization,
} from './types.ts';

// ============================================================================
// Constants (§6.3)
// ============================================================================

export const SIZE_WEIGHTS: Record<BsrEventSize, number> = {
  small: 1,
  medium: 2,
  large: 4,
};

/** Noise level tau: smallest net change called a trend (§6.3) */
export const TAU = 2;

/** Pressure floor theta: least pressure that can trigger EVOLVE or PRUNE (§6.3, §6.5) */
export const THETA = 0.3;

export interface BsrConfigOptions {
  tau?: number;
  theta?: number;
  weights?: Record<BsrEventSize, number>;
}

// ============================================================================
// Pure BSR Calculations (§6.3, §6.4, §6.5)
// ============================================================================

export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface WindowScoringResult {
  net: number;
  movement: number;
  windowOutcome: BsrWindowOutcome;
  bestTotal: number;
  lastGoodIteration: number | 'window_start';
  lostGround: number;
  progressKept: number;
}

/**
 * Turns window events into running totals, net, movement, outcome, and ground metrics.
 * Follows §6.3 exactly.
 */
export function scoreWindow(
  windowStartIteration: number,
  windowEndIteration: number,
  progressEvents: BsrEvent[],
  regressionEvents: BsrEvent[],
  ledgerBeforeWindow: BsrLedgerEntry[],
  options?: { tau?: number; weights?: Record<BsrEventSize, number> }
): WindowScoringResult {
  const tau = options?.tau ?? TAU;
  const weights = options?.weights ?? SIZE_WEIGHTS;

  // Aggregate changes per iteration in the window
  const iterationChanges = new Map<number, number>();
  for (let it = windowStartIteration; it <= windowEndIteration; it++) {
    iterationChanges.set(it, 0);
  }

  let windowMovement = 0;

  for (const ev of progressEvents) {
    const w = weights[ev.size] ?? 1;
    const cur = iterationChanges.get(ev.iteration) ?? 0;
    iterationChanges.set(ev.iteration, cur + w);
    windowMovement += w;
  }

  for (const ev of regressionEvents) {
    const w = weights[ev.size] ?? 1;
    const cur = iterationChanges.get(ev.iteration) ?? 0;
    iterationChanges.set(ev.iteration, cur - w);
    windowMovement += w;
  }

  // Running total starts at 0 (representing window starting state)
  let currentTotal = 0;
  let bestTotal = 0;
  let lastGoodIteration: number | 'window_start' = 'window_start';

  for (let it = windowStartIteration; it <= windowEndIteration; it++) {
    const change = iterationChanges.get(it) ?? 0;
    currentTotal += change;
    if (currentTotal > 0 && currentTotal >= bestTotal) {
      bestTotal = currentTotal;
      lastGoodIteration = it;
    }
  }

  const net = currentTotal;

  // Window outcome
  let windowOutcome: BsrWindowOutcome = 'STALL';
  if (net >= tau) {
    windowOutcome = 'PROGRESS';
  } else if (net <= -tau) {
    windowOutcome = 'REGRESS';
  }

  // Lost ground: (best_total - net) / (movement + tau)
  const lostGround = windowMovement === 0 && bestTotal === 0
    ? 0
    : (bestTotal - net) / (windowMovement + tau);

  // Progress kept over the whole life of the branch ledger
  let netLife = 0;
  let movementLife = 0;
  for (const entry of ledgerBeforeWindow) {
    if (entry.direction === 'progress') {
      netLife += entry.weight;
    } else {
      netLife -= entry.weight;
    }
    movementLife += entry.weight;
  }
  netLife += net;
  movementLife += windowMovement;

  const progressKept = movementLife === 0
    ? 0
    : Math.max(0, netLife) / (movementLife + tau);

  return {
    net,
    movement: windowMovement,
    windowOutcome,
    bestTotal,
    lastGoodIteration,
    lostGround,
    progressKept,
  };
}

/**
 * Computes drift and stall evidence from the observed window (§6.5).
 */
export function computeWindowEvidence(
  net: number,
  movement: number,
  critiqueAlignmentValue: number,
  options?: { tau?: number }
): {
  drift: number;
  stallEvidence: number;
} {
  const tau = options?.tau ?? TAU;

  // drift = net / (movement + tau)
  const drift = net / (movement + tau);

  // stall_evidence = (1 - max(0, drift)) * max(0, critique_alignment)
  const stallEvidence = (1 - Math.max(0, drift)) * Math.max(0, critiqueAlignmentValue);

  return {
    drift,
    stallEvidence,
  };
}

/**
 * Computes action pressures for CONTINUE, EVOLVE, PRUNE (§6.5).
 */
export function computePressures(
  drift: number,
  lostGround: number,
  progressKept: number,
  stallEvidence: number
): {
  CONTINUE: number;
  EVOLVE: number;
  PRUNE: number;
} {
  const pContinue = Math.max(0, drift);
  const pEvolve = Math.max(lostGround, stallEvidence * progressKept);
  const pPrune = stallEvidence * (1 - progressKept) * (1 - lostGround);

  return {
    CONTINUE: pContinue,
    EVOLVE: pEvolve,
    PRUNE: pPrune,
  };
}

/**
 * Selects deterministic action and EVOLVE form (§6.5).
 */
export function decideAction(
  pressures: { CONTINUE: number; EVOLVE: number; PRUNE: number },
  lostGround: number,
  stallEvidence: number,
  progressKept: number,
  lastGoodIteration: number | 'window_start',
  options?: { theta?: number }
): {
  decision: BsrAction;
  form?: BsrEvolveForm;
  rollbackTo?: number | 'window_start';
} {
  const theta = options?.theta ?? THETA;
  let decision: BsrAction = 'CONTINUE';

  if (pressures.EVOLVE < theta && pressures.PRUNE < theta) {
    decision = 'CONTINUE';
  } else if (pressures.CONTINUE >= Math.max(pressures.EVOLVE, pressures.PRUNE)) {
    decision = 'CONTINUE';
  } else if (pressures.EVOLVE >= pressures.PRUNE) {
    decision = 'EVOLVE';
  } else {
    decision = 'PRUNE';
  }

  if (decision === 'EVOLVE') {
    // Rollback to last_good_iteration when lost_ground > stall_evidence * progress_kept (§6.5)
    const isRollback = lostGround > stallEvidence * progressKept;
    if (isRollback) {
      return {
        decision: 'EVOLVE',
        form: 'rollback',
        rollbackTo: lastGoodIteration,
      };
    }
    return {
      decision: 'EVOLVE',
      form: 'in_place',
    };
  }

  return { decision };
}

/**
 * Master function computing full BSR analysis for one branch at a global update.
 */
export function evaluateBranchState(
  report: BsrReport,
  windowStartIteration: number,
  windowEndIteration: number,
  ledgerBeforeWindow: BsrLedgerEntry[],
  options?: BsrConfigOptions
): BsrComputedScores {
  const scoring = scoreWindow(
    windowStartIteration,
    windowEndIteration,
    report.confirmed_progress,
    report.confirmed_regression,
    ledgerBeforeWindow,
    { tau: options?.tau, weights: options?.weights }
  );

  const evidence = computeWindowEvidence(
    scoring.net,
    scoring.movement,
    report.critique_alignment.value,
    { tau: options?.tau }
  );

  const pressures = computePressures(
    evidence.drift,
    scoring.lostGround,
    scoring.progressKept,
    evidence.stallEvidence
  );

  const actionDecision = decideAction(
    pressures,
    scoring.lostGround,
    evidence.stallEvidence,
    scoring.progressKept,
    scoring.lastGoodIteration,
    { theta: options?.theta }
  );

  return {
    net: scoring.net,
    movement: scoring.movement,
    window_outcome: scoring.windowOutcome,
    last_good_iteration: scoring.lastGoodIteration,
    lost_ground: scoring.lostGround,
    progress_kept: scoring.progressKept,
    drift: evidence.drift,
    stall_evidence: evidence.stallEvidence,
    pressure: pressures,
    decision: actionDecision.decision,
    form: actionDecision.form,
    rollback_to: actionDecision.rollbackTo,
  };
}

// ============================================================================
// DOS Module Feedback Calculations (§5.2)
// ============================================================================

export function calculateUtilizationVector(
  branchUtilizations: DosBranchUtilization[]
): {
  correct_use: number;
  partial_use: number;
  not_used: number;
  misused: number;
} | undefined {
  let c = 0;
  let p = 0;
  let n = 0;
  let m = 0;

  for (const bu of branchUtilizations) {
    switch (bu.utilization.classification) {
      case 'USED_CORRECTLY':
        c++;
        break;
      case 'USED_PARTIALLY':
        p++;
        break;
      case 'NOT_USED':
        n++;
        break;
      case 'MISUSED':
        m++;
        break;
    }
  }

  const total = c + p + n + m;
  if (total === 0) return undefined;

  return {
    correct_use: c / total,
    partial_use: p / total,
    not_used: n / total,
    misused: m / total,
  };
}
