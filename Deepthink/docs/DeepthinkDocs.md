# Deepthink

Deepthink tackles a hard challenge by running several different strategies side by side. Each strategy lives in its own branch. In every iteration each branch executes on its strategy (producing or refining a complete solution) and has it critiqued by a dedicated Critique Agent, and all branches finish the iteration before any of them moves on. Every $j = 4$ iterations (when $n < i$), a Global Update evaluates how each branch has been trending, decides whether to keep it (`CONTINUE`), evolve its strategy (`EVOLVE` in place or with rollback), or replace it (`PRUNE`), distills surviving branch histories into a Memory Bank in parallel with replacement branch initial `Execution > Critique`, and concludes with a Curated Context Heartbeat that synthesizes cross-branch state and builds tested modules for the next window. At the final iteration $i$, every surviving branch runs its final Execution (without a critique) and stands as a valid candidate output.

One kind of supporting evidence can be added at the end of each Global Update, and it is optional: curated context modules that are built and verified in parallel by dedicated **Modules Building** agents. The pipeline is the same on every run. Settings change the number of branches, the total number of iterations ($i$), and which optional agents take part.

## Terms

| Term | Meaning |
|---|---|
| Branch, slot | One strategy and everything built on it. Branches are named `main1` to `mainN`. The name belongs to the slot, so replacing a branch's strategy text or the whole branch keeps the name. |
| Iteration | One round in which every branch advances once (`Execution > Critique` for iterations $1 \dots i-1$; `Execution` only for final iteration $i$). |
| Window | The $j = 4$ iterations between two Global Updates. |
| Global update | Runs after every $j = 4$ iterations (when $n \bmod 4 = 0$ and $n < i$). Scores each branch via BSR, keeps it, rewrites its strategy, or replaces it, distills memory banks, and concludes with the Curated Context Heartbeat. |
| Heartbeat | The concluding phase of a Global Update when modules are enabled (`modulesCount > 0`). Runs `State-Synthesis-For-Modules`, `Modules Generator <-> Modules Impact Reviewer`, and parallel `Modules Building` agents to refresh the module packets that upcoming Execution Agents read. |
| Curated context | That evidence: independently built and tested modules prepared and mapped per branch at the end of each Global Update. |
| State Synthesis | An agent (`stateSynthesis`) that summarizes where every branch stands across two Global Update stages: `State-Synthesis-For-Strategies` and `State-Synthesis-For-Modules`. |
| BSR | Branch State Representation. An agent (`bsr`) that reports confirmed progress and regression events in a branch during a window. |

## Principles

- A branch name is also its folder, `Strategy-N`. Rewriting a strategy never changes the name.
- A single unified **Execution Agent** (`executionAgent`) handles iteration 1 initial execution, replacement branch initial execution, and all subsequent iterative refinements ($2 \dots i$) based on the branch history and context passed to it.
- No agent decides what happens to a branch. BSR describes the window, and fixed formulas turn that report and the standing event ledger into a decision (`CONTINUE`, `EVOLVE (in_place)`, `EVOLVE (rollback)`, or `PRUNE`).
- Iteration numbers count from the start of the run for every branch. A replacement branch created during the Global Update after iteration 4 records its initial `Execution > Critique` at iteration 4 and its next refinement at iteration 5.
- Curated context modules are optional and run exclusively as the concluding phase of each Global Update. There are no standalone heartbeats between Global Updates.

## Configuration

| Setting | Meaning | Range | Default |
|---|---|---|---|
| `i` | Total iterations | 5 to 20 | 10 |
| `j` | Fixed Global Update interval | Fixed at 4 | 4 |
| `strategiesCount` | Number of parallel strategy branches | 1 to 5 | |
| `strategyProximityLoops` | Rounds of Strategy Generator and Strategy Proximity Reviewer | | |
| `modulesCount` | Modules per Global Update Heartbeat. 0 turns modules off | | |
| `modulesImpactReviewLoops` | Rounds of Modules Generator and Modules Impact Reviewer | | |
| `isolateBranches` | Execution Agents get no information about other branches | | |
| `deepthinkCodeExecutionEnabled` | Gives agents sandbox tools | | |
| `thinkingLevel` | Reasoning effort requested from the provider | | |
| `bsrNoiseLevel` | BSR noise threshold $\tau$ | | 0.05 |
| `bsrPressureFloor` | BSR pressure threshold $\theta$ for `EVOLVE` or `PRUNE` | | 0.20 |
| `bsrWeightSmall` | Weight for `small` confirmed events | | 0.15 |
| `bsrWeightMedium` | Weight for `medium` confirmed events | | 0.30 |
| `bsrWeightLarge` | Weight for `large` confirmed events | | 0.50 |

All bounds are inclusive and a violation is reported as an error. The Global Update cadence is fixed at $j = 4$ iterations, so Global Updates occur after iterations $4, 8, 12, 16$ whenever $n < i$.

`isolateBranches` is enforced through the agents' instructions. Every agent can technically read the whole repository, so isolation depends on the agent following its prompt.

Each agent has an editable system prompt and an optional model override. The override wins over the run's selected model.

## The run loop

```text
Seed strategies
Iteration 1            every branch runs Execution Agent, then Critique Agent
Iterations 2 to i - 1  every branch runs Execution Agent, then Critique Agent
                       (when n mod 4 == 0 and n < i, a Global Update + Heartbeat runs after Critique)
Iteration i            every branch runs its final Execution Agent (no Critique); pipeline completes
```

Inside an iteration, all branches run their Execution Agent in parallel, and once all finishes, all branches run their Critique Agent in parallel (for $n < i$). In the final iteration $i$, only the branch Execution Agents run, and each surviving strategy branch stands as a valid final output. There are no modules before the first Global Update (after iteration 4), because modules are synthesized from accumulated branch executions, critiques, and `State-Synthesis-For-Modules`.

After iteration `n` finishes, exactly one of these happens:

1. If `n = i`, the run completes once the final Execution Agents finish. No Critique Agent or Global Update runs.
2. If `n` is a multiple of `4` (`n % 4 === 0` and `n < i`), a unified **Global Update** runs (concluding with a Curated Context Heartbeat when `modulesCount > 0`).
3. Otherwise, the pipeline advances directly to iteration `n + 1`.

**Example: `i = 10` (default), `j = 4` (fixed)**

| After iteration | What runs |
|---|---|
| 1, 2, 3 | nothing (advance to next iteration) |
| 4 | Global Update 1 (BSR + `State-Synthesis-For-Strategies` $\to$ Strategy Revision $\to$ Parallel Memory Bank Distillation & Pruned Branch `Execution > Critique` $\to$ `State-Synthesis-For-Modules` $\to$ `Modules Generator <-> Impact Reviewer` $\to$ Parallel `Modules Building`) |
| 5, 6, 7 | nothing (advance to next iteration) |
| 8 | Global Update 2 (full Global Update + Heartbeat 2) |
| 9 | nothing (advance to final iteration) |
| 10 | Final iteration (Execution Agents only); run completes |

