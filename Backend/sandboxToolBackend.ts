import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { getEncoding } from 'js-tiktoken';
import { parse as parseBashAst } from 'just-bash';

const encoder = getEncoding('cl100k_base');


interface SeedFile {
    name?: string;
    mimeType: string;
    base64: string;
    relativePath?: string;
}

interface SandboxExecuteRequest {
    sessionId: string;
    command: string;
    files?: SeedFile[];
    timeoutMs?: number;
    repositoryAccess?: SandboxRepositoryAccessRequest;
}

interface SandboxRepositoryAccessRequest {
    repositoryId: string;
    /** Omitted for a read-only repository view. */
    agentDirectory?: string;
    agentDirectoryReadOnly?: boolean;
    readableDirectories?: string[];
    liveReadableDirectories?: string[];
    hiddenDirectories?: string[];
    /** Exposes the complete repository read-only. */
    fullRepositoryRead?: boolean;
    /** Exposes the complete repository read/write for the Adaptive orchestrator. */
    fullRepositoryWrite?: boolean;
    /** Immutable Git baseline used by read-only mounts. */
    revision?: string;
}

interface SandboxSessionMetadata {
    schema: 'iterative_studio_sandbox_session.v1';
    repositoryAccess?: SandboxRepositoryAccessRequest;
}

interface SandboxSessionSummary {
    sessionId: string;
    agentName: string;
    mode: 'legacy' | 'repository';
    repositoryAccess?: SandboxRepositoryAccessRequest;
}

/** A rendered Deepthink state is written only to the durable Results mirror.
 * The cache repository remains the private, permission-scoped agent workspace. */
interface DeepthinkResultsSnapshotRequest {
    repositoryId: string;
    commitMessage?: string;
    contextFiles?: Array<{
        path: string;
        content: string;
    }>;
}

interface DeepthinkResultsRepositoryMetadata {
    schema: 'iterative_studio_deepthink_results.v1';
    repositoryId: string;
    resultPath: string;
    createdAt: string;
}

interface VisibleImage {
    filename: string;
    mimeType: string;
    size: number;
    url: string;
    base64?: string;
    modifiedMs: number;
}

type ImageSnapshot = Map<string, { size: number; modifiedMs: number }>;

interface SandboxExecutionResult {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string | null;
    durationMs: number;
    timedOut?: boolean;
    readOnlyCommand?: boolean;
}

type SandboxRuntime = 'docker' | 'bwrap';

interface SandboxNestedMount {
    source: string;
    target: string;
    readonly: boolean;
}

interface SandboxCommandWorkspace {
    sessionId: string;
    rootHostPath: string;
    /** Actual shared repository root; differs from a filtered read-only view. */
    repositoryRootPath?: string;
    rootReadonly: boolean;
    tmpDir: string;
    commandCwd: string;
    nestedMounts: SandboxNestedMount[];
    visibleRootPath: string;
    writablePath: string;
    repositoryAccess?: SandboxRepositoryAccessRequest;
}

interface HostCommandResult {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}

interface SandboxEnvironmentProfile {
    ok: boolean;
    runtime: SandboxRuntime;
    sharedEnvironment: {
        mountPath: string;
        hostPath: string;
        enabled: boolean;
    };
    python: {
        available: boolean;
        executable?: string;
        version?: string;
        packageCount: number;
        packages: string[];
        failedPackages: string[];
    };
    node: {
        available: boolean;
        version?: string;
        packages: string[];
        failedPackages: string[];
    };
    lean: {
        available: boolean;
        version?: string;
        lakeVersion?: string;
        mathlibAvailable?: boolean;
        helperScripts: string[];
        error?: string;
    };
    commands: Array<{ name: string; available: boolean; version?: string }>;
    setupErrors: string[];
    agentSummary: string;
}

const VFS_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-vfs');
const REPOSITORY_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-repos');
const REPOSITORY_VIEW_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-views');
const ARTIFACT_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-artifacts');
// The agent-facing repository intentionally stays in /tmp. Results is a
// human-owned, durable Git mirror that contains only meaningful run artifacts.
const RESULTS_ROOT = process.env.ITERATIVE_STUDIO_RESULTS_ROOT || path.join(process.cwd(), 'Results');
const DEEPTHINK_RESULTS_METADATA_ROOT = path.join(os.tmpdir(), 'iterative-studio-deepthink-results');
const SESSION_METADATA_FILE = '.sandbox-session.json';
// Filesystem context is intentionally high-capacity; the remaining bound is
// only a practical server-memory guard for a single JSON/base64 request.
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TOOL_RESULT_OUTPUT_TOKENS = 5000;
const APP_BASE_PATH = '/Iterative-Contextual-Refinements';
const DEFAULT_SANDBOX_IMAGE = 'python:3.12-bookworm';
const DEFAULT_SANDBOX_CPUS = '2';
const DEFAULT_SANDBOX_MEMORY = '1g';
const DEFAULT_SANDBOX_PIDS_LIMIT = '256';
const SANDBOX_ENV_ROOT = process.env.ITERATIVE_STUDIO_SANDBOX_ENV_ROOT ||
    path.join(os.homedir(), '.cache', 'iterative-studio', 'sandbox-env');
const SANDBOX_ENV_MOUNT = '/sandbox-env';
const SANDBOX_ENV_BIN = path.join(SANDBOX_ENV_ROOT, 'bin');
const SANDBOX_PYTHON_ENV = path.join(SANDBOX_ENV_ROOT, 'python');
const SANDBOX_NODE_ENV = path.join(SANDBOX_ENV_ROOT, 'node');
const SANDBOX_LEAN_ELAN_HOME = path.join(SANDBOX_ENV_ROOT, 'lean', 'elan');
const SANDBOX_LEAN_ROOT = path.join(SANDBOX_ENV_ROOT, 'lean');
const SANDBOX_LEAN_MATHLIB_PROJECT_NAME = 'SandboxMathlib';
const SANDBOX_LEAN_MATHLIB_PROJECT = path.join(SANDBOX_LEAN_ROOT, SANDBOX_LEAN_MATHLIB_PROJECT_NAME);
const SANDBOX_LEAN_MATHLIB_READY_MARKER = path.join(SANDBOX_LEAN_MATHLIB_PROJECT, '.iterative-studio-mathlib-ready');
const SANDBOX_LEAN_MATHLIB_MOUNT = `${SANDBOX_ENV_MOUNT}/lean/${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}`;
const DEFAULT_LEAN_TOOLCHAIN = 'leanprover/lean4:stable';
const ELAN_INIT_URL = 'https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh';
const SANDBOX_RUST_ROOT = '/sandbox-rust';
const BWRAP_SYSTEM_MOUNTS = [
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
    '/etc',
    '/opt',
];

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
};

const IMAGE_SCAN_IGNORED_DIRECTORIES = new Set([
    '.tmp',
    '.cache',
    '.local',
    '.matplotlib',
    '.python_user_base',
    '.venv',
    'venv',
    'node_modules',
    '__pycache__',
]);

let cachedHostRustSysroot: string | null | undefined;
let sandboxEnvironmentPromise: Promise<SandboxEnvironmentProfile> | null = null;
const sessionWorkspacePrepLocks = new Map<string, Promise<void>>();
const activeSessionExecutions = new Map<string, number>();

const RTK_VERSION = 'v1.0.1';
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

function rewriteCommandWithRtk(command: string): string {
    const rtkExecutable = path.join(SANDBOX_ENV_BIN, 'rtk');
    try {
        accessSync(rtkExecutable, fsConstants.X_OK);
    } catch {
        return command;
    }

    const result = spawnSync(rtkExecutable, ['rewrite', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        env: getHostEnv({
            XDG_DATA_HOME: path.join(os.tmpdir(), 'iterative-studio-rtk-data'),
            XDG_CONFIG_HOME: path.join(os.tmpdir(), 'iterative-studio-rtk-config'),
        }),
    });

    if (!result.error && (result.status === 0 || result.status === 3)) {
        const rewritten = (result.stdout || '').trim();
        if (rewritten) {
            return rewritten;
        }
    }
    return command;
}

const DEFAULT_PYTHON_PACKAGES = [
    'numpy',
    'scipy',
    'pandas',
    'matplotlib',
    'seaborn',
    'pillow',
    'opencv-python-headless',
    'scikit-learn',
    'scikit-image',
    'sympy',
    'networkx',
    'requests',
    'httpx',
    'beautifulsoup4',
    'lxml',
    'html5lib',
    'pyyaml',
    'python-dateutil',
    'pytz',
    'tqdm',
    'rich',
    'plotly',
    'statsmodels',
    'mpmath',
    'pytest',
    'hypothesis',
    'imageio',
    'imageio-ffmpeg',
    'openpyxl',
    'xlsxwriter',
    'reportlab',
    'pypdf',
    'pdfplumber',
    'markdown',
    'pygments',
    'regex',
    'rapidfuzz',
    'attrs',
    'sortedcontainers',
    'joblib',
    'cloudpickle',
    'psutil',
];

const DEFAULT_NODE_PACKAGES = [
    'lodash',
    'axios',
    'cheerio',
    'dayjs',
    'zod',
    'yaml',
    'mathjs',
    'csv-parse',
    'csv-stringify',
    'fast-check',
];

const PROBED_COMMANDS = [
    'python',
    'python3',
    'node',
    'npm',
    'gcc',
    'g++',
    'rustc',
    'cargo',
    'lean',
    'lake',
    'curl',
    'git',
    'perl',
    'ruby',
    'go',
    'java',
    'javac',
    'Rscript',
    'julia',
    'lua',
    'rtk',
];

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, statusCode: number, message: string) {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(message);
}

function isSafeSessionId(sessionId: string): boolean {
    return /^[a-zA-Z0-9_-]{8,80}$/.test(sessionId);
}

function isSafeRepositoryId(repositoryId: string): boolean {
    return /^[a-zA-Z0-9_-]{4,80}$/.test(repositoryId);
}

function isSafeRepositoryDirectory(directory: string): boolean {
    if (!directory || directory.includes('\\') || directory.startsWith('/') || directory.endsWith('/')) return false;
    const segments = directory.split('/');
    return segments.every(segment => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(segment));
}

function getWorkspacePath(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
        throw new Error('Invalid sandbox session id.');
    }
    return path.join(VFS_ROOT, sessionId);
}

async function resolveRepositoryPath(repositoryId: string): Promise<string> {
    if (!isSafeRepositoryId(repositoryId)) {
        throw new Error('Invalid sandbox repository id.');
    }
    if (isDeepthinkRepository(repositoryId)) {
        const resultsPath = await ensureDeepthinkResultsRepository(repositoryId);
        if (resultsPath) return resultsPath;
    }
    return path.join(REPOSITORY_ROOT, repositoryId);
}

function isDeepthinkRepository(repositoryId: string): boolean {
    return repositoryId.startsWith('deepthink-') || repositoryId.startsWith('adaptive-deepthink-');
}

function getDeepthinkResultsMetadataPath(repositoryId: string): string {
    if (!isSafeRepositoryId(repositoryId)) {
        throw new Error('Invalid sandbox repository id.');
    }
    return path.join(DEEPTHINK_RESULTS_METADATA_ROOT, `${repositoryId}.json`);
}

function deepthinkResultDirectoryName(): string {
    // This keeps the requested deepthink_timestamp form while milliseconds
    // make parallel starts collision-safe without adding an opaque suffix.
    const timestamp = new Date().toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '_')
        .replace('Z', '');
    return `deepthink_${timestamp}`;
}

async function getDeepthinkResultsRepositoryPath(repositoryId: string): Promise<string | null> {
    if (!isDeepthinkRepository(repositoryId)) return null;

    try {
        const raw = await readFile(getDeepthinkResultsMetadataPath(repositoryId), 'utf8');
        const metadata = JSON.parse(raw) as DeepthinkResultsRepositoryMetadata;
        if (metadata?.schema === 'iterative_studio_deepthink_results.v1' && metadata.repositoryId === repositoryId) {
            if (await fileExists(metadata.resultPath)) return metadata.resultPath;
        }
    } catch {
        // Fall back to scanning RESULTS_ROOT
    }

    // Durable fallback: check directories in RESULTS_ROOT for .deepthink-meta.json
    try {
        const entries = await readdir(RESULTS_ROOT, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(RESULTS_ROOT, entry.name);
            const metaFile = path.join(dirPath, '.deepthink-meta.json');
            if (await fileExists(metaFile)) {
                try {
                    const raw = await readFile(metaFile, 'utf8');
                    const meta = JSON.parse(raw) as DeepthinkResultsRepositoryMetadata;
                    if (meta?.repositoryId === repositoryId) {
                        await mkdir(DEEPTHINK_RESULTS_METADATA_ROOT, { recursive: true });
                        await writeFile(getDeepthinkResultsMetadataPath(repositoryId), JSON.stringify(meta, null, 2)).catch(() => {});
                        return dirPath;
                    }
                } catch {
                    // Ignore JSON parse errors in corrupt meta
                }
            } else {
                const gzFile = path.join(dirPath, 'latest.gz');
                if (await fileExists(gzFile)) {
                    try {
                        const buf = await readFile(gzFile);
                        const decompressed = zlib.gunzipSync(buf);
                        const parsed = JSON.parse(decompressed.toString('utf8'));
                        const pId = parsed?.data?.modeState?.pipeline?.id;
                        if (pId === repositoryId) {
                            const meta: DeepthinkResultsRepositoryMetadata = {
                                schema: 'iterative_studio_deepthink_results.v1',
                                repositoryId,
                                resultPath: dirPath,
                                createdAt: new Date().toISOString(),
                            };
                            await writeFile(metaFile, JSON.stringify(meta, null, 2)).catch(() => {});
                            await mkdir(DEEPTHINK_RESULTS_METADATA_ROOT, { recursive: true });
                            await writeFile(getDeepthinkResultsMetadataPath(repositoryId), JSON.stringify(meta, null, 2)).catch(() => {});
                            return dirPath;
                        }
                    } catch {
                        // Ignore decompression or JSON parse errors
                    }
                }
            }
        }
    } catch {
        // Ignore read errors
    }

    return null;
}

