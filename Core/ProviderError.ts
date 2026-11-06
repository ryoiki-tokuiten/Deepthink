type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeMessage(value: string): string {
    return value
        .replace(/data:[^\s,;]+(?:;[^\s,;]+)*;base64,[A-Za-z0-9+/=]+/gi, '[binary data omitted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 900);
}

function isGenericMessage(message: string): boolean {
    const normalized = message
        .replace(/^\d{3}\s+/, '')
        .trim()
        .toLowerCase();
    return normalized === 'provider returned error'
        || normalized === 'bad request'
        || normalized === 'request failed';
}

function parseJsonIfPossible(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

function findMessage(value: unknown, visited = new Set<unknown>(), depth = 0): string | null {
    if (depth > 5 || value == null || visited.has(value)) return null;

    if (typeof value === 'string') {
        const parsed = parseJsonIfPossible(value);
        if (parsed !== value) return findMessage(parsed, visited, depth + 1);
        const message = sanitizeMessage(value);
        return message && !isGenericMessage(message) ? message : null;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            const message = findMessage(entry, visited, depth + 1);
            if (message) return message;
        }
        return null;
    }

    const record = asRecord(value);
    if (!record) return null;
    visited.add(value);

    for (const key of ['message', 'detail', 'error_description', 'reason']) {
        const message = findMessage(record[key], visited, depth + 1);
        if (message) return message;
    }

    for (const key of ['error', 'raw', 'body', 'response', 'data', 'cause']) {
        const message = findMessage(record[key], visited, depth + 1);
        if (message) return message;
    }

    return null;
}

/** Returns an HTTP-like status code when the provider SDK exposed one. */
export function getProviderErrorStatus(error: unknown, visited = new Set<unknown>()): number | null {
    const record = asRecord(error);
    if (!record || visited.has(record)) return null;
    visited.add(record);

    const directStatus = record.status ?? record.statusCode;
    if (typeof directStatus === 'number') return directStatus;
    if (typeof directStatus === 'string' && /^\d{3}$/.test(directStatus)) return Number(directStatus);

    const apiError = asRecord(record.error);
    const code = apiError?.code ?? apiError?.status ?? record.code;
    if (typeof code === 'number') return code;
    if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);

    for (const nestedKey of ['cause', 'error', 'response', 'data']) {
        if (record[nestedKey]) {
            const nestedStatus = getProviderErrorStatus(record[nestedKey], visited);
            if (nestedStatus !== null) return nestedStatus;
        }
    }

    return null;
}

const NON_RETRYABLE_PROVIDER_STATUSES = new Set([
    'INVALID_ARGUMENT',
    'UNAUTHENTICATED',
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'FAILED_PRECONDITION',
    'UNIMPLEMENTED',
]);

/**
 * Returns true when an error is a permanent client/configuration failure
 * (e.g., 400/401/403/404/422, invalid API key, unknown model ID, or uninitialized client)
 * that should fail immediately instead of waiting through backoff retries.
 * Rate limits (429), timeouts (408), concurrency conflicts (409), and 5xx/network errors remain retryable.
 */
export function isNonRetryableProviderError(error: unknown, visited = new Set<unknown>()): boolean {
    if (!error || typeof error !== 'object' || visited.has(error)) return false;
    visited.add(error);

    const rec = error as UnknownRecord;
    if (rec.skipRetry === true) return true;

    const status = getProviderErrorStatus(error);
    if (status !== null) {
        if (status === 408 || status === 409 || status === 425 || status === 429) {
            return false;
        }
        if (status >= 400 && status < 500) {
            return true;
        }
    }

    const providerStatus = typeof rec.providerStatus === 'string'
        ? rec.providerStatus.toUpperCase()
        : typeof asRecord(rec.error)?.status === 'string'
            ? String(asRecord(rec.error)!.status).toUpperCase()
            : '';
    if (providerStatus && NON_RETRYABLE_PROVIDER_STATUSES.has(providerStatus)) {
        return true;
    }

    const msg = typeof rec.message === 'string' ? rec.message.toLowerCase() : '';
    if (
        msg.includes('client not initialized') ||
        msg.includes('endpoint is not initialized') ||
        msg.includes('api key manager not initialized') ||
        msg.includes('no configured provider found for model') ||
        msg.includes('does not support tool calling') ||
        msg.includes('endpoint url is missing') ||
        msg.includes('api key not valid') ||
        msg.includes('invalid api key') ||
        msg.includes('incorrect api key')
    ) {
        return true;
    }

    if (rec.cause && isNonRetryableProviderError(rec.cause, visited)) {
        return true;
    }

    return false;
}