**Example: `i = 15`, `j = 4` (fixed)**

| After iteration | What runs |
|---|---|
| 1, 2, 3 | nothing |
| 4 | Global Update 1 + Heartbeat 1 |
| 5, 6, 7 | nothing |
| 8 | Global Update 2 + Heartbeat 2 |
| 9, 10, 11 | nothing |
| 12 | Global Update 3 + Heartbeat 3 |
| 13, 14 | nothing |
| 15 | Final iteration (Execution Agents only); run completes |

## Strategy generation

Strategies come from a **Strategy Generator** and a **Strategy Proximity Reviewer** that take turns. The generator proposes, the reviewer criticizes, and the generator revises, for as many rounds as `strategyProximityLoops` says. The last proposal is used. What each agent receives is listed under What every agent receives.

The reviewer looks for overlap between strategies, variations that are only on the surface, parts of the problem that no strategy covers, and strategies that depend on each other.

**Seed.** The output is the full set:

```json
{ "strategies": ["...", "..."] }
```

The strategies are assigned to `main1` to `mainN` in order.

**Global update.** The generator returns only the slots that are changing (`evolved_slots` and `pruned_slots`), covered in the Global update section below.

## Branch work

### Execution Agent

A single unified **Execution Agent** (`executionAgent`) runs in every iteration ($1 \dots i$) and for the initial execution of every replacement branch created in a `PRUNE` slot during a Global Update:
- In iteration 1 (and replacement branch initial runs), it receives the core challenge and its assigned strategy text and writes its first complete solution into `Strategy-N/`.
- In iterations $2 \dots i$, it receives the core challenge, its assigned strategy text, `<BranchHistoryAndMemory>` (including any distilled Memory Bank, mapped Curated Context packet, and current window execution-critique pairs), and—when `isolateBranches` is off—`<CrossStrategyPeerIntelligence>`, and writes the branch's next complete solution into `Strategy-N/`.

### Critique Agent

The **Critique Agent** (`critiqueAgent`) runs after every Execution Agent in iterations $1 \dots i-1$ and after every replacement branch's initial execution during a Global Update. It assesses the solution just produced for correctness, completeness, broken constraints, structural weaknesses, and whether the strategy still looks viable. It does not rewrite the solution.

### Memory Bank

At each Global Update, every surviving branch (`CONTINUE`, `EVOLVE in place`, and `EVOLVE with rollback`) is distilled by the **Memory Bank** (`memoryBank`) agent in parallel with replacement branch `Execution > Critique`. The agent merges the previous memory bank with the window's execution-critique history into a single cohesive document recording verified insights, recurring failure modes, attempted repairs, and trajectory evolution.

The window is the $j = 4$ iterations that end at the Global Update: iterations `n - 3` to `n`.
- For `CONTINUE` and `EVOLVE (in_place)`, all 4 iterations of the window (`n - 3 .. n`) are distilled.
- For `EVOLVE (rollback)`, only the window iterations up to and including the rollback target (`windowStart .. last_good_iteration`) are distilled, excluding the regressed iterations that occurred after `last_good_iteration`. If `last_good_iteration` is `window_start`, no window iterations remain after the rollback, so no new Memory Bank call is made and the previous memory bank stays unchanged.

Nothing is compressed inside a window. Only the Memory Bank compresses across Global Update boundaries.

## Global update & Heartbeat

A Global Update runs after iteration `n` when `n` is a multiple of `4` (`n % 4 === 0`) and `n < i`, immediately after iteration `n`'s `Execution > Critique` completes.

1. **BSR and `State-Synthesis-For-Strategies` run in parallel.** One BSR agent per branch evaluates the 4-iteration window, while one State Synthesis call (`State-Synthesis-For-Strategies`) summarizes where every branch stands.
2. **Code decides.** The BSR reports go through the deterministic formulas in the BSR section and give each branch one decision: `CONTINUE`, `EVOLVE (in_place)`, `EVOLVE (rollback)`, or `PRUNE`.
3. **New strategies.** When at least one branch is `EVOLVE` or `PRUNE`, the Strategy Generator and Strategy Proximity Reviewer rewrite only the changing slots.
4. **The repository is updated and rolled out.** Pruned branches are archived into `Pruned_Strategies/`, branches undergoing `EVOLVE (rollback)` are restored from their `last_good_iteration` (or `window_start`) commit, each freed slot gets a fresh folder, and `State_Synthesis_global_update_XX_for_strategies.md` (+ `.jsonl`), strategy revision histories, `strategies_finalized_and_used_so_far.md`, and updated `Strategy-N/strategy.md` files are committed together in a single rollout commit (recording the `window_start` commit for the next window).
5. **Memory Bank distillation and replacement branch executions run in parallel.** Each surviving branch (`CONTINUE`, `EVOLVE in place`, `EVOLVE with rollback`) runs its Memory Bank distillation (`windowStart .. n` for `CONTINUE`/`EVOLVE in place`, or `windowStart .. last_good_iteration` for `EVOLVE with rollback`) and commits its `Strategy-N/` folder. Simultaneously, each `PRUNE` replacement branch runs its initial `Execution > Critique` (recorded as iteration `n`) and commits its `Strategy-N/` folder. The system waits for all branches to finish.
6. **`State-Synthesis-For-Modules` (when `modulesCount > 0`).** State Synthesis runs its second call of the Global Update (`State-Synthesis-For-Modules`), auditing how surviving branches utilized the previous Global Update's modules and synthesizing the post-update state across surviving and newly initialized replacement branches.
7. **Modules Generation, Impact Review, and Modules Building (when `modulesCount > 0`).** Using the output of `State-Synthesis-For-Modules`, the **Modules Generator** and **Modules Impact Reviewer** run for `modulesImpactReviewLoops` rounds to produce `modulesCount` modules. Each module is then built and tested in parallel by a dedicated **Modules Building** agent in `Modules/Heartbeat-H/Module-M/`, mapped into per-branch packets, and committed together with `State_Synthesis_global_update_XX_for_modules.md` (+ `.jsonl`) and realized `feedback.json` records.

`State-Synthesis-For-Strategies` runs even when curated context modules are off (`modulesCount = 0`), because strategy generation uses it. `State-Synthesis-For-Modules`, `Modules Generator <-> Impact Reviewer`, and `Modules Building` run only when `modulesCount > 0`.

### Strategy changes

Its inputs are listed under What every agent receives.

It returns only what changes:

```json
{
  "evolved_slots": [{ "slot_id": "main2", "updated_strategy_text": "..." }],
  "pruned_slots":  [{ "slot_id": "main4", "new_strategy_text": "..." }]
}
```

There must be one entry for every `EVOLVE` slot, one for every `PRUNE` slot, and none for any `CONTINUE` slot. A branch that continues cannot be touched, because the output format has no place for it. For a pruned slot, the generator decides how much of the old strategy to reuse. It may re-aim the same idea, keep the part that worked, or drop it. The strategy text is the only thing a replacement branch inherits.

### Modules & Modules Building

