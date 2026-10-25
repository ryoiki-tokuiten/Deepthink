/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MANDATORY REFERENCE: Read Deepthink_Consolidated_Specification.md before modifying!
 * The specification document (Deepthink/docs/Deepthink_Consolidated_Specification.md)
 * is the absolute source of truth (§8.1, §8.2, §8.3).
 * Consult that document for any minor inconvenience or question about file structures,
 * git barrier commits, or directory layouts.
 */

import type { DeepthinkResultsContextFile } from './types.ts';

async function getSandboxRuntime() {
  if (typeof window === 'undefined') return null;
  try {
    return await import('../../Core/SandboxToolRuntime.ts');
  } catch {
    return null;
  }
}

export class GitRepositoryHarness {
  private readonly repositoryId: string;
  private readonly committedFiles: Map<string, string> = new Map();
  private readonly archivedDirectories: string[] = [];
  private readonly rollbacks: Array<{ slotIndex: number; commitHash: string }> = [];

  constructor(repositoryId: string) {
    this.repositoryId = repositoryId;
  }

  /**
   * Returns a copy of all committed context files stored in this repository harness.
   */
  public getCommittedFiles(): Map<string, string> {
    return new Map(this.committedFiles);
  }

  /**
   * Retrieves the content of a specific committed file by relative path.
   */
  public getCommittedFile(path: string): string | undefined {
    return this.committedFiles.get(path);
  }

  /**
   * Returns list of archived directories created via PRUNE (§8.2).
   */
  public getArchivedDirectories(): string[] {
    return [...this.archivedDirectories];
  }

  /**
   * Returns list of rollback operations executed via EVOLVE rollback (§8.2).
   */
  public getRollbacks(): Array<{ slotIndex: number; commitHash: string }> {
    return [...this.rollbacks];
  }

  /**
   * Initializes the repository structure before strategy generation (§8.1, §8.2).
   */
  public async initializeRepository(_strategyCount?: number): Promise<string | undefined> {
    try {
      const rt = await getSandboxRuntime();
      if (rt?.ensureDeepthinkResultsRepository) {
        const res = await rt.ensureDeepthinkResultsRepository(this.repositoryId);
        return res?.resultPath;
      }
    } catch (err) {
      console.warn('Sandbox results repository initialization notice:', err);
    }
    return undefined;
  }

  /**
   * Writes durable orchestration context files into the repository and commits them (§8.1).
   */
  public async writeFilesAndCommit(
    commitMessage: string,
    files: DeepthinkResultsContextFile[]
  ): Promise<void> {
    if (!files.length) return;
    for (const file of files) {
      this.committedFiles.set(file.path, file.content);
    }
    try {
      const rt = await getSandboxRuntime();
      if (rt?.snapshotDeepthinkResultsRepository) {
        await rt.snapshotDeepthinkResultsRepository(this.repositoryId, commitMessage, files);
      }
    } catch (err) {
      console.warn(`Failed to commit context files (${commitMessage}):`, err);
    }
  }


  /**
   * Commits one strategy folder at an iteration barrier (§8.2).
   * Commits are run sequentially, one after another, touching one strategy directory only.
   */
  public async commitStrategyIteration(
    slotIndex: number,
    iteration: number,
    contextFiles?: DeepthinkResultsContextFile[]
  ): Promise<string> {
    const strategyDir = `Strategy-${slotIndex + 1}`;
    const commitMessage = `Commit ${strategyDir} at iteration ${iteration}`;
    if (contextFiles && contextFiles.length > 0) {
      await this.writeFilesAndCommit(commitMessage, contextFiles);
    }
    try {
      const rt = await getSandboxRuntime();
      if (rt?.snapshotSandboxRepositoryById) {
        return await rt.snapshotSandboxRepositoryById(this.repositoryId, commitMessage);
      }
      return `commit_${this.repositoryId}_slot${slotIndex}_it${iteration}`;
    } catch {
      return `commit_${this.repositoryId}_slot${slotIndex}_it${iteration}`;
    }
  }

