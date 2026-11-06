import React, { useCallback, useEffect, useRef } from 'react';
import { highlightCodeSync, isLanguageSupported, resolveLanguage } from '../Shiki';

const BLOCK_ELEMENTS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE']);
const CODE_FENCE = '```';
const CODE_ELEMENT_PATTERN = /<code\b[^>]*>([\s\S]*?)<\/code>/i;
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

const GRAMMAR = {
    CODE_BLOCK: /(```(?:[\w-]*)\n[\s\S]*?```)/g,
    HEADING: /^(#{1,6})(\s.*)$/,
    LIST_ITEM: /^(\s*-\s)(.*)/,
    TOKENS: /(\{\{[^}]+\}\})|(<\/?[\w\s="-]+>)|(\[[^\]]+\])|(\*\*.*?\*\*)|(`[^`]+`)|(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(You must|Must|Always|Ensure|IMPORTANT|CRITICAL|Mandatory|Required|Require|Be sure to|Make sure to|Ensure that|Strictly|At all times)\b|\b(Never|Do not|Don't|Avoid|Must not|Mustn't|Should not|Shouldn't|No|Not allowed|Prohibited|Forbidden|Disallowed|Cannot|Can't)\b/gi,
    TYPES: {
        VAR: /^\{\{/,
        TAG: /^</,
        INST: /^\[/,
        CRIT: /^\*\*/,
        CODE: /^`/,
        STR: /^["']/,
        POS: /^(?:You must|Must|Always|Ensure|IMPORTANT|CRITICAL|Mandatory|Required|Require|Be sure to|Make sure to|Ensure that|Strictly|At all times)$/i,
        NEG: /^(?:Never|Do not|Don't|Avoid|Must not|Mustn't|Should not|Shouldn't|No|Not allowed|Prohibited|Forbidden|Disallowed|Cannot|Can't)$/i
    }
};

interface InternalToken {
    type: string;
    content: string;
    level?: number;
    lang?: string;
    marker?: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ESCAPE_MAP[c] ?? c);
const cleanText = (s: string) => s.replace(/\u200B/g, '');
const isBlockElement = (node: Node) => node.nodeType === 1 && BLOCK_ELEMENTS.has(node.nodeName);

function contentOf(node: Node): string {
    if (node.nodeType === 3) return cleanText(node.textContent ?? '');
    if (node.nodeName === 'BR') return '\n';
    let out = '';
    for (let i = 0; i < node.childNodes.length; i++) out += textOf(node.childNodes[i]);
    return out;
}

function textOf(node: Node): string {
    const content = contentOf(node);
    return isBlockElement(node) && node.previousSibling !== null && node.previousSibling.nodeName !== 'BR' && content.length > 0
        ? `\n${content}`
        : content;
}

function prefixLength(node: Node): number {
    return isBlockElement(node) && node.previousSibling !== null && node.previousSibling.nodeName !== 'BR' && contentOf(node).length > 0 ? 1 : 0;
}

function getCaretPosition(root: HTMLElement): number {
    const sel = root.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const { startContainer: targetNode, startOffset: targetOffset } = sel.getRangeAt(0);
    if (targetNode !== root && !root.contains(targetNode)) return 0;
    let offset = 0;
    let found = false;
    const visit = (node: Node) => {
        if (found) return;
        offset += prefixLength(node);
        if (node === targetNode) {
            if (node.nodeType === 3) {
                const raw = node.textContent ?? '';
                offset += cleanText(raw.slice(0, Math.max(0, Math.min(targetOffset, raw.length)))).length;
            } else {
                const bound = Math.max(0, Math.min(targetOffset, node.childNodes.length));
                for (let i = 0; i < bound; i++) offset += textOf(node.childNodes[i]).length;
            }
            found = true;
            return;
        }
        if (node.nodeType === 3 || node.nodeName === 'BR') {
            offset += contentOf(node).length;
            return;
        }
        for (let i = 0; i < node.childNodes.length; i++) {
            visit(node.childNodes[i]);
            if (found) return;
        }
    };
    visit(root);
    return found ? offset : 0;
}

function setCaretPosition(root: HTMLElement, targetIndex: number): void {
    const sel = root.ownerDocument.getSelection();
    if (!sel) return;
    const doc = root.ownerDocument;
    const range = doc.createRange();
    const max = textOf(root).length;
    const target = Math.min(max, Math.max(0, Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : 0));
    let offset = 0;
    let rangeSet = false;

    const visit = (node: Node) => {
        if (rangeSet) return;
        const pref = prefixLength(node);
        if (pref > 0) {
            if (target === offset) { range.setStartBefore(node); range.collapse(true); rangeSet = true; return; }
            offset += pref;
            if (target <= offset) { range.setStart(node, 0); range.collapse(true); rangeSet = true; return; }
        }
        if (node.nodeType === 3) {
            const raw = node.textContent ?? '';
            const len = cleanText(raw).length;
            if (target <= offset + len) {
                const vis = target - offset;
                let rawOff = 0;
                if (vis > 0) {
                    let seen = 0;
                    for (let i = 0; i < raw.length; i++) {
                        if (raw[i] !== '\u200B' && ++seen === vis) { rawOff = i + 1; break; }
                    }
                    if (!rawOff) rawOff = raw.length;
                }
                range.setStart(node, rawOff);
                range.collapse(true);
                rangeSet = true;
                return;
            }
            offset += len;
            return;
        }
        if (node.nodeName === 'BR') {
            if (target === offset) { range.setStartBefore(node); range.collapse(true); rangeSet = true; return; }
            offset += 1;
            if (target <= offset) { range.setStartAfter(node); range.collapse(true); rangeSet = true; }
            return;
        }
        if (node.childNodes.length === 0 && target === offset) {
            range.setStart(node, 0); range.collapse(true); rangeSet = true; return;
        }
        for (let i = 0; i < node.childNodes.length; i++) {
            visit(node.childNodes[i]);
            if (rangeSet) return;
        }
    };
    visit(root);
    if (!rangeSet) { range.selectNodeContents(root); range.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(range);
}

function classifyToken(text: string): string {
    const t = GRAMMAR.TYPES;
    if (t.VAR.test(text)) return 'variable';
    if (t.TAG.test(text)) return 'tag';
    if (t.INST.test(text)) return 'instruction';
    if (t.CRIT.test(text)) return 'critical';
    if (t.CODE.test(text)) return 'code-inline';
    if (t.STR.test(text)) return 'string';
    if (t.POS.test(text)) return 'keyword-positive';
    if (t.NEG.test(text)) return 'keyword-negative';
    return 'text';
}

function tokenizeLine(text: string, tokens: InternalToken[]): void {
    let cursor = 0;
    for (const m of text.matchAll(GRAMMAR.TOKENS)) {
        if (m.index! > cursor) tokens.push({ type: 'text', content: text.slice(cursor, m.index) });
        tokens.push({ type: classifyToken(m[0]), content: m[0] });
        cursor = m.index! + m[0].length;
    }
    if (cursor < text.length) tokens.push({ type: 'text', content: text.slice(cursor) });
}

function renderPromptHtml(text: string): string {
    const tokens: InternalToken[] = [];
    const parts = text.split(GRAMMAR.CODE_BLOCK);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;
        if (part.startsWith(CODE_FENCE) && (part.endsWith(CODE_FENCE) || i === parts.length - 1)) {
            const lines = part.split('\n');
            const marker = lines[0].slice(CODE_FENCE.length).trim();
            tokens.push({
                type: 'code-block',
                content: lines.slice(1, part.endsWith(CODE_FENCE) ? -1 : undefined).join('\n'),
                lang: marker || 'plaintext',
                marker
            });
            continue;
        }
        const lines = part.split('\n');
        for (let j = 0; j < lines.length; j++) {
            if (j > 0) tokens.push({ type: 'newline', content: '' });
            const line = lines[j];
            if (!line) continue;
            const hm = line.match(GRAMMAR.HEADING);
            if (hm) { tokens.push({ type: 'heading', content: line, level: hm[1].length }); continue; }
            const lm = line.match(GRAMMAR.LIST_ITEM);
            if (lm) { tokens.push({ type: 'list-marker', content: lm[1] }); tokenizeLine(lm[2], tokens); continue; }
            tokenizeLine(line, tokens);
        }
    }

    return tokens.map(token => {
        if (token.type === 'newline') return '<br>';
        if (token.type === 'text') return escapeHtml(token.content);
        if (token.type === 'code-block') {
            const reqLang = token.lang || 'plaintext';
            let lang = 'plaintext';
            try { if (reqLang && isLanguageSupported(reqLang)) lang = resolveLanguage(reqLang); } catch {}
            const escaped = escapeHtml(token.content);
            let html = escaped;
            try { html = highlightCodeSync(token.content, lang).match(CODE_ELEMENT_PATTERN)?.[1] ?? escaped; } catch {}
            const langClass = lang.replace(/[^a-zA-Z0-9_-]/g, '-') || 'plaintext';
            return `<div class="token-code-marker">${CODE_FENCE}${escapeHtml(token.marker ?? token.lang ?? '')}</div><pre class="shiki"><code class="language-${langClass}">${html}</code></pre><div class="token-code-marker">${CODE_FENCE}</div>`;
        }
        if (token.type === 'heading') {
            const lvl = Math.min(6, Math.max(1, token.level ?? 1));
            return `<span class="token-heading token-heading${lvl}">${escapeHtml(token.content)}</span>`;
        }
        if (token.type === 'list-marker') return `<span class="token-list-marker">${escapeHtml(token.content)}</span>`;
        return `<span class="token-${token.type.replace(/[^a-zA-Z0-9_-]/g, '-') || 'plaintext'}">${escapeHtml(token.content)}</span>`;
    }).join('');
}

interface PromptStylingEditorProps {
    value?: string;
    onChange?: (val: string) => void;
    id?: string;
    className?: string;
    placeholder?: string;
    rows?: number;
    readOnly?: boolean;
}

const FORCE_SYNC_EVENT = 'prompt-styling-force-sync';

function insertPlainText(editor: HTMLElement, text: string): void {
    editor.focus();
    const sel = editor.ownerDocument.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0 || (sel.getRangeAt(0).commonAncestorContainer !== editor && !editor.contains(sel.getRangeAt(0).commonAncestorContainer))) {
        const r = editor.ownerDocument.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
    }
    try {
        if (editor.ownerDocument.execCommand?.('insertText', false, text)) return;
    } catch {}
    const range = sel.getRangeAt(0);
    const textNode = editor.ownerDocument.createTextNode(text);
    range.deleteContents();
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
}

export const PromptStylingEditor: React.FC<PromptStylingEditorProps> = ({
    value,
    onChange,
    id,
    className = '',
    placeholder,
    rows,
    readOnly = false
}) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mutationRef = useRef(false);
    const requestRef = useRef<number | null>(null);

    const replaceEditorHtml = useCallback((editor: HTMLDivElement, html: string, caretOffset?: number): void => {
        mutationRef.current = true;
        try {
            editor.innerHTML = html;
            if (caretOffset !== undefined) setCaretPosition(editor, caretOffset);
        } finally {
            mutationRef.current = false;
        }
    }, []);

    const syncFromValue = useCallback((nextValue: string): void => {
        const editor = editorRef.current;
        if (!editor || mutationRef.current) return;
        const normalized = nextValue ?? '';
        if (textOf(editor) === normalized) return;
        if (requestRef.current !== null) { cancelAnimationFrame(requestRef.current); requestRef.current = null; }
        replaceEditorHtml(editor, renderPromptHtml(normalized));
    }, [replaceEditorHtml]);

    const handleInput = useCallback((): void => {
        const editor = editorRef.current;
        if (!editor || mutationRef.current) return;
        const text = textOf(editor);
        onChange?.(text);
        if (value === undefined && textareaRef.current) {
            textareaRef.current.value = text;
            textareaRef.current.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (requestRef.current !== null) cancelAnimationFrame(requestRef.current);
        requestRef.current = requestAnimationFrame(() => {
            requestRef.current = null;
            if (!editorRef.current || mutationRef.current) return;
            const caretOffset = getCaretPosition(editorRef.current);
            const html = renderPromptHtml(textOf(editorRef.current));
            if (editorRef.current.innerHTML !== html) replaceEditorHtml(editorRef.current, html, caretOffset);
        });
    }, [onChange, replaceEditorHtml, value]);

    useEffect(() => {
        if (value !== undefined) syncFromValue(value);
    }, [syncFromValue, value]);

    useEffect(() => {
        const handleForceSync = () => {
            if (value === undefined && textareaRef.current) syncFromValue(textareaRef.current.value);
        };
        handleForceSync();
        window.addEventListener(FORCE_SYNC_EVENT, handleForceSync);
        return () => window.removeEventListener(FORCE_SYNC_EVENT, handleForceSync);
    }, [syncFromValue, value]);

    useEffect(() => () => {
        if (requestRef.current !== null) cancelAnimationFrame(requestRef.current);
    }, []);

    return (
        <div className="prompt-styling-container">
            <div
                ref={editorRef}
                className={`prompt-styling-editor ${className} ${readOnly ? 'read-only' : ''}`}
                contentEditable={!readOnly}
                suppressContentEditableWarning
                spellCheck={false}
                onInput={handleInput}
                onKeyDown={e => {
                    if (e.key === 'Enter' && editorRef.current) {
                        e.preventDefault();
                        e.stopPropagation();
                        insertPlainText(editorRef.current, '\n');
                    }
                }}
                onPaste={e => {
                    e.preventDefault();
                    if (editorRef.current) insertPlainText(editorRef.current, e.clipboardData?.getData('text/plain') ?? '');
                }}
                data-placeholder={placeholder}
                id={id ? `${id}-editor` : undefined}
            />
            <textarea
                ref={textareaRef}
                id={id}
                className={`prompt-textarea ${className}`}
                rows={rows}
                value={value !== undefined ? value : undefined}
                defaultValue={value === undefined ? '' : undefined}
                onChange={value !== undefined ? e => onChange?.(e.target.value) : undefined}
                style={{ display: 'none' }}
                data-ps-enhanced="true"
            />
        </div>
    );
};

export function updatePromptContent(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(FORCE_SYNC_EVENT));
}
