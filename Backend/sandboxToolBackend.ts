import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, createReadStream, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { getEncoding } from 'js-tiktoken';

const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
    'image/tiff': '.tiff', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
    'application/pdf': '.pdf', 'image/png': '.png',
};

function extensionForMimeType(mimeType: string): string {
    return MIME_EXTENSIONS[mimeType] ?? (mimeType.startsWith('image/') ? '.png' : '.bin');
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
    fullRepositoryRead?: boolean;
}

interface SandboxSessionMetadata {
    schema: 'iterative_studio_sandbox_session.v1';
    repositoryAccess: SandboxRepositoryAccessRequest;
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
}

type SandboxRuntime = 'docker' | 'bwrap' | 'seatbelt';

export type SandboxProtectionLayer = 'L0' | 'L1' | 'L2' | 'L3';

interface SandboxNestedMount {
    layer?: SandboxProtectionLayer;
    source: string;
    target: string;
    readonly: boolean;
}

interface SandboxCommandWorkspace {
    sessionId: string;
    rootHostPath: string;
    rootReadonly: boolean;
    tmpDir: string;
    commandCwd: string;
    nestedMounts: SandboxNestedMount[];
    visibleRootPath: string;
    writablePath: string;
    repositoryAccess: SandboxRepositoryAccessRequest;
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
    python: {
        available: boolean;
        executable?: string;
    };
    node: {
        available: boolean;
        version?: string;
    };
    commands: Array<{ name: string; available: boolean }>;
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

const HOME_DIR = os.homedir();
const CACHE_ROOT = process.env.XDG_CACHE_HOME || path.join(HOME_DIR, '.cache');
const HOST_PIP_CACHE_DIR = path.join(CACHE_ROOT, 'pip');
const HOST_UV_CACHE_DIR = path.join(CACHE_ROOT, 'uv');
const HOST_NPM_CACHE_DIR = path.join(HOME_DIR, '.npm');
const RTK_BIN_DIR = path.join(CACHE_ROOT, 'rtk', 'bin');

const SANDBOX_HOST_USER_LOCAL = '/host-user-local';
const SANDBOX_HOST_CARGO = '/host-cargo';
const SANDBOX_HOST_RUSTUP = '/host-rustup';
const SANDBOX_HOST_ELAN = '/host-elan';
const SANDBOX_RTK_BIN = '/host-rtk-bin';
const SANDBOX_PIP_CACHE = '/var/cache/pip';
const SANDBOX_UV_CACHE = '/var/cache/uv';
const SANDBOX_NPM_CACHE = '/var/cache/npm';

const ARTIFACT_ROOT = path.join(os.tmpdir(), 'iterative-studio-sandbox-artifacts');
const RESULTS_ROOT = process.env.ITERATIVE_STUDIO_RESULTS_ROOT || path.join(process.cwd(), 'Results');
const DEEPTHINK_RESULTS_METADATA_ROOT = path.join(os.tmpdir(), 'iterative-studio-deepthink-results');
const SESSION_METADATA_ROOT = path.join(DEEPTHINK_RESULTS_METADATA_ROOT, 'sessions');
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

let sandboxEnvironmentPromise: Promise<SandboxEnvironmentProfile> | null = null;
const sessionWorkspacePrepLocks = new Map<string, Promise<void>>();
const sessionMetadataCache = new Map<string, SandboxRepositoryAccessRequest>();
const RTK_VERSION = 'v1.0.1';

function rewriteCommandWithRtk(command: string): string {
    const rtkExecutable = findExecutableInPath('rtk');
    if (!rtkExecutable) return command;
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

function isSafeRepositoryDirectory(directory: string): boolean {
    if (!directory || directory.includes('\\') || directory.startsWith('/') || directory.endsWith('/')) return false;
    return directory.split('/').every(seg => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(seg));
}

async function resolveRepositoryPath(repositoryId: string, options?: { skipInitialCommit?: boolean }): Promise<string> {
    if (!isSafeRepositoryId(repositoryId)) throw new Error('Invalid sandbox repository id.');
    return ensureDeepthinkResultsRepository(repositoryId, options);
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
    if (!isSafeRepositoryId(repositoryId)) return null;
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

async function ensureDeepthinkResultsRepository(repositoryId: string, options?: { skipInitialCommit?: boolean }): Promise<string> {
    const existing = await getDeepthinkResultsRepositoryPath(repositoryId);
    if (existing) {
        if (!options?.skipInitialCommit && !(await fileExists(path.join(existing, '.git')))) {
            await initAndCommitWorkspace(existing, 'Initial workspace seed');
        }
        return existing;
    }

    await mkdir(RESULTS_ROOT, { recursive: true });
    const baseName = deepthinkResultDirectoryName();
    let resultPath = path.join(RESULTS_ROOT, baseName);
    let suffix = 1;
    while (await fileExists(resultPath)) {
        resultPath = path.join(RESULTS_ROOT, `${baseName}-${suffix++}`);
    }
    await mkdir(resultPath, { recursive: true });
    await persistDeepthinkResultsMetadata(repositoryId, resultPath);
    if (!options?.skipInitialCommit) {
        await initAndCommitWorkspace(resultPath, 'Initial workspace seed');
    }
    return resultPath;
}

function sanitizeRepositoryAccess(accessRequest: SandboxRepositoryAccessRequest | undefined, fallbackSessionId: string): SandboxRepositoryAccessRequest {
    const repositoryId = accessRequest?.repositoryId || `deepthink-${fallbackSessionId}`;
    if (!isSafeRepositoryId(repositoryId)) throw new Error('Invalid sandbox repository id.');
    if (accessRequest?.agentDirectory !== undefined && !isSafeRepositoryDirectory(accessRequest.agentDirectory)) {
        throw new Error('Invalid sandbox agent directory.');
    }

    return {
        repositoryId,
        ...(accessRequest?.agentDirectory ? { agentDirectory: accessRequest.agentDirectory } : {}),
        ...(accessRequest?.agentDirectoryReadOnly ? { agentDirectoryReadOnly: true } : {}),
        fullRepositoryRead: accessRequest?.fullRepositoryRead !== false,
    };
}

// ============================================================================
// L0–L3 OS-Inspired Sandbox & Harness Protection Hierarchy
// - L0: LLM Model Weights (Immutable Substrate)
// - L1: Direct Prompt Context (Assembled per turn by Harness)
// - L2: Mutable Agent Workspace (/workspace/Strategy-N, /workspace/Modules/.../Module-M, /workspace/tmp, shared_workspace.md)
// - L3: Harness Kernel & Immutable Ledger (.git, user_uploaded, Strategy-N/history, Strategy-N/strategy.md,
//       State_Synthesis_history, strategies_history, Pruned_Strategies, Modules/**/*.md|*.jsonl|*.json, root .env Secret Store)
// ============================================================================

const L3_IMMUTABLE_FILE_MODE = 0o444;
const L3_UNLOCKED_FILE_MODE = 0o644;

const L3_RESERVED_ENV_KEYS = new Set([
    'PATH', 'HOME', 'TMPDIR', 'WORKSPACE', 'USER', 'SHELL', 'PWD',
    'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE',
    'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_HOME', 'ELAN_HOME',
    'PIP_TARGET', 'PYTHONPATH', 'PYTHONUSERBASE', 'PIP_CACHE_DIR', 'UV_CACHE_DIR',
    'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
    'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
    'MPLBACKEND', 'MPLCONFIGDIR',
]);

function getL3EnvFilePath(): string {
    return path.join(process.cwd(), '.env');
}

function parseL3DotEnvText(raw: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        map.set(key, val);
    }
    return map;
}

function formatL3DotEnvValue(value: string): string {
    if (/[\s#"']/.test(value)) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}

function maskL3SecretValue(value: string): string {
    if (!value) return 'Empty';
    return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
}

function readL3EnvSecretStoreMapSync(): Map<string, string> {
    try {
        const raw = readFileSync(getL3EnvFilePath(), 'utf8');
        return parseL3DotEnvText(raw);
    } catch {
        return new Map();
    }
}

export async function listL3EnvSecrets(): Promise<Array<{ key: string; maskedValue: string }>> {
    const envPath = getL3EnvFilePath();
    try {
        const raw = await readFile(envPath, 'utf8');
        const map = parseL3DotEnvText(raw);
        return Array.from(map.entries()).map(([key, value]) => ({
            key,
            maskedValue: maskL3SecretValue(value),
        }));
    } catch {
        return [];
    }
}

export async function setL3EnvSecret(rawKey: string, rawValue: string): Promise<Array<{ key: string; maskedValue: string }>> {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error('Environment key must match ^[A-Za-z_][A-Za-z0-9_]*$ (e.g. HF_TOKEN, WANDB_API_KEY).');
    }
    if (L3_RESERVED_ENV_KEYS.has(key)) {
        throw new Error(`Environment key "${key}" is reserved by the sandbox runtime.`);
    }
    if (!value) {
        throw new Error('Secret value cannot be empty.');
    }

    const envPath = getL3EnvFilePath();
    await mkdir(path.dirname(envPath), { recursive: true });
    const existingRaw = await readFile(envPath, 'utf8').catch(() => '');
    const lines = existingRaw ? existingRaw.split(/\r?\n/) : [];
    const formattedLine = `${key}=${formatL3DotEnvValue(value)}`;
    const keyRegex = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
    let replaced = false;
    const nextLines = lines.map(line => {
        if (keyRegex.test(line.trim())) {
            replaced = true;
            return formattedLine;
        }
        return line;
    });
    if (!replaced) {
        if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
            nextLines.splice(nextLines.length - 1, 0, formattedLine);
        } else {
            nextLines.push(formattedLine);
        }
    }
    const output = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
    await writeFile(envPath, output, 'utf8');
    await chmod(envPath, 0o600).catch(() => undefined);
    process.env[key] = value;
    sandboxEnvironmentPromise = null;
    return listL3EnvSecrets();
}

export async function removeL3EnvSecret(rawKey: string): Promise<Array<{ key: string; maskedValue: string }>> {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error('Invalid environment key name.');
    }
    const envPath = getL3EnvFilePath();
    const existingRaw = await readFile(envPath, 'utf8').catch(() => '');
    if (existingRaw) {
        const keyRegex = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
        const nextLines = existingRaw.split(/\r?\n/).filter(line => !keyRegex.test(line.trim()));
        const trimmed = nextLines.join('\n').replace(/\n+$/, '');
        await writeFile(envPath, trimmed ? `${trimmed}\n` : '', 'utf8');
    }
    delete process.env[key];
    sandboxEnvironmentPromise = null;
    return listL3EnvSecrets();
}

function maskL3SecretsInOutput(text: string, secrets: Map<string, string>): string {
    if (!text || secrets.size === 0) return text;
    let masked = text;
    for (const [key, value] of secrets.entries()) {
        if (!value || value.length < 4) continue;
        if (masked.includes(value)) {
            masked = masked.split(value).join(`[REDACTED_L3_SECRET:${key}]`);
        }
    }
    return masked;
}

async function writeL3ImmutableFile(destination: string, content: string | Buffer): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    await chmod(destination, L3_UNLOCKED_FILE_MODE).catch(() => undefined);
    if (typeof content === 'string') {
        await writeFile(destination, content, 'utf8');
    } else {
        await writeFile(destination, content);
    }
    await chmod(destination, L3_IMMUTABLE_FILE_MODE).catch(() => undefined);
}

async function unlockL3TreeForRestore(dirPath: string): Promise<void> {
    if (!(await fileExists(dirPath))) return;
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const childPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await chmod(childPath, 0o755).catch(() => undefined);
            await unlockL3TreeForRestore(childPath);
        } else if (entry.isFile()) {
            await chmod(childPath, L3_UNLOCKED_FILE_MODE).catch(() => undefined);
        }
    }
}

