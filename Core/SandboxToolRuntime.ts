/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from '@langchain/core/language_models/base';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DEFAULT_NORMALIZATION_BOUNDS, normalizeTranscript, validateTranscript } from '@letta-ai/trajectory';
import { parse as parseBashAst } from 'just-bash';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { globalState } from './State';
import {
    invokeToolCallingAgentTurn,
    messageContentToText,
    resolveProviderForModel,
    type ResolvedProvider
} from './LangGraphToolRuntime';
import {
    SHARED_WORKSPACE_TOOL_NAME,
    SHARED_WORKSPACE_MAX_TOKENS,
    SharedWorkspaceTokenLimitError,
    countTextTokens,
    sharedWorkspaceToolDefinition,
    sharedWorkspaceToolSchema,
    type SharedWorkspaceToolInput,
} from '../Deepthink/core/sharedWorkspace';
import {
    buildFinalOutputTokenGateHarnessNote,
    buildOvertimeFinalSubmitHarnessNote,
    buildRemainingSandboxTimeHarnessNote,
    buildRemainingToolCallsHarnessNote,
    buildRevokedToolsFinalSubmitHarnessNote,
    buildSandboxTimeExpiredFinalSubmitHarnessNote,
    buildSharedWorkspaceTokenGateHarnessNote,
} from '../Deepthink/core/harnessNotes';

export {
    SHARED_WORKSPACE_TOOL_NAME,
    SHARED_WORKSPACE_MAX_TOKENS,
    SharedWorkspaceTokenLimitError,
    sharedWorkspaceToolDefinition,
    sharedWorkspaceToolSchema,
    type SharedWorkspaceToolInput,
};

interface SandboxToolAgentOptions {
    agentName: string;
    sessionId?: string;
    messages: BaseMessage[];
    systemPrompt: string;
    modelName: string;
    seedFiles?: SeedFile[];
    filesystemFiles?: SeedFile[];
    omitUploadedFileMessage?: boolean;
    runScopeDescription?: string;
    agentFilesystemRules?: string[];
    repositoryAccess?: SandboxRepositoryAccess;
    /**
     * Maximum tool-call turns (m) before overtime grace window and tool revocation.
     * Defaults to MAX_TOOL_TURNS (64).
     */
    maxToolTurns?: number;
    /**
     * Maximum wall-clock duration in milliseconds before revoking tools and forcing final_output.
     * Defaults to MAX_SANDBOX_DURATION_MS (60 minutes).
     */
    maxDurationMs?: number;
    /**
     * Maximum allowed output tokens in final_output submission.
     * Defaults to 5000 (10000 for Solution Correction and Memory Bank).
     */
    maxOutputTokens?: number;
    /**
     * Optional role-specific contract for a structured final_output payload.
     * The sandbox loop validates this while the model is still in its tool
     * conversation, so an invalid payload becomes a recoverable tool error
     * rather than discarding the agent's completed sandbox work.
     */
    finalOutputContract?: SandboxFinalOutputContract;
    /**
     * Optional handler for real-time shared_workspace tool calls (§8.4).
     */
    sharedWorkspaceHandler?: (input: SharedWorkspaceToolInput) => Promise<string>;
    abortSignal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    silenceTimeoutMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

type ContextualSandboxToolAgentOptions = SandboxToolAgentOptions;

export interface SandboxRepositoryAccess {
    repositoryId: string;
    /**
     * The only repository directory this agent may write. Omit this for a
     * completely read-only repository view; agents still have private /tmp
     * scratch space for research and temporary files.
     */
    agentDirectory?: string;
    agentDirectoryReadOnly?: boolean;
    readableDirectories?: string[];
    /** Readable directories that intentionally follow the live writable branch. */
    liveReadableDirectories?: string[];
    /**
     * Descendant repository directories removed from otherwise readable parent
     * mounts. This preserves branch-local permissions when a child directory
     * belongs to a different role (for example Strategy-N/Critique).
     */
    hiddenDirectories?: string[];
    /** Mount the complete repository read-only instead of selected peers. */
    fullRepositoryRead?: boolean;
    /** Reserved for the Adaptive Deepthink orchestrator's global workspace. */
    fullRepositoryWrite?: boolean;
    /** Git commit used as the immutable baseline for read-only mounts. */
    revision?: string;
}

export interface SandboxFinalOutputContract {
    /** Human-readable role/mode name used in tool descriptions and errors. */
    name: string;
    /** Optional JSON Schema used for final_output.response when this role is structured. */
    responseSchema?: Record<string, unknown>;
    /**
     * Validate the parsed JSON payload. Throw an Error with a correction
     * message when the payload does not match the role's accepted scheme.
     */
    validate: (payload: unknown) => void;
}

export async function snapshotSandboxRepositoryById(repositoryId: string, commitMessage: string): Promise<string> {
    const response = await fetch(`${getSandboxApiBasePath()}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId, commitMessage }),
    });
    if (!response.ok) throw new Error(`Sandbox snapshot failed (${response.status}).`);
    const payload = await response.json().catch(() => ({}));
    if (typeof payload?.commit !== 'string' || !payload.commit) {
        throw new Error('Sandbox snapshot did not return a repository revision.');
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deepthinkResultsSnapshot', {
            detail: { repositoryId, commit: payload.commit },
        }));
    }
    return payload.commit;
}

/** Restore only one strategy branch to a pre-correction repository checkpoint. */
export async function restoreSandboxRepositoryStrategy(
    repositoryId: string,
    strategyDirectory: string,
    commit: string
): Promise<void> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/restore-strategy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId, strategyDirectory, commit }),
    });
    if (!response.ok) {
        let message = `Sandbox strategy restore failed (${response.status}).`;
        try {
            const payload = await response.json();
            message = payload?.error || message;
        } catch {
            // Keep the useful HTTP-level error when the response is not JSON.
        }
        throw new Error(message);
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deepthinkResultsSnapshot', {
            detail: { repositoryId },
        }));
    }
}

/** A file rendered from orchestration state into the durable Deepthink Results
 * repository. These files never enter the permission-scoped agent cache. */
export interface DeepthinkResultsContextFile {
    path: string;
    content: string;
}

/**
 * Persist a pruned full-repository mirror under Results/deepthink_timestamp
 * and commit it as one atomic Deepthink iteration. The backend owns the
 * filesystem copy so agents retain their existing cache and permissions.
 */
export async function snapshotDeepthinkResultsRepository(
    repositoryId: string,
    commitMessage: string,
    contextFiles: DeepthinkResultsContextFile[]
): Promise<void> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/results-snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId, commitMessage, contextFiles }),
    });
    if (!response.ok) {
        let message = `Deepthink Results snapshot failed (${response.status}).`;
        try {
            const payload = await response.json();
            message = payload?.error || message;
        } catch {
            // Keep the useful HTTP-level error when the response is not JSON.
        }
        throw new Error(message);
    }
    // The Results explorer is a projection of this repository, so refresh it
    // precisely when a new Git snapshot lands—never on a polling timer.
    window.dispatchEvent(new CustomEvent('deepthinkResultsSnapshot', {
        detail: { repositoryId },
    }));
}

/** Pre-create the durable Results Git repository at the start of a sandboxed
 * Deepthink run. This does not seed or expose any agent workspace files. */
export async function ensureDeepthinkResultsRepository(repositoryId: string): Promise<{ resultPath?: string }> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/ensure-deepthink`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId }),
    });
    if (!response.ok) throw new Error(`Could not initialize Deepthink Results (${response.status}).`);
    try {
        const payload = await response.json();
        return { resultPath: payload?.resultPath };
    } catch {
        return {};
    }
}

/**
 * Persist or replace the single latest.gz export in the run's Results repository.
 */
export async function saveSandboxLatestGz(
    repositoryId: string,
    state: unknown
): Promise<{ ok: boolean; path?: string }> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/save-latest-gz`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId, state }),
    });
    if (!response.ok) {
        let msg = `Failed to save latest.gz (${response.status})`;
        try {
            const err = await response.json();
            msg = err?.error || msg;
        } catch { }
        throw new Error(msg);
    }
    return await response.json();
}

/**
 * Open the host Results repository directory in the user's OS file manager.
 */
export async function openSandboxRepositoryDirectory(
    repositoryId?: string
): Promise<{ ok: boolean; path?: string }> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/open-directory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(repositoryId ? { repositoryId } : {}),
    });
    if (!response.ok) {
        let msg = `Failed to open directory (${response.status})`;
        try {
            const err = await response.json();
            msg = err?.error || msg;
        } catch { }
        throw new Error(msg);
    }
    return await response.json();
}

/**
 * Open the host /Results directory in the user's OS file manager.
 */
export async function openResultsDirectory(): Promise<{ ok: boolean; path?: string }> {
    return openSandboxRepositoryDirectory();
}

interface SandboxArchivedStrategy {
    archivedDirectory?: string;
    activeDirectory: string;
}

/**
 * Archive one active Deepthink strategy directory before a PRUNE replacement.
 * The backend performs this repository mutation atomically so a new branch can
 * safely reuse the stable Strategy-N directory name.
 */
export async function archiveSandboxRepositoryStrategy(
    repositoryId: string,
    strategyDirectory: string
): Promise<SandboxArchivedStrategy> {
    const response = await fetch(`${getSandboxApiBasePath()}/repository/archive-strategy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId, strategyDirectory }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Failed to archive the replaced strategy repository directory.');
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deepthinkResultsSnapshot', {
            detail: { repositoryId },
        }));
    }
    return payload as SandboxArchivedStrategy;
}

interface SandboxInlineOutputReference {
    path: string;
    kind?: 'file' | 'image';
    label?: string;
}

interface SandboxToolAgentResult {
    text: string;
    promptText: string;
    finalText: string;
    executionTrace?: SandboxToolExecutionTrace;
    executionTraceText?: string;
    /** Full uncleaned trajectory of the invoke in .jsonl format (one JSON object per line). */
    rawTrajectoryJsonl?: string;
    geminiContent?: {
        parts: any[];
    };
    /** Raw BaseMessage[] from this private tool loop. This is kept only for
     *  diagnostics/trace export; downstream agent histories must use promptText. */
    loopMessages?: BaseMessage[];
    /** Full conversation messages up through the accepted final_output call,
     *  used when continuing the same agent's trajectory across loop rounds. */
    messages?: BaseMessage[];
}