/**
 * Extracts the provider's actionable error text without exposing request
 * payloads. Some gateways nest their upstream failure under
 * `error.metadata.raw` while the top-level message is only "Provider returned
 * error".
 */
export function describeProviderError(error: unknown): string {
    const record = asRecord(error);
    const apiError = asRecord(record?.error);
    const metadata = asRecord(apiError?.metadata) ?? asRecord(record?.metadata);
    const raw = metadata?.raw ?? apiError?.raw ?? record?.raw;
    const providerName = asNonEmptyString(metadata?.provider_name)
        ?? asNonEmptyString(metadata?.provider)
        ?? asNonEmptyString(asRecord(raw)?.provider_name);
    const status = getProviderErrorStatus(error);
    const detail = findMessage(raw)
        ?? findMessage(apiError)
        ?? findMessage(record?.cause)
        ?? findMessage(record?.message)
        ?? 'Provider request failed without an error message.';

    return [
        status ? String(status) : '',
        providerName ? `${providerName}:` : '',
        detail,
    ].filter(Boolean).join(' ');
}

/**
 * Gives every OpenAI-compatible runtime a stable, actionable error prefix.
 * Provider SDKs use different error classes and nesting, but the user-facing
 * checks are the same: endpoint URL, API compatibility, credentials, or model.
 */
export function normalizeOpenAICompatibleProviderError(
    error: unknown,
    endpoint: string,
    modelId?: string
): Error {
    const modelSuffix = modelId ? ` Model: ${modelId}.` : '';
    const normalized = new Error(
        `Error: OpenAI-compatible endpoint request failed. Check the endpoint URL, API compatibility, API key, and model ID.${modelSuffix} ${describeProviderError(error)}`
    );
    (normalized as any).cause = error;
    (normalized as any).endpoint = endpoint;
    const status = getProviderErrorStatus(error);
    if (status !== null) {
        (normalized as any).status = status;
    }
    return normalized;
}

// ============================================================================
// Unified Inference Resilience: 1m -> 3m -> 5m Backoff & 5m Silence Watchdog
// ============================================================================

export const INFERENCE_RETRY_DELAYS_MS = [
    1 * 60_000,
    3 * 60_000,
    5 * 60_000,
] as const;

export const INFERENCE_SILENCE_TIMEOUT_MS = 5 * 60_000;

export class InferenceSilenceTimeoutError extends Error {
    readonly isTerminalInferenceError = true;
    readonly isSilenceTimeout = true;
    readonly skipRetry = true;

    constructor(label: string, silenceTimeoutMs: number = INFERENCE_SILENCE_TIMEOUT_MS) {
        const mins = Math.round((silenceTimeoutMs / 60_000) * 10) / 10;
        super(`Inference silence timeout: No reasoning or output tokens received from ${label} for ${mins} minutes.`);
        this.name = 'InferenceSilenceTimeoutError';
    }
}

export class InferenceRetriesExhaustedError extends Error {
    readonly isTerminalInferenceError = true;
    readonly attempts: number;

    constructor(label: string, lastError: unknown, attempts: number) {
        const detail = lastError instanceof Error ? lastError.message : describeProviderError(lastError);
        super(`Inference failed after ${attempts} attempts (initial + 1m, 3m, 5m retries) for ${label}: ${detail}`);
        this.name = 'InferenceRetriesExhaustedError';
        this.attempts = attempts;
        (this as any).cause = lastError;
    }
}

export function isTerminalInferenceError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const rec = error as Record<string, unknown>;
    return (
        error instanceof InferenceSilenceTimeoutError ||
        error instanceof InferenceRetriesExhaustedError ||
        rec.isTerminalInferenceError === true ||
        rec.name === 'InferenceSilenceTimeoutError' ||
        rec.name === 'InferenceRetriesExhaustedError' ||
        isNonRetryableProviderError(error) ||
        (rec.cause != null && isTerminalInferenceError(rec.cause))
    );
}

export function isUserAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const rec = error as Record<string, unknown>;
    if (isTerminalInferenceError(error)) return false;
    const name = typeof rec.name === 'string' ? rec.name : '';
    const msg = typeof rec.message === 'string' ? rec.message : '';
    return (
        name === 'AbortError' ||
        name === 'PipelineStopRequestedError' ||
        msg === 'Process stopped by user' ||
        msg === 'Adaptive Deepthink process was stopped.' ||
        msg === 'Deepthink run stopped by user request.'
    );
}