async function restampL3StrategyArtifacts(strategyDirPath: string): Promise<void> {
    if (!(await fileExists(strategyDirPath))) return;
    const strategyMd = path.join(strategyDirPath, 'strategy.md');
    if (await fileExists(strategyMd)) {
        await chmod(strategyMd, L3_IMMUTABLE_FILE_MODE).catch(() => undefined);
    }
    const historyDir = path.join(strategyDirPath, 'history');
    if (await fileExists(historyDir)) {
        const entries = await readdir(historyDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isFile()) {
                await chmod(path.join(historyDir, entry.name), L3_IMMUTABLE_FILE_MODE).catch(() => undefined);
            }
        }
    }
}

async function createActiveStrategyDirectory(repoRoot: string, strategyDirectory: string): Promise<void> {
    const activeDirectory = safeJoin(repoRoot, strategyDirectory);
    await mkdir(path.join(activeDirectory, 'history'), { recursive: true });
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
        const archivedTarget = safeJoin(prunedRoot, archiveName);
        await rename(activeDirectory, archivedTarget);
        await restampL3StrategyArtifacts(archivedTarget);
        archivedDirectory = `Pruned_Strategies/${archiveName}`;
    }

    await createActiveStrategyDirectory(repoRoot, strategyDirectory);
    return { archivedDirectory, activeDirectory: strategyDirectory };
}

async function writeSessionMetadata(sessionId: string, repositoryAccess: SandboxRepositoryAccessRequest): Promise<void> {
    if (!isSafeSessionId(sessionId)) return;
    sessionMetadataCache.set(sessionId, repositoryAccess);
    await mkdir(SESSION_METADATA_ROOT, { recursive: true });
    const metadata: SandboxSessionMetadata = { schema: 'iterative_studio_sandbox_session.v1', repositoryAccess };
    await writeFile(path.join(SESSION_METADATA_ROOT, `${sessionId}.json`), JSON.stringify(metadata)).catch(() => {});
}