type ContextualSandboxToolAgentResult = SandboxToolAgentResult;

export interface SandboxToolExecutionTrace {
    schema: 'sandbox_tool_execution_trace.v1';
    sandbox_tool_name: typeof SANDBOX_TOOL_NAME;
    agent: {
        name: string;
        provider: ResolvedProvider['providerName'];
        model: string;
        session_id: string;
    };
    final_text: string;
    messages: SandboxToolExecutionTraceMessage[];
}

export interface SandboxToolExecutionTraceMessage {
    role: 'assistant' | 'tool' | 'user' | 'system' | 'unknown';
    message_type: string;
    content: unknown;
    tool_calls?: unknown;
    invalid_tool_calls?: unknown;
    tool_call_id?: string;
    name?: string;
    status?: string;
    additional_kwargs?: unknown;
    response_metadata?: unknown;
    id?: string;
    images?: Array<{
        filename: string;
        mimeType: string;
        url: string;
    }>;
}

export interface SeedFile {
    name: string;
    mimeType: string;
    base64: string;
    /** Relative sandbox location, used for virtual filesystem context. */
    relativePath?: string;
}

interface SandboxToolImage {
    filename: string;
    mimeType: string;
    base64?: string;
    url: string;
    size: number;
}

interface SandboxToolResponse {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string | null;
    durationMs: number;
    timedOut?: boolean;
    readOnlyCommand?: boolean;
    images?: SandboxToolImage[];
    visibleFiles?: SandboxToolImage[];
}

interface SandboxEnvironmentProfile {
    ok?: boolean;
    agentSummary?: string;
    setupErrors?: string[];
}

const sandboxToolSchema = z.object({
    command: z.string().trim().min(1),
    timeout_ms: z.number().int().positive().max(300_000).optional()
});

const finalOutputToolSchema = z.object({
    response: z.unknown()
}).strict();

const SANDBOX_TOOL_NAME = 'sandbox_exec';
const FINAL_OUTPUT_TOOL_NAME = 'final_output';
const MAX_TOOL_TURNS = 64;
const OVERTIME_GRACE_TURNS = 5;
const FORCED_FINAL_OUTPUT_TURNS = 5;
const MAX_SANDBOX_DURATION_MS = 60 * 60_000; // 1 hour wall-clock budget
const SANDBOX_WARNING_10_MIN_MS = 10 * 60_000;
const SANDBOX_WARNING_5_MIN_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 5000;
const OMIT_TRACE_VALUE = Symbol('omitTraceValue');
const REDACTED_THOUGHT_TRACE = '[thought content omitted from shared execution trace]';
let sandboxEnvironmentProfilePromise: Promise<SandboxEnvironmentProfile | null> | null = null;

const READ_ONLY_BASH_COMMANDS = new Set([
    'ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'head', 'tail',
    'wc', 'stat', 'file', 'tree', 'pwd', 'which', 'type', 'realpath', 'dirname', 'basename', 'du', 'df',
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree',
]);
const FILE_WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const MUTATING_FIND_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls']);

function extractBashWordText(word: any): string {
    if (!word || !Array.isArray(word.parts)) return '';
    return word.parts
        .map((part: any) => (part.type === 'Literal' || part.type === 'SingleQuoted') ? String(part.value ?? '') : '')
        .join('');
}

function isReadOnlySimpleCommandWords(words: string[]): boolean {
    const tokens = words.filter(Boolean);
    if (tokens.length === 0) return false;
    const [first, ...rest] = tokens[0] === 'rtk' ? tokens.slice(1) : tokens;
    if (!first) return false;
    if (first === 'read' && tokens[0] === 'rtk') return true;
    if (first === 'find') {
        return !rest.some(arg => MUTATING_FIND_FLAGS.has(arg));
    }
    if (READ_ONLY_BASH_COMMANDS.has(first)) return true;
    if (first === 'git') {
        const subcommand = rest.find(arg => !arg.startsWith('-'));
        return !!subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
    }
    return false;
}

/**
 * Parses a shell command string into a Bash AST using `just-bash` and returns
 * true when the AST contains no file-write redirections (`>`, `>>`, etc.) and
 * every command node sits in the read-only inspection allowlist.
 */
export function isReadOnlyBashCommand(command: string): boolean {
    try {
        const ast = parseBashAst(command);
        let sawCommand = false;
        const checkCommand = (cmd: any): boolean => {
            if ((cmd.redirections || []).some((r: any) => FILE_WRITE_REDIRECT_OPERATORS.has(r.operator))) {
                return false;
            }
            if (cmd.type === 'SimpleCommand') {
                sawCommand = true;
                const words = [extractBashWordText(cmd.name), ...(cmd.args || []).map(extractBashWordText)];
                if (!isReadOnlySimpleCommandWords(words)) return false;
                return ![cmd.name, ...(cmd.args || [])].filter(Boolean).some((w: any) =>
                    Array.isArray(w.parts) && w.parts.some((p: any) => p.type === 'CommandSubstitution' || p.type === 'ProcessSubstitution')
                );
            }
            if (cmd.type === 'Subshell' || cmd.type === 'Group') {
                return Array.isArray(cmd.body) && cmd.body.every(checkStatement);
            }
            return false;
        };
        const checkStatement = (stmt: any): boolean =>
            Array.isArray(stmt.pipelines) && stmt.pipelines.every((p: any) => Array.isArray(p.commands) && p.commands.every(checkCommand));
        return Array.isArray(ast.statements) && ast.statements.every(checkStatement) && sawCommand;
    } catch {
        return false;
    }
}

const sandboxToolDefinition: ToolDefinition = {
    type: 'function',
    function: {
        name: SANDBOX_TOOL_NAME,
        description: [
            'Execute non-interactive bash commands inside the agent sandbox workspace.',
            'Use this like a real sandboxed terminal: create/read/search/edit/delete files, write and run scripts or programs, install workspace-local dependencies, run tests, use available CLI tools, and generate artifacts.',
            'You can execute multiple commands in three ways: (1) sequentially in a single sandbox_exec() call using `&&` (stop on first error, e.g. `mkdir -p build && pytest -q`) or `;` (continue regardless of exit code) or multi-line scripts; (2) concurrently in parallel within a single sandbox_exec() call by backgrounding jobs with `&` and synchronizing with `wait` (e.g. `python3 job1.py > job1.log 2>&1 & python3 job2.py > job2.log 2>&1 & wait`); or (3) by emitting multiple sandbox_exec() tool calls in a single turn, which the harness executes concurrently in parallel.',
            'Files persist in the workspace across this agent session.',
            `When the work is complete, submit the answer with ${FINAL_OUTPUT_TOOL_NAME}.`
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'Bash command string to run from the sandbox workspace. Supports single commands, sequential chains (`cmd1 && cmd2` or `cmd1; cmd2`), and parallel concurrent jobs (`cmd1 & cmd2 & wait`) in a single call. Use relative paths or /workspace paths for persistent files.'
                },
                timeout_ms: {
                    type: 'number',
                    description: 'Optional command timeout in milliseconds, maximum 300000.'
                }
            },
            required: ['command'],
            additionalProperties: false
        }
    }
};

function createFinalOutputToolDefinition(contract?: SandboxFinalOutputContract): ToolDefinition {
    const structuredResponse = !!contract?.responseSchema;
    return {
        type: 'function',
        function: {
            name: FINAL_OUTPUT_TOOL_NAME,
            description: [
                'Submit the final answer or artifact for this agent call.',
                'Use this after sandbox exploration is complete. If the environment returns a validation error, correct the payload and submit it again in the same tool conversation.',
                structuredResponse
                    ? `For ${contract!.name}, response must be the role-specific JSON object described by its schema. The environment validates it and returns a tool error for correction if it is invalid.`
                    : 'The response field is the only answer that downstream agents receive.'
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    response: structuredResponse
                        ? contract!.responseSchema!
                        : {
                            type: 'string',
                            description: 'The complete final answer, solution, critique, test result, or role-specific output to submit to the multi-agent system.'
                        }
                },
                required: ['response'],
                additionalProperties: false
            }
        }
    };
}

function isImageUpload(file: { mimeType?: string }): boolean {
    return typeof file.mimeType === 'string' && file.mimeType.startsWith('image/');
}

function extensionForMimeType(mimeType: string): string {
    switch (mimeType) {
        case 'image/jpeg':
            return '.jpg';
        case 'image/gif':
            return '.gif';
        case 'image/webp':
            return '.webp';
        case 'image/bmp':
            return '.bmp';
        case 'image/tiff':
            return '.tiff';
        case 'text/plain':
            return '.txt';
        case 'text/csv':
            return '.csv';
        case 'application/json':
            return '.json';
        case 'application/pdf':
            return '.pdf';
        case 'image/png':
        default:
            return mimeType.startsWith('image/') ? '.png' : '.bin';
    }
}

function getDefaultSeedFiles(): SeedFile[] {
    return globalState.directContextFiles
        .map((file, index) => {
            const fileWithName = file as typeof file & { name?: string };
            const fallbackName = `uploaded-file-${index + 1}${extensionForMimeType(file.mimeType)}`;
            return {
                name: fileWithName.name || fallbackName,
                mimeType: file.mimeType,
                base64: file.base64
            };
        });
}

function getDirectContextSandboxFiles(seedFiles: SeedFile[]): SeedFile[] {
    return seedFiles.map((file, index) => {
        const fallbackName = `direct-context-file-${index + 1}${extensionForMimeType(file.mimeType)}`;
        const name = (file.name || fallbackName).replace(/[\\/]+/g, '_');
        return {
            ...file,
            name,
            relativePath: `user_uploaded/${name}`,
        };
    });
}

