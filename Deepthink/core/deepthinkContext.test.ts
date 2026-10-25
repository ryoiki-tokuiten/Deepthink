import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildAttachmentSeedFiles,
    buildDeepthinkAttachments,
    buildFilesystemAttachmentFiles,
    buildProviderParts,
    buildTextAttachmentContext,
    selectRoutedModules,
    validateAllowedUniqueIds,
    validateExactUniqueIdSet,
} from './deepthinkContext.ts';
import {
    DEEPTHINK_AGENT_REGISTRY,
    deepthinkAgentModel,
} from './agentRegistry.ts';

const base64 = (value: string) => Buffer.from(value).toString('base64');
const image = (name: string) => ({
    name,
    mimeType: 'image/png',
    base64: base64(`${name}-pixels`),
    size: 12,
});
const textFile = (name: string, content = 'hello') => ({
    name,
    mimeType: 'text/plain',
    base64: base64(content),
    size: content.length,
});

test('attachment routing sends every direct file exactly once', () => {
    const cases = [
        {
            name: 'direct text only',
            direct: [textFile('notes.txt')],
            providerPayloads: [],
            textNames: ['notes.txt'],
            seedNames: ['notes.txt'],
        },
        {
            name: 'direct image only',
            direct: [image('diagram.png')],
            providerPayloads: [base64('diagram.png-pixels')],
            textNames: [],
            seedNames: ['diagram.png'],
        },
        {
            name: 'mixed direct files',
            direct: [textFile('notes.txt'), image('diagram.png'), textFile('data.json', '{"ok":true}')],
            providerPayloads: [base64('diagram.png-pixels')],
            textNames: ['notes.txt', 'data.json'],
            seedNames: ['notes.txt', 'diagram.png', 'data.json'],
        },
    ];

    cases.forEach(fixture => {
        const attachments = buildDeepthinkAttachments({
            directFiles: fixture.direct,
        });
        assert.deepEqual(
            buildProviderParts('prompt', attachments)
                .filter(part => 'inlineData' in part)
                .map(part => 'inlineData' in part ? part.inlineData?.data || '' : ''),
            fixture.providerPayloads,
            fixture.name,
        );
        const textContext = buildTextAttachmentContext(attachments);
        const expectedTextContext = fixture.textNames.length
            ? `\n\nDirect context files:${fixture.textNames.map(name => {
                const file = fixture.direct.find(candidate => candidate.name === name)!;
                return `\n\n--- ${name} ---\n${Buffer.from(file.base64, 'base64').toString('utf8')}\n--- end file ---`;
            }).join('')}`
            : '';
        assert.equal(textContext, expectedTextContext, fixture.name);
        assert.deepEqual(
            buildAttachmentSeedFiles(attachments).map(file => file.name),
            fixture.seedNames,
            fixture.name,
        );
    });
});

test('filesystem uploads are frozen into the manifest without becoming provider or prompt input', () => {
    const attachments = buildDeepthinkAttachments({
        directFiles: [textFile('direct.txt')],
        filesystemFiles: [textFile('nested/evidence', 'filesystem evidence')],
    });
    assert.deepEqual(
        buildProviderParts('prompt', attachments)
            .filter(part => 'inlineData' in part)
            .map(part => 'inlineData' in part ? part.inlineData?.data || '' : ''),
        [],
    );
    assert.doesNotMatch(buildTextAttachmentContext(attachments), /filesystem evidence/);
    assert.deepEqual(buildAttachmentSeedFiles(attachments).map(file => file.name), ['direct.txt']);
    assert.deepEqual(buildFilesystemAttachmentFiles(attachments), [{
        name: 'evidence.txt',
        mimeType: 'text/plain',
        base64: base64('filesystem evidence'),
        relativePath: 'user_uploaded/evidence.txt',
    }]);
});

test('invalid text data produces a stable placeholder without removing other transports', () => {
    const attachments = buildDeepthinkAttachments({
        directFiles: [{
            name: 'broken.txt',
            mimeType: 'text/plain',
            base64: Buffer.from([0xff, 0xfe]).toString('base64'),
            size: 16,
        }],
    });
    assert.match(buildTextAttachmentContext(attachments), /\[Unable to decode file\]/);
    assert.equal(buildProviderParts('prompt', attachments).length, 1);
    assert.equal(buildAttachmentSeedFiles(attachments)[0]?.name, 'broken.txt');
});