async function readSessionMetadata(sessionId: string): Promise<SandboxRepositoryAccessRequest | null> {
    if (!isSafeSessionId(sessionId)) return null;
    const cached = sessionMetadataCache.get(sessionId);
    if (cached) return cached;
    try {
        const parsed = JSON.parse(await readFile(path.join(SESSION_METADATA_ROOT, `${sessionId}.json`), 'utf8')) as SandboxSessionMetadata;
        if (parsed?.schema === 'iterative_studio_sandbox_session.v1' && parsed.repositoryAccess) {
            sessionMetadataCache.set(sessionId, parsed.repositoryAccess);
            return parsed.repositoryAccess;
        }
    } catch {}
    return null;
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

function isReadableDirectorySync(dirPath: string): boolean {
    try {
        accessSync(dirPath, fsConstants.R_OK);
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

const getHostEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...process.env, ...extra });

function hostToolPath(): string {
    return [
        RTK_BIN_DIR,
        path.join(HOME_DIR, '.local', 'bin'),
        path.join(HOME_DIR, '.cargo', 'bin'),
        path.join(HOME_DIR, '.elan', 'bin'),
        process.env.PATH || '',
    ].filter(Boolean).join(path.delimiter);
}

function findExecutableInPath(command: string, pathEnv = hostToolPath()): string | null {
    if (command.includes(path.sep) || command.startsWith('/')) {
        try {
            accessSync(command, fsConstants.X_OK);
            return command;
        } catch {
            return null;
        }
    }
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, command);
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {}
    }
    return null;
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
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
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

async function ensureSandboxRuntime(setupErrors: string[]): Promise<void> {
    const requested = (process.env.ITERATIVE_STUDIO_SANDBOX_RUNTIME || 'auto').toLowerCase();
    const dockerReady = canUseDockerSocket() && !!findExecutableInPath(getSandboxExecutable());
    const bwrapReady = !!findExecutableInPath(getBubblewrapExecutable());
    const seatbeltReady = canUseSeatbelt();

    if (requested === 'docker') {
        if (!dockerReady) {
            setupErrors.push(`Docker runtime was requested, but '${getSandboxExecutable()}' or the Docker daemon socket is unavailable.`);
        }
        return;
    }

    if (requested === 'seatbelt' || requested === 'sandbox-exec') {
        if (!seatbeltReady) {
            setupErrors.push(`Seatbelt runtime was requested, but '${getSeatbeltExecutable()}' is only available on macOS.`);
        }
        return;
    }

    if (process.platform === 'darwin' && requested === 'auto' && seatbeltReady) {
        return;
    }

    if ((requested === 'bwrap' || requested === 'bubblewrap' || (!dockerReady && !seatbeltReady)) && !bwrapReady) {
        if (process.platform === 'linux') {
            const sudoPrefix = typeof process.getuid === 'function' && process.getuid() !== 0 ? 'sudo -n ' : '';
            const installScript = [
                `if command -v apt-get >/dev/null 2>&1; then ${sudoPrefix}apt-get update -qq && DEBIAN_FRONTEND=noninteractive ${sudoPrefix}apt-get install -y -qq bubblewrap;`,
                `elif command -v dnf >/dev/null 2>&1; then ${sudoPrefix}dnf install -y -q bubblewrap;`,
                `elif command -v yum >/dev/null 2>&1; then ${sudoPrefix}yum install -y -q bubblewrap;`,
                `elif command -v apk >/dev/null 2>&1; then ${sudoPrefix}apk add --no-cache bubblewrap;`,
                `elif command -v pacman >/dev/null 2>&1; then ${sudoPrefix}pacman -S --noconfirm bubblewrap;`,
                `elif command -v zypper >/dev/null 2>&1; then ${sudoPrefix}zypper --non-interactive install bubblewrap;`,
                `else exit 1; fi`,
            ].join(' ');
            const installResult = await runHostCommand('sh', ['-lc', installScript], { timeoutMs: 180_000 });
            if (!installResult.ok && !findExecutableInPath(getBubblewrapExecutable())) {
                setupErrors.push(`Failed to auto-install bubblewrap (bwrap): ${installResult.stderr || installResult.stdout || 'package manager unavailable'}`);
            }
        } else if (!dockerReady && !seatbeltReady) {
            setupErrors.push(`No OS sandbox runtime available on ${process.platform}: start Docker Desktop or run inside WSL2.`);
        }
    }

    if (!canUseDockerSocket() && !findExecutableInPath(getBubblewrapExecutable()) && !canUseSeatbelt()) {
        setupErrors.push(`No operational sandbox runtime found: neither bubblewrap, macOS sandbox-exec, nor Docker is available.`);
    }
}

async function ensureRtkBinary(setupErrors: string[]): Promise<void> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    if (findExecutableInPath('rtk')) return;
    const rtkBinaryPath = path.join(RTK_BIN_DIR, 'rtk');
    try {
        await mkdir(RTK_BIN_DIR, { recursive: true });
        const archAsset = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'rtk-aarch64-apple-darwin.tar.gz' : 'rtk-x86_64-apple-darwin.tar.gz')
            : (process.arch === 'arm64' ? 'rtk-aarch64-unknown-linux-gnu.tar.gz' : 'rtk-x86_64-unknown-linux-musl.tar.gz');
        const downloadUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${archAsset}`;
        const installResult = await runHostCommand(
            'bash',
            ['-lc', `curl -fsSL "${downloadUrl}" | tar -xz -C "${RTK_BIN_DIR}" && chmod 755 "${rtkBinaryPath}"`],
            { timeoutMs: 60_000 }
        );
        if (!installResult.ok) {
            setupErrors.push(`rtk binary install failed: ${installResult.stderr || installResult.stdout}`);
        }
    } catch (error) {
        setupErrors.push(`rtk setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function buildAgentEnvironmentSummary(profile: Omit<SandboxEnvironmentProfile, 'agentSummary'>): string {
    const availableCommands = profile.commands.filter(command => command.available).map(command => command.name);
    const lines = [
        '- Workspace: isolated workspace directory at /workspace ($WORKSPACE). Host toolchains and caches are mounted read-only.',
        '- Python: uses host Python and packages directly. Any extra package installed via `pip install <pkg>` is cached in the system wheel cache and unpacked into /tmp/.shared-python-pkgs (on PYTHONPATH and PATH), shared across all agents in this run.',
        '- Node.js: uses host Node directly. Extra packages installed via `npm install -g <pkg>` are cached in the system npm cache and unpacked into /tmp/.shared-node-pkgs (on NODE_PATH and PATH), shared across all agents in this run.',
    ];

    if (availableCommands.length > 0) {
        lines.push(`- Detected commands include: ${availableCommands.join(', ')}.`);
    }

    const secretKeys = Array.from(readL3EnvSecretStoreMapSync().keys()).filter(k => !L3_RESERVED_ENV_KEYS.has(k));
    if (secretKeys.length > 0) {
        lines.push(`- L3 Secret Store (.env): ${secretKeys.length} environment key(s) configured (${secretKeys.map(k => `$${k}`).join(', ')}). Available in sandbox commands; raw secret values are automatically redacted from command output.`);
    }

    return lines.join('\n');
}

