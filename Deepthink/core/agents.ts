/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Exported Deepthink Agents for reuse in other modes
 * These agents are independent API calls without conversation history
 */

import { Part } from "@google/genai";
import {
    describeProviderError,
    isTerminalInferenceError,
    isUserAbortError,
} from '../../Core/ProviderError';

// Agent response interface
interface AgentResponse {
    success: boolean;
    data?: any;
    error?: string;
    rawResponse?: string;
}

// Agent execution context
export interface AgentExecutionContext {
    callAI: (parts: Part[], modelToUse: string, systemInstruction?: string, isJson?: boolean) => Promise<any>;
    cleanOutputByType: (rawOutput: string, type?: string) => string;
    parseJsonSafe: (raw: string, context: string) => any;
    getSelectedModel: () => string;
    /**
     * Optional transport used by modes that run these shared roles inside the
     * Deepthink sandbox. Keeping the agent contracts here lets Adaptive
     * Deepthink reuse the exact same prompts/parsers without duplicating a
     * second set of agents.
     */
    runPrompt?: (args: {
        promptText: string;
        systemPrompt: string;
        isJson: boolean;
        images: ImageInput;
    }) => Promise<string>;
}

// ========== SHARED HELPERS ==========

type ImageInput = Array<{ base64: string; mimeType: string }>;

/** Builds prompt parts array: images (in order) followed by text. */
function buildPromptParts(text: string, images: ImageInput): Part[] {
    return [
        ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
        { text }
    ];
}

/** Appends optional special context XML block to a prompt string. */
function appendContext(prompt: string, specialContext: string): string {
    return specialContext
        ? `${prompt}\n\n<Special Context>\n${specialContext}\n</Special Context>`
        : prompt;
}

function buildStrategyPrompt(question: string, numStrategies: number): string {
    return `Core Challenge: ${question}

Generate exactly ${numStrategies} distinct high-level strategic interpretations. Return JSON with a "strategies" array. Do not solve the challenge.`;
}

function buildModulesGenerationPrompt(question: string, numModules: number, allowFewer = false): string {
    return `Core Challenge: ${question}

Generate ${allowFewer ? `up to ${numModules}` : `exactly ${numModules}`} modules worth testing. Return JSON with a "modules" array. Do not solve the challenge.`;
}

function buildModulesTestingPrompt(question: string, moduleText: string): string {
    return `Core Challenge: ${question}

<Module To Test>
${moduleText}
</Module To Test>

Test only this module. Return the full investigation and final classification.`;
}

function buildExecutionPrompt(question: string, strategy: string, informationPacket: string): string {
    return `Core Challenge: ${question}

<Assigned Strategy>
${strategy}
</Assigned Strategy>

<Information Packet>
${informationPacket}
</Information Packet>

Execute the assigned strategy faithfully and completely.`;
}

function buildCritiquePrompt(question: string, strategy: string, execution: string): string {
    return `Core Challenge: ${question}

<Assigned Strategy>
${strategy}
</Assigned Strategy>

<Solution Attempt>
${execution}
</Solution Attempt>

Critique the solution attempt. Identify errors, gaps, unjustified claims, and strategy-fidelity issues. Do not fix the solution.`;
}

function buildCorrectionPrompt(question: string, strategy: string, execution: string, critique: string, modulePacket?: string): string {
    return [
        `Core Challenge: ${question}`,
        `<Assigned Strategy>\n${strategy}\n</Assigned Strategy>`,
        modulePacket ? `<Modules>\n${modulePacket}\n</Modules>` : '',
        `<Previous Solution Attempt>\n${execution}\n</Previous Solution Attempt>`,
        `<Critique>\n${critique}\n</Critique>`,
        `Produce a corrected solution that addresses the critique while remaining faithful to the assigned strategy.`
    ].filter(Boolean).join('\n\n');
}

