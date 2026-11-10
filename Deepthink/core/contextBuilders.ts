import type { Part } from "../../Routing/AIProvider";
import type {
  BsrAction,
  BsrEvolveForm,
  BsrLedgerEntry,
  DeepthinkBranchIteration,
  DeepthinkMainStrategyData,
  DosOutput,
  HeartbeatBlock,
} from './types.ts';
import {
  buildDosStepIiNote,
  buildModuleHeartbeatNote,
  buildStrategyGlobalUpdateNote,
  DOS_HEARTBEAT_NOTE,
  DOS_STEP_I_NOTE,
} from './harnessNotes.ts';

function fence(label: string, content: string | undefined): string {
  return `<${label}>\n${content?.trim() || 'Not available.'}\n</${label}>`;
}

export function buildContextForStrategySeed(
  challenge: string,
  strategiesCount: number,
  currentLoopTurns?: Array<{ role: 'generator' | 'proximity'; content: string; turnNumber?: number }>
): string {
  const parts: string[] = [
    `# Core Challenge`,
    challenge,
    '',
    `Requested Number of Strategies: ${strategiesCount}`,
  ];

  if (currentLoopTurns && currentLoopTurns.length > 0) {
    const formattedTurns = currentLoopTurns.map(
      t => `### Strategy ${t.role === 'generator' ? 'Generator' : 'Proximity Reviewer'} (Turn ${t.turnNumber ?? 1})\n${t.content}`
    ).join('\n\n');
    parts.push('', fence('SeedStrategyProximityTurns', formattedTurns));
  }

  const isProximityTurn = Boolean(
    currentLoopTurns &&
    currentLoopTurns.length > 0 &&
    currentLoopTurns[currentLoopTurns.length - 1].role === 'generator'
  );
  parts.push('', isProximityTurn ? 'Immediate Role: Strategy Proximity Reviewer' : 'Immediate Role: Strategy Generator');

  return parts.join('\n');
}

export function buildContextForStrategyGlobalUpdate(
  challenge: string,
  updateNumber: number,
  j: number,
  activeStrategies: DeepthinkMainStrategyData[],
  bsrDecisions: Array<{
    slotId: string;
    decision: BsrAction;
    form?: BsrEvolveForm;
    rollbackTo?: number | 'window_start';
    eventReasons: string[];
  }>,
  stepIDosOutput: DosOutput,
  strategiesUsedSoFar: Array<{ slotId: string; iterationFinalized: number; text: string }>,
  currentGuTurns?: Array<{ role: 'generator' | 'proximity'; content: string; turnNumber?: number }>,
  strategiesCount?: number
): string {
  const count = strategiesCount ?? activeStrategies.length;
  const note = buildStrategyGlobalUpdateNote(j);

  const formattedActiveStrategies = activeStrategies.map(s => (
    `### ${s.id}\n${s.strategyText}\n\nLatest Correction:\n${s.refinedSolution || s.solutionAttempt || 'None'}`
  )).join('\n\n');

  const formattedDecisions = bsrDecisions.map(d => {
    let detail = `Decision: ${d.decision}`;
    if (d.form) {
      const rollbackTarget = d.rollbackTo !== undefined
        ? (d.rollbackTo === 'window_start' ? ' to window start' : ` to iteration ${d.rollbackTo}`)
        : '';
      detail += ` (${d.form}${rollbackTarget})`;
    }
    const reasons = d.eventReasons.length > 0
      ? `\nEvent reasons from window:\n${d.eventReasons.map(r => `  - ${r}`).join('\n')}`
      : '';
    return `### ${d.slotId}\n${detail}${reasons}`;
  }).join('\n\n');

  const formattedUsedSoFar = strategiesUsedSoFar.map(u => (
    `- [Iteration ${u.iterationFinalized}] ${u.slotId}: ${u.text}`
  )).join('\n');

  const parts: string[] = [
    `# Core Challenge`,
    challenge,
    '',
    `Requested Number of Strategies: ${count}`,
  ];

  parts.push(
    '',
    `# Strategy Generation Context for Global Update ${updateNumber}`,
    fence('HarnessNote', note),
    '',
    fence('CurrentActiveStrategies', formattedActiveStrategies),
    '',
    fence('ConsolidatedBsrDecisions', formattedDecisions),
    '',
    fence('DosSynthesisForStrategies', JSON.stringify(stepIDosOutput.core_synthesis || stepIDosOutput, null, 2)),
    '',
    fence('StrategiesFinalizedAndUsedSoFar', formattedUsedSoFar),
  );

  if (currentGuTurns && currentGuTurns.length > 0) {
    const formattedCurrentTurns = currentGuTurns.map(
      t => `### Strategy ${t.role === 'generator' ? 'Generator' : 'Proximity Reviewer'} (Turn ${t.turnNumber ?? 1})\n${t.content}`
    ).join('\n\n');
    parts.push('', fence('CurrentGlobalUpdateProximityTurns', formattedCurrentTurns));
  }

  const isProximityTurn = Boolean(
    currentGuTurns &&
    currentGuTurns.length > 0 &&
    currentGuTurns[currentGuTurns.length - 1].role === 'generator'
  );
  parts.push('', isProximityTurn ? 'Immediate Role: Strategy Proximity Reviewer' : 'Immediate Role: Strategy Generator');

  return parts.join('\n\n');
}

