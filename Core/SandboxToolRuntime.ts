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
    maxToolTurns?: number;
    maxDurationMs?: number;
    maxOutputTokens?: number;
    finalOutputContract?: SandboxFinalOutputContract;
    sharedWorkspaceHandler?: (input: SharedWorkspaceToolInput) => Promise<string>;
    abortSignal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    silenceTimeoutMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

export interface SandboxRepositoryAccess {
    repositoryId: string;
    agentDirectory?: string;
    agentDirectoryReadOnly?: boolean;
    readableDirectories?: string[];
    liveReadableDirectories?: string[];
    hiddenDirectories?: string[];
    fullRepositoryRead?: boolean;
    fullRepositoryWrite?: boolean;
    revision?: string;
}

export interface SandboxFinalOutputContract {
    name: string;
    responseSchema?: Record<string, unknown>;
    validate: (payload: unknown) => void;
}

export interface DeepthinkResultsContextFile {
    path: string;
    content: string;
}

interface SandboxToolAgentResult {
    text: string;
    promptText: string;
    finalText: string;
    executionTrace?: SandboxToolExecutionTrace;
    executionTraceText?: string;
    rawTrajectoryJsonl?: string;
    geminiContent?: { parts: any[] };
    loopMessages?: BaseMessage[];
    messages?: BaseMessage[];
}

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
    images?: Array<{ filename: string; mimeType: string; url: string }>;
}

export interface SeedFile {
    name: string;
    mimeType: string;
    base64: string;
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
    limits?: {
        maxToolTurns?: number;
        maxDurationMs?: number;
        defaultCommandTimeoutMs?: number;
        maxCommandTimeoutMs?: number;
    };
}

const sandboxToolSchema = z.object({
    command: z.string().trim().min(1),
    timeout_ms: z.number().int().positive().optional()
});
const finalOutputToolSchema = z.object({ response: z.unknown() }).strict();

const SANDBOX_TOOL_NAME = 'sandbox_exec';
const FINAL_OUTPUT_TOOL_NAME = 'final_output';
const MAX_TOOL_TURNS = 64;
const OVERTIME_GRACE_TURNS = 5;
const FORCED_FINAL_OUTPUT_TURNS = 5;
const MAX_SANDBOX_DURATION_MS = 60 * 60_000;
const SANDBOX_WARNING_10_MIN_MS = 10 * 60_000;
const SANDBOX_WARNING_5_MIN_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 5000;
const OMIT_TRACE_VALUE = Symbol('omitTraceValue');
const REDACTED_THOUGHT_TRACE = '[thought content omitted from shared execution trace]';
let sandboxEnvironmentProfilePromise: Promise<SandboxEnvironmentProfile | null> | null = null;

function dispatchSnapshotEvent(repositoryId: string, commit?: string) {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deepthinkResultsSnapshot', {
            detail: commit ? { repositoryId, commit } : { repositoryId },
        }));
    }
}

