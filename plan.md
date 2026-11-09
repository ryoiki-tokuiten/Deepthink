# Deepthink L0–L3 OS-Inspired Sandbox & Harness Architecture Plan

## Core Principle: Inherent Simplicity
Instead of maintaining per-agent permission scaffolding (`readableDirectories`, `liveReadableDirectories`, `hiddenDirectories`, `viewRoot` copies, or per-file ACL matrices), the Deepthink harness enforces protection rings by **literal L0–L3 layers**, **mount regions**, and **host-level file stamping**, directly inspired by UNIX/Plan 9/seL4 operating system design:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ L0: Model Weights (Immutable Substrate)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│ L1: Direct Prompt Context (Assembled per turn by Harness)               │
├─────────────────────────────────────────────────────────────────────────┤
│ L2: Mutable Agent Workspace (Read/Write User Space)                     │
│     • /workspace/Strategy-N/            (active branch working files)   │
│     • /workspace/Modules/.../Module-M/  (active tester scratch files)   │
│     • /workspace/tmp/ (/tmp)            (shared scratch & harnesses)    │
│     • shared_workspace.md               (bounded 5k-token IPC via tool) │
├─────────────────────────────────────────────────────────────────────────┤
│ L3: Harness Kernel & Immutable Ledger (Read-Only Mounts / Kernel-Only)  │
│     • /workspace/.git/                  (always ro-bound)               │
│     • /workspace/user_uploaded/         (stamped 0444 + ro-bound)       │
│     • /workspace/Strategy-N/history/ & strategy.md (ro-bound over L2)   │
│     • /workspace/DOS_history/, strategies_history/, Pruned_Strategies/  │
│     • /workspace/Modules/Heartbeat-H/*.md, *.jsonl, feedback.json       │
│     • Global .env Secret Store (root .env file; managed in Providers UI)│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Current System Audit — What Already Works vs. Concrete Gaps

### 1. `user_uploaded/` Permissions (L3)
* **What already happens:**
  * During Deepthink runs (`fullRepositoryRead: true`), `/workspace` is bind-mounted read-only (`--mount ...,readonly` in Docker; `--ro-bind` in Bubblewrap). Because `user_uploaded/` has no writable sub-mount over it, Deepthink agents already cannot modify or delete `/workspace/user_uploaded/` inside the container.
* **Gaps to fix:**
  1. **Host files are written with `0644` instead of `0444`:** `seedWorkspaceFiles()` (`Backend/sandboxToolBackend.ts`) and `syncDeepthinkResultsSnapshot()` write `user_uploaded/*` with default writable permissions on the host filesystem.
  2. **Legacy/fallback workspace sessions mount `/workspace` read/write:** If `repositoryAccess` is omitted, `rootReadonly` is `false`, leaving `user_uploaded/` writable unless explicitly ro-bound and stamped `0444`.

### 2. Past Histories (`.md`, `.jsonl`, `.json`) & Rewind/Pruned Directories (L3)
* **What already happens:**
  * Root-level history directories (`DOS_history/`, `strategies_history/`, `Pruned_Strategies/`, and completed `Modules/Heartbeat-H/`) live under the read-only `/workspace` mount. Because an agent's only writable mounts are `/workspace/tmp` and its assigned `/workspace/<agentDirectory>`, agents already cannot modify root-level history directories.
* **Gaps to fix:**
  1. **`Strategy-N/history/` and `Strategy-N/strategy.md` sit inside the writable `Strategy-N/` mount (Critical Gap):**
     * The harness writes `Strategy-N/history/iteration_XX.md`, `Strategy-N/history/iteration_XX.jsonl`, `Strategy-N/history/memory_bank_XX.md`, `Strategy-N/history/memory_bank_XX.jsonl`, and `Strategy-N/strategy.md`.
     * When `solutionAttempt`, `solutionCritique`, or `solutionCorrection` runs, `prepareSandboxWorkspace()` mounts all of `/workspace/Strategy-N` as **`readonly: false`**.
     * Because POSIX file deletion/renaming is governed by parent directory write permissions (`Strategy-N/` and `Strategy-N/history/`), branch agents currently have full read/write/delete access to their own `Strategy-N/history/` files and `strategy.md`.
  2. **No `0444` immutable stamping on creation:**
     * `syncDeepthinkResultsSnapshot()` writes harness-generated `.md`, `.jsonl`, and `.json` files with default `0644` mode instead of stamping them read-only (`0444`) on creation.

### 3. Git Repository (`.git`) Inside L3
* **What already happens:**
  * Only the harness runs mutating Git commands (`git init`, `git add -A`, `git commit`, `git restore`, `git clean`) on the host.
  * Because `/workspace` is mounted read-only for Deepthink agents, `/workspace/.git` is inherited as read-only (`git log`, `git diff`, `git show`, `git status` work; `git commit` or `git reset` fails with `Read-only file system`).
* **Gaps to fix:**
  1. **`.git` is not explicitly ro-bound in `nestedMounts`:** Explicitly mounting `/workspace/.git` as `readonly: true` guarantees Git history is unconditionally in L3.

### 4. Global `.env` Secret Store in L3 & Providers Modal UI
* **Current state:** Provider keys (Gemini, OpenAI, Anthropic, Local, OpenAI-Compatible) are managed in the **Providers** modal (`Routing/ProviderManagementUI.ts`), while the root `.env` file is not exposed for managing Secret Store environment keys for the sandbox.
* **Design requirement:**
  * Store and manage Secret Store environment keys directly in the **global `.env` file in the root directory of the project** (`path.join(process.cwd(), '.env')`).
  * Add a consistent **Secret Store (`.env`)** card at the bottom of the **Providers** modal (`Routing/ProviderManagementUI.ts`) using the exact same card, instance list, and form styling as the existing provider cards.
  * Inject configured `.env` keys into the sandbox execution environment so agents can use `$KEY_NAME` seamlessly in commands, while keeping the `.env` file in L3 (project root, never mounted in `/workspace`) and redacting raw secret values from `stdout`/`stderr` so agents cannot read or edit the raw keys.

---

## Part 2: Clean Implementation Design (Literal L0–L3 Hierarchy)

### 1. Literal `L0`–`L3` Hierarchy in `Backend/sandboxToolBackend.ts`
* Organize sandbox protection directly around literal `L2` (mutable user space) and `L3` (immutable harness kernel) helpers:
  * `writeL3ImmutableFile(destination, content)`: unlocks parent directory (`0o755`) and existing file (`0o644`) when the harness updates cumulative ledgers (`strategies_finalized_and_used_so_far.md`, `modules_finalized_and_used_so_far.md`, `Strategy-N/strategy.md`), writes the content, and stamps `0o444` (`L3_IMMUTABLE_FILE_MODE`). Locks L3 history/upload directories (`0o555`) after harness writes and unlocks before `git restore`/`git clean` or strategy archiving.
  * `buildL2AndL3WorkspaceMounts(...)`:
    * **L3 Read-Only Base:** `/workspace` (`readonly: true`), `/workspace/.git` (`readonly: true`), `/workspace/user_uploaded` (`readonly: true`).
    * **L2 Read-Write User Space:** `/workspace/tmp` and `/tmp` (`readonly: false`), plus `/workspace/<agentDirectory>` (`readonly: false` for active writers; `readonly: true` for `bsr` and `memoryBank`).
    * **L3 Read-Only Overlays on L2 `Strategy-N`:** `/workspace/Strategy-N/history` (`readonly: true`) and `/workspace/Strategy-N/strategy.md` (`readonly: true`, when present).

### 2. Global `.env` Secret Store in L3 & Providers Modal UI (`Routing/ProviderManagementUI.ts`)
* **Backend (`/api/sandbox/env-secrets` in `Backend/sandboxToolBackend.ts`):**
  * Reads and updates the root `.env` file (`path.join(process.cwd(), '.env')`, overridable via `ITERATIVE_STUDIO_ENV_PATH` in tests).
  * `GET /api/sandbox/env-secrets`: returns configured `.env` keys with masked values (`••••abcd`).
  * `POST /api/sandbox/env-secrets`: sets/updates `KEY=VALUE` in root `.env` and `process.env`.
  * `DELETE /api/sandbox/env-secrets`: removes `KEY` from root `.env` and `process.env`.
  * Injects L3 `.env` keys into `getSandboxEnvEntries()` for container execution and scrubs raw secret values from `runSandboxCommand` `stdout`/`stderr` (`[REDACTED_L3_SECRET:KEY]`).
* **Frontend (`Routing/ProviderManagementUI.ts`):**
  * Renders a full-width **Secret Store (`.env` Environment Keys)** card at the bottom of `.provider-cards-grid` (below `OpenAI Compatible APIs`), reusing `.provider-card.openai-compatible-card`, `.openai-compatible-instances`, `.openai-compatible-instance`, and `.openai-compatible-add-form` for a 100% consistent UI experience.