export function buildContextForModulesGenerate(
  challenge: string,
  heartbeatNo: number,
  activeStrategies: DeepthinkMainStrategyData[],
  dosOutput?: DosOutput,
  previousHeartbeat?: HeartbeatBlock,
  currentHbTurns?: Array<{ role: 'generator' | 'proximity'; content: string; turnNumber?: number }>,
  modulesCount?: number,
  modulesUsedSoFar?: Array<{ heartbeatNo: number; iterationFinalized: number; moduleId: string; text: string }>
): string {
  const count = modulesCount ?? 1;
  const note = buildModuleHeartbeatNote(heartbeatNo);

  const parts: string[] = [
    `# Core Challenge`,
    challenge,
    '',
    `Requested Number of Modules: ${count}`,
  ];

  parts.push(
    '',
    `# Modules Generator Context for Heartbeat ${heartbeatNo}`,
    fence('HarnessNote', note),
  );

  if (!previousHeartbeat) {
    const formattedActiveStrategies = activeStrategies.map(s => (
      `### ${s.id}\nStrategy: ${s.strategyText}\n\nLatest Correction:\n${s.refinedSolution || s.solutionAttempt || 'None'}`
    )).join('\n\n');
    parts.push(
      '',
      fence('ActiveRunningStrategies', formattedActiveStrategies),
    );
    if (dosOutput?.core_synthesis && Object.keys(dosOutput.core_synthesis).length > 0) {
      parts.push('', fence('DosCoreSynthesis', JSON.stringify(dosOutput.core_synthesis, null, 2)));
    }
  } else {
    const prevModulesAndTests = previousHeartbeat.modules.map(m => ({
      module_id: m.id,
      text: m.moduleText,
      target_branches: m.targetBranchIds || [],
      testing_output: m.testerAttempt || 'None',
    }));

    const mappedBranchPackets = activeStrategies.map(s => {
      const mappedModuleIds = previousHeartbeat.modules
        .filter(m => !m.targetBranchIds || m.targetBranchIds.length === 0 || m.targetBranchIds.includes(s.id))
        .map(m => m.id);
      return {
        branch_id: s.id,
        strategy_text: s.strategyText,
        latest_correction: s.refinedSolution || s.solutionAttempt || 'None',
        mapped_modules_from_previous_heartbeat: mappedModuleIds,
      };
    });

    const feedbackText = previousHeartbeat.realized_feedback.length > 0
      ? JSON.stringify(previousHeartbeat.realized_feedback, null, 2)
      : 'No prior feedback recorded.';

    const formattedUsedSoFar = (modulesUsedSoFar || []).map(u => (
      `- [Heartbeat ${u.heartbeatNo}, Iteration ${u.iterationFinalized}] ${u.moduleId}: ${u.text}`
    )).join('\n');

    parts.push(
      '',
      fence('PreviousHeartbeatModulesAndTests', JSON.stringify({
        heartbeat_no: previousHeartbeat.heartbeat_no,
        modules: prevModulesAndTests,
      }, null, 2)),
      '',
      fence('MappedBranchPackets', JSON.stringify(mappedBranchPackets, null, 2)),
      '',
      fence('RealizedModuleFeedback', feedbackText),
      '',
      fence('ModulesFinalizedAndUsedSoFar', formattedUsedSoFar),
    );

    if (dosOutput?.core_synthesis && Object.keys(dosOutput.core_synthesis).length > 0) {
      parts.push('', fence('DosCoreSynthesis', JSON.stringify(dosOutput.core_synthesis, null, 2)));
    }
  }

  if (currentHbTurns && currentHbTurns.length > 0) {
    const formattedCurrentTurns = currentHbTurns.map(
      t => `### Modules ${t.role === 'generator' ? 'Generator' : 'Impact Reviewer'} (Turn ${t.turnNumber ?? 1})\n${t.content}`
    ).join('\n\n');
    parts.push('', fence('CurrentHeartbeatImpactReviewTurns', formattedCurrentTurns));
  }

  const isImpactReviewTurn = Boolean(
    currentHbTurns &&
    currentHbTurns.length > 0 &&
    currentHbTurns[currentHbTurns.length - 1].role === 'generator'
  );
  parts.push('', isImpactReviewTurn ? 'Immediate Role: Modules Impact Reviewer' : 'Immediate Role: Modules Generator');

  return parts.join('\n\n');
}