test('ID validation rejects duplicates, missing IDs, extras, and unknown routes', () => {
    assert.doesNotThrow(() => validateExactUniqueIdSet(['main1', 'main3'], ['main1', 'main3'], 'updates'));
    assert.throws(() => validateExactUniqueIdSet(['main1', 'main1'], ['main1', 'main3'], 'updates'), /duplicate/);
    assert.throws(() => validateExactUniqueIdSet(['main1'], ['main1', 'main3'], 'updates'), /exactly/);
    assert.throws(() => validateExactUniqueIdSet(['main1', 'main2'], ['main1', 'main3'], 'updates'), /exactly/);
    assert.doesNotThrow(() => validateAllowedUniqueIds([], ['main1'], 'targets', { allowEmpty: true }));
    assert.throws(() => validateAllowedUniqueIds(['main2'], ['main1'], 'targets', { allowEmpty: true }), /unknown/);
});

test('freshness and branch routing use one selector for packets and mounts', () => {
    const modules = [
        { id: 'global', targetBranchIds: [] },
        { id: 'main1', targetBranchIds: ['main1'] },
        { id: 'main2', targetBranchIds: ['main2'] },
    ];
    assert.deepEqual(
        selectRoutedModules(modules, 'main1').map(mod => mod.id),
        ['global', 'main1'],
    );
    assert.deepEqual(selectRoutedModules(modules, 'main1', true), []);
});

test('the typed registry selects models independently of display labels', () => {
    const prompts = {
        model_solutionCorrection: 'correction-model',
    } as never;
    assert.equal(
        deepthinkAgentModel('solutionCorrection', prompts, 'configured-model'),
        'correction-model',
    );
    assert.equal(
        deepthinkAgentModel('solutionCorrection', undefined, 'configured-model'),
        'configured-model',
    );
    assert.throws(() => deepthinkAgentModel('solutionCorrection', undefined, undefined));
    assert.equal(DEEPTHINK_AGENT_REGISTRY.solutionCorrection.sandboxRole, 'Solution Correction');
    assert.equal(DEEPTHINK_AGENT_REGISTRY.solutionCorrection.systemPromptKey, 'sys_deepthink_solutionCorrection');
    Object.values(DEEPTHINK_AGENT_REGISTRY).forEach(metadata => {
        assert.match(metadata.systemPromptKey, /^sys_deepthink_/);
        assert.match(metadata.modelKey, /^model_/);
    });
});

test('the typed registry enforces per-agent maxOutputTokens limits (5000 default, 10000 for correction and memoryBank)', () => {
    assert.equal(DEEPTHINK_AGENT_REGISTRY.initialStrategy.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.strategyProximity.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.modulesGeneration.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.modulesImpactReview.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.dos.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.bsr.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.solutionAttempt.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.solutionCritique.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.modulesTester.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.finalJudge.maxOutputTokens, 5000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.solutionCorrection.maxOutputTokens, 10000);
    assert.equal(DEEPTHINK_AGENT_REGISTRY.memoryBank.maxOutputTokens, 10000);
});

test('just-bash AST classification identifies read-only inspection commands and rejects redirections or mutations', async () => {
    const { isReadOnlyBashCommand } = await import('../../Backend/sandboxToolBackend.ts');
    assert.equal(isReadOnlyBashCommand('ls -la && git status | grep main'), true);
    assert.equal(isReadOnlyBashCommand('cat README.md && rg "pattern" src/ && find . -name "*.ts"'), true);
    assert.equal(isReadOnlyBashCommand('rtk ls -la && rtk read foo.txt'), true);
    assert.equal(isReadOnlyBashCommand('cat foo.txt > bar.txt'), false);
    assert.equal(isReadOnlyBashCommand('ls -la >> out.log'), false);
    assert.equal(isReadOnlyBashCommand('find . -name "*.tmp" -delete'), false);
    assert.equal(isReadOnlyBashCommand('python3 script.py'), false);
    assert.equal(isReadOnlyBashCommand('git checkout -b test'), false);
});