export interface SilenceWatchdogOptions {
    label: string;
    silenceTimeoutMs?: number;
    externalSignal?: AbortSignal;
}

/**
 * Runs an async streaming operation with a rolling silence watchdog.
 * Calling `touch()` on any incoming stream chunk (reasoning, text, or tool call)
 * resets the 5-minute silence timer. If no chunk arrives within `silenceTimeoutMs`,
 * the operation aborts immediately with `InferenceSilenceTimeoutError` (no retry).
 */
export async function withSilenceWatchdog<T>(
    options: SilenceWatchdogOptions,
    fn: (watchdog: { signal: AbortSignal; touch: () => void }) => Promise<T>
): Promise<T> {
    const silenceTimeoutMs = options.silenceTimeoutMs ?? INFERENCE_SILENCE_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    let rejectOnSilence: ((err: InferenceSilenceTimeoutError) => void) | null = null;
    const silencePromise = new Promise<never>((_, reject) => {
        rejectOnSilence = reject;
    });

    const resetTimer = () => {
        clearTimer();
        if (controller.signal.aborted) return;
        timer = setTimeout(() => {
            timedOut = true;
            const err = new InferenceSilenceTimeoutError(options.label, silenceTimeoutMs);
            try {
                controller.abort(err);
            } catch {
                // Ignore abort errors
            }
            rejectOnSilence?.(err);
        }, silenceTimeoutMs);
    };

    const onExternalAbort = () => {
        clearTimer();
        const reason = options.externalSignal?.reason ?? new Error('Process stopped by user');
        try {
            controller.abort(reason);
        } catch {
            // Ignore
        }
    };

    if (options.externalSignal) {
        if (options.externalSignal.aborted) {
            onExternalAbort();
            throw options.externalSignal.reason ?? new Error('Process stopped by user');
        }
        options.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    resetTimer();

    try {
        return await Promise.race([
            fn({ signal: controller.signal, touch: resetTimer }),
            silencePromise,
        ]);
    } catch (error) {
        if (timedOut) {
            throw new InferenceSilenceTimeoutError(options.label, silenceTimeoutMs);
        }
        throw error;
    } finally {
        clearTimer();
        if (options.externalSignal) {
            options.externalSignal.removeEventListener('abort', onExternalAbort);
        }
    }
}

export interface InferenceRetryOptions {
    label: string;
    retryDelaysMs?: readonly number[];
    externalSignal?: AbortSignal;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('Process stopped by user'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('Process stopped by user'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Executes an inference call with the unified 1-minute -> 3-minute -> 5-minute
 * backoff retry sequence on transient inference errors (429, 5xx, network).
 * Does NOT retry on user aborts, 5-minute silence timeouts, or permanent 4xx/configuration errors.
 */
export async function executeWithInferenceRetry<T>(
    options: InferenceRetryOptions,
    fn: (attempt: number) => Promise<T>
): Promise<T> {
    const delays = options.retryDelaysMs ?? INFERENCE_RETRY_DELAYS_MS;
    const maxRetries = delays.length;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (options.externalSignal?.aborted) {
            throw options.externalSignal.reason ?? new Error('Process stopped by user');
        }

        try {
            return await fn(attempt + 1);
        } catch (error: any) {
            if (options.externalSignal?.aborted || isUserAbortError(error)) {
                throw options.externalSignal?.reason ?? error;
            }
            if (
                error instanceof InferenceSilenceTimeoutError ||
                error?.skipRetry === true ||
                error?.isSilenceTimeout === true ||
                isNonRetryableProviderError(error)
            ) {
                if (error && typeof error === 'object') {
                    (error as any).isTerminalInferenceError = true;
                }
                throw error;
            }

            lastError = error;

            if (attempt < maxRetries) {
                const delayMs = delays[attempt] ?? 0;
                const delayMins = Math.round((delayMs / 60_000) * 10) / 10;
                console.warn(
                    `[Inference Retry] ${options.label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${describeProviderError(error)}. Retrying in ${delayMins}m...`
                );
                options.onRetry?.(attempt + 1, maxRetries, delayMs, error);
                await sleepWithAbort(delayMs, options.externalSignal);
            }
        }
    }

    throw new InferenceRetriesExhaustedError(options.label, lastError, maxRetries + 1);
}