async function postSandboxJson<T = any>(endpoint: string, body: unknown, fallbackError: string): Promise<T> {
    const response = await fetch(`${getSandboxApiBasePath()}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `${fallbackError} (${response.status}).`);
    return payload as T;
}

export async function snapshotSandboxRepositoryById(repositoryId: string, commitMessage: string): Promise<string> {
    const payload = await postSandboxJson<{ commit?: string }>('/snapshot', { repositoryId, commitMessage }, 'Sandbox snapshot failed');
    if (typeof payload?.commit !== 'string' || !payload.commit) {
        throw new Error('Sandbox snapshot did not return a repository revision.');
    }
    dispatchSnapshotEvent(repositoryId, payload.commit);
    return payload.commit;
}

export async function restoreSandboxRepositoryStrategy(repositoryId: string, strategyDirectory: string, commit: string): Promise<void> {
    await postSandboxJson('/repository/restore-strategy', { repositoryId, strategyDirectory, commit }, 'Sandbox strategy restore failed');
    dispatchSnapshotEvent(repositoryId);
}

export async function snapshotDeepthinkResultsRepository(
    repositoryId: string,
    commitMessage: string,
    contextFiles: DeepthinkResultsContextFile[]
): Promise<void> {
    await postSandboxJson('/repository/results-snapshot', { repositoryId, commitMessage, contextFiles }, 'Deepthink Results snapshot failed');
    dispatchSnapshotEvent(repositoryId);
}

export async function ensureDeepthinkResultsRepository(repositoryId: string): Promise<{ resultPath?: string }> {
    const payload = await postSandboxJson<{ resultPath?: string }>('/repository/ensure-deepthink', { repositoryId }, 'Could not initialize Deepthink Results');
    return { resultPath: payload?.resultPath };
}

export async function saveSandboxLatestGz(repositoryId: string, state: unknown): Promise<{ ok: boolean; path?: string }> {
    return postSandboxJson('/repository/save-latest-gz', { repositoryId, state }, 'Failed to save latest.gz');
}

export async function openSandboxRepositoryDirectory(repositoryId?: string): Promise<{ ok: boolean; path?: string }> {
    return postSandboxJson('/repository/open-directory', repositoryId ? { repositoryId } : {}, 'Failed to open directory');
}

export const openResultsDirectory = () => openSandboxRepositoryDirectory();

export async function archiveSandboxRepositoryStrategy(
    repositoryId: string,
    strategyDirectory: string
): Promise<{ archivedDirectory?: string; activeDirectory: string }> {
    const payload = await postSandboxJson<{ archivedDirectory?: string; activeDirectory: string }>(
        '/repository/archive-strategy',
        { repositoryId, strategyDirectory },
        'Failed to archive the replaced strategy repository directory.'
    );
    dispatchSnapshotEvent(repositoryId);
    return payload;
}

const READ_ONLY_BASH_COMMANDS = new Set([
    'ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'head', 'tail',
    'wc', 'stat', 'file', 'tree', 'pwd', 'which', 'type', 'realpath', 'dirname', 'basename', 'du', 'df',
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree']);
const FILE_WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const MUTATING_FIND_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls']);

function extractBashWordText(word: any): string {
    return Array.isArray(word?.parts)
        ? word.parts.map((p: any) => (p.type === 'Literal' || p.type === 'SingleQuoted') ? String(p.value ?? '') : '').join('')
        : '';
}

function isReadOnlySimpleCommandWords(words: string[]): boolean {
    const tokens = words.filter(Boolean);
    if (!tokens.length) return false;
    const [first, ...rest] = tokens[0] === 'rtk' ? tokens.slice(1) : tokens;
    if (!first) return false;
    if (first === 'read' && tokens[0] === 'rtk') return true;
    if (first === 'find') return !rest.some(arg => MUTATING_FIND_FLAGS.has(arg));
    if (READ_ONLY_BASH_COMMANDS.has(first)) return true;
    if (first === 'git') {
        const sub = rest.find(arg => !arg.startsWith('-'));
        return !!sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
    }
    return false;
}

export function isReadOnlyBashCommand(command: string): boolean {
    try {
        const ast = parseBashAst(command);
        let sawCommand = false;
        const checkCommand = (cmd: any): boolean => {
            if ((cmd.redirections || []).some((r: any) => FILE_WRITE_REDIRECT_OPERATORS.has(r.operator))) return false;
            if (cmd.type === 'SimpleCommand') {
                sawCommand = true;
                const words = [extractBashWordText(cmd.name), ...(cmd.args || []).map(extractBashWordText)];
                if (!isReadOnlySimpleCommandWords(words)) return false;
                return ![cmd.name, ...(cmd.args || [])].filter(Boolean).some((w: any) =>
                    Array.isArray(w.parts) && w.parts.some((p: any) => p.type === 'CommandSubstitution' || p.type === 'ProcessSubstitution')
                );
            }
            return (cmd.type === 'Subshell' || cmd.type === 'Group') && Array.isArray(cmd.body) && cmd.body.every(checkStatement);
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

const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/pdf': '.pdf',
    'image/png': '.png',
};

export function extensionForMimeType(mimeType: string): string {
    return MIME_EXTENSIONS[mimeType] ?? (mimeType.startsWith('image/') ? '.png' : '.bin');
}

function getDefaultSeedFiles(): SeedFile[] {
    return globalState.directContextFiles.map((file, i) => ({
        name: (file as any).name || `uploaded-file-${i + 1}${extensionForMimeType(file.mimeType)}`,
        mimeType: file.mimeType,
        base64: file.base64,
    }));
}

function toUserUploadedFiles(files: Array<{ name?: string; mimeType: string; base64: string }>, prefix: string): SeedFile[] {
    return files.map((file, i) => {
        const name = (file.name || `${prefix}-${i + 1}${extensionForMimeType(file.mimeType)}`).replace(/[\\/]+/g, '_');
        return { ...file, name, relativePath: `user_uploaded/${name}` };
    });
}

function getDirectContextSandboxFiles(seedFiles: SeedFile[]): SeedFile[] {
    return toUserUploadedFiles(seedFiles, 'direct-context-file');
}

function getDefaultFilesystemFiles(): SeedFile[] {
    return toUserUploadedFiles(globalState.filesystemContextFiles, 'uploaded-file');
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
                source: { type: 'base64', media_type: image.mimeType, data: image.base64 }
            }))
        ];
    }
    if (providerName === 'gemini') {
        return [
            ...(text ? [{ text }] : []),
            ...validFiles.map(file => ({ inlineData: { mimeType: file.mimeType, data: file.base64 } }))
        ];
    }
    return [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map(image => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
        }))
    ];
}

function createImageMessage(
    providerName: ResolvedProvider['providerName'],
    text: string,
    files: Array<{ mimeType: string; base64: string }>
): HumanMessage {
    return new HumanMessage({ content: getProviderImageContent(providerName, text, files) });
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
    return attachable.length ? createImageMessage(providerName, '', attachable.map(img => ({ mimeType: img.mimeType, base64: img.base64! }))) : null;
}

function buildGeminiHistoryContent(displayText: string, images: SandboxToolImage[]): { parts: any[] } | undefined {
    const attachable = images.filter(image => !!image.base64);
    return attachable.length ? {
        parts: [{ text: displayText }, ...attachable.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64! } }))]
    } : undefined;
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
        : [sandboxToolDefinition, finalOutputToolDefinition, ...(options.sharedWorkspaceHandler ? [sharedWorkspaceToolDefinition] : [])];

    return invokeToolCallingAgentTurn(provider, messages, systemPrompt, tools, {
        modelName: provider.modelName,
        abortSignal: options.abortSignal,
        retryDelaysMs: options.retryDelaysMs,
        silenceTimeoutMs: options.silenceTimeoutMs,
        label: `${options.agentName} (turn ${turnNumber}, ${provider.providerName}:${provider.modelName})`,
        onRetry: options.onRetry,
    });
}

async function executeSandboxTool(
    sessionId: string,
    command: string,
    seedFiles: SeedFile[] | null,
    repositoryAccess?: SandboxRepositoryAccess,
    timeoutMs?: number
): Promise<SandboxToolResponse> {
    const payload = await postSandboxJson<SandboxToolResponse>(
        '/execute',
        { sessionId, command, timeoutMs, repositoryAccess, files: seedFiles ?? undefined },
        'Sandbox backend request failed'
    );
    return {
        ...payload,
        images: payload.images?.map(img => ({ ...img, url: withAppBasePath(img.url) })),
        visibleFiles: payload.visibleFiles?.map(img => ({ ...img, url: withAppBasePath(img.url) })),
    };
}

export async function runVirtualEnvironmentCommand(options: {
    sessionId: string;
    command: string;
    seedFiles?: SeedFile[];
    repositoryAccess?: SandboxRepositoryAccess;
    timeoutMs?: number;
}): Promise<Pick<SandboxToolResponse, 'ok' | 'exitCode' | 'stdout' | 'stderr' | 'error' | 'durationMs'>> {
    const r = await executeSandboxTool(options.sessionId, options.command, options.seedFiles ?? null, options.repositoryAccess, options.timeoutMs);
    return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error, durationMs: r.durationMs };
}

async function getSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile | null> {
    if (!sandboxEnvironmentProfilePromise) {
        sandboxEnvironmentProfilePromise = fetch(`${getSandboxApiBasePath()}/environment`, {
            method: 'GET',
            headers: { accept: 'application/json' }
        }).then(async res => res.ok ? await res.json() as SandboxEnvironmentProfile : null).catch(() => null);
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
    return url.startsWith('/api/sandbox/') ? `${getAppBasePath()}${url}` : url;
}

function formatToolTranscript(command: string, response: SandboxToolResponse): string {
    const lines = [`exit_code=${response.exitCode}`, `duration_ms=${response.durationMs}`];
    if (response.stdout?.trim()) lines.push('\nstdout:', response.stdout.trimEnd());
    if (response.stderr?.trim()) lines.push('\nstderr:', response.stderr.trimEnd());
    if (response.error) lines.push('\nerror:', response.error.trimEnd());
    if (response.visibleFiles?.length) {
        lines.push('\nvisible_image_files:', ...response.visibleFiles.map(f => `- ${f.filename} (${f.mimeType}, ${f.size} bytes)`));
    }
    const imgs = response.images ?? [];
    return [
        '### Tool Execution Command',
        `<!-- CODE_EXECUTION_START -->\n<!-- LANGUAGE: bash -->\n\`\`\`bash\n${command.trimEnd()}\n\`\`\`\n<!-- CODE_EXECUTION_END -->`,
        '',
        '### Command Output',
        `<!-- EXECUTION_OUTPUT_START -->\n\`\`\`\n${lines.join('\n').trimEnd()}\n\`\`\`\n<!-- EXECUTION_OUTPUT_END -->`,
        '',
        imgs.length ? ['Generated or updated images:', ...imgs.map(i => `![${i.filename}](${i.url})`)].join('\n') : ''
    ].filter(Boolean).join('\n');
}

