export function extractJsonString(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim();

    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
    if (fenceMatch && fenceMatch[1].trim()) {
        text = fenceMatch[1].trim();
    }

    if (text.startsWith('{') || text.startsWith('[')) {
        return text;
    }

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

export function parseJsonSafe(raw: string, context: string): any {
    if (!raw || typeof raw !== 'string') {
        throw new Error(`Invalid input for ${context}: ${typeof raw}`);
    }

    try {
        return JSON.parse(raw);
    } catch {
    }

    const extracted = extractJsonString(raw);
    try {
        return JSON.parse(extracted);
    } catch (e: any) {
        throw new Error(`JSON parse failed in ${context}: ${e?.message || String(e)}`);
    }
}