When `modulesCount > 0`, a **Modules Generator** and a **Modules Impact Reviewer** take turns at the end of each Global Update, just as Strategy Generator and Strategy Proximity Reviewer do for strategies. The reviewer checks that each module can be proven wrong or verified, can be built and tested alone, and matters to the challenge.

Each module is an object:

```json
{
  "module_id": "m2",
  "text": "A self-contained investigative task or subcomponent that a build/test run can verify or falsify",
  "target_branches": ["main1", "main3"]
}
```

An empty `target_branches` list means the result is useful to every branch.

Each finalized module goes to its own **Modules Building** (`modulesBuilding`) agent, and the Modules Building agents run in parallel. Each Modules Building agent receives the challenge (and any image) and its one assigned module in its prompt, while having full read access across the repository, read and write access to its own `Modules/Heartbeat-H/Module-M/` folder and `tmp/`, and access to `shared_workspace`.

Every Modules Building agent ends with a classification line, which is parsed as `VALIDATED`, `REJECTED`, or `INCONCLUSIVE`.

Each branch then receives a mapped packet made of every module marked for all branches (`target_branches: []`) plus every module that explicitly targets that branch, each with its full Modules Building output. Execution Agents in the next 4-iteration window read this mapped packet via `<LatestCustomCuratedContext>`.

## State Synthesis

The **State Synthesis** (`stateSynthesis`) agent summarizes where the branches stand. It remembers nothing between calls; each call is built fresh from the stored state and operates in one of two Global Update stages:

| Stage | When | Output |
|---|---|---|
| `State-Synthesis-For-Strategies` | At the start of a Global Update (in parallel with BSR) | `core_synthesis` only. Feeds the Strategy Generator & Strategy Proximity Reviewer, and serves as `<StateSynthesisForStrategiesBaseline>` for `State-Synthesis-For-Modules`. |
| `State-Synthesis-For-Modules` | During the concluding Heartbeat of a Global Update (when `modulesCount > 0`, after Memory Bank distillation and replacement branch `Execution > Critique`) | `core_synthesis` and `module_feedback` on surviving branches. Feeds the Modules Generator & Modules Impact Reviewer. |

Once Memory Bank distillation and replacement branch initialization complete, replacement branches appear in `PRUNE` slots with only their initial execution and critique, and pruned branches have been archived. A branch that underwent `EVOLVE (rollback)` has reverted its folder and history to `last_good_iteration`. Consequently, `State-Synthesis-For-Modules` can produce `module_feedback` only for branches that survived (`CONTINUE` or `EVOLVE`), since replacement branches never received the previous Global Update's module packet. Each call comes with a `<HarnessNote>` explaining the stage and listing what happened to each slot.

State Synthesis reports only what it can observe. It does not claim that a module caused a decision about a branch. For each module from the previous Global Update and each surviving branch the module was mapped to, it reports whether the module was used (`USED_CORRECTLY`, `USED_PARTIALLY`, `NOT_USED`, or `MISUSED`) and whether a later critique provides strong counterevidence against the Modules Building verdict.

```json
{
  "core_synthesis": { "...": "the structured cross-branch synthesis" },
  "module_feedback": [
    {
      "module_id": "m2",
      "branch_utilization": [
        { "branch_id": "main1", "utilization": { "reason": "...", "classification": "USED_CORRECTLY" } },
        { "branch_id": "main3", "utilization": { "reason": "...", "classification": "NOT_USED" } }
      ],
      "critique_counterevidence": [
        { "branch_id": "main1", "reason": "...", "classification": "STRONG" }
      ]
    }
  ]
}
```

`critique_counterevidence` can be left out when there is none. `module_feedback` appears only in `State-Synthesis-For-Modules` when a previous Global Update Heartbeat exists to report on.

## Module feedback

When `State-Synthesis-For-Modules` returns feedback on the previous Global Update's modules, the harness turns it into a realized feedback record for each module.

**Utilization** is counted over the module-and-branch pairs that State Synthesis could judge. With C, P, N, and M the counts of correct, partial, not used, and misused, and T their total, the result is the vector `[C/T, P/T, N/T, M/T]`. The four numbers are not combined into a single score. If T is 0, the record has no utilization.

```json
{
  "module_id": "m2",
  "observed_test_outcome": "VALIDATED",
  "utilization": { "correct_use": 0.50, "partial_use": 0.25, "not_used": 0.25, "misused": 0.00 },
  "utilization_note": "Calculated from State Synthesis's observations.",
  "critique_counterevidence": [{ "branch_id": "main1", "classification": "STRONG", "reason": "..." }]
}
```

Each record is saved as `feedback.json` in the matching `Module-M/` folder and kept in the heartbeat's block, together with the generator and reviewer exchange, the final modules, the Modules Building outputs, and the branch packets. The strategy agents never see utilization or counterevidence.

## BSR

### What it does

BSR does not judge whether a branch's answer is correct. Confidence in an answer, an exhausted critique, and an answer that looks complete all count as no evidence of truth, since a branch can be firmly stuck in a wrong answer. BSR serves one question: is another window on this branch's strategy worth the compute?

It does not answer that question itself. It reports what changed during the window and how directly the executions followed the critiques, and code answers the question from the observed window and the branch's standing event ledger.

A branch can run out of value in two ways. In failure, it is stuck, getting worse, or repeating the same unresolved problems. In saturation, the strategy has given what it can, and another window would add little whether or not the answer is right. Progress that is already standing protects a branch from being pruned. A failing branch is released, and a saturated one gets a new strategy.

BSR runs once per branch at the start of each Global Update (in parallel with `State-Synthesis-For-Strategies`), and judges the 4-iteration window as a single trajectory. It never outputs an action.

### The report

```json
{
  "branch_id": "main2",
  "confirmed_progress":   [{ "iteration": 6, "size": "large", "reason": "..." }],
  "confirmed_regression": [{ "iteration": 8, "size": "large", "reason": "..." }],
  "critique_alignment": { "value": 0.6, "reason": "..." }
}
```

An **event** is a change placed at the iteration whose execution caused it, with a size:

- `small`: a local change with little consequence
- `medium`: a change that matters for correctness or completeness
- `large`: a change that alters the validity or structure of the answer

BSR gives only these sizes and never a number. A branch's first solution is the baseline of its first window and carries no events.

An event counts only when something besides the execution's own claim supports it. For progress, that means a critique from the same or a later iteration agrees the issue is resolved, or a sandbox run shows it. For regression, the same kinds of evidence show a defect that was absent before, or one that had been fixed and came back.

`critique_alignment` runs from -1 to 1. At 1, every point in the critiques was taken up by the next execution. At -1, the executions went against them. It keeps a branch whose executions ignored the critiques from being blamed on its strategy. Negative values are treated as 0.

### Scoring the window

These parameters have default values in `formulas.ts` and can be overridden in `DeepthinkRunConfig`.

| Parameter | Default | Role |
|---|---|---|
| Size weights | small 0.15, medium 0.30, large 0.50 | Convert event sizes to movement |
| Noise level $\tau$ | 0.05 | Smallest net change that counts as a trend |
| Pressure floor $\theta$ | 0.20 | Smallest pressure that can trigger EVOLVE or PRUNE |

