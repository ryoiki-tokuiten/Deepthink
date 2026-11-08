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

const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
    'image/tiff': '.tiff', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
    'application/pdf': '.pdf', 'image/png': '.png',
};
function extensionForMimeType(mimeType: string): string {
    return MIME_EXTENSIONS[mimeType] ?? (mimeType.startsWith('image/') ? '.png' : '.bin');
}

const READ_ONLY_BASH_COMMANDS = new Set(['ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'head', 'tail', 'wc', 'stat', 'file', 'tree', 'pwd', 'which', 'type', 'realpath', 'dirname', 'basename', 'du', 'df']);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree']);
const FILE_WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const MUTATING_FIND_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls']);
export function isReadOnlyBashCommand(command: string): boolean {
    try {
        const ast = parseBashAst(command);
        let saw = false;
        const wordText = (w: any) => Array.isArray(w?.parts) ? w.parts.map((p: any) => (p.type === 'Literal' || p.type === 'SingleQuoted') ? String(p.value ?? '') : '').join('') : '';
        const checkCmd = (cmd: any): boolean => {
            if ((cmd.redirections || []).some((r: any) => FILE_WRITE_REDIRECT_OPERATORS.has(r.operator))) return false;
            if (cmd.type === 'SimpleCommand') {
                saw = true;
                const tokens = [wordText(cmd.name), ...(cmd.args || []).map(wordText)].filter(Boolean);
                if (!tokens.length) return false;
                const [first, ...rest] = tokens[0] === 'rtk' ? tokens.slice(1) : tokens;
                const ok = first === 'read' && tokens[0] === 'rtk'
                    || (first === 'find' && !rest.some(a => MUTATING_FIND_FLAGS.has(a)))
                    || READ_ONLY_BASH_COMMANDS.has(first)
                    || (first === 'git' && READ_ONLY_GIT_SUBCOMMANDS.has(rest.find(a => !a.startsWith('-')) || ''));
                return ok && ![cmd.name, ...(cmd.args || [])].filter(Boolean).some((w: any) =>
                    Array.isArray(w.parts) && w.parts.some((p: any) => p.type === 'CommandSubstitution' || p.type === 'ProcessSubstitution')
                );
            }
            return (cmd.type === 'Subshell' || cmd.type === 'Group') && Array.isArray(cmd.body) && cmd.body.every(checkStmt);
        };
        const checkStmt = (s: any): boolean => Array.isArray(s.pipelines) && s.pipelines.every((p: any) => Array.isArray(p.commands) && p.commands.every(checkCmd));
        return Array.isArray(ast.statements) && ast.statements.every(checkStmt) && saw;
    } catch { return false; }
}

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
    agentDirectory?: string;
    agentDirectoryReadOnly?: boolean;
    readableDirectories?: string[];
    liveReadableDirectories?: string[];
    hiddenDirectories?: string[];
    fullRepositoryRead?: boolean;
    fullRepositoryWrite?: boolean;
    revision?: string;
}

interface SandboxSessionMetadata {
    schema: 'iterative_studio_sandbox_session.v1';
    repositoryAccess?: SandboxRepositoryAccessRequest;
}

interface DeepthinkResultsSnapshotRequest {
    repositoryId: string;
    commitMessage?: string;
    contextFiles?: Array<{ path: string; content: string; base64?: string }>;
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
    sharedEnvironment: { mountPath: string; hostPath: string; enabled: boolean };
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
    limits: {
        maxToolTurns: number;
        maxDurationMs: number;
        defaultCommandTimeoutMs: number;
        maxCommandTimeoutMs: number;
    };
    setupErrors: string[];
    agentSummary: string;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt((value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const VFS_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-vfs');
const REPOSITORY_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-repos');
const REPOSITORY_VIEW_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-views');
const ARTIFACT_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-artifacts');
const RESULTS_ROOT = process.env.ITERATIVE_STUDIO_RESULTS_ROOT || path.join(process.cwd(), 'Results');
const DEEPTHINK_RESULTS_METADATA_ROOT = path.join(os.tmpdir(), 'iterative-studio-deepthink-results');
const SESSION_METADATA_FILE = '.sandbox-session.json';
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const getDefaultTimeoutMs = () => parsePositiveIntEnv(process.env.ITERATIVE_STUDIO_SANDBOX_COMMAND_TIMEOUT_MS, 120_000);
const getMaxTimeoutMs = () => Math.max(getDefaultTimeoutMs(), parsePositiveIntEnv(process.env.ITERATIVE_STUDIO_SANDBOX_MAX_COMMAND_TIMEOUT_MS, 300_000));
const getMaxToolTurns = () => parsePositiveIntEnv(process.env.ITERATIVE_STUDIO_SANDBOX_MAX_TOOL_TURNS, 64);
const getMaxSandboxDurationMs = () => {
    if (process.env.ITERATIVE_STUDIO_SANDBOX_MAX_DURATION_MS?.trim()) {
        return parsePositiveIntEnv(process.env.ITERATIVE_STUDIO_SANDBOX_MAX_DURATION_MS, 60 * 60_000);
    }
    return parsePositiveIntEnv(process.env.ITERATIVE_STUDIO_SANDBOX_MAX_DURATION_MINUTES, 60) * 60_000;
};
const MAX_TOOL_RESULT_OUTPUT_TOKENS = 5000;
const APP_BASE_PATH = '/Iterative-Contextual-Refinements';
const DEFAULT_SANDBOX_IMAGE = 'python:3.12-bookworm';
const DEFAULT_SANDBOX_CPUS = '2';
const DEFAULT_SANDBOX_MEMORY = '1g';
const DEFAULT_SANDBOX_PIDS_LIMIT = '256';
const SANDBOX_ENV_ROOT = process.env.ITERATIVE_STUDIO_SANDBOX_ENV_ROOT || path.join(os.homedir(), '.cache', 'iterative-studio', 'sandbox-env');
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
const BWRAP_SYSTEM_MOUNTS = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/opt'];

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const EXTRA_MIME_BY_EXT: Record<string, string> = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.pdf': 'application/pdf', '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'application/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.svg': 'image/svg+xml',
};
const IMAGE_SCAN_IGNORED_DIRECTORIES = new Set([
    '.tmp', '.cache', '.local', '.matplotlib', '.python_user_base', '.venv', 'venv', 'node_modules', '__pycache__',
]);

let cachedHostRustSysroot: string | null | undefined;
let sandboxEnvironmentPromise: Promise<SandboxEnvironmentProfile> | null = null;
const sessionWorkspacePrepLocks = new Map<string, Promise<void>>();
const activeSessionExecutions = new Map<string, number>();
const RTK_VERSION = 'v1.0.1';

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
        if (rewritten) return rewritten;
    }
    return command;
}

const DEFAULT_PYTHON_PACKAGES = [
    'numpy', 'scipy', 'pandas', 'matplotlib', 'seaborn', 'pillow', 'opencv-python-headless',
    'scikit-learn', 'scikit-image', 'sympy', 'networkx', 'requests', 'httpx', 'beautifulsoup4',
    'lxml', 'html5lib', 'pyyaml', 'python-dateutil', 'pytz', 'tqdm', 'rich', 'plotly', 'statsmodels',
    'mpmath', 'pytest', 'hypothesis', 'imageio', 'imageio-ffmpeg', 'openpyxl', 'xlsxwriter', 'reportlab',
    'pypdf', 'pdfplumber', 'markdown', 'pygments', 'regex', 'rapidfuzz', 'attrs', 'sortedcontainers',
    'joblib', 'cloudpickle', 'psutil',
];
const DEFAULT_NODE_PACKAGES = [
    'lodash', 'axios', 'cheerio', 'dayjs', 'zod', 'yaml', 'mathjs', 'csv-parse', 'csv-stringify', 'fast-check',
];
const PROBED_COMMANDS = [
    'python', 'python3', 'node', 'npm', 'gcc', 'g++', 'rustc', 'cargo', 'lean', 'lake',
    'curl', 'git', 'perl', 'ruby', 'go', 'java', 'javac', 'Rscript', 'julia', 'lua', 'rtk',
];

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, statusCode: number, message: string, contentType = 'text/plain; charset=utf-8') {
    res.statusCode = statusCode;
    res.setHeader('content-type', contentType);
    res.end(message);
}

const isSafeSessionId = (id: string) => /^[a-zA-Z0-9_-]{8,80}$/.test(id);
const isSafeRepositoryId = (id: string) => /^[a-zA-Z0-9_-]{4,80}$/.test(id);
const isDeepthinkRepository = (id: string) => id.startsWith('deepthink-');

function isSafeRepositoryDirectory(directory: string): boolean {
    if (!directory || directory.includes('\\') || directory.startsWith('/') || directory.endsWith('/')) return false;
    return directory.split('/').every(seg => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(seg));
}

function getWorkspacePath(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new Error('Invalid sandbox session id.');
    return path.join(VFS_ROOT, sessionId);
}

async function resolveRepositoryPath(repositoryId: string): Promise<string> {
    if (!isSafeRepositoryId(repositoryId)) throw new Error('Invalid sandbox repository id.');
    if (isDeepthinkRepository(repositoryId)) {
        const resultsPath = await ensureDeepthinkResultsRepository(repositoryId);
        if (resultsPath) return resultsPath;
    }
    return path.join(REPOSITORY_ROOT, repositoryId);
}