async function ensureDeepthinkResultsRepository(repositoryId: string): Promise<string | null> {
    if (!isDeepthinkRepository(repositoryId)) return null;

    const existing = await getDeepthinkResultsRepositoryPath(repositoryId);
    if (existing) return existing;

    await mkdir(RESULTS_ROOT, { recursive: true });
    await mkdir(DEEPTHINK_RESULTS_METADATA_ROOT, { recursive: true });

    const resultDirectory = deepthinkResultDirectoryName();
    let resultPath = path.join(RESULTS_ROOT, resultDirectory);
    let suffix = 1;
    while (await fileExists(resultPath)) {
        resultPath = path.join(RESULTS_ROOT, `${resultDirectory}-${suffix++}`);
    }
    await mkdir(resultPath, { recursive: true });

    const metadata: DeepthinkResultsRepositoryMetadata = {
        schema: 'iterative_studio_deepthink_results.v1',
        repositoryId,
        resultPath,
        createdAt: new Date().toISOString(),
    };
    await writeFile(getDeepthinkResultsMetadataPath(repositoryId), JSON.stringify(metadata, null, 2));
    await writeFile(path.join(resultPath, '.deepthink-meta.json'), JSON.stringify(metadata, null, 2));
    // Make the directory a real Git repository at run start, even if an agent
    // decides it has no terminal command to execute before its first snapshot.
    await initAndCommitWorkspace(resultPath, 'Deepthink run initialized');
    return resultPath;
}

function getRepositoryViewPath(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
        throw new Error('Invalid sandbox session id.');
    }
    return path.join(REPOSITORY_VIEW_ROOT, sessionId);
}

function sanitizeRepositoryAccess(accessRequest: SandboxRepositoryAccessRequest | undefined): SandboxRepositoryAccessRequest | undefined {
    if (!accessRequest) return undefined;
    if (!isSafeRepositoryId(accessRequest.repositoryId)) {
        throw new Error('Invalid sandbox repository id.');
    }
    if (accessRequest.agentDirectory !== undefined && !isSafeRepositoryDirectory(accessRequest.agentDirectory)) {
        throw new Error('Invalid sandbox agent directory.');
    }
    if (accessRequest.revision !== undefined && !/^[0-9a-f]{7,64}$/i.test(accessRequest.revision)) {
        throw new Error('Invalid sandbox repository revision.');
    }

    const readableDirectories = Array.from(new Set(accessRequest.readableDirectories || []))
        .filter(directory => directory !== accessRequest.agentDirectory)
        .map(directory => {
            if (!isSafeRepositoryDirectory(directory)) {
                throw new Error(`Invalid readable sandbox directory: ${directory}`);
            }
            return directory;
        });
    const liveReadableDirectories = Array.from(new Set(accessRequest.liveReadableDirectories || []))
        .map(directory => {
            if (!isSafeRepositoryDirectory(directory) || !readableDirectories.includes(directory)) {
                throw new Error(`Invalid live-readable sandbox directory: ${directory}`);
            }
            return directory;
        });
    const hiddenDirectories = Array.from(new Set(accessRequest.hiddenDirectories || []))
        .map(directory => {
            if (!isSafeRepositoryDirectory(directory)) {
                throw new Error(`Invalid hidden sandbox directory: ${directory}`);
            }
            return directory;
        });

    return {
        repositoryId: accessRequest.repositoryId,
        ...(accessRequest.agentDirectory ? { agentDirectory: accessRequest.agentDirectory } : {}),
        ...(accessRequest.agentDirectoryReadOnly ? { agentDirectoryReadOnly: true } : {}),
        readableDirectories,
        liveReadableDirectories,
        hiddenDirectories,
        fullRepositoryRead: accessRequest.fullRepositoryRead === true,
        fullRepositoryWrite: accessRequest.fullRepositoryWrite === true,
        ...(accessRequest.revision ? { revision: accessRequest.revision } : {}),
    };
}


async function createActiveStrategyDirectory(repoRoot: string, strategyDirectory: string): Promise<void> {
    const activeDirectory = safeJoin(repoRoot, strategyDirectory);
    await mkdir(activeDirectory, { recursive: true });
    await mkdir(path.join(activeDirectory, 'Critique'), { recursive: true });
}

async function archiveStrategyRepositoryDirectory(repositoryId: string, strategyDirectory: string): Promise<{
    archivedDirectory?: string;
    activeDirectory: string;
}> {
    if (!/^Strategy-\d+$/.test(strategyDirectory)) {
        throw new Error('Only an active top-level Strategy-N directory can be archived.');
    }

    const repoRoot = await resolveRepositoryPath(repositoryId);
    const activeDirectory = safeJoin(repoRoot, strategyDirectory);
    const prunedRoot = safeJoin(repoRoot, 'Pruned_Strategies');
    await mkdir(repoRoot, { recursive: true });

    let archivedDirectory: string | undefined;
    if (await fileExists(activeDirectory)) {
        await mkdir(prunedRoot, { recursive: true });
        const existing = await readdir(prunedRoot, { withFileTypes: true }).catch(() => []);
        const replacementCount = existing.filter(entry => (
            entry.isDirectory() && new RegExp(`^${strategyDirectory}_pruned_\\d+`).test(entry.name)
        )).length;
        const archiveName = `${strategyDirectory}_pruned_${String(replacementCount + 1).padStart(2, '0')}`;
        await rename(activeDirectory, safeJoin(prunedRoot, archiveName));
        archivedDirectory = `Pruned_Strategies/${archiveName}`;
    }

    await createActiveStrategyDirectory(repoRoot, strategyDirectory);
    return { archivedDirectory, activeDirectory: strategyDirectory };
}

async function writeSessionMetadata(sessionId: string, metadata: SandboxSessionMetadata): Promise<void> {
    const workspace = getWorkspacePath(sessionId);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, SESSION_METADATA_FILE), JSON.stringify(metadata, null, 2));
}

async function readSessionMetadata(sessionId: string): Promise<SandboxSessionMetadata | null> {
    try {
        const raw = await readFile(path.join(getWorkspacePath(sessionId), SESSION_METADATA_FILE), 'utf8');
        const parsed = JSON.parse(raw) as SandboxSessionMetadata;
        if (parsed?.schema !== 'iterative_studio_sandbox_session.v1') return null;
        return parsed;
    } catch {
        return null;
    }
}

function getMimeType(filename: string): string | null {
    const ext = path.extname(filename).toLowerCase();
    if (IMAGE_MIME_BY_EXT[ext]) return IMAGE_MIME_BY_EXT[ext];
    const extraMimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.pdf': 'application/pdf',
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'application/css',
        '.json': 'application/json',
        '.jsonl': 'application/x-ndjson',
        '.svg': 'image/svg+xml'
    };
    return extraMimeTypes[ext] ?? null;
}

function normalizeApiPathname(pathname: string): string {
    if (pathname.startsWith(`${APP_BASE_PATH}/api/sandbox/`)) {
        return pathname.slice(APP_BASE_PATH.length);
    }
    return pathname;
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

function sanitizeFilename(name: string | undefined, mimeType: string, index: number): string {
    const fallback = `uploaded-image-${index + 1}${extensionForMimeType(mimeType)}`;
    const base = path.basename(name || fallback).replace(/[^\w.\- ()]/g, '_');
    const withName = base || fallback;
    return path.extname(withName) ? withName : `${withName}${extensionForMimeType(mimeType)}`;
}

function safeJoin(workspace: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error('Invalid virtual filesystem path.');
    }
    const resolved = path.resolve(workspace, normalized);
    const root = path.resolve(workspace);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error('Path escapes the virtual filesystem.');
    }
    return resolved;
}

async function fileExists(filename: string): Promise<boolean> {
    try {
        await access(filename);
        return true;
    } catch {
        return false;
    }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks: Buffer[] = [];

        req.on('data', chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('Sandbox tool request is too large.'));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });

        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function getConfiguredList(envValue: string | undefined, defaults: string[]): string[] {
    if (!envValue?.trim()) return defaults;
    return envValue
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function isSandboxEnvironmentPrewarmEnabled(): boolean {
    return isEnabledEnvValue(process.env.ITERATIVE_STUDIO_SANDBOX_PREWARM);
}

function isLeanPrewarmEnabled(): boolean {
    const leanSetting = process.env.ITERATIVE_STUDIO_SANDBOX_LEAN;
    return (isSandboxEnvironmentPrewarmEnabled() || isEnabledEnvValue(leanSetting)) && !isDisabledEnvValue(leanSetting);
}

function isMathlibPrewarmEnabled(): boolean {
    const mathlibSetting = process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB;
    return isLeanPrewarmEnabled() && !isDisabledEnvValue(mathlibSetting);
}

function getLeanToolchain(): string {
    return process.env.ITERATIVE_STUDIO_SANDBOX_LEAN_TOOLCHAIN || DEFAULT_LEAN_TOOLCHAIN;
}

function getMathlibRevision(leanVersionText: string): string {
    if (process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB_REV?.trim()) {
        return process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB_REV.trim();
    }

    const match = leanVersionText.match(/version\s+([0-9]+(?:\.[0-9]+){1,3})/i);
    return match ? `v${match[1]}` : 'v4.31.0';
}

function getHostEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...extra,
    };
}

function sharedToolPathForHost(): string {
    return [
        SANDBOX_ENV_BIN,
        path.join(SANDBOX_PYTHON_ENV, 'bin'),
        path.join(SANDBOX_NODE_ENV, 'node_modules', '.bin'),
        path.join(SANDBOX_LEAN_ELAN_HOME, 'bin'),
        process.env.PATH || '',
    ].filter(Boolean).join(path.delimiter);
}

async function runHostCommand(
    executable: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        maxOutputBytes?: number;
    } = {}
): Promise<HostCommandResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let spawnFailed = false;

        // Host-side environment probes must never spill logs into the app's
        // working directory. These are not agent commands, so retaining a
        // workspace-readable .last_* file has no value.

        const child = spawn(executable, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const append = (current: string, chunk: Buffer | string, wasTruncated: boolean) => {
            if (wasTruncated) return { value: current, truncated: true };
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            const nextText = current + text;
            if (encoder.encode(nextText).length > MAX_TOOL_RESULT_OUTPUT_TOKENS) {
                const tokens = encoder.encode(nextText).slice(0, MAX_TOOL_RESULT_OUTPUT_TOKENS);
                return { value: encoder.decode(tokens), truncated: true };
            }
            return { value: nextText, truncated: false };
        };

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            const result = append(stdout, chunk, stdoutTruncated);
            stdout = result.value;
            stdoutTruncated = result.truncated;
        });

        child.stderr.on('data', chunk => {
            const result = append(stderr, chunk, stderrTruncated);
            stderr = result.value;
            stderrTruncated = result.truncated;
        });

        child.on('error', error => {
            spawnFailed = true;
            clearTimeout(timer);
            resolve({
                ok: false,
                exitCode: 127,
                stdout,
                stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
            });
        });

        child.on('close', code => {
            if (spawnFailed) return;
            clearTimeout(timer);
            if (stdoutTruncated) stdout += `\n[stdout truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens]`;
            if (stderrTruncated) stderr += `\n[stderr truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens]`;
            const exitCode = timedOut ? 124 : (code ?? 1);
            resolve({
                ok: exitCode === 0,
                exitCode,
                stdout,
                stderr,
                timedOut,
            });
        });
    });
}

