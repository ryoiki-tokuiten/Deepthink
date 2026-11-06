/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extracts a candidate JSON string from markdown code blocks or surrounding text.
 */
export function extractJsonString(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim();

    // 1. If wrapped in markdown code fence, extract the block
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
    if (fenceMatch && fenceMatch[1].trim()) {
        text = fenceMatch[1].trim();
    }

    // 2. If it already starts with { or [, return it
    if (text.startsWith('{') || text.startsWith('[')) {
        return text;
    }

    // 3. Find the outermost { ... } or [ ... ]
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let startIdx = -1;
    if (firstBrace !== -1 && firstBracket !== -1) {
        startIdx = Math.min(firstBrace, firstBracket);
    } else if (firstBrace !== -1) {
        startIdx = firstBrace;
    } else if (firstBracket !== -1) {
        startIdx = firstBracket;
    }

    if (startIdx !== -1) {
        const isObject = text[startIdx] === '{';
        const closeChar = isObject ? '}' : ']';
        const lastIdx = text.lastIndexOf(closeChar);
        if (lastIdx > startIdx) {
            return text.substring(startIdx, lastIdx + 1).trim();
        }
    }

    return text;
}

/**
 * Strict JSON parsing for AI outputs.
 * Extracts the candidate JSON from markdown code fences or outermost JSON delimiters,
 * and parses strictly via standard JSON.parse.
 * If JSON parsing fails, throws immediately without relaxed or fallback parsing.
 */
export function parseJsonSafe(raw: string, context: string): any {
    if (!raw || typeof raw !== 'string') {
        throw new Error(`Invalid input for ${context}: ${typeof raw}`);
    }

    // Try native JSON.parse directly
    try {
        return JSON.parse(raw);
    } catch {
        // Continue to code fence / delimiter extraction
    }

    const extracted = extractJsonString(raw);
    try {
        return JSON.parse(extracted);
    } catch (e: any) {
        throw new Error(`JSON parse failed in ${context}: ${e?.message || String(e)}`);
    }
}