function getDeepthinkResultsMetadataPath(repositoryId: string): string {
    if (!isSafeRepositoryId(repositoryId)) throw new Error('Invalid sandbox repository id.');
    return path.join(DEEPTHINK_RESULTS_METADATA_ROOT, `${repositoryId}.json`);
}

function deepthinkResultDirectoryName(): string {
    return `deepthink_${new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace('Z', '')}`;
}

async function persistDeepthinkResultsMetadata(repositoryId: string, dirPath: string, meta?: DeepthinkResultsRepositoryMetadata) {
    const metadata: DeepthinkResultsRepositoryMetadata = meta ?? {
        schema: 'iterative_studio_deepthink_results.v1',
        repositoryId,
        resultPath: dirPath,
        createdAt: new Date().toISOString(),
    };
    const json = JSON.stringify(metadata, null, 2);
    await mkdir(DEEPTHINK_RESULTS_METADATA_ROOT, { recursive: true });
    await writeFile(getDeepthinkResultsMetadataPath(repositoryId), json).catch(() => {});
    await writeFile(path.join(dirPath, '.deepthink-meta.json'), json).catch(() => {});
}

async function getDeepthinkResultsRepositoryPath(repositoryId: string): Promise<string | null> {
    if (!isDeepthinkRepository(repositoryId)) return null;
    try {
        const metadata = JSON.parse(await readFile(getDeepthinkResultsMetadataPath(repositoryId), 'utf8')) as DeepthinkResultsRepositoryMetadata;
        if (metadata?.schema === 'iterative_studio_deepthink_results.v1' && metadata.repositoryId === repositoryId && await fileExists(metadata.resultPath)) {
            return metadata.resultPath;
        }
    } catch {}

    try {
        for (const entry of await readdir(RESULTS_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(RESULTS_ROOT, entry.name);
            const metaFile = path.join(dirPath, '.deepthink-meta.json');
            if (await fileExists(metaFile)) {
                try {
                    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as DeepthinkResultsRepositoryMetadata;
                    if (meta?.repositoryId === repositoryId) {
                        await persistDeepthinkResultsMetadata(repositoryId, dirPath, meta);
                        return dirPath;
                    }
                } catch {}
            } else {
                const gzFile = path.join(dirPath, 'latest.gz');
                if (await fileExists(gzFile)) {
                    try {
                        const parsed = JSON.parse(zlib.gunzipSync(await readFile(gzFile)).toString('utf8'));
                        if (parsed?.data?.modeState?.pipeline?.id === repositoryId) {
                            await persistDeepthinkResultsMetadata(repositoryId, dirPath);
                            return dirPath;
                        }
                    } catch {}
                }
            }
        }
    } catch {}
    return null;
}

async function ensureDeepthinkResultsRepository(repositoryId: string): Promise<string | null> {
    if (!isDeepthinkRepository(repositoryId)) return null;
    const existing = await getDeepthinkResultsRepositoryPath(repositoryId);
    if (existing) return existing;

    await mkdir(RESULTS_ROOT, { recursive: true });
    const baseName = deepthinkResultDirectoryName();
    let resultPath = path.join(RESULTS_ROOT, baseName);
    let suffix = 1;
    while (await fileExists(resultPath)) {
        resultPath = path.join(RESULTS_ROOT, `${baseName}-${suffix++}`);
    }
    await mkdir(resultPath, { recursive: true });
    await persistDeepthinkResultsMetadata(repositoryId, resultPath);
    await initAndCommitWorkspace(resultPath, 'Deepthink run initialized');
    return resultPath;
}

function getRepositoryViewPath(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new Error('Invalid sandbox session id.');
    return path.join(REPOSITORY_VIEW_ROOT, sessionId);
}

function sanitizeRepositoryAccess(accessRequest?: SandboxRepositoryAccessRequest): SandboxRepositoryAccessRequest | undefined {
    if (!accessRequest) return undefined;
    if (!isSafeRepositoryId(accessRequest.repositoryId)) throw new Error('Invalid sandbox repository id.');
    if (accessRequest.agentDirectory !== undefined && !isSafeRepositoryDirectory(accessRequest.agentDirectory)) {
        throw new Error('Invalid sandbox agent directory.');
    }
    if (accessRequest.revision !== undefined && !/^[0-9a-f]{7,64}$/i.test(accessRequest.revision)) {
        throw new Error('Invalid sandbox repository revision.');
    }

    const validateDirs = (dirs: string[] | undefined, label: string, extraCheck?: (d: string) => boolean) =>
        Array.from(new Set(dirs || [])).map(d => {
            if (!isSafeRepositoryDirectory(d) || (extraCheck && !extraCheck(d))) {
                throw new Error(`Invalid ${label} sandbox directory: ${d}`);
            }
            return d;
        });

    const readableDirectories = validateDirs(
        (accessRequest.readableDirectories || []).filter(d => d !== accessRequest.agentDirectory),
        'readable'
    );
    const liveReadableDirectories = validateDirs(
        accessRequest.liveReadableDirectories,
        'live-readable',
        d => readableDirectories.includes(d)
    );
    const hiddenDirectories = validateDirs(accessRequest.hiddenDirectories, 'hidden');

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
        const count = existing.filter(e => e.isDirectory() && new RegExp(`^${strategyDirectory}_pruned_\\d+`).test(e.name)).length;
        const archiveName = `${strategyDirectory}_pruned_${String(count + 1).padStart(2, '0')}`;
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
        const parsed = JSON.parse(await readFile(path.join(getWorkspacePath(sessionId), SESSION_METADATA_FILE), 'utf8')) as SandboxSessionMetadata;
        return parsed?.schema === 'iterative_studio_sandbox_session.v1' ? parsed : null;
    } catch {
        return null;
    }
}

function getMimeType(filename: string): string | null {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_MIME_BY_EXT[ext] ?? EXTRA_MIME_BY_EXT[ext] ?? null;
}

function normalizeApiPathname(pathname: string): string {
    return pathname.startsWith(`${APP_BASE_PATH}/api/sandbox/`) ? pathname.slice(APP_BASE_PATH.length) : pathname;
}

function sanitizeFilename(name: string | undefined, mimeType: string, index: number): string {
    const ext = extensionForMimeType(mimeType);
    const fallback = `uploaded-image-${index + 1}${ext}`;
    const withName = path.basename(name || fallback).replace(/[^\w.\- ()]/g, '_') || fallback;
    return path.extname(withName) ? withName : `${withName}${ext}`;
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
    return envValue?.trim() ? envValue.split(/[,\s]+/).map(item => item.trim()).filter(Boolean) : defaults;
}

const isDisabledEnvValue = (value?: string) => /^(0|false|no|none|disabled)$/i.test((value || '').trim());
const isEnabledEnvValue = (value?: string) => /^(1|true|yes|on|enabled)$/i.test((value || '').trim());
const isSandboxEnvironmentPrewarmEnabled = () => isEnabledEnvValue(process.env.ITERATIVE_STUDIO_SANDBOX_PREWARM);

function isLeanPrewarmEnabled(): boolean {
    const s = process.env.ITERATIVE_STUDIO_SANDBOX_LEAN;
    return (isSandboxEnvironmentPrewarmEnabled() || isEnabledEnvValue(s)) && !isDisabledEnvValue(s);
}

const isMathlibPrewarmEnabled = () => isLeanPrewarmEnabled() && !isDisabledEnvValue(process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB);
const getLeanToolchain = () => process.env.ITERATIVE_STUDIO_SANDBOX_LEAN_TOOLCHAIN || DEFAULT_LEAN_TOOLCHAIN;

function getMathlibRevision(leanVersionText: string): string {
    if (process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB_REV?.trim()) return process.env.ITERATIVE_STUDIO_SANDBOX_MATHLIB_REV.trim();
    const match = leanVersionText.match(/version\s+([0-9]+(?:\.[0-9]+){1,3})/i);
    return match ? `v${match[1]}` : 'v4.31.0';
}

const getHostEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...process.env, ...extra });

function sharedToolPathForHost(): string {
    return [
        SANDBOX_ENV_BIN,
        path.join(SANDBOX_PYTHON_ENV, 'bin'),
        path.join(SANDBOX_NODE_ENV, 'node_modules', '.bin'),
        path.join(SANDBOX_LEAN_ELAN_HOME, 'bin'),
        process.env.PATH || '',
    ].filter(Boolean).join(path.delimiter);
}

function appendBounded(current: string, chunk: Buffer | string, wasTruncated: boolean): { value: string; truncated: boolean } {
    if (wasTruncated) return { value: current, truncated: true };
    const nextText = current + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    if (encoder.encode(nextText).length > MAX_TOOL_RESULT_OUTPUT_TOKENS) {
        return { value: encoder.decode(encoder.encode(nextText).slice(0, MAX_TOOL_RESULT_OUTPUT_TOKENS)), truncated: true };
    }
    return { value: nextText, truncated: false };
}