function commandPath(command: string, env?: NodeJS.ProcessEnv): string | null {
    const result = spawnSync('sh', ['-lc', `command -v "$1"`, 'sh', command], {
        encoding: 'utf8',
        env: getHostEnv(env),
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim() || null;
}

async function ensureSharedBinScripts(leanAvailable: boolean, mathlibAvailable: boolean): Promise<void> {
    await mkdir(SANDBOX_ENV_BIN, { recursive: true });

    if (leanAvailable) {
        const initMathlibScript = mathlibAvailable
            ? `#!/usr/bin/env bash
set -euo pipefail
raw_name="\${1:-LeanWork}"
name="$(printf '%s' "$raw_name" | sed 's/[^A-Za-z0-9_]/_/g')"
if [[ -z "$name" || "$name" =~ ^[0-9] ]]; then
  name="LeanWork_$name"
fi
shared="${SANDBOX_LEAN_MATHLIB_MOUNT}"
if [[ ! -d "$shared/.lake/packages/mathlib" ]]; then
  echo "Shared Mathlib project is unavailable at $shared." >&2
  exit 1
fi
if [[ -e "$name" ]]; then
  echo "Refusing to overwrite existing path: $name" >&2
  exit 1
fi
mkdir -p "$name/$name" "$name/.lake/packages"
cp "$shared/lean-toolchain" "$name/lean-toolchain"
cp "$shared/lake-manifest.json" "$name/lake-manifest.json"
awk -v project="$name" '
  BEGIN { q = sprintf("%c", 34) }
  /^name = / && topNameDone != 1 {
    print "name = " q project q;
    topNameDone = 1;
    next;
  }
  /^defaultTargets = / {
    print "defaultTargets = [" q project q "]";
    next;
  }
  /^\\[\\[lean_lib\\]\\]/ {
    inLeanLib = 1;
    print;
    next;
  }
  inLeanLib == 1 && /^name = / {
    print "name = " q project q;
    inLeanLib = 0;
    next;
  }
  { print }
' "$shared/lakefile.toml" > "$name/lakefile.toml"
for pkg in "$shared/.lake/packages/"*; do
  [[ -e "$pkg" ]] || continue
  ln -s "$pkg" "$name/.lake/packages/$(basename "$pkg")"
done
cat > "$name/$name.lean" <<LEAN
import $name.Basic
LEAN
cat > "$name/$name/Basic.lean" <<'LEAN'
import Mathlib

example (a b : Nat) : a + b = b + a := by
  exact Nat.add_comm a b
LEAN
echo "Created $name with shared Mathlib packages. Try: cd $name && lake env lean $name/Basic.lean"
`
            : `#!/usr/bin/env bash
set -euo pipefail
echo "Shared Mathlib is not available in this sandbox profile. Use standalone lean files or report that Mathlib verification is unavailable." >&2
exit 1
`;
        const checkLeanScript = `#!/usr/bin/env bash
set -euo pipefail
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
cat > "$tmpdir/SandboxProof.lean" <<'LEAN'
example (p q : Prop) : p ∧ q → q ∧ p := by
  intro h
  exact And.intro h.right h.left
LEAN
lean "$tmpdir/SandboxProof.lean"
lean --version
lake --version
`;
        await writeFile(path.join(SANDBOX_ENV_BIN, 'lean-init-mathlib'), initMathlibScript);
        await writeFile(path.join(SANDBOX_ENV_BIN, 'lean-check'), checkLeanScript);
        await chmod(path.join(SANDBOX_ENV_BIN, 'lean-init-mathlib'), 0o755);
        await chmod(path.join(SANDBOX_ENV_BIN, 'lean-check'), 0o755);
    }
}

async function getPythonPackageList(pythonExecutable: string): Promise<string[]> {
    const result = await runHostCommand(pythonExecutable, ['-m', 'pip', 'list', '--format=json'], {
        env: getHostEnv({ PATH: sharedToolPathForHost() }),
        timeoutMs: 60_000,
    });
    if (!result.ok) return [];

    try {
        const parsed = JSON.parse(result.stdout) as Array<{ name?: string }>;
        return parsed.map(item => item.name || '').filter(Boolean).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

async function ensurePythonEnvironment(setupErrors: string[]): Promise<{ packages: string[]; failedPackages: string[]; version?: string }> {
    const requestedPackages = getConfiguredList(process.env.ITERATIVE_STUDIO_SANDBOX_PYTHON_PACKAGES, DEFAULT_PYTHON_PACKAGES);
    const pythonExecutable = path.join(SANDBOX_PYTHON_ENV, 'bin', 'python');

    if (!isSandboxEnvironmentPrewarmEnabled()) {
        return { packages: [], failedPackages: [] };
    }

    try {
        await mkdir(SANDBOX_ENV_ROOT, { recursive: true });
        if (!commandPath(pythonExecutable)) {
            const venvResult = await runHostCommand('python3', ['-m', 'venv', SANDBOX_PYTHON_ENV], {
                env: getHostEnv({ PATH: sharedToolPathForHost() }),
                timeoutMs: 180_000,
            });
            if (!venvResult.ok) {
                setupErrors.push(`Python environment creation failed: ${venvResult.stderr || venvResult.stdout}`);
                return { packages: [], failedPackages: requestedPackages };
            }
        }

        await runHostCommand(pythonExecutable, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
            env: getHostEnv({ PATH: sharedToolPathForHost(), PIP_CACHE_DIR: path.join(SANDBOX_ENV_ROOT, 'pip-cache') }),
            timeoutMs: 180_000,
        });

        const installedBefore = new Set((await getPythonPackageList(pythonExecutable)).map(name => name.toLowerCase()));
        const missing = requestedPackages.filter(pkg => !installedBefore.has(pkg.toLowerCase()));
        const failedPackages: string[] = [];

        if (missing.length > 0) {
            const bulkInstall = await runHostCommand(pythonExecutable, ['-m', 'pip', 'install', '--prefer-binary', ...missing], {
                env: getHostEnv({ PATH: sharedToolPathForHost(), PIP_CACHE_DIR: path.join(SANDBOX_ENV_ROOT, 'pip-cache') }),
                timeoutMs: 20 * 60_000,
                maxOutputBytes: 512 * 1024,
            });

            if (!bulkInstall.ok) {
                for (const pkg of missing) {
                    const singleInstall = await runHostCommand(pythonExecutable, ['-m', 'pip', 'install', '--prefer-binary', pkg], {
                        env: getHostEnv({ PATH: sharedToolPathForHost(), PIP_CACHE_DIR: path.join(SANDBOX_ENV_ROOT, 'pip-cache') }),
                        timeoutMs: 5 * 60_000,
                        maxOutputBytes: 128 * 1024,
                    });
                    if (!singleInstall.ok) failedPackages.push(pkg);
                }
            }
        }

        const version = (await runHostCommand(pythonExecutable, ['--version'], {
            env: getHostEnv({ PATH: sharedToolPathForHost() }),
            timeoutMs: 30_000,
        })).stdout.trim();
        return {
            packages: await getPythonPackageList(pythonExecutable),
            failedPackages,
            version,
        };
    } catch (error) {
        setupErrors.push(`Python environment setup failed: ${error instanceof Error ? error.message : String(error)}`);
        return { packages: [], failedPackages: requestedPackages };
    }
}

async function getNodePackageList(): Promise<string[]> {
    const packageJsonPath = path.join(SANDBOX_NODE_ENV, 'package.json');
    try {
        const packageJson = await readFile(packageJsonPath, 'utf8');
        const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
        return Object.keys(parsed.dependencies || {}).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

async function ensureNodeEnvironment(setupErrors: string[]): Promise<{ available: boolean; version?: string; packages: string[]; failedPackages: string[] }> {
    const nodePath = commandPath('node');
    const npmPath = commandPath('npm');
    const requestedPackages = getConfiguredList(process.env.ITERATIVE_STUDIO_SANDBOX_NODE_PACKAGES, DEFAULT_NODE_PACKAGES);
    if (!nodePath || !npmPath || !isSandboxEnvironmentPrewarmEnabled()) {
        return { available: !!nodePath, packages: [], failedPackages: requestedPackages };
    }

    try {
        await mkdir(SANDBOX_NODE_ENV, { recursive: true });
        const existingPackages = new Set((await getNodePackageList()).map(name => name.toLowerCase()));
        const missing = requestedPackages.filter(pkg => !existingPackages.has(pkg.toLowerCase()));
        const failedPackages: string[] = [];

        if (missing.length > 0) {
            const install = await runHostCommand(npmPath, ['install', '--prefix', SANDBOX_NODE_ENV, ...missing], {
                env: getHostEnv({ PATH: sharedToolPathForHost() }),
                timeoutMs: 10 * 60_000,
                maxOutputBytes: 512 * 1024,
            });
            if (!install.ok) {
                for (const pkg of missing) {
                    const singleInstall = await runHostCommand(npmPath, ['install', '--prefix', SANDBOX_NODE_ENV, pkg], {
                        env: getHostEnv({ PATH: sharedToolPathForHost() }),
                        timeoutMs: 3 * 60_000,
                        maxOutputBytes: 128 * 1024,
                    });
                    if (!singleInstall.ok) failedPackages.push(pkg);
                }
            }
        }

        const version = (await runHostCommand(nodePath, ['--version'], {
            env: getHostEnv({ PATH: sharedToolPathForHost() }),
            timeoutMs: 30_000,
        })).stdout.trim();
        return {
            available: true,
            version,
            packages: await getNodePackageList(),
            failedPackages,
        };
    } catch (error) {
        setupErrors.push(`Node environment setup failed: ${error instanceof Error ? error.message : String(error)}`);
        return { available: true, packages: await getNodePackageList(), failedPackages: requestedPackages };
    }
}

async function ensureMathlibEnvironment(
    env: NodeJS.ProcessEnv,
    setupErrors: string[],
    leanVersionText: string
): Promise<{ available: boolean; error?: string }> {
    if (!isMathlibPrewarmEnabled()) {
        return { available: false };
    }

    try {
        if (await fileExists(SANDBOX_LEAN_MATHLIB_READY_MARKER)) {
            return { available: true };
        }

        await mkdir(SANDBOX_LEAN_ROOT, { recursive: true });
        const lakeBin = path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'lake');
        const mathlibRevision = getMathlibRevision(leanVersionText);
        const lakefilePath = path.join(SANDBOX_LEAN_MATHLIB_PROJECT, 'lakefile.toml');
        const mathlibPackagePath = path.join(SANDBOX_LEAN_MATHLIB_PROJECT, '.lake', 'packages', 'mathlib');

        if (!(await fileExists(lakefilePath)) || !(await fileExists(mathlibPackagePath))) {
            await rm(SANDBOX_LEAN_MATHLIB_PROJECT, { recursive: true, force: true });
            await mkdir(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, SANDBOX_LEAN_MATHLIB_PROJECT_NAME), { recursive: true });
            await mkdir(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, '.lake', 'packages'), { recursive: true });
            await writeFile(
                path.join(SANDBOX_LEAN_MATHLIB_PROJECT, 'lean-toolchain'),
                `leanprover/lean4:${mathlibRevision}\n`
            );
            await writeFile(
                lakefilePath,
                [
                    `name = "${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}"`,
                    'version = "0.1.0"',
                    'keywords = ["math"]',
                    `defaultTargets = ["${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}"]`,
                    '',
                    '[leanOptions]',
                    'pp.unicode.fun = true',
                    'relaxedAutoImplicit = false',
                    'weak.linter.mathlibStandardSet = true',
                    'maxSynthPendingDepth = 3',
                    '',
                    '[[require]]',
                    'name = "mathlib"',
                    'scope = "leanprover-community"',
                    `rev = "${mathlibRevision}"`,
                    '',
                    '[[lean_lib]]',
                    `name = "${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}"`,
                    '',
                ].join('\n')
            );
            await writeFile(
                path.join(SANDBOX_LEAN_MATHLIB_PROJECT, `${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}.lean`),
                `import ${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}.Basic\n`
            );
            await writeFile(
                path.join(SANDBOX_LEAN_MATHLIB_PROJECT, SANDBOX_LEAN_MATHLIB_PROJECT_NAME, 'Basic.lean'),
                [
                    'import Mathlib',
                    '',
                    'example (a b : Nat) : a + b = b + a := by',
                    '  exact Nat.add_comm a b',
                    '',
                ].join('\n')
            );

            const cloneMathlib = await runHostCommand('git', [
                'clone',
                '--depth',
                '1',
                '--branch',
                mathlibRevision,
                '--single-branch',
                'https://github.com/leanprover-community/mathlib4',
                mathlibPackagePath,
            ], {
                env,
                timeoutMs: 20 * 60_000,
                maxOutputBytes: 512 * 1024,
            });
            if (!cloneMathlib.ok) {
                throw new Error(cloneMathlib.stderr || cloneMathlib.stdout || 'Mathlib shallow clone failed.');
            }
        }

        const update = await runHostCommand(lakeBin, ['update'], {
            cwd: SANDBOX_LEAN_MATHLIB_PROJECT,
            env,
            timeoutMs: 15 * 60_000,
            maxOutputBytes: 512 * 1024,
        });
        if (!update.ok) {
            throw new Error(update.stderr || update.stdout || 'Mathlib lake update failed.');
        }

        const cacheGet = await runHostCommand(lakeBin, ['exe', 'cache', 'get'], {
            cwd: SANDBOX_LEAN_MATHLIB_PROJECT,
            env,
            timeoutMs: 45 * 60_000,
            maxOutputBytes: 512 * 1024,
        });
        if (!cacheGet.ok) {
            throw new Error(cacheGet.stderr || cacheGet.stdout || 'Mathlib cache fetch failed.');
        }

        await writeFile(SANDBOX_LEAN_MATHLIB_READY_MARKER, new Date().toISOString());
        return { available: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setupErrors.push(`Mathlib environment setup failed: ${message}`);
        return { available: false, error: message };
    }
}

async function ensureLeanEnvironment(setupErrors: string[]): Promise<SandboxEnvironmentProfile['lean']> {
    const leanBin = path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'lean');
    const lakeBin = path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'lake');

    if (!isLeanPrewarmEnabled()) {
        return { available: false, mathlibAvailable: false, helperScripts: [] };
    }

    try {
        await mkdir(SANDBOX_LEAN_ELAN_HOME, { recursive: true });
        await mkdir(path.join(SANDBOX_LEAN_ELAN_HOME, 'toolchains'), { recursive: true });
        if (!commandPath(leanBin) || !commandPath(lakeBin)) {
            const curlPath = commandPath('curl');
            if (!curlPath) {
                throw new Error('curl is required to install elan but was not found.');
            }

            const scriptPath = path.join(SANDBOX_ENV_ROOT, 'elan-init.sh');
            const download = await runHostCommand(curlPath, ['-fsSL', ELAN_INIT_URL, '-o', scriptPath], {
                env: getHostEnv({ PATH: sharedToolPathForHost() }),
                timeoutMs: 120_000,
            });
            if (!download.ok) {
                throw new Error(download.stderr || download.stdout || 'Failed to download elan installer.');
            }

            const install = await runHostCommand('sh', [
                scriptPath,
                '-y',
                '--no-modify-path',
                '--default-toolchain',
                getLeanToolchain(),
            ], {
                env: getHostEnv({
                    ELAN_HOME: SANDBOX_LEAN_ELAN_HOME,
                    PATH: sharedToolPathForHost(),
                }),
                timeoutMs: 10 * 60_000,
                maxOutputBytes: 512 * 1024,
            });
            if (!install.ok) {
                throw new Error(install.stderr || install.stdout || 'elan installation failed.');
            }
        }

        const env = getHostEnv({
            ELAN_HOME: SANDBOX_LEAN_ELAN_HOME,
            PATH: sharedToolPathForHost(),
        });
        const toolchainInstall = await runHostCommand(path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'elan'), ['toolchain', 'install', getLeanToolchain()], {
            env,
            timeoutMs: 15 * 60_000,
            maxOutputBytes: 512 * 1024,
        });
        const toolchainInstallText = `${toolchainInstall.stdout}\n${toolchainInstall.stderr}`;
        if (!toolchainInstall.ok && !/already installed/i.test(toolchainInstallText)) {
            throw new Error(toolchainInstall.stderr || toolchainInstall.stdout || 'Lean toolchain installation failed.');
        }

        const leanVersion = await runHostCommand(leanBin, ['--version'], { env, timeoutMs: 5 * 60_000 });
        const lakeVersion = await runHostCommand(lakeBin, ['--version'], { env, timeoutMs: 5 * 60_000 });
        const available = leanVersion.ok && lakeVersion.ok;
        if (!available) {
            throw new Error(leanVersion.stderr || lakeVersion.stderr || 'Lean binaries were installed but failed to run.');
        }

        const mathlib = await ensureMathlibEnvironment(env, setupErrors, leanVersion.stdout.trim());
        await ensureSharedBinScripts(true, mathlib.available);
        return {
            available: true,
            version: leanVersion.stdout.trim(),
            lakeVersion: lakeVersion.stdout.trim(),
            mathlibAvailable: mathlib.available,
            helperScripts: mathlib.available ? ['lean-check', 'lean-init-mathlib'] : ['lean-check'],
            error: mathlib.error,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setupErrors.push(`Lean environment setup failed: ${message}`);
        await ensureSharedBinScripts(false, false);
        return {
            available: false,
            mathlibAvailable: false,
            helperScripts: [],
            error: message,
        };
    }
}

function packagePreview(packages: string[], max = 28): string {
    if (packages.length <= max) return packages.join(', ');
    return `${packages.slice(0, max).join(', ')}, and ${packages.length - max} more`;
}

async function probeCommand(name: string): Promise<{ name: string; available: boolean; version?: string }> {
    const executable = commandPath(name, {
        PATH: sharedToolPathForHost(),
        ELAN_HOME: SANDBOX_LEAN_ELAN_HOME,
    });
    if (!executable) return { name, available: false };

    const versionArgs = name === 'python' || name === 'python3' ? ['--version'] : ['--version'];
    const version = await runHostCommand(executable, versionArgs, {
        env: getHostEnv({
            PATH: sharedToolPathForHost(),
            ELAN_HOME: SANDBOX_LEAN_ELAN_HOME,
        }),
        timeoutMs: 20_000,
        maxOutputBytes: 8 * 1024,
    });
    const firstLine = (version.stdout || version.stderr).split('\n').find(Boolean)?.trim();
    return { name, available: true, version: firstLine };
}

function buildAgentEnvironmentSummary(profile: Omit<SandboxEnvironmentProfile, 'agentSummary'>): string {
    const availableCommands = profile.commands.filter(command => command.available).map(command => command.name);
    const lines = [
        `- Workspace: isolated Linux directory at /workspace. Shared tool bundle, when present, is mounted read-only at ${SANDBOX_ENV_MOUNT}.`,
    ];

    if (!isSandboxEnvironmentPrewarmEnabled()) {
        lines.push('- Shared Python/Node package prewarm is disabled by default. Use available system/container tools, or create workspace-local environments for extra dependencies.');
    }

    if (profile.python.available && profile.python.packageCount > 0) {
        lines.push(`- Python: shared read-only environment on PATH with ${profile.python.packageCount} preinstalled packages, including ${packagePreview(profile.python.packages)}. For extra packages, create a workspace venv first.`);
    } else {
        lines.push('- Python: use python/python3 if available; create workspace-local virtual environments for extra packages.');
    }

    if (profile.node.available && profile.node.packages.length > 0) {
        lines.push(`- Node.js: available with shared packages via NODE_PATH, including ${packagePreview(profile.node.packages, 16)}.`);
    }

    if (profile.lean.available) {
        lines.push(profile.lean.mathlibAvailable
            ? '- Lean: lean and lake are available for proof checking. Use `lean file.lean` for standalone proofs, `lean-check` for a smoke test, and `lean-init-mathlib ProjectName` to create a workspace Lake project linked to the shared prewarmed Mathlib dependency cache.'
            : '- Lean: lean and lake are available for standalone proof checking. Use `lean file.lean` or `lean-check`; Mathlib is not prewarmed in this sandbox profile.');
    } else {
        lines.push('- Lean: not currently available in this sandbox profile; if formal proof checking is essential, report the setup error instead of pretending verification occurred.');
    }

    if (availableCommands.length > 0) {
        lines.push(`- Detected commands include: ${availableCommands.join(', ')}.`);
    }

    if (profile.python.failedPackages.length > 0 || profile.node.failedPackages.length > 0) {
        const failed = [...profile.python.failedPackages, ...profile.node.failedPackages];
        lines.push(`- Some optional package preinstalls failed: ${failed.join(', ')}. Install alternatives in /workspace if needed.`);
    }

    return lines.join('\n');
}

async function ensureRtkBinary(setupErrors: string[]): Promise<void> {
    const rtkBinaryPath = path.join(SANDBOX_ENV_BIN, 'rtk');
    try {
        accessSync(rtkBinaryPath, fsConstants.X_OK);
        return;
    } catch {
        // Install rtk binary into SANDBOX_ENV_BIN below
    }

    try {
        await mkdir(SANDBOX_ENV_BIN, { recursive: true });
        const archAsset = process.arch === 'arm64'
            ? 'rtk-aarch64-unknown-linux-gnu.tar.gz'
            : 'rtk-x86_64-unknown-linux-musl.tar.gz';
        const downloadUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${archAsset}`;
        const installResult = await runHostCommand(
            'bash',
            ['-lc', `curl -fsSL "${downloadUrl}" | tar -xz -C "${SANDBOX_ENV_BIN}" && chmod 755 "${rtkBinaryPath}"`],
            { timeoutMs: 60_000 }
        );
        if (!installResult.ok) {
            setupErrors.push(`rtk binary install failed: ${installResult.stderr || installResult.stdout}`);
        }
    } catch (error) {
        setupErrors.push(`rtk setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function buildSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile> {
    const setupErrors: string[] = [];

    await mkdir(SANDBOX_ENV_ROOT, { recursive: true });

    const [python, node, lean] = await Promise.all([
        ensurePythonEnvironment(setupErrors),
        ensureNodeEnvironment(setupErrors),
        ensureLeanEnvironment(setupErrors),
        ensureRtkBinary(setupErrors),
    ]);

    await ensureSharedBinScripts(lean.available, !!lean.mathlibAvailable);

    const commands = await Promise.all(PROBED_COMMANDS.map(command => probeCommand(command)));
    const pythonExecutable = commandPath('python', { PATH: sharedToolPathForHost() }) || undefined;
    const profileWithoutSummary: Omit<SandboxEnvironmentProfile, 'agentSummary'> = {
        ok: true,
        runtime: getSandboxRuntime(),
        sharedEnvironment: {
            mountPath: SANDBOX_ENV_MOUNT,
            hostPath: SANDBOX_ENV_ROOT,
            enabled: true,
        },
        python: {
            available: !!pythonExecutable,
            executable: pythonExecutable,
            version: python.version,
            packageCount: python.packages.length,
            packages: python.packages,
            failedPackages: python.failedPackages,
        },
        node,
        lean,
        commands,
        setupErrors,
    };

    return {
        ...profileWithoutSummary,
        agentSummary: buildAgentEnvironmentSummary(profileWithoutSummary),
    };
}

async function getSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile> {
    if (!sandboxEnvironmentPromise) {
        sandboxEnvironmentPromise = buildSandboxEnvironmentProfile();
    }
    return sandboxEnvironmentPromise;
}

async function seedWorkspaceFiles(workspace: string, files: SeedFile[] | undefined) {
    if (!files?.length) return;

    await mkdir(workspace, { recursive: true });
    const usedNames = new Set<string>();

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (!file?.mimeType || !file.base64) continue;

        const requestedPath = file.relativePath?.replace(/\\/g, '/');
        const requestedDirectory = requestedPath ? path.dirname(requestedPath) : '.';
        const requestedName = requestedPath ? path.basename(requestedPath) : file.name;
        let filename = sanitizeFilename(requestedName, file.mimeType, index);
        const ext = path.extname(filename);
        const stem = ext ? filename.slice(0, -ext.length) : filename;
        let suffix = 1;
        const keyFor = (name: string) => path.posix.join(requestedDirectory, name);
        while (usedNames.has(keyFor(filename))) {
            filename = `${stem}-${suffix}${ext}`;
            suffix++;
        }
        usedNames.add(keyFor(filename));

        const destination = safeJoin(workspace, requestedDirectory === '.' ? filename : `${requestedDirectory}/${filename}`);
        await mkdir(path.dirname(destination), { recursive: true });
        if (await fileExists(destination)) continue;
        await writeFile(destination, Buffer.from(file.base64, 'base64'));
    }
}

async function copyRepositoryRootFiles(repoRoot: string, viewRoot: string): Promise<void> {
    await mkdir(viewRoot, { recursive: true });
    const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async entry => {
        if (!entry.isFile()) return;
        const source = path.join(repoRoot, entry.name);
        const destination = path.join(viewRoot, entry.name);
        await copyFile(source, destination);
        await chmod(destination, 0o400).catch(() => undefined);
    }));
}