function getDefaultFilesystemFiles(): SeedFile[] {
    return globalState.filesystemContextFiles.map((file, index) => {
        const fallbackName = `uploaded-file-${index + 1}${extensionForMimeType(file.mimeType)}`;
        const name = (file.name || fallbackName).replace(/[\\/]+/g, '_');
        return {
            name,
            mimeType: file.mimeType,
            base64: file.base64,
            relativePath: `user_uploaded/${name}`,
        };
    });
}

function getProviderImageContent(
    providerName: ResolvedProvider['providerName'],
    text: string,
    files: Array<{ mimeType: string; base64: string }>
): any[] {
    const validFiles = files.filter(f => typeof f.base64 === 'string' && f.base64.trim().length > 0);
    const images = validFiles.filter(isImageUpload);
    if (providerName === 'anthropic') {
        return [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map(image => ({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.base64
                }
            }))
        ];
    }

    if (providerName === 'gemini') {
        return [
            ...(text ? [{ text }] : []),
            // Gemini accepts inline binary parts for its supported document,
            // image, audio, and video inputs, so preserve direct uploads as
            // native inputs instead of turning them into rough text estimates.
            ...validFiles.map(file => ({
                inlineData: {
                    mimeType: file.mimeType,
                    data: file.base64
                }
            }))
        ];
    }

    return [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map(image => ({
            type: 'image_url',
            image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`
            }
        }))
    ];
}

function createImageMessage(
    providerName: ResolvedProvider['providerName'],
    text: string,
    files: Array<{ mimeType: string; base64: string }>
): HumanMessage {
    return new HumanMessage({
        content: getProviderImageContent(providerName, text, files)
    });
}

function buildUploadedFileMessage(providerName: ResolvedProvider['providerName'], files: SeedFile[]): HumanMessage | null {
    const images = files.filter(isImageUpload);
    const textFiles = files.filter(file => file.mimeType.startsWith('text/') || file.mimeType === 'application/json');
    const nativeFiles = images;
    if (nativeFiles.length === 0 && textFiles.length === 0) return null;

    const decodeTextFile = (file: SeedFile) => {
        try {
            const binary = atob(file.base64);
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            return '[Unable to decode uploaded text file]';
        }
    };

    const text = [
        'The following files are supplied directly with the Core Challenge:',
        ...files.map(file => `- ${file.name} (${file.mimeType})`),
        ...textFiles.flatMap(file => ['', `--- ${file.name} ---`, decodeTextFile(file), `--- end ${file.name} ---`]),
        '',
        nativeFiles.length ? 'Supported uploaded files are attached to this message as native inputs.' : ''
    ].join('\n');

    return createImageMessage(providerName, text, nativeFiles);
}

function buildGeneratedImageMessage(providerName: ResolvedProvider['providerName'], images: SandboxToolImage[]): HumanMessage | null {
    const attachable = images.filter(image => !!image.base64);
    if (attachable.length === 0) return null;

    return createImageMessage(providerName, '', attachable.map(image => ({
        mimeType: image.mimeType,
        base64: image.base64!
    })));
}

function buildGeminiHistoryContent(displayText: string, images: SandboxToolImage[]): { parts: any[] } | undefined {
    const attachable = images.filter(image => !!image.base64);
    if (attachable.length === 0) return undefined;

    return {
        parts: [
            { text: displayText },
            ...attachable.map(image => ({
                inlineData: {
                    mimeType: image.mimeType,
                    data: image.base64!
                }
            }))
        ]
    };
}

function buildEnvironmentProfileText(environmentProfile: SandboxEnvironmentProfile | null): string {
    if (!environmentProfile?.agentSummary?.trim()) {
        return [
            '- Environment profile unavailable. Probe capabilities with command -v, --version, python -m pip list, npm list, or similar checks when a tool/runtime matters.',
        ].join('\n');
    }

    const lines = [environmentProfile.agentSummary.trim()];
    if (environmentProfile.setupErrors?.length) {
        lines.push(`- Setup notes: ${environmentProfile.setupErrors.join(' | ')}`);
    }
    return lines.join('\n');
}

function buildRepositoryFilesystemRules(access: SandboxRepositoryAccess): string[] {
    const readableDirectories = Array.from(new Set(access.readableDirectories || []))
        .filter(directory => directory && directory !== access.agentDirectory);
    const writableDirectory = access.agentDirectoryReadOnly ? undefined : access.agentDirectory;
    const fullRepositoryWrite = access.fullRepositoryWrite === true;
    const readableScope = fullRepositoryWrite
        ? '- You may read and write the complete repository. This is the orchestrator-only global workspace.'
        : access.fullRepositoryRead
            ? '- You may read every directory and file in this repository. The complete repository is mounted read-only except for your explicitly assigned writable directory, if any.'
            : readableDirectories.length
                ? `- You may read these peer directories, mounted read-only: ${readableDirectories.map(directory => `/workspace/${directory}`).join(', ')}.`
                : '- No peer agent directories are visible for this call.';
    const hiddenScope = (access.hiddenDirectories || []).length
        ? `- The following role-owned child directories are intentionally hidden: ${(access.hiddenDirectories || []).map(directory => `/workspace/${directory}`).join(', ')}.`
        : '';

    return [
        fullRepositoryWrite
            ? '- This run uses one shared repository mounted read/write at /workspace.'
            : writableDirectory
                ? `- This run uses a shared repository mounted at /workspace. Your writable working directory is /workspace/${writableDirectory}, and you also have full read/write access to the shared workspace-root /workspace/tmp (also mounted at /tmp).`
                : `- This run uses a shared repository mounted read-only at /workspace${access.agentDirectory ? ` (starting in /workspace/${access.agentDirectory})` : ''}, with full read/write access to the shared workspace-root /workspace/tmp (also mounted at /tmp).`,
        fullRepositoryWrite
            ? '- Every sandbox command starts in the repository root.'
            : writableDirectory
                ? '- Every sandbox command starts inside your writable directory.'
                : `- Every sandbox command starts in the read-only ${access.agentDirectory ? `/workspace/${access.agentDirectory} directory` : 'repository root'}. Use /workspace/tmp (or /tmp) for temporary scripts, shared verification harnesses, caches, or experimental files.`,
        fullRepositoryWrite
            ? '- /workspace is writable for this orchestrator session; preserve strategy branch boundaries.'
            : '- /workspace itself is read-only except for your assigned writable directory (if any) and the shared /workspace/tmp (/tmp) directory.',
        fullRepositoryWrite
            ? '- You may create, modify, and delete repository files anywhere under /workspace.'
            : writableDirectory
                ? `- You may create, modify, and delete repository files under /workspace/${writableDirectory} and in the shared untracked /workspace/tmp (/tmp) directory.`
                : '- You may create, modify, and delete files in the shared untracked /workspace/tmp (/tmp) directory, which is accessible to all agents for verification harnesses and scratch work.',
        '- All direct-context files and additional filesystem uploads are mounted read-only at /workspace/user_uploaded.',
        readableScope,
        hiddenScope,
        fullRepositoryWrite
            ? '- Changes are shared repository state. Do not overwrite branch artifacts unless the orchestration decision explicitly requires it.'
            : access.fullRepositoryRead
                ? '- Repository files outside your writable directory and /workspace/tmp are mounted read-only. Treat them as shared evidence.'
                : '- Directories other than the locations listed above are not mounted into your sandbox view. Treat absent directories as unavailable context, not as empty evidence.',
        fullRepositoryWrite
            ? '- Keep strategy-local artifacts in their Strategy-N directory whenever possible.'
            : writableDirectory
                ? '- If you need to modify a readable peer file, copy it into your own writable directory or /workspace/tmp first and edit the copy.'
                : '- If you need to experiment with a readable file or build a shared verification loop, use /workspace/tmp (/tmp) and keep tracked repository directories unchanged.',
    ];
}

function buildSystemPrompt(
    systemPrompt: string,
    directFiles: SeedFile[],
    filesystemFiles: SeedFile[],
    options: SandboxToolAgentOptions,
    environmentProfile: SandboxEnvironmentProfile | null
): string {
    const directFileText = directFiles.length > 0
        ? directFiles.map(file => `- /workspace/user_uploaded/${file.name} (${file.mimeType})`).join('\n')
        : 'No direct-context files were uploaded.';
    const filesystemFileText = filesystemFiles.length > 0
        ? filesystemFiles.map(file => `- /workspace/${file.relativePath || file.name} (${file.mimeType})`).join('\n')
        : 'No additional filesystem files were uploaded.';
    const runScopeDescription = options.runScopeDescription || 'same contextual run';
    const agentFilesystemRules = options.agentFilesystemRules || [
        '- Main Generator keeps its own sandbox workspace across iterations.',
        '- Solution Critique / Iterative Agent keeps its own sandbox workspace across iterations.',
        '- Strategic Pool Agent keeps its own sandbox workspace across iterations.',
        '- Memory Agent keeps its own sandbox workspace across iterations.',
    ];
    const filesystemRules = options.repositoryAccess
        ? buildRepositoryFilesystemRules(options.repositoryAccess)
        : [
            ...agentFilesystemRules,
            '- These agent workspaces do not share generated files with each other. A file created by another agent is not available in your current working directory unless it is also an original uploaded file listed below.',
            '- You may load files from your own previous tool calls by filename when they appeared in your own visible_image_files or generated image outputs.',
            '- Do not try to open filenames merely because they appeared in another agent output, UI transcript, markdown image link, or critique text. If you need a similar artifact, reproduce it in your own session by rerunning equivalent code from the original uploaded image/data, then save your own copy with a clear filename.',
        ];
    const commandStartRule = options.repositoryAccess
        ? options.repositoryAccess.agentDirectory
            ? options.repositoryAccess.agentDirectoryReadOnly
                ? `Each sandbox command starts in the read-only /workspace/${options.repositoryAccess.agentDirectory} directory. Use /workspace to read visible root and peer directories, and /tmp for scratch work.`
                : `Each sandbox command starts in /workspace/${options.repositoryAccess.agentDirectory}. Use /workspace to read visible root and peer directories.`
            : 'Each sandbox command starts in the read-only /workspace repository root. Use /tmp for private scratch work.'
        : 'Each sandbox command starts in /workspace.';

    return [
        systemPrompt,
        '',
        '<Virtual Sandbox Tool>',
        options.sharedWorkspaceHandler
            ? `You have three tools: ${SANDBOX_TOOL_NAME} for private terminal work, ${SHARED_WORKSPACE_TOOL_NAME} for real-time collaboration with peer agents via shared_workspace.md, and ${FINAL_OUTPUT_TOOL_NAME} for the submitted answer.`
            : `You have two tools: ${SANDBOX_TOOL_NAME} for private terminal work and ${FINAL_OUTPUT_TOOL_NAME} for the submitted answer.`,
        `${SANDBOX_TOOL_NAME} runs non-interactive bash commands inside your sandboxed Linux workspace.`,
        'Treat this as a real terminal in a real but sandboxed project directory. You can create directories and files, write scripts or source code, run programs, inspect outputs, read files with cat/sed, search with grep/find, edit or delete workspace files, install dependencies into the workspace when possible, and generate data, plots, images, or other artifacts.',
        `Running sequential or parallel commands with ${SANDBOX_TOOL_NAME}:`,
        `- Sequential commands in a single ${SANDBOX_TOOL_NAME}() call: chain dependent commands with \`&&\` (stops on first non-zero exit, e.g. \`mkdir -p build && g++ -O2 solve.cpp -o build/solve && ./build/solve\`) or chain independent commands with \`;\` or newlines (runs one after another regardless of previous exit codes, e.g. \`python3 check_a.py; python3 check_b.py\`).`,
        `- Parallel concurrent commands in a single ${SANDBOX_TOOL_NAME}() call: background independent commands with \`&\` and synchronize with \`wait\` (e.g. \`python3 sim1.py > sim1.out 2>&1 & python3 sim2.py > sim2.out 2>&1 & wait && cat sim1.out sim2.out\`) to run multiple tasks concurrently in one shell invocation.`,
        `- Parallel ${SANDBOX_TOOL_NAME}() tool calls in a single turn: you may also emit multiple ${SANDBOX_TOOL_NAME}() tool calls in the same assistant turn; the harness executes all ${SANDBOX_TOOL_NAME}() calls in that turn concurrently in parallel and returns each command's separate output.`,
        `${commandStartRule} Files and directories you create persist across your own tool calls and future iterations in the ${runScopeDescription}. Process memory, shell variables, and language REPL variables do not persist between separate commands; write durable state to files.`,
        'Use standard terminal practice: write scripts when commands become complex, check tool availability with command -v or --version when a runtime matters, and adapt if a language, package, or network access is unavailable.',
        '',
        '<Detected Sandbox Environment>',
        buildEnvironmentProfileText(environmentProfile),
        '</Detected Sandbox Environment>',
        '',
        'Use the tool whenever computation, verification, algorithm testing, data analysis, filesystem work, curl, image manipulation, plots, charts, or running scripts would materially improve your answer.',
        'If you would normally use a terminal, shell script, program, or command-line tool, call the sandbox tool instead of presenting unexecuted commands as if they ran.',
        'When the task explicitly asks for code execution, tests, plots, charts, image generation, or image editing, at least one real sandbox tool call is mandatory before your final response.',
        'Do not claim that commands, plots, charts, tests, or files were generated unless the sandbox tool actually did the work and returned the result.',
        '',
        'Final output discipline:',
        `- When your work is complete, call ${FINAL_OUTPUT_TOOL_NAME}. Do not end with ordinary prose when tool calling is available. If the tool returns a validation error, correct the payload and call it again.`,
        `- Your ${FINAL_OUTPUT_TOOL_NAME} submission is strictly gated at a maximum of ${options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} tokens. Keep your final submission within ${options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} tokens.`,
        `- The ${FINAL_OUTPUT_TOOL_NAME} response is the only text submitted to the multi-agent system and the only text future agents receive as your answer.`,
        options.finalOutputContract?.responseSchema
            ? `- This role has a structured final-output contract (${options.finalOutputContract.name}). Put the required JSON object directly in ${FINAL_OUTPUT_TOOL_NAME}.response; do not serialize it as prose or surround it with markdown. If the environment rejects it, fix only that payload and call ${FINAL_OUTPUT_TOOL_NAME} again—your sandbox research remains available.`
            : '- Submit the complete role-specific result in the final_output.response string.',
        '- Do not include private scratchpad, command transcripts, tool logs, or exploratory dead ends in the final output unless they are essential evidence for your role.',
        '- If generated files, plots, images, proofs, scripts, or data are useful, reference them exactly where they belong in the response with inline markers like [[image:plot.png|Plot label]] or [[file:analysis.py|Analysis script]].',
        '- Inline references must point to real files visible from this sandbox. Use paths relative to your writable directory for your own files, or /workspace/<visible-directory>/<file> for visible repository files.',
        '',
        'Verification discipline:',
        '- A claim is externally verified only when the relevant command was actually executed in the sandbox and returned a successful exit code. Otherwise call it a sketch, estimate, conjecture, or unverified attempt.',
        '- For formal proofs, create the proof file and run the proof checker. If Lean/Lake is available, use lean, lake env lean, lean-check, or a Lake project command as appropriate. Do not call a Lean proof verified unless the checker exits successfully.',
        '- For compiled or interpreted programs, save the source file, run the compiler/interpreter/tests, inspect stdout/stderr and exit_code, and iterate when errors appear. Do not treat a version check or package availability check as execution of the requested program.',
        '- For generated files and images, verify by listing or opening the saved file when useful, and report the filename produced by the real command.',
        '- If verification fails because a package, theorem, import, runtime, network call, or command is unavailable, say that directly and continue with the strongest honestly supported result.',
        `You may call ${SANDBOX_TOOL_NAME} repeatedly. The application will not advance to the next agent while you are still calling tools; ${FINAL_OUTPUT_TOOL_NAME} completes this agent.`,
        'If a timeout or backend restart occurs, files already written inside your workspace may remain.',
        '',
        'Agent-scoped workspace rules:',
        ...filesystemRules,
        'Before a tool call, include a concise visible note about what you are testing or producing. After tool output returns, inspect it and decide whether another tool call is needed.',
        '',
        'Sandbox filesystem rules:',
        `- ${commandStartRule}`,
        '- Prefer relative paths or /workspace paths for persistent files.',
        '- The host filesystem outside your sandbox workspace is not mounted. Do not rely on files outside /workspace.',
        '- /workspace/tmp (also mounted at /tmp) is an untracked shared read/write directory accessible to all agents in the run for building and refining shared verification harnesses and temporary files.',
        '- Direct-context files are supplied in the initial model message and are also mounted read-only under /workspace/user_uploaded for sandbox processing.',
        '- Additional user uploads are mounted read-only under /workspace/user_uploaded.',
        '- Generated or modified image files with png, jpg, jpeg, gif, webp, bmp, tif, or tiff extensions are returned to you as native image inputs.',
        '- If you need to visually inspect an existing image file (e.g. from user_uploaded or generated in a previous turn), you can run the `view <filename>` or `open <filename>` command. This attaches the image natively to your next turn.',
        '- Do not print or paste base64. Refer to image files by filename.',
        '',
        'Output visibility rules:',
        '- Print concise text results, progress notes, important numbers, command results, and saved filenames so both you and the user can see what happened in Command Output.',
        '- For plots, charts, or image manipulations, save actual image files such as output.png, step_01.png, or comparison.jpg. Saved image files are displayed to the user and attached back to you as native image inputs in the next loop.',
        '- Do not print raw image bytes or base64. That is noisy and prevents useful visual inspection.',
        '- When creating multiple image iterations, save each meaningful step with a clear filename and print a short line describing that file.',
        '- Never invent, copy, or edit markdown links to /api/sandbox/files/... or /api/sandbox/artifacts/... URLs. Those are UI display URLs, not workspace files. Refer to images by filename only.',
        '- Never manually write or imitate "Tool Execution Command", "Command Output", "visible_image_files", "Generated or updated images", or similar execution transcript sections. The application inserts those sections only from real sandbox tool calls. If you need a command, output, or generated images, call the sandbox tool.',
        '',
        'Direct-context files (native model inputs and read-only sandbox files):',
        directFileText,
        '',
        'Additional user-uploaded filesystem files:',
        filesystemFileText,
        directFiles.length ? 'Direct-context files are relevant to the current task. Inspect /workspace/user_uploaded as needed when terminal processing would help.' : '',
        filesystemFiles.length ? 'These additional user-uploaded files are relevant to the current task. Inspect /workspace/user_uploaded as needed before drawing conclusions.' : '',
        '',
        'The sandbox includes standard Linux shell utilities and whatever runtimes, packages, and command-line tools are available in the configured environment. If something is unavailable, report that directly and continue with available tools.',
        '</Virtual Sandbox Tool>'
    ].join('\n');
}

async function invokeAgentTurn(
    provider: ResolvedProvider,
    messages: BaseMessage[],
    systemPrompt: string,
    options: SandboxToolAgentOptions,
    onlyFinalOutputTool = false,
    turnNumber = 1
): Promise<AIMessage> {
    const finalOutputToolDefinition = createFinalOutputToolDefinition(options.finalOutputContract);
    const tools: ToolDefinition[] = onlyFinalOutputTool
        ? [finalOutputToolDefinition]
        : [
            sandboxToolDefinition,
            finalOutputToolDefinition,
            ...(options.sharedWorkspaceHandler ? [sharedWorkspaceToolDefinition] : []),
        ];

    return invokeToolCallingAgentTurn(
        provider,
        messages,
        systemPrompt,
        tools,
        {
            modelName: provider.modelName,
            abortSignal: options.abortSignal,
            retryDelaysMs: options.retryDelaysMs,
            silenceTimeoutMs: options.silenceTimeoutMs,
            label: `${options.agentName} (turn ${turnNumber}, ${provider.providerName}:${provider.modelName})`,
            onRetry: options.onRetry,
        }
    );
}

async function executeSandboxTool(
    sessionId: string,
    command: string,
    seedFiles: SeedFile[] | null,
    repositoryAccess?: SandboxRepositoryAccess,
    timeoutMs?: number
): Promise<SandboxToolResponse> {
    const response = await fetch(`${getSandboxApiBasePath()}/execute`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            sessionId,
            command,
            timeoutMs,
            repositoryAccess,
            files: seedFiles ?? undefined
        })
    });

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.error || 'Sandbox backend request failed.');
    }
    return normalizeSandboxToolResponseUrls(payload as SandboxToolResponse);
}