/** Executes a single AI call: builds parts, calls the model, cleans output. */
async function callAgent(
    promptText: string,
    images: ImageInput,
    context: AgentExecutionContext,
    systemPrompt: string,
    isJson: boolean
): Promise<string> {
    if (context.runPrompt) {
        return context.runPrompt({
            promptText,
            systemPrompt,
            isJson,
            images,
        });
    }

    const response = await context.callAI(
        buildPromptParts(promptText, images),
        context.getSelectedModel(),
        systemPrompt,
        isJson
    );
    return context.cleanOutputByType(response.text || '', isJson ? 'json' : undefined);
}

function buildProximityPrompt(
    kind: 'strategies' | 'modules',
    question: string,
    candidates: string[],
    conversationHistory: string
): string {
    const label = kind === 'strategies' ? 'Strategy' : 'Module';
    return `Core Challenge: ${question}

<Current ${label} Candidates>
${candidates.map((candidate, index) => `<${label} ${index + 1}>\n${candidate}\n</${label} ${index + 1}>`).join('\n\n')}
</Current ${label} Candidates>

<Generator Proximity History>
${conversationHistory || 'This is the first proximity review.'}
</Generator Proximity History>

Act as the ${kind === 'strategies' ? 'Strategies Proximity Agent' : 'Modules Impact Reviewer'}. Audit the candidate set for convergence, duplication, missing orthogonal domains, structural blind spots, untested assumptions, and local-minimum behavior. Be demanding and specific. Do not solve the core challenge and do not rewrite the candidates. Return a concise critique that a generator can use for its next revision.`;
}

/** Wraps an async agent body with standard error handling, while rethrowing terminal inference/silence/abort errors. */
async function wrapAgent(fn: () => Promise<AgentResponse>): Promise<AgentResponse> {
    try {
        return await fn();
    } catch (error) {
        if (isTerminalInferenceError(error) || isUserAbortError(error)) {
            throw error;
        }
        return { success: false, error: describeProviderError(error) };
    }
}

// ========== AGENT IMPLEMENTATIONS ==========

/**
 * Generate Strategies Agent
 * Generates N high-level strategic interpretations for a problem
 */
export async function generateStrategiesAgent(
    question: string,
    numStrategies: number,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const prompt = appendContext(buildStrategyPrompt(question, numStrategies), specialContext);
        const rawText = await callAgent(prompt, images, context, systemPrompt, true);
        const parsed = context.parseJsonSafe(rawText, 'GenerateStrategies');

        if (!parsed || !Array.isArray(parsed.strategies)) {
            return { success: false, error: 'Failed to parse strategies from response', rawResponse: rawText };
        }
        return { success: true, data: { strategies: parsed.strategies }, rawResponse: rawText };
    });
}

/**
 * Generate Modules Agent
 * Generates N modules for testing
 */
export async function generateModulesAgent(
    question: string,
    numModules: number,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = [],
    allowFewer = false
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const prompt = appendContext(buildModulesGenerationPrompt(question, numModules, allowFewer), specialContext);
        const rawText = await callAgent(prompt, images, context, systemPrompt, true);
        const parsed = context.parseJsonSafe(rawText, 'GenerateModules');

        if (!parsed || !Array.isArray(parsed.modules)) {
            return { success: false, error: 'Failed to parse modules from response', rawResponse: rawText };
        }
        return { success: true, data: { modules: parsed.modules }, rawResponse: rawText };
    });
}

/**
 * Independent adversarial proximity review for a strategy batch. The
 * generator owns revisions; this role only diagnoses weak diversity and
 * structural coverage so the two cannot silently agree with themselves.
 */
export async function strategiesProximityAgent(
    question: string,
    strategies: string[],
    conversationHistory: string,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const prompt = appendContext(
            buildProximityPrompt('strategies', question, strategies, conversationHistory),
            specialContext
        );
        const review = await callAgent(prompt, images, context, systemPrompt, false);
        return { success: true, data: { review }, rawResponse: review };
    });
}

/** See strategiesProximityAgent; modules use the same independent review contract. */
export async function modulesImpactReviewAgent(
    question: string,
    modules: string[],
    conversationHistory: string,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const prompt = appendContext(
            buildProximityPrompt('modules', question, modules, conversationHistory),
            specialContext
        );
        const review = await callAgent(prompt, images, context, systemPrompt, false);
        return { success: true, data: { review }, rawResponse: review };
    });
}