export function buildContextForDos(
  challenge: string,
  kind: 'heartbeat' | 'step_i' | 'step_ii',
  activeBranches: Array<{
    branchId: string;
    strategyText: string;
    latestCorrection: string;
    latestCritique: string;
  }>,
  options?: {
    previousHeartbeat?: HeartbeatBlock;
    slotStatuses?: Array<{
      slotId: string;
      action: BsrAction;
      form?: BsrEvolveForm;
      rollbackTo?: number | 'window_start';
    }>;
    stepIOutput?: DosOutput;
  }
): string {
  const formattedBranches = activeBranches.map(b => (
    `### Branch ${b.branchId}\nStrategy: ${b.strategyText}\n\nLatest Correction:\n${b.latestCorrection}\n\nLatest Critique:\n${b.latestCritique}`
  )).join('\n\n');

  if (kind === 'step_i') {
    return [
      `# Core Challenge`,
      challenge,
      '',
      `# Dissected Observations Synthesis - Global Update (Step-i)`,
      fence('HarnessNote', DOS_STEP_I_NOTE),
      '',
      fence('ActiveBranchesState', formattedBranches),
    ].join('\n\n');
  }

  const formatPrevModulesForDos = (hb?: HeartbeatBlock): string => {
    if (!hb || !hb.modules || hb.modules.length === 0) return 'None.';
    return JSON.stringify(
      hb.modules.map(m => ({
        module_id: m.id,
        text: m.moduleText,
        target_branches: m.targetBranchIds || [],
        testing_output: m.testerAttempt || 'None',
      })),
      null,
      2
    );
  };

  if (kind === 'heartbeat') {
    const prevModules = formatPrevModulesForDos(options?.previousHeartbeat);

    return [
      `# Core Challenge`,
      challenge,
      '',
      `# Dissected Observations Synthesis - Heartbeat DOS`,
      fence('HarnessNote', DOS_HEARTBEAT_NOTE),
      '',
      fence('PreviousHeartbeatModulesAndTests', prevModules),
      '',
      fence('ActiveBranchesState', formattedBranches),
    ].join('\n\n');
  }

  const note = buildDosStepIiNote(options?.slotStatuses || []);
  const prevModules = formatPrevModulesForDos(options?.previousHeartbeat);

  return [
    `# Core Challenge`,
    challenge,
    '',
    `# Dissected Observations Synthesis - Global Update (Step-ii)`,
    fence('HarnessNote', note),
    '',
    fence('StepIOutputBaseline', JSON.stringify(options?.stepIOutput, null, 2)),
    '',
    fence('PreviousHeartbeatModulesAndTests', prevModules),
    '',
    fence('SurvivingAndNewBranchesState', formattedBranches),
  ].join('\n\n');
}

function formatIterationEntry(it: DeepthinkBranchIteration): string {
  const hasCritique = Boolean(it.critique && it.critique.trim().length > 0);
  return (
    `<Iteration n="${it.iterationNumber}">\n` +
    fence('Correction', it.correctedSolution) +
    (hasCritique ? '\n' + fence('Critique', it.critique) : '') + '\n' +
    `</Iteration>`
  );
}

export function buildCritiqueCorrectionMemoryBankHistory(
  memoryBank: string | undefined,
  iterationsInWindow: DeepthinkBranchIteration[],
  preUpdateIteration?: DeepthinkBranchIteration,
  curatedContextPacket?: string | null
): string {
  const parts: string[] = [];

  if (preUpdateIteration) {
    parts.push(formatIterationEntry(preUpdateIteration));
  }

  if (memoryBank && memoryBank.trim().length > 0) {
    parts.push(fence('DistilledMemoryBank', memoryBank));
  }

  if (curatedContextPacket) {
    parts.push(fence('LatestCustomCuratedContext', curatedContextPacket));
  }

  if (iterationsInWindow.length > 0) {
    const formatted = iterationsInWindow.map(formatIterationEntry).join('\n\n');
    parts.push(fence('WindowCorrectionCritiqueHistory', formatted));
  }

  return parts.join('\n\n');
}