interface VirtualEnvironmentCommandOptions {
    sessionId: string;
    command: string;
    seedFiles?: SeedFile[];
    repositoryAccess?: SandboxRepositoryAccess;
    timeoutMs?: number;
}

/**
 * Direct terminal transport for a tool-calling orchestrator. It deliberately
 * uses the same backend session and repository access contract as sandbox_exec
 * so its files appear in the Deepthink Filesystem tab.
 */
export async function runVirtualEnvironmentCommand(
    options: VirtualEnvironmentCommandOptions
): Promise<Pick<SandboxToolResponse, 'ok' | 'exitCode' | 'stdout' | 'stderr' | 'error' | 'durationMs'>> {
    const result = await executeSandboxTool(
        options.sessionId,
        options.command,
        options.seedFiles ?? null,
        options.repositoryAccess,
        options.timeoutMs,
    );
    return {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        durationMs: result.durationMs,
    };
}

async function getSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile | null> {
    if (!sandboxEnvironmentProfilePromise) {
        sandboxEnvironmentProfilePromise = fetch(`${getSandboxApiBasePath()}/environment`, {
            method: 'GET',
            headers: {
                'accept': 'application/json'
            }
        })
            .then(async response => {
                if (!response.ok) return null;
                return await response.json() as SandboxEnvironmentProfile;
            })
            .catch(() => null);
    }

    return sandboxEnvironmentProfilePromise;
}

