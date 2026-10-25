/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type {
    SandboxFinalOutputContract,
    SandboxRepositoryAccess,
    SeedFile,
} from '../../Core/SandboxToolRuntime';
import type { FileData } from '../../Core/Types';
import type { CustomizablePromptsDeepthink } from '../prompts';
import type { DeepthinkAgentKind } from './agentRegistry';

export interface DeepthinkRunConfig {
    selectedModel: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string;
    strategyCount: number;
    strategyProximityLoops: number;
    modulesCount: number;
    modulesImpactReviewLoops: number;
    depth: number;
    i?: number;
    j?: number;
    k?: number;
    isolateBranches: boolean;
    codeExecutionEnabled: boolean;
    prompts: CustomizablePromptsDeepthink;
}

type DeepthinkAttachmentSource = 'direct-file' | 'filesystem-file';

export interface DeepthinkAttachmentRoute {
    source: DeepthinkAttachmentSource;
    name: string;
    mimeType: string;
    base64: string;
    asMultimodalInput: boolean;
    asTextPromptContext: boolean;
    asFilesystemArtifact: boolean;
}

export interface DeepthinkAgentContextManifest {
    agentKind: DeepthinkAgentKind;
    agentName: string;
    sandboxSessionId: string;
    systemInstruction: string;
    promptText: string;
    attachments: DeepthinkAttachmentRoute[];
    repositoryAccess?: SandboxRepositoryAccess;
    outputContract?: SandboxFinalOutputContract;
}

function extensionForMimeType(mimeType: string): string {
    const extensions: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff',
        'application/json': '.json',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'text/csv': '.csv',
    };
    return extensions[mimeType] || (mimeType.startsWith('image/') ? '.png' : '.bin');
}

function uniqueName(requested: string, used: Set<string>, mimeType: string): string {
    const basename = requested.replace(/\\/g, '/').split('/').pop() || '';
    const sanitized = basename.replace(/[^\w.\- ()]/g, '_').trim() || 'deepthink-file';
    const normalized = sanitized.lastIndexOf('.') > 0
        ? sanitized
        : `${sanitized}${extensionForMimeType(mimeType)}`;
    if (!used.has(normalized)) {
        used.add(normalized);
        return normalized;
    }
    const dot = normalized.lastIndexOf('.');
    const stem = dot > 0 ? normalized.slice(0, dot) : normalized;
    const extension = dot > 0 ? normalized.slice(dot) : '';
    let suffix = 2;
    while (used.has(`${stem}-${suffix}${extension}`)) suffix++;
    const name = `${stem}-${suffix}${extension}`;
    used.add(name);
    return name;
}

export function buildDeepthinkAttachments(args: {
    directFiles: readonly FileData[];
    filesystemFiles?: readonly FileData[];
}): DeepthinkAttachmentRoute[] {
    const attachments: DeepthinkAttachmentRoute[] = [];
    const usedNames = new Set<string>();
    args.directFiles.forEach((file, index) => {
        const textual = file.mimeType.startsWith('text/') || file.mimeType === 'application/json';
        attachments.push({
            source: 'direct-file',
            name: uniqueName(file.name || `deepthink-direct-file-${index + 1}`, usedNames, file.mimeType),
            mimeType: file.mimeType,
            base64: file.base64,
            asMultimodalInput: file.mimeType.startsWith('image/'),
            asTextPromptContext: textual,
            asFilesystemArtifact: true,
        });
    });
    (args.filesystemFiles || []).forEach((file, index) => {
        attachments.push({
            source: 'filesystem-file',
            name: uniqueName(file.name || `deepthink-filesystem-file-${index + 1}`, usedNames, file.mimeType),
            mimeType: file.mimeType,
            base64: file.base64,
            asMultimodalInput: false,
            asTextPromptContext: false,
            asFilesystemArtifact: true,
        });
    });
    return attachments;
}

export function buildProviderParts(
    promptText: string,
    attachments: readonly DeepthinkAttachmentRoute[],
): Part[] {
    return [
        ...attachments
            .filter(attachment => attachment.asMultimodalInput)
            .map(attachment => ({
                inlineData: {
                    mimeType: attachment.mimeType,
                    data: attachment.base64,
                },
            })),
        { text: promptText },
    ];
}

export function buildTextAttachmentContext(attachments: readonly DeepthinkAttachmentRoute[]): string {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const sections = attachments
        .filter(attachment => attachment.asTextPromptContext)
        .map(attachment => {
            let content = '[Unable to decode file]';
            try {
                const binary = atob(attachment.base64);
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
                content = decoder.decode(bytes);
            } catch {
                // Preserve an explicit placeholder in the same prompt position.
            }
            return `\n\n--- ${attachment.name} ---\n${content}\n--- end file ---`;
        });
    return sections.length ? `\n\nDirect context files:${sections.join('')}` : '';
}

export function buildAttachmentSeedFiles(
    attachments: readonly DeepthinkAttachmentRoute[],
): SeedFile[] {
    return attachments
        .filter(attachment =>
            attachment.asFilesystemArtifact
            && attachment.source !== 'filesystem-file')
        .map(attachment => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            base64: attachment.base64,
        }));
}

export function buildFilesystemAttachmentFiles(
    attachments: readonly DeepthinkAttachmentRoute[],
): SeedFile[] {
    return attachments
        .filter(attachment =>
            attachment.asFilesystemArtifact
            && attachment.source === 'filesystem-file')
        .map(attachment => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            base64: attachment.base64,
            relativePath: `user_uploaded/${attachment.name}`,
        }));
}

export function validateExactUniqueIdSet(
    actualIds: readonly string[],
    expectedIds: readonly string[],
    context: string,
): void {
    const actual = new Set(actualIds);
    const expected = new Set(expectedIds);
    if (actual.size !== actualIds.length) {
        throw new Error(`${context} contains duplicate IDs.`);
    }
    if (expected.size !== expectedIds.length) {
        throw new Error(`${context} expected-ID set contains duplicates.`);
    }
    if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
        throw new Error(`${context} must contain exactly these IDs: ${expectedIds.join(', ')}.`);
    }
}

export function validateAllowedUniqueIds(
    actualIds: readonly string[],
    allowedIds: readonly string[],
    context: string,
    options: { allowEmpty?: boolean } = {},
): void {
    if (!options.allowEmpty && actualIds.length === 0) {
        throw new Error(`${context} must contain at least one ID.`);
    }
    if (new Set(actualIds).size !== actualIds.length) {
        throw new Error(`${context} contains duplicate IDs.`);
    }
    const allowed = new Set(allowedIds);
    const invalid = actualIds.filter(id => !allowed.has(id));
    if (invalid.length) {
        throw new Error(`${context} contains unknown IDs: ${invalid.join(', ')}.`);
    }
}

export function selectRoutedModules<T extends { targetBranchIds?: string[] }>(
    modules: readonly T[],
    strategyId: string,
    awaitingFreshModules = false,
): T[] {
    if (awaitingFreshModules) return [];
    return modules.filter(mod =>
        !mod.targetBranchIds?.length
        || mod.targetBranchIds.includes(strategyId));
}