test('@letta-ai/trajectory normalizes and validates .jsonl trajectories with structured role records', async () => {
    const {
        formatDirectCallTrajectoryJsonl,
        INCLUDE_REASONING_IN_TRAJECTORY_JSONL,
        sanitizeTrajectoryRecordsForJsonl,
    } = await import('./pipelineOrchestrator.ts');
    assert.equal(INCLUDE_REASONING_IN_TRAJECTORY_JSONL, false);
    const jsonl = formatDirectCallTrajectoryJsonl({
        systemInstruction: 'You are a Deepthink agent.',
        userPrompt: 'Solve the recurrence.',
        assistantResponse: 'The closed form is 2^n - 1.',
    });
    const records = jsonl.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.some(r => r.role === 'system'), false, 'system role must be omitted');
    assert.equal(records.some(r => r.role === 'user'), false, 'initial user prompt must be omitted');
    assert.equal(records[0].role, 'meta');
    assert.equal(records[0].source, 'letta-code');
    assert.equal(records[1].role, 'assistant');
    assert.equal(records[1].content, 'The closed form is 2^n - 1.');
    assert.equal('timestamp' in records[1], false, 'timestamp must be omitted');

    const withReasoning = sanitizeTrajectoryRecordsForJsonl(
        [
            { role: 'system', content: 'sys', timestamp: '2026-01-01T00:00:00Z' },
            { role: 'user', content: 'prompt', timestamp: '2026-01-01T00:00:01Z' },
            { role: 'reasoning', content: 'thinking step', timestamp: '2026-01-01T00:00:02Z' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'tc_1', name: 'sandbox_exec', args: '{"command":"ls"}' }], timestamp: '2026-01-01T00:00:03Z' },
            { role: 'tool', tool_call_id: 'tc_1', content: 'ok', ok: true, timestamp: '2026-01-01T00:00:04Z' },
        ],
        true
    );
    assert.equal(withReasoning[0].role, 'reasoning');
    assert.equal((withReasoning[1] as any).tool_calls[0].id, undefined);
    assert.equal((withReasoning[2] as any).tool_call_id, undefined);
    assert.equal((withReasoning[2] as any).timestamp, undefined);
});