Code builds a running total over the window's iterations, starting at 0. A progress event raises it by its weight and a regression lowers it.

```text
net       = running total after the last iteration
movement  = sum of the weights of all events, both directions

window outcome:  PROGRESS if net >= τ,  REGRESS if net <= -τ,  otherwise STALL
best_total          = highest value the running total reached (at least 0)
last_good_iteration = latest iteration where the total was at best_total, or window_start
lost_ground         = (best_total - net) / (movement + τ)
progress_kept       = max(0, net_life) / (movement_life + τ)
```

`lost_ground` is the share of the window's movement that was undone after the branch's best point. `progress_kept` uses the branch's whole ledger, including this window, so that a branch which has quietly finished its work does not look like it did nothing. Both are 0 when there are no events.

### Pressures and the decision

```text
drift          = net / (movement + τ)
stall_evidence = (1 - max(0, drift)) * max(0, critique_alignment)

pressure[CONTINUE] = max(0, drift)
pressure[EVOLVE]   = max(lost_ground, stall_evidence * progress_kept)
pressure[PRUNE]    = stall_evidence * (1 - progress_kept) * (1 - lost_ground)
```

Stall evidence measures how strongly the observed window indicates that another window on the current strategy will produce nothing: it combines lack of positive drift in the window with executions that faithfully followed the critiques. Pressures run from 0 to 1 and do not sum to 1.

The decision for each branch follows three rules in order:

1. If the EVOLVE and PRUNE pressures are both below $\theta$, the branch continues.
2. Otherwise, if the CONTINUE pressure is at least as high as both, the branch continues.
3. Otherwise the higher of EVOLVE and PRUNE wins. Ties go to the less destructive action: CONTINUE, then EVOLVE, then PRUNE.

For EVOLVE, the form is rollback when `lost_ground > stall_evidence * progress_kept`, and in place otherwise. A tie goes to in place.

In practice, a branch that started well and then regressed gets `EVOLVE with rollback`. A branch that stalled with little progress standing gets `PRUNE`. A branch that stalled with substantial progress standing gets `EVOLVE in place`, and its solution stays a candidate for the final answer.

### What each decision does

- **CONTINUE.** Nothing changes. The branch carries on from its new Memory Bank (distilled over all 4 iterations of the window).
- **EVOLVE in place.** The strategy text is rewritten. History, memory (distilled over all 4 iterations of the window), and the ledger stay as they are.
- **EVOLVE with rollback.** The branch's folder is restored to the end of `last_good_iteration` (or `window_start`). The later regressed iterations leave the folder on disk but remain in git commit history. The standing event ledger loses the discarded events and keeps the rest. The Memory Bank distills **only the window iterations up to and including `last_good_iteration`** (`windowStart .. last_good_iteration`), so the branch's memory bank is never polluted by the discarded regressed turns (or skips distillation if `last_good_iteration === 'window_start'`).
- **PRUNE.** The branch is stopped and archived into `Pruned_Strategies/` and its slot is freed. A replacement branch takes the slot with a new strategy, runs an initial `Execution > Critique` in parallel with the surviving branches' Memory Bank distillation, and starts with an empty ledger and no Memory Bank. Nothing the old branch produced reaches the new one except what the Strategy Generator chooses to carry into the new strategy text.

### Standing event ledger

The standing event ledger is stored per branch and carried from one Global Update to the next. It lives outside the repository, along with every BSR report, its computed values, and its decision.

- **The ledger** lists every confirmed event still standing, with its iteration, direction, size, weight, and reason. It feeds `progress_kept`. A rollback removes events after the rollback point, PRUNE closes the ledger along with the branch, and EVOLVE in place leaves it alone.

### Who sees BSR output

No other agent sees any BSR data except the Strategy Generator and Strategy Proximity Reviewer, which get the decisions and event reasons in `<ConsolidatedBsrDecisions>` (and `State-Synthesis-For-Modules`, which receives a concise summary of the slot decisions in its `<HarnessNote>`).

## What every agent receives

This section lists the prompt of every agent call in the order its parts appear. It is written from the prompt builders in `contextBuilders.ts`, the notes in `harnessNotes.ts`, and the call sites in `pipelineOrchestrator.ts`.

### How a prompt is put together

Each call has a system instruction and a user prompt. The system instruction is the agent's own prompt, taken from the prompt editor and falling back to the default. The user prompt is built from the templates in this section at the moment of the call, from the run's current state.

| Agent | Registry key | System prompt key | Output | Working directory |
|---|---|---|---|---|
| Strategy Generator | `initialStrategy` | `sys_deepthink_initialStrategy` | JSON | none, read-only |
| Strategy Proximity Reviewer | `initialStrategy` | `sys_deepthink_initialStrategy` | text | none, read-only |
| Modules Generator | `modulesGeneration` | `sys_deepthink_modulesGeneration` | JSON | none, read-only |
| Modules Impact Reviewer | `modulesGeneration` | `sys_deepthink_modulesGeneration` | text | none, read-only |
| Modules Building | `modulesBuilding` | `sys_deepthink_modulesBuilding` | text | `Modules/Heartbeat-H/Module-M/` |
| Execution Agent | `executionAgent` | `sys_deepthink_executionAgent` | text | `Strategy-N/` |
| Critique Agent | `critiqueAgent` | `sys_deepthink_critiqueAgent` | text | `Strategy-N/` |
| Memory Bank | `memoryBank` | `sys_deepthink_memoryBank` | text | `Strategy-N/` (read-only) |
| State Synthesis | `stateSynthesis` | `sys_deepthink_stateSynthesis` | JSON | none, read-only |
| BSR | `bsr` | `sys_deepthink_bsr` | JSON | `Strategy-N/` (read-only) |

With sandbox tools off, the prompt goes to the model directly, with JSON mode for the JSON agents and the configured thinking level. With sandbox tools on, the same prompt goes in as the user message to a tool-using agent that has the system prompt, full repository read access, read/write access to `/tmp/`, and the `shared_workspace` tool.

**`{challenge}`.** Every prompt starts from the same challenge text, built once when the run starts:

```text
{text the user typed}

Direct context files:

--- {file name} ---
{decoded text}
--- end file ---
                                      (one block per text or JSON file, in upload order)

<!-- EXECUTION_IMAGE_START -->
<!-- MIME_TYPE: {mime type} -->
{base64 data}
<!-- EXECUTION_IMAGE_END -->
                                      (one block per image, after all text files)
```

Before a prompt is sent, each image block is cut out of the text and sent as an image at that position. The model therefore sees the challenge text and files, then the images, then whatever the prompt contains after the challenge. All user-uploaded files are also written to `user_uploaded/` inside the run repository.

**Labeled blocks.** A block written as `<Label>` ... `</Label>` is built as the label, a newline, the content with surrounding whitespace removed, a newline, and the closing label. Empty content becomes `Not available.`.

### State that prompts are built from

