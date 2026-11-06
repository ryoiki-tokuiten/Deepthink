/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MANDATORY REFERENCE: Read Deepthink_Consolidated_Specification.md before modifying!
 * The specification document (Deepthink/docs/Deepthink_Consolidated_Specification.md)
 * is the absolute source of truth (§8.2, §8.3, §8.4).
 */

import type { ToolDefinition } from '@langchain/core/language_models/base';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';

export const SHARED_WORKSPACE_TOOL_NAME = 'shared_workspace';
export const SHARED_WORKSPACE_FILENAME = 'shared_workspace.md';
export const SHARED_WORKSPACE_MAX_TOKENS = 5000;

const tokenEncoder = getEncoding('cl100k_base');

export function countTextTokens(text: string): number {
  if (!text) return 0;
  return tokenEncoder.encode(text).length;
}

export class SharedWorkspaceTokenLimitError extends Error {
  public readonly tokenCount: number;
  public readonly maxTokens: number;

  constructor(tokenCount: number, maxTokens = SHARED_WORKSPACE_MAX_TOKENS) {
    super(
      `shared_workspace.md update rejected because the resulting document would be ${tokenCount} tokens, exceeding the maximum allowed limit of ${maxTokens} tokens.`
    );
    this.name = 'SharedWorkspaceTokenLimitError';
    this.tokenCount = tokenCount;
    this.maxTokens = maxTokens;
  }
}

export interface SharedWorkspaceToolInput {
  action: 'read' | 'edit' | 'append';
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export const sharedWorkspaceToolSchema = z.object({
  action: z.enum(['read', 'edit', 'append']).describe(
    'The action to perform on shared_workspace.md: "read" to get current content, "edit" to perform an exact string replacement, or "append" to add content at the end.'
  ),
  old_string: z.string().optional().describe(
    'Exact string to find and replace when action is "edit". Must match existing content in shared_workspace.md.'
  ),
  new_string: z.string().optional().describe(
    'Replacement string when action is "edit".'
  ),
  replace_all: z.boolean().optional().describe(
    'When action is "edit", set to true to replace all occurrences of old_string; defaults to false (requires unique match).'
  ),
  content: z.string().optional().describe(
    'The markdown text content to append at the end when action is "append".'
  ),
});

export const sharedWorkspaceToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: SHARED_WORKSPACE_TOOL_NAME,
    description: [
      'Read, edit, or append to the shared workspace document (shared_workspace.md) in real time.',
      'All agents across the system share this document.',
      'Use this to share valuable discoveries, invariants, equations, verified lemmas, or coordinates with other agents.',
      `The total document is strictly capped at ${SHARED_WORKSPACE_MAX_TOKENS} tokens.`,
      'Actions: "read" returns the full document; "edit" replaces old_string with new_string; "append" adds content to the end.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'edit', 'append'],
          description: 'The operation to perform: "read", "edit", or "append".'
        },
        old_string: {
          type: 'string',
          description: 'Exact existing text in shared_workspace.md to replace when action is "edit".'
        },
        new_string: {
          type: 'string',
          description: 'Replacement markdown text when action is "edit".'
        },
        replace_all: {
          type: 'boolean',
          description: 'When action is "edit", whether to replace all occurrences of old_string (default false).'
        },
        content: {
          type: 'string',
          description: 'Markdown content to append when action is "append". Ignored when action is "read" or "edit".'
        }
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

/**
 * Shared workspace state manager providing thread-safe realtime read/edit/append
 * across concurrent agent executions with a 5000-token maximum cap (§8.4).
 */
export class SharedWorkspaceManager {
  private content = '# Shared Workspace\n\nLive collaboration document across agents.\n';
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly onDiskSync?: (content: string) => Promise<void>;
  private readonly maxTokens: number;