async function buildSandboxEnvironmentProfile(): Promise<SandboxEnvironmentProfile> {
    const setupErrors: string[] = [];
    await Promise.all([
        mkdir(HOST_PIP_CACHE_DIR, { recursive: true }).catch(() => {}),
        mkdir(HOST_UV_CACHE_DIR, { recursive: true }).catch(() => {}),
        mkdir(HOST_NPM_CACHE_DIR, { recursive: true }).catch(() => {}),
        ensureSandboxRuntime(setupErrors),
        ensureRtkBinary(setupErrors),
    ]);

    const currentPath = hostToolPath();
    const commands = PROBED_COMMANDS.map(name => ({
        name,
        available: !!findExecutableInPath(name, currentPath),
    }));

    const pythonExecutable = findExecutableInPath('python3', currentPath)
        || findExecutableInPath('python', currentPath)
        || undefined;
    const nodeAvailable = !!findExecutableInPath('node', currentPath);

    const profileWithoutSummary: Omit<SandboxEnvironmentProfile, 'agentSummary'> = {
        ok: setupErrors.length === 0,
        runtime: getSandboxRuntime(),
        python: {
            available: !!pythonExecutable,
            executable: pythonExecutable,
        },
        node: {
            available: nodeAvailable,
            version: process.version,
        },
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

export async function ensureSandboxEnvironmentReady(options: { strict?: boolean } = {}): Promise<SandboxEnvironmentProfile> {
    const profile = await getSandboxEnvironmentProfile();
    const runtimeAvailable = (profile.runtime === 'bwrap' && !!findExecutableInPath(getBubblewrapExecutable()))
        || (profile.runtime === 'seatbelt' && canUseSeatbelt())
        || (profile.runtime === 'docker' && canUseDockerSocket() && !!findExecutableInPath(getSandboxExecutable()));

    if (options.strict && !runtimeAvailable) {
        const details = [`Sandbox runtime '${profile.runtime}' is not available.`, ...profile.setupErrors].join(' | ');
        throw new Error(`Sandbox environment setup check failed: ${details}`);
    }
    return profile;
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
        if (!(await fileExists(destination))) {
            await writeL3ImmutableFile(destination, Buffer.from(file.base64, 'base64'));
        }
    }
}

async function prepareSandboxWorkspace(
    sessionId: string,
    accessRequest: SandboxRepositoryAccessRequest | undefined,
    files: SeedFile[] | undefined
): Promise<SandboxCommandWorkspace> {
    const repositoryAccess = sanitizeRepositoryAccess(accessRequest, sessionId);
    const repoRoot = await resolveRepositoryPath(repositoryAccess.repositoryId);
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const ownDirectory = repositoryAccess.agentDirectory ? safeJoin(repoRoot, repositoryAccess.agentDirectory) : undefined;

    await mkdir(repoRoot, { recursive: true });
    await mkdir(sharedTmpDir, { recursive: true });
    if (ownDirectory) {
        const strategyMatch = repositoryAccess.agentDirectory?.match(/^(Strategy-\d+)$/);
        if (strategyMatch) {
            await createActiveStrategyDirectory(repoRoot, strategyMatch[1]);
        } else {
            await mkdir(ownDirectory, { recursive: true });
        }
        await mkdir(path.join(ownDirectory, '.tmp'), { recursive: true });
    }
    await seedWorkspaceFiles(repoRoot, files);

    if (!(await fileExists(path.join(repoRoot, '.git')))) {
        await initAndCommitWorkspace(repoRoot, 'Initial shared workspace seed');
    }

    const sourceUploads = safeJoin(repoRoot, 'user_uploaded');
    const sourceGit = safeJoin(repoRoot, '.git');

    const l3StrategyOverlays: SandboxNestedMount[] = [];
    if (
        ownDirectory &&
        repositoryAccess.agentDirectory &&
        /^Strategy-\d+$/.test(repositoryAccess.agentDirectory) &&
        repositoryAccess.agentDirectoryReadOnly !== true
    ) {
        const strategyHistoryDir = path.join(ownDirectory, 'history');
        await mkdir(strategyHistoryDir, { recursive: true });
        l3StrategyOverlays.push({
            layer: 'L3',
            source: strategyHistoryDir,
            target: `/workspace/${repositoryAccess.agentDirectory}/history`,
            readonly: true,
        });
        const strategyMdPath = path.join(ownDirectory, 'strategy.md');
        if (await fileExists(strategyMdPath)) {
            l3StrategyOverlays.push({
                layer: 'L3',
                source: strategyMdPath,
                target: `/workspace/${repositoryAccess.agentDirectory}/strategy.md`,
                readonly: true,
            });
        }
    }

    await writeSessionMetadata(sessionId, repositoryAccess);

    return {
        sessionId,
        rootHostPath: repoRoot,
        rootReadonly: true,
        tmpDir: sharedTmpDir,
        commandCwd: repositoryAccess.agentDirectory ? `/workspace/${repositoryAccess.agentDirectory}` : '/workspace',
        nestedMounts: [
            { layer: 'L2', source: sharedTmpDir, target: '/workspace/tmp', readonly: false },
            ...(await fileExists(sourceGit) ? [{ layer: 'L3' as const, source: sourceGit, target: '/workspace/.git', readonly: true }] : []),
            ...(await fileExists(sourceUploads) ? [{ layer: 'L3' as const, source: sourceUploads, target: '/workspace/user_uploaded', readonly: true }] : []),
            ...(repositoryAccess.agentDirectory ? [{
                layer: (repositoryAccess.agentDirectoryReadOnly === true ? 'L3' : 'L2') as SandboxProtectionLayer,
                source: safeJoin(repoRoot, repositoryAccess.agentDirectory),
                target: `/workspace/${repositoryAccess.agentDirectory}`,
                readonly: repositoryAccess.agentDirectoryReadOnly === true,
            }] : []),
            ...l3StrategyOverlays,
        ],
        visibleRootPath: repoRoot,
        writablePath: (!repositoryAccess.agentDirectoryReadOnly && ownDirectory) || sharedTmpDir,
        repositoryAccess,
    };
}

async function getWorkspaceContextForSession(sessionId: string): Promise<SandboxCommandWorkspace | null> {
    const metadataAccess = await readSessionMetadata(sessionId);
    if (!metadataAccess) return null;
    const repositoryAccess = sanitizeRepositoryAccess(metadataAccess, sessionId);
    const repoRoot = await getDeepthinkResultsRepositoryPath(repositoryAccess.repositoryId);
    if (!repoRoot || !(await fileExists(repoRoot))) return null;
    const sharedTmpDir = path.join(repoRoot, 'tmp');
    const ownDirectory = repositoryAccess.agentDirectory ? safeJoin(repoRoot, repositoryAccess.agentDirectory) : undefined;
    return {
        sessionId,
        rootHostPath: repoRoot,
        rootReadonly: true,
        tmpDir: sharedTmpDir,
        commandCwd: repositoryAccess.agentDirectory ? `/workspace/${repositoryAccess.agentDirectory}` : '/workspace',
        nestedMounts: [],
        visibleRootPath: repoRoot,
        writablePath: (!repositoryAccess.agentDirectoryReadOnly && ownDirectory) || sharedTmpDir,
        repositoryAccess,
    };
}

function resolveVisiblePath(context: SandboxCommandWorkspace, relativePath: string): string {
    return safeJoin(context.visibleRootPath, relativePath);
}

async function listVisibleFiles(context: SandboxCommandWorkspace): Promise<Array<{ path: string; size: number; mtime: number }>> {
    return walkDir(context.visibleRootPath, context.visibleRootPath);
}

async function listVisibleImageFiles(context: SandboxCommandWorkspace, includeBase64: boolean): Promise<VisibleImage[]> {
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
    return images.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function listDirectImageFiles(dirPath: string, sessionId: string): Promise<VisibleImage[]> {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    const images: VisibleImage[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const mimeType = getMimeType(entry.name);
        if (!mimeType?.startsWith('image/')) continue;
        const absolutePath = path.join(dirPath, entry.name);
        const fileStat = await stat(absolutePath);
        images.push({
            filename: entry.name,
            mimeType,
            size: fileStat.size,
            modifiedMs: fileStat.mtimeMs,
            url: `/api/sandbox/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(entry.name)}`,
            base64: (await readFile(absolutePath)).toString('base64'),
        });
    }
    return images.sort((a, b) => a.filename.localeCompare(b.filename));
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

const getSandboxExecutable = () => process.env.ITERATIVE_STUDIO_DOCKER || 'docker';
const getBubblewrapExecutable = () => process.env.ITERATIVE_STUDIO_BWRAP || 'bwrap';
const getSeatbeltExecutable = () => process.env.ITERATIVE_STUDIO_SEATBELT || '/usr/bin/sandbox-exec';
const getSandboxImage = () => process.env.ITERATIVE_STUDIO_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
const getSandboxNetworkMode = () => process.env.ITERATIVE_STUDIO_SANDBOX_NETWORK || 'bridge';

function sandboxHomeDirectory(workspace: SandboxCommandWorkspace): string {
    return (!workspace.repositoryAccess.agentDirectory || workspace.repositoryAccess.agentDirectoryReadOnly)
        ? '/tmp'
        : workspace.commandCwd;
}

function getSandboxUser(): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    return `${uid}:${gid}`;
}

function canUseSeatbelt(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
        accessSync(getSeatbeltExecutable(), fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
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
    if (requested === 'seatbelt' || requested === 'sandbox-exec') return 'seatbelt';
    if (process.platform === 'darwin' && canUseSeatbelt()) return 'seatbelt';
    if (canUseDockerSocket() && !!findExecutableInPath(getSandboxExecutable())) return 'docker';
    if (findExecutableInPath(getBubblewrapExecutable())) return 'bwrap';
    return process.platform === 'darwin' ? 'seatbelt' : 'docker';
}

const dockerMount = (source: string, target: string, readonly = false) =>
    `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;

interface SandboxEnvConfig {
    workspaceHome: string;
    workspaceRoot: string;
    tmpRoot: string;
    pipCacheDir: string;
    uvCacheDir: string;
    npmCacheDir: string;
    extraBinDirs: string[];
    extraPythonPaths?: string[];
    rustupHome?: string;
    elanHome?: string;
}

function getHostUserPythonSitePackages(mappedUserLocalRoot: string): string[] {
    try {
        const libDir = path.join(HOME_DIR, '.local', 'lib');
        return readdirSync(libDir)
            .filter(name => name.startsWith('python'))
            .map(name => `${mappedUserLocalRoot}/lib/${name}/site-packages`);
    } catch {
        return [];
    }
}

function getSandboxEnvEntries(cfg: SandboxEnvConfig): Array<[string, string]> {
    const runSharedBins = [
        `${cfg.tmpRoot}/.shared-python-pkgs/bin`,
        `${cfg.tmpRoot}/.python_user_base/bin`,
        `${cfg.tmpRoot}/.shared-node-pkgs/bin`,
        `${cfg.tmpRoot}/.cargo/bin`,
        ...cfg.extraBinDirs,
        `${cfg.workspaceHome}/.local/bin`,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ].filter(Boolean).join(':');

    const pythonPathEntries = [
        `${cfg.tmpRoot}/.shared-python-pkgs`,
        ...(cfg.extraPythonPaths || []),
    ].filter(Boolean).join(':');

    const baseEntries: Array<[string, string]> = [
        ['HOME', cfg.workspaceHome],
        ['WORKSPACE', cfg.workspaceRoot],
        ['TMPDIR', cfg.tmpRoot],
        ['XDG_CACHE_HOME', `${cfg.tmpRoot}/.cache`],
        ['XDG_DATA_HOME', `${cfg.tmpRoot}/.local/share`],
        ['XDG_CONFIG_HOME', `${cfg.tmpRoot}/.config`],
        ['MPLBACKEND', 'Agg'],
        ['MPLCONFIGDIR', `${cfg.tmpRoot}/.matplotlib`],
        ['PYTHONUNBUFFERED', '1'],
        ['PYTHONDONTWRITEBYTECODE', '1'],
        ['PIP_TARGET', `${cfg.tmpRoot}/.shared-python-pkgs`],
        ['PYTHONPATH', pythonPathEntries],
        ['PYTHONUSERBASE', `${cfg.tmpRoot}/.python_user_base`],
        ['PIP_CACHE_DIR', cfg.pipCacheDir],
        ['UV_CACHE_DIR', cfg.uvCacheDir],
        ['NPM_CONFIG_PREFIX', `${cfg.tmpRoot}/.shared-node-pkgs`],
        ['NPM_CONFIG_CACHE', cfg.npmCacheDir],
        ['NODE_PATH', `${cfg.tmpRoot}/.shared-node-pkgs/lib/node_modules:${cfg.tmpRoot}/.shared-node-pkgs/node_modules`],
        ['CARGO_HOME', `${cfg.tmpRoot}/.cargo`],
        ['CARGO_TARGET_DIR', `${cfg.tmpRoot}/cargo-target`],
        ...(cfg.rustupHome ? [['RUSTUP_HOME', cfg.rustupHome] as [string, string]] : []),
        ...(cfg.elanHome ? [['ELAN_HOME', cfg.elanHome] as [string, string]] : []),
        ['PATH', runSharedBins],
    ];
    const l3Secrets = readL3EnvSecretStoreMapSync();
    for (const [key, value] of l3Secrets.entries()) {
        if (!L3_RESERVED_ENV_KEYS.has(key) && value) {
            baseEntries.push([key, value]);
        }
    }
    return baseEntries;
}

function buildShellViewCommand(viewDir: string, command: string): string {
    return `umask 077; view() { mkdir -p "${viewDir}"; i=0; for f in "$@"; do i=$((i + 1)); touch -c "$f" 2>/dev/null || cp -- "$f" "${viewDir}/$i-$(basename "$f")" 2>/dev/null; done; }; open() { view "$@"; }; ${command}`;
}

function buildDockerArgs(args: {
    workspace: SandboxCommandWorkspace;
    command: string;
    containerName: string;
    viewDir: string;
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const hasPipCache = isReadableDirectorySync(HOST_PIP_CACHE_DIR);
    const hasUvCache = isReadableDirectorySync(HOST_UV_CACHE_DIR);
    const hasNpmCache = isReadableDirectorySync(HOST_NPM_CACHE_DIR);

    const envEntries = getSandboxEnvEntries({
        workspaceHome,
        workspaceRoot: '/workspace',
        tmpRoot: '/tmp',
        pipCacheDir: hasPipCache ? SANDBOX_PIP_CACHE : '/tmp/.cache/pip',
        uvCacheDir: hasUvCache ? SANDBOX_UV_CACHE : '/tmp/.cache/uv',
        npmCacheDir: hasNpmCache ? SANDBOX_NPM_CACHE : '/tmp/.cache/npm',
        extraBinDirs: [],
    });

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
        ...(hasPipCache ? ['--mount', dockerMount(HOST_PIP_CACHE_DIR, SANDBOX_PIP_CACHE, false)] : []),
        ...(hasUvCache ? ['--mount', dockerMount(HOST_UV_CACHE_DIR, SANDBOX_UV_CACHE, false)] : []),
        ...(hasNpmCache ? ['--mount', dockerMount(HOST_NPM_CACHE_DIR, SANDBOX_NPM_CACHE, false)] : []),
        ...envEntries.flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        getSandboxImage(),
        'bash', '-c', buildShellViewCommand(args.viewDir, args.command),
    ];
}

function buildBubblewrapArgs(args: {
    workspace: SandboxCommandWorkspace;
    command: string;
    viewDir: string;
}): string[] {
    const workspaceHome = sandboxHomeDirectory(args.workspace);
    const hostUserLocal = path.join(HOME_DIR, '.local');
    const hostCargo = path.join(HOME_DIR, '.cargo');
    const hostRustup = path.join(HOME_DIR, '.rustup');
    const hostElan = path.join(HOME_DIR, '.elan');

    const roHostToolchains: Array<[string, string]> = [
        [hostUserLocal, SANDBOX_HOST_USER_LOCAL],
        [hostCargo, SANDBOX_HOST_CARGO],
        [hostRustup, SANDBOX_HOST_RUSTUP],
        [hostElan, SANDBOX_HOST_ELAN],
        [RTK_BIN_DIR, SANDBOX_RTK_BIN],
    ];
    const rwHostCaches: Array<[string, string]> = [
        [HOST_PIP_CACHE_DIR, SANDBOX_PIP_CACHE],
        [HOST_UV_CACHE_DIR, SANDBOX_UV_CACHE],
        [HOST_NPM_CACHE_DIR, SANDBOX_NPM_CACHE],
    ];

    const envEntries = getSandboxEnvEntries({
        workspaceHome,
        workspaceRoot: '/workspace',
        tmpRoot: '/tmp',
        pipCacheDir: SANDBOX_PIP_CACHE,
        uvCacheDir: SANDBOX_UV_CACHE,
        npmCacheDir: SANDBOX_NPM_CACHE,
        extraBinDirs: [
            SANDBOX_RTK_BIN,
            `${SANDBOX_HOST_USER_LOCAL}/bin`,
            `${SANDBOX_HOST_CARGO}/bin`,
            `${SANDBOX_HOST_ELAN}/bin`,
        ],
        extraPythonPaths: getHostUserPythonSitePackages(SANDBOX_HOST_USER_LOCAL),
        rustupHome: isReadableDirectorySync(hostRustup) ? SANDBOX_HOST_RUSTUP : undefined,
        elanHome: isReadableDirectorySync(hostElan) ? SANDBOX_HOST_ELAN : undefined,
    });

    return [
        '--die-with-parent', '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts',
        ...(getSandboxNetworkMode() === 'none' ? ['--unshare-net'] : []),
        '--tmpfs', '/',
        '--dir', '/workspace', '--dir', '/tmp', '--dir', '/run', '--dir', '/run/systemd', '--dir', '/var/cache',
        '--proc', '/proc', '--dev', '/dev',
        ...BWRAP_SYSTEM_MOUNTS.flatMap(p => ['--ro-bind-try', p, p]),
        '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
        '--ro-bind-try', '/run/NetworkManager', '/run/NetworkManager',
        ...roHostToolchains.flatMap(([src, dst]) => isReadableDirectorySync(src) ? ['--dir', dst, '--ro-bind', src, dst] : []),
        ...rwHostCaches.flatMap(([src, dst]) => isReadableDirectorySync(src) ? ['--dir', dst, '--bind', src, dst] : []),
        ...(args.workspace.rootReadonly ? ['--ro-bind', args.workspace.rootHostPath, '/workspace'] : ['--bind', args.workspace.rootHostPath, '/workspace']),
        ...args.workspace.nestedMounts.flatMap(m => [m.readonly ? '--ro-bind' : '--bind', m.source, m.target]),
        '--bind', args.workspace.tmpDir, '/tmp',
        '--remount-ro', '/',
        '--chdir', args.workspace.commandCwd,
        '--clearenv',
        ...envEntries.flatMap(([k, v]) => ['--setenv', k, v]),
        'bash', '-c', buildShellViewCommand(args.viewDir, args.command),
    ];
}

function resolveSeatbeltPath(targetPath: string): string {
    try {
        return realpathSync(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

function buildSeatbeltInvocation(args: {
    workspace: SandboxCommandWorkspace;
    command: string;
    viewDir: string;
}): { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
    const hostCwd = args.workspace.repositoryAccess.agentDirectory
        ? safeJoin(args.workspace.rootHostPath, args.workspace.repositoryAccess.agentDirectory)
        : args.workspace.rootHostPath;
    const hostHome = (!args.workspace.repositoryAccess.agentDirectory || args.workspace.repositoryAccess.agentDirectoryReadOnly)
        ? args.workspace.tmpDir
        : hostCwd;
    const hostViewDir = path.join(args.workspace.tmpDir, path.basename(args.viewDir));
    const sbplPath = (p: string) => JSON.stringify(resolveSeatbeltPath(p));

    const hostUserLocal = path.join(HOME_DIR, '.local');
    const hostCargo = path.join(HOME_DIR, '.cargo');
    const hostRustup = path.join(HOME_DIR, '.rustup');
    const hostElan = path.join(HOME_DIR, '.elan');

    const readablePaths = [
        args.workspace.rootHostPath,
        args.workspace.tmpDir,
        ...args.workspace.nestedMounts.map(m => m.source),
        RTK_BIN_DIR,
        HOST_PIP_CACHE_DIR,
        HOST_UV_CACHE_DIR,
        HOST_NPM_CACHE_DIR,
        ...[hostUserLocal, hostCargo, hostRustup, hostElan].filter(isReadableDirectorySync),
    ];

    const ancestorMetadataLiterals = new Set<string>();
    for (const target of readablePaths) {
        let dir = path.dirname(resolveSeatbeltPath(target));
        while (dir && dir !== path.dirname(dir)) {
            ancestorMetadataLiterals.add(JSON.stringify(dir));
            dir = path.dirname(dir);
        }
    }

    const writablePaths = [
        '/dev',
        args.workspace.tmpDir,
        HOST_PIP_CACHE_DIR,
        HOST_UV_CACHE_DIR,
        HOST_NPM_CACHE_DIR,
        ...(!args.workspace.rootReadonly ? [args.workspace.rootHostPath] : []),
        ...args.workspace.nestedMounts.filter(m => !m.readonly).map(m => m.source),
    ];
    const readonlyPaths = args.workspace.nestedMounts.filter(m => m.readonly).map(m => m.source);

    const profileLines = [
        '(version 1)',
        '(allow default)',
        ...(getSandboxNetworkMode() === 'none' ? ['(deny network*)'] : []),
        `(deny file-read* (subpath ${sbplPath(HOME_DIR)}) (subpath ${sbplPath(process.cwd())}))`,
        ...(ancestorMetadataLiterals.size > 0
            ? [`(allow file-read-metadata ${Array.from(ancestorMetadataLiterals).map(p => `(literal ${p})`).join(' ')})`]
            : []),
        `(allow file-read* ${readablePaths.map(p => `(subpath ${sbplPath(p)})`).join(' ')})`,
        '(deny file-write*)',
        `(allow file-write* ${writablePaths.map(p => `(subpath ${sbplPath(p)})`).join(' ')})`,
        ...(readonlyPaths.length > 0 ? [`(deny file-write* ${readonlyPaths.map(p => `(subpath ${sbplPath(p)})`).join(' ')})`] : []),
    ];

    const envEntries = getSandboxEnvEntries({
        workspaceHome: hostHome,
        workspaceRoot: args.workspace.rootHostPath,
        tmpRoot: args.workspace.tmpDir,
        pipCacheDir: HOST_PIP_CACHE_DIR,
        uvCacheDir: HOST_UV_CACHE_DIR,
        npmCacheDir: HOST_NPM_CACHE_DIR,
        extraBinDirs: [
            RTK_BIN_DIR,
            path.join(hostUserLocal, 'bin'),
            path.join(hostCargo, 'bin'),
            path.join(hostElan, 'bin'),
        ],
        extraPythonPaths: getHostUserPythonSitePackages(hostUserLocal),
        rustupHome: isReadableDirectorySync(hostRustup) ? hostRustup : undefined,
        elanHome: isReadableDirectorySync(hostElan) ? hostElan : undefined,
    });

    return {
        executable: getSeatbeltExecutable(),
        args: ['-p', profileLines.join('\n'), 'bash', '-c', buildShellViewCommand(hostViewDir, args.command)],
        cwd: hostCwd,
        env: Object.fromEntries(envEntries),
    };
}

function getRuntimeInvocation(args: {
    runtime: SandboxRuntime;
    workspace: SandboxCommandWorkspace;
    command: string;
    containerName: string;
    viewDir: string;
}): { executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } {
    if (args.runtime === 'seatbelt') {
        return buildSeatbeltInvocation(args);
    }
    return args.runtime === 'bwrap'
        ? { executable: getBubblewrapExecutable(), args: buildBubblewrapArgs(args) }
        : { executable: getSandboxExecutable(), args: buildDockerArgs(args) };
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
    const effectiveCommand = rewriteCommandWithRtk(command);

    await mkdir(workspace.tmpDir, { recursive: true });
    return new Promise(resolve => {
        let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, timedOut = false, spawnFailed = false;
        const invocation = getRuntimeInvocation({ runtime, workspace, command: effectiveCommand, containerName, viewDir });
        const child = spawn(invocation.executable, invocation.args, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
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
            const l3Secrets = readL3EnvSecretStoreMapSync();
            resolve({
                ok: false, exitCode: 127,
                stdout: maskL3SecretsInOutput(stdout, l3Secrets),
                stderr: maskL3SecretsInOutput(stderr, l3Secrets),
                error: `Failed to start sandbox runtime '${runtime}' (${invocation.executable}): ${error.message}`,
                durationMs: Date.now() - startedAt,
            });
        });
        child.on('close', code => {
            if (spawnFailed) return;
            clearTimeout(timer);
            const truncSuffix = ` tokens; redirect command output to an explicit workspace file when the full log matters]`;
            if (stdoutTruncated) stdout += `\n[stdout truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS}${truncSuffix}`;
            if (stderrTruncated) stderr += `\n[stderr truncated after ${MAX_TOOL_RESULT_OUTPUT_TOKENS}${truncSuffix}`;
            const l3Secrets = readL3EnvSecretStoreMapSync();
            const exitCode = timedOut ? 124 : (code ?? 1);
            resolve({
                ok: exitCode === 0, exitCode,
                stdout: maskL3SecretsInOutput(stdout, l3Secrets),
                stderr: maskL3SecretsInOutput(stderr, l3Secrets),
                error: timedOut ? `Sandbox command timed out after ${Math.round(boundedTimeout / 1000)} seconds. Files already written inside the workspace may remain.` : null,
                timedOut, durationMs: Date.now() - startedAt,
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

async function initAndCommitWorkspace(workspace: string, commitMessage: string): Promise<string> {
    try {
        if (!(await fileExists(path.join(workspace, '.git')))) {
            await runGitCommand(workspace, ['init']);
            await runGitCommand(workspace, ['config', 'user.name', 'Sandbox Agent']);
            await runGitCommand(workspace, ['config', 'user.email', 'agent@sandbox.local']);
        }
        await ensureUntrackedGitExcludes(workspace);
        await runGitCommand(workspace, ['add', '-A']);
        await runGitCommand(workspace, ['commit', '-m', commitMessage, '--allow-empty']);
        return await runGitCommand(workspace, ['rev-parse', 'HEAD']).catch(() => '');
    } catch (err) {
        console.warn('Failed to commit to sandbox git repository:', err);
        return '';
    }
}

function isSafeResultsContextPath(relativePath: string): boolean {
    if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.endsWith('/')) return false;
    const segments = relativePath.split('/');
    return !segments.some(seg => seg === '..' || seg === '.' || !seg) &&
        segments.every(seg => /^[a-zA-Z0-9][a-zA-Z0-9_.()+\-\s]{0,120}$/.test(seg));
}

async function syncDeepthinkResultsSnapshot(payload: DeepthinkResultsSnapshotRequest): Promise<{ resultPath: string; commit: string }> {
    if (!payload.repositoryId || !isSafeRepositoryId(payload.repositoryId)) {
        throw new Error('A valid Deepthink repository id is required for a Results snapshot.');
    }
    return withSessionPrepLock(payload.repositoryId, async () => {
        const repository = await resolveRepositoryPath(payload.repositoryId, { skipInitialCommit: true });
        await mkdir(repository, { recursive: true });

        for (const file of payload.contextFiles || []) {
            if (!file || !isSafeResultsContextPath(file.path)) throw new Error('Invalid Results context file.');
            const destination = safeJoin(repository, file.path);
            if (file.base64) {
                await writeL3ImmutableFile(destination, Buffer.from(file.base64, 'base64'));
            } else if (typeof file.content === 'string') {
                await writeL3ImmutableFile(destination, file.content);
            }
        }
        const commit = await initAndCommitWorkspace(repository, payload.commitMessage || 'Deepthink Results snapshot');
        return { resultPath: repository, commit };
    });
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
        const initialImages = snapshotImages(await listVisibleImageFiles(preparedWorkspace, false));
        return { workspace: preparedWorkspace, viewedImagesRoot: viewHostRoot, beforeImages: initialImages };
    });

    const execution = await runSandboxCommand(payload.sessionId, workspace, command, payload.timeoutMs ?? getDefaultTimeoutMs(), sandboxViewMountDir);

    const imagesAfterExecution = await listVisibleImageFiles(workspace, true);
    const visibleFiles = await listVisibleImageFiles(workspace, false);
    const changedImages = getChangedImages(beforeImages, imagesAfterExecution);
    const generatedTranscriptImages = await snapshotImagesForTranscript(changedImages, filename => resolveVisiblePath(workspace, filename));
    const viewedImages = await fileExists(viewedImagesRoot) ? await listDirectImageFiles(viewedImagesRoot, payload.sessionId) : [];
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

    if (!(await fileExists(absolutePath)) && workspace.repositoryAccess.agentDirectory && !relativePath.startsWith(`${workspace.repositoryAccess.agentDirectory}/`)) {
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

async function resolveExplorerRepositoryRoot(args: {
    sessionId?: string;
    repositoryId?: string;
}): Promise<string | null> {
    if (args.repositoryId) {
        if (!isSafeRepositoryId(args.repositoryId)) return null;
        const resultsRepository = await getDeepthinkResultsRepositoryPath(args.repositoryId);
        return (resultsRepository && await fileExists(resultsRepository)) ? resultsRepository : null;
    }
    if (!args.sessionId || !isSafeSessionId(args.sessionId)) return null;
    const workspace = await getWorkspaceContextForSession(args.sessionId);
    return workspace ? workspace.visibleRootPath : null;
}

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.vscode', '.idea']);

async function walkDir(
    dir: string,
    baseDir: string
): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const entry of entries) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            files.push(...await walkDir(fullPath, baseDir));
        } else if (entry.isFile()) {
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

            case '/api/sandbox/repository/restore-strategy': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string; strategyDirectory?: string; commit?: string };
                const repositoryId = payload.repositoryId;
                const strategyDirectory = payload.strategyDirectory;
                const commit = payload.commit;
                if (!repositoryId || !isSafeRepositoryId(repositoryId)) throw new Error('A valid repository id is required.');
                if (!strategyDirectory || !/^Strategy-\d+$/.test(strategyDirectory)) throw new Error('Only an active top-level Strategy-N directory can be restored.');
                if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('A valid Git checkpoint is required.');
                await withSessionPrepLock(repositoryId, async () => {
                    const repository = await resolveRepositoryPath(repositoryId);
                    if (!(await fileExists(path.join(repository, '.git')))) throw new Error('Sandbox repository was not found.');
                    const strategyPath = safeJoin(repository, strategyDirectory);
                    await unlockL3TreeForRestore(strategyPath);
                    try {
                        await runGitCommand(repository, ['restore', `--source=${commit}`, '--staged', '--worktree', '--', strategyDirectory]);
                        await runGitCommand(repository, ['clean', '-fd', '--', strategyDirectory]);
                    } finally {
                        await restampL3StrategyArtifacts(strategyPath);
                    }
                });
                sendJson(res, 200, { ok: true });
                return true;
            }

            case '/api/sandbox/env-secrets': {
                if (req.method === 'GET') {
                    const secrets = await listL3EnvSecrets();
                    sendJson(res, 200, { ok: true, secrets });
                    return true;
                }
                if (req.method === 'POST') {
                    const payload = JSON.parse(await readRequestBody(req)) as { key?: string; value?: string };
                    const secrets = await setL3EnvSecret(String(payload?.key || ''), String(payload?.value || ''));
                    sendJson(res, 200, { ok: true, secrets });
                    return true;
                }
                if (req.method === 'DELETE') {
                    const payload = JSON.parse(await readRequestBody(req)) as { key?: string };
                    const secrets = await removeL3EnvSecret(String(payload?.key || ''));
                    sendJson(res, 200, { ok: true, secrets });
                    return true;
                }
                sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
                return true;
            }

            case '/api/sandbox/repository/results-snapshot': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as DeepthinkResultsSnapshotRequest;
                const { resultPath, commit } = await syncDeepthinkResultsSnapshot(payload);
                sendJson(res, 200, { ok: true, resultPath, commit });
                return true;
            }

            case '/api/sandbox/repository/ensure-deepthink': {
                if (!requireMethod('POST')) return true;
                const payload = JSON.parse(await readRequestBody(req)) as { repositoryId?: string };
                const repositoryId = payload.repositoryId;
                if (!repositoryId || !isSafeRepositoryId(repositoryId)) {
                    sendJson(res, 400, { ok: false, error: 'A valid Deepthink repository id is required.' });
                    return true;
                }
                const resultPath = await withSessionPrepLock(repositoryId, () => ensureDeepthinkResultsRepository(repositoryId));
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
                const repositoryId = payload.repositoryId;
                const strategyDirectory = payload.strategyDirectory;
                if (!repositoryId || !isSafeRepositoryId(repositoryId)) {
                    sendJson(res, 400, { ok: false, error: 'A valid repositoryId is required.' });
                    return true;
                }
                if (!strategyDirectory || !isSafeRepositoryDirectory(strategyDirectory)) {
                    sendJson(res, 400, { ok: false, error: 'A valid strategyDirectory is required.' });
                    return true;
                }
                const archived = await withSessionPrepLock(repositoryId, () =>
                    archiveStrategyRepositoryDirectory(repositoryId, strategyDirectory)
                );
                sendJson(res, 200, { ok: true, ...archived });
                return true;
            }

            case '/api/sandbox/environment':
                if (requireMethod('GET')) sendJson(res, 200, await getSandboxEnvironmentProfile());
                return true;

            case '/api/sandbox/workspace/history': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId } = parseExplorerQuery(req);
                const root = await resolveExplorerRepositoryRoot({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined });
                if (!root) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (!(await fileExists(path.join(root, '.git')))) { sendJson(res, 200, []); return true; }
                try {
                    const logOutput = await runGitCommand(root, ['log', '--pretty=format:%H|%ad|%s', '--date=iso']);
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
                const { sessionId, repositoryId, commit } = parseExplorerQuery(req);
                const root = await resolveExplorerRepositoryRoot({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined });
                if (!root) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (commit && commit !== 'current') {
                    if (!(await fileExists(path.join(root, '.git')))) {
                        sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                        return true;
                    }
                    const filesOutput = await runGitCommand(root, ['ls-tree', '-r', '--name-only', commit]);
                    const files = filesOutput.split('\n').filter(Boolean)
                        .filter(fp => !EXCLUDE_DIRS.has(fp.split('/')[0]))
                        .map(fp => ({ path: fp, size: 0, mtime: 0 }));
                    sendJson(res, 200, files);
                } else {
                    const files = await walkDir(root, root);
                    sendJson(res, 200, files);
                }
                return true;
            }

            case '/api/sandbox/workspace/file': {
                if (!requireMethod('GET')) return true;
                const { sessionId, repositoryId, relativePath, commit } = parseExplorerQuery(req);
                const root = await resolveExplorerRepositoryRoot({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined });
                if (!root) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                const absolutePath = safeJoin(root, relativePath);
                const mimeType = getMimeType(absolutePath) || 'text/plain; charset=utf-8';
                if (commit && commit !== 'current') {
                    if (!(await fileExists(path.join(root, '.git')))) {
                        sendJson(res, 404, { ok: false, error: 'Git history not found in workspace.' });
                        return true;
                    }
                    const content = await runGitCommandBuffer(root, ['show', `${commit}:${relativePath}`]);
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
                const root = await resolveExplorerRepositoryRoot({ sessionId: sessionId || undefined, repositoryId: repositoryId || undefined });
                if (!root) { sendJson(res, 404, { ok: false, error: 'Results repository not found.' }); return true; }
                if (!(await fileExists(path.join(root, '.git')))) {
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
                const diff = await runGitCommandBuffer(root, args);
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