function getAppBasePath(): string {
    const baseUrl = (import.meta as any).env?.BASE_URL || '/';
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function getSandboxApiBasePath(): string {
    return `${getAppBasePath()}/api/sandbox`;
}

function withAppBasePath(url: string): string {
    if (!url.startsWith('/api/sandbox/')) return url;
    return `${getAppBasePath()}${url}`;
}

function normalizeSandboxToolImageUrls(images?: SandboxToolImage[]): SandboxToolImage[] | undefined {
    return images?.map(image => {
        return { ...image, url: withAppBasePath(image.url) };
    });
}

function normalizeSandboxToolResponseUrls(response: SandboxToolResponse): SandboxToolResponse {
    return {
        ...response,
        images: normalizeSandboxToolImageUrls(response.images),
        visibleFiles: response.visibleFiles?.map(image => ({ ...image, url: withAppBasePath(image.url) }))
    };
}

function formatCommandBlock(command: string): string {
    return [
        '<!-- CODE_EXECUTION_START -->',
        '<!-- LANGUAGE: bash -->',
        '```bash',
        command.trimEnd(),
        '```',
        '<!-- CODE_EXECUTION_END -->'
    ].join('\n');
}

function formatOutputBlock(response: SandboxToolResponse): string {
    const lines: string[] = [];
    lines.push(`exit_code=${response.exitCode}`);
    lines.push(`duration_ms=${response.durationMs}`);

    if (response.stdout?.trim()) {
        lines.push('\nstdout:');
        lines.push(response.stdout.trimEnd());
    }

    if (response.stderr?.trim()) {
        lines.push('\nstderr:');
        lines.push(response.stderr.trimEnd());
    }

    if (response.error) {
        lines.push('\nerror:');
        lines.push(response.error.trimEnd());
    }

    if (response.visibleFiles?.length) {
        lines.push('\nvisible_image_files:');
        response.visibleFiles.forEach(file => {
            lines.push(`- ${file.filename} (${file.mimeType}, ${file.size} bytes)`);
        });
    }

    return [
        '<!-- EXECUTION_OUTPUT_START -->',
        '```',
        lines.join('\n').trimEnd(),
        '```',
        '<!-- EXECUTION_OUTPUT_END -->'
    ].join('\n');
}

function formatImageLinks(images: SandboxToolImage[]): string {
    if (images.length === 0) return '';

    return [
        'Generated or updated images:',
        ...images.map(image => `![${image.filename}](${image.url})`)
    ].join('\n');
}

function formatToolTranscript(command: string, response: SandboxToolResponse): string {
    return [
        '### Tool Execution Command',
        formatCommandBlock(command),
        '',
        '### Command Output',
        formatOutputBlock(response),
        '',
        formatImageLinks(response.images ?? [])
    ].filter(Boolean).join('\n');
}

function formatIntermediateModelOutput(text: string): string {
    return `### Intermediate Model Output\n${text}`;
}

function normalizeWorkspaceReferencePath(rawPath: string, access?: SandboxRepositoryAccess): string | null {
    const raw = rawPath.trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0')) return null;

    const fromWorkspaceRoot = raw.startsWith('/workspace/');
    const fromRelativeRoot = raw.startsWith('../');
    let normalized = raw
        .replace(/^\/workspace\/?/, '')
        .replace(/^\.\//, '');

    while (normalized.startsWith('../')) {
        normalized = normalized.slice(3);
    }

    const parts: string[] = [];
    for (const part of normalized.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') return null;
        parts.push(part);
    }

    if (parts.length === 0) return null;

    if (access && access.agentDirectory && !fromWorkspaceRoot && !fromRelativeRoot) {
        const visibleDirectories = new Set([
            access.agentDirectory,
            ...(access.readableDirectories || []),
            'tmp',
            'direct_context',
            'user_uploaded',
        ]);
        if (!visibleDirectories.has(parts[0]) && (!access.fullRepositoryRead || parts.length === 1)) {
            parts.unshift(access.agentDirectory);
        }
    }

    return parts.join('/');
}

function encodeSandboxFileUrl(sessionId: string, relativePath: string): string {
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
    return withAppBasePath(`/api/sandbox/files/${encodeURIComponent(sessionId)}/${encodedPath}`);
}

function isImageReference(reference: SandboxInlineOutputReference): boolean {
    // Agents occasionally label an image artifact as a generic "file". The
    // actual path is authoritative here: rendering image bytes as a code file
    // both looks broken and can create an enormous text payload in the UI.
    return reference.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/i.test(reference.path);
}

function markdownForReference(sessionId: string, reference: SandboxInlineOutputReference): string {
    const url = encodeSandboxFileUrl(sessionId, reference.path);
    const label = (reference.label || reference.path.split('/').pop() || reference.path).replace(/[\]\n\r]/g, ' ').trim();

    if (isImageReference(reference)) {
        return `![${label}](${url})`;
    }

    return `[${label}](${url})`;
}

export function expandInlineReferenceMarkers(
    text: string,
    sessionId: string,
    access?: SandboxRepositoryAccess
): string {
    if (!text) return text;
    return text.replace(/\[\[(image|file):([^\]|\n\r]+)(?:\|([^\]\n\r]+))?\]\]/g, (_match, kind, rawPath, rawLabel) => {
        const path = normalizeWorkspaceReferencePath(String(rawPath), access);
        if (!path) return '';
        return markdownForReference(sessionId, {
            kind: kind === 'image' ? 'image' : 'file',
            path,
            label: rawLabel ? String(rawLabel).trim() : undefined,
        });
    });
}

function buildSubmittedFinalOutput(args: {
    finalText: string;
    sessionId: string;
    repositoryAccess?: SandboxRepositoryAccess;
}): string {
    return expandInlineReferenceMarkers(args.finalText.trim(), args.sessionId, args.repositoryAccess).trim();
}

function getFinalText(message: AIMessage): string {
    return messageContentToText(message.content).trim();
}

function getSandboxToolCalls(message: AIMessage) {
    return (message.tool_calls ?? []).filter(toolCall => toolCall.name === SANDBOX_TOOL_NAME);
}

function getFinalOutputToolCalls(message: AIMessage) {
    return (message.tool_calls ?? []).filter(toolCall => toolCall.name === FINAL_OUTPUT_TOOL_NAME);
}

function getSharedWorkspaceToolCalls(message: AIMessage) {
    return (message.tool_calls ?? []).filter(toolCall => toolCall.name === SHARED_WORKSPACE_TOOL_NAME);
}

function structuredFinalOutputText(
    response: unknown,
    contract: SandboxFinalOutputContract | undefined
): string {
    if (!contract) {
        if (typeof response !== 'string' || !response.trim()) {
            throw new Error('final_output.response must be a non-empty string for this role.');
        }
        return response.trim();
    }

    let payload = response;
    if (typeof payload === 'string') {
        let candidate = payload.trim();
        const fenceMatch = candidate.match(/```(?:json|json5)?\s*\n?([\s\S]*?)\n?\s*```/i);
        if (fenceMatch && fenceMatch[1]?.trim()) {
            candidate = fenceMatch[1].trim();
        } else if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
            const firstBrace = candidate.indexOf('{');
            const lastBrace = candidate.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                candidate = candidate.substring(firstBrace, lastBrace + 1).trim();
            }
        }
        try {
            payload = JSON.parse(candidate);
        } catch (error) {
            const details = error instanceof Error ? error.message : 'invalid JSON';
            throw new Error(`${contract.name} requires a JSON object in final_output.response. JSON parsing failed: ${details}`);
        }
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`${contract.name} requires final_output.response to be a JSON object.`);
    }

    contract.validate(payload);
    return typeof response === 'string' ? response.trim() : JSON.stringify(payload);
}

function isLikelyImageDataUri(value: string): boolean {
    return /^data:image\/[^;]+;base64,/i.test(value);
}

function redactBinaryString(value: string, label: string): string {
    return `[${label} omitted from text trace; length=${value.length}]`;
}

function normalizeTraceKey(key: string | undefined): string {
    return (key || '').replace(/[_-]+/g, '').toLowerCase();
}

function isProviderThinkingRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    return record.thought === true ||
        type === 'thinking' ||
        type === 'reasoning' ||
        type === 'redacted_thinking';
}

