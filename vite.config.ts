import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from 'vite';
import { handleGeminiBackendRequest } from './Backend/geminiBackend';
import { handleOpenAICompatibleProxyRequest } from './Backend/openAICompatibleProxy';
import { ensureSandboxEnvironmentReady, handleSandboxBackendRequest } from './Backend/sandboxToolBackend';

function installBackendMiddleware(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use(async (req, res, next) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const basePath = server.config.base.replace(/\/$/, '');
    const isGeminiRequest = pathname.startsWith('/api/gemini/')
      || (basePath && pathname.startsWith(`${basePath}/api/gemini/`));
    const isOpenAICompatibleRequest = pathname.startsWith('/api/openai-compatible/')
      || (basePath && pathname.startsWith(`${basePath}/api/openai-compatible/`));
    const isSandboxBackendRequest = pathname.startsWith('/api/sandbox/')
      || (basePath && pathname.startsWith(`${basePath}/api/sandbox/`));

    if (isGeminiRequest) {
      const handled = await handleGeminiBackendRequest(req, res, basePath);
      if (handled) return;
    }

    if (isOpenAICompatibleRequest) {
      const handled = await handleOpenAICompatibleProxyRequest(req, res, basePath);
      if (handled) return;
    }

    if (isSandboxBackendRequest) {
      const handled = await handleSandboxBackendRequest(req, res);
      if (handled) return;
    }

    next();
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  if (env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
  return {
    plugins: [{
      name: 'iterative-studio-sandbox-backend',
      enforce: 'pre',
      configureServer(server) {
        void ensureSandboxEnvironmentReady({ strict: true }).catch(err => {
          console.error('[sandbox]', err instanceof Error ? err.message : String(err));
        });
        installBackendMiddleware(server);
      },
      configurePreviewServer(server) {
        void ensureSandboxEnvironmentReady({ strict: true }).catch(err => {
          console.error('[sandbox]', err instanceof Error ? err.message : String(err));
        });
        installBackendMiddleware(server);
      },
      resolveId(source, _importer, options) {
        if (options?.ssr) return null;
        if (source === 'just-bash') {
          return path.resolve(__dirname, 'node_modules/just-bash/dist/bundle/index.js');
        }
        if (source.startsWith('node:')) {
          return `\0browser-node-shim:${source}`;
        }
        return null;
      },
      load(id) {
        if (id.endsWith('just-bash/dist/bundle/index.js')) {
          const raw = fs.readFileSync(id, 'utf8');
          return raw
            .replace(/typeof __BROWSER__>"u"\|\|!__BROWSER__/g, 'false')
            .replace(/typeof __BROWSER__<"u"&&__BROWSER__/g, 'true');
        }
        if (!id.startsWith('\0browser-node-shim:')) return null;
        return [
          'export const spawn = () => { throw new Error("Not supported in browser"); };',
          'export const accessSync = () => {};',
          'export const existsSync = () => false;',
          'export const readdirSync = () => [];',
          'export const statSync = () => ({ isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false, mtimeMs: 0 });',
          'export const lstatSync = () => ({ isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false, mtimeMs: 0 });',
          'export const realpathSync = (p) => String(p || "");',
          'export const readlinkSync = () => "";',
          'export const readFileSync = () => "";',
          'export const writeFileSync = () => {};',
          'export const open = async () => { throw new Error("Not supported in browser"); };',
          'export const promises = new Proxy({}, { get: () => async () => { throw new Error("Not supported in browser"); } });',
          'export const constants = { R_OK: 4, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536, O_NOATIME: 262144, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_DSYNC: 4096, O_NONBLOCK: 2048 };',
          'export const homedir = () => "/";',
          'export const join = (...parts) => parts.filter(Boolean).join("/");',
          'export const resolve = (...parts) => "/" + parts.filter(Boolean).join("/").replace(/^\\/+/, "");',
          'export const relative = (_from, to) => String(to || "");',
          'export const isAbsolute = (p) => String(p || "").startsWith("/");',
          'export const dirname = (p) => String(p || "").split("/").slice(0, -1).join("/") || "/";',
          'export const basename = (p) => String(p || "").split("/").pop() || "";',
          'export const sep = "/";',
          'export const posix = { join, resolve, relative, isAbsolute, dirname, basename, sep: "/" };',
          'export const win32 = { join, resolve, relative, isAbsolute, dirname, basename, sep: "\\\\" };',
          'export const fileURLToPath = (u) => String(u || "");',
          'export const createRequire = () => () => ({});',
          'export const createHash = () => ({ update() { return this; }, digest() { return ""; } });',
          'export const createHmac = () => ({ update() { return this; }, digest() { return new Uint8Array(0); } });',
          'export const timingSafeEqual = () => false;',
          'export const randomBytes = (n) => new Uint8Array(n || 0);',
          'export const gunzipSync = (buf) => buf;',
          'export const gzipSync = (buf) => buf;',
          'export const once = async () => [];',
          'export class EventEmitter { on() { return this; } off() { return this; } once() { return this; } emit() { return false; } }',
          'export class Worker {}',
          'export const parentPort = null;',
          'export const workerData = null;',
          'export class AsyncLocalStorage { run(_store, fn, ...args) { return fn(...args); } getStore() { return undefined; } }',
          'export const Buffer = globalThis.Buffer || Uint8Array;',
          'export default { spawn, accessSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, readlinkSync, readFileSync, writeFileSync, open, promises, constants, homedir, join, resolve, relative, isAbsolute, dirname, basename, sep, posix, win32, fileURLToPath, createRequire, createHash, createHmac, timingSafeEqual, randomBytes, gunzipSync, gzipSync, once, EventEmitter, Worker, parentPort, workerData, AsyncLocalStorage, Buffer };',
        ].join('\n');
      },
    }],
    define: {
      '__BROWSER__': 'true',
      'process.env.GEMINI_API_KEY': JSON.stringify((env.GEMINI_API_KEY || process.env.GEMINI_API_KEY)?.trim() ? '__SERVER_ENV__' : undefined),
      'process.env.OPENAI_API_KEY': JSON.stringify(env.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
      'process.env.ANTHROPIC_API_KEY': JSON.stringify(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      watch: {
        ignored: [
          '**/Forest-Fire-Detection/**',
          '**/.venv/**',
          '**/__pycache__/**',
          '**/*.pyc',
          '**/.env',
        ],
      },
    },
    base: '/Iterative-Contextual-Refinements/',
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) {
              return;
            }
            if (id.includes('@anthropic-ai') || id.includes('node_modules/openai')
              || id.includes('@ai-sdk') || id.includes('node_modules/ai')) {
                return 'vendor-ai';
            }
            if (id.includes('langchain') || id.includes('langsmith')) {
              return 'vendor-langchain';
            }
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
              return 'vendor-react';
            }
            if (id.includes('remark-') || id.includes('rehype-') || id.includes('unified') ||
              id.includes('katex') || id.includes('react-markdown')) {
              return 'vendor-markdown';
            }
            if (id.includes('shiki') || id.includes('@shikijs')) {
              return 'vendor-shiki';
            }
            if (id.includes('nanoid')) {
              return 'vendor-utils';
            }
          }
        }
      }
    }
  };
});
