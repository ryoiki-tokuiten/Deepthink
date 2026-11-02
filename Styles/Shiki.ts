import { bundledLanguagesInfo } from 'shiki';
import { createBundledHighlighter, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const BUNDLED_LANGUAGE_LOADERS = {
    javascript: () => import('shiki/langs/javascript.mjs'),
    typescript: () => import('shiki/langs/typescript.mjs'),
    python: () => import('shiki/langs/python.mjs'),
    css: () => import('shiki/langs/css.mjs'),
    html: () => import('shiki/langs/html.mjs'),
    json: () => import('shiki/langs/json.mjs'),
    shellscript: () => import('shiki/langs/shellscript.mjs'),
    markdown: () => import('shiki/langs/markdown.mjs'),
    sql: () => import('shiki/langs/sql.mjs'),
    java: () => import('shiki/langs/java.mjs'),
    cpp: () => import('shiki/langs/cpp.mjs'),
    c: () => import('shiki/langs/c.mjs'),
    go: () => import('shiki/langs/go.mjs'),
    rust: () => import('shiki/langs/rust.mjs'),
    yaml: () => import('shiki/langs/yaml.mjs'),
    xml: () => import('shiki/langs/xml.mjs'),
    jsx: () => import('shiki/langs/jsx.mjs'),
    tsx: () => import('shiki/langs/tsx.mjs'),
} as const;

const BUNDLED_LANGUAGE_IDS = Object.keys(BUNDLED_LANGUAGE_LOADERS) as Array<keyof typeof BUNDLED_LANGUAGE_LOADERS>;
const PLAIN_TEXT_ALIASES = new Set(['plaintext', 'text', 'txt']);
const LANGUAGE_INFO = new Map(
    bundledLanguagesInfo
        .filter(info => BUNDLED_LANGUAGE_IDS.includes(info.id as keyof typeof BUNDLED_LANGUAGE_LOADERS))
        .map(info => [info.id, info])
);

const LANGUAGE_LOOKUP = new Map<string, string>();
for (const id of BUNDLED_LANGUAGE_IDS) LANGUAGE_LOOKUP.set(id, id);
for (const info of LANGUAGE_INFO.values()) {
    info.aliases?.forEach(alias => LANGUAGE_LOOKUP.set(alias, info.id));
}
for (const alias of PLAIN_TEXT_ALIASES) LANGUAGE_LOOKUP.set(alias, 'plaintext');

const createHighlighter = createBundledHighlighter({
    langs: BUNDLED_LANGUAGE_LOADERS,
    themes: {
        'github-dark': () => import('shiki/themes/github-dark.mjs'),
        'github-light': () => import('shiki/themes/github-light.mjs'),
    },
    engine: () => createJavaScriptRegexEngine(),
});

let highlighterInstance: HighlighterCore | null = null;
let initPromise: Promise<HighlighterCore> | null = null;
const readinessListeners: (() => void)[] = [];

async function initHighlighter(): Promise<HighlighterCore> {
    if (highlighterInstance) return highlighterInstance;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            const highlighter = await createHighlighter({
                themes: ['github-dark', 'github-light'],
                langs: [...BUNDLED_LANGUAGE_IDS],
            });
            highlighterInstance = highlighter as HighlighterCore;
            readinessListeners.forEach(l => l());
            readinessListeners.length = 0;
            return highlighterInstance;
        } catch (error) {
            console.error('Failed to initialize Shiki:', error);
            initPromise = null;
            throw error;
        }
    })();
    return initPromise;
}

export function onHighlighterReady(callback: () => void): () => void {
    if (highlighterInstance) {
        callback();
        return () => {};
    }
    readinessListeners.push(callback);
    return () => {
        const idx = readinessListeners.indexOf(callback);
        if (idx !== -1) readinessListeners.splice(idx, 1);
    };
}

export function isHighlighterReady(): boolean {
    return highlighterInstance !== null;
}

export function resolveLanguage(lang: string): string {
    return LANGUAGE_LOOKUP.get(lang.toLowerCase().trim()) || 'plaintext';
}

export function isLanguageSupported(lang: string): boolean {
    return resolveLanguage(lang) !== 'plaintext' || PLAIN_TEXT_ALIASES.has(lang.toLowerCase().trim());
}

export function getLanguageDisplayName(lang: string): string {
    const resolved = resolveLanguage(lang);
    return resolved === 'plaintext' ? 'Plain Text' : (LANGUAGE_INFO.get(resolved)?.name || resolved.toUpperCase());
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function highlightCodeSync(code: string, lang: string = 'plaintext'): string {
    if (!highlighterInstance) {
        if (!initPromise) initHighlighter().catch(console.error);
        return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
    }
    const resolvedLang = resolveLanguage(lang);
    const langToUse = highlighterInstance.getLoadedLanguages().includes(resolvedLang) ? resolvedLang : 'plaintext';
    try {
        return highlighterInstance.codeToHtml(code, {
            lang: langToUse,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: false,
        });
    } catch {
        return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
    }
}

if (typeof window !== 'undefined') {
    initHighlighter().catch(err => console.error('Failed to initialize Shiki highlighter:', err));
}