async function runHostCommand(
    executable: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<HostCommandResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise(resolve => {
        let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, timedOut = false, spawnFailed = false;
        const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

        child.stdout.on('data', chunk => ({ value: stdout, truncated: stdoutTruncated } = appendBounded(stdout, chunk, stdoutTruncated)));
        child.stderr.on('data', chunk => ({ value: stderr, truncated: stderrTruncated } = appendBounded(stderr, chunk, stderrTruncated)));
        child.on('error', error => {
            spawnFailed = true;
            clearTimeout(timer);
            resolve({ ok: false, exitCode: 127, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}` });
        });
        child.on('close', code => {
            if (spawnFailed) return;
            clearTimeout(timer);
            if (stdoutTruncated) stdout += `\n[stdout truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens]`;
            if (stderrTruncated) stderr += `\n[stderr truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS} tokens]`;
            const exitCode = timedOut ? 124 : (code ?? 1);
            resolve({ ok: exitCode === 0, exitCode, stdout, stderr, timedOut });
        });
    });
}

function commandPath(command: string, env?: NodeJS.ProcessEnv): string | null {
    const result = spawnSync('sh', ['-lc', 'command -v "$1"', 'sh', command], {
        encoding: 'utf8', env: getHostEnv(env), stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (!result.error && result.status === 0 && result.stdout.trim()) || null;
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
        env: getHostEnv({ PATH: sharedToolPathForHost() }), timeoutMs: 60_000,
    });
    if (!result.ok) return [];
    try {
        return (JSON.parse(result.stdout) as Array<{ name?: string }>).map(i => i.name || '').filter(Boolean).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

async function installMissingPackages(
    executable: string,
    baseArgs: string[],
    missing: string[],
    env: NodeJS.ProcessEnv,
    bulkTimeoutMs: number,
    singleTimeoutMs: number
): Promise<string[]> {
    const failed: string[] = [];
    if (!missing.length) return failed;
    const bulk = await runHostCommand(executable, [...baseArgs, ...missing], { env, timeoutMs: bulkTimeoutMs });
    if (!bulk.ok) {
        for (const pkg of missing) {
            const single = await runHostCommand(executable, [...baseArgs, pkg], { env, timeoutMs: singleTimeoutMs });
            if (!single.ok) failed.push(pkg);
        }
    }
    return failed;
}

async function ensurePythonEnvironment(setupErrors: string[]): Promise<{ packages: string[]; failedPackages: string[]; version?: string }> {
    const requestedPackages = getConfiguredList(process.env.ITERATIVE_STUDIO_SANDBOX_PYTHON_PACKAGES, DEFAULT_PYTHON_PACKAGES);
    const pythonExecutable = path.join(SANDBOX_PYTHON_ENV, 'bin', 'python');
    if (!isSandboxEnvironmentPrewarmEnabled()) return { packages: [], failedPackages: [] };

    try {
        await mkdir(SANDBOX_ENV_ROOT, { recursive: true });
        const env = getHostEnv({ PATH: sharedToolPathForHost(), PIP_CACHE_DIR: path.join(SANDBOX_ENV_ROOT, 'pip-cache') });
        if (!commandPath(pythonExecutable)) {
            const venvResult = await runHostCommand('python3', ['-m', 'venv', SANDBOX_PYTHON_ENV], { env, timeoutMs: 180_000 });
            if (!venvResult.ok) {
                setupErrors.push(`Python environment creation failed: ${venvResult.stderr || venvResult.stdout}`);
                return { packages: [], failedPackages: requestedPackages };
            }
        }
        await runHostCommand(pythonExecutable, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { env, timeoutMs: 180_000 });
        const installedBefore = new Set((await getPythonPackageList(pythonExecutable)).map(n => n.toLowerCase()));
        const missing = requestedPackages.filter(pkg => !installedBefore.has(pkg.toLowerCase()));
        const failedPackages = await installMissingPackages(pythonExecutable, ['-m', 'pip', 'install', '--prefer-binary'], missing, env, 20 * 60_000, 5 * 60_000);
        const version = (await runHostCommand(pythonExecutable, ['--version'], { env, timeoutMs: 30_000 })).stdout.trim();
        return { packages: await getPythonPackageList(pythonExecutable), failedPackages, version };
    } catch (error) {
        setupErrors.push(`Python environment setup failed: ${error instanceof Error ? error.message : String(error)}`);
        return { packages: [], failedPackages: requestedPackages };
    }
}

async function getNodePackageList(): Promise<string[]> {
    try {
        const parsed = JSON.parse(await readFile(path.join(SANDBOX_NODE_ENV, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
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
        const existing = new Set((await getNodePackageList()).map(n => n.toLowerCase()));
        const missing = requestedPackages.filter(pkg => !existing.has(pkg.toLowerCase()));
        const env = getHostEnv({ PATH: sharedToolPathForHost() });
        const failedPackages = await installMissingPackages(npmPath, ['install', '--prefix', SANDBOX_NODE_ENV], missing, env, 10 * 60_000, 3 * 60_000);
        const version = (await runHostCommand(nodePath, ['--version'], { env, timeoutMs: 30_000 })).stdout.trim();
        return { available: true, version, packages: await getNodePackageList(), failedPackages };
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
    if (!isMathlibPrewarmEnabled()) return { available: false };
    try {
        if (await fileExists(SANDBOX_LEAN_MATHLIB_READY_MARKER)) return { available: true };
        await mkdir(SANDBOX_LEAN_ROOT, { recursive: true });
        const lakeBin = path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'lake');
        const mathlibRevision = getMathlibRevision(leanVersionText);
        const lakefilePath = path.join(SANDBOX_LEAN_MATHLIB_PROJECT, 'lakefile.toml');
        const mathlibPackagePath = path.join(SANDBOX_LEAN_MATHLIB_PROJECT, '.lake', 'packages', 'mathlib');

        if (!(await fileExists(lakefilePath)) || !(await fileExists(mathlibPackagePath))) {
            await rm(SANDBOX_LEAN_MATHLIB_PROJECT, { recursive: true, force: true });
            await mkdir(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, SANDBOX_LEAN_MATHLIB_PROJECT_NAME), { recursive: true });
            await mkdir(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, '.lake', 'packages'), { recursive: true });
            await writeFile(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, 'lean-toolchain'), `leanprover/lean4:${mathlibRevision}\n`);
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
            await writeFile(path.join(SANDBOX_LEAN_MATHLIB_PROJECT, `${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}.lean`), `import ${SANDBOX_LEAN_MATHLIB_PROJECT_NAME}.Basic\n`);
            await writeFile(
                path.join(SANDBOX_LEAN_MATHLIB_PROJECT, SANDBOX_LEAN_MATHLIB_PROJECT_NAME, 'Basic.lean'),
                'import Mathlib\n\nexample (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n'
            );

            const clone = await runHostCommand('git', [
                'clone', '--depth', '1', '--branch', mathlibRevision, '--single-branch',
                'https://github.com/leanprover-community/mathlib4', mathlibPackagePath,
            ], { env, timeoutMs: 20 * 60_000 });
            if (!clone.ok) throw new Error(clone.stderr || clone.stdout || 'Mathlib shallow clone failed.');
        }

        const update = await runHostCommand(lakeBin, ['update'], { cwd: SANDBOX_LEAN_MATHLIB_PROJECT, env, timeoutMs: 15 * 60_000 });
        if (!update.ok) throw new Error(update.stderr || update.stdout || 'Mathlib lake update failed.');

        const cacheGet = await runHostCommand(lakeBin, ['exe', 'cache', 'get'], { cwd: SANDBOX_LEAN_MATHLIB_PROJECT, env, timeoutMs: 45 * 60_000 });
        if (!cacheGet.ok) throw new Error(cacheGet.stderr || cacheGet.stdout || 'Mathlib cache fetch failed.');

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
    if (!isLeanPrewarmEnabled()) return { available: false, mathlibAvailable: false, helperScripts: [] };

    try {
        await mkdir(path.join(SANDBOX_LEAN_ELAN_HOME, 'toolchains'), { recursive: true });
        const env = getHostEnv({ ELAN_HOME: SANDBOX_LEAN_ELAN_HOME, PATH: sharedToolPathForHost() });
        if (!commandPath(leanBin) || !commandPath(lakeBin)) {
            const curlPath = commandPath('curl');
            if (!curlPath) throw new Error('curl is required to install elan but was not found.');
            const scriptPath = path.join(SANDBOX_ENV_ROOT, 'elan-init.sh');
            const download = await runHostCommand(curlPath, ['-fsSL', ELAN_INIT_URL, '-o', scriptPath], { env, timeoutMs: 120_000 });
            if (!download.ok) throw new Error(download.stderr || download.stdout || 'Failed to download elan installer.');
            const install = await runHostCommand('sh', [scriptPath, '-y', '--no-modify-path', '--default-toolchain', getLeanToolchain()], { env, timeoutMs: 10 * 60_000 });
            if (!install.ok) throw new Error(install.stderr || install.stdout || 'elan installation failed.');
        }

        const tcInstall = await runHostCommand(path.join(SANDBOX_LEAN_ELAN_HOME, 'bin', 'elan'), ['toolchain', 'install', getLeanToolchain()], { env, timeoutMs: 15 * 60_000 });
        if (!tcInstall.ok && !/already installed/i.test(`${tcInstall.stdout}\n${tcInstall.stderr}`)) {
            throw new Error(tcInstall.stderr || tcInstall.stdout || 'Lean toolchain installation failed.');
        }

        const leanVersion = await runHostCommand(leanBin, ['--version'], { env, timeoutMs: 5 * 60_000 });
        const lakeVersion = await runHostCommand(lakeBin, ['--version'], { env, timeoutMs: 5 * 60_000 });
        if (!leanVersion.ok || !lakeVersion.ok) {
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
        return { available: false, mathlibAvailable: false, helperScripts: [], error: message };
    }
}

function packagePreview(packages: string[], max = 28): string {
    return packages.length <= max ? packages.join(', ') : `${packages.slice(0, max).join(', ')}, and ${packages.length - max} more`;
}

async function probeCommand(name: string): Promise<{ name: string; available: boolean; version?: string }> {
    const env = { PATH: sharedToolPathForHost(), ELAN_HOME: SANDBOX_LEAN_ELAN_HOME };
    const executable = commandPath(name, env);
    if (!executable) return { name, available: false };
    const version = await runHostCommand(executable, ['--version'], { env: getHostEnv(env), timeoutMs: 20_000 });
    return { name, available: true, version: (version.stdout || version.stderr).split('\n').find(Boolean)?.trim() };
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
    } catch {}
    try {
        await mkdir(SANDBOX_ENV_BIN, { recursive: true });
        const archAsset = process.arch === 'arm64' ? 'rtk-aarch64-unknown-linux-gnu.tar.gz' : 'rtk-x86_64-unknown-linux-musl.tar.gz';
        const downloadUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${archAsset}`;
        const installResult = await runHostCommand(
            'bash',
            ['-lc', `curl -fsSL "${downloadUrl}" | tar -xz -C "${SANDBOX_ENV_BIN}" && chmod 755 "${rtkBinaryPath}"`],
            { timeoutMs: 60_000 }
        );
        if (!installResult.ok) setupErrors.push(`rtk binary install failed: ${installResult.stderr || installResult.stdout}`);
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
    const commands = await Promise.all(PROBED_COMMANDS.map(probeCommand));
    const pythonExecutable = commandPath('python', { PATH: sharedToolPathForHost() }) || undefined;
    const profileWithoutSummary: Omit<SandboxEnvironmentProfile, 'agentSummary'> = {
        ok: true,
        runtime: getSandboxRuntime(),
        sharedEnvironment: { mountPath: SANDBOX_ENV_MOUNT, hostPath: SANDBOX_ENV_ROOT, enabled: true },
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
        limits: {
            maxToolTurns: getMaxToolTurns(),
            maxDurationMs: getMaxSandboxDurationMs(),
            defaultCommandTimeoutMs: getDefaultTimeoutMs(),
            maxCommandTimeoutMs: getMaxTimeoutMs(),
        },
        setupErrors,
    };
    return { ...profileWithoutSummary, agentSummary: buildAgentEnvironmentSummary(profileWithoutSummary) };
}

function getSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile> {
    return (sandboxEnvironmentPromise ??= buildSandboxEnvironmentProfile());
}

async function seedWorkspaceFiles(workspace: string, files?: SeedFile[]) {
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
            filename = `${stem}-${suffix++}${ext}`;
        }
        usedNames.add(keyFor(filename));

        const destination = safeJoin(workspace, requestedDirectory === '.' ? filename : `${requestedDirectory}/${filename}`);
        await mkdir(path.dirname(destination), { recursive: true });
        if (!(await fileExists(destination))) {
            await writeFile(destination, Buffer.from(file.base64, 'base64'));
        }
    }
}

async function copyRepositoryRootFiles(repoRoot: string, viewRoot: string): Promise<void> {
    await mkdir(viewRoot, { recursive: true });
    const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async entry => {
        if (!entry.isFile()) return;
        const destination = path.join(viewRoot, entry.name);
        await copyFile(path.join(repoRoot, entry.name), destination);
        await chmod(destination, 0o400).catch(() => undefined);
    }));
}