Prompts are rebuilt from stored fields every time. Nothing is carried over inside a prompt from an earlier call, except where a history is listed below.

| Stored field | Set when | Replaced or added to | Read by |
|---|---|---|---|
| Strategy text | Seed; EVOLVE; PRUNE | Replaced | Everything that names the branch's strategy |
| First solution | Iteration 1, and a replacement branch's first execution | Set once per branch | Fallback when there is no latest solution |
| Latest solution | Iteration 1, then every Execution Agent call | Replaced | Peers' context, State Synthesis, Modules Generator & Impact Reviewer, Strategy Generator & Proximity Reviewer |
| Latest critique | Every Critique Agent call | Replaced | Peers' context, State Synthesis |
| Iteration history | After the critique of each iteration | Added to | History windows, BSR, Memory Bank |
| Memory bank | Each Global Update distillation | Replaced | History window of Execution Agent and Critique Agent, BSR, next Memory Bank |
| Heartbeat blocks & module exchanges | End of each Global Update (when modules on) | Added to | Execution Agents read only the newest mapped packet. `State-Synthesis-For-Modules` reads the previous block. Modules Generator & Impact Reviewer read the previous block's modules, Modules Building outputs, mapped packets, and realized feedback, plus `<ModulesFinalizedAndUsedSoFar>` and `<CurrentHeartbeatImpactReviewTurns>` |
| Seed strategy exchange | End of seed generation | Set once | Persisted to `strategies_history/` and UI state; within the seed loop, read via `<SeedStrategyProximityTurns>` |
| Update strategy exchanges | After each Global Update's strategy step | Added to | Persisted to `strategies_history/` and UI state; within Global Update $u$, read via `<CurrentGlobalUpdateProximityTurns>` |
| Strategies & modules used so far | Seed; each EVOLVE or new strategy; each Global Update Heartbeat | Added to | Strategy Generator & Proximity Reviewer at every Global Update (`<StrategiesFinalizedAndUsedSoFar>`); Modules Generator & Impact Reviewer at every Heartbeat after the first (`<ModulesFinalizedAndUsedSoFar>`) |
| Standing event ledger | After each Global Update's decisions | Added to (or trimmed on rollback / reset on prune) | BSR |
| State Synthesis outputs | Each `State-Synthesis-For-Strategies` and `State-Synthesis-For-Modules` call | Added to | `State-Synthesis-For-Strategies` feeds Strategy Generator & Proximity Reviewer (`<StateSynthesisForStrategies>`) and `State-Synthesis-For-Modules` (`<StateSynthesisForStrategiesBaseline>`); `State-Synthesis-For-Modules` feeds Modules Generator & Impact Reviewer (`<StateSynthesisCore>`) |

### One branch across a run

`i = 10`, `j = 4` (fixed), modules on, isolation off. Each row shows what the Execution Agent in that iteration receives for one surviving branch.

| Execution Agent in iteration | `<BranchHistoryAndMemory>` contents | Curated context comes from |
|---|---|---|
| 1 | none (initial execution) | none yet |
| 2 | `[Iter 1]` | none yet |
| 3 | `[Iter 1, Iter 2]` | none yet |
| 4 | `[Iter 1 .. Iter 3]` | none yet |
| 5 | `[Iter 4] + bank 1 (iterations 1 to 4)` | Heartbeat 1 (end of Global Update 1, after iter 4) |
| 6 | `[Iter 4] + bank 1 + [Iter 5]` | Heartbeat 1 |
| 7 | `[Iter 4] + bank 1 + [Iter 5, Iter 6]` | Heartbeat 1 |
| 8 | `[Iter 4] + bank 1 + [Iter 5 .. Iter 7]` | Heartbeat 1 |
| 9 | `[Iter 8] + bank 2 (bank 1 merged with 5 to 8)` | Heartbeat 2 (end of Global Update 2, after iter 8) |
| 10 (final) | `[Iter 8] + bank 2 + [Iter 9]` | Heartbeat 2 |

The Critique Agent in iteration `k` ($1 \le k < i$) gets the same history and memory bank as the Execution Agent in iteration `k`, plus that execution itself inside `<Iteration n="k">`. BSR in Global Update 1 sees iterations 1 to 4 and no memory bank; in Global Update 2 it sees iterations 5 to 8 and `bank 1`.

### Stage 1: seed strategies (Strategy Generator & Strategy Proximity Reviewer)

Both **Strategy Generator (SG)** and **Strategy Proximity Reviewer (SP)** share the same system prompt (`initialStrategy`) and receive the **exact same user prompt** prefix at the start of the seed loop, with the active role indicated on the final line (`Immediate Role: Strategy Generator` or `Immediate Role: Strategy Proximity Reviewer`, with JSON output for SG and text output for SP).

When sandbox tools are enabled, SG and SP each maintain their own separate **continuous append-only trajectory** across all rounds of the seed invocation (preserving KV cache and all tool calls from earlier rounds of the seed loop so neither agent repeats prior exploration):
- **SG Round 1** starts with `[Challenge + Count]` + `Immediate Role: Strategy Generator`, executes tool calls, and submits `final_output` (`SG-seed-1`).
- **SP Round 1** starts with `[Challenge + Count]` + `SG-seed-1` + `Immediate Role: Strategy Proximity Reviewer`, executes its own tool calls, and submits `final_output` (`SP-seed-1`).
- **SG Round $r \ge 2$** continues directly from SG's Round $r-1$ conversation trace: the harness resolves SG's previous `final_output` tool call with a tool result containing `SP-seed-(r-1)` and `Immediate Role: Strategy Generator`, after which SG continues with a fresh per-invocation tool-call budget and submits `final_output` (`SG-seed-r`).
- **SP Round $r \ge 2$** continues directly from SP's Round $r-1$ conversation trace: the harness resolves SP's previous `final_output` tool call with a tool result containing `SG-seed-r` and `Immediate Role: Strategy Proximity Reviewer`, after which SP continues and submits `final_output` (`SP-seed-r`).

### Stage 2: iteration 1

All branch Execution Agents finish first. Then all Critique Agents run in parallel.

**Execution Agent (iteration 1).**

```text
# Core Challenge
{challenge}

Assigned Strategy: main1
{strategy text}

Produce iteration 1 solution attempt.
```

The initial execution does not see the other strategies. The output is stored as both the first solution and the latest solution.

**Critique Agent (iteration 1).**

```text
# Core Challenge
{challenge}

Assigned Strategy ID: main1
Assigned Strategy Text: {strategy text}

<BranchHistoryAndMemory>
<WindowCorrectionCritiqueHistory>
<Iteration n="1">
<Correction>
{the first solution}
</Correction>
</Iteration>
</WindowCorrectionCritiqueHistory>
</BranchHistoryAndMemory>
```

After the critique finishes, the critique is recorded on iteration 1 in the branch's history and becomes the latest critique.

### Stage 3: iterations 2 to i

In iterations $2 \dots i-1$, all branch Execution Agents finish first, and then all Critique Agents run in parallel. In final iteration $i$, only the branch Execution Agents run.

**Execution Agent (iterations 2 to i).**