test('continuous append-only sandbox trajectories across loop rounds for Strategy & Modules Generator/Reviewer', async () => {
    (globalThis as any).localStorage ??= {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
    };
    const { AIMessage, ToolMessage, SystemMessage } = await import('@langchain/core/messages');
    const { buildRawTrajectoryJsonl } = await import('../../Core/SandboxToolRuntime.ts');
    const { DeepthinkPipelineOrchestrator, extractJsonString } = await import('./pipelineOrchestrator.ts');

    const recordedCalls: Array<{
        agentName: string;
        sessionId: string;
        inputMessageCount: number;
        inputMessagesSnapshot: any[];
        hasFinalOutputContract: boolean;
    }> = [];

    let seedGenRound = 0;
    let seedProxRound = 0;
    let guGenRound = 0;
    let guProxRound = 0;
    let hbGenCall = 0;
    let hbProxCall = 0;

    const state: any = {
        id: 'test-continuous-traj-run',
        challenge: 'Prove the tight bound for packing 3 unit circles.',
        status: 'processing',
        runConfig: {
            strategiesCount: 2,
            strategyProximityLoops: 2, // 3 generator turns, 2 proximity turns
            modulesCount: 2,
            modulesImpactReviewLoops: 1, // 2 generator turns, 1 impact review turn per heartbeat
            i: 6,
            j: 3,
            k: 2,
            isolateBranches: false,
            deepthinkCodeExecutionEnabled: true,
            thinkingLevel: 'high',
            model: 'gemini-2.5-pro',
        },
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
    };

    const orchestrator = new DeepthinkPipelineOrchestrator(state, {
        callAI: async () => {
            throw new Error('Direct callAI should not be invoked when deepthinkCodeExecutionEnabled is true');
        },
        parseJsonStrict: <T>(raw: string): T => JSON.parse(extractJsonString(raw)) as T,
        retryDelaysMs: [1, 1, 1],
        runSandboxToolAgent: async (options) => {
            const messages = [...options.messages];
            recordedCalls.push({
                agentName: options.agentName,
                sessionId: options.sessionId || '',
                inputMessageCount: messages.length,
                inputMessagesSnapshot: [...messages],
                hasFinalOutputContract: Boolean(options.finalOutputContract),
            });

            // Simulate one sandbox_exec tool call + output in this round
            const execCallId = `exec_${options.agentName}_${recordedCalls.length}`;
            messages.push(new AIMessage({
                content: `Exploring sandbox for ${options.agentName} (call #${recordedCalls.length})`,
                tool_calls: [{ id: execCallId, name: 'sandbox_exec', args: { command: `python3 -c "print('${options.agentName}_${recordedCalls.length}')"` } }],
            }));
            messages.push(new ToolMessage({
                name: 'sandbox_exec',
                tool_call_id: execCallId,
                content: `Sandbox command completed.\n\nexit_code=0\n\nduration_ms=5\n\nstdout:\n${options.agentName}_${recordedCalls.length}`,
                status: 'success',
            }));

            let finalPayload = '';
            if (options.agentName === 'initialStrategy') {
                // Distinguish Seed vs Global Update by checking whether Seed is already done
                if (seedGenRound < 3) {
                    seedGenRound++;
                    // Verify contract validation catches an invalid payload first on Round 1
                    if (seedGenRound === 1 && options.finalOutputContract) {
                        assert.throws(
                            () => options.finalOutputContract!.validate({ strategies: ['only-one'] }),
                            /Expected at least 2 strategies/
                        );
                    }
                    finalPayload = JSON.stringify({
                        strategies: [
                            `Seed strategy main1 (round ${seedGenRound})`,
                            `Seed strategy main2 (round ${seedGenRound})`,
                        ],
                    });
                } else {
                    guGenRound++;
                    finalPayload = JSON.stringify({
                        evolved_slots: [{ slot_id: 'main2', updated_strategy_text: `GU evolved main2 (round ${guGenRound})` }],
                        pruned_slots: [],
                    });
                }
            } else if (options.agentName === 'strategyProximity') {
                if (seedProxRound < 2) {
                    seedProxRound++;
                    finalPayload = `Seed proximity review critique (round ${seedProxRound})`;
                } else {
                    guProxRound++;
                    finalPayload = `GU proximity review critique (round ${guProxRound})`;
                }
            } else if (options.agentName === 'modulesGeneration') {
                hbGenCall++;
                finalPayload = JSON.stringify({
                    modules: [
                        { module_id: 'm1', text: `Module 1 text (call ${hbGenCall})`, target_branches: ['main1'] },
                        { module_id: 'm2', text: `Module 2 text (call ${hbGenCall})`, target_branches: [] },
                    ],
                });
            } else if (options.agentName === 'modulesImpactReview') {
                hbProxCall++;
                finalPayload = `Modules impact review critique (call ${hbProxCall})`;
            } else if (options.agentName === 'modulesTester') {
                finalPayload = 'Tested module in sandbox.\n\nCLASSIFICATION: VALIDATED';
            } else if (options.agentName === 'solutionAttempt' || options.agentName === 'solutionCorrection') {
                finalPayload = '# Solution\nValid derivation.';
            } else if (options.agentName === 'solutionCritique') {
                finalPayload = '# Critique\nChecked derivation.';
            } else if (options.agentName === 'dos') {
                finalPayload = JSON.stringify({
                    core_synthesis: { summary: 'All branches progressing.' },
                    module_feedback: [
                        {
                            module_id: 'm1',
                            branch_utilization: [{ branch_id: 'main1', utilization: { classification: 'USED_CORRECTLY', reason: 'Applied' } }],
                            critique_counterevidence: [{ branch_id: 'main1', classification: 'NONE', reason: 'No counterevidence' }],
                        },
                    ],
                });
            } else if (options.agentName === 'bsr') {
                const firstUserText = String((messages[0] as any)?.content?.[0]?.text || (messages[0] as any)?.content || '');
                const isMain1 = firstUserText.includes('Branch ID: main1');
                finalPayload = JSON.stringify({
                    branch_id: isMain1 ? 'main1' : 'main2',
                    confirmed_progress: isMain1
                        ? [{ iteration: 2, size: 'large', reason: 'Breakthrough' }]
                        : [{ iteration: 2, size: 'large', reason: 'Initial' }],
                    confirmed_regression: isMain1
                        ? []
                        : [{ iteration: 3, size: 'large', reason: 'Regressed' }],
                    critique_alignment: { value: isMain1 ? 0.85 : 0.6, reason: 'Aligned' },
                });
            } else if (options.agentName === 'memoryBank') {
                finalPayload = '# Memory Bank\nDistilled invariants.';
            } else if (options.agentName === 'finalJudge') {
                finalPayload = JSON.stringify({
                    best_solution_id: 'main1',
                    final_reasoning: 'main1 is rigorous.',
                });
            }

            if (options.finalOutputContract) {
                options.finalOutputContract.validate(JSON.parse(finalPayload));
            }

            const finalCallId = `final_${options.agentName}_${recordedCalls.length}`;
            messages.push(new AIMessage({
                content: '',
                tool_calls: [{ id: finalCallId, name: 'final_output', args: { response: finalPayload } }],
            }));

            const rawTrajectoryJsonl = buildRawTrajectoryJsonl([
                new SystemMessage(options.systemPrompt),
                ...messages,
            ]);

            return {
                text: finalPayload,
                promptText: finalPayload,
                finalText: finalPayload,
                executionTrace: {} as any,
                executionTraceText: '{}',
                rawTrajectoryJsonl,
                loopMessages: messages,
                messages,
            };
        },
    });

    await orchestrator.run();
    assert.equal(state.status, 'completed');

    // 1. Verify Seed Strategy Generator calls (3 rounds in one continuous session/trajectory)
    const seedGenCalls = recordedCalls.filter(c => c.agentName === 'initialStrategy').slice(0, 3);
    assert.equal(seedGenCalls.length, 3);
    assert.equal(seedGenCalls[0].sessionId, seedGenCalls[1].sessionId, 'Seed Generator rounds 1 & 2 must share sessionId');
    assert.equal(seedGenCalls[1].sessionId, seedGenCalls[2].sessionId, 'Seed Generator rounds 2 & 3 must share sessionId');
    assert.equal(seedGenCalls[0].inputMessageCount, 1, 'Seed Generator round 1 starts with 1 HumanMessage');
    // Round 1 adds: AIMessage(sandbox_exec), ToolMessage(sandbox_exec), AIMessage(final_output), + ToolMessage(peer review 1) = +4 => 5 messages
    assert.equal(seedGenCalls[1].inputMessageCount, 5, 'Seed Generator round 2 continues trajectory with Round 1 tool calls + Reviewer 1 output in final_output ToolMessage');
    const round1PeerToolMsg = seedGenCalls[1].inputMessagesSnapshot[4];
    assert.ok(String(round1PeerToolMsg.content).includes('Seed proximity review critique (round 1)'), 'Round 2 must receive Reviewer Round 1 output as final_output ToolMessage');
    assert.ok(String(round1PeerToolMsg.content).includes('Immediate Role: Strategy Generator'), 'Round 2 final_output ToolMessage must restate Immediate Role: Strategy Generator');
    // Round 2 adds 4 more => 9 messages on Round 3 entry
    assert.equal(seedGenCalls[2].inputMessageCount, 9, 'Seed Generator round 3 continues trajectory with Rounds 1 & 2 + Reviewer 2 output');
    const round2PeerToolMsg = seedGenCalls[2].inputMessagesSnapshot[8];
    assert.ok(String(round2PeerToolMsg.content).includes('Seed proximity review critique (round 2)'), 'Round 3 must receive Reviewer Round 2 output as final_output ToolMessage');

    // 2. Verify Seed Strategy Proximity Reviewer calls (2 rounds in its own separate continuous session/trajectory)
    const seedProxCalls = recordedCalls.filter(c => c.agentName === 'strategyProximity').slice(0, 2);
    assert.equal(seedProxCalls.length, 2);
    assert.notEqual(seedProxCalls[0].sessionId, seedGenCalls[0].sessionId, 'Proximity Reviewer must have its own separate sessionId from Generator');
    assert.equal(seedProxCalls[0].sessionId, seedProxCalls[1].sessionId, 'Seed Proximity Reviewer rounds 1 & 2 must share sessionId');
    assert.equal(seedProxCalls[0].inputMessageCount, 1, 'Seed Proximity Reviewer round 1 starts with 1 HumanMessage (including Generator Round 1)');
    assert.equal(seedProxCalls[1].inputMessageCount, 5, 'Seed Proximity Reviewer round 2 continues trajectory with Round 1 tool calls + Generator Round 2 output in final_output ToolMessage');
    const proxRound1PeerToolMsg = seedProxCalls[1].inputMessagesSnapshot[4];
    assert.ok(String(proxRound1PeerToolMsg.content).includes('Seed strategy main1 (round 2)'), 'Proximity Round 2 must receive Generator Round 2 output as final_output ToolMessage');
    assert.ok(String(proxRound1PeerToolMsg.content).includes('Immediate Role: Strategy Proximity Reviewer'), 'Proximity Round 2 ToolMessage must restate Immediate Role: Strategy Proximity Reviewer');

    // 3. Verify Global Update Strategy Generator starts a FRESH trajectory (does NOT carry over from Seed!)
    const guGenCalls = recordedCalls.filter(c => c.agentName === 'initialStrategy').slice(3);
    assert.equal(guGenCalls.length, 3);
    assert.notEqual(guGenCalls[0].sessionId, seedGenCalls[0].sessionId, 'Global Update Generator must NOT carry over Seed sessionId');
    assert.equal(guGenCalls[0].inputMessageCount, 1, 'Global Update Generator round 1 must start a fresh trajectory with 1 HumanMessage');
    assert.equal(guGenCalls[1].inputMessageCount, 5, 'Global Update Generator round 2 continues Global Update trajectory');
    assert.equal(guGenCalls[2].inputMessageCount, 9, 'Global Update Generator round 3 continues Global Update trajectory');

    // 4. Verify Heartbeat 1 vs Heartbeat 2 Modules Generator each have continuous trajectory within the heartbeat, NOT across heartbeats
    const modGenCalls = recordedCalls.filter(c => c.agentName === 'modulesGeneration');
    assert.equal(modGenCalls.length, 4); // 2 rounds in HB1 (at iter 2), 2 rounds in HB2 (at iter 3 GU end)
    assert.equal(modGenCalls[0].sessionId, modGenCalls[1].sessionId, 'HB1 Modules Generator rounds 1 & 2 share sessionId');
    assert.equal(modGenCalls[0].inputMessageCount, 1);
    assert.equal(modGenCalls[1].inputMessageCount, 5, 'HB1 Modules Generator round 2 continues HB1 trajectory with Impact Reviewer output');
    assert.notEqual(modGenCalls[2].sessionId, modGenCalls[0].sessionId, 'HB2 Modules Generator starts a fresh sessionId');
    assert.equal(modGenCalls[2].inputMessageCount, 1, 'HB2 Modules Generator round 1 starts fresh');
    assert.equal(modGenCalls[3].inputMessageCount, 5, 'HB2 Modules Generator round 2 continues HB2 trajectory');

    // 5. Verify repository .md and .jsonl files contain the continuous multi-round trajectories
    const files = orchestrator.getGitHarness().getCommittedFiles();
    const seedGenJsonl = files.get('strategies_history/seed_strategies.jsonl')!;
    assert.ok(seedGenJsonl.includes('Seed proximity review critique (round 1)'), 'seed_strategies.jsonl must contain Reviewer Round 1 output inside the continuous trajectory');
    assert.ok(seedGenJsonl.includes('Seed proximity review critique (round 2)'), 'seed_strategies.jsonl must contain Reviewer Round 2 output inside the continuous trajectory');
    assert.ok(seedGenJsonl.includes('Seed strategy main1 (round 3)'), 'seed_strategies.jsonl must contain final Round 3 submission');

    const seedProxJsonl = files.get('strategies_history/seed_strategies_proximity_review.jsonl')!;
    assert.ok(seedProxJsonl.includes('Seed strategy main1 (round 2)'), 'seed_strategies_proximity_review.jsonl must contain Generator Round 2 output inside the continuous trajectory');
    assert.ok(seedProxJsonl.includes('Seed proximity review critique (round 2)'), 'seed_strategies_proximity_review.jsonl must contain Reviewer Round 2 submission');
});