function hasToolPayload(record: Record<string, unknown>): boolean {
    return 'functionCall' in record ||
        'functionResponse' in record ||
        'tool_calls' in record ||
        'tool_call' in record ||
        'tool_use' in record ||
        'tool_result' in record;
}

function shouldOmitTraceField(key: string | undefined, parent?: Record<string, unknown>): boolean {
    const normalized = normalizeTraceKey(key);
    if (normalized === 'thoughtsignature' || normalized === 'thinkingsignature') return true;
    if (normalized === 'thought' && parent && isProviderThinkingRecord(parent)) return true;
    if (normalized === 'signature' && parent && isProviderThinkingRecord(parent)) return true;
    if (normalized === 'reasoningcontent' || normalized === 'thinkingcontent') return true;
    return false;
}

function scrubTraceValue(value: unknown, key?: string, parent?: Record<string, unknown>): unknown | typeof OMIT_TRACE_VALUE {
    if (shouldOmitTraceField(key, parent)) {
        return OMIT_TRACE_VALUE;
    }

    if (typeof value === 'string') {
        if (isLikelyImageDataUri(value)) {
            const mimeMatch = value.match(/^data:([^;]+);base64,/i);
            return redactBinaryString(value, `${mimeMatch?.[1] || 'image'} data URI`);
        }

        const parentMime = parent?.mimeType || parent?.mime_type || parent?.media_type;
        if (
            key === 'data' &&
            typeof parentMime === 'string' &&
            parentMime.startsWith('image/') &&
            value.length > 128
        ) {
            return redactBinaryString(value, `${parentMime} base64`);
        }

        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => scrubTraceValue(item))
            .filter(item => item !== OMIT_TRACE_VALUE);
    }

    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (isProviderThinkingRecord(record) && !hasToolPayload(record)) {
            return {
                type: typeof record.type === 'string' ? record.type : 'thought',
                redacted: REDACTED_THOUGHT_TRACE,
            };
        }

        const entries: Array<[string, unknown]> = [];
        Object.entries(record).forEach(([entryKey, entryValue]) => {
            const scrubbed = scrubTraceValue(entryValue, entryKey, record);
            if (scrubbed !== OMIT_TRACE_VALUE) {
                entries.push([entryKey, scrubbed]);
            }
        });
        return Object.fromEntries(entries);
    }

    return value;
}

function messageRoleForTrace(messageType: string): SandboxToolExecutionTraceMessage['role'] {
    switch (messageType) {
        case 'ai':
            return 'assistant';
        case 'human':
            return 'user';
        case 'system':
            return 'system';
        case 'tool':
            return 'tool';
        default:
            return 'unknown';
    }
}

function messageTypeForTrace(message: BaseMessage): string {
    const getter = (message as { _getType?: () => string })._getType;
    if (typeof getter === 'function') return getter.call(message);
    return message.constructor?.name || 'unknown';
}

function buildTraceMessage(message: BaseMessage): SandboxToolExecutionTraceMessage {
    const raw = message as any;
    const messageType = messageTypeForTrace(message);
    const traced: SandboxToolExecutionTraceMessage = {
        role: messageRoleForTrace(messageType),
        message_type: messageType,
        content: scrubTraceValue(raw.content),
    };

    if (raw.tool_calls) traced.tool_calls = scrubTraceValue(raw.tool_calls);
    if (raw.invalid_tool_calls) traced.invalid_tool_calls = scrubTraceValue(raw.invalid_tool_calls);
    if (raw.tool_call_id) traced.tool_call_id = String(raw.tool_call_id);
    if (raw.name) traced.name = String(raw.name);
    if (raw.status) traced.status = String(raw.status);
    if (raw.additional_kwargs && Object.keys(raw.additional_kwargs).length > 0) traced.additional_kwargs = scrubTraceValue(raw.additional_kwargs);
    if (raw.response_metadata && Object.keys(raw.response_metadata).length > 0) traced.response_metadata = scrubTraceValue(raw.response_metadata);
    if (raw.id) traced.id = String(raw.id);
    if (Array.isArray(raw.artifact?.images)) traced.images = raw.artifact.images;

    return traced;
}

function buildExecutionTrace(args: {
    options: SandboxToolAgentOptions;
    provider: ResolvedProvider;
    sessionId: string;
    finalText: string;
    loopMessages: BaseMessage[];
}): SandboxToolExecutionTrace {
    return {
        schema: 'sandbox_tool_execution_trace.v1',
        sandbox_tool_name: SANDBOX_TOOL_NAME,
        agent: {
            name: args.options.agentName,
            provider: args.provider.providerName,
            model: args.provider.modelName,
            session_id: args.sessionId,
        },
        final_text: args.finalText,
        messages: args.loopMessages.map(buildTraceMessage),
    };
}

export function isContextualSandboxToolEnabled(): boolean {
    // Uploaded files are meaningful only when agents have a sandbox in which
    // to inspect them, so either upload bucket activates the runtime per run.
    return globalState.virtualEnvironmentEnabled
        || globalState.directContextFiles.length > 0
        || globalState.filesystemContextFiles.length > 0;
}

function extractReasoningTextsFromMessage(message: BaseMessage): string[] {
    const raw = message as any;
    const texts: string[] = [];

    if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
            if (!part || typeof part !== 'object') continue;
            const record = part as Record<string, unknown>;
            if (isProviderThinkingRecord(record)) {
                const candidate = typeof record.thinking === 'string'
                    ? record.thinking
                    : typeof record.text === 'string'
                        ? record.text
                        : typeof record.summary === 'string'
                            ? record.summary
                            : '';
                if (candidate.trim()) texts.push(candidate.trim());
            }
        }
    }

    const kwargsReasoning = raw.additional_kwargs?.reasoning_content ?? raw.additional_kwargs?.thinking;
    if (typeof kwargsReasoning === 'string' && kwargsReasoning.trim()) {
        texts.push(kwargsReasoning.trim());
    }
    return texts;
}

function isHarnessReminderText(text: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith('<harness_note>') ||
        trimmed.startsWith('Your previous response was ordinary prose, so it was not submitted.');
}

/**
 * Controls whether model reasoning/thinking blocks are emitted into `.jsonl` trajectory files.
 * Disabled by default to keep on-disk `.jsonl` files compact for downstream agent inspection.
 */
export const INCLUDE_REASONING_IN_TRAJECTORY_JSONL = false;

export function sanitizeTrajectoryRecordsForJsonl(
    records: ReadonlyArray<Record<string, any>>,
    includeReasoning = INCLUDE_REASONING_IN_TRAJECTORY_JSONL
): Array<Record<string, unknown>> {
    let firstUserDropped = false;
    const cleaned: Array<Record<string, unknown>> = [];

    for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const roleOrKind = record.role ?? record.kind;

        if (roleOrKind === 'system') continue;
        if (roleOrKind === 'user' && !firstUserDropped) {
            firstUserDropped = true;
            continue;
        }
        if (roleOrKind === 'reasoning' && !includeReasoning) continue;

        const copy: Record<string, unknown> = { ...record };
        delete copy.timestamp;
        delete copy.captured_at;
        delete copy.id;
        delete copy.tool_call_id;
        delete copy.source_message_id;
        delete copy.source_line_id;

        if (Array.isArray(copy.tool_calls)) {
            copy.tool_calls = copy.tool_calls.map((tc: any) => {
                if (!tc || typeof tc !== 'object') return tc;
                const tcCopy: Record<string, unknown> = { ...tc };
                delete tcCopy.id;
                return tcCopy;
            });
        }

        cleaned.push(copy);
    }

    return cleaned;
}

/**
 * Formats a simple system/user/assistant exchange (or single-message fallback)
 * into `@letta-ai/trajectory` validated `.jsonl` records.
 */
export function formatTrajectoryWithLetta(args: {
    systemInstruction?: string;
    userPrompt?: string;
    assistantResponse: string;
    reasoningText?: string;
}): string {
    const messages: BaseMessage[] = [];
    if (args.systemInstruction?.trim()) {
        messages.push(new SystemMessage(args.systemInstruction));
    }
    if (args.userPrompt?.trim()) {
        messages.push(new HumanMessage(args.userPrompt));
    } else {
        messages.push(new HumanMessage('[agent invocation]'));
    }
    const aiMsg = new AIMessage(args.assistantResponse || '[empty response]');
    if (INCLUDE_REASONING_IN_TRAJECTORY_JSONL && args.reasoningText?.trim()) {
        (aiMsg as any).additional_kwargs = { reasoning_content: args.reasoningText.trim() };
    }
    messages.push(aiMsg);
    return buildRawTrajectoryJsonl(messages);
}