```text
# Core Challenge
{challenge}

Assigned Strategy ID: main1
Assigned Strategy Text: {current strategy text}

<BranchHistoryAndMemory>
{history, below}
</BranchHistoryAndMemory>

<CrossStrategyPeerIntelligence>           only when isolation is off and other branches exist
{peers, below}
</CrossStrategyPeerIntelligence>
```

**History.** Built for the Execution Agent and the Critique Agent as follows (with `<LatestCustomCuratedContext>` included only for the Execution Agent when a mapped packet exists):

```text
<Iteration n="4">                         only after a Global Update (the last retained pair before the update)
<Correction>
{solution of iteration 4}
</Correction>
<Critique>
{critique of iteration 4}
</Critique>
</Iteration>

<DistilledMemoryBank>                     only when the branch has a memory bank
{memory bank}
</DistilledMemoryBank>

<LatestCustomCuratedContext>              only in Execution Agent prompts when there is a mapped packet
{the branch's module packet}
</LatestCustomCuratedContext>

<WindowCorrectionCritiqueHistory>         when completed iterations exist in the current window
<Iteration n="5">
<Correction>
{solution of iteration 5}
</Correction>
<Critique>
{critique of iteration 5}
</Critique>
</Iteration>

<Iteration n="6">
{...}
</Iteration>
</WindowCorrectionCritiqueHistory>
```

- **Which iterations.** For a prompt in iteration `k`, let `w = floor((k - 1) / 4) * 4 + 1` be the first iteration of the current 4-iteration window (1, 5, 9, 13, and so on). In the first window (`w = 1`), `<WindowCorrectionCritiqueHistory>` contains every completed iteration `1 <= n < k`. After a Global Update (`w > 1`), the history starts with the branch's last retained pre-update execution-critique pair (iteration `w - 1`, or the rollback target `last_good_iteration` if the branch underwent `EVOLVE (rollback)`), followed by `<DistilledMemoryBank>`, followed (for Execution Agent calls when a packet exists) by `<LatestCustomCuratedContext>`, followed by `<WindowCorrectionCritiqueHistory>` containing every completed iteration `w <= n < k` in the current window.
- **The memory bank** is the branch's current bank. It is replaced, not accumulated, at each Global Update.
- **Replacement branches** created at a Global Update have no memory bank and start from the initial `Execution > Critique` they ran during that Global Update.

**Packet.** The newest Global Update Heartbeat's modules that were marked for all branches or that target this branch, each as:

```text
Module {id}: {text}
Testing of that Module:
{the Modules Building agent's complete output}

Module {id}: {text}
...
```

**Peers.**

```text
Strategy main2: {strategy text}
<LatestCorrection>
{latest solution of main2}
</LatestCorrection>
<LatestCritique>
{latest critique of main2}
</LatestCritique>

Strategy main3: {strategy text}
...
```

For an Execution Agent in iteration `k`, each peer's latest solution and latest critique are from iteration `k - 1`, captured at the start of the iteration before parallel executions run.

**Critique Agent (iterations 2 to i - 1).** Same template as the iteration 1 Critique Agent, with `<BranchHistoryAndMemory>` above, where `<WindowCorrectionCritiqueHistory>` includes `<Iteration n="k">` at the end containing `<Correction>{the execution that was just written}</Correction>` (with no `<Critique>` tag yet, since that is what the Critique Agent is producing).

### Stage 4: Global Update & Concluding Heartbeat

A Global Update runs after iteration `n` finishes (`Execution > Critique`) whenever `n % 4 === 0` and `n < i`.

**Parallel window evaluation: `State-Synthesis-For-Strategies` and BSR.** Both read the state after the critique of iteration `n`, before any decision is applied.

`State-Synthesis-For-Strategies`:

```text
# Core Challenge
{challenge}

# State Synthesis - Global Update (State-Synthesis-For-Strategies)
<HarnessNote>
{STATE_SYNTHESIS_FOR_STRATEGIES_NOTE}
</HarnessNote>

<ActiveBranchesState>
### Branch main1
Strategy: {strategy text}

Latest Correction:
{latest solution}

Latest Critique:
{latest critique}

### Branch main2
...
</ActiveBranchesState>
```

BSR, one call per branch:

```text
# Core Challenge
{challenge}

Branch ID: main1
Current Strategy: {strategy text}

<StandingEventLedger>
[Iter 2] PROGRESS (large): {reason}
[Iter 4] REGRESSION (large): {reason}
</StandingEventLedger>

<MemoryBankBeforeWindow>
{memory bank, or "None available."}
</MemoryBankBeforeWindow>

<WindowCorrectionCritiqueHistory>
Iteration 5:
Correction: {solution of iteration 5}
Critique: {critique of iteration 5}

Iteration 6:
Correction: {...}
Critique: {...}
</WindowCorrectionCritiqueHistory>
```

**Deterministic BSR scoring.** The harness computes `CONTINUE`, `EVOLVE (in_place)`, `EVOLVE (rollback)`, or `PRUNE` for each branch.

**Strategy Generator & Strategy Proximity Reviewer (Global Update $u$).** Runs when at least one branch is `EVOLVE` or `PRUNE`.

- **`[GU-u Context]`**:
  1. `<CurrentActiveStrategies>`: Current actual strategies (`main1`…`mainN`) + latest execution from every branch
  2. `<ConsolidatedBsrDecisions>`: Every branch's decision (`CONTINUE`, `EVOLVE (in_place)`, `EVOLVE (rollback to iteration N / window start)`, or `PRUNE`) + event reasons from the window
  3. `<StateSynthesisForStrategies>`: `core_synthesis` from `State-Synthesis-For-Strategies` for Global Update $u$
  4. `<StrategiesFinalizedAndUsedSoFar>`: Ledger of every strategy actually finalized and executed so far

**Repository rollout commit.** Rolled-back folders are restored from their target commit (`last_good_iteration` or `window_start`), and their iteration history, standing event ledger, and active solution/critique fields are restored to that checkpoint. Pruned folders are archived into `Pruned_Strategies/` and their iteration history and memory bank are cleared. `State_Synthesis_history/State_Synthesis_global_update_XX_for_strategies.md` (+ `.jsonl`), the Global Update strategy revision histories, `strategies_finalized_and_used_so_far.md`, and all updated `Strategy-N/strategy.md` files are then committed together in a single `"Global Update U: State-Synthesis-For-Strategies, strategy updates, and rollout"` commit, which also records the `window_start` commit for the upcoming window.

**Parallel Memory Bank distillation and replacement branch `Execution > Critique`.**

Memory Bank, once per surviving branch (`CONTINUE`, `EVOLVE in place`, or `EVOLVE with rollback`):

```text
# Core Challenge
{challenge}

Branch ID: main1

Strategy Text: {strategy text, after this update's changes}

Previous Memory Bank:
{memory bank}                         or "No previous memory bank."

Window History:
Iteration 5:
Correction: {solution of iteration 5}
Critique: {critique of iteration 5}

Iteration 6:
...
```