  /**
   * Commits each strategy folder at the starting state of a window (after memory distillation
   * or first execution + critique) (§6.3, §8.2).
   * This is the checkpoint that a rollback to 'window_start' returns to.
   */
  public async commitWindowStart(
    slotIndex: number,
    windowStart: number,
    contextFiles?: DeepthinkResultsContextFile[]
  ): Promise<string> {
    const strategyDir = `Strategy-${slotIndex + 1}`;
    const commitMessage = `Starting state for ${strategyDir} at window beginning (iteration ${windowStart})`;
    if (contextFiles && contextFiles.length > 0) {
      await this.writeFilesAndCommit(commitMessage, contextFiles);
    }
    try {
      const rt = await getSandboxRuntime();
      if (rt?.snapshotSandboxRepositoryById) {
        return await rt.snapshotSandboxRepositoryById(this.repositoryId, commitMessage);
      }
      return `commit_${this.repositoryId}_slot${slotIndex}_start${windowStart}`;
    } catch {
      return `commit_${this.repositoryId}_slot${slotIndex}_start${windowStart}`;
    }
  }

  /**
   * Commits shared directories when a heartbeat finishes (§8.2).
   */
  public async commitHeartbeat(
    heartbeatNo: number,
    contextFiles?: DeepthinkResultsContextFile[]
  ): Promise<string> {
    const commitMessage = `Curated Context Heartbeat ${heartbeatNo}`;
    if (contextFiles && contextFiles.length > 0) {
      await this.writeFilesAndCommit(commitMessage, contextFiles);
    }
    try {
      const rt = await getSandboxRuntime();
      if (rt?.snapshotSandboxRepositoryById) {
        return await rt.snapshotSandboxRepositoryById(this.repositoryId, commitMessage);
      }
      return `commit_${this.repositoryId}_heartbeat${heartbeatNo}`;
    } catch {
      return `commit_${this.repositoryId}_heartbeat${heartbeatNo}`;
    }
  }

  /**
   * Commits strategy history after writing (§8.2).
   */
  public async commitStrategyHistory(
    filename: string,
    content?: string,
    trajectoryJsonl?: string
  ): Promise<string> {
    const commitMessage = `Strategy history update: ${filename}`;
    if (content) {
      const files: DeepthinkResultsContextFile[] = [{
        path: `strategies_history/${filename}`,
        content,
      }];
      if (trajectoryJsonl !== undefined) {
        files.push({
          path: `strategies_history/${filename.replace(/\.md$/i, '.jsonl')}`,
          content: trajectoryJsonl,
        });
      }
      await this.writeFilesAndCommit(commitMessage, files);
    }
    try {
      const rt = await getSandboxRuntime();
      if (rt?.snapshotSandboxRepositoryById) {
        return await rt.snapshotSandboxRepositoryById(this.repositoryId, commitMessage);
      }
      return `commit_${this.repositoryId}_hist_${filename}`;
    } catch {
      return `commit_${this.repositoryId}_hist_${filename}`;
    }
  }

  /**
   * Performs an EVOLVE rollback: restores the strategy directory to its state at the end
   * of the specified commit checkpoint, removing post-barrier leftovers (§8.2).
   */
  public async rollbackStrategy(slotIndex: number, commitHash: string): Promise<void> {
    const strategyDir = `Strategy-${slotIndex + 1}`;
    this.rollbacks.push({ slotIndex, commitHash });
    const rt = await getSandboxRuntime();
    if (rt?.restoreSandboxRepositoryStrategy) {
      await rt.restoreSandboxRepositoryStrategy(this.repositoryId, strategyDir, commitHash);
    }
  }

  /**
   * Performs a PRUNE: moves the active strategy directory to Pruned_Strategies/ under an ordinal name
   * and creates a fresh empty strategy directory (§8.2).
   */
  public async pruneStrategy(slotIndex: number): Promise<string | undefined> {
    const strategyDir = `Strategy-${slotIndex + 1}`;
    const ordinal = String(this.archivedDirectories.length + 1).padStart(2, '0');
    const targetArchived = `Pruned_Strategies/${strategyDir}_pruned_${ordinal}`;

    const rt = await getSandboxRuntime();
    if (rt?.archiveSandboxRepositoryStrategy) {
      const res = await rt.archiveSandboxRepositoryStrategy(this.repositoryId, strategyDir);
      const dir = res?.archivedDirectory || targetArchived;
      this.archivedDirectories.push(dir);
      return dir;
    }

    this.archivedDirectories.push(targetArchived);
    return targetArchived;
  }
}