export function buildRawTrajectoryJsonl(allMessages: BaseMessage[]): string {
    const toolResultByCallId = new Map<string, { content: string; ok: boolean }>();
    for (const message of allMessages) {
        if (messageTypeForTrace(message) !== 'tool') continue;
        const raw = message as any;
        const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
        if (!callId) continue;
        const content = typeof raw.content === 'string'
            ? raw.content
            : JSON.stringify(scrubTraceValue(raw.content));
        const ok = raw.status !== 'error';
        toolResultByCallId.set(callId, { content, ok });
    }

    const lettaRows: Array<Record<string, unknown>> = [];
    const baseMs = Date.now();
    let stepIdx = 0;
    const nextTimestamp = () => new Date(baseMs + stepIdx++ * 1_000).toISOString();

    for (const message of allMessages) {
        const raw = message as any;
        const messageType = messageTypeForTrace(message);

        if (messageType === 'system') {
            continue;
        }

        if (messageType === 'human') {
            const text = messageContentToText(raw.content).trim();
            if (!text || isHarnessReminderText(text)) continue;
            lettaRows.push({
                kind: 'user',
                text,
                captured_at: nextTimestamp(),
            });
            continue;
        }

        if (messageType === 'ai') {
            const msgId = typeof raw.id === 'string' && raw.id ? raw.id : `msg_${stepIdx}`;
            if (INCLUDE_REASONING_IN_TRAJECTORY_JSONL) {
                const reasoningTexts = extractReasoningTextsFromMessage(message);
                for (const reasoning of reasoningTexts) {
                    lettaRows.push({
                        kind: 'reasoning',
                        source_message_id: msgId,
                        text: reasoning,
                        captured_at: nextTimestamp(),
                    });
                }
            }

            const text = messageContentToText(raw.content).trim();
            if (text) {
                lettaRows.push({
                    kind: 'assistant',
                    source_message_id: msgId,
                    text,
                    captured_at: nextTimestamp(),
                });
            }

            const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i] ?? {};
                const callId = typeof call.id === 'string' && call.id ? call.id : `${msgId}_call_${i + 1}`;
                const toolName = typeof call.name === 'string' && call.name ? call.name : 'unknown_tool';
                const callArgs = call.args ?? {};
                const command = toolName === SANDBOX_TOOL_NAME && typeof callArgs?.command === 'string'
                    ? callArgs.command
                    : '';

                const matchedResult = toolResultByCallId.get(callId);
                let resultText = matchedResult?.content ?? (toolName === FINAL_OUTPUT_TOOL_NAME ? 'final_output accepted.' : '');
                const resultOk = matchedResult?.ok ?? true;

                // Pass 2 (just-bash AST classification): mask output of read-only commands when exit_code === 0
                if (toolName === SANDBOX_TOOL_NAME && resultOk && command && isReadOnlyBashCommand(command)) {
                    resultText = 'exit_code=0 [read-only command output masked]';
                }

                lettaRows.push({
                    kind: 'tool_call',
                    source_line_id: callId,
                    name: toolName,
                    argsText: typeof callArgs === 'string' ? callArgs : JSON.stringify(callArgs),
                    resultText,
                    resultOk,
                    captured_at: nextTimestamp(),
                });
            }
        }
    }

    if (!lettaRows.some(row => row.kind === 'user')) {
        lettaRows.unshift({
            kind: 'user',
            text: '[sandbox invocation]',
            captured_at: new Date(baseMs - 1_000).toISOString(),
        });
    }
    if (!lettaRows.some(row => row.kind === 'assistant' || row.kind === 'tool_call')) {
        lettaRows.push({
            kind: 'assistant',
            text: '[completed]',
            captured_at: nextTimestamp(),
        });
    }

    try {
        const normalized = normalizeTranscript({
            source: 'letta-code',
            transcript: lettaRows.map(row => JSON.stringify(row)).join('\n'),
            bounds: {
                ...DEFAULT_NORMALIZATION_BOUNDS,
                toolResults: { maxCharacters: null, strategy: 'head-tail' },
            },
            filters: {
                systemMessages: 'omit',
                toolResults: 'include',
            },
        });

        validateTranscript(normalized.records);
        return sanitizeTrajectoryRecordsForJsonl(normalized.records)
            .map(record => JSON.stringify(record))
            .join('\n');
    } catch {
        return sanitizeTrajectoryRecordsForJsonl(lettaRows)
            .map(row => JSON.stringify(row))
            .join('\n');
    }
}