- The iterations are `n - 3` through `n` for `CONTINUE` and `EVOLVE in place`, or `n - 3` through `last_good_iteration` when the branch underwent `EVOLVE with rollback`. When a branch rolled back to `window_start`, no Memory Bank call is made and the old bank stays.
- The result replaces the stored memory bank, is written to `Strategy-N/history/memory_bank_NN.md` (+ `.jsonl`), and is immediately committed for that branch (`"Commit Strategy-N memory bank at Global Update U"`).

Replacement branch, initial Execution Agent + Critique Agent (in parallel with surviving branches' Memory Bank distillation):

```text
# Core Challenge
{challenge}

Assigned Strategy: main4
{new strategy text}

First execution for replacement branch in slot main4.
```

Then its Critique Agent runs using `<WindowCorrectionCritiqueHistory>` holding `<Iteration n="{n}"><Correction>{first execution}</Correction></Iteration>`. Once the critique completes, the pair is stored as iteration `n` and committed for that branch (`"Commit Strategy-N at iteration X"`).

**`State-Synthesis-For-Modules` (when `modulesCount > 0`).**

```text
# Core Challenge
{challenge}

# State Synthesis - Global Update (State-Synthesis-For-Modules)
<HarnessNote>
{buildStateSynthesisForModulesNote(slotDecisions)}
</HarnessNote>

<StateSynthesisForStrategiesBaseline>
{the complete State-Synthesis-For-Strategies output as pretty JSON}
</StateSynthesisForStrategiesBaseline>

<PreviousHeartbeatModulesAndTests>
[
  {
    "module_id": "{id}",
    "text": "{text}",
    "target_branches": ["main1", "main3"],
    "testing_output": "{the Modules Building agent's complete output}"
  }
]
</PreviousHeartbeatModulesAndTests>

<SurvivingAndNewBranchesState>
### Branch main1
Strategy: {strategy text after the update}

Latest Correction:
{latest solution}

Latest Critique:
{latest critique}

### Branch main4
{...}
</SurvivingAndNewBranchesState>
```

**Modules Generator, Modules Impact Reviewer, and Parallel Modules Building (when `modulesCount > 0`).**

Both **Modules Generator (MG)** and **Modules Impact Reviewer (MIR)** share the same system prompt (`modulesGeneration`) and receive the same user prompt prefix, with the active role indicated on the final line (`Immediate Role: Modules Generator` or `Immediate Role: Modules Impact Reviewer`).
- During Heartbeat 1 (at Global Update 1), `[HB-1 Context]` includes `<CurrentActiveStrategies>` and `<StateSynthesisCore>` from `State-Synthesis-For-Modules`.
- During Heartbeat $h \ge 2$ (at Global Update $u \ge 2$), `[HB-h Context]` includes:
  1. `<PreviousHeartbeatModulesAndTests>`: Final generated module objects from Heartbeat $h-1$ + corresponding independent Modules Building outputs
  2. `<MappedBranchPackets>`: Schema showing current running strategies `main1`…`mainN`, their latest executions, and which modules from Heartbeat $h-1$ were mapped to which branches
  3. `<RealizedModuleFeedback>`: Realized module feedback for Heartbeat $h-1$ (`observed_test_outcome`, `utilization` vector `[C/T, P/T, N/T, M/T]`, and `critique_counterevidence`)
  4. `<ModulesFinalizedAndUsedSoFar>`: Ledger of every module finalized and built across prior heartbeats (`Modules/modules_finalized_and_used_so_far.md`)
  5. `<StateSynthesisCore>`: `core_synthesis` from `State-Synthesis-For-Modules` for Heartbeat $h$

Once MG finalizes the modules JSON, each module is dispatched in parallel to a **Modules Building** agent:

```text
# Core Challenge
{challenge}

Assigned Module {id}:
{module text}

Test this module within your assigned folder.
```

Finally, `State_Synthesis_history/State_Synthesis_global_update_XX_for_modules.md` (+ `.jsonl`), realized `feedback.json` updates on the previous heartbeat's modules, and the new heartbeat's `Modules/Heartbeat-H/` generation transcripts and `Module-M/` folders are committed together in a single `"Global Update U: State-Synthesis-For-Modules & Curated Context Heartbeat H"` commit.

### Stage 5: final iteration

Iteration `i` uses the exact same Stage 3 Execution Agent template and context as iterations `2` to `i-1`, including `<LatestCustomCuratedContext>` when a Global Update Heartbeat has run. In iteration `i`, only the branch Execution Agents run (no Critique Agents or Global Updates run), and the pipeline completes once all branch executions finish.

## Repository

Prompts carry the curated context: the memory bank and recent history. The repository holds everything else, so an agent late in a long run can still open any file and see what was tried, what failed, and what has not been touched.

### Layout

Each run operates in a single Git repository located at `Results/deepthink_<timestamp>/` (mounted inside sandboxed agent containers at `/workspace`).

```text
Results/deepthink_<timestamp>/
├── latest.gz                        live compressed run state checkpoint, excluded from git commits
├── shared_workspace.md              live document (≤ 5,000 tokens), excluded from git commits
├── tmp/                             shared R/W scratch & verification harnesses, excluded from git commits
├── user_uploaded/                   copies of the files the user attached
├── State_Synthesis_history/         one .md + .jsonl pair per State Synthesis call
│   ├── State_Synthesis_global_update_01_for_strategies.md (+ .jsonl)
│   └── State_Synthesis_global_update_01_for_modules.md    (+ .jsonl)
├── strategies_history/
│   ├── seed_strategies.md                            (+ .jsonl continuous generator trajectory)
│   ├── seed_strategies_proximity_review.md           (+ .jsonl continuous reviewer trajectory)
│   ├── strategies_global_update01.md                 (+ .jsonl continuous generator trajectory)
│   ├── strategies_global_update01_proximity_review.md (+ .jsonl continuous reviewer trajectory)
│   └── strategies_finalized_and_used_so_far.md
├── Modules/
│   ├── modules_finalized_and_used_so_far.md
│   ├── Heartbeat-1/
│   │   ├── generation_history.md                     (+ .jsonl continuous generator trajectory)
│   │   ├── modules_impact_review_history_heartbeat_01.md (+ .jsonl continuous reviewer trajectory)
│   │   ├── Module-1/                                 module.md (+ .jsonl), built/tested files, feedback.json
│   │   └── Module-2/
│   └── Heartbeat-2/
├── Pruned_Strategies/               for example Strategy-1_pruned_01/
├── Strategy-1/
│   ├── strategy.md
│   ├── solution files
│   ├── iterations/
│   │   └── iteration_01.md          execution and critique
│   └── history/
│       ├── iteration_01.jsonl       raw agent trajectory for iteration 1
│       └── memory_bank_01.md        one per memory bank (+ memory_bank_01.jsonl)
└── Strategy-2/
```

File numbers in `history/` are global iteration numbers. Every agent invocation that writes a durable `.md` output file is accompanied in the same directory by a `.jsonl` file containing the raw agent trajectory for that invoke. Heartbeat folders are never deleted.

### Git

The repository has one git branch and one working tree. Every strategy folder, the heartbeat folders, and the strategy histories sit side by side. All branches run in parallel, and each agent writes in its own folder while reading everyone else's, so every folder needs to be on disk at once. Restoring one folder from an earlier commit does not affect the others, because no file is shared between strategies.

Only the harness uses git. Agents can read history but cannot commit or restore. The harness runs git operations one at a time, always when no agent is writing, so a commit never captures a half-written file. `shared_workspace.md` and `tmp/` are untracked via git exclude / `.gitignore`.

Commits are consolidated into five pause/resume-safe checkpoints:

1. **Initial workspace seed** (`"Initial workspace seed"`): Commits `user_uploaded/` context files when the repository is initialized.
2. **Seed strategies generation** (`"Seed strategies generation"`): Commits `strategies_history/seed_strategies.md` (+ `.jsonl`), `seed_strategies_proximity_review.md` (+ `.jsonl`), `strategies_finalized_and_used_so_far.md`, and the initial `Strategy-N/strategy.md` files, recording the initial `window_start` commit SHA.
3. **Per-branch iteration completion** (`"Commit Strategy-N at iteration X"`): Each branch commits its own `Strategy-N/iterations/iteration_XX.md` and `Strategy-N/history/iteration_XX.jsonl` immediately after completing its `Execution > Critique` pair (or final Execution on iteration `i`). These commits are what an `EVOLVE (rollback)` returns to.
4. **Global Update rollout** (`"Global Update U: State-Synthesis-For-Strategies, strategy updates, and rollout"`): Restores rolled-back folders, archives pruned folders into `Pruned_Strategies/`, writes `State_Synthesis_history/State_Synthesis_global_update_XX_for_strategies.md` (+ `.jsonl`), strategy revision histories, `strategies_finalized_and_used_so_far.md`, and updated `Strategy-N/strategy.md` files, and commits them together as the next window's `window_start`.
5. **Global Update branch states & Curated Context Heartbeat**: Surviving branches commit their distilled `memory_bank_XX.md` (+ `.jsonl`) per folder (`"Commit Strategy-N memory bank at Global Update U"`), replacement branches commit their initial `Execution > Critique` per folder (`"Commit Strategy-N at iteration X"`), and `State-Synthesis-For-Modules` + realized `feedback.json` + Heartbeat modules & Modules Building outputs commit together in a single `"Global Update U: State-Synthesis-For-Modules & Curated Context Heartbeat H"` commit (when `modulesCount > 0`).

### Access

Every agent can read the entire repository and has full read and write access to the shared untracked `tmp/` directory at the repository root (for scratch work, shared verification scripts, and test harnesses). In addition, agents with a dedicated folder write into their own working directory. Nobody writes directly to the repository root or to `.git`.

| Role | Working directory |
|---|---|
| Strategy Generator and Strategy Proximity Reviewer | Repo root, read-only. Read/write in `tmp/` |
| State Synthesis | Repo root, read-only. Read/write in `tmp/` |
| Modules Generator and Modules Impact Reviewer | Repo root, read-only. Read/write in `tmp/` |
| Modules Building | Its own `Modules/Heartbeat-H/Module-M/` folder (read/write), full repository read, and read/write in `tmp/` |
| Execution Agent, Critique Agent | `Strategy-N/` (read/write), full repository read, and read/write in `tmp/` |
| Memory Bank, BSR | `Strategy-N/` (read-only), full repository read, and read/write in `tmp/` |

Agents with sandbox access get three tools: `sandbox_exec`, `shared_workspace`, and `final_output`, plus a runtime-appended `<Virtual Sandbox Tool>` system prompt block describing detected runtimes (Python, Node.js, Lean 4 / Mathlib, Rust, and CLI utilities), mount permissions, and inline file/image marker syntax (`[[image:path|Label]]` and `[[file:path|Label]]`, which expand into inline previews in the UI). `final_output` validates both the role's required output format and its maximum output token cap (5,000 tokens for Strategy Generator, Strategy Proximity Reviewer, Modules Generator, Modules Impact Reviewer, State Synthesis, BSR, Critique Agent, and Modules Building; 10,000 tokens for Execution Agent and Memory Bank).

### Shared workspace

Every agent gets the `shared_workspace` tool with three actions: `read`, `edit` (targeted `old_string` $\to$ `new_string` replacement with optional `replace_all`), and `append`. Targeted edits update specific sections in place while preserving peer notes across the file. `shared_workspace.md` is capped at 5,000 tokens.

## Failures and retries

- **Retries.** Transient provider errors and failed output validation checks are retried with backoff (`1m`, `3m`, `5m` for provider retries, and up to 4 attempts with `30s`, `60s`, `5m` waits for orchestrator format/contract retries), with a rolling 5-minute silence watchdog on streaming turns.
- **Pausing on unrecovered failure.** If an agent call exhausts its retries, the orchestrator pauses the pipeline (`status = 'stopped'`), preserving the latest checkpoint in `latest.gz` so the run can be resumed without losing completed work.
- **Format checks.** Every structured output is checked before it is used. A failed check is retried, and a partly valid output is never applied.

## Saving and resuming

The run's settings and prompts are fixed when it starts. A snapshot of the run, `latest.gz`, is written into the run's repository whenever the state changes, and it carries the state version.

Resuming rebuilds the orchestrator from the saved state and skips whatever is done: seed strategies that exist, and iterations where every branch has a history entry and where the Global Update that followed is recorded.

## Interface

| Tab | Shows |
|---|---|
| Branches | Active strategies and each branch's execution, critique, and memory bank history |
| Curated Context | Modules Generator and Impact Reviewer history, Global Update Heartbeats, which branches each module was mapped to, Modules Building results, and feedback |
| Live | Each agent's lifecycle, prompts, responses, traces, retries, and failures |
| Filesystem | The run's repository |

The prompt editor lists these 8 configurable agent roles: Strategy Generator, Modules Generator, Modules Building, Execution Agent, Critique Agent, Memory Bank, State Synthesis, and BSR.

## Code map

| Module | Responsibility |
|---|---|
| `pipelineOrchestrator.ts` | The run loop, each iteration phase, unified Global Updates & Heartbeats, retries, and `GitRepositoryHarness` commits/rollbacks/pruning |
| `deepthinkCore.ts` | Starting and resuming a run, reading settings, saving snapshots, and assembling the challenge from attached files |
| `formulas.ts` | BSR window scoring, pressures, and decisions; module utilization |
| `contextBuilders.ts` | The prompt contents for each agent, and conversion of image blocks |
| `harnessNotes.ts` | The notes added to the Strategy Generator, Modules Generator, and State Synthesis (`State-Synthesis-For-Strategies` and `State-Synthesis-For-Modules`) |
| `agentRegistry.ts` | Each agent's label, sandbox role, system prompt key, and model key |
| `sharedWorkspace.ts` | The `shared_workspace` tool and its live document |
| `types.ts` | Types for settings, branches, modules, BSR, State Synthesis, heartbeats, loop scheduling, and run state |
