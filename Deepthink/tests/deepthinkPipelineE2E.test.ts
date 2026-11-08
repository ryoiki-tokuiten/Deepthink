import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

import {
    installNodeExtensionlessImportHook,
    withInProcessSandboxBackend,
    withSyntheticToolCallingProvider,
} from './sandboxAndGitHarnessBridge.ts';

installNodeExtensionlessImportHook();

import type {
    BsrLedgerEntry,
    BsrReport,
    DeepthinkPipelineState,
    DeepthinkRunConfig,
} from '../core/types.ts';
import type { SeededRunSpec } from './prngAndTokenCalibrator.ts';

const {
    validateLoopBounds,
    determinePostIterationStep,
    calculateLoopSchedule,
    evaluateBranchState,
    calculateUtilizationVector,
} = await import('../core/types.ts');

const {
    prunePipelineForExport,
    resetInFlightPipelineExecution,
} = await import('../core/deepthinkCore.ts');

const {
    DeepthinkPipelineOrchestrator,
} = await import('../core/pipelineOrchestrator.ts');

const {
    parsePromptToGeminiParts,
} = await import('../core/contextBuilders.ts');

const {
    SharedWorkspaceManager,
    SharedWorkspaceTokenLimitError,
    countTextTokens,
} = await import('../core/sharedWorkspace.ts');

const {
    DEEPTHINK_AGENT_REGISTRY,
    deepthinkAgentMaxOutputTokens,
} = await import('../core/agentRegistry.ts');

const {
    buildStrategyProximityHistoryWithNotes,
    buildModulesImpactReviewHistoryWithNotes,
    buildSharedWorkspaceTokenGateHarnessNote,
} = await import('../core/harnessNotes.ts');

const {
    calculateDeepthinkApiCallsFromParams,
    calculateDeepthinkTokenEstimate,
} = await import('../../Routing/DeepthinkTokenEstimator.ts');

const { BSR_WEIGHT_PRESETS } = await import('../../Routing/ModelConfig.ts');

const {
    SeededPRNG,
    buildOrchestratorConfigFromParams,
    generateSeededConfigMatrix,
    synthesizeExactTokenPayload,
} = await import('./prngAndTokenCalibrator.ts');

const { SyntheticAgentResponder } = await import('./syntheticAgentResponder.ts');