async function copyReadOnlyDirectory(source: string, destination: string, excludedRelativePaths: string[] = [], relativePath = ''): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
    await mkdir(destination, { recursive: true });
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (excludedRelativePaths.some(ex => childRelativePath === ex || childRelativePath.startsWith(`${ex}/`))) continue;
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

async function ensureRepositoryRevisionView(repoRoot: string, revision: string, privateScratchRoot: string): Promise<string> {
    const revisionRoot = path.join(privateScratchRoot, 'repository-revision');
    const markerPath = path.join(privateScratchRoot, '.repository-revision');
    if ((await readFile(markerPath, 'utf8').catch(() => '')).trim() === revision && await fileExists(revisionRoot)) {
        return revisionRoot;
    }
    await rm(revisionRoot, { recursive: true, force: true });
    await mkdir(revisionRoot, { recursive: true });
    const tree = await runGitCommandBuffer(repoRoot, ['ls-tree', '-r', '-z', '--name-only', revision]);
    for (const relativePath of tree.toString('utf8').split('\0').filter(Boolean)) {
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

function buildLegacyWorkspace(sessionId: string, workspace: string): SandboxCommandWorkspace {
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
        return buildLegacyWorkspace(sessionId, workspace);
    }

    const repoRoot = await resolveRepositoryPath(repositoryAccess.repositoryId);
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const ownDirectory = repositoryAccess.agentDirectory ? safeJoin(repoRoot, repositoryAccess.agentDirectory) : undefined;
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
    await mkdir(path.join(privateScratchRoot, '.tmp'), { recursive: true });
    await seedWorkspaceFiles(repoRoot, files);

    if (!(await fileExists(path.join(repoRoot, '.git')))) {
        await initAndCommitWorkspace(repoRoot, 'Initial shared workspace seed');
    }
    const readRoot = repositoryAccess.revision
        ? await ensureRepositoryRevisionView(repoRoot, repositoryAccess.revision, privateScratchRoot)
        : repoRoot;
    await mkdir(path.join(readRoot, 'tmp'), { recursive: true });

    const sourceDirectContext = safeJoin(readRoot, 'direct_context');
    const sourceUploads = safeJoin(readRoot, 'user_uploaded');
    const readableDirectories = Array.from(new Set(repositoryAccess.readableDirectories || []));
    const liveReadableDirectories = new Set(repositoryAccess.liveReadableDirectories || []);
    const readableExistingDirectories = (await Promise.all(readableDirectories.map(async directory => ({
        directory,
        exists: await fileExists(safeJoin(liveReadableDirectories.has(directory) ? repoRoot : readRoot, directory)),
    })))).filter(i => i.exists).map(i => i.directory);
    const hiddenDirectories = repositoryAccess.hiddenDirectories || [];
    const fullRepositoryRead = repositoryAccess.fullRepositoryRead === true || repositoryAccess.fullRepositoryWrite === true;
    const fullRepositoryWrite = repositoryAccess.fullRepositoryWrite === true;
    const usesFilteredFullRepository = fullRepositoryRead && hiddenDirectories.length > 0;
    const hasActiveExecution = (activeSessionExecutions.get(sessionId) ?? 0) > 0;

    if (!fullRepositoryRead || usesFilteredFullRepository) {
        if (!hasActiveExecution) await rm(viewRoot, { recursive: true, force: true });
        await mkdir(viewRoot, { recursive: true });
        if (usesFilteredFullRepository) {
            await copyReadOnlyDirectory(readRoot, viewRoot, [...hiddenDirectories, 'tmp', '.tmp']);
        } else {
            await copyRepositoryRootFiles(readRoot, viewRoot);
            if (await fileExists(sourceDirectContext)) await copyReadOnlyDirectory(sourceDirectContext, path.join(viewRoot, 'direct_context'));
            if (await fileExists(sourceUploads)) await copyReadOnlyDirectory(sourceUploads, path.join(viewRoot, 'user_uploaded'));
            for (const directory of [...readableExistingDirectories, ...(repositoryAccess.agentDirectory ? [repositoryAccess.agentDirectory] : []), ...hiddenDirectories]) {
                await mkdir(path.join(viewRoot, directory), { recursive: true });
            }
        }
        await mkdir(path.join(viewRoot, 'tmp'), { recursive: true });
    }

    const readonlyMountRoot = path.join(privateScratchRoot, 'readonly-mounts');
    if (!hasActiveExecution) await rm(readonlyMountRoot, { recursive: true, force: true });
    const readableMounts = await Promise.all(readableExistingDirectories.map(async directory => {
        const excluded = hiddenDirectories.filter(h => h.startsWith(`${directory}/`)).map(h => h.slice(directory.length + 1));
        const sourceRoot = liveReadableDirectories.has(directory) ? repoRoot : readRoot;
        if (!excluded.length) return { directory, source: safeJoin(sourceRoot, directory) };
        const filteredSource = safeJoin(readonlyMountRoot, directory);
        await copyReadOnlyDirectory(safeJoin(sourceRoot, directory), filteredSource, excluded);
        return { directory, source: filteredSource };
    }));
    const isDescendant = (d: string) => !!repositoryAccess.agentDirectory && d.startsWith(`${repositoryAccess.agentDirectory}/`);
    const beforeWritableMounts = readableMounts.filter(m => !isDescendant(m.directory));
    const readonlyChildMounts = readableMounts.filter(m => isDescendant(m.directory));
    const hiddenChildMounts = await Promise.all(hiddenDirectories.filter(isDescendant).map(async directory => {
        const source = safeJoin(readonlyMountRoot, `hidden/${directory}`);
        await mkdir(source, { recursive: true });
        return { directory, source };
    }));

    await writeSessionMetadata(sessionId, { schema: 'iterative_studio_sandbox_session.v1', repositoryAccess });
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
            ...(needsWorkspaceTmpMount ? [{ source: sharedTmpDir, target: '/workspace/tmp', readonly: false }] : []),
            ...((!fullRepositoryRead && await fileExists(sourceDirectContext)) ? [{ source: sourceDirectContext, target: '/workspace/direct_context', readonly: true }] : []),
            ...((!fullRepositoryRead && await fileExists(sourceUploads)) ? [{ source: sourceUploads, target: '/workspace/user_uploaded', readonly: true }] : []),
            ...beforeWritableMounts.map(m => ({ source: m.source, target: `/workspace/${m.directory}`, readonly: true })),
            ...(repositoryAccess.agentDirectory ? [{
                source: safeJoin(repoRoot, repositoryAccess.agentDirectory),
                target: `/workspace/${repositoryAccess.agentDirectory}`,
                readonly: repositoryAccess.agentDirectoryReadOnly === true,
            }] : []),
            ...readonlyChildMounts.map(m => ({ source: m.source, target: `/workspace/${m.directory}`, readonly: true })),
            ...hiddenChildMounts.map(m => ({ source: m.source, target: `/workspace/${m.directory}`, readonly: true })),
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
        return (await fileExists(workspace)) ? buildLegacyWorkspace(sessionId, workspace) : null;
    }

    const repoRoot = await resolveRepositoryPath(repositoryAccess.repositoryId);
    if (!(await fileExists(repoRoot))) return null;
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const readRoot = repositoryAccess.revision ? path.join(getWorkspacePath(sessionId), 'repository-revision') : repoRoot;
    const ownDirectory = repositoryAccess.agentDirectory ? safeJoin(repoRoot, repositoryAccess.agentDirectory) : undefined;
    const hasHidden = !!(repositoryAccess.hiddenDirectories || []).length;
    return {
        sessionId,
        rootHostPath: repositoryAccess.fullRepositoryRead && !hasHidden ? readRoot : getRepositoryViewPath(sessionId),
        repositoryRootPath: repoRoot,
        rootReadonly: repositoryAccess.fullRepositoryWrite !== true,
        tmpDir: sharedTmpDir,
        commandCwd: repositoryAccess.agentDirectory ? `/workspace/${repositoryAccess.agentDirectory}` : '/workspace',
        nestedMounts: [],
        visibleRootPath: repositoryAccess.fullRepositoryRead && hasHidden ? getRepositoryViewPath(sessionId) : readRoot,
        writablePath: repositoryAccess.fullRepositoryWrite ? repoRoot : ((!repositoryAccess.agentDirectoryReadOnly && ownDirectory) || sharedTmpDir),
        repositoryAccess,
    };
}

