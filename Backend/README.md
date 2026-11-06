# Sandbox Tool Environment

Iterative Studio runs agent terminal commands through a real OS sandbox. Agents
receive `sandbox_exec` for private terminal work and `final_output` for the
submitted answer that enters the multi-agent system. Python is available as a
normal command inside the sandbox. When the host has a Rust toolchain, the
backend mounts only that toolchain sysroot read-only at `/sandbox-rust` so
`rustc` and `cargo` can be used without exposing the user's home directory.

Each agent session receives persistent scratch storage. Legacy sessions mount a
writable directory directly at `/workspace`. Contextual and Deepthink
multi-agent sessions use a run-level repository view: `/workspace` is
read-only, an optional role-owned generated directory is writable, and
role-specific peer directories are mounted read-only. A read-only repository
role has no generated directory and uses `/tmp` for private research files.
Some Deepthink roles receive the full repository read-only; scoped roles cannot
list or read directories outside their access policy. Python variables and
process memory do not persist between commands, so durable state should be
written to files.

When an agent includes inline markers such as `[[image:plot.png|Plot]]` directly
in `final_output.response`, the runtime renders the artifact at that exact
position and includes the exact `/workspace/...` path in the submitted output. The
virtual environment explorer also uses sandbox session metadata to label the
writable directory and read-only repository paths.

The backend can maintain an optional shared, read-only tool bundle at
`~/.cache/iterative-studio/sandbox-env` by default and mount it at
`/sandbox-env`. This bundle is summarized to the agent through
`/api/sandbox/environment`.

The large shared prewarm is opt-in. A fresh clone should not silently download
Python packages, Node packages, Lean, or Mathlib unless the user enables it.
Without prewarm, the sandbox still runs with the host/container commands that
are available, and agents can create workspace-local virtual environments or
project directories under `/workspace`.

Runtime defaults can be changed with environment variables:

- `ITERATIVE_STUDIO_SANDBOX_RUNTIME`: `auto`, `docker`, or `bwrap`. Defaults to
  `auto`, which uses Docker when the daemon socket is accessible and falls back
  to bubblewrap when available.
- `ITERATIVE_STUDIO_SANDBOX_PREWARM`: set to `1`, `true`, `yes`, `on`, or
  `enabled` to preinstall the shared Python, Node, Lean, and Mathlib bundle.
  Disabled by default because the Lean/Mathlib cache can be several gigabytes.
- `ITERATIVE_STUDIO_SANDBOX_ENV_ROOT`: shared tool bundle directory. Defaults to
  `~/.cache/iterative-studio/sandbox-env`.
- `ITERATIVE_STUDIO_SANDBOX_PYTHON_PACKAGES`: whitespace- or comma-separated
  Python packages to preinstall in the shared read-only Python environment.
- `ITERATIVE_STUDIO_SANDBOX_NODE_PACKAGES`: whitespace- or comma-separated Node
  packages to preinstall under the shared Node prefix.
- `ITERATIVE_STUDIO_SANDBOX_LEAN`: set to `1`, `true`, `yes`, `on`, or
  `enabled` to install Lean even when the full shared prewarm is disabled. Set
  to a disabled value to skip Lean setup when full prewarm is enabled.
- `ITERATIVE_STUDIO_SANDBOX_LEAN_TOOLCHAIN`: Lean toolchain installed by elan.
  Defaults to `leanprover/lean4:stable`.
- `ITERATIVE_STUDIO_SANDBOX_MATHLIB`: set to a disabled value to skip the
  shared prewarmed Mathlib/Lake project.
- `ITERATIVE_STUDIO_SANDBOX_MATHLIB_REV`: Mathlib git tag/revision to prewarm.
  Defaults to the installed Lean version, for example `v4.31.0`.
- `ITERATIVE_STUDIO_DOCKER`: Docker-compatible CLI executable. Defaults to
  `docker`.
- `ITERATIVE_STUDIO_BWRAP`: bubblewrap executable. Defaults to `bwrap`.
- `ITERATIVE_STUDIO_SANDBOX_IMAGE`: Container image. Defaults to
  `python:3.12-bookworm`. Used by the Docker runtime.
- `ITERATIVE_STUDIO_SANDBOX_NETWORK`: Docker network mode. Defaults to
  `bridge`; set to `none` to disable network access. For bubblewrap, `none`
  creates a private network namespace and other values retain the host network
  namespace.
- `ITERATIVE_STUDIO_SANDBOX_RUST_SYSROOT`: Optional Rust sysroot to expose
  read-only at `/sandbox-rust`. Set to `none` to disable Rust exposure. When
  unset, the backend probes `rustc --print sysroot` and the user's rustup shim.
- `ITERATIVE_STUDIO_RUSTC`: Optional rustc executable used for auto-detecting
  the Rust sysroot. Defaults to `rustc`.
- `ITERATIVE_STUDIO_SANDBOX_CPUS`: Docker CPU limit. Defaults to `2`.
- `ITERATIVE_STUDIO_SANDBOX_MEMORY`: Docker memory limit. Defaults to `1g`.
- `ITERATIVE_STUDIO_SANDBOX_PIDS_LIMIT`: Docker process limit. Defaults to
  `256`.

The Docker runtime uses a read-only root filesystem, no Linux capabilities,
`no-new-privileges`, and writable mounts only for the agent's writable directory
and a workspace-backed `/tmp`. The bubblewrap runtime creates user, pid, ipc,
uts, and optional network namespaces; mounts system paths read-only; and makes
only the agent writable directory and workspace-backed `/tmp` writable.
Generated or modified image files in visible workspace paths are snapshotted
into immutable artifacts for UI display and are attached back to the model as
native image inputs.

When shared Python and Node prewarm is enabled, those environments are stored
under the shared tool bundle, mounted read-only inside the sandbox, and exposed
on the sandbox `PATH`. Extra package installs should be written into the
workspace, preferably through a virtual environment or project-local package
directory created under the writable agent directory. Cargo state is scoped to
that writable directory with `CARGO_HOME` and `CARGO_TARGET_DIR`.

Lean is installed through elan into the shared tool bundle when enabled. Mathlib
is prewarmed into a shared Lake project when enabled, so agents do not have to
clone Mathlib in every workspace. Agents can verify standalone Lean files with
`lean file.lean`, smoke-test the setup with `lean-check`, and create a
Mathlib/Lake project in their workspace with `lean-init-mathlib ProjectName`.

Default storage layout:

- `~/.cache/iterative-studio/sandbox-env/python`: shared Python virtual
  environment and preinstalled Python packages.
- `~/.cache/iterative-studio/sandbox-env/pip-cache`: pip download/build cache.
- `~/.cache/iterative-studio/sandbox-env/node`: shared Node package prefix.
- `~/.cache/iterative-studio/sandbox-env/lean/elan`: elan, Lean, and Lake
  toolchains.
- `~/.cache/iterative-studio/sandbox-env/lean/SandboxMathlib`: shared Mathlib
  Lake project and downloaded Mathlib cache.

`Backend/Python_Environment` is not used for this sandbox prewarm bundle.