export function buildCrossStrategyLatestCorrectionCritique(
  currentBranchId: string,
  allBranches: DeepthinkMainStrategyData[],
  isolateBranches: boolean
): string | null {
  if (isolateBranches) return null;

  const peers = allBranches.filter(
    b => b.id !== currentBranchId && Boolean((b.refinedSolution && b.refinedSolution.trim()) || (b.solutionAttempt && b.solutionAttempt.trim()))
  );
  if (peers.length === 0) return null;

  return peers.map(p => {
    const latestCorrection = p.refinedSolution || p.solutionAttempt || 'None';
    const latestCritique = p.solutionCritique || 'None';
    return (
      `Strategy ${p.id}: ${p.strategyText}\n` +
      fence('LatestCorrection', latestCorrection) + '\n' +
      fence('LatestCritique', latestCritique)
    );
  }).join('\n\n');
}

export function buildContextForCorrectionAgent(
  challenge: string,
  branchId: string,
  strategyText: string,
  historyObject: string,
  curatedContextPacket: string | null,
  crossStrategyContext: string | null
): string {
  let effectiveHistory = historyObject;
  if (curatedContextPacket && !effectiveHistory.includes('<LatestCustomCuratedContext>')) {
    const winIdx = effectiveHistory.indexOf('<WindowCorrectionCritiqueHistory>');
    const curatedFence = fence('LatestCustomCuratedContext', curatedContextPacket);
    if (winIdx >= 0) {
      effectiveHistory =
        effectiveHistory.slice(0, winIdx) +
        curatedFence + '\n\n' +
        effectiveHistory.slice(winIdx);
    } else {
      effectiveHistory = effectiveHistory
        ? `${effectiveHistory}\n\n${curatedFence}`
        : curatedFence;
    }
  }

  const parts: string[] = [
    `# Core Challenge`,
    challenge,
    '',
    `Assigned Strategy ID: ${branchId}`,
    `Assigned Strategy Text: ${strategyText}`,
    '',
    fence('BranchHistoryAndMemory', effectiveHistory),
  ];

  if (crossStrategyContext) {
    parts.push('', fence('CrossStrategyPeerIntelligence', crossStrategyContext));
  }

  return parts.join('\n');
}

export function buildContextForCritiqueAgent(
  challenge: string,
  branchId: string,
  strategyText: string,
  historyObject: string
): string {
  return [
    `# Core Challenge`,
    challenge,
    '',
    `Assigned Strategy ID: ${branchId}`,
    `Assigned Strategy Text: ${strategyText}`,
    '',
    fence('BranchHistoryAndMemory', historyObject),
  ].join('\n');
}

export function buildContextForBsr(
  challenge: string,
  branchId: string,
  strategyText: string,
  windowHistoryText: string,
  distilledMemoryBeforeWindow: string | undefined,
  ledgerEntries: BsrLedgerEntry[]
): string {
  const formattedLedger = ledgerEntries.length > 0
    ? ledgerEntries.map(e => `[Iter ${e.iteration}] ${e.direction.toUpperCase()} (${e.size}): ${e.reason}`).join('\n')
    : 'Empty ledger.';

  return [
    `# Core Challenge`,
    challenge,
    '',
    `Branch ID: ${branchId}`,
    `Current Strategy: ${strategyText}`,
    '',
    fence('StandingEventLedger', formattedLedger),
    '',
    fence('MemoryBankBeforeWindow', distilledMemoryBeforeWindow || 'None available.'),
    '',
    fence('WindowCorrectionCritiqueHistory', windowHistoryText),
  ].join('\n\n');
}

export function parsePromptToGeminiParts(promptText: string): Part[] {
    const parts: Part[] = [];
    const regex = /<!-- EXECUTION_IMAGE_START -->\s*<!-- MIME_TYPE:\s*([^\s]+)\s*-->\s*([\s\S]*?)<!-- EXECUTION_IMAGE_END -->/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(promptText)) !== null) {
        if (match.index > lastIndex) {
            parts.push({ text: promptText.substring(lastIndex, match.index) });
        }
        parts.push({ inlineData: { mimeType: match[1], data: match[2].trim() } });
        lastIndex = regex.lastIndex;
    }
    if (lastIndex < promptText.length) {
        parts.push({ text: promptText.substring(lastIndex) });
    }
    return parts;
}