async function copyReadOnlyDirectory(
    source: string,
    destination: string,
    excludedRelativePaths: string[] = [],
    relativePath = ''
): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
    await mkdir(destination, { recursive: true });
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (excludedRelativePaths.some(excluded => childRelativePath === excluded || childRelativePath.startsWith(`${excluded}/`))) {
            continue;
        }
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            await copyReadOnlyDirectory(from, to, excludedRelativePaths, childRelativePath);
        } else if (entry.isFile()) {
            await copyFile(from, to);
            await chmod(to, 0o400).catch(() => undefined);
        }
    }
}

async function ensureRepositoryRevisionView(
    repoRoot: string,
    revision: string,
    privateScratchRoot: string,
): Promise<string> {
    const revisionRoot = path.join(privateScratchRoot, 'repository-revision');
    const markerPath = path.join(privateScratchRoot, '.repository-revision');
    const existingRevision = await readFile(markerPath, 'utf8').catch(() => '');
    if (existingRevision.trim() === revision && await fileExists(revisionRoot)) {
        return revisionRoot;
    }

    await rm(revisionRoot, { recursive: true, force: true });
    await mkdir(revisionRoot, { recursive: true });
    const tree = await runGitCommandBuffer(repoRoot, ['ls-tree', '-r', '-z', '--name-only', revision]);
    const files = tree.toString('utf8').split('\0').filter(Boolean);
    for (const relativePath of files) {
        if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
            throw new Error(`Unsafe path in sandbox repository revision: ${relativePath}`);
        }
        const content = await runGitCommandBuffer(repoRoot, ['show', `${revision}:${relativePath}`]);
        const destination = safeJoin(revisionRoot, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content);
        await chmod(destination, 0o400).catch(() => undefined);
    }
    await writeFile(markerPath, revision);
    return revisionRoot;
}

async function prepareSandboxWorkspace(
    sessionId: string,
    accessRequest: SandboxRepositoryAccessRequest | undefined,
    files: SeedFile[] | undefined
): Promise<SandboxCommandWorkspace> {
    const repositoryAccess = sanitizeRepositoryAccess(accessRequest);

    if (!repositoryAccess) {
        const workspace = getWorkspacePath(sessionId);
        await mkdir(workspace, { recursive: true });
        await seedWorkspaceFiles(workspace, files);
        return {
            sessionId,
            rootHostPath: workspace,
            rootReadonly: false,
            tmpDir: path.join(workspace, '.tmp'),
            commandCwd: '/workspace',
            nestedMounts: [],
            visibleRootPath: workspace,
            writablePath: workspace,
        };
    }

    const repoRoot = await resolveRepositoryPath(repositoryAccess.repositoryId);
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const ownDirectory = repositoryAccess.agentDirectory
        ? safeJoin(repoRoot, repositoryAccess.agentDirectory)
        : undefined;
    const viewRoot = getRepositoryViewPath(sessionId);
    const privateScratchRoot = getWorkspacePath(sessionId);

    await mkdir(repoRoot, { recursive: true });
    await mkdir(sharedTmpDir, { recursive: true });
    if (ownDirectory) {
        const strategyMatch = repositoryAccess.agentDirectory?.match(/^(Strategy-\d+)(?:\/(Critique))?$/);
        if (strategyMatch) {
            await createActiveStrategyDirectory(repoRoot, strategyMatch[1]);
        } else {
            await mkdir(ownDirectory, { recursive: true });
        }
        await mkdir(path.join(ownDirectory, '.tmp'), { recursive: true });
    }
    await mkdir(privateScratchRoot, { recursive: true });
    await mkdir(path.join(privateScratchRoot, '.tmp'), { recursive: true });
    await seedWorkspaceFiles(repoRoot, files);

    // The repository is the unit of history. Agent directories only define
    // execution-time access; they must not create independent git histories.
    if (!(await fileExists(path.join(repoRoot, '.git')))) {
        await initAndCommitWorkspace(repoRoot, 'Initial shared workspace seed');
    }
    const readRoot = repositoryAccess.revision
        ? await ensureRepositoryRevisionView(repoRoot, repositoryAccess.revision, privateScratchRoot)
        : repoRoot;
    await mkdir(path.join(readRoot, 'tmp'), { recursive: true });

    const directContextDirectory = 'direct_context';
    const uploadedDirectory = 'user_uploaded';
    const sourceDirectContext = safeJoin(readRoot, directContextDirectory);
    const sourceUploads = safeJoin(readRoot, uploadedDirectory);
    const readableDirectories = Array.from(new Set(repositoryAccess.readableDirectories || []));
    const liveReadableDirectories = new Set(repositoryAccess.liveReadableDirectories || []);
    const readableExistingDirectories = (await Promise.all(readableDirectories.map(async directory => ({
        directory,
        exists: await fileExists(safeJoin(liveReadableDirectories.has(directory) ? repoRoot : readRoot, directory)),
    })))).filter(item => item.exists).map(item => item.directory);
    const hiddenDirectories = repositoryAccess.hiddenDirectories || [];
    const fullRepositoryRead = repositoryAccess.fullRepositoryRead === true || repositoryAccess.fullRepositoryWrite === true;
    const fullRepositoryWrite = repositoryAccess.fullRepositoryWrite === true;
    const usesFilteredFullRepository = fullRepositoryRead && hiddenDirectories.length > 0;

    const hasActiveExecution = (activeSessionExecutions.get(sessionId) ?? 0) > 0;

    if (!fullRepositoryRead || usesFilteredFullRepository) {
        if (!hasActiveExecution) {
            await rm(viewRoot, { recursive: true, force: true });
        }
        await mkdir(viewRoot, { recursive: true });
        if (usesFilteredFullRepository) {
            await copyReadOnlyDirectory(readRoot, viewRoot, [...hiddenDirectories, 'tmp', '.tmp']);
        } else {
            await copyRepositoryRootFiles(readRoot, viewRoot);
            if (await fileExists(sourceDirectContext)) {
                await copyReadOnlyDirectory(sourceDirectContext, path.join(viewRoot, directContextDirectory));
            }
            if (await fileExists(sourceUploads)) {
                await copyReadOnlyDirectory(sourceUploads, path.join(viewRoot, uploadedDirectory));
            }

            for (const directory of [
                ...readableExistingDirectories,
                ...(repositoryAccess.agentDirectory ? [repositoryAccess.agentDirectory] : []),
                ...hiddenDirectories,
            ]) {
                await mkdir(path.join(viewRoot, directory), { recursive: true });
            }
        }
        await mkdir(path.join(viewRoot, 'tmp'), { recursive: true });
    }

    const readonlyMountRoot = path.join(privateScratchRoot, 'readonly-mounts');
    if (!hasActiveExecution) {
        await rm(readonlyMountRoot, { recursive: true, force: true });
    }
    const readableMounts = await Promise.all(readableExistingDirectories.map(async directory => {
        const excludedRelativePaths = hiddenDirectories
            .filter(hiddenDirectory => hiddenDirectory.startsWith(`${directory}/`))
            .map(hiddenDirectory => hiddenDirectory.slice(directory.length + 1));
        if (excludedRelativePaths.length === 0) {
            const sourceRoot = liveReadableDirectories.has(directory) ? repoRoot : readRoot;
            return { directory, source: safeJoin(sourceRoot, directory) };
        }

        const filteredSource = safeJoin(readonlyMountRoot, directory);
        const sourceRoot = liveReadableDirectories.has(directory) ? repoRoot : readRoot;
        await copyReadOnlyDirectory(safeJoin(sourceRoot, directory), filteredSource, excludedRelativePaths);
        return { directory, source: filteredSource };
    }));
    const isDescendantOfAgentDirectory = (directory: string) => !!repositoryAccess.agentDirectory
        && directory.startsWith(`${repositoryAccess.agentDirectory}/`);
    const beforeWritableMounts = readableMounts.filter(mount => !isDescendantOfAgentDirectory(mount.directory));
    const readonlyChildMounts = readableMounts.filter(mount => isDescendantOfAgentDirectory(mount.directory));
    const hiddenChildMounts = await Promise.all(hiddenDirectories
        .filter(directory => isDescendantOfAgentDirectory(directory))
        .map(async directory => {
            const source = safeJoin(readonlyMountRoot, `hidden/${directory}`);
            await mkdir(source, { recursive: true });
            return { directory, source };
        }));

    await writeSessionMetadata(sessionId, {
        schema: 'iterative_studio_sandbox_session.v1',
        repositoryAccess,
    });

    const rootHostPath = fullRepositoryRead && !usesFilteredFullRepository ? readRoot : viewRoot;
    const needsWorkspaceTmpMount = !fullRepositoryWrite || rootHostPath !== repoRoot;

    return {
        sessionId,
        rootHostPath,
        repositoryRootPath: repoRoot,
        rootReadonly: !fullRepositoryWrite,
        tmpDir: sharedTmpDir,
        commandCwd: repositoryAccess.agentDirectory ? `/workspace/${repositoryAccess.agentDirectory}` : '/workspace',
        nestedMounts: [
            ...(needsWorkspaceTmpMount ? [{
                source: sharedTmpDir,
                target: '/workspace/tmp',
                readonly: false,
            }] : []),
            ...((!fullRepositoryRead && await fileExists(sourceDirectContext)) ? [{
                source: sourceDirectContext,
                target: '/workspace/direct_context',
                readonly: true,
            }] : []),
            ...((!fullRepositoryRead && await fileExists(sourceUploads)) ? [{
                source: sourceUploads,
                target: '/workspace/user_uploaded',
                readonly: true,
            }] : []),
            ...beforeWritableMounts.map(mount => ({
                source: mount.source,
                target: `/workspace/${mount.directory}`,
                readonly: true,
            })),
            ...(repositoryAccess.agentDirectory ? [{
                source: safeJoin(repoRoot, repositoryAccess.agentDirectory),
                target: `/workspace/${repositoryAccess.agentDirectory}`,
                readonly: repositoryAccess.agentDirectoryReadOnly === true,
            }] : []),
            ...readonlyChildMounts.map(mount => ({
                source: mount.source,
                target: `/workspace/${mount.directory}`,
                readonly: true,
            })),
            ...hiddenChildMounts.map(mount => ({
                source: mount.source,
                target: `/workspace/${mount.directory}`,
                readonly: true,
            })),
        ],
        visibleRootPath: usesFilteredFullRepository ? viewRoot : readRoot,
        writablePath: fullRepositoryWrite ? repoRoot : ((!repositoryAccess.agentDirectoryReadOnly && ownDirectory) || sharedTmpDir),
        repositoryAccess,
    };
}