async function getExplorerRepositoryRoot(workspace: SandboxCommandWorkspace): Promise<string> {
    const repositoryId = workspace.repositoryAccess?.repositoryId;
    if (repositoryId) {
        const resultsRepository = await getDeepthinkResultsRepositoryPath(repositoryId);
        if (resultsRepository && await fileExists(resultsRepository)) return resultsRepository;
    }
    return gitWorkspaceFor(workspace);
}

async function listImageFiles(workspace: string, sessionId: string, includeBase64: boolean, currentDir = workspace): Promise<VisibleImage[]> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const images: VisibleImage[] = [];

    for (const entry of entries) {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(workspace, absolutePath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (!IMAGE_SCAN_IGNORED_DIRECTORIES.has(entry.name) && relativePath.split('/').length < 4) {
                images.push(...await listImageFiles(workspace, sessionId, includeBase64, absolutePath));
            }
            continue;
        }
        if (!entry.isFile()) continue;
        const mimeType = getMimeType(entry.name);
        if (!mimeType) continue;
        const fileStat = await stat(absolutePath);
        images.push({
            filename: relativePath,
            mimeType,
            size: fileStat.size,
            modifiedMs: fileStat.mtimeMs,
            url: `/api/sandbox/files/${encodeURIComponent(sessionId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
            ...(includeBase64 ? { base64: (await readFile(absolutePath)).toString('base64') } : {}),
        });
    }
    return images.sort((a, b) => a.filename.localeCompare(b.filename));
}

function visibleRepositoryDirectories(context: SandboxCommandWorkspace): string[] {
    if (!context.repositoryAccess || context.repositoryAccess.fullRepositoryRead) return [];
    return Array.from(new Set([
        ...(context.repositoryAccess.agentDirectory ? [context.repositoryAccess.agentDirectory] : []),
        ...(context.repositoryAccess.readableDirectories || []),
        'tmp', 'direct_context', 'user_uploaded',
    ]));
}

function isVisibleRepositoryPath(relativePath: string, visibleDirectories: string[]): boolean {
    return visibleDirectories.some(d => relativePath === d || relativePath.startsWith(`${d}/`));
}

function isHiddenRepositoryPath(context: SandboxCommandWorkspace, relativePath: string): boolean {
    return (context.repositoryAccess?.hiddenDirectories || []).some(d => relativePath === d || relativePath.startsWith(`${d}/`));
}

function resolveVisiblePath(context: SandboxCommandWorkspace, relativePath: string): string {
    if (!context.repositoryAccess) return safeJoin(context.visibleRootPath, relativePath);
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error('Invalid virtual filesystem path.');
    }
    if (isHiddenRepositoryPath(context, normalized)) throw new Error('Path is not visible in this sandbox session.');
    if ((normalized === 'tmp' || normalized.startsWith('tmp/')) && context.repositoryRootPath) {
        return safeJoin(context.repositoryRootPath, normalized);
    }
    if (context.repositoryAccess.fullRepositoryRead) return safeJoin(context.visibleRootPath, normalized);
    if (normalized.includes('/') && !isVisibleRepositoryPath(normalized, visibleRepositoryDirectories(context))) {
        throw new Error('Path is not visible in this sandbox session.');
    }
    const liveDirectories = ['tmp', context.repositoryAccess.agentDirectory, ...(context.repositoryAccess.liveReadableDirectories || [])].filter((d): d is string => !!d);
    const resolvesFromLive = context.repositoryAccess.fullRepositoryWrite || liveDirectories.some(d => normalized === d || normalized.startsWith(`${d}/`));
    return safeJoin(resolvesFromLive && context.repositoryRootPath ? context.repositoryRootPath : context.visibleRootPath, normalized);
}

async function listRepositoryRootFiles(repoRoot: string): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const entry of entries) {
        if (!entry.isFile() || EXCLUDE_FILES.has(entry.name)) continue;
        const fileStat = await stat(path.join(repoRoot, entry.name));
        files.push({ path: entry.name, size: fileStat.size, mtime: fileStat.mtimeMs });
    }
    return files;
}

async function listVisibleFiles(context: SandboxCommandWorkspace): Promise<Array<{ path: string; size: number; mtime: number }>> {
    if (!context.repositoryAccess || context.repositoryAccess.fullRepositoryRead) {
        return walkDir(context.visibleRootPath, context.visibleRootPath);
    }
    const rootFiles = await listRepositoryRootFiles(context.visibleRootPath);
    const directoryFiles = await Promise.all(visibleRepositoryDirectories(context).map(async directory => {
        const hostDirectory = safeJoin(context.visibleRootPath, directory);
        if (!(await fileExists(hostDirectory))) return [];
        return walkDir(hostDirectory, context.visibleRootPath, rel => !isHiddenRepositoryPath(context, rel));
    }));
    const byPath = new Map<string, { path: string; size: number; mtime: number }>();
    [...rootFiles, ...directoryFiles.flat()].forEach(f => byPath.set(f.path, f));
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function listVisibleImageFiles(context: SandboxCommandWorkspace, includeBase64: boolean): Promise<VisibleImage[]> {
    if (!context.repositoryAccess) return listImageFiles(context.visibleRootPath, context.sessionId, includeBase64);
    const files = await listVisibleFiles(context);
    const images: VisibleImage[] = [];
    for (const file of files) {
        const mimeType = getMimeType(file.path);
        if (!mimeType?.startsWith('image/')) continue;
        const absolutePath = resolveVisiblePath(context, file.path);
        images.push({
            filename: file.path,
            mimeType,
            size: file.size,
            modifiedMs: file.mtime,
            url: `/api/sandbox/files/${encodeURIComponent(context.sessionId)}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
            ...(includeBase64 ? { base64: (await readFile(absolutePath)).toString('base64') } : {}),
        });
    }
    return images;
}

function snapshotImages(images: VisibleImage[]): ImageSnapshot {
    return new Map(images.map(i => [i.filename, { size: i.size, modifiedMs: i.modifiedMs }]));
}

function getChangedImages(before: ImageSnapshot, after: VisibleImage[]): VisibleImage[] {
    return after.filter(image => {
        const prev = before.get(image.filename);
        return !prev || prev.size !== image.size || Math.abs(prev.modifiedMs - image.modifiedMs) > 1;
    });
}

async function snapshotImagesForTranscript(images: VisibleImage[], resolveSource: (filename: string) => string): Promise<VisibleImage[]> {
    if (!images.length) return [];
    const artifactId = randomUUID();
    const artifactWorkspace = path.join(ARTIFACT_ROOT, artifactId);
    return Promise.all(images.map(async image => {
        const destination = safeJoin(artifactWorkspace, image.filename);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(resolveSource(image.filename), destination);
        return {
            ...image,
            url: `/api/sandbox/artifacts/${encodeURIComponent(artifactId)}/${image.filename.split('/').map(encodeURIComponent).join('/')}`,
        };
    }));
}