/**
 * Test Modules Agent
 * Tests multiple modules in parallel
 */
export async function testModulesAgent(
    question: string,
    moduleIds: string[],
    modulesData: Map<string, { text: string }>,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const results = await Promise.all(
            moduleIds.map(async (id) => {
                const mod = modulesData.get(id);
                if (!mod) return { id, success: false, error: 'Module not found' };

                const prompt = appendContext(buildModulesTestingPrompt(question, mod.text), specialContext);
                const testing = await callAgent(prompt, images, context, systemPrompt, false);
                return { id, success: true, module: mod.text, testing };
            })
        );
        return { success: true, data: { results } };
    });
}

/**
 * Execute Strategies Agent
 * Executes multiple strategies in parallel with selected module testing results
 */
export async function executeStrategiesAgent(
    question: string,
    strategyExecutions: Array<{ strategyId: string; moduleIds: string[] }>,
    strategiesData: Map<string, { text: string }>,
    moduleTestingResults: Map<string, { module: string; testing: string }>,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const results = await Promise.all(
            strategyExecutions.map(async (exec) => {
                const strategy = strategiesData.get(exec.strategyId);
                if (!strategy) return { id: exec.strategyId, success: false, error: 'Strategy not found' };

                const informationPacket = buildInformationPacket(exec.moduleIds, moduleTestingResults);
                const prompt = appendContext(buildExecutionPrompt(question, strategy.text, informationPacket), specialContext);
                const execution = await callAgent(prompt, images, context, systemPrompt, false);
                return { id: exec.strategyId, success: true, strategy: strategy.text, execution };
            })
        );
        return { success: true, data: { results } };
    });
}

/** Builds the XML information packet from module testing results. */
function buildInformationPacket(
    moduleIds: string[],
    results: Map<string, { module: string; testing: string }>
): string {
    const entries = moduleIds
        .map((id, idx) => {
            const r = results.get(id);
            return r
                ? `<Module ${idx + 1}>\nModule: ${r.module}\nModule Testing: ${r.testing}\n</Module ${idx + 1}>\n`
                : '';
        })
        .filter(Boolean)
        .join('\n');
    return `<Full Information Packet>\n${entries}</Full Information Packet>`;
}

/**
 * Solution Critique Agent
 * Critiques multiple executed solutions in parallel
 */
export async function solutionCritiqueAgent(
    question: string,
    executionIds: string[],
    executionsData: Map<string, { strategy: string; execution: string }>,
    specialContext: string,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const results = await Promise.all(
            executionIds.map(async (id) => {
                const execution = executionsData.get(id);
                if (!execution) return { id, success: false, error: 'Execution not found' };

                const prompt = appendContext(buildCritiquePrompt(question, execution.strategy, execution.execution), specialContext);
                const critique = await callAgent(prompt, images, context, systemPrompt, false);
                return { id, success: true, critique };
            })
        );
        return { success: true, data: { results } };
    });
}

/**
 * Corrected Solutions Agent
 * Generates corrected solutions based on critiques
 */
export async function correctedSolutionsAgent(
    question: string,
    executionIds: string[],
    executionsData: Map<string, { strategy: string; execution: string }>,
    critiquesData: Map<string, { critique: string; modulePacket?: string }>,
    systemPrompt: string,
    context: AgentExecutionContext,
    images: ImageInput = []
): Promise<AgentResponse> {
    return wrapAgent(async () => {
        const results = await Promise.all(
            executionIds.map(async (id) => {
                const execution = executionsData.get(id);
                const critique = critiquesData.get(id);
                if (!execution || !critique) return { id, success: false, error: 'Execution or critique not found' };

                const prompt = buildCorrectionPrompt(question, execution.strategy, execution.execution, critique.critique, critique.modulePacket);
                const correctedSolution = await callAgent(prompt, images, context, systemPrompt, false);
                return { id, success: true, correctedSolution };
            })
        );
        return { success: true, data: { results } };
    });
}