  constructor(
    onDiskSync?: (content: string) => Promise<void>,
    maxTokens = SHARED_WORKSPACE_MAX_TOKENS
  ) {
    this.onDiskSync = onDiskSync;
    this.maxTokens = maxTokens;
  }

  public async read(): Promise<string> {
    return this.content;
  }

  /**
   * Internal orchestrator initialization/restore method (still enforces the 5000-token gate).
   * Note: Agent tool calls via handleToolCall do NOT have access to full-file "write"
   * and must use "edit" or "append".
   */
  public async write(newContent: string): Promise<string> {
    return this.enqueue(async () => {
      const tokenCount = countTextTokens(newContent);
      if (tokenCount > this.maxTokens) {
        throw new SharedWorkspaceTokenLimitError(tokenCount, this.maxTokens);
      }
      this.content = newContent;
      if (this.onDiskSync) {
        await this.onDiskSync(this.content);
      }
      return this.content;
    });
  }

  public async edit(
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<string> {
    return this.enqueue(async () => {
      if (!oldString) {
        throw new Error('shared_workspace edit requires a non-empty "old_string".');
      }
      if (!this.content.includes(oldString)) {
        throw new Error(
          'shared_workspace edit failed: "old_string" was not found in shared_workspace.md. Call shared_workspace with action="read" first to inspect the exact current text.'
        );
      }

      if (!replaceAll) {
        const firstIdx = this.content.indexOf(oldString);
        const secondIdx = this.content.indexOf(oldString, firstIdx + oldString.length);
        if (secondIdx !== -1) {
          throw new Error(
            'shared_workspace edit failed: "old_string" matched multiple locations in shared_workspace.md. Provide more surrounding context in "old_string" or set "replace_all" to true.'
          );
        }
      }

      const nextContent = replaceAll
        ? this.content.split(oldString).join(newString)
        : this.content.replace(oldString, () => newString);

      const tokenCount = countTextTokens(nextContent);
      if (tokenCount > this.maxTokens) {
        throw new SharedWorkspaceTokenLimitError(tokenCount, this.maxTokens);
      }

      this.content = nextContent;
      if (this.onDiskSync) {
        await this.onDiskSync(this.content);
      }
      return this.content;
    });
  }

  public async append(addition: string): Promise<string> {
    return this.enqueue(async () => {
      const trimmedAddition = (addition || '').trim();
      if (!trimmedAddition) {
        return this.content;
      }
      const nextContent = `${this.content.trimEnd()}\n\n${trimmedAddition}\n`;
      const tokenCount = countTextTokens(nextContent);
      if (tokenCount > this.maxTokens) {
        throw new SharedWorkspaceTokenLimitError(tokenCount, this.maxTokens);
      }

      this.content = nextContent;
      if (this.onDiskSync) {
        await this.onDiskSync(this.content);
      }
      return this.content;
    });
  }

  public async handleToolCall(input: {
    action: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
  }): Promise<string> {
    switch (input.action) {
      case 'read':
        return this.read();
      case 'edit':
        if (typeof input.old_string !== 'string' || input.old_string.length === 0) {
          throw new Error('shared_workspace action="edit" requires a non-empty "old_string" parameter.');
        }
        if (typeof input.new_string !== 'string') {
          throw new Error('shared_workspace action="edit" requires a "new_string" parameter.');
        }
        await this.edit(input.old_string, input.new_string, Boolean(input.replace_all));
        return 'Successfully edited shared workspace content.';
      case 'append':
        await this.append(input.content || '');
        return 'Successfully appended to shared workspace.';
      case 'write':
        throw new Error(
          'Full-file "write" is disabled on shared_workspace.md to prevent overwriting peer agents\' work. Use action="edit" (with old_string and new_string) or action="append" (with content).'
        );
      default:
        throw new Error(`Unsupported shared_workspace action: ${input.action}. Allowed actions are "read", "edit", and "append".`);
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op);
    this.writeQueue = next.then(() => {}, () => {});
    return next;
  }
}