async function snapshotVisibleImagesForTranscript(context: SandboxCommandWorkspace, images: VisibleImage[]): Promise<VisibleImage[]> {
    return snapshotImagesForTranscript(
        images,
        filename => context.repositoryAccess ? resolveVisiblePath(context, filename) : safeJoin(context.visibleRootPath, filename)
    );
}

const getSandboxExecutable = () => process.env.ITERATIVE_STUDIO_DOCKER || 'docker';
const getBubblewrapExecutable = () => process.env.ITERATIVE_STUDIO_BWRAP || 'bwrap';
const getSandboxImage = () => process.env.ITERATIVE_STUDIO_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
const getSandboxNetworkMode = () => process.env.ITERATIVE_STUDIO_SANDBOX_NETWORK || 'bridge';

function findRustSysrootWith(rustcExecutable: string): string | null {
    const result = spawnSync(rustcExecutable, ['--print', 'sysroot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (!result.error && result.status === 0 && result.stdout.trim()) || null;
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
    if (isDisabledEnvValue(configured)) return (cachedHostRustSysroot = null);
    const candidates = [
        configured?.trim(),
        findRustSysrootWith(process.env.ITERATIVE_STUDIO_RUSTC || 'rustc'),
        findRustSysrootWith(path.join(os.homedir(), '.cargo', 'bin', 'rustc')),
    ].filter((c): c is string => !!c);
    return (cachedHostRustSysroot = candidates.map(c => path.resolve(c)).find(isUsableRustSysroot) || null);
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
    return workspace.repositoryAccess && !workspace.repositoryAccess.agentDirectory ? '/tmp' : workspace.commandCwd;
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
    const r = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
}

function canUseDockerSocket(): boolean {
    if (process.env.DOCKER_HOST) return true;
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
    return commandExists(getBubblewrapExecutable()) ? 'bwrap' : 'docker';
}

const dockerMount = (source: string, target: string, readonly = false) =>
    `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;

function getSandboxEnvEntries(workspaceHome: string, hostRustSysroot: string | null): Array<[string, string]> {
    return [
        ['HOME', workspaceHome],
        ['TMPDIR', '/tmp'],
        ['XDG_CACHE_HOME', `${workspaceHome}/.cache`],
        ['XDG_DATA_HOME', '/tmp/.local/share'],
        ['XDG_CONFIG_HOME', '/tmp/.config'],
        ['MPLBACKEND', 'Agg'],
        ['MPLCONFIGDIR', `${workspaceHome}/.matplotlib`],
        ['PYTHONUNBUFFERED', '1'],
        ['PYTHONDONTWRITEBYTECODE', '1'],
        ['PYTHONUSERBASE', `${workspaceHome}/.python_user_base`],
        ['PIP_CACHE_DIR', `${workspaceHome}/.cache/pip`],
        ['NODE_PATH', `${SANDBOX_ENV_MOUNT}/node/node_modules`],
        ['ELAN_HOME', `${SANDBOX_ENV_MOUNT}/lean/elan`],
        ['CARGO_HOME', `${workspaceHome}/.cargo`],
        ['CARGO_TARGET_DIR', `${workspaceHome}/target`],
        ['PATH', getSandboxPath(hostRustSysroot, workspaceHome)],
    ];
}

function buildShellViewCommand(viewDir: string, command: string): string {
    return `umask 077; view() { mkdir -p "${viewDir}"; i=0; for f in "$@"; do i=$((i + 1)); touch -c "$f" 2>/dev/null || cp -- "$f" "${viewDir}/$i-$(basename "$f")" 2>/dev/null; done; }; open() { view "$@"; }; ${command}`;
}

function buildDockerArgs(args: {
    workspace: SandboxCommandWorkspace;
    command: string;
    containerName: string;
    hostRustSysroot: string | null;
    viewDir: string;
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const sharedEnvMount = getSharedEnvironmentMountPath();
    return [
        'run', '--rm',
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
        ...args.workspace.nestedMounts.flatMap(m => ['--mount', dockerMount(m.source, m.target, m.readonly)]),
        '--mount', dockerMount(args.workspace.tmpDir, '/tmp'),
        ...(sharedEnvMount ? ['--mount', dockerMount(sharedEnvMount, SANDBOX_ENV_MOUNT, true)] : []),
        ...(args.hostRustSysroot ? ['--mount', dockerMount(args.hostRustSysroot, SANDBOX_RUST_ROOT, true)] : []),
        ...getSandboxEnvEntries(workspaceHome, args.hostRustSysroot).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        getSandboxImage(),
        'bash', '-c', buildShellViewCommand(args.viewDir, args.command),
    ];
}

function buildBubblewrapArgs(args: {
    workspace: SandboxCommandWorkspace;
    command: string;
    hostRustSysroot: string | null;
    viewDir: string;
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const sharedEnvMount = getSharedEnvironmentMountPath();
    return [
        '--die-with-parent', '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts',
        ...(getSandboxNetworkMode() === 'none' ? ['--unshare-net'] : []),
        '--tmpfs', '/',
        '--dir', '/workspace', '--dir', '/tmp', '--dir', '/run', '--dir', '/run/systemd',
        '--proc', '/proc', '--dev', '/dev',
        ...BWRAP_SYSTEM_MOUNTS.flatMap(p => ['--ro-bind-try', p, p]),
        '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
        '--ro-bind-try', '/run/NetworkManager', '/run/NetworkManager',
        ...(sharedEnvMount ? ['--dir', SANDBOX_ENV_MOUNT, '--ro-bind', sharedEnvMount, SANDBOX_ENV_MOUNT] : []),
        ...(args.hostRustSysroot ? ['--dir', SANDBOX_RUST_ROOT, '--ro-bind', args.hostRustSysroot, SANDBOX_RUST_ROOT] : []),
        ...(args.workspace.rootReadonly ? ['--ro-bind', args.workspace.rootHostPath, '/workspace'] : ['--bind', args.workspace.rootHostPath, '/workspace']),
        ...args.workspace.nestedMounts.flatMap(m => [m.readonly ? '--ro-bind' : '--bind', m.source, m.target]),
        '--bind', args.workspace.tmpDir, '/tmp',
        '--remount-ro', '/',
        '--chdir', args.workspace.commandCwd,
        '--clearenv',
        ...getSandboxEnvEntries(workspaceHome, args.hostRustSysroot).flatMap(([k, v]) => ['--setenv', k, v]),
        'bash', '-c', buildShellViewCommand(args.viewDir, args.command),
    ];
}

function getRuntimeInvocation(args: {
    runtime: SandboxRuntime;
    workspace: SandboxCommandWorkspace;
    command: string;
    containerName: string;
    viewDir: string;
}): { executable: string; args: string[] } {
    const hostRustSysroot = getHostRustSysroot();
    return args.runtime === 'bwrap'
        ? { executable: getBubblewrapExecutable(), args: buildBubblewrapArgs({ ...args, hostRustSysroot }) }
        : { executable: getSandboxExecutable(), args: buildDockerArgs({ ...args, hostRustSysroot }) };
}

async function stopContainer(runtime: SandboxRuntime, containerName: string): Promise<void> {
    if (runtime !== 'docker') return;
    await new Promise<void>(resolve => {
        const child = spawn(getSandboxExecutable(), ['rm', '-f', containerName], { stdio: 'ignore' });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
    });
}

async function runSandboxCommand(
    sessionId: string,
    workspace: SandboxCommandWorkspace,
    command: string,
    timeoutMs: number,
    viewDir = '/tmp/.sandbox-view'
): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs || getDefaultTimeoutMs(), getMaxTimeoutMs()));
    const containerName = `iterative-studio-${sessionId}-${randomUUID().slice(0, 8)}`;
    const runtime = getSandboxRuntime();
    const readOnlyCommand = isReadOnlyBashCommand(command);
    const effectiveCommand = rewriteCommandWithRtk(command);

    await mkdir(workspace.tmpDir, { recursive: true });
    return new Promise(resolve => {
        let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, timedOut = false, spawnFailed = false;
        const invocation = getRuntimeInvocation({ runtime, workspace, command: effectiveCommand, containerName, viewDir });
        const child = spawn(invocation.executable, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            timedOut = true;
            void stopContainer(runtime, containerName);
            child.kill('SIGKILL');
        }, boundedTimeout);

        child.stdout.on('data', chunk => ({ value: stdout, truncated: stdoutTruncated } = appendBounded(stdout, chunk, stdoutTruncated)));
        child.stderr.on('data', chunk => ({ value: stderr, truncated: stderrTruncated } = appendBounded(stderr, chunk, stderrTruncated)));
        child.on('error', error => {
            spawnFailed = true;
            clearTimeout(timer);
            resolve({
                ok: false, exitCode: 127, stdout, stderr,
                error: `Failed to start sandbox runtime '${runtime}' (${invocation.executable}): ${error.message}`,
                durationMs: Date.now() - startedAt, readOnlyCommand,
            });
        });
        child.on('close', code => {
            if (spawnFailed) return;
            clearTimeout(timer);
            const truncSuffix = ` tokens; redirect command output to an explicit workspace file when the full log matters]`;
            if (stdoutTruncated) stdout += `\n[stdout truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS}${truncSuffix}`;
            if (stderrTruncated) stderr += `\n[stderr truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS}${truncSuffix}`;
            const exitCode = timedOut ? 124 : (code ?? 1);
            resolve({
                ok: exitCode === 0, exitCode, stdout, stderr,
                error: timedOut ? `Sandbox command timed out after ${Math.round(boundedTimeout / 1000)} seconds. Files already written inside the workspace may remain.` : null,
                timedOut, durationMs: Date.now() - startedAt, readOnlyCommand,
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
        child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Git command "git ${args.join(' ')}" failed with code ${code}.\nStderr: ${stderr}`)));
        child.on('error', reject);
    });
}