function normalizeWorkspaceReferencePath(rawPath: string, access?: SandboxRepositoryAccess): string | null {
    const raw = rawPath.trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0')) return null;
    const fromWorkspaceRoot = raw.startsWith('/workspace/');
    const fromRelativeRoot = raw.startsWith('../');
    let normalized = raw.replace(/^\/workspace\/?/, '').replace(/^\.\//, '');
    while (normalized.startsWith('../')) normalized = normalized.slice(3);

    const parts: string[] = [];
    for (const part of normalized.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') return null;
        parts.push(part);
    }
    if (!parts.length) return null;

    if (access?.agentDirectory && !fromWorkspaceRoot && !fromRelativeRoot) {
        const visible = new Set([access.agentDirectory, ...(access.readableDirectories || []), 'tmp', 'direct_context', 'user_uploaded']);
        if (!visible.has(parts[0]) && (!access.fullRepositoryRead || parts.length === 1)) {
            parts.unshift(access.agentDirectory);
        }
    }
    return parts.join('/');
}

export function expandInlineReferenceMarkers(text: string, sessionId: string, access?: SandboxRepositoryAccess): string {
    if (!text) return text;
    return text.replace(/\[\[(image|file):([^\]|\n\r]+)(?:\|([^\]\n\r]+))?\]\]/g, (_m, kind, rawPath, rawLabel) => {
        const normPath = normalizeWorkspaceReferencePath(String(rawPath), access);
        if (!normPath) return '';
        const url = withAppBasePath(`/api/sandbox/files/${encodeURIComponent(sessionId)}/${normPath.split('/').map(encodeURIComponent).join('/')}`);
        const label = (rawLabel ? String(rawLabel).trim() : (normPath.split('/').pop() || normPath)).replace(/[\]\n\r]/g, ' ').trim();
        const isImg = kind === 'image' || /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/i.test(normPath);
        return isImg ? `![${label}](${url})` : `[${label}](${url})`;
    });
}

