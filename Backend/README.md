# Sandbox Tool Environment

Iterative Studio runs agent terminal commands through an OS-level sandbox (`bwrap` on Linux, `sandbox-exec` Seatbelt on macOS, or `docker` across Linux, macOS, and Windows). Agents receive `sandbox_exec` for terminal work, `shared_workspace` for live cross-branch notes, and `final_output` for the submitted answer that enters the multi-agent pipeline.

## Workspace & Mount Model

Each Deepthink run operates in a single Git-backed repository (`Results/deepthink_<timestamp>/`) mounted at `/workspace`:

- **Repository root (`/workspace`)**: Mounted read-only by default, with `.git/` masked by a read-only overlay so agents cannot run `git commit`, `git reset`, or rewrite history.
- **Role-owned directory (`/workspace/<agentDirectory>`)**: Roles that produce artifacts (`Strategy-N/` for branch execution/correction/critique, `Module-M/` for module testers) receive read/write access to their assigned directory while `Strategy-N/history/` and `user_uploaded/` remain read-only.
- **Shared scratch & verification directory (`/workspace/tmp` and `/tmp`)**: Mounted read/write for every agent in the run (`TMPDIR=/tmp`) so branches, critiques, and testers can co-evolve verification harnesses and share intermediate scripts.
- **Host toolchains & caches (read-only)**:
  - Host Python, Node.js, C/C++, Rust, Lean 4, and system utilities are used directly without requiring multi-gigabyte upfront downloads.
  - User-level toolchain directories (`~/.local`, `~/.cargo`, `~/.rustup`, `~/.elan`, `~/.cache/rtk/bin`) and package caches (`~/.cache/pip`, `~/.cache/uv`, `~/.npm`) are mounted read-only when present.
  - Private home directories (`~/.ssh`, cloud credentials, shell histories, project `.env` files) are hidden or locked by OS mount namespaces (`bwrap` / `docker`) or explicit Seatbelt `deny file-read*` rules (`seatbelt`).
- **On-the-fly package installs**: Any package an agent installs via `pip install <pkg>` or `npm install -g <pkg>` is cached in the system wheel/npm cache and unpacked into `/tmp/.shared-python-pkgs` (`PYTHONPATH` / `PATH`) or `/tmp/.shared-node-pkgs` (`NODE_PATH` / `PATH`), making it immediately available to all agents in the run.
- **L3 Secret Store (`.env`)**: Non-reserved keys defined in `.env` are injected into the sandbox environment for authenticated CLI/API usage, and their raw secret values are automatically redacted from `stdout` and `stderr` before returning to the model or UI.

## Inline Artifacts & Output Gates

When an agent includes inline markers such as `[[image:plot.png|Plot]]` or `[[file:path|Label]]` in `final_output.response`, the runtime resolves and renders the artifact inline in the UI. Generated or modified images in visible workspace paths are also snapshotted into immutable artifacts and attached to the model as native image inputs.

## Environment Variables

- `ITERATIVE_STUDIO_SANDBOX_RUNTIME`: `auto`, `bwrap`, `seatbelt`, or `docker`. Defaults to `auto` (`bwrap` on Linux, `seatbelt` on macOS, `docker` fallback).
- `ITERATIVE_STUDIO_SANDBOX_MAX_TOOL_TURNS`: Maximum tool-call turns per agent invocation (default `64`).
- `ITERATIVE_STUDIO_SANDBOX_MAX_DURATION_MINUTES` / `ITERATIVE_STUDIO_SANDBOX_MAX_DURATION_MS`: Maximum wall-clock duration per agent invocation (default `60` minutes).
- `ITERATIVE_STUDIO_SANDBOX_COMMAND_TIMEOUT_MS`: Default timeout per `sandbox_exec` command in milliseconds (default `120000`).
- `ITERATIVE_STUDIO_SANDBOX_MAX_COMMAND_TIMEOUT_MS`: Maximum timeout per `sandbox_exec` command in milliseconds (default `300000`).
- `ITERATIVE_STUDIO_RESULTS_ROOT`: Directory where Deepthink run repositories are stored (default `./Results`).
- `ITERATIVE_STUDIO_BWRAP`: Bubblewrap executable (default `bwrap`).
- `ITERATIVE_STUDIO_DOCKER`: Docker CLI executable (default `docker`).
- `ITERATIVE_STUDIO_SANDBOX_IMAGE`: Container image for Docker mode (default `python:3.12-bookworm`).
- `ITERATIVE_STUDIO_SANDBOX_NETWORK`: Network mode (`bridge` by default; set to `none` to isolate network access).
- `ITERATIVE_STUDIO_SANDBOX_CPUS`: Docker CPU limit (default `2`).
- `ITERATIVE_STUDIO_SANDBOX_MEMORY`: Docker memory limit (default `1g`).
- `ITERATIVE_STUDIO_SANDBOX_PIDS_LIMIT`: Docker process limit (default `256`).

