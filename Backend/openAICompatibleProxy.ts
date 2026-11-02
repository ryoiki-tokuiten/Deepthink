import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const OPENAI_COMPATIBLE_ENDPOINT_HEADER = 'x-openai-compatible-endpoint';
const ROUTE = '/api/openai-compatible';
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const OMITTED_HEADERS = new Set([
    'connection', 'content-length', 'content-encoding', 'cookie', 'host',
    'keep-alive', 'origin', 'referer', 'transfer-encoding',
    OPENAI_COMPATIBLE_ENDPOINT_HEADER,
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('OpenAI-compatible request body is too large.'));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export async function handleOpenAICompatibleProxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    basePath = '',
): Promise<boolean> {
    const requestURL = new URL(req.url || '/', 'http://localhost');
    const base = basePath && basePath !== '/' ? basePath.replace(/\/+$/, '') : '';
    const prefix = [`${base}${ROUTE}`, ROUTE].find(p => requestURL.pathname === p || requestURL.pathname.startsWith(`${p}/`));
    if (!prefix) return false;

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const path = requestURL.pathname.slice(prefix.length).replace(/\/+$/, '') || '/';
    if ((req.method !== 'GET' && req.method !== 'POST') || (path !== '/models' && path !== '/chat/completions')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'Unsupported OpenAI-compatible relay request.' } }));
        return true;
    }

    try {
        const rawEndpoint = req.headers[OPENAI_COMPATIBLE_ENDPOINT_HEADER];
        const endpointValue = Array.isArray(rawEndpoint) ? rawEndpoint[0] : rawEndpoint;
        if (!endpointValue) throw new Error(`Missing ${OPENAI_COMPATIBLE_ENDPOINT_HEADER} header.`);
        const endpoint = new URL(endpointValue);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
            throw new Error('Endpoint URL must be an http(s) URL without credentials or a fragment.');
        }

        endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${path}`;
        const query = new URLSearchParams(endpoint.search);
        new URLSearchParams(requestURL.search).forEach((value, key) => query.append(key, value));
        endpoint.search = query.toString() ? `?${query}` : '';

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (!value || OMITTED_HEADERS.has(name.toLowerCase())) continue;
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }

        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const upstream = await fetch(endpoint, { method: req.method, headers, ...(body && body.length > 0 ? { body } : {}) });

        res.statusCode = upstream.status;
        res.setHeader('cache-control', 'no-store');
        for (const [name, value] of upstream.headers) {
            if (!OMITTED_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
        }

        if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(res);
        else res.end();
    } catch (error) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({
            error: { message: `Error: OpenAI-compatible relay could not reach the endpoint. ${error instanceof Error ? error.message : String(error)}` },
        }));
    }
    return true;
}