async function runGitCommand(workspace: string, args: string[]): Promise<string> {
    return (await runGitCommandBuffer(workspace, args)).toString('utf8').trim();
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
            '/shared_workspace.md', '/.deepthink-meta.json', '/latest.gz',
        ];
        const lines = existing.split(/\r?\n/);
        const missing = requiredPatterns.filter(p => !lines.includes(p));
        if (missing.length > 0) {
            await writeFile(excludePath, `${existing.trimEnd()}\n${missing.join('\n')}\n`.replace(/^\n+/, ''), 'utf8');
        }
    } catch {}
}

async function initAndCommitWorkspace(workspace: string, commitMessage: string) {
    try {
        if (!(await fileExists(path.join(workspace, '.git')))) {
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
    return !segments.some(seg => seg === '..' || seg === '.' || !seg) &&
        segments.every(seg => /^[a-zA-Z0-9][a-zA-Z0-9_.()+\-\s]{0,120}$/.test(seg));
}

async function syncDeepthinkResultsSnapshot(payload: DeepthinkResultsSnapshotRequest): Promise<string> {
    if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId) || !isDeepthinkRepository(payload.repositoryId)) {
        throw new Error('A Deepthink repository id is required for a Results snapshot.');
    }
    const repository = await resolveRepositoryPath(payload.repositoryId);
    await mkdir(repository, { recursive: true });

    for (const file of payload.contextFiles || []) {
        if (!file || !isSafeResultsContextPath(file.path)) throw new Error('Invalid Results context file.');
        const destination = safeJoin(repository, file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        if (file.base64) {
            await writeFile(destination, Buffer.from(file.base64, 'base64'));
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
    const next = new Promise<void>(resolve => { release = resolve; });
    sessionWorkspacePrepLocks.set(lockKey, previous.then(() => next));
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (sessionWorkspacePrepLocks.get(lockKey) === next) sessionWorkspacePrepLocks.delete(lockKey);
    }
}

async function handleExecute(req: IncomingMessage, res: ServerResponse) {
    const payload = JSON.parse(await readRequestBody(req)) as SandboxExecuteRequest;
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';
    if (!command) return sendJson(res, 400, { ok: false, error: 'No sandbox command was provided.' });

    await getSandboxEnvironmentProfile();
    const executionViewId = randomUUID().slice(0, 8);
    const sandboxViewMountDir = `/tmp/.sandbox-view-${executionViewId}`;

    const { workspace, viewedImagesRoot, beforeImages } = await withSessionPrepLock(payload.sessionId, async () => {
        const preparedWorkspace = await prepareSandboxWorkspace(payload.sessionId, payload.repositoryAccess, payload.files);
        const viewHostRoot = path.join(preparedWorkspace.tmpDir, `.sandbox-view-${executionViewId}`);
        await rm(viewHostRoot, { recursive: true, force: true });
        if (!(await fileExists(path.join(gitWorkspaceFor(preparedWorkspace), '.git')))) {
            await initAndCommitWorkspace(gitWorkspaceFor(preparedWorkspace), 'Initial workspace seed');
        }
        const initialImages = snapshotImages(await listVisibleImageFiles(preparedWorkspace, false));
        activeSessionExecutions.set(payload.sessionId, (activeSessionExecutions.get(payload.sessionId) ?? 0) + 1);
        return { workspace: preparedWorkspace, viewedImagesRoot: viewHostRoot, beforeImages: initialImages };
    });

    let execution: SandboxExecutionResult;
    try {
        execution = await runSandboxCommand(payload.sessionId, workspace, command, payload.timeoutMs ?? getDefaultTimeoutMs(), sandboxViewMountDir);
    } finally {
        const remaining = (activeSessionExecutions.get(payload.sessionId) ?? 1) - 1;
        if (remaining <= 0) activeSessionExecutions.delete(payload.sessionId);
        else activeSessionExecutions.set(payload.sessionId, remaining);
    }

    const imagesAfterExecution = await listVisibleImageFiles(workspace, true);
    const visibleFiles = await listVisibleImageFiles(workspace, false);
    const changedImages = getChangedImages(beforeImages, imagesAfterExecution);
    const generatedTranscriptImages = await snapshotVisibleImagesForTranscript(workspace, changedImages);
    const viewedImages = await fileExists(viewedImagesRoot) ? await listImageFiles(viewedImagesRoot, payload.sessionId, true) : [];
    const viewedTranscriptImages = await snapshotImagesForTranscript(viewedImages, filename => safeJoin(viewedImagesRoot, filename));
    await rm(viewedImagesRoot, { recursive: true, force: true }).catch(() => undefined);

    sendJson(res, 200, {
        ...execution,
        sessionId: payload.sessionId,
        images: [...generatedTranscriptImages, ...viewedTranscriptImages],
        visibleFiles,
    });
}

function streamFile(res: ServerResponse, absolutePath: string) {
    res.statusCode = 200;
    res.setHeader('content-type', getMimeType(absolutePath) || 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    createReadStream(absolutePath).pipe(res);
}

async function handleFileRequest(pathname: string, res: ServerResponse) {
    const encodedRest = pathname.slice('/api/sandbox/files/'.length);
    const slashIndex = encodedRest.indexOf('/');
    if (slashIndex === -1) return sendText(res, 404, 'Image file not found.');

    const sessionId = decodeURIComponent(encodedRest.slice(0, slashIndex));
    const relativePath = encodedRest.slice(slashIndex + 1).split('/').map(decodeURIComponent).join('/');
    const workspace = await getWorkspaceContextForSession(sessionId);
    if (!workspace) return sendText(res, 404, 'Image file not found.');

    let absolutePath: string;
    try {
        absolutePath = resolveVisiblePath(workspace, relativePath);
    } catch {
        return sendText(res, 404, 'Image file not found.');
    }

    if (!(await fileExists(absolutePath)) && workspace.repositoryAccess?.agentDirectory && !relativePath.startsWith(`${workspace.repositoryAccess.agentDirectory}/`)) {
        const fallbackPath = safeJoin(workspace.visibleRootPath, `${workspace.repositoryAccess.agentDirectory}/${relativePath}`);
        if (await fileExists(fallbackPath)) absolutePath = fallbackPath;
    }
    if (!(await fileExists(absolutePath))) return sendText(res, 404, 'File not found.');
    streamFile(res, absolutePath);
}

async function handleArtifactRequest(pathname: string, res: ServerResponse) {
    const encodedRest = pathname.slice('/api/sandbox/artifacts/'.length);
    const slashIndex = encodedRest.indexOf('/');
    if (slashIndex === -1) return sendText(res, 404, 'Image artifact not found.');

    const artifactId = decodeURIComponent(encodedRest.slice(0, slashIndex));
    if (!isSafeSessionId(artifactId)) return sendText(res, 404, 'Image artifact not found.');
    const relativePath = encodedRest.slice(slashIndex + 1).split('/').map(decodeURIComponent).join('/');
    const absolutePath = safeJoin(path.join(ARTIFACT_ROOT, artifactId), relativePath);
    if (!(await fileExists(absolutePath))) return sendText(res, 404, 'Artifact not found.');
    streamFile(res, absolutePath);
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
            return (resultsRepository && await fileExists(resultsRepository)) ? { root: resultsRepository, isRepositoryView: true } : null;
        }
        const repository = await resolveRepositoryPath(args.repositoryId);
        return (await fileExists(repository)) ? { root: repository, isRepositoryView: true } : null;
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
        } else if (entry.isFile() && !EXCLUDE_FILES.has(entry.name)) {
            const fileStat = await stat(fullPath);
            files.push({ path: relativePath, size: fileStat.size, mtime: fileStat.mtimeMs });
        }
    }
    return files;
}

function parseExplorerQuery(req: IncomingMessage) {
    const { searchParams } = new URL(req.url || '/', 'http://localhost');
    return {
        sessionId: searchParams.get('sessionId') || '',
        repositoryId: searchParams.get('repositoryId') || '',
        relativePath: searchParams.get('path') || '',
        commit: searchParams.get('commit') || '',
        repositoryScope: searchParams.get('scope') === 'repository',
        base: searchParams.get('base') || '',
        head: searchParams.get('head') || '',
    };
}

const isSafeExplorerRevision = (rev: string) => rev === 'current' || /^[a-f0-9]{7,64}$/i.test(rev);