function gitWorkspaceFor(context: SandboxCommandWorkspace): string {
    return context.repositoryAccess ? (context.repositoryRootPath || context.visibleRootPath) : context.writablePath;
}

async function getWorkspaceContextForSession(sessionId: string): Promise<SandboxCommandWorkspace | null> {
    const metadata = await readSessionMetadata(sessionId);
    const repositoryAccess = sanitizeRepositoryAccess(metadata?.repositoryAccess);

    if (!repositoryAccess) {
        const workspace = getWorkspacePath(sessionId);
        if (!(await fileExists(workspace))) return null;
        return {
            sessionId,
            rootHostPath: workspace,
            rootReadonly: false,
            tmpDir: path.join(workspace, '.tmp'),
            commandCwd: '/workspace',
            nestedMounts: [],
            visibleRootPath: workspace,
            writablePath: workspace,
        };
    }

    const repoRoot = await resolveRepositoryPath(repositoryAccess.repositoryId);
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const readRoot = repositoryAccess.revision
        ? path.join(getWorkspacePath(sessionId), 'repository-revision')
        : repoRoot;
    const ownDirectory = repositoryAccess.agentDirectory
        ? safeJoin(repoRoot, repositoryAccess.agentDirectory)
        : undefined;
    if (!(await fileExists(repoRoot))) return null;
    return {
        sessionId,
        rootHostPath: repositoryAccess.fullRepositoryRead && !(repositoryAccess.hiddenDirectories || []).length
            ? readRoot
            : getRepositoryViewPath(sessionId),
        repositoryRootPath: repoRoot,
        rootReadonly: repositoryAccess.fullRepositoryWrite !== true,
        tmpDir: sharedTmpDir,
        commandCwd: repositoryAccess.agentDirectory ? `/workspace/${repositoryAccess.agentDirectory}` : '/workspace',
        nestedMounts: [],
        visibleRootPath: repositoryAccess.fullRepositoryRead && (repositoryAccess.hiddenDirectories || []).length
            ? getRepositoryViewPath(sessionId)
            : readRoot,
        writablePath: repositoryAccess.fullRepositoryWrite ? repoRoot : ((!repositoryAccess.agentDirectoryReadOnly && ownDirectory) || sharedTmpDir),
        repositoryAccess,
    };
}

/**
 * Repository explorer reads from the durable Results mirror whenever this is a
 * Deepthink run. The cache repository remains available only as a fallback
 * until the first rendered snapshot exists.
 */
async function getExplorerRepositoryRoot(workspace: SandboxCommandWorkspace): Promise<string> {
    const repositoryId = workspace.repositoryAccess?.repositoryId;
    if (repositoryId) {
        const resultsRepository = await getDeepthinkResultsRepositoryPath(repositoryId);
        if (resultsRepository && await fileExists(resultsRepository)) return resultsRepository;
    }
    return gitWorkspaceFor(workspace);
}

async function listImageFiles(
    workspace: string,
    sessionId: string,
    includeBase64: boolean,
    currentDir = workspace
): Promise<VisibleImage[]> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const images: VisibleImage[] = [];

    for (const entry of entries) {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(workspace, absolutePath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            if (IMAGE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) continue;
            if (relativePath.split('/').length < 4) {
                images.push(...await listImageFiles(workspace, sessionId, includeBase64, absolutePath));
            }
            continue;
        }

        if (!entry.isFile()) continue;
        const mimeType = getMimeType(entry.name);
        if (!mimeType) continue;

        const fileStat = await stat(absolutePath);

        const item: VisibleImage = {
            filename: relativePath,
            mimeType,
            size: fileStat.size,
            modifiedMs: fileStat.mtimeMs,
            url: `/api/sandbox/files/${encodeURIComponent(sessionId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
        };

        if (includeBase64) {
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                const stream = createReadStream(absolutePath);
                stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                stream.on('end', resolve);
                stream.on('error', reject);
            });
            item.base64 = Buffer.concat(chunks).toString('base64');
        }

        images.push(item);
    }

    return images.sort((a, b) => a.filename.localeCompare(b.filename));
}

function visibleRepositoryDirectories(context: SandboxCommandWorkspace): string[] {
    if (!context.repositoryAccess) return [];
    if (context.repositoryAccess.fullRepositoryRead) return [];
    return Array.from(new Set([
        ...(context.repositoryAccess.agentDirectory ? [context.repositoryAccess.agentDirectory] : []),
        ...(context.repositoryAccess.readableDirectories || []),
        'tmp',
        'direct_context',
        'user_uploaded',
    ]));
}

function isVisibleRepositoryPath(relativePath: string, visibleDirectories: string[]): boolean {
    return visibleDirectories.some(directory => relativePath === directory || relativePath.startsWith(`${directory}/`));
}

function isHiddenRepositoryPath(context: SandboxCommandWorkspace, relativePath: string): boolean {
    return (context.repositoryAccess?.hiddenDirectories || []).some(directory => (
        relativePath === directory || relativePath.startsWith(`${directory}/`)
    ));
}

function resolveVisiblePath(context: SandboxCommandWorkspace, relativePath: string): string {
    if (!context.repositoryAccess) {
        return safeJoin(context.visibleRootPath, relativePath);
    }

    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error('Invalid virtual filesystem path.');
    }

    if (isHiddenRepositoryPath(context, normalized)) {
        throw new Error('Path is not visible in this sandbox session.');
    }

    if ((normalized === 'tmp' || normalized.startsWith('tmp/')) && context.repositoryRootPath) {
        return safeJoin(context.repositoryRootPath, normalized);
    }

    if (context.repositoryAccess.fullRepositoryRead) {
        return safeJoin(context.visibleRootPath, normalized);
    }

    const visibleDirectories = visibleRepositoryDirectories(context);
    if (normalized.includes('/') && !isVisibleRepositoryPath(normalized, visibleDirectories)) {
        throw new Error('Path is not visible in this sandbox session.');
    }

    const liveDirectories = [
        'tmp',
        context.repositoryAccess.agentDirectory,
        ...(context.repositoryAccess.liveReadableDirectories || []),
    ].filter((directory): directory is string => !!directory);
    const resolvesFromLiveRepository = context.repositoryAccess.fullRepositoryWrite
        || liveDirectories.some(directory => normalized === directory || normalized.startsWith(`${directory}/`));
    const visibleRoot = resolvesFromLiveRepository && context.repositoryRootPath
        ? context.repositoryRootPath
        : context.visibleRootPath;

    return safeJoin(visibleRoot, normalized);
}

async function listRepositoryRootFiles(repoRoot: string): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (EXCLUDE_FILES.has(entry.name)) continue;
        const fullPath = path.join(repoRoot, entry.name);
        const fileStat = await stat(fullPath);
        files.push({
            path: entry.name,
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
        });
    }
    return files;
}

async function listVisibleFiles(context: SandboxCommandWorkspace): Promise<Array<{ path: string; size: number; mtime: number }>> {
    if (!context.repositoryAccess) {
        return walkDir(context.visibleRootPath, context.visibleRootPath);
    }

    if (context.repositoryAccess.fullRepositoryRead) {
        return walkDir(context.visibleRootPath, context.visibleRootPath);
    }

    const rootFiles = await listRepositoryRootFiles(context.visibleRootPath);
    const directoryFiles = await Promise.all(visibleRepositoryDirectories(context).map(async directory => {
        const hostDirectory = safeJoin(context.visibleRootPath, directory);
        if (!(await fileExists(hostDirectory))) return [];
        return walkDir(hostDirectory, context.visibleRootPath, relativePath => !isHiddenRepositoryPath(context, relativePath));
    }));

    const byPath = new Map<string, { path: string; size: number; mtime: number }>();
    [...rootFiles, ...directoryFiles.flat()].forEach(file => byPath.set(file.path, file));
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function listVisibleImageFiles(
    context: SandboxCommandWorkspace,
    includeBase64: boolean
): Promise<VisibleImage[]> {
    if (!context.repositoryAccess) {
        return listImageFiles(context.visibleRootPath, context.sessionId, includeBase64);
    }

    const files = await listVisibleFiles(context);
    const images: VisibleImage[] = [];
    for (const file of files) {
        const mimeType = getMimeType(file.path);
        if (!mimeType?.startsWith('image/')) continue;
        const absolutePath = resolveVisiblePath(context, file.path);
        const item: VisibleImage = {
            filename: file.path,
            mimeType,
            size: file.size,
            modifiedMs: file.mtime,
            url: `/api/sandbox/files/${encodeURIComponent(context.sessionId)}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        };

        if (includeBase64) {
            item.base64 = (await readFile(absolutePath)).toString('base64');
        }

        images.push(item);
    }
    return images;
}

function snapshotImages(images: VisibleImage[]): ImageSnapshot {
    return new Map(images.map(image => [image.filename, { size: image.size, modifiedMs: image.modifiedMs }]));
}

function getChangedImages(before: ImageSnapshot, after: VisibleImage[]): VisibleImage[] {
    return after.filter(image => {
        const previous = before.get(image.filename);
        if (!previous) return true;
        return previous.size !== image.size || Math.abs(previous.modifiedMs - image.modifiedMs) > 1;
    });
}

async function snapshotImagesForTranscript(
    images: VisibleImage[],
    resolveSource: (filename: string) => string,
): Promise<VisibleImage[]> {
    if (images.length === 0) return [];

    const artifactId = randomUUID();
    const artifactWorkspace = path.join(ARTIFACT_ROOT, artifactId);

    return Promise.all(images.map(async image => {
        const source = resolveSource(image.filename);
        const destination = safeJoin(artifactWorkspace, image.filename);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);

        return {
            ...image,
            url: `/api/sandbox/artifacts/${encodeURIComponent(artifactId)}/${image.filename.split('/').map(encodeURIComponent).join('/')}`,
        };
    }));
}

async function snapshotVisibleImagesForTranscript(context: SandboxCommandWorkspace, images: VisibleImage[]): Promise<VisibleImage[]> {
    return snapshotImagesForTranscript(
        images,
        filename => context.repositoryAccess
            ? resolveVisiblePath(context, filename)
            : safeJoin(context.visibleRootPath, filename),
    );
}


function getSandboxExecutable(): string {
    return process.env.ITERATIVE_STUDIO_DOCKER || 'docker';
}

function getBubblewrapExecutable(): string {
    return process.env.ITERATIVE_STUDIO_BWRAP || 'bwrap';
}

function getSandboxImage(): string {
    return process.env.ITERATIVE_STUDIO_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
}

function getSandboxNetworkMode(): string {
    return process.env.ITERATIVE_STUDIO_SANDBOX_NETWORK || 'bridge';
}

function isDisabledEnvValue(value: string | undefined): boolean {
    return /^(0|false|no|none|disabled)$/i.test((value || '').trim());
}

function isEnabledEnvValue(value: string | undefined): boolean {
    return /^(1|true|yes|on|enabled)$/i.test((value || '').trim());
}