function structuredFinalOutputText(response: unknown, contract?: SandboxFinalOutputContract): string {
    if (!contract) {
        if (typeof response !== 'string' || !response.trim()) {
            throw new Error('final_output.response must be a non-empty string for this role.');
        }
        return response.trim();
    }
    let payload = response;
    if (typeof payload === 'string') {
        let candidate = payload.trim();
        const fenceMatch = candidate.match(/\`\`\`(?:json|json5)?\s*\n?([\s\S]*?)\n?\s*\`\`\`/i);
        if (fenceMatch?.[1]?.trim()) {
            candidate = fenceMatch[1].trim();
        } else if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
            const first = candidate.indexOf('{');
            const last = candidate.lastIndexOf('}');
            if (first !== -1 && last > first) candidate = candidate.substring(first, last + 1).trim();
        }
        try {
            payload = JSON.parse(candidate);
        } catch (error) {
            throw new Error(`${contract.name} requires a JSON object in final_output.response. JSON parsing failed: ${error instanceof Error ? error.message : 'invalid JSON'}`);
        }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`${contract.name} requires final_output.response to be a JSON object.`);
    }
    contract.validate(payload);
    return typeof response === 'string' ? response.trim() : JSON.stringify(payload);
}

function isProviderThinkingRecord(record: Record<string, unknown>): boolean {
    const t = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    return record.thought === true || t === 'thinking' || t === 'reasoning' || t === 'redacted_thinking';
}

function hasToolPayload(record: Record<string, unknown>): boolean {
    return ['functionCall', 'functionResponse', 'tool_calls', 'tool_call', 'tool_use', 'tool_result'].some(k => k in record);
}

function shouldOmitTraceField(key?: string, parent?: Record<string, unknown>): boolean {
    const norm = (key || '').replace(/[_-]+/g, '').toLowerCase();
    if (norm === 'thoughtsignature' || norm === 'thinkingsignature' || norm === 'reasoningcontent' || norm === 'thinkingcontent') return true;
    return (norm === 'thought' || norm === 'signature') && !!parent && isProviderThinkingRecord(parent);
}

function scrubTraceValue(value: unknown, key?: string, parent?: Record<string, unknown>): unknown | typeof OMIT_TRACE_VALUE {
    if (shouldOmitTraceField(key, parent)) return OMIT_TRACE_VALUE;
    if (typeof value === 'string') {
        if (/^data:image\/[^;]+;base64,/i.test(value)) {
            const m = value.match(/^data:([^;]+);base64,/i);
            return `[${m?.[1] || 'image'} data URI omitted from text trace; length=${value.length}]`;
        }
        const parentMime = parent?.mimeType || parent?.mime_type || parent?.media_type;
        if (key === 'data' && typeof parentMime === 'string' && parentMime.startsWith('image/') && value.length > 128) {
            return `[${parentMime} base64 omitted from text trace; length=${value.length}]`;
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => scrubTraceValue(item)).filter(item => item !== OMIT_TRACE_VALUE);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (isProviderThinkingRecord(record) && !hasToolPayload(record)) {
            return { type: typeof record.type === 'string' ? record.type : 'thought', redacted: REDACTED_THOUGHT_TRACE };
        }
        const entries: Array<[string, unknown]> = [];
        for (const [k, v] of Object.entries(record)) {
            const scrubbed = scrubTraceValue(v, k, record);
            if (scrubbed !== OMIT_TRACE_VALUE) entries.push([k, scrubbed]);
        }
        return Object.fromEntries(entries);
    }
    return value;
}

const ROLE_MAP: Record<string, SandboxToolExecutionTraceMessage['role']> = {
    ai: 'assistant', human: 'user', system: 'system', tool: 'tool'
};

function messageTypeForTrace(message: BaseMessage): string {
    const getter = (message as { _getType?: () => string })._getType;
    return typeof getter === 'function' ? getter.call(message) : (message.constructor?.name || 'unknown');
}

function buildTraceMessage(message: BaseMessage): SandboxToolExecutionTraceMessage {
    const raw = message as any;
    const messageType = messageTypeForTrace(message);
    const traced: SandboxToolExecutionTraceMessage = {
        role: ROLE_MAP[messageType] || 'unknown',
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

export function isContextualSandboxToolEnabled(): boolean {
    return globalState.virtualEnvironmentEnabled
        || globalState.directContextFiles.length > 0
        || globalState.filesystemContextFiles.length > 0;
}

function extractReasoningTextsFromMessage(message: BaseMessage): string[] {
    const raw = message as any;
    const texts: string[] = [];
    if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
            if (part && typeof part === 'object' && isProviderThinkingRecord(part as Record<string, unknown>)) {
                const c = [part.thinking, part.text, part.summary].find(x => typeof x === 'string' && x.trim());
                if (c) texts.push(c.trim());
            }
        }
    }
    const kw = raw.additional_kwargs?.reasoning_content ?? raw.additional_kwargs?.thinking;
    if (typeof kw === 'string' && kw.trim()) texts.push(kw.trim());
    return texts;
}

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

        const { timestamp, captured_at, id, tool_call_id, source_message_id, source_line_id, ...copy } = record as Record<string, any>;
        if (Array.isArray(copy.tool_calls)) {
            copy.tool_calls = copy.tool_calls.map((tc: any) => {
                if (!tc || typeof tc !== 'object') return tc;
                const { id: _id, ...tcCopy } = tc;
                return tcCopy;
            });
        }
        cleaned.push(copy);
    }
    return cleaned;
}

export function buildRawTrajectoryJsonl(allMessages: BaseMessage[]): string {
    const toolResultByCallId = new Map<string, { content: string; ok: boolean }>();
    for (const message of allMessages) {
        if (messageTypeForTrace(message) !== 'tool') continue;
        const raw = message as any;
        const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
        if (!callId) continue;
        const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(scrubTraceValue(raw.content));
        toolResultByCallId.set(callId, { content, ok: raw.status !== 'error' });
    }

    const lettaRows: Array<Record<string, unknown>> = [];
    const baseMs = Date.now();
    let stepIdx = 0;
    const nextTimestamp = () => new Date(baseMs + stepIdx++ * 1_000).toISOString();

    for (const message of allMessages) {
        const raw = message as any;
        const messageType = messageTypeForTrace(message);
        if (messageType === 'system') continue;

        if (messageType === 'human') {
            const text = messageContentToText(raw.content).trim();
            if (!text || text.startsWith('<harness_note>') || text.startsWith('Your previous response was ordinary prose, so it was not submitted.')) continue;
            lettaRows.push({ kind: 'user', text, captured_at: nextTimestamp() });
            continue;
        }

        if (messageType === 'ai') {
            const msgId = typeof raw.id === 'string' && raw.id ? raw.id : `msg_${stepIdx}`;
            if (INCLUDE_REASONING_IN_TRAJECTORY_JSONL) {
                for (const reasoning of extractReasoningTextsFromMessage(message)) {
                    lettaRows.push({ kind: 'reasoning', source_message_id: msgId, text: reasoning, captured_at: nextTimestamp() });
                }
            }
            const text = messageContentToText(raw.content).trim();
            if (text) {
                lettaRows.push({ kind: 'assistant', source_message_id: msgId, text, captured_at: nextTimestamp() });
            }
            const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i] ?? {};
                const callId = typeof call.id === 'string' && call.id ? call.id : `${msgId}_call_${i + 1}`;
                const toolName = typeof call.name === 'string' && call.name ? call.name : 'unknown_tool';
                const callArgs = call.args ?? {};
                const command = toolName === SANDBOX_TOOL_NAME && typeof callArgs?.command === 'string' ? callArgs.command : '';
                const matched = toolResultByCallId.get(callId);
                let resultText = matched?.content ?? (toolName === FINAL_OUTPUT_TOOL_NAME ? 'final_output accepted.' : '');
                const resultOk = matched?.ok ?? true;
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

    if (!lettaRows.some(r => r.kind === 'user')) {
        lettaRows.unshift({ kind: 'user', text: '[sandbox invocation]', captured_at: new Date(baseMs - 1_000).toISOString() });
    }
    if (!lettaRows.some(r => r.kind === 'assistant' || r.kind === 'tool_call')) {
        lettaRows.push({ kind: 'assistant', text: '[completed]', captured_at: nextTimestamp() });
    }

    try {
        const normalized = normalizeTranscript({
            source: 'letta-code',
            transcript: lettaRows.map(r => JSON.stringify(r)).join('\n'),
            bounds: { ...DEFAULT_NORMALIZATION_BOUNDS, toolResults: { maxCharacters: null, strategy: 'head-tail' } },
            filters: { systemMessages: 'omit', toolResults: 'include' },
        });
        validateTranscript(normalized.records);
        return sanitizeTrajectoryRecordsForJsonl(normalized.records).map(r => JSON.stringify(r)).join('\n');
    } catch {
        return sanitizeTrajectoryRecordsForJsonl(lettaRows).map(r => JSON.stringify(r)).join('\n');
    }
}

export async function runSandboxToolAgent(options: SandboxToolAgentOptions): Promise<SandboxToolAgentResult> {
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

    const maxToolTurns = Math.max(1, options.maxToolTurns ?? environmentProfile?.limits?.maxToolTurns ?? MAX_TOOL_TURNS);
    const maxDurationMs = Math.max(1, options.maxDurationMs ?? environmentProfile?.limits?.maxDurationMs ?? MAX_SANDBOX_DURATION_MS);
    const maxOutputTokens = Math.max(1, options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
    const totalAllowedTurns = maxToolTurns + OVERTIME_GRACE_TURNS + FORCED_FINAL_OUTPUT_TURNS;
    const maxMinutes = Math.max(1, Math.round(maxDurationMs / 60_000));
    const sandboxStartedAt = Date.now();
    let warned10MinRemaining = false;
    let warned5MinRemaining = false;
    let timeExpiredRevoked = false;
    let forcedTimeExpiredTurnsUsed = 0;

    if (!options.omitUploadedFileMessage && options.messages.length <= 1) {
        const uploadedFileMessage = buildUploadedFileMessage(provider.providerName, seedFiles);
        if (uploadedFileMessage) messages.push(uploadedFileMessage);
    }

    const loopStartIndex = messages.length;
    const pushRejectedOtherCalls = (allCalls: any[], activeCall: any, reason: string) => {
        for (const c of allCalls) {
            if (c !== activeCall) {
                messages.push(new ToolMessage({ name: c.name, content: reason, tool_call_id: c.id ?? nanoid(8), status: 'error' }));
            }
        }
    };

    for (let turn = 0; turn < totalAllowedTurns; turn++) {
        if (options.abortSignal?.aborted) {
            throw options.abortSignal.reason ?? new Error('Process stopped by user');
        }

        if (!timeExpiredRevoked && maxDurationMs - (Date.now() - sandboxStartedAt) <= 0) {
            timeExpiredRevoked = true;
            messages.push(new HumanMessage(buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes)));
        }
        if (timeExpiredRevoked && forcedTimeExpiredTurnsUsed++ >= FORCED_FINAL_OUTPUT_TURNS) break;

        const onlyFinalOutputTool = timeExpiredRevoked || turn >= maxToolTurns + OVERTIME_GRACE_TURNS;
        const response = await invokeAgentTurn(provider, messages, systemPrompt, options, onlyFinalOutputTool, turn + 1);
        const toolCalls = response.tool_calls ?? [];
        for (const call of toolCalls) {
            if (!call.id) call.id = nanoid(8);
        }
        messages.push(response);

        const modelText = messageContentToText(response.content).trim();
        const sandboxToolCalls = toolCalls.filter(c => c.name === SANDBOX_TOOL_NAME);
        const finalOutputToolCalls = toolCalls.filter(c => c.name === FINAL_OUTPUT_TOOL_NAME);
        const sharedWorkspaceToolCalls = toolCalls.filter(c => c.name === SHARED_WORKSPACE_TOOL_NAME);
        const hasToolCalls = sandboxToolCalls.length > 0 || finalOutputToolCalls.length > 0 || sharedWorkspaceToolCalls.length > 0;

        if (modelText) {
            transcriptParts.push(hasToolCalls && transcriptParts.length > 0 ? `### Intermediate Model Output\n${modelText}` : modelText);
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
                pushRejectedOtherCalls(toolCalls, toolCall, 'Not executed: final_output was rejected in the same turn.');
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
                    pushRejectedOtherCalls(toolCalls, toolCall, 'Not executed: final_output exceeded the token limit in the same turn.');
                    messages.push(new HumanMessage(buildFinalOutputTokenGateHarnessNote(options.agentName, outputTokenCount, maxOutputTokens)));
                    transcriptParts.push(`[${FINAL_OUTPUT_TOOL_NAME} token gate error]: ${tokenErrorText}`);
                } else {
                    finalText = candidateFinalText;
                    break;
                }
            }
        } else if (onlyFinalOutputTool) {
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
                timeExpiredRevoked ? buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes) : buildRevokedToolsFinalSubmitHarnessNote()
            ));
        } else {
            for (const toolCall of sharedWorkspaceToolCalls) {
                let toolContent = '';
                let isOk = true;
                let tokenLimitError: SharedWorkspaceTokenLimitError | null = null;
                try {
                    const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
                    if (rawArgs.action === 'write') {
                        throw new Error('Full-file "write" is disabled on shared_workspace.md to prevent overwriting peer agents\' work. Use action="edit" (with old_string and new_string) or action="append" (with content).');
                    }
                    const parsed = sharedWorkspaceToolSchema.parse(rawArgs);
                    if (!options.sharedWorkspaceHandler) throw new Error('shared_workspace tool is not available for this role.');
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
                    messages.push(new HumanMessage(buildSharedWorkspaceTokenGateHarnessNote(
                        tokenLimitError.tokenCount ?? SHARED_WORKSPACE_MAX_TOKENS + 1,
                        tokenLimitError.maxTokens ?? SHARED_WORKSPACE_MAX_TOKENS
                    )));
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
                const seedFilesForBatch = shouldSeedBackend ? [...directContextSandboxFiles, ...filesystemFiles] : null;
                shouldSeedBackend = false;

                const batchResults = await Promise.all(
                    sandboxToolCalls.map(async (toolCall, index) => {
                        let parsedCommand = '';
                        let toolResponse: SandboxToolResponse;
                        try {
                            const parsed = sandboxToolSchema.parse(toolCall.args ?? {});
                            parsedCommand = parsed.command;
                            toolResponse = await executeSandboxTool(sessionId, parsedCommand, index === 0 ? seedFilesForBatch : null, options.repositoryAccess, parsed.timeout_ms);
                        } catch (error) {
                            toolResponse = {
                                ok: false, exitCode: 1, stdout: '', stderr: '',
                                error: error instanceof Error ? error.message : 'Sandbox tool call failed.',
                                durationMs: 0, images: [], visibleFiles: []
                            };
                        }
                        return { toolCall, parsedCommand, toolResponse };
                    })
                );

                for (const { toolCall, parsedCommand, toolResponse } of batchResults) {
                    transcriptParts.push(formatToolTranscript(parsedCommand || '[Invalid or missing sandbox command]', toolResponse));
                    for (const image of toolResponse.images ?? []) {
                        if (image.base64) historyImages.set(image.filename, image);
                    }
                    const toolContent = [
                        `Sandbox command ${toolResponse.ok ? 'completed' : 'failed'}.`,
                        `exit_code=${toolResponse.exitCode}`,
                        `duration_ms=${toolResponse.durationMs}`,
                        toolResponse.stdout?.trim() ? `stdout:\n${toolResponse.stdout.trimEnd()}` : '',
                        toolResponse.stderr?.trim() ? `stderr:\n${toolResponse.stderr.trimEnd()}` : '',
                        toolResponse.error ? `error:\n${toolResponse.error.trimEnd()}` : '',
                        toolResponse.visibleFiles?.length
                            ? `visible_image_files:\n${toolResponse.visibleFiles.map(f => `- ${f.filename} (${f.mimeType})`).join('\n')}`
                            : 'visible_image_files: none',
                    ].filter(Boolean).join('\n\n');

                    messages.push(new ToolMessage({
                        name: SANDBOX_TOOL_NAME,
                        content: toolContent,
                        tool_call_id: toolCall.id ?? nanoid(8),
                        status: toolResponse.ok ? 'success' : 'error',
                        artifact: { images: (toolResponse.images ?? []).map(({ filename, mimeType, url }) => ({ filename, mimeType, url })) },
                    }));

                    const generatedImageMessage = buildGeneratedImageMessage(provider.providerName, toolResponse.images ?? []);
                    if (generatedImageMessage) messages.push(generatedImageMessage);
                }
            }
        }

        const completedTurns = turn + 1;
        const remainingInMainBudget = maxToolTurns - completedTurns;
        if (!timeExpiredRevoked) {
            if (remainingInMainBudget === 10 || remainingInMainBudget === 5) {
                messages.push(new HumanMessage(buildRemainingToolCallsHarnessNote(remainingInMainBudget, maxToolTurns)));
            } else if (completedTurns === maxToolTurns) {
                messages.push(new HumanMessage(buildOvertimeFinalSubmitHarnessNote(maxToolTurns, OVERTIME_GRACE_TURNS)));
            } else if (completedTurns === maxToolTurns + OVERTIME_GRACE_TURNS) {
                messages.push(new HumanMessage(buildRevokedToolsFinalSubmitHarnessNote()));
            }
        }

        const remainingTimeMs = maxDurationMs - (Date.now() - sandboxStartedAt);
        if (remainingTimeMs <= 0) {
            if (!timeExpiredRevoked) {
                timeExpiredRevoked = true;
                messages.push(new HumanMessage(buildSandboxTimeExpiredFinalSubmitHarnessNote(maxMinutes)));
            }
        } else if (remainingTimeMs <= SANDBOX_WARNING_5_MIN_MS && !warned5MinRemaining) {
            warned5MinRemaining = warned10MinRemaining = true;
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

    const submittedText = expandInlineReferenceMarkers(finalText.trim(), sessionId, options.repositoryAccess).trim();
    const displayText = submittedText || transcriptParts.join('\n\n').trim();
    const loopMessages = messages.slice(loopStartIndex);
    const executionTrace: SandboxToolExecutionTrace = {
        schema: 'sandbox_tool_execution_trace.v1',
        sandbox_tool_name: SANDBOX_TOOL_NAME,
        agent: {
            name: options.agentName,
            provider: provider.providerName,
            model: provider.modelName,
            session_id: sessionId,
        },
        final_text: finalText,
        messages: loopMessages.map(buildTraceMessage),
    };
    const rawTrajectoryJsonl = buildRawTrajectoryJsonl([new SystemMessage(systemPrompt), ...messages]);

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

export const runContextualSandboxToolAgent = runSandboxToolAgent;