export async function handleSandboxBackendRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizeApiPathname(parsedUrl.pathname);
    if (!pathname.startsWith('/api/sandbox/')) return false;

    const requireMethod = (method: 'GET' | 'POST') => {
        if (req.method !== method) {
            sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
            return false;
        }
        return true;
    };

    try {
        if (pathname.startsWith('/api/sandbox/files/')) {
            await handleFileRequest(pathname, res);
            return true;
        }
        if (pathname.startsWith('/api/sandbox/artifacts/')) {
            await handleArtifactRequest(pathname, res);
            return true;
        }

        switch (pathname) {
            case '/api/sandbox/execute':
                if (requireMethod('POST')) await handleExecute(req, res);
                return true;

            case '/api/sandbox/snapshot': {
                if (!requireMethod('POST')) return true;
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
                    return true;
                }
                await initAndCommitWorkspace(workspace, payload.commitMessage || 'Workspace snapshot');
                const commit = await runGitCommand(workspace, ['rev-parse', 'HEAD']).catch(() => '');
                sendJson(res, 200, { ok: true, commit });
                return true;
            }

            case '/api/sandbox/repository/restore-strategy': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string; strategyDirectory?: string; commit?: string };
                if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) throw new Error('A valid repository id is required.');
                if (!payload.strategyDirectory || !/^Strategy-\d+$/.test(payload.strategyDirectory)) throw new Error('Only an active top-level Strategy-N directory can be restored.');
                if (!payload.commit || !/^[0-9a-f]{7,64}$/i.test(payload.commit)) throw new Error('A valid Git checkpoint is required.');
                const repository = await resolveRepositoryPath(payload.repositoryId);
                if (!(await fileExists(path.join(repository, '.git')))) throw new Error('Sandbox repository was not found.');
                await runGitCommand(repository, ['restore', `--source=${payload.commit}`, '--staged', '--worktree', '--', payload.strategyDirectory]);
                await runGitCommand(repository, ['clean', '-fd', '--', payload.strategyDirectory]);
                sendJson(res, 200, { ok: true });
                return true;
            }

            case '/api/sandbox/repository/results-snapshot': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as DeepthinkResultsSnapshotRequest;
                const resultPath = await syncDeepthinkResultsSnapshot(payload);
                sendJson(res, 200, { ok: true, resultPath });
                return true;
            }

            case '/api/sandbox/repository/ensure-deepthink': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string };
                if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId) || !isDeepthinkRepository(payload.repositoryId)) {
                    sendJson(res, 400, { ok: false, error: 'A valid Deepthink repository id is required.' });
                    return true;
                }
                const resultPath = await ensureDeepthinkResultsRepository(payload.repositoryId);
                sendJson(res, 200, { ok: true, resultPath });
                return true;
            }

            case '/api/sandbox/repository/save-latest-gz': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string; state?: unknown; gzBase64?: string };
                if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
                    sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
                    return true;
                }
                const repoPath = (await getDeepthinkResultsRepositoryPath(payload.repositoryId)) ?? (await ensureDeepthinkResultsRepository(payload.repositoryId));
                if (!repoPath || !(await fileExists(repoPath))) {
                    sendJson(res, 404, { ok: false, error: 'Results repository not found.' });
                    return true;
                }
                const latestGzPath = path.join(repoPath, 'latest.gz');
                if (payload.gzBase64) {
                    await writeFile(latestGzPath, Buffer.from(payload.gzBase64, 'base64'));
                } else if (payload.state) {
                    await writeFile(latestGzPath, zlib.gzipSync(Buffer.from(JSON.stringify(payload.state), 'utf8')));
                } else {
                    sendJson(res, 400, { ok: false, error: 'Either state or gzBase64 is required.' });
                    return true;
                }
                sendJson(res, 200, { ok: true, path: latestGzPath, repositoryId: payload.repositoryId });
                return true;
            }

            case '/api/sandbox/repository/open-directory': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse((await readRequestBody(req)) || '{}') as { repositoryId?: string };
                await mkdir(RESULTS_ROOT, { recursive: true });
                let targetPath = RESULTS_ROOT;
                if (payload.repositoryId) {
                    if (!isSafeRepositoryId(payload.repositoryId)) {
                        sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
                        return true;
                    }
                    const repoPath = await getDeepthinkResultsRepositoryPath(payload.repositoryId);
                    if (repoPath && await fileExists(repoPath)) targetPath = repoPath;
                }
                const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
                const child = spawn(cmd, [targetPath], { detached: true, stdio: 'ignore' });
                child.unref();
                child.on('error', err => console.warn('Notice: failed to open directory in system file manager:', err));
                sendJson(res, 200, { ok: true, path: targetPath });
                return true;
            }

            case '/api/sandbox/repository/archive-strategy': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string; strategyDirectory?: string };
                if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
                    sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
                    return true;
                }
                if (!payload.strategyDirectory || !isSafeRepositoryDirectory(payload.strategyDirectory)) {
                    sendJson(res, 400, { ok: false, error: 'A valid strategyDirectory is required.' });
                    return true;
                }
                const archived = await archiveStrategyRepositoryDirectory(payload.repositoryId, payload.strategyDirectory);
                sendJson(res, 200, { ok: true, ...archived });
                return true;
            }

            case '/api/sandbox/environment':
                if (requireMethod('GET')) sendJson(res, 200, await getSandboxEnvironmentProfile());
                return true;

            case '/api/sandbox/workspace/history': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId } = parseExplorerQuery(req);
                const target = await resolveExplorerRepositoryTarget({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined, repositoryScope: true });
                if (!target) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (!(await fileExists(path.join(target.root, '.git')))) { sendJson(res, 200, []); return true; }
                try {
                    const logOutput = await runGitCommand(target.root, ['log', '--pretty=format:%H|%ad|%s', '--date=iso']);
                    const commits = logOutput.split('\n').filter(Boolean).map(line => {
                        const [hash, date, ...msg] = line.split('|');
                        return { hash, date, message: msg.join('|') };
                    });
                    sendJson(res, 200, commits);
                } catch {
                    sendJson(res, 200, []);
                }
                return true;
            }

            case '/api/sandbox/workspace/files': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId, commit, repositoryScope } = parseExplorerQuery(req);
                const target = await resolveExplorerRepositoryTarget({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined, repositoryScope });
                if (!target) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (commit && commit !== 'current') {
                    if (!(await fileExists(path.join(target.root, '.git')))) {
                        sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                        return true;
                    }
                    const filesOutput = await runGitCommand(target.root, ['ls-tree', '-r', '--name-only', commit]);
                    const files = filesOutput.split('\n').filter(Boolean)
                        .filter(fp => !EXCLUDE_DIRS.has(fp.split('/')[0]))
                        .map(fp => ({ path: fp, size: 0, mtime: 0 }));
                    sendJson(res, 200, files);
                } else {
                    const files = target.isRepositoryView ? await walkDir(target.root, target.root) : await listVisibleFiles(target.workspace!);
                    sendJson(res, 200, files);
                }
                return true;
            }

            case '/api/sandbox/workspace/file': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId, relativePath, commit, repositoryScope } = parseExplorerQuery(req);
                const target = await resolveExplorerRepositoryTarget({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined, repositoryScope });
                if (!target) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                const absolutePath = target.isRepositoryView ? safeJoin(target.root, relativePath) : resolveVisiblePath(target.workspace!, relativePath);
                const mimeType = getMimeType(absolutePath) || 'text/plain; charset=utf-8';
                if (commit && commit !== 'current') {
                    if (!(await fileExists(path.join(target.root, '.git')))) {
                        sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                        return true;
                    }
                    const content = await runGitCommandBuffer(target.root, ['show', `${commit}:${relativePath}`]);
                    res.statusCode = 200;
                    res.setHeader('content-type', mimeType);
                    res.setHeader('cache-control', 'no-store');
                    res.end(content);
                } else {
                    if (!(await fileExists(absolutePath))) { sendJson(res, 404, { ok: false, error: 'File not found.' }); return true; }
                    const content = await readFile(absolutePath);
                    res.statusCode = 200;
                    res.setHeader('content-type', mimeType);
                    res.setHeader('cache-control', 'no-store');
                    res.end(content);
                }
                return true;
            }

            case '/api/sandbox/workspace/diff': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId, base, head } = parseExplorerQuery(req);
                if ((!sessionId && !repositoryId) || !isSafeExplorerRevision(base) || !isSafeExplorerRevision(head)) {
                    sendJson(res, 400, { ok: false, error: 'Two valid revisions are required.' });
                    return true;
                }
                const target = await resolveExplorerRepositoryTarget({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined, repositoryScope: true });
                if (!target) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (!(await fileExists(path.join(target.root, '.git')))) {
                    sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                    return true;
                }
                if (base === head) {
                    sendText(res, 200, '', 'text/x-diff; charset=utf-8');
                    return true;
                }
                const args = ['diff', '--find-renames', '--find-copies', '--no-ext-diff'];
                if (base === 'current') args.push('-R', head);
                else if (head === 'current') args.push(base);
                else args.push(base, head);
                args.push(
                    '--', '.',
                    ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg'].map(ext => `:(exclude,glob)**/*.${ext}`),
                    ':(exclude,glob)**/.*', ':(exclude,glob)**/.*/**', ':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/node_modules/**',
                );
                const diff = await runGitCommandBuffer(target.root, args);
                res.statusCode = 200;
                res.setHeader('content-type', 'text/x-diff; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                res.end(diff);
                return true;
            }

            default:
                return false;
        }
    } catch (error) {
        sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error || 'Sandbox backend error.'),
        });
        return true;
    }
}