function findRustSysrootWith(rustcExecutable: string): string | null {
    const result = spawnSync(rustcExecutable, ['--print', 'sysroot'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim() || null;
}

function isUsableRustSysroot(candidate: string): boolean {
    if (!candidate || candidate.includes('\0')) return false;
    const resolved = path.resolve(candidate);
    if (!path.isAbsolute(resolved)) return false;

    try {
        accessSync(path.join(resolved, 'bin', 'rustc'), fsConstants.X_OK);
        accessSync(path.join(resolved, 'bin', 'cargo'), fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function getHostRustSysroot(): string | null {
    if (cachedHostRustSysroot !== undefined) return cachedHostRustSysroot;

    const configured = process.env.ITERATIVE_STUDIO_SANDBOX_RUST_SYSROOT;
    if (isDisabledEnvValue(configured)) {
        cachedHostRustSysroot = null;
        return cachedHostRustSysroot;
    }

    const candidates = [
        configured?.trim(),
        findRustSysrootWith(process.env.ITERATIVE_STUDIO_RUSTC || 'rustc'),
        findRustSysrootWith(path.join(os.homedir(), '.cargo', 'bin', 'rustc')),
    ].filter((candidate): candidate is string => !!candidate);

    cachedHostRustSysroot = candidates
        .map(candidate => path.resolve(candidate))
        .find(isUsableRustSysroot) || null;
    return cachedHostRustSysroot;
}

function getSandboxPath(hostRustSysroot: string | null, workspaceHome = '/workspace'): string {
    const basePath = `${workspaceHome}/.local/bin:${workspaceHome}/.python_user_base/bin:/usr/local/bin:/usr/bin:/bin`;
    const sharedPath = [
        `${SANDBOX_ENV_MOUNT}/bin`,
        `${SANDBOX_ENV_MOUNT}/python/bin`,
        `${SANDBOX_ENV_MOUNT}/node/node_modules/.bin`,
        `${SANDBOX_ENV_MOUNT}/lean/elan/bin`,
    ].join(':');
    return hostRustSysroot ? `${sharedPath}:${SANDBOX_RUST_ROOT}/bin:${basePath}` : `${sharedPath}:${basePath}`;
}

function sandboxHomeDirectory(workspace: SandboxCommandWorkspace): string {
    return workspace.repositoryAccess && !workspace.repositoryAccess.agentDirectory
        ? '/tmp'
        : workspace.commandCwd;
}

function getSharedEnvironmentMountPath(): string | null {
    try {
        accessSync(SANDBOX_ENV_ROOT, fsConstants.R_OK);
        return SANDBOX_ENV_ROOT;
    } catch {
        return null;
    }
}

function getSandboxUser(): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    return `${uid}:${gid}`;
}

function commandExists(command: string): boolean {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

function canUseDockerSocket(): boolean {
    if (process.env.DOCKER_HOST) {
        return true;
    }

    try {
        accessSync('/var/run/docker.sock', fsConstants.R_OK | fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function getSandboxRuntime(): SandboxRuntime {
    const requested = (process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME || 'auto').toLowerCase();
    if (requested === 'docker') return 'docker';
    if (requested === 'bwrap' || requested === 'bubblewrap') return 'bwrap';
    if (canUseDockerSocket()) return 'docker';
    if (commandExists(getBubblewrapExecutable())) return 'bwrap';
    return 'docker';
}

function appendBounded(current: string, chunk: Buffer | string, wasTruncated: boolean): { value: string; truncated: boolean } {
    if (wasTruncated) return { value: current, truncated: true };
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const nextText = current + text;
    if (encoder.encode(nextText).length > MAX_TOOL_RESULT_OUTPUT_TOKENS) {
        const tokens = encoder.encode(nextText).slice(0, MAX_TOOL_RESULT_OUTPUT_TOKENS);
        return { value: encoder.decode(tokens), truncated: true };
    }
    return { value: nextText, truncated: false };
}

function dockerMount(source: string, target: string, readonly = false): string {
    return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

function buildDockerArgs(args: {
    workspace: SandboxCommandWorkspace,
    command: string,
    containerName: string,
    hostRustSysroot: string | null,
    viewDir: string,
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const rustMountArgs = args.hostRustSysroot
        ? ['--mount', dockerMount(args.hostRustSysroot, SANDBOX_RUST_ROOT, true)]
        : [];
    const sharedEnvironmentMount = getSharedEnvironmentMountPath();
    const sharedEnvironmentMountArgs = sharedEnvironmentMount
        ? ['--mount', dockerMount(sharedEnvironmentMount, SANDBOX_ENV_MOUNT, true)]
        : [];
    const nestedMountArgs = args.workspace.nestedMounts.flatMap(mount => [
        '--mount',
        dockerMount(mount.source, mount.target, mount.readonly)
    ]);

    return [
        'run',
        '--rm',
        '--name', args.containerName,
        '--workdir', args.workspace.commandCwd,
        '--user', getSandboxUser(),
        '--network', getSandboxNetworkMode(),
        '--cpus', process.env.ITERATIVE_STUDIO_SANDBOX_CPUS || DEFAULT_SANDBOX_CPUS,
        '--memory', process.env.ITERATIVE_STUDIO_SANDBOX_MEMORY || DEFAULT_SANDBOX_MEMORY,
        '--pids-limit', process.env.ITERATIVE_STUDIO_SANDBOX_PIDS_LIMIT || DEFAULT_SANDBOX_PIDS_LIMIT,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--mount', dockerMount(args.workspace.rootHostPath, '/workspace', args.workspace.rootReadonly),
        ...nestedMountArgs,
        '--mount', dockerMount(args.workspace.tmpDir, '/tmp'),
        ...sharedEnvironmentMountArgs,
        ...rustMountArgs,
        '--env', `HOME=${workspaceHome}`,
        '--env', 'TMPDIR=/tmp',
        '--env', `XDG_CACHE_HOME=${workspaceHome}/.cache`,
        '--env', 'XDG_DATA_HOME=/tmp/.local/share',
        '--env', 'XDG_CONFIG_HOME=/tmp/.config',
        '--env', 'MPLBACKEND=Agg',
        '--env', `MPLCONFIGDIR=${workspaceHome}/.matplotlib`,
        '--env', 'PYTHONUNBUFFERED=1',
        '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--env', `PYTHONUSERBASE=${workspaceHome}/.python_user_base`,
        '--env', `PIP_CACHE_DIR=${workspaceHome}/.cache/pip`,
        '--env', `NODE_PATH=${SANDBOX_ENV_MOUNT}/node/node_modules`,
        '--env', `ELAN_HOME=${SANDBOX_ENV_MOUNT}/lean/elan`,
        '--env', `CARGO_HOME=${workspaceHome}/.cargo`,
        '--env', `CARGO_TARGET_DIR=${workspaceHome}/target`,
        '--env', `PATH=${getSandboxPath(args.hostRustSysroot, workspaceHome)}`,
        getSandboxImage(),
        'bash',
        '-c',
        `umask 077; view() { mkdir -p "${args.viewDir}"; i=0; for f in "$@"; do i=$((i + 1)); touch -c "$f" 2>/dev/null || cp -- "$f" "${args.viewDir}/$i-$(basename "$f")" 2>/dev/null; done; }; open() { view "$@"; }; ${args.command}`,
    ];
}

function buildBubblewrapArgs(args: {
    workspace: SandboxCommandWorkspace,
    command: string,
    hostRustSysroot: string | null,
    viewDir: string,
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const networkMode = getSandboxNetworkMode();
    const mountArgs = BWRAP_SYSTEM_MOUNTS.flatMap(mountPath => [
        '--ro-bind-try',
        mountPath,
        mountPath,
    ]);
    const rustMountArgs = args.hostRustSysroot
        ? ['--dir', SANDBOX_RUST_ROOT, '--ro-bind', args.hostRustSysroot, SANDBOX_RUST_ROOT]
        : [];
    const sharedEnvironmentMount = getSharedEnvironmentMountPath();
    const sharedEnvironmentMountArgs = sharedEnvironmentMount
        ? ['--dir', SANDBOX_ENV_MOUNT, '--ro-bind', sharedEnvironmentMount, SANDBOX_ENV_MOUNT]
        : [];
    const workspaceRootArgs = args.workspace.rootReadonly
        ? ['--ro-bind', args.workspace.rootHostPath, '/workspace']
        : ['--bind', args.workspace.rootHostPath, '/workspace'];
    const nestedMountArgs = args.workspace.nestedMounts.flatMap(mount => (
        mount.readonly
            ? ['--ro-bind', mount.source, mount.target]
            : ['--bind', mount.source, mount.target]
    ));
    const networkArgs = networkMode === 'none' ? ['--unshare-net'] : [];

    return [
        '--die-with-parent',
        '--unshare-user',
        '--unshare-ipc',
        '--unshare-pid',
        '--unshare-uts',
        ...networkArgs,
        '--tmpfs', '/',
        '--dir', '/workspace',
        '--dir', '/tmp',
        '--dir', '/run',
        '--dir', '/run/systemd',
        '--proc', '/proc',
        '--dev', '/dev',
        ...mountArgs,
        '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
        '--ro-bind-try', '/run/NetworkManager', '/run/NetworkManager',
        ...sharedEnvironmentMountArgs,
        ...rustMountArgs,
        ...workspaceRootArgs,
        ...nestedMountArgs,
        '--bind', args.workspace.tmpDir, '/tmp',
        '--remount-ro', '/',
        '--chdir', args.workspace.commandCwd,
        '--clearenv',
        '--setenv', 'HOME', workspaceHome,
        '--setenv', 'TMPDIR', '/tmp',
        '--setenv', 'XDG_CACHE_HOME', `${workspaceHome}/.cache`,
        '--setenv', 'XDG_DATA_HOME', '/tmp/.local/share',
        '--setenv', 'XDG_CONFIG_HOME', '/tmp/.config',
        '--setenv', 'MPLBACKEND', 'Agg',
        '--setenv', 'MPLCONFIGDIR', `${workspaceHome}/.matplotlib`,
        '--setenv', 'PYTHONUNBUFFERED', '1',
        '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
        '--setenv', 'PYTHONUSERBASE', `${workspaceHome}/.python_user_base`,
        '--setenv', 'PIP_CACHE_DIR', `${workspaceHome}/.cache/pip`,
        '--setenv', 'NODE_PATH', `${SANDBOX_ENV_MOUNT}/node/node_modules`,
        '--setenv', 'ELAN_HOME', `${SANDBOX_ENV_MOUNT}/lean/elan`,
        '--setenv', 'CARGO_HOME', `${workspaceHome}/.cargo`,
        '--setenv', 'CARGO_TARGET_DIR', `${workspaceHome}/target`,
        '--setenv', 'PATH', getSandboxPath(args.hostRustSysroot, workspaceHome),
        'bash',
        '-c',
        `umask 077; view() { mkdir -p "${args.viewDir}"; i=0; for f in "$@"; do i=$((i + 1)); touch -c "$f" 2>/dev/null || cp -- "$f" "${args.viewDir}/$i-$(basename "$f")" 2>/dev/null; done; }; open() { view "$@"; }; ${args.command}`,
    ];
}

function getRuntimeInvocation(args: {
    runtime: SandboxRuntime,
    workspace: SandboxCommandWorkspace,
    command: string,
    containerName: string,
    viewDir: string,
}): { executable: string; args: string[] } {
    const hostRustSysroot = getHostRustSysroot();

    if (args.runtime === 'bwrap') {
        return {
            executable: getBubblewrapExecutable(),
            args: buildBubblewrapArgs({ ...args, hostRustSysroot }),
        };
    }

    return {
        executable: getSandboxExecutable(),
        args: buildDockerArgs({ ...args, hostRustSysroot }),
    };
}

async function stopContainer(runtime: SandboxRuntime, containerName: string): Promise<void> {
    if (runtime !== 'docker') return;

    await new Promise<void>(resolve => {
        const child = spawn(getSandboxExecutable(), ['rm', '-f', containerName], {
            stdio: 'ignore',
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
    });
}

async function runSandboxCommand(
    sessionId: string,
    workspace: SandboxCommandWorkspace,
    command: string,
    timeoutMs: number,
    viewDir = '/tmp/.sandbox-view',
): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const containerName = `iterative-studio-${sessionId}-${randomUUID().slice(0, 8)}`;
    const runtime = getSandboxRuntime();
    const readOnlyCommand = isReadOnlyBashCommand(command);
    const effectiveCommand = rewriteCommandWithRtk(command);

    await mkdir(workspace.tmpDir, { recursive: true });

    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let spawnFailed = false;

        // Tool output belongs in the response trace or in an explicit file that
        // an agent creates. Hidden shared .last_* files are intentionally gone.

        const invocation = getRuntimeInvocation({
            runtime,
            workspace,
            command: effectiveCommand,
            containerName,
            viewDir,
        });

        const child = spawn(invocation.executable, invocation.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timer = setTimeout(() => {
            timedOut = true;
            void stopContainer(runtime, containerName);
            child.kill('SIGKILL');
        }, boundedTimeout);

        child.stdout.on('data', chunk => {
            const result = appendBounded(stdout, chunk, stdoutTruncated);
            stdout = result.value;
            stdoutTruncated = result.truncated;
        });

        child.stderr.on('data', chunk => {
            const result = appendBounded(stderr, chunk, stderrTruncated);
            stderr = result.value;
            stderrTruncated = result.truncated;
        });

        child.on('error', error => {
            spawnFailed = true;
            clearTimeout(timer);
            resolve({
                ok: false,
                exitCode: 127,
                stdout,
                stderr,
                error: `Failed to start sandbox runtime '${runtime}' (${invocation.executable}): ${error.message}`,
                durationMs: Date.now() - startedAt,
                readOnlyCommand,
            });
        });

        child.on('close', code => {
            if (spawnFailed) return;
            clearTimeout(timer);
            if (stdoutTruncated) stdout += `\n[stdout truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens; redirect command output to an explicit workspace file when the full log matters]`;
            if (stderrTruncated) stderr += `\n[stderr truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens; redirect command output to an explicit workspace file when the full log matters]`;

            const exitCode = timedOut ? 124 : (code ?? 1);
            resolve({
                ok: exitCode === 0,
                exitCode,
                stdout,
                stderr,
                error: timedOut
                    ? `Sandbox command timed out after ${Math.round(boundedTimeout / 1000)} seconds. Files already written inside the workspace may remain.`
                    : null,
                timedOut,
                durationMs: Date.now() - startedAt,
                readOnlyCommand,
            });
        });
    });
}

function runGitCommandBuffer(workspace: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: workspace });
        const chunks: Buffer[] = [];
        let stderr = '';
        child.stdout.on('data', data => chunks.push(data));
        child.stderr.on('data', data => stderr += data);
        child.on('close', code => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`Git command "git ${args.join(' ')}" failed with code ${code}.\nStderr: ${stderr}`));
            }
        });
        child.on('error', err => reject(err));
    });
}

function runGitCommand(workspace: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: workspace });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => stdout += data);
        child.stderr.on('data', data => stderr += data);
        child.on('close', code => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Git command "git ${args.join(' ')}" failed with code ${code}.\nStderr: ${stderr}`));
            }
        });
        child.on('error', err => {
            reject(err);
        });
    });
}

async function ensureUntrackedGitExcludes(workspace: string) {
    try {
        const infoDir = path.join(workspace, '.git', 'info');
        await mkdir(infoDir, { recursive: true });
        const excludePath = path.join(infoDir, 'exclude');
        const existing = await readFile(excludePath, 'utf8').catch(() => '');
        const requiredPatterns = [
            '/tmp', '/tmp/', '/.tmp', '/.tmp/', '**/.tmp/',
            '/.cache', '/.cache/', '**/.cache/',
            '/.local', '/.local/', '**/.local/',
            '/.matplotlib', '/.matplotlib/', '**/.matplotlib/',
            '/.python_user_base', '/.python_user_base/', '**/.python_user_base/',
            '/.venv', '/.venv/', '/venv', '/venv/',
            '/node_modules', '/node_modules/', '**/node_modules/',
            '/__pycache__', '/__pycache__/', '**/__pycache__/',
            '/.ipynb_checkpoints', '**/.ipynb_checkpoints/',
            '/shared_workspace.md',
            '/.deepthink-meta.json',
            '/latest.gz',
        ];
        const missing = requiredPatterns.filter(pattern => !existing.split(/\r?\n/).includes(pattern));
        if (missing.length > 0) {
            const nextContent = `${existing.trimEnd()}\n${missing.join('\n')}\n`.replace(/^\n+/, '');
            await writeFile(excludePath, nextContent, 'utf8');
        }
    } catch {
        // Ignore if .git/info cannot be written
    }
}

async function initAndCommitWorkspace(workspace: string, commitMessage: string) {
    try {
        const hasGit = await fileExists(path.join(workspace, '.git'));
        if (!hasGit) {
            await runGitCommand(workspace, ['init']);
            await runGitCommand(workspace, ['config', 'user.name', 'Sandbox Agent']);
            await runGitCommand(workspace, ['config', 'user.email', 'agent@sandbox.local']);
        }
        await ensureUntrackedGitExcludes(workspace);
        await runGitCommand(workspace, ['add', '-A']);
        await runGitCommand(workspace, ['commit', '-m', commitMessage, '--allow-empty']);
    } catch (err) {
        console.warn('Failed to commit to sandbox git repository:', err);
    }
}

function isSafeResultsContextPath(relativePath: string): boolean {
    if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.endsWith('/')) return false;
    const segments = relativePath.split('/');
    if (segments.some(seg => seg === '..' || seg === '.' || !seg)) return false;
    return segments.every(segment => /^[a-zA-Z0-9][a-zA-Z0-9_.()+\-\s]{0,120}$/.test(segment));
}

async function syncDeepthinkResultsSnapshot(payload: DeepthinkResultsSnapshotRequest): Promise<string> {
    if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId) || !isDeepthinkRepository(payload.repositoryId)) {
        throw new Error('A Deepthink repository id is required for a Results snapshot.');
    }

    const repository = await resolveRepositoryPath(payload.repositoryId);
    await mkdir(repository, { recursive: true });

    const contextFiles = payload.contextFiles || [];
    for (const file of contextFiles) {
        if (!file || !isSafeResultsContextPath(file.path)) {
            throw new Error('Invalid Results context file.');
        }
        const destination = safeJoin(repository, file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        if ((file as any).base64) {
            await writeFile(destination, Buffer.from((file as any).base64, 'base64'));
        } else if (typeof file.content === 'string') {
            await writeFile(destination, file.content, 'utf8');
        }
    }

    await initAndCommitWorkspace(repository, payload.commitMessage || 'Deepthink Results snapshot');
    return repository;
}

async function withSessionPrepLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionWorkspacePrepLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
        release = resolve;
    });
    sessionWorkspacePrepLocks.set(lockKey, previous.then(() => next));
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (sessionWorkspacePrepLocks.get(lockKey) === next) {
            sessionWorkspacePrepLocks.delete(lockKey);
        }
    }
}

async function handleExecute(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody) as SandboxExecuteRequest;
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';

    if (!command) {
        sendJson(res, 400, { ok: false, error: 'No sandbox command was provided.' });
        return;
    }

    await getSandboxEnvironmentProfile();
    const executionViewId = randomUUID().slice(0, 8);
    const sandboxViewMountDir = `/tmp/.sandbox-view-${executionViewId}`;

    const { workspace, viewedImagesRoot, beforeImages } = await withSessionPrepLock(payload.sessionId, async () => {
        const preparedWorkspace = await prepareSandboxWorkspace(payload.sessionId, payload.repositoryAccess, payload.files);
        const viewHostRoot = path.join(preparedWorkspace.tmpDir, `.sandbox-view-${executionViewId}`);
        await rm(viewHostRoot, { recursive: true, force: true });

        // Legacy sessions retain their own workspace history. Repository sessions
        // are initialized once at the shared root above.
        const hasGit = await fileExists(path.join(gitWorkspaceFor(preparedWorkspace), '.git'));
        if (!hasGit) {
            await initAndCommitWorkspace(gitWorkspaceFor(preparedWorkspace), 'Initial workspace seed');
        }

        const initialImages = snapshotImages(await listVisibleImageFiles(preparedWorkspace, false));
        activeSessionExecutions.set(payload.sessionId, (activeSessionExecutions.get(payload.sessionId) ?? 0) + 1);
        return {
            workspace: preparedWorkspace,
            viewedImagesRoot: viewHostRoot,
            beforeImages: initialImages,
        };
    });

    let execution: SandboxExecutionResult;
    try {
        execution = await runSandboxCommand(
            payload.sessionId,
            workspace,
            command,
            payload.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            sandboxViewMountDir,
        );
    } finally {
        const remaining = (activeSessionExecutions.get(payload.sessionId) ?? 1) - 1;
        if (remaining <= 0) {
            activeSessionExecutions.delete(payload.sessionId);
        } else {
            activeSessionExecutions.set(payload.sessionId, remaining);
        }
    }

    // Removed automatic post-execution git commit to prevent too many git revisions

    const imagesAfterExecution = await listVisibleImageFiles(workspace, true);
    const visibleFiles = await listVisibleImageFiles(workspace, false);
    const changedImages = getChangedImages(beforeImages, imagesAfterExecution);
    const generatedTranscriptImages = await snapshotVisibleImagesForTranscript(workspace, changedImages);
    const viewedImages = await fileExists(viewedImagesRoot)
        ? await listImageFiles(viewedImagesRoot, payload.sessionId, true)
        : [];
    const viewedTranscriptImages = await snapshotImagesForTranscript(
        viewedImages,
        filename => safeJoin(viewedImagesRoot, filename),
    );
    await rm(viewedImagesRoot, { recursive: true, force: true }).catch(() => undefined);

    sendJson(res, 200, {
        ...execution,
        sessionId: payload.sessionId,
        images: [...generatedTranscriptImages, ...viewedTranscriptImages],
        visibleFiles,
    });
}

async function handleCommit(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const rawBody = await readRequestBody(req);
        const payload = JSON.parse(rawBody) as { sessionId: string; commitMessage?: string };
        
        if (!payload.sessionId) {
            sendJson(res, 400, { ok: false, error: 'sessionId is required.' });
            return;
        }

        const workspace = await getWorkspaceContextForSession(payload.sessionId);
        if (!workspace || !(await fileExists(gitWorkspaceFor(workspace)))) {
            sendJson(res, 404, { ok: false, error: `Workspace not found for session ${payload.sessionId}` });
            return;
        }

        await initAndCommitWorkspace(gitWorkspaceFor(workspace), payload.commitMessage || 'Workspace snapshot');
        sendJson(res, 200, { ok: true });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleSnapshot(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const payload = JSON.parse(await readRequestBody(req)) as { sessionId?: string; repositoryId?: string; commitMessage?: string };
        let workspace: string | null = null;
        if (payload.repositoryId && isSafeRepositoryId(payload.repositoryId)) {
            workspace = await resolveRepositoryPath(payload.repositoryId);
        } else if (payload.sessionId && isSafeSessionId(payload.sessionId)) {
            const context = await getWorkspaceContextForSession(payload.sessionId);
            workspace = context ? gitWorkspaceFor(context) : null;
        }
        if (!workspace || !(await fileExists(workspace))) {
            sendJson(res, 404, { ok: false, error: 'Workspace not found.' });
            return;
        }
        await initAndCommitWorkspace(workspace, payload.commitMessage || 'Workspace snapshot');
        const commit = await runGitCommand(workspace, ['rev-parse', 'HEAD']).catch(() => '');
        sendJson(res, 200, { ok: true, commit });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleRestoreStrategy(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const payload = JSON.parse(await readRequestBody(req)) as {
            repositoryId?: string;
            strategyDirectory?: string;
            commit?: string;
        };
        if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
            throw new Error('A valid repository id is required.');
        }
        if (!payload.strategyDirectory || !/^Strategy-\d+$/.test(payload.strategyDirectory)) {
            throw new Error('Only an active top-level Strategy-N directory can be restored.');
        }
        if (!payload.commit || !/^[0-9a-f]{7,64}$/i.test(payload.commit)) {
            throw new Error('A valid Git checkpoint is required.');
        }

        const repository = await resolveRepositoryPath(payload.repositoryId);
        if (!(await fileExists(path.join(repository, '.git')))) {
            throw new Error('Sandbox repository was not found.');
        }

        await runGitCommand(repository, ['restore', `--source=${payload.commit}`, '--staged', '--worktree', '--', payload.strategyDirectory]);
        await runGitCommand(repository, ['clean', '-fd', '--', payload.strategyDirectory]);
        sendJson(res, 200, { ok: true });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleDeepthinkResultsSnapshot(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const payload = JSON.parse(await readRequestBody(req)) as DeepthinkResultsSnapshotRequest;
        const resultPath = await syncDeepthinkResultsSnapshot(payload);
        sendJson(res, 200, { ok: true, resultPath });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleEnsureDeepthinkRepository(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string };
        if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId) || !isDeepthinkRepository(payload.repositoryId)) {
            sendJson(res, 400, { ok: false, error: 'A valid Deepthink repository id is required.' });
            return;
        }
        const resultPath = await ensureDeepthinkResultsRepository(payload.repositoryId);
        sendJson(res, 200, { ok: true, resultPath });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleSaveLatestGz(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const rawBody = await readRequestBody(req);
        const payload = JSON.parse(rawBody) as {
            repositoryId?: string;
            state?: unknown;
            gzBase64?: string;
        };

        if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
            sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
            return;
        }

        let repoPath = await getDeepthinkResultsRepositoryPath(payload.repositoryId);
        if (!repoPath) {
            repoPath = await ensureDeepthinkResultsRepository(payload.repositoryId);
        }
        if (!repoPath || !(await fileExists(repoPath))) {
            sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
            return;
        }

        const latestGzPath = path.join(repoPath, 'latest.gz');

        if (payload.gzBase64) {
            const buffer = Buffer.from(payload.gzBase64, 'base64');
            await writeFile(latestGzPath, buffer);
        } else if (payload.state) {
            const jsonBuffer = Buffer.from(JSON.stringify(payload.state), 'utf8');
            const compressed = zlib.gzipSync(jsonBuffer);
            await writeFile(latestGzPath, compressed);
        } else {
            sendJson(res, 400, { ok: false, error: 'Either state or gzBase64 is required.' });
            return;
        }

        sendJson(res, 200, { ok: true, path: latestGzPath, repositoryId: payload.repositoryId });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleOpenDirectory(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    try {
        const rawBody = await readRequestBody(req);
        const payload = JSON.parse(rawBody || '{}') as {
            repositoryId?: string;
        };

        await mkdir(RESULTS_ROOT, { recursive: true });
        let targetPath = RESULTS_ROOT;

        if (payload.repositoryId) {
            if (!isSafeRepositoryId(payload.repositoryId)) {
                sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
                return;
            }
            const repoPath = await getDeepthinkResultsRepositoryPath(payload.repositoryId);
            if (repoPath && (await fileExists(repoPath))) {
                targetPath = repoPath;
            }
        }

        let cmd = 'xdg-open';
        let args = [targetPath];
        if (process.platform === 'win32') {
            cmd = 'explorer.exe';
            args = [targetPath];
        } else if (process.platform === 'darwin') {
            cmd = 'open';
            args = [targetPath];
        }

        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        child.on('error', (err) => {
            console.warn('Notice: failed to open directory in system file manager:', err);
        });

        sendJson(res, 200, { ok: true, path: targetPath });
    } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
}

async function handleArchiveStrategy(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string; strategyDirectory?: string };
    if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
        sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
        return;
    }
    if (!payload.strategyDirectory || !isSafeRepositoryDirectory(payload.strategyDirectory)) {
        sendJson(res, 400, { ok: false, error: 'A valid strategyDirectory is required.' });
        return;
    }

    const archived = await archiveStrategyRepositoryDirectory(payload.repositoryId, payload.strategyDirectory);
    sendJson(res, 200, { ok: true, ...archived });
}


async function handleEnvironment(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    const profile = await getSandboxEnvironmentProfile();
    sendJson(res, 200, profile);
}

async function handleFileRequest(pathname: string, res: ServerResponse) {
    const prefix = '/api/sandbox/files/';
    const encodedRest = pathname.slice(prefix.length);
    const slashIndex = encodedRest.indexOf('/');

    if (slashIndex === -1) {
        sendText(res, 404, 'Image file not found.');
        return;
    }

    const sessionId = decodeURIComponent(encodedRest.slice(0, slashIndex));
    const relativePath = encodedRest
        .slice(slashIndex + 1)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
    const workspace = await getWorkspaceContextForSession(sessionId);
    if (!workspace) {
        sendText(res, 404, 'Image file not found.');
        return;
    }

    let absolutePath: string;
    try {
        absolutePath = resolveVisiblePath(workspace, relativePath);
    } catch {
        sendText(res, 404, 'Image file not found.');
        return;
    }
    const mimeType = getMimeType(absolutePath) || 'text/plain; charset=utf-8';

    if (!(await fileExists(absolutePath))) {
        if (workspace.repositoryAccess?.agentDirectory && !relativePath.startsWith(`${workspace.repositoryAccess.agentDirectory}/`)) {
            const fallbackPath = safeJoin(workspace.visibleRootPath, `${workspace.repositoryAccess.agentDirectory}/${relativePath}`);
            if (await fileExists(fallbackPath)) {
                absolutePath = fallbackPath;
            }
        }
    }

    if (!(await fileExists(absolutePath))) {
        sendText(res, 404, 'File not found.');
        return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'no-store');
    createReadStream(absolutePath).pipe(res);
}

async function handleArtifactRequest(pathname: string, res: ServerResponse) {
    const prefix = '/api/sandbox/artifacts/';
    const encodedRest = pathname.slice(prefix.length);
    const slashIndex = encodedRest.indexOf('/');

    if (slashIndex === -1) {
        sendText(res, 404, 'Image artifact not found.');
        return;
    }

    const artifactId = decodeURIComponent(encodedRest.slice(0, slashIndex));
    if (!isSafeSessionId(artifactId)) {
        sendText(res, 404, 'Image artifact not found.');
        return;
    }

    const relativePath = encodedRest
        .slice(slashIndex + 1)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
    const artifactWorkspace = path.join(ARTIFACT_ROOT, artifactId);
    const absolutePath = safeJoin(artifactWorkspace, relativePath);
    const mimeType = getMimeType(absolutePath) || 'text/plain; charset=utf-8';

    if (!(await fileExists(absolutePath))) {
        sendText(res, 404, 'Artifact not found.');
        return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'no-store');
    createReadStream(absolutePath).pipe(res);
}

function getFriendlyAgentName(sessionId: string, repositoryAccess?: SandboxRepositoryAccessRequest): string {
    const repositorySuffix = repositoryAccess?.agentDirectory
        ? ` - /workspace/${repositoryAccess.agentDirectory}`
        : '';

    if (sessionId.startsWith('ctx-sess-')) {
        const parts = sessionId.split('-');
        const namePart = parts.slice(3).join(' ');
        if (namePart) {
            return `${namePart.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}${repositorySuffix}`;
        }
        return `Contextual Agent${repositorySuffix}`;
    } else if (sessionId.startsWith('dtsb-')) {
        const parts = sessionId.split('-');
        let kind = '';
        let strategy = '';
        let sub = '';
        let version = '';
        for (const part of parts) {
            if (/^s\d+$/.test(part)) {
                strategy = part.toUpperCase();
            } else if (/^main\d+$/.test(part)) {
                strategy = 'S' + part.slice(4);
            } else if (/^ss\d+$/.test(part)) {
                sub = part.toUpperCase();
            } else if (/^sub\d+$/.test(part)) {
                sub = 'Sub ' + part.slice(3);
            } else if (part === 'direct') {
                sub = '';
            } else if (/^v\d+$/.test(part)) {
                version = part;
            }
        }
        if (sessionId.includes('modules-testing')) kind = 'Modules Testing';
        else if (sessionId.includes('solution-attempt')) kind = 'Solution Attempt';
        else if (sessionId.includes('solution-critique')) kind = 'Solution Critique';
        else if (sessionId.includes('solution-correction')) kind = 'Solution Correction';
        else kind = 'Deepthink Agent';

        let details = [strategy, sub, version].filter(Boolean).join(' - ');
        return `${details ? `${kind} (${details})` : kind}${repositorySuffix}`;
    }
    return `${sessionId}${repositorySuffix}`;
}

async function buildSessionSummary(sessionId: string): Promise<SandboxSessionSummary> {
    const metadata = await readSessionMetadata(sessionId);
    const repositoryAccess = sanitizeRepositoryAccess(metadata?.repositoryAccess);
    return {
        sessionId,
        agentName: getFriendlyAgentName(sessionId, repositoryAccess),
        mode: repositoryAccess ? 'repository' : 'legacy',
        repositoryAccess,
    };
}

async function handleListSessions(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const prefix = parsedUrl.searchParams.get('prefix') || '';

    try {
        const exists = await fileExists(VFS_ROOT);
        if (!exists) {
            sendJson(res, 200, []);
            return;
        }
        const entries = await readdir(VFS_ROOT, { withFileTypes: true });
        const sessions: SandboxSessionSummary[] = [];
        for (const entry of entries) {
            if (entry.isDirectory() && isSafeSessionId(entry.name)) {
                if (!prefix || entry.name.includes(prefix)) {
                    try {
                        sessions.push(await buildSessionSummary(entry.name));
                    } catch {
                        sessions.push({
                            sessionId: entry.name,
                            agentName: getFriendlyAgentName(entry.name),
                            mode: 'legacy',
                        });
                    }
                }
            }
        }
        sendJson(res, 200, sessions);
    } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) });
    }
}

interface ExplorerRepositoryTarget {
    root: string;
    workspace?: SandboxCommandWorkspace;
    isRepositoryView: boolean;
}

async function resolveExplorerRepositoryTarget(args: {
    sessionId?: string;
    repositoryId?: string;
    repositoryScope?: boolean;
}): Promise<ExplorerRepositoryTarget | null> {
    if (args.repositoryId) {
        if (!isSafeRepositoryId(args.repositoryId)) return null;
        if (isDeepthinkRepository(args.repositoryId)) {
            const resultsRepository = await getDeepthinkResultsRepositoryPath(args.repositoryId);
            if (resultsRepository && (await fileExists(resultsRepository))) {
                return { root: resultsRepository, isRepositoryView: true };
            }
            return null;
        }
        const repository = await resolveRepositoryPath(args.repositoryId);
        if (await fileExists(repository)) return { root: repository, isRepositoryView: true };
        return null;
    }

    if (!args.sessionId || !isSafeSessionId(args.sessionId)) return null;
    const workspace = await getWorkspaceContextForSession(args.sessionId);
    if (!workspace) return null;
    const isRepositoryView = args.repositoryScope === true && !!workspace.repositoryAccess;
    return {
        root: isRepositoryView ? await getExplorerRepositoryRoot(workspace) : gitWorkspaceFor(workspace),
        workspace,
        isRepositoryView,
    };
}

async function handleGetHistory(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const target = await resolveExplorerRepositoryTarget({
        sessionId: parsedUrl.searchParams.get('sessionId') || undefined,
        repositoryId: parsedUrl.searchParams.get('repositoryId') || undefined,
        repositoryScope: true,
    });
    if (!target) {
        sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
        return;
    }

    const hasGit = await fileExists(path.join(target.root, '.git'));
    if (!hasGit) {
        sendJson(res, 200, []);
        return;
    }

    try {
        const logOutput = await runGitCommand(target.root, ['log', '--pretty=format:%H|%ad|%s', '--date=iso']);
        const lines = logOutput.split('\n').filter(Boolean);
        const commits = lines.map(line => {
            const [hash, date, ...msg] = line.split('|');
            return {
                hash,
                date,
                message: msg.join('|')
            };
        });
        sendJson(res, 200, commits);
    } catch (err) {
        sendJson(res, 200, []);
    }
}

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.vscode', '.idea']);
const EXCLUDE_FILES = new Set([SESSION_METADATA_FILE]);

async function walkDir(
    dir: string,
    baseDir: string,
    includePath: (relativePath: string) => boolean = () => true
): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const entry of entries) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (!includePath(relativePath)) continue;
        if (entry.isDirectory()) {
            files.push(...await walkDir(fullPath, baseDir, includePath));
        } else if (entry.isFile()) {
            if (EXCLUDE_FILES.has(entry.name)) continue;
            const fileStat = await stat(fullPath);
            files.push({
                path: relativePath,
                size: fileStat.size,
                mtime: fileStat.mtimeMs
            });
        }
    }
    return files;
}

function parseExplorerQuery(req: IncomingMessage) {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    return {
        sessionId: parsedUrl.searchParams.get('sessionId') || '',
        repositoryId: parsedUrl.searchParams.get('repositoryId') || '',
        relativePath: parsedUrl.searchParams.get('path') || '',
        commit: parsedUrl.searchParams.get('commit') || '',
        repositoryScope: parsedUrl.searchParams.get('scope') === 'repository',
    };
}

async function handleListFiles(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }
    const { sessionId, repositoryId, commit, repositoryScope } = parseExplorerQuery(req);

    const target = await resolveExplorerRepositoryTarget({
        sessionId: sessionId || undefined,
        repositoryId: repositoryId || undefined,
        repositoryScope,
    });
    if (!target) {
        sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
        return;
    }

    try {
        if (commit && commit !== 'current') {
            const hasGit = await fileExists(path.join(target.root, '.git'));
            if (!hasGit) {
                sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                return;
            }
            const filesOutput = await runGitCommand(target.root, ['ls-tree', '-r', '--name-only', commit]);
            const filePaths = filesOutput.split('\n').filter(Boolean);
            const files = filePaths
                .filter(filePath => {
                    const firstPart = filePath.split('/')[0];
                    return !EXCLUDE_DIRS.has(firstPart);
                })
                .map(filePath => ({
                    path: filePath,
                    size: 0,
                    mtime: 0
                }));
            sendJson(res, 200, files);
        } else {
            const files = target.isRepositoryView
                ? await walkDir(target.root, target.root)
                : await listVisibleFiles(target.workspace!);
            sendJson(res, 200, files);
        }
    } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) });
    }
}

async function handleGetFileContent(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }
    const { sessionId, repositoryId, relativePath, commit, repositoryScope } = parseExplorerQuery(req);

    const target = await resolveExplorerRepositoryTarget({
        sessionId: sessionId || undefined,
        repositoryId: repositoryId || undefined,
        repositoryScope,
    });
    if (!target) {
        sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
        return;
    }

    try {
        const absolutePath = target.isRepositoryView
            ? safeJoin(target.root, relativePath)
            : resolveVisiblePath(target.workspace!, relativePath);
        const mimeType = getMimeType(absolutePath) || 'text/plain; charset=utf-8';
        if (commit && commit !== 'current') {
            const gitRelativePath = relativePath;
            const hasGit = await fileExists(path.join(target.root, '.git'));
            if (!hasGit) {
                sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                return;
            }
            const content = await runGitCommandBuffer(target.root, ['show', `${commit}:${gitRelativePath}`]);
            res.statusCode = 200;
            res.setHeader('content-type', mimeType);
            res.setHeader('cache-control', 'no-store');
            res.end(content);
        } else {
            if (!(await fileExists(absolutePath))) {
                sendJson(res, 404, { ok: false, error: 'File not found.' });
                return;
            }
            const content = await readFile(absolutePath);
            res.statusCode = 200;
            res.setHeader('content-type', mimeType);
            res.setHeader('cache-control', 'no-store');
            res.end(content);
        }
    } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) });
    }
}

function isSafeExplorerRevision(revision: string): boolean {
    return revision === 'current' || /^[a-f0-9]{7,64}$/i.test(revision);
}

async function handleRepositoryDiff(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const sessionId = parsedUrl.searchParams.get('sessionId') || '';
    const repositoryId = parsedUrl.searchParams.get('repositoryId') || '';
    const base = parsedUrl.searchParams.get('base') || '';
    const head = parsedUrl.searchParams.get('head') || '';

    if ((!sessionId && !repositoryId) || !isSafeExplorerRevision(base) || !isSafeExplorerRevision(head)) {
        sendJson(res, 400, { ok: false, error: 'Two valid revisions are required.' });
        return;
    }

    const target = await resolveExplorerRepositoryTarget({
        sessionId: sessionId || undefined,
        repositoryId: repositoryId || undefined,
        repositoryScope: true,
    });
    if (!target) {
        sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
        return;
    }

    if (!(await fileExists(path.join(target.root, '.git')))) {
        sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
        return;
    }

    try {
        if (base === head) {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/x-diff; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end('');
            return;
        }

        const args = ['diff', '--find-renames', '--find-copies', '--no-ext-diff'];
        if (base === 'current') {
            // git diff <commit> is <commit> -> worktree; reverse it to render
            // the requested worktree -> <commit> direction.
            args.push('-R', head);
        } else if (head === 'current') {
            args.push(base);
        } else {
            args.push(base, head);
        }
        // Images are workspace artifacts, not reviewable source diffs. Never
        // emit Git binary patches (or their opaque encoded payloads) to the UI.
        args.push('--', '.',
            ':(exclude,glob)**/*.png',
            ':(exclude,glob)**/*.jpg',
            ':(exclude,glob)**/*.jpeg',
            ':(exclude,glob)**/*.gif',
            ':(exclude,glob)**/*.webp',
            ':(exclude,glob)**/*.bmp',
            ':(exclude,glob)**/*.tif',
            ':(exclude,glob)**/*.tiff',
            ':(exclude,glob)**/*.svg',
            ':(exclude,glob)**/.*',
            ':(exclude,glob)**/.*/**',
            ':(exclude,glob)**/__pycache__/**',
            ':(exclude,glob)**/node_modules/**',
        );

        const diff = await runGitCommandBuffer(target.root, args);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/x-diff; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(diff);
    } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) });
    }
}

export async function handleSandboxBackendRequest(
    req: IncomingMessage,
    res: ServerResponse
): Promise<boolean> {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizeApiPathname(parsedUrl.pathname);

    try {
        if (pathname === '/api/sandbox/execute') {
            await handleExecute(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/commit') {
            await handleCommit(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/snapshot') {
            await handleSnapshot(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/results-snapshot') {
            await handleDeepthinkResultsSnapshot(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/ensure-deepthink') {
            await handleEnsureDeepthinkRepository(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/save-latest-gz') {
            await handleSaveLatestGz(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/open-directory') {
            await handleOpenDirectory(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/archive-strategy') {
            await handleArchiveStrategy(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/repository/restore-strategy') {
            await handleRestoreStrategy(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/environment') {
            await handleEnvironment(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/workspace/sessions') {
            await handleListSessions(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/workspace/history') {
            await handleGetHistory(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/workspace/files') {
            await handleListFiles(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/workspace/file') {
            await handleGetFileContent(req, res);
            return true;
        }

        if (pathname === '/api/sandbox/workspace/diff') {
            await handleRepositoryDiff(req, res);
            return true;
        }

        if (pathname.startsWith('/api/sandbox/files/')) {
            await handleFileRequest(pathname, res);
            return true;
        }

        if (pathname.startsWith('/api/sandbox/artifacts/')) {
            await handleArtifactRequest(pathname, res);
            return true;
        }

        return false;
    } catch (error) {
        sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'Sandbox backend error.',
        });
        return true;
    }
}