export async function runSandboxToolAgent(
    options: SandboxToolAgentOptions
): Promise<SandboxToolAgentResult> {
    const provider = resolveProviderForModel(options.modelName);
    if (!provider.providerConfig?.isConfigured || (provider.providerName === 'openai-compatible'
        ? !provider.providerConfig.baseURL
        : !provider.providerConfig.apiKey)) {
        throw new Error(`No configured provider found for model: ${options.modelName}`);
    }

    const seedFiles = options.seedFiles ?? getDefaultSeedFiles();
    const filesystemFiles = options.filesystemFiles ?? getDefaultFilesystemFiles();
    const directContextSandboxFiles = getDirectContextSandboxFiles(seedFiles);
    const sessionId = options.sessionId ?? `ctx-${options.agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(12)}`;
    const environmentProfile = await getSandboxEnvironmentProfile();
    const systemPrompt = buildSystemPrompt(options.systemPrompt, directContextSandboxFiles, filesystemFiles, options, environmentProfile);
    const messages = [...options.messages];
    const transcriptParts: string[] = [];
    const historyImages = new Map<string, SandboxToolImage>();
    let finalText = '';
    let shouldSeedBackend = !messages.some(m => messageTypeForTrace(m) === 'tool' && (m as any).name === SANDBOX_TOOL_NAME);

    const maxToolTurns = Math.max(1, options.maxToolTurns ?? MAX_TOOL_TURNS);
    const maxDurationMs = Math.max(1, options.maxDurationMs ?? MAX_SANDBOX_DURATION_MS);
    const maxOutputTokens = Math.max(1, options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
    const totalAllowedTurns = maxToolTurns + OVERTIME_GRACE_TURNS + FORCED_FINAL_OUTPUT_TURNS;
    const maxMinutes = Math.max(1, Math.round(maxDurationMs / 60_000));
    const sandboxStartedAt = Date.now();
    let warned10MinRemaining = false;
    let warned5MinRemaining = false;
    let timeExpiredRevoked = false;
    let forcedTimeExpiredTurnsUsed = 0;

    const uploadedFileMessage = (options.omitUploadedFileMessage || options.messages.length > 1)
        ? null
        : buildUploadedFileMessage(provider.providerName, seedFiles);
    if (uploadedFileMessage) {
        messages.push(uploadedFileMessage);
    }

    // Mark where the tool loop starts so we can capture the raw messages afterwards
    const loopStartIndex = messages.length;

    for (let turn = 0; turn < totalAllowedTurns; turn++) {
        if (options.abortSignal?.aborted) {
            throw options.abortSignal.reason ?? new Error('Process stopped by user');
        }

        const elapsedBeforeTurn = Date.now() - sandboxStartedAt;
        const remainingBeforeTurn = maxDurationMs - elapsedBeforeTurn;
        if (!timeExpiredRevoked && remainingBeforeTurn <= 0) {
            timeExpiredRevoked = true;
            messages.push(new HumanMessage(buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes)));
        }
        if (timeExpiredRevoked) {
            if (forcedTimeExpiredTurnsUsed >= FORCED_FINAL_OUTPUT_TURNS) {
                break;
            }
            forcedTimeExpiredTurnsUsed++;
        }

        const onlyFinalOutputTool = timeExpiredRevoked || turn >= maxToolTurns + OVERTIME_GRACE_TURNS;
        const response = await invokeAgentTurn(provider, messages, systemPrompt, options, onlyFinalOutputTool, turn + 1);
        for (const call of response.tool_calls ?? []) {
            if (!call.id) call.id = nanoid(8);
        }
        messages.push(response);

        const modelText = getFinalText(response);
        const sandboxToolCalls = getSandboxToolCalls(response);
        const finalOutputToolCalls = getFinalOutputToolCalls(response);
        const sharedWorkspaceToolCalls = getSharedWorkspaceToolCalls(response);
        const hasToolCalls = sandboxToolCalls.length > 0 || finalOutputToolCalls.length > 0 || sharedWorkspaceToolCalls.length > 0;

        if (modelText) {
            transcriptParts.push(
                hasToolCalls
                    ? (transcriptParts.length === 0 ? modelText : formatIntermediateModelOutput(modelText))
                    : modelText
            );
        }

        if (finalOutputToolCalls.length > 0) {
            const toolCall = finalOutputToolCalls[0];
            let candidateFinalText = '';
            let schemaError: string | null = null;
            try {
                const parsed = finalOutputToolSchema.parse(toolCall.args ?? {});
                candidateFinalText = structuredFinalOutputText(parsed.response, options.finalOutputContract);
            } catch (error) {
                schemaError = error instanceof Error ? error.message : 'Invalid final output payload.';
            }

            if (schemaError) {
                messages.push(new ToolMessage({
                    name: FINAL_OUTPUT_TOOL_NAME,
                    content: [
                        `final_output was not accepted: ${schemaError}`,
                        options.finalOutputContract
                            ? `Correct the ${options.finalOutputContract.name} JSON object and call ${FINAL_OUTPUT_TOOL_NAME} again. Your previous sandbox work and conversation are still available.`
                            : `Correct the payload and call ${FINAL_OUTPUT_TOOL_NAME} again. Your previous sandbox work and conversation are still available.`
                    ].join('\n'),
                    tool_call_id: toolCall.id ?? nanoid(8),
                    status: 'error'
                }));
                for (const otherCall of response.tool_calls ?? []) {
                    if (otherCall === toolCall) continue;
                    messages.push(new ToolMessage({
                        name: otherCall.name,
                        content: 'Not executed: final_output was rejected in the same turn.',
                        tool_call_id: otherCall.id ?? nanoid(8),
                        status: 'error',
                    }));
                }
            } else {
                const outputTokenCount = countTextTokens(candidateFinalText);
                if (outputTokenCount > maxOutputTokens) {
                    const tokenErrorText = `Tool Error: ${FINAL_OUTPUT_TOOL_NAME} rejected because the output is ${outputTokenCount} tokens, exceeding the maximum allowed limit of ${maxOutputTokens} output tokens for ${options.agentName}.`;
                    messages.push(new ToolMessage({
                        name: FINAL_OUTPUT_TOOL_NAME,
                        content: tokenErrorText,
                        tool_call_id: toolCall.id ?? nanoid(8),
                        status: 'error',
                    }));
                    for (const otherCall of response.tool_calls ?? []) {
                        if (otherCall === toolCall) continue;
                        messages.push(new ToolMessage({
                            name: otherCall.name,
                            content: 'Not executed: final_output exceeded the token limit in the same turn.',
                            tool_call_id: otherCall.id ?? nanoid(8),
                            status: 'error',
                        }));
                    }
                    messages.push(new HumanMessage(
                        buildFinalOutputTokenGateHarnessNote(options.agentName, outputTokenCount, maxOutputTokens)
                    ));
                    transcriptParts.push(`[${FINAL_OUTPUT_TOOL_NAME} token gate error]: ${tokenErrorText}`);
                } else {
                    finalText = candidateFinalText;
                    break;
                }
            }
        } else if (onlyFinalOutputTool) {
            // All other tools have been revoked; reject any non-final_output tool calls and demand final_output
            for (const revokedCall of [...sandboxToolCalls, ...sharedWorkspaceToolCalls]) {
                messages.push(new ToolMessage({
                    name: revokedCall.name,
                    content: timeExpiredRevoked
                        ? `Tool Error: Access to ${revokedCall.name} has been revoked after reaching the ${maxMinutes}-minute sandbox time limit. Only ${FINAL_OUTPUT_TOOL_NAME} is available.`
                        : `Tool Error: Access to ${revokedCall.name} has been revoked after exceeding the maximum tool call budget and grace window. Only ${FINAL_OUTPUT_TOOL_NAME} is available.`,
                    tool_call_id: revokedCall.id ?? nanoid(8),
                    status: 'error',
                }));
            }
            messages.push(new HumanMessage(
                timeExpiredRevoked
                    ? buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes)
                    : buildRevokedToolsFinalSubmitHarnessNote()
            ));
        } else {
            if (sharedWorkspaceToolCalls.length > 0) {
                for (const toolCall of sharedWorkspaceToolCalls) {
                    let toolContent = '';
                    let isOk = true;
                    let tokenLimitError: SharedWorkspaceTokenLimitError | null = null;
                    try {
                        const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
                        if (rawArgs.action === 'write') {
                            throw new Error(
                                'Full-file "write" is disabled on shared_workspace.md to prevent overwriting peer agents\' work. Use action="edit" (with old_string and new_string) or action="append" (with content).'
                            );
                        }
                        const parsed = sharedWorkspaceToolSchema.parse(rawArgs);
                        if (!options.sharedWorkspaceHandler) {
                            throw new Error('shared_workspace tool is not available for this role.');
                        }
                        toolContent = await options.sharedWorkspaceHandler(parsed);
                    } catch (error) {
                        isOk = false;
                        if (error instanceof SharedWorkspaceTokenLimitError || (error as any)?.name === 'SharedWorkspaceTokenLimitError') {
                            tokenLimitError = error as SharedWorkspaceTokenLimitError;
                        }
                        toolContent = `shared_workspace call failed: ${error instanceof Error ? error.message : 'Invalid parameters.'}`;
                    }
                    messages.push(new ToolMessage({
                        name: SHARED_WORKSPACE_TOOL_NAME,
                        content: toolContent,
                        tool_call_id: toolCall.id ?? nanoid(8),
                        status: isOk ? 'success' : 'error',
                    }));
                    transcriptParts.push(`[shared_workspace ${toolCall.args?.action ?? 'call'}]:\n${toolContent}`);
                    if (tokenLimitError) {
                        messages.push(new HumanMessage(
                            buildSharedWorkspaceTokenGateHarnessNote(
                                tokenLimitError.tokenCount ?? SHARED_WORKSPACE_MAX_TOKENS + 1,
                                tokenLimitError.maxTokens ?? SHARED_WORKSPACE_MAX_TOKENS
                            )
                        ));
                    }
                }
            }

            if (sandboxToolCalls.length === 0 && sharedWorkspaceToolCalls.length === 0) {
                messages.push(new HumanMessage(
                    modelText
                        ? `Your previous response was ordinary prose, so it was not submitted. Submit the complete role-specific answer now by calling ${FINAL_OUTPUT_TOOL_NAME}.`
                        : `Submit the complete role-specific answer now by calling ${FINAL_OUTPUT_TOOL_NAME}.`
                ));
            }

            if (sandboxToolCalls.length > 0) {
                const seedFilesForBatch = shouldSeedBackend
                    ? [...directContextSandboxFiles, ...filesystemFiles]
                    : null;
                shouldSeedBackend = false;

                const batchResults = await Promise.all(
                    sandboxToolCalls.map(async (toolCall, index) => {
                        let parsedCommand = '';
                        let toolResponse: SandboxToolResponse;

                        try {
                            const parsed = sandboxToolSchema.parse(toolCall.args ?? {});
                            parsedCommand = parsed.command;
                            toolResponse = await executeSandboxTool(
                                sessionId,
                                parsedCommand,
                                index === 0 ? seedFilesForBatch : null,
                                options.repositoryAccess,
                                parsed.timeout_ms
                            );
                        } catch (error) {
                            toolResponse = {
                                ok: false,
                                exitCode: 1,
                                stdout: '',
                                stderr: '',
                                error: error instanceof Error ? error.message : 'Sandbox tool call failed.',
                                durationMs: 0,
                                images: [],
                                visibleFiles: []
                            };
                        }

                        return { toolCall, parsedCommand, toolResponse };
                    })
                );

                for (const { toolCall, parsedCommand, toolResponse } of batchResults) {
                    transcriptParts.push(formatToolTranscript(parsedCommand || '[Invalid or missing sandbox command]', toolResponse));
                    (toolResponse.images ?? []).forEach(image => {
                        if (image.base64) {
                            historyImages.set(image.filename, image);
                        }
                    });

                    const toolContent = [
                        `Sandbox command ${toolResponse.ok ? 'completed' : 'failed'}.`,
                        `exit_code=${toolResponse.exitCode}`,
                        `duration_ms=${toolResponse.durationMs}`,
                        toolResponse.stdout?.trim() ? `stdout:\n${toolResponse.stdout.trimEnd()}` : '',
                        toolResponse.stderr?.trim() ? `stderr:\n${toolResponse.stderr.trimEnd()}` : '',
                        toolResponse.error ? `error:\n${toolResponse.error.trimEnd()}` : '',
                        toolResponse.visibleFiles?.length
                            ? `visible_image_files:\n${toolResponse.visibleFiles.map(file => `- ${file.filename} (${file.mimeType})`).join('\n')}`
                            : 'visible_image_files: none',
                    ].filter(Boolean).join('\n\n');

                    messages.push(new ToolMessage({
                        name: SANDBOX_TOOL_NAME,
                        content: toolContent,
                        tool_call_id: toolCall.id ?? nanoid(8),
                        status: toolResponse.ok ? 'success' : 'error',
                        artifact: {
                            images: (toolResponse.images ?? []).map(({ filename, mimeType, url }) => ({ filename, mimeType, url })),
                        },
                    }));

                    const generatedImageMessage = buildGeneratedImageMessage(provider.providerName, toolResponse.images ?? []);
                    if (generatedImageMessage) {
                        messages.push(generatedImageMessage);
                    }
                }
            }
        }

        // Inject tool-call budget countdown notes and overtime transitions (§8.5)
        const completedTurns = turn + 1;
        const remainingInMainBudget = maxToolTurns - completedTurns;
        if (!timeExpiredRevoked) {
            if (remainingInMainBudget === 10) {
                messages.push(new HumanMessage(buildRemainingToolCallsHarnessNote(10, maxToolTurns)));
            } else if (remainingInMainBudget === 5) {
                messages.push(new HumanMessage(buildRemainingToolCallsHarnessNote(5, maxToolTurns)));
            } else if (completedTurns === maxToolTurns) {
                messages.push(new HumanMessage(buildOvertimeFinalSubmitHarnessNote(maxToolTurns, OVERTIME_GRACE_TURNS)));
            } else if (completedTurns === maxToolTurns + OVERTIME_GRACE_TURNS) {
                messages.push(new HumanMessage(buildRevokedToolsFinalSubmitHarnessNote()));
            }
        }

        // Inject wall-clock time countdown notes at <= 10 minutes and <= 5 minutes remaining, and enforce 60-minute cutoff
        const elapsedAfterTurn = Date.now() - sandboxStartedAt;
        const remainingTimeMs = maxDurationMs - elapsedAfterTurn;
        if (remainingTimeMs <= 0) {
            if (!timeExpiredRevoked) {
                timeExpiredRevoked = true;
                messages.push(new HumanMessage(buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes)));
            }
        } else if (remainingTimeMs <= SANDBOX_WARNING_5_MIN_MS && !warned5MinRemaining) {
            warned5MinRemaining = true;
            warned10MinRemaining = true;
            messages.push(new HumanMessage(buildRemainingSandboxTimeHarnessNote(5, maxMinutes)));
        } else if (remainingTimeMs <= SANDBOX_WARNING_10_MIN_MS && !warned10MinRemaining) {
            warned10MinRemaining = true;
            messages.push(new HumanMessage(buildRemainingSandboxTimeHarnessNote(10, maxMinutes)));
        }
    }

    if (!finalText) {
        if (timeExpiredRevoked) {
            throw new Error(`${options.agentName} exceeded the ${maxMinutes}-minute sandbox wall-clock time budget (plus ${FORCED_FINAL_OUTPUT_TURNS} forced-submit turns) without submitting final_output.`);
        }
        throw new Error(`${options.agentName} exceeded ${maxToolTurns} sandbox tool turns (plus ${OVERTIME_GRACE_TURNS} grace turns and ${FORCED_FINAL_OUTPUT_TURNS} forced-submit turns) without submitting final_output.`);
    }

    const submittedText = buildSubmittedFinalOutput({
        finalText,
        sessionId,
        repositoryAccess: options.repositoryAccess,
    });
    const displayText = submittedText || transcriptParts.join('\n\n').trim();

    // Capture raw messages only for diagnostics. These must not be replayed
    // into downstream agent histories; promptText is the submitted answer.
    const loopMessages = messages.slice(loopStartIndex);
    const executionTrace = buildExecutionTrace({
        options,
        provider,
        sessionId,
        finalText,
        loopMessages,
    });
    const rawTrajectoryJsonl = buildRawTrajectoryJsonl([
        new SystemMessage(systemPrompt),
        ...messages,
    ]);

    return {
        text: displayText,
        promptText: submittedText || finalText,
        finalText,
        executionTrace,
        executionTraceText: JSON.stringify(executionTrace, null, 2),
        rawTrajectoryJsonl,
        geminiContent: provider.providerName === 'gemini'
            ? buildGeminiHistoryContent(displayText, [...historyImages.values()])
            : undefined,
        loopMessages,
        messages,
    };
}

export async function runContextualSandboxToolAgent(
    options: ContextualSandboxToolAgentOptions
): Promise<ContextualSandboxToolAgentResult> {
    return runSandboxToolAgent(options);
}