function createInitialPipelineState(
    id: string,
    runConfig: DeepthinkRunConfig,
    challenge = 'Prove or construct a verified solution for the Core Challenge.'
): DeepthinkPipelineState {
    const safeId = id.startsWith('deepthink-') ? id : `deepthink-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return {
        id: safeId,
        challenge,
        status: 'processing',
        activeTabId: 'live',
        runConfig,
        initialStrategies: [],
        strategyProximityHistory: [],
        modulesGenerationHistory: [],
        modules: [],
        solutionCritiques: [],
        bsrRecords: [],
        branchLedgers: {},
        dosOutputs: [],
        heartbeats: [],
        modulesImpactReviewHistory: [],
        liveEvents: [],
    };
}

describe('Pillar 1: Mathematical Loop Schedule, Bounds & BSR/DOS Formulas', () => {
    it('exhaustively validates loop bounds (i in [5,20], j in [3,8], k in [2,j]) and rejects out-of-bounds triples', () => {
        for (let i = 5; i <= 20; i++) {
            for (let j = 3; j <= 8; j++) {
                for (let k = 2; k <= j; k++) {
                    const res = validateLoopBounds(i, j, k);
                    assert.equal(res.valid, true, `Expected valid for (i=${i}, j=${j}, k=${k})`);
                }
            }
        }

        assert.equal(validateLoopBounds(4, 3, 2).valid, false);
        assert.equal(validateLoopBounds(21, 3, 2).valid, false);
        assert.equal(validateLoopBounds(10, 2, 2).valid, false);
        assert.equal(validateLoopBounds(10, 9, 2).valid, false);
        assert.equal(validateLoopBounds(10, 4, 1).valid, false);
        assert.equal(validateLoopBounds(10, 4, 5).valid, false);
    });

    it('exhaustively verifies skipped-heartbeat rule, global update cadence, and n===i termination across all valid (i,j,k)', () => {
        for (let i = 5; i <= 20; i++) {
            for (let j = 3; j <= 8; j++) {
                for (let k = 2; k <= j; k++) {
                    const schedWithMods = calculateLoopSchedule(i, j, k, true);
                    const schedNoMods = calculateLoopSchedule(i, j, k, false);

                    const finalStepWithMods = determinePostIterationStep(i, 0, i, j, k, true);
                    const finalStepNoMods = determinePostIterationStep(i, 0, i, j, k, false);
                    assert.equal(finalStepWithMods.action.type, 'NONE');
                    assert.equal(finalStepNoMods.action.type, 'NONE');

                    if (j > i) {
                        assert.equal(schedWithMods.globalUpdates, 0);
                        assert.equal(schedWithMods.globalUpdateIterations.length, 0);
                    }

                    assert.equal(schedNoMods.standaloneHeartbeats, 0);
                    assert.equal(schedNoMods.heartbeatIterations.length, 0);

                    let sinceHb = 0;
                    for (let n = 1; n < i; n++) {
                        const step = determinePostIterationStep(n, sinceHb, i, j, k, true);
                        const nextSinceIfNone = sinceHb + 1;
                        if (n % j === 0) {
                            assert.equal(step.action.type, 'GLOBAL_UPDATE');
                            assert.equal(step.nextSinceHeartbeat, 0);
                        } else if (nextSinceIfNone === k) {
                            const nextGu = (Math.floor(n / j) + 1) * j;
                            const shouldSkip = nextGu < i && nextGu - n < 2;
                            assert.equal(
                                step.action.type,
                                shouldSkip ? 'NONE' : 'HEARTBEAT',
                                `Mismatch at (i=${i}, j=${j}, k=${k}, n=${n})`
                            );
                        } else {
                            assert.equal(step.action.type, 'NONE');
                        }
                        sinceHb = step.nextSinceHeartbeat;
                    }
                }
            }
        }

        const docExampleSchedule = calculateLoopSchedule(14, 6, 5, true);
        assert.equal(docExampleSchedule.heartbeatIterations.includes(5), false, 'n=5 must skip standalone heartbeat because n=6 is a Global Update');
        assert.equal(docExampleSchedule.heartbeatIterations.includes(11), false, 'n=11 must skip standalone heartbeat because n=12 is a Global Update');
        assert.deepEqual(docExampleSchedule.globalUpdateIterations, [6, 12]);
        assert.deepEqual(docExampleSchedule.heartbeatIterations, []);

        const tableSchedule = calculateLoopSchedule(15, 5, 3, true);
        assert.deepEqual(tableSchedule.globalUpdateIterations, [5, 10]);
        assert.deepEqual(tableSchedule.heartbeatIterations, [3, 8, 13]);
    });

    it('reproduces the exact BSR worked example from DeepthinkDocs.md', () => {
        const standingLedger: BsrLedgerEntry[] = [
            { iteration: 2, direction: 'progress', size: 'large', weight: 4, reason: 'p1' },
            { iteration: 3, direction: 'progress', size: 'medium', weight: 2, reason: 'p2' },
            { iteration: 4, direction: 'progress', size: 'small', weight: 1, reason: 'p3' },
            { iteration: 5, direction: 'regression', size: 'small', weight: 1, reason: 'r1' },
        ];
        const bsrReport: BsrReport = {
            branch_id: 'main2',
            confirmed_progress: [
                { iteration: 6, size: 'large', reason: 'Large progress at iter 6 (+4)' },
                { iteration: 7, size: 'small', reason: 'Small progress at iter 7 (+1)' },
            ],
            confirmed_regression: [
                { iteration: 9, size: 'large', reason: 'Large regression at iter 9 (-4)' },
                { iteration: 10, size: 'large', reason: 'Large regression at iter 10 (-4)' },
            ],
            critique_alignment: { value: 0.6, reason: 'Addressed most points' },
        };

        const decision = evaluateBranchState(bsrReport, 6, 10, standingLedger, {
            weights: { small: 1, medium: 2, large: 4 },
            tau: 2,
            theta: 0.3,
        });

        assert.equal(decision.net, -3);
        assert.equal(decision.movement, 13);
        assert.equal(decision.window_outcome, 'REGRESS');
        assert.equal(decision.last_good_iteration, 8);
        assert.ok(Math.abs(decision.lost_ground - 8 / 15) < 1e-9);
        assert.ok(Math.abs(decision.drift - (-3 / 15)) < 1e-9);
        assert.ok(Math.abs(decision.stall_evidence - 0.6) < 1e-9);
        assert.ok(Math.abs(decision.progress_kept - 3 / 23) < 1e-9);
        assert.ok(Math.abs(decision.pressure.CONTINUE - 0) < 1e-9);
        assert.ok(Math.abs(decision.pressure.EVOLVE - 8 / 15) < 1e-9);
        assert.equal(decision.decision, 'EVOLVE');
        assert.equal(decision.form, 'rollback');
        assert.equal(decision.rollback_to, 8);
    });

    it('property-tests 1,000 randomized BSR trajectories across all weight presets and verifies algebraic invariants', () => {
        const prng = new SeededPRNG(0x13572468);
        const sizes = ['small', 'medium', 'large'] as const;

        for (let trial = 0; trial < 1000; trial++) {
            const preset = prng.pick(BSR_WEIGHT_PRESETS);
            const tau = prng.nextInt(1, 4);
            const theta = prng.nextFloat(0.1, 0.6, 2);
            const windowStart = prng.nextInt(1, 13);
            const windowEnd = windowStart + prng.nextInt(2, 7);

            const standingLedger: BsrLedgerEntry[] = [];
            const standingCount = prng.nextInt(0, 6);
            for (let s = 0; s < standingCount; s++) {
                const size = prng.pick(sizes);
                standingLedger.push({
                    iteration: prng.nextInt(1, Math.max(1, windowStart - 1)),
                    direction: prng.nextBool(0.65) ? 'progress' : 'regression',
                    size,
                    weight: preset.weights[size],
                    reason: `standing_${s}`,
                });
            }

            const progressEvents = [];
            const regressionEvents = [];
            const eventCount = prng.nextInt(0, 8);
            for (let e = 0; e < eventCount; e++) {
                const ev = {
                    iteration: prng.nextInt(windowStart, windowEnd),
                    size: prng.pick(sizes),
                    reason: `win_${e}`,
                };
                if (prng.nextBool(0.5)) progressEvents.push(ev);
                else regressionEvents.push(ev);
            }

            const alignment = prng.nextFloat(-1.0, 1.0, 2);
            const bsrReport: BsrReport = {
                branch_id: 'main1',
                confirmed_progress: progressEvents,
                confirmed_regression: regressionEvents,
                critique_alignment: { value: alignment, reason: 'fuzz' },
            };

            const res = evaluateBranchState(bsrReport, windowStart, windowEnd, standingLedger, {
                weights: preset.weights,
                tau,
                theta,
            });

            assert.ok(res.lost_ground >= 0 && res.lost_ground <= 1);
            assert.ok(res.progress_kept >= 0 && res.progress_kept <= 1);
            assert.ok(res.pressure.CONTINUE >= 0 && res.pressure.CONTINUE <= 1);
            assert.ok(res.pressure.EVOLVE >= 0 && res.pressure.EVOLVE <= 1);
            assert.ok(res.pressure.PRUNE >= 0 && res.pressure.PRUNE <= 1);
            assert.ok(res.drift >= -1 && res.drift <= 1);

            if (alignment <= 0) {
                assert.equal(res.pressure.PRUNE, 0);
            }

            if (standingLedger.length === 0 && res.decision === 'EVOLVE') {
                assert.equal(res.form, 'rollback');
            }
        }

        assert.equal(calculateUtilizationVector([]), undefined);
        const vec = calculateUtilizationVector([
            { branch_id: 'main1', utilization: { classification: 'USED_CORRECTLY', reason: 'r1' } },
            { branch_id: 'main2', utilization: { classification: 'USED_PARTIALLY', reason: 'r2' } },
            { branch_id: 'main3', utilization: { classification: 'NOT_USED', reason: 'r3' } },
            { branch_id: 'main4', utilization: { classification: 'MISUSED', reason: 'r4' } },
        ]);
        assert.deepEqual(vec, {
            correct_use: 0.25,
            partial_use: 0.25,
            not_used: 0.25,
            misused: 0.25,
        });
    });
});

describe('Pillar 2: Output Token Gates (5k/10k), Shared Workspace (5k) & Sandbox Limits', () => {
    it('enforces exact 5,000 vs 10,000 token limits across all 11 registered Deepthink agent roles', () => {
        const agentIds = Object.keys(DEEPTHINK_AGENT_REGISTRY) as Array<keyof typeof DEEPTHINK_AGENT_REGISTRY>;
        assert.equal(agentIds.length, 11);
        for (const agentId of agentIds) {
            const limit = deepthinkAgentMaxOutputTokens(agentId);
            if (agentId === 'solutionCorrection' || agentId === 'memoryBank') {
                assert.equal(limit, 10000, `${agentId} must have 10,000 token limit`);
            } else {
                assert.equal(limit, 5000, `${agentId} must have 5,000 token limit`);
            }
        }
    });

    it('rejects over-limit final_output (5,001 and 10,001 tokens) in real runSandboxToolAgent, skips sibling tool calls, and accepts condensed retry', async () => {
        const over5kPayload = synthesizeExactTokenPayload(5001, 'ATTEMPT_OVER_LIMIT:');
        const exact5kPayload = synthesizeExactTokenPayload(5000, 'ATTEMPT_EXACT_LIMIT:');
        assert.equal(countTextTokens(over5kPayload), 5001);
        assert.equal(countTextTokens(exact5kPayload), 5000);

        let capturedTurn2Contents: any[] = [];
        await withSyntheticToolCallingProvider(
            async ({ turnIndex, contents }) => {
                if (turnIndex === 1) {
                    return [
                        {
                            functionCall: {
                                id: 'call_over_5k',
                                name: 'final_output',
                                args: { response: over5kPayload },
                            },
                        },
                        {
                            functionCall: {
                                id: 'call_sibling_exec',
                                name: 'sandbox_exec',
                                args: { command: 'echo should_not_execute' },
                            },
                        },
                    ];
                }
                capturedTurn2Contents = contents;
                return [
                    {
                        functionCall: {
                            id: 'call_exact_5k',
                            name: 'final_output',
                            args: { response: exact5kPayload },
                        },
                    },
                ];
            },
            async (sandboxRuntime) => {
                const ws = new SharedWorkspaceManager();
                const res = await sandboxRuntime.runSandboxToolAgent({
                    messages: [new HumanMessage('Produce iteration 1 solution attempt.')],
                    systemPrompt: 'System prompt',
                    modelName: 'gemini-3.5-flash-synthetic',
                    agentName: 'solutionAttempt',
                    maxOutputTokens: 5000,
                    omitUploadedFileMessage: true,
                    sharedWorkspaceHandler: (input) => ws.handleToolCall(input),
                });

                assert.equal(res.text, exact5kPayload);
                const serializedTurn2 = JSON.stringify(capturedTurn2Contents);
                assert.ok(serializedTurn2.includes('exceeding the maximum allowed limit of 5000 output tokens'));
                assert.ok(serializedTurn2.includes('5001 tokens'));
                assert.ok(serializedTurn2.includes('Not executed: final_output exceeded the token limit in the same turn.'));
            }
        );

        const over10kPayload = synthesizeExactTokenPayload(10001, 'CORRECTION_OVER_LIMIT:');
        const valid10kPayload = synthesizeExactTokenPayload(9990, 'CORRECTION_VALID_LIMIT:');
        assert.equal(countTextTokens(over10kPayload), 10001);

        let corrTurnCount = 0;
        await withSyntheticToolCallingProvider(
            async ({ turnIndex }) => {
                corrTurnCount = turnIndex;
                if (turnIndex === 1) {
                    return [
                        {
                            functionCall: {
                                id: 'call_over_10k',
                                name: 'final_output',
                                args: { response: over10kPayload },
                            },
                        },
                    ];
                }
                return [
                    {
                        functionCall: {
                            id: 'call_valid_10k',
                            name: 'final_output',
                            args: { response: valid10kPayload },
                        },
                    },
                ];
            },
            async (sandboxRuntime) => {
                const res = await sandboxRuntime.runSandboxToolAgent({
                    messages: [new HumanMessage('Produce iteration 2 correction.')],
                    systemPrompt: 'System prompt',
                    modelName: 'gemini-3.5-flash-synthetic',
                    agentName: 'solutionCorrection',
                    maxOutputTokens: 10000,
                    omitUploadedFileMessage: true,
                });
                assert.equal(corrTurnCount, 2);
                assert.equal(res.text, valid10kPayload);
            }
        );
    });

    it('enforces 64-turn tool budget countdowns (m-10, m-5), 5 overtime grace turns, and 5 forced final_output-only turns', async () => {
        const observedToolSets: Array<{ step: number; tools: string[] }> = [];
        let sawWarning10 = false;
        let sawWarning5 = false;
        let sawOvertime = false;
        let sawForcedRevocation = false;

        await withSyntheticToolCallingProvider(
            async ({ turnIndex, contents, toolNames }) => {
                observedToolSets.push({ step: turnIndex, tools: toolNames });
                const serialized = JSON.stringify(contents);
                if (serialized.includes('[HARNESS NOTE — 10 TOOL CALLS REMAINING]')) sawWarning10 = true;
                if (serialized.includes('[HARNESS NOTE — 5 TOOL CALLS REMAINING]')) sawWarning5 = true;
                if (serialized.includes('[CRITICAL HARNESS WARNING — MAXIMUM TOOL CALL BUDGET (12) REACHED]')) sawOvertime = true;
                if (serialized.includes('[CRITICAL HARNESS ENFORCEMENT — ALL OTHER TOOL ACCESS REVOKED]')) sawForcedRevocation = true;

                if (turnIndex <= 17) {
                    return [
                        {
                            functionCall: {
                                id: `call_ws_${turnIndex}`,
                                name: 'shared_workspace',
                                args: { action: 'read' },
                            },
                        },
                    ];
                }
                return [
                    {
                        functionCall: {
                            id: 'call_forced_final',
                            name: 'final_output',
                            args: { response: 'Completed on forced turn 18 after tool revocation.' },
                        },
                    },
                ];
            },
            async (sandboxRuntime) => {
                const ws = new SharedWorkspaceManager();
                const res = await sandboxRuntime.runSandboxToolAgent({
                    messages: [new HumanMessage('Run multi-step tool loop.')],
                    systemPrompt: 'System prompt',
                    modelName: 'gemini-3.5-flash-synthetic',
                    agentName: 'solutionAttempt',
                    maxOutputTokens: 5000,
                    maxToolTurns: 12,
                    omitUploadedFileMessage: true,
                    sharedWorkspaceHandler: (input) => ws.handleToolCall(input),
                });

                assert.equal(res.text, 'Completed on forced turn 18 after tool revocation.');
                assert.equal(sawWarning10, true, 'Must inject 10-calls-remaining warning');
                assert.equal(sawWarning5, true, 'Must inject 5-calls-remaining warning');
                assert.equal(sawOvertime, true, 'Must inject overtime grace warning at budget limit');
                assert.equal(sawForcedRevocation, true, 'Must inject sandbox access revoked note after 5 grace turns');

                assert.deepEqual(observedToolSets[16].tools.sort(), ['final_output', 'sandbox_exec', 'shared_workspace']);
                assert.deepEqual(observedToolSets[17].tools, ['final_output']);
            }
        );
    });

    it('enforces SharedWorkspaceManager 5,000-token cap and FIFO write-queue serialization across 25 concurrent writers', async () => {
        const ws = new SharedWorkspaceManager();

        await Promise.all(
            Array.from({ length: 25 }, (_, idx) =>
                ws.append(`entry_${String(idx + 1).padStart(2, '0')}: verified harness check`)
            )
        );

        const contentAfterConcurrent = await ws.read();
        for (let idx = 1; idx <= 25; idx++) {
            const key = `entry_${String(idx).padStart(2, '0')}: verified harness check`;
            assert.ok(contentAfterConcurrent.includes(key), `Missing concurrent write ${key}`);
        }

        await assert.rejects(
            () => ws.edit('verified harness check', 'updated check', false),
            /matched multiple locations/i
        );

        await ws.edit('verified harness check', 'verified_ok', true);
        const contentAfterEdit = await ws.read();
        assert.ok(!contentAfterEdit.includes('verified harness check'));
        assert.equal((contentAfterEdit.match(/verified_ok/g) || []).length, 25);

        const beforeOverflow = await ws.read();
        const beforeTokens = countTextTokens(beforeOverflow);
        const hugeAddition = synthesizeExactTokenPayload(5005 - beforeTokens, 'OVERFLOW_BLOCK:');
        await assert.rejects(
            async () => {
                await ws.append(hugeAddition);
            },
            (err: unknown) => {
                assert.ok(err instanceof SharedWorkspaceTokenLimitError);
                assert.ok(err.tokenCount > 5000);
                const note = buildSharedWorkspaceTokenGateHarnessNote(err.tokenCount, err.maxTokens);
                assert.ok(note.includes('[HARNESS NOTE — SHARED WORKSPACE TOKEN LIMIT EXCEEDED]'));
                assert.ok(note.includes('exceeds the maximum limit of 5000 tokens'));
                return true;
            }
        );
        assert.equal(await ws.read(), beforeOverflow);
    });

    it('truncates sandbox_exec stdout and stderr independently at 5,000 tokens via Backend/sandboxToolBackend.ts', async () => {
        await withInProcessSandboxBackend(async (api) => {
            const repoId = 'deepthink-token-trunc-test';
            const repoRes = await api.request('/api/sandbox/repository/ensure-deepthink', {
                method: 'POST',
                body: { repositoryId: repoId },
            });
            assert.equal(repoRes.ok, true);

            const execRes = await api.request('/api/sandbox/execute', {
                method: 'POST',
                body: {
                    sessionId: 'dtsb-trunc-test-1234',
                    repositoryAccess: {
                        repositoryId: repoId,
                        fullRepositoryRead: true,
                    },
                    command: 'node -e \'const s = " alpha".repeat(6200); process.stdout.write("OUT:" + s); process.stderr.write("ERR:" + s);\'',
                },
            });

            assert.equal(execRes.ok, true);
            assert.ok(execRes.body.stdout.includes('[stdout truncated after 5000 tokens;'));
            assert.ok(execRes.body.stderr.includes('[stderr truncated after 5000 tokens;'));
        });
    });
});

describe('Pillar 3: Context Window Memory Compression, Historical Reframing & Sanitization', () => {
    it('replaces prior Global Update and Heartbeat contexts with compact {GU_Reframed_Note} and {HB_Reframed_Note} references', () => {
        const guHistory = buildStrategyProximityHistoryWithNotes(
            [{ role: 'generator', content: '{"strategies":["S1"]}', turnNumber: 1 }],
            [
                {
                    updateNumber: 1,
                    turns: [{ role: 'generator', content: '{"evolved_slots":[]}', turnNumber: 1 }],
                },
                {
                    updateNumber: 2,
                    turns: [{ role: 'generator', content: '{"pruned_slots":[]}', turnNumber: 1 }],
                },
            ],
            4
        );

        assert.ok(guHistory.includes('# Seed Strategy Generation History'));
        assert.ok(guHistory.includes('# Global Update 1 Strategy Revision History'));
        assert.ok(guHistory.includes('DOS_history/DOS_global_update_01_step_i.md'));
        assert.ok(guHistory.includes('# Global Update 2 Strategy Revision History'));
        assert.ok(guHistory.includes('DOS_history/DOS_global_update_02_step_i.md'));
        assert.ok(!guHistory.includes('<ConsolidatedBsrDecisions>'));

        const hbHistory = buildModulesImpactReviewHistoryWithNotes([
            {
                heartbeatNo: 1,
                dosFilePath: 'DOS_history/DOS_heartbeat_01.md',
                turns: [{ role: 'generator', content: '{"modules":[]}', turnNumber: 1 }],
            },
            {
                heartbeatNo: 2,
                dosFilePath: 'DOS_history/DOS_global_update_01_step_ii.md',
                turns: [{ role: 'generator', content: '{"modules":[]}', turnNumber: 1 }],
            },
        ]);

        assert.ok(hbHistory.includes('# Heartbeat 1 Modules Generator History'));
        assert.ok(hbHistory.includes('DOS_history/DOS_heartbeat_01.md'));
        assert.ok(hbHistory.includes('# Heartbeat 2 Modules Generator History'));
        assert.ok(hbHistory.includes('DOS_history/DOS_global_update_01_step_ii.md'));
    });

    it('sanitizes .jsonl trajectories (omits system & first user prompt, masks read-only bash stdout, scrubs base64 images)', async () => {
        await withInProcessSandboxBackend(async () => {
            const sandboxRuntime = await import('../../Core/SandboxToolRuntime.ts');
            const messages = [
                new SystemMessage('HUGE_SYSTEM_PROMPT'),
                new HumanMessage('INITIAL_USER_PROMPT_IN_MD'),
                new AIMessage({
                    content: [{ text: 'Checking files', thoughtSignature: 'secret_sig_123' } as any],
                    tool_calls: [
                        { id: 'c1', name: 'sandbox_exec', args: { command: 'cat Strategy-1/iter_01.md' }, type: 'tool_call' },
                        { id: 'c2', name: 'sandbox_exec', args: { command: 'python3 /tmp/strategy1/verify.py' }, type: 'tool_call' },
                    ],
                }),
                new ToolMessage({
                    tool_call_id: 'c1',
                    name: 'sandbox_exec',
                    status: 'success',
                    content: 'VERY_LONG_CAT_OUTPUT_THAT_MUST_BE_MASKED',
                }),
                new ToolMessage({
                    tool_call_id: 'c2',
                    name: 'sandbox_exec',
                    status: 'success',
                    content: 'VERIFICATION_SCRIPT_PASSED_100_PERCENT',
                }),
                new HumanMessage({
                    content: [
                        { text: 'Captured image:' },
                        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA' } },
                    ] as any,
                }),
            ];

            const jsonl = sandboxRuntime.buildRawTrajectoryJsonl(messages);
            const lines = jsonl.trim().split('\n').map((l: string) => JSON.parse(l));

            assert.equal(lines.some((l: any) => l.role === 'system' || l.kind === 'system'), false);
            assert.equal(JSON.stringify(lines).includes('INITIAL_USER_PROMPT_IN_MD'), false);
            assert.equal(JSON.stringify(lines).includes('secret_sig_123'), false);

            assert.equal(JSON.stringify(lines).includes('VERY_LONG_CAT_OUTPUT_THAT_MUST_BE_MASKED'), false);
            assert.equal(JSON.stringify(lines).includes('[read-only command output masked]'), true);
            assert.equal(JSON.stringify(lines).includes('VERIFICATION_SCRIPT_PASSED_100_PERCENT'), true);

            assert.equal(JSON.stringify(lines).includes('iVBORw0KGgoAAAANSUhEUgAAAAUA'), false);
        });
    });

    it('splits inline execution images into Gemini parts in order and strips them during prunePipelineForExport', () => {
        const rawText = [
            'Before image text.',
            '<!-- EXECUTION_IMAGE_START -->',
            '<!-- MIME_TYPE: image/png -->',
            'AAAA',
            '<!-- EXECUTION_IMAGE_END -->',
            'After image text.',
        ].join('\n');

        const parts = parsePromptToGeminiParts(rawText);
        assert.equal(parts.length, 3);
        assert.ok(parts[0].text?.includes('Before image text.'));
        assert.deepEqual(parts[1].inlineData, { mimeType: 'image/png', data: 'AAAA' });
        assert.ok(parts[2].text?.includes('After image text.'));

        const dummyConfig = buildOrchestratorConfigFromParams({
            i: 5, j: 3, k: 2, strategiesCount: 1, strategyProximityLoops: 1,
            modulesCount: 0, modulesImpactReviewLoops: 1, isolateBranches: false, deepthinkCodeExecutionEnabled: false,
        });
        const state: DeepthinkPipelineState = {
            ...createInitialPipelineState('export_test', dummyConfig, rawText),
            status: 'processing',
            isStopRequested: true,
            liveEvents: [
                {
                    id: 'ev1',
                    timestamp: 1,
                    agentName: 'solutionAttempt',
                    stepDescription: 'Iteration 1',
                    eventType: 'agent_complete',
                    prompt: rawText,
                    response: rawText,
                },
            ],
        };

        const exported = prunePipelineForExport(state);
        assert.equal(exported.status, 'stopped');
        assert.equal(exported.isStopRequested, false);
        assert.equal(exported.challenge.includes('EXECUTION_IMAGE_START'), false);
        assert.ok(exported.challenge.includes('EXECUTION_IMAGE_REF:'));
        assert.equal(exported.liveEvents?.[0].prompt?.includes('EXECUTION_IMAGE_START'), false);
        assert.equal(exported.liveEvents?.[0].response?.includes('EXECUTION_IMAGE_START'), false);
        assert.ok(exported.liveEvents?.[0].prompt?.includes('[Image attachment referenced in user_uploaded]'));
    });
});

describe('Pillar 4 & 5: Real Temporary Git Repository Rollback/Prune & Audited Discrepancies', () => {
    it('executes full Global Update EVOLVE (rollback) and repeated PRUNE against a REAL temporary Git repository on disk', async () => {
        await withInProcessSandboxBackend(async (api) => {
            const config = buildOrchestratorConfigFromParams({
                i: 7,
                j: 3,
                k: 3,
                strategiesCount: 2,
                strategyProximityLoops: 1,
                modulesCount: 2,
                modulesImpactReviewLoops: 1,
                isolateBranches: true,
                deepthinkCodeExecutionEnabled: true,
                bsrWeightPreset: 'standard',
            });

            const state = createInitialPipelineState('git_real_repo_test', config);
            const responder = new SyntheticAgentResponder({
                seed: 0xCAFE1234,
                config,
                forcedSlotBehaviors: {
                    main1: ['FORCE_EVOLVE_SCROLLBACK', 'FORCE_CONTINUE'],
                    main2: ['FORCE_PRUNE', 'FORCE_PRUNE'],
                },
                enableAsyncJitter: true,
                maxJitterMs: 5,
            });

            const orchestrator = new DeepthinkPipelineOrchestrator(
                state,
                responder.createCallbacks()
            );

            await orchestrator.run();

            assert.equal(state.status, 'completed');
            assert.deepEqual(responder.invariantViolations, []);
            assert.deepEqual(responder.verifyPhaseBarriers(), []);

            const gitHarness = orchestrator.getGitHarness();
            const archivedDirs = gitHarness.getArchivedDirectories();

            assert.ok(archivedDirs.includes('Pruned_Strategies/Strategy-2_pruned_01'));
            assert.ok(archivedDirs.includes('Pruned_Strategies/Strategy-2_pruned_02'));

            const filesRes = await api.request(
                `/api/sandbox/workspace/files?repositoryId=${encodeURIComponent(state.id)}`
            );
            assert.equal(filesRes.ok, true);
            const repoPaths: string[] = filesRes.body.map((f: any) => f.path);

            assert.ok(
                repoPaths.some(p => p.startsWith('Pruned_Strategies/Strategy-2_pruned_01/')),
                'Real Git repo must contain Pruned_Strategies/Strategy-2_pruned_01/'
            );
            assert.ok(
                repoPaths.some(p => p.startsWith('Pruned_Strategies/Strategy-2_pruned_02/')),
                'Real Git repo must contain Pruned_Strategies/Strategy-2_pruned_02/'
            );

            assert.ok(repoPaths.includes('Strategy-1/history/iteration_01.md'));
            assert.equal(
                repoPaths.includes('Strategy-1/history/iteration_02.md'),
                false,
                'Rolled-back iteration_02.md must be removed from Strategy-1 working tree by git restore/clean'
            );
            assert.equal(
                repoPaths.includes('Strategy-1/history/iteration_03.md'),
                false,
                'Rolled-back iteration_03.md must be removed from Strategy-1 working tree by git restore/clean'
            );
            assert.ok(repoPaths.includes('Strategy-1/history/iteration_04.md'));
            assert.ok(repoPaths.includes('Strategy-1/history/memory_bank_01.md'));

            const committedFiles = gitHarness.getCommittedFiles();
            for (const committedPath of committedFiles.keys()) {
                if (
                    committedPath.endsWith('.md') &&
                    !committedPath.endsWith('/strategy.md') &&
                    !committedPath.endsWith('_finalized_and_used_so_far.md')
                ) {
                    const companionJsonl = committedPath.replace(/\.md$/, '.jsonl');
                    assert.ok(
                        committedFiles.has(companionJsonl),
                        `Missing companion .jsonl for ${committedPath}`
                    );
                }
            }
        });
    });

    it('codifies and verifies the 5 concrete code discrepancies / edge cases uncovered during deep audit', async () => {
        const configRollback = buildOrchestratorConfigFromParams({
            i: 7,
            j: 3,
            k: 3,
            strategiesCount: 2,
            strategyProximityLoops: 1,
            modulesCount: 0,
            modulesImpactReviewLoops: 1,
            isolateBranches: false,
            deepthinkCodeExecutionEnabled: false,
        });
        const stateRollback = createInitialPipelineState('edge_case_window_start_rollback', configRollback);
        let main1HistoryLengthAfterGu1 = -1;
        let main1MemoryBankAfterGu1: string | undefined = 'not_checked';
        let main2HistoryLengthAfterGu2 = -1;
        let main2MemoryBankAfterGu2: string | undefined = undefined;

        const responderRollback = new SyntheticAgentResponder({
            seed: 0x77889900,
            config: configRollback,
            forcedSlotBehaviors: {
                main1: ['FORCE_EVOLVE_WINDOW_START', 'FORCE_CONTINUE'],
                main2: ['FORCE_CONTINUE', 'FORCE_EVOLVE_WINDOW_START'],
            },
            enableAsyncJitter: false,
        });

        const baseCallbacks = responderRollback.createCallbacks();
        const wrappedCallbacks = {
            ...baseCallbacks,
            callAI: async (callArgs: any) => {
                if (callArgs.stepDescription === 'Solution Correction for main1 (Iteration 4)') {
                    const m1 = stateRollback.initialStrategies[0];
                    main1HistoryLengthAfterGu1 = m1.iterationHistory?.iterations.length ?? 0;
                    main1MemoryBankAfterGu1 = m1.memoryBank;
                }
                if (callArgs.stepDescription === 'Solution Correction for main2 (Iteration 7)') {
                    const m2 = stateRollback.initialStrategies[1];
                    main2HistoryLengthAfterGu2 = m2.iterationHistory?.iterations.length ?? 0;
                    main2MemoryBankAfterGu2 = m2.memoryBank;
                }
                return baseCallbacks.callAI(callArgs);
            },
        };

        const orchRollback = new DeepthinkPipelineOrchestrator(stateRollback, wrappedCallbacks);
        await orchRollback.run();

        assert.equal(main1HistoryLengthAfterGu1, 0);
        assert.equal(main1MemoryBankAfterGu1, undefined);
        assert.equal(
            responderRollback.invocations.some(inv => inv.label === 'memoryBank:main1:iter3'),
            false,
            'memoryBank must be skipped when rollbackTo === window_start at GU 1'
        );
        assert.equal(
            responderRollback.invocations.some(inv => inv.label === 'memoryBank:main2:iter6'),
            false,
            'memoryBank must be skipped when rollbackTo === window_start at GU 2'
        );

        assert.equal(main2HistoryLengthAfterGu2, 3);
        assert.ok(Boolean(main2MemoryBankAfterGu2), 'main2 must retain its GU 1 memoryBank after rolling back to window_start at GU 2');

        assert.equal(configRollback.modulesCount, 0);
        assert.equal(stateRollback.heartbeats?.length ?? 0, 0);
        assert.equal((stateRollback as any).heartbeatNo, 2, 'heartbeatNo increments on each of the 2 Global Updates even when modulesCount === 0');

        const over10kDirect = synthesizeExactTokenPayload(10050, 'DIRECT_UNBOUNDED:');
        assert.equal(countTextTokens(over10kDirect), 10050);

        const apiEstimate = calculateDeepthinkApiCallsFromParams({
            strategiesCount: 3,
            strategyProximityLoops: 1,
            modulesCount: 2,
            modulesImpactReviewLoops: 1,
            i: 10,
            j: 4,
            k: 4,
            deepthinkCodeExecutionEnabled: false,
        });
        assert.equal(apiEstimate.breakdown.memoryBank.min, 6);
        assert.equal(apiEstimate.breakdown.memoryBank.max, 0);

        const tokenEst = calculateDeepthinkTokenEstimate({
            strategiesCount: 3,
            strategyProximityLoops: 1,
            modulesCount: 2,
            modulesImpactReviewLoops: 1,
            i: 10,
            j: 4,
            k: 4,
            isolateBranches: false,
            codeExecutionEnabled: true,
        });
        assert.ok(tokenEst.total.worst >= tokenEst.total.average && tokenEst.total.average > 0);
    });
});

describe('Pillar 6: Fault Injection, Contract Retries, Checkpointing & Exact Resume Parity', () => {
    it('retries transient provider errors, malformed JSON, and contract violations up to 4 attempts and succeeds', async () => {
        const config = buildOrchestratorConfigFromParams({
            i: 5,
            j: 3,
            k: 2,
            strategiesCount: 2,
            strategyProximityLoops: 1,
            modulesCount: 2,
            modulesImpactReviewLoops: 1,
            isolateBranches: false,
            deepthinkCodeExecutionEnabled: false,
        });

        const state = createInitialPipelineState('retry_resilience_test', config);
        const responder = new SyntheticAgentResponder({
            seed: 0xABCD9876,
            config,
            faultRules: [
                { labelPattern: 'initialStrategy:turn1', failAttempts: 2, failureType: 'transient_error' },
                { labelPattern: /^dos:heartbeat:/, failAttempts: 2, failureType: 'malformed_json' },
                { labelPattern: 'bsr:main1:iter3', failAttempts: 3, failureType: 'contract_violation' },
                { labelPattern: 'solutionCorrection:main1:iter5', failAttempts: 1, failureType: 'transient_error' },
            ],
            enableAsyncJitter: false,
        });

        const orchestrator = new DeepthinkPipelineOrchestrator(
            state,
            responder.createCallbacks()
        );
        await orchestrator.run();

        assert.equal(state.status, 'completed');
        const retryEvents = (state.liveEvents ?? []).filter(ev => ev.eventType === 'agent_retry');
        assert.ok(retryEvents.length >= 5, `Expected retry events to be recorded in liveEvents (found ${retryEvents.length})`);
    });

    it('pauses cleanly on mid-run stop/failure, resets in-flight state, and achieves exact state parity upon resume', async () => {
        const config = buildOrchestratorConfigFromParams({
            i: 8,
            j: 3,
            k: 2,
            strategiesCount: 2,
            strategyProximityLoops: 1,
            modulesCount: 2,
            modulesImpactReviewLoops: 1,
            isolateBranches: false,
            deepthinkCodeExecutionEnabled: false,
        });
        const seed = 0x55AA55AA;
        const forcedSlotBehaviors = {
            main1: ['FORCE_CONTINUE', 'FORCE_EVOLVE_IN_PLACE'] as any,
            main2: ['FORCE_CONTINUE', 'FORCE_EVOLVE_SCROLLBACK'] as any,
        };

        const refState = createInitialPipelineState('resume_parity_test', config);
        const refResponder = new SyntheticAgentResponder({
            seed,
            config,
            forcedSlotBehaviors,
            enableAsyncJitter: false,
        });
        const refOrch = new DeepthinkPipelineOrchestrator(
            refState,
            refResponder.createCallbacks()
        );
        await refOrch.run();
        assert.equal(refState.status, 'completed');

        const interruptedState = createInitialPipelineState('resume_parity_test', config);
        let part1Orch: InstanceType<typeof DeepthinkPipelineOrchestrator>;
        const part1Responder = new SyntheticAgentResponder({
            seed,
            config,
            forcedSlotBehaviors,
            enableAsyncJitter: false,
            faultRules: [
                {
                    labelPattern: 'solutionCorrection:main1:iter4',
                    failAttempts: 1,
                    failureType: 'stop_request',
                    onTrigger: () => {
                        part1Orch.stop();
                    },
                },
            ],
        });

        part1Orch = new DeepthinkPipelineOrchestrator(
            interruptedState,
            part1Responder.createCallbacks()
        );
        await assert.rejects(async () => {
            await part1Orch.run();
        }, /Deepthink run stopped by user request|Pipeline execution stopped by user request/);

        assert.equal(interruptedState.status, 'stopped');
        assert.equal(
            new Set(interruptedState.bsrRecords.map(r => r.updateNumber)).size,
            1,
            'Global Update 1 must be completed in interrupted state'
        );

        const checkpointState: DeepthinkPipelineState = JSON.parse(JSON.stringify(interruptedState));
        resetInFlightPipelineExecution(checkpointState);
        checkpointState.status = 'processing';
        checkpointState.isStopRequested = false;

        const part2Responder = new SyntheticAgentResponder({
            seed,
            config,
            forcedSlotBehaviors,
            enableAsyncJitter: false,
        });
        const resumedOrch = new DeepthinkPipelineOrchestrator(
            checkpointState,
            part2Responder.createCallbacks()
        );
        await resumedOrch.run();

        assert.equal(checkpointState.status, 'completed');
        assert.equal(
            part2Responder.invocations.some(inv => inv.label.startsWith('initialStrategy:')),
            false,
            'Resumed run must skip completed Seed Strategy Generation'
        );
        assert.equal(
            part2Responder.invocations.some(inv => inv.iteration !== undefined && inv.iteration <= 3),
            false,
            'Resumed run must skip completed iterations 1..3 and Global Update 1'
        );

        assert.deepEqual(checkpointState.branchLedgers, refState.branchLedgers);
        assert.equal(checkpointState.bsrRecords.length, refState.bsrRecords.length);
        assert.equal(checkpointState.heartbeats.length, refState.heartbeats.length);
        for (let idx = 0; idx < config.strategiesCount; idx++) {
            assert.equal(
                checkpointState.initialStrategies[idx].refinedSolution,
                refState.initialStrategies[idx].refinedSolution
            );
            assert.equal(
                checkpointState.initialStrategies[idx].memoryBank,
                refState.initialStrategies[idx].memoryBank
            );
        }
    });
});

describe('Pillar 7: Seeded E2E Fuzzing Matrix (Full Pipeline Data Flow & Invariants)', () => {
    const matrixSpecs: SeededRunSpec[] = generateSeededConfigMatrix();

    it(`executes ${matrixSpecs.length} deterministic seeded E2E configurations across all parameter permutations`, async () => {
        assert.ok(
            matrixSpecs.length >= 25,
            `Expected at least 25 seeded E2E runs by default (got ${matrixSpecs.length})`
        );

        for (const spec of matrixSpecs) {
            const state = createInitialPipelineState(`fuzz_run_${spec.runIndex}_${spec.seed}`, spec.config);
            const responder = new SyntheticAgentResponder({
                seed: spec.seed,
                config: spec.config,
                forcedSlotBehaviors: spec.forcedSlotBehaviors,
                enableAsyncJitter: spec.enableAsyncJitter,
                maxJitterMs: spec.maxJitterMs,
            });

            const orchestrator = new DeepthinkPipelineOrchestrator(
                state,
                responder.createCallbacks()
            );

            await orchestrator.run();

            const ctxMsg = `[Run #${spec.runIndex} "${spec.label}" seed=0x${spec.seed.toString(16)}]`;

            assert.equal(state.status, 'completed', `${ctxMsg} pipeline did not complete`);
            assert.equal(
                state.initialStrategies.length,
                spec.config.strategiesCount,
                `${ctxMsg} expected ${spec.config.strategiesCount} active branches`
            );
            for (const branch of state.initialStrategies) {
                assert.ok(
                    Boolean(branch.refinedSolution?.trim()),
                    `${ctxMsg} branch ${branch.id} refinedSolution is empty`
                );
                const finalEntry = branch.iterationHistory?.iterations?.find(
                    e => e.iterationNumber === spec.config.i
                );
                assert.ok(
                    Boolean(finalEntry?.correctedSolution?.trim()),
                    `${ctxMsg} branch ${branch.id} missing final iteration (${spec.config.i}) correctedSolution`
                );
                assert.equal(
                    finalEntry?.critique || '',
                    '',
                    `${ctxMsg} branch ${branch.id} should not generate critique on final iteration (${spec.config.i})`
                );
            }
            assert.equal(
                responder.invocations.some(
                    inv => inv.agentKind === 'solutionCritique' && inv.iteration === spec.config.i
                ),
                false,
                `${ctxMsg} solutionCritique must not be invoked on final iteration (${spec.config.i})`
            );

            assert.deepEqual(
                responder.invariantViolations,
                [],
                `${ctxMsg} prompt/memory invariant violations:\n${responder.invariantViolations.join('\n')}`
            );

            const barrierErrors = responder.verifyPhaseBarriers();
            assert.deepEqual(
                barrierErrors,
                [],
                `${ctxMsg} phase barrier violations:\n${barrierErrors.join('\n')}`
            );

            const updatesByNo = new Map<number, typeof state.bsrRecords>();
            for (const rec of state.bsrRecords) {
                const list = updatesByNo.get(rec.updateNumber) ?? [];
                list.push(rec);
                updatesByNo.set(rec.updateNumber, list);
            }
            for (const [updateNo, records] of updatesByNo.entries()) {
                const guIter = updateNo * spec.config.j;
                const allContinue = records.every(r => r.computed.decision === 'CONTINUE');
                const ranSurgicalSg = responder.invocations.some(
                    inv => inv.label.startsWith(`strategyGeneration:update:iter${guIter}:`)
                );
                if (allContinue) {
                    assert.equal(
                        ranSurgicalSg,
                        false,
                        `${ctxMsg} Global Update ${updateNo} (iter ${guIter}) had all CONTINUE slots but still invoked Surgical Strategy Generator`
                    );
                } else {
                    assert.equal(
                        ranSurgicalSg,
                        true,
                        `${ctxMsg} Global Update ${updateNo} (iter ${guIter}) had non-CONTINUE slots but skipped Surgical Strategy Generator`
                    );
                }
            }

            const committedFiles = orchestrator.getGitHarness().getCommittedFiles();
            for (const filePath of committedFiles.keys()) {
                if (
                    filePath.endsWith('.md') &&
                    !filePath.endsWith('/strategy.md') &&
                    !filePath.endsWith('_finalized_and_used_so_far.md')
                ) {
                    const companionJsonl = filePath.replace(/\.md$/, '.jsonl');
                    assert.ok(
                        committedFiles.has(companionJsonl),
                        `${ctxMsg} Missing companion .jsonl for committed file ${filePath}`
                    );
                }
            }
        }
    });
});
