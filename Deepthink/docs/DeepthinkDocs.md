# Deepthink

Deepthink tackles a hard challenge by running several different strategies side by side. Each strategy lives in its own branch. In every iteration each branch writes or improves a solution and has it critiqued, and all branches finish the iteration before any of them moves on. Every few iterations the system looks at how each branch has been trending and decides whether to keep it, change its strategy, or replace it. At the end, a judge picks the best solution among the surviving branches.

One kind of supporting evidence can be added along the way, and it is optional: modules that are tested by dedicated tester agents. The pipeline is the same on every run. Settings change the number of branches, the length of the run, and which optional agents take part.

## Terms

| Term | Meaning |
|---|---|
| Branch, slot | One strategy and everything built on it. Branches are named `main1` to `mainN`. The name belongs to the slot, so replacing a branch's strategy text or the whole branch keeps the name. |
| Iteration | One round in which every branch advances once. |
| Window | The `j` iterations between two global updates. |
| Global update | Runs every `j` iterations. Scores each branch, then keeps it, rewrites its strategy, or replaces it. |
| Heartbeat | Runs every `k` iterations. Refreshes the evidence that corrections read. |
| Curated context | That evidence: tested modules prepared per branch. |
| DOS | Dissected Observations Synthesis. An agent that summarizes where every branch stands. |
| BSR | Branch State Representation. An agent that reports what changed in a branch during a window. |

## Principles

- A branch name is also its folder, `Strategy-N`. Rewriting a strategy never changes the name.
- No agent decides what happens to a branch. BSR describes the window, and fixed formulas turn that report and the standing event ledger into a decision.
- Iteration numbers count from the start of the run for every branch. A replacement branch created after iteration 10 records its first solution as iteration 10 and its first correction as iteration 11.
- Modules are optional. The run works without them.

## Configuration

| Setting | Meaning | Range | Default |
|---|---|---|---|
| `i` | Total iterations | 5 to 20 | 10 |
| `j` | Iterations between global updates | 3 to 8 | 5 |
| `k` | Iterations between heartbeats | 2 to `j` | 3 |
| `strategiesCount` | Number of branches | 1 to 5 | |
| `strategyProximityLoops` | Rounds of strategy generator and proximity review | | |
| `modulesCount` | Modules per heartbeat. 0 turns modules off | | |
| `modulesImpactReviewLoops` | Rounds of Modules Generator and Modules Impact Reviewer | | |
| `isolateBranches` | Correction agents get no information about other branches | | |
| `deepthinkCodeExecutionEnabled` | Gives agents sandbox tools | | |
| `thinkingLevel` | Reasoning effort requested from the provider | | |
| `bsrNoiseLevel` | BSR noise threshold $\tau$ | | 0.05 |
| `bsrPressureFloor` | BSR pressure threshold $\theta$ for `EVOLVE` or `PRUNE` | | 0.20 |
| `bsrWeightSmall` | Weight for `small` confirmed events | | 0.15 |
| `bsrWeightMedium` | Weight for `medium` confirmed events | | 0.30 |
| `bsrWeightLarge` | Weight for `large` confirmed events | | 0.50 |

All bounds are inclusive and a violation is reported as an error. `j` may be larger than `i`: with `i = 5` and `j = 8`, no global update runs.

Modules use the `k` slider, in a panel titled "Customize How Often Curated Context Is Refreshed". If modules are turned off, curated context is off, and `k` is ignored.

`isolateBranches` is enforced through the agents' instructions. Every agent can technically read the whole repository, so isolation depends on the agent following its prompt.

Each agent has an editable system prompt and an optional model override. The override wins over the run's selected model.

## The run loop

```text
Seed strategies
Iteration 1            every branch writes a first solution, then it is critiqued
Iterations 2 to i - 1  every branch corrects its solution, then the correction is critiqued
Iteration i            every branch runs its final correction (no critique); pipeline completes
```

Inside an iteration, all branches run in parallel and the system waits for every one of them to finish. Every iteration from 2 through `i - 1` runs correction and critique with its natural context, and the final iteration `i` runs only the branch corrections. Each surviving strategy branch produces a valid final output. There are no modules before iteration 1, because modules are generated from critiques and DOS synthesis.

After iteration `n` finishes, exactly one of these happens:

1. If `n = i`, the run completes once the final corrections finish. No critique, heartbeat, or global update runs.
2. If `n` is a multiple of `j`, a global update runs. It always ends with a heartbeat, whatever `k` is.
3. Otherwise a counter of iterations since the last heartbeat goes up by one. When it reaches `k` and the heartbeat is worth running, a heartbeat runs and the counter resets. If curated context is off, this step is skipped.

Whatever runs after iteration `n` is what the corrections in iteration `n + 1` and later will read.

**When a heartbeat is worth running.** A heartbeat is read by the corrections that follow it, up to the next global update, which brings a heartbeat of its own. So a heartbeat only runs if it will serve at least two corrections. Let `G` be the next multiple of `j` after `n`. If a global update lies ahead (`G < i`) and `G - n < 2`, the heartbeat is skipped. If no global update lies ahead, it runs. A heartbeat that ends a global update is never skipped. The counter resets after any heartbeat, wherever it ran.

**Example: `i = 15`, `j = 5`, `k = 3`**

| After iteration | What runs |
|---|---|
| 1, 2 | nothing |
| 3 | heartbeat |
| 4 | nothing |
| 5 | global update, then its heartbeat |
| 6, 7 | nothing |
| 8 | heartbeat |
| 9 | nothing |
| 10 | global update, then its heartbeat |
| 11, 12 | nothing |
| 13 | heartbeat |
| 14 | nothing |
| 15 | final iteration (corrections only); run completes |

**Example of a skipped heartbeat: `i = 14`, `j = 6`, `k = 5`.** After iteration 5 the counter reaches `k`, but the global update comes right after iteration 6, so a heartbeat would serve only one correction. It is skipped, and the global update's heartbeat refreshes everything.

## Strategy generation

Strategies come from a generator and a proximity reviewer that take turns. The generator proposes, the reviewer criticizes, and the generator revises, for as many rounds as `strategyProximityLoops` says. The last proposal is used. What each agent receives is listed under What every agent receives.

The reviewer looks for overlap between strategies, variations that are only on the surface, parts of the problem that no strategy covers, and strategies that depend on each other.

**Seed.** The output is the full set:

```json
{ "strategies": ["...", "..."] }
```

The strategies are assigned to `main1` to `mainN` in order.

**Global update.** The generator returns only the slots that are changing, covered in the global update section below.

## Branch work

### Solution attempt

Runs in iteration 1 and for every replacement branch. It writes its solution into `Strategy-N/`.

### Critique

Assesses the solution just produced for correctness, completeness, broken constraints, structural weaknesses, and whether the strategy still looks viable. It does not rewrite the solution.

### Correction

Writes the branch's next complete solution into `Strategy-N/`. When isolation is off, it is expected to open the other branches' directories and learn from them.

### Memory bank

At each global update, every surviving branch gets a new memory bank. The agent merges the previous memory bank with the window's full history. It records what was learned, which failures keep recurring, which repairs were tried, and where the strategy has been heading.

The window is the `j` iterations that end at the update: iterations `n - j + 1` to `n`. After a rollback, only the iterations that remain are used. If none remain, the previous memory bank stays and no new one is written. Nothing is compressed inside a window. Only the memory bank compresses.

## Heartbeat

A heartbeat prepares the evidence that corrections will read when modules are on.

| Modules | Steps |
|---|---|
| on | DOS, modules, tests, mapping |
| off | nothing |

A heartbeat that ends a global update reuses that update's second DOS call instead of running its own (see DOS).

### Modules

A Modules Generator and a Modules Impact Reviewer take turns, as they do for strategies. The reviewer checks that each module can be proven wrong or verified, can be tested alone, and matters to the challenge.

Each module is an object:

```json
{
  "module_id": "m2",
  "text": "A self-contained investigative task or subcomponent that a test can verify or falsify",
  "target_branches": ["main1", "main3"]
}
```

An empty `target_branches` list means the result is useful to every branch.

### Tests

Each module goes to its own tester, and the testers run in parallel. A tester receives the challenge (and any image) and its one module in its prompt, while having full read access across the repository, read and write access to its own `Module-M/` folder and `tmp/`, and access to `shared_workspace`.

A tester ends with a classification line, which is read as `VALIDATED`, `REJECTED`, or `INCONCLUSIVE`.

### Mapping

Each branch gets a packet made of every module marked for all branches plus every module that targets it, each with its full test result. The same selection decides which modules a branch's prompt and sandbox include.

### What a heartbeat produces

For each branch, a packet of mapped module results, which every correction reads until the next heartbeat. The heartbeat also adds a block to the modules history.

## Global update

A global update runs after iteration `n` when `n` is a multiple of `j` and `n < i`.

1. **BSR and the first DOS call run in parallel.** One BSR agent per branch, plus one DOS call that summarizes where every branch stands.
2. **Code decides.** The BSR reports go through the formulas in the BSR section and give each branch one decision: CONTINUE, EVOLVE, or PRUNE.
3. **New strategies.** The strategy generator and proximity reviewer rewrite the slots that need it (below).
4. **The repository is updated.** Pruned branches are archived, branches that are rolling back are restored, and each freed slot gets a fresh folder.
5. **Memory banks and replacements.** In parallel, each surviving branch gets a new memory bank, and each replacement branch writes a first solution and has it critiqued. The system waits for both. Every active strategy folder is then committed as the starting point of the next window.
6. **Second DOS call.** If modules are on, DOS looks at the updated state and produces feedback on the previous heartbeat's modules.
7. **Heartbeat.** It runs whatever `k` is, and its DOS step is the second call from step 6.

The first DOS call runs even when curated context is off, because strategy generation uses it. The second runs only when modules are on.

### Strategy changes

Its inputs are listed under What every agent receives.

It returns only what changes:

```json
{
  "evolved_slots": [{ "slot_id": "main2", "updated_strategy_text": "..." }],
  "pruned_slots":  [{ "slot_id": "main4", "new_strategy_text": "..." }]
}
```

There must be one entry for every EVOLVE slot, one for every PRUNE slot, and none for any other slot. A branch that continues cannot be touched, because the output format has no place for it. For a pruned slot, the generator decides how much of the old strategy to reuse. It may re-aim the same idea, keep the part that worked, or drop it. The strategy text is the only thing a replacement branch inherits.

## DOS

DOS summarizes where the branches stand. It remembers nothing between calls. Each call is built fresh from the stored state.

| Call | When | Output |
|---|---|---|
| Heartbeat DOS | Start of a heartbeat that does not end a global update, modules on | Summary, plus feedback on the last heartbeat's modules if one exists |
| First call in a global update | Step 1 | Summary only. It goes to the strategy generator |
| Second call in a global update | Step 6, modules on | Summary and feedback on surviving branches. It also serves as the DOS for the heartbeat that follows |

After the update, replacement branches appear with only their first solution and critique, and pruned branches are gone. A branch that rolled back has lost its later iterations. DOS can give feedback only on branches that survived, since new branches never received the last heartbeat's results. Each call comes with a note explaining which of these cases applies, and the second call's note lists what happened to each slot. The inputs and notes are listed under What every agent receives.

DOS reports only what it can see. It does not claim that a module caused a decision about a branch. For each module and each branch the module was sent to, it says whether the result was used, and if so whether correctly, partly, or wrongly. It also says whether a later critique gives strong evidence against the tester's verdict.

```json
{
  "core_synthesis": { "...": "the structured summary" },
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

The classifications are `USED_CORRECTLY`, `USED_PARTIALLY`, `NOT_USED`, and `MISUSED`. `critique_counterevidence` can be left out when there is none. `module_feedback` appears only when there is a previous heartbeat to report on.

## Module feedback

When DOS returns feedback, the harness turns it into a record for each module.

**Utilization** is counted over the module-and-branch pairs that DOS could judge. With C, P, N, and M the counts of correct, partial, not used, and misused, and T their total, the result is the vector `[C/T, P/T, N/T, M/T]`. The four numbers are not combined into a single score. If T is 0, the record has no utilization.

```json
{
  "module_id": "m2",
  "observed_test_outcome": "VALIDATED",
  "utilization": { "correct_use": 0.50, "partial_use": 0.25, "not_used": 0.25, "misused": 0.00 },
  "utilization_note": "Calculated from DOS's observations.",
  "critique_counterevidence": [{ "branch_id": "main1", "classification": "STRONG", "reason": "..." }]
}
```

Each record is saved in the matching `Module-M/` folder and kept in the heartbeat's block, together with the generator and reviewer exchange, the final modules, the test results, and the branch packets. The strategy agents never see utilization or counterevidence.

## BSR

### What it does

BSR does not judge whether a branch's answer is correct. Confidence in an answer, an exhausted critique, and an answer that looks complete all count as no evidence of truth, since a branch can be firmly stuck in a wrong answer. BSR serves one question: is another window on this branch's strategy worth the compute?

It does not answer that question itself. It reports what changed during the window and how directly the corrections followed the critiques, and code answers the question from the observed window and the branch's standing event ledger.

A branch can run out of value in two ways. In failure, it is stuck, getting worse, or repeating the same unresolved problems. In saturation, the strategy has given what it can, and another window would add little whether or not the answer is right. Progress that is already standing protects a branch from being pruned. A failing branch is released, and a saturated one gets a new strategy.

BSR runs once per branch at each global update, in parallel, and judges the whole window as a single trajectory. It never outputs an action.

### The report

```json
{
  "branch_id": "main2",
  "confirmed_progress":   [{ "iteration": 6, "size": "large", "reason": "..." }],
  "confirmed_regression": [{ "iteration": 9, "size": "large", "reason": "..." }],
  "critique_alignment": { "value": 0.6, "reason": "..." }
}
```

An **event** is a change placed at the iteration whose correction caused it, with a size:

- `small`: a local change with little consequence
- `medium`: a change that matters for correctness or completeness
- `large`: a change that alters the validity or structure of the answer

BSR gives only these sizes and never a number. A branch's first solution is the baseline of its window and carries no events.

An event counts only when something besides the correction's own claim supports it. For progress, that means a critique from the same or a later iteration agrees the issue is resolved, or a sandbox run shows it. For regression, the same kinds of evidence show a defect that was absent before, or one that had been fixed and came back.

`critique_alignment` runs from -1 to 1. At 1, every point in the critiques was taken up by the next correction. At -1, the corrections went against them. It keeps a branch whose corrections ignored the critiques from being blamed on its strategy. Negative values are treated as 0.

### Scoring the window

These parameters have default values in `formulas.ts` and can be overridden in `DeepthinkRunConfig`.

| Parameter | Default | Role |
|---|---|---|
| Size weights | small 0.15, medium 0.30, large 0.50 | Convert event sizes to movement |
| Noise level τ | 0.05 | Smallest net change that counts as a trend |
| Pressure floor θ | 0.20 | Smallest pressure that can trigger EVOLVE or PRUNE |

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

Stall evidence measures how strongly the observed window indicates that another window on the current strategy will produce nothing: it combines lack of positive drift in the window with corrections that faithfully followed the critiques. Pressures run from 0 to 1 and do not sum to 1.

The decision for each branch follows three rules in order:

1. If the EVOLVE and PRUNE pressures are both below θ, the branch continues.
2. Otherwise, if the CONTINUE pressure is at least as high as both, the branch continues.
3. Otherwise the higher of EVOLVE and PRUNE wins. Ties go to the less destructive action: CONTINUE, then EVOLVE, then PRUNE.

For EVOLVE, the form is rollback when `lost_ground > stall_evidence * progress_kept`, and in place otherwise. A tie goes to in place.

In practice, a branch that started well and then regressed gets EVOLVE with rollback. A branch that stalled with little progress standing gets PRUNE. A branch that stalled with substantial progress standing gets EVOLVE in place, and its solution stays a candidate for the final answer.

**Worked example.** Events: iteration 6 large progress, 7 small progress, 9 large regression, 10 large regression (with weights 1, 2, 4 and $\tau = 2$, $\theta = 0.30$). The running total is 4, 5, 5, 1, -3, so `net` is -3, `movement` is 13, the outcome is REGRESS, and `last_good_iteration` is 8. Lost ground is 8 / 15 = 0.533, `drift` is -3 / 15 = -0.20, and with `critique_alignment = 0.6`, `stall_evidence` is 0.60. With `progress_kept` at 3 / 23 = 0.130, the EVOLVE pressure is 0.533, PRUNE is 0.243, and CONTINUE is 0. The decision is EVOLVE with rollback to iteration 8.

### What each decision does

- **CONTINUE.** Nothing changes. The branch carries on from its new memory bank.
- **EVOLVE in place.** The strategy text is rewritten. History, memory, and the ledger stay as they are.
- **EVOLVE with rollback.** The branch's folder is restored to the end of `last_good_iteration`. The later iterations leave the folder but remain in git history. The ledger loses the discarded events and keeps the rest. The new strategy text tells the model where not to go. For long-running tasks, restoring is much better than rewriting the strategy and continuing from a memory of a bad trajectory.
- **PRUNE.** The branch is stopped and archived and its slot is freed. A new branch takes the slot with a new strategy, runs a first solution and critique, and starts with an empty ledger. Nothing the old branch produced reaches the new one except what the strategy generator chooses to carry into the new strategy text.

### Standing event ledger

The standing event ledger is stored per branch and carried from one global update to the next. It lives outside the repository, along with every BSR report, its computed values, and its decision.

- **The ledger** lists every confirmed event still standing, with its iteration, direction, size, weight, and reason. It feeds `progress_kept`. A rollback removes events after the rollback point, PRUNE closes the ledger along with the branch, and EVOLVE in place leaves it alone.

### Who sees BSR output

No other agent sees any BSR data except the strategy generator, which gets the decisions and event reasons described in Global update.

## What every agent receives

This section lists the prompt of every agent call in the order its parts appear. It is written from the prompt builders in `contextBuilders.ts`, the notes in `harnessNotes.ts`, and the call sites in `pipelineOrchestrator.ts`.

### How a prompt is put together

Each call has a system instruction and a user prompt. The system instruction is the agent's own prompt, taken from the prompt editor and falling back to the default. The user prompt is built from the templates in this section at the moment of the call, from the run's current state.

| Agent | System prompt | Output | Working directory |
|---|---|---|---|
| Strategy generator | `initialStrategy` | JSON | none, read-only |
| Strategy proximity (seed and update) | `initialStrategy` | text | none, read-only |
| Modules Generator | `modulesGeneration` | JSON | none, read-only |
| Modules Impact Reviewer | `modulesGeneration` | text | none, read-only |
| Modules Tester | `modulesTester` | text | `Module-M/` |
| Solution attempt | `solutionAttempt` | text | `Strategy-N/` |
| Critique | `solutionCritique` | text | `Strategy-N/` |
| Correction | `solutionCorrection` | text | `Strategy-N/` |
| Memory bank | `memoryBank` | text | `Strategy-N/` (read-only) |
| DOS | `dos` | JSON | none, read-only |
| BSR | `bsr` | JSON | `Strategy-N/` (read-only) |

With sandbox tools off, the prompt goes to the model directly, with JSON mode for the JSON agents and the configured thinking level. With sandbox tools on, the same prompt goes in as the user message to a tool-using agent that has the system prompt, full repository read access, read/write access to `/tmp/`, and the `shared_workspace` tool. The thinking level is not passed in that mode.

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

**Spacing.** The templates below show one blank line between parts. Some builders join their parts with a double newline and also have empty parts, which makes the real gap wider in places. Content and order are exactly as shown.

### State that prompts are built from

Prompts are rebuilt from stored fields every time. Nothing is carried over inside a prompt from an earlier call, except where a history is listed below.

| Stored field | Set when | Replaced or added to | Read by |
|---|---|---|---|
| Strategy text | Seed; EVOLVE; PRUNE | Replaced | Everything that names the branch's strategy |
| First solution | Iteration 1, and a replacement branch's first execution | Set once per branch | Fallback when there is no latest solution |
| Latest solution | Iteration 1, then every correction | Replaced | Peers' context, DOS, Modules Generator and Modules Impact Reviewer, strategy generator and proximity |
| Latest critique | Every critique | Replaced | Peers' context, DOS |
| Iteration history | After the critique of each iteration | Added to | History windows, BSR, memory bank |
| Memory bank | Each distillation | Replaced | History window of correction and critique, BSR, next memory bank |
| Heartbeat blocks & module exchanges | End of each heartbeat | Added to | Corrections read only the newest mapped packet. DOS reads the previous block. Modules Generator and Modules Impact Reviewer read the reframed history of all prior heartbeats plus the previous block's modules, test outputs, mapped packets, realized feedback, and the ledger of modules finalized and used so far |
| Seed strategy exchange | End of seed generation | Set once | Strategy generator and proximity at every update |
| Update strategy exchanges | After each update's strategy step | Added to | Strategy generator and proximity at later updates (with prior update contexts replaced by reframed notes) |
| Strategies & modules used so far | Seed; each EVOLVE or new strategy; each heartbeat | Added to | Strategy generator/proximity at every update (`StrategiesFinalizedAndUsedSoFar`); Modules Generator / Modules Impact Reviewer at every heartbeat after the first (`ModulesFinalizedAndUsedSoFar`) |
| Standing event ledger | After each update's decisions | Added to (or trimmed on rollback / reset on prune) | BSR |
| DOS outputs | Each DOS call | Added to | Step-i feeds strategy generator/proximity and step-ii; Heartbeat DOS and step-ii DOS feed Modules Generator / Modules Impact Reviewer |

### One branch across a run

`i = 15`, `j = 5`, `k = 3`, modules on, isolation off. Each row shows what the correction in that iteration receives for one surviving branch.

| Correction in iteration | `<BranchHistoryAndMemory>` contents | Curated context comes from |
|---|---|---|
| 2 | `[Iter 1]` | none yet |
| 3 | `[Iter 1, Iter 2]` | none yet |
| 4 | `[Iter 1 .. Iter 3]` | heartbeat 1 (after iteration 3) |
| 5 | `[Iter 1 .. Iter 4]` | heartbeat 1 |
| 6 | `[Iter 5] + bank 1 (iterations 1 to 5)` | heartbeat 2 (end of update 1) |
| 7 | `[Iter 5] + bank 1 + [Iter 6]` | heartbeat 2 |
| 8 | `[Iter 5] + bank 1 + [Iter 6, Iter 7]` | heartbeat 2 |
| 9 | `[Iter 5] + bank 1 + [Iter 6 .. Iter 8]` | heartbeat 3 (after iteration 8) |
| 10 | `[Iter 5] + bank 1 + [Iter 6 .. Iter 9]` | heartbeat 3 |
| 11 | `[Iter 10] + bank 2 (bank 1 merged with 6 to 10)` | heartbeat 4 (end of update 2) |
| 12 | `[Iter 10] + bank 2 + [Iter 11]` | heartbeat 4 |
| 13 | `[Iter 10] + bank 2 + [Iter 11, Iter 12]` | heartbeat 4 |
| 14 | `[Iter 10] + bank 2 + [Iter 11 .. Iter 13]` | heartbeat 5 (after iteration 13) |
| 15 (final) | `[Iter 10] + bank 2 + [Iter 11 .. Iter 14]` | heartbeat 5 |

The critique in iteration `k` gets the same history and memory bank as the correction in iteration `k`, plus that correction itself. BSR in update 1 sees iterations 1 to 5 and no memory bank. In update 2 it sees iterations 6 to 10 and bank 1. The Modules Generator in heartbeats 1, 3, and 5 uses a heartbeat DOS. In heartbeats 2 and 4 it uses the DOS call that ended the update.

### Stage 1: seed strategies (Strategy Generator & Strategy Proximity)

Both **Strategy Generator (SG)** and **Strategy Proximity (SP)** share the same system prompt (`initialStrategy`) and receive the **exact same user prompt** prefix at the start of the seed loop, with the active role indicated on the final line (`Immediate Role: Strategy Generator` or `Immediate Role: Strategy Proximity Reviewer`, with JSON output for SG and text output for SP).

When sandbox tools are enabled, SG and SP each maintain their own separate **continuous append-only trajectory** across all rounds of the seed invocation (preserving KV cache and all tool calls from earlier rounds of the seed loop so neither agent repeats prior exploration):
- **SG Round 1** starts with `[Challenge + Count]` + `Immediate Role: Strategy Generator`, executes tool calls, and submits `final_output` (`SG-seed-1`).
- **SP Round 1** starts with `[Challenge + Count]` + `SG-seed-1` + `Immediate Role: Strategy Proximity Reviewer`, executes its own tool calls, and submits `final_output` (`SP-seed-1`).
- **SG Round $r \ge 2$** continues directly from SG's Round $r-1$ conversation trace: the harness resolves SG's previous `final_output` tool call with a tool result containing `SP-seed-(r-1)` and `Immediate Role: Strategy Generator`, after which SG continues with a fresh per-invocation tool-call budget and submits `final_output` (`SG-seed-r`).
- **SP Round $r \ge 2$** continues directly from SP's Round $r-1$ conversation trace: the harness resolves SP's previous `final_output` tool call with a tool result containing `SG-seed-r` and `Immediate Role: Strategy Proximity Reviewer`, after which SP continues and submits `final_output` (`SP-seed-r`).
- Continuous trajectories live only for the current Seed invocation and do not carry over into Global Updates. When sandbox tools are disabled, each turn runs directly with the accumulated `<SeedStrategyProximityTurns>` block in the prompt.

- **`[Challenge + Count]`**:
  ```text
  # Core Challenge
  {challenge}

  Requested Number of Strategies: {strategiesCount}
  ```

With `strategyProximityLoops = L`, there are `L + 1` generator turns and `L` proximity review turns. Below is the exact chronological order of what each turn receives (for `L = 2`):

- **SG — Turn 1:**
  1. `[Challenge + Count]`
  2. `Immediate Role: Strategy Generator`
- **SP — Turn 1:**
  1. `[Challenge + Count]`
  2. `SG-seed-1`
  3. `Immediate Role: Strategy Proximity Reviewer`
- **SG — Turn 2:**
  1. `[Challenge + Count]`
  2. `SG-seed-1`
  3. `SP-seed-1`
  4. `Immediate Role: Strategy Generator`
- **SP — Turn 2:**
  1. `[Challenge + Count]`
  2. `SG-seed-1`
  3. `SP-seed-1`
  4. `SG-seed-2`
  5. `Immediate Role: Strategy Proximity Reviewer`
- **SG — Turn 3 (Final Seed Output):**
  1. `[Challenge + Count]`
  2. `SG-seed-1`
  3. `SP-seed-1`
  4. `SG-seed-2`
  5. `SP-seed-2`
  6. `Immediate Role: Strategy Generator`

When `SG — Turn 3` outputs `SG-seed-3`, the harness extracts the strategies as `main1`…`mainN` and stores the full 5-turn transcript `[Seed G↔P]`.

### Stage 2: iteration 1

All attempts finish first. Then all critiques run.

**Solution attempt.**

```text
# Core Challenge
{challenge}

Assigned Strategy: main1
{strategy text}

Produce iteration 1 solution attempt.
```

The attempt does not see the other strategies. The output is stored as both the first solution and the latest solution.

**Critique, iteration 1.**

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

All corrections finish first. Then all critiques run.

**Correction.**

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

The branch's own latest solution and critique do not appear as separate blocks. They reach the correction only through the history.

**History.** Built for the correction and the critique as follows (with `<LatestCustomCuratedContext>` included only for the correction when a mapped packet exists):

```text
<Iteration n="5">                         only after a global update (the last pair before the update)
<Correction>
{solution of iteration 5}
</Correction>
<Critique>
{critique of iteration 5}
</Critique>
</Iteration>

<DistilledMemoryBank>                     only when the branch has a memory bank
{memory bank}
</DistilledMemoryBank>

<LatestCustomCuratedContext>              only in correction prompts when there is a packet
{the branch's module packet}
</LatestCustomCuratedContext>

<WindowCorrectionCritiqueHistory>         when completed iterations exist in the current window
<Iteration n="6">
<Correction>
{solution of iteration 6}
</Correction>
<Critique>
{critique of iteration 6}
</Critique>
</Iteration>

<Iteration n="7">
{...}
</Iteration>
</WindowCorrectionCritiqueHistory>
```

- **Which iterations.** For a prompt in iteration `k`, let `w = floor((k - 1) / j) * j + 1` be the first iteration of the current window of `j` iterations (1, 6, 11, and so on for `j = 5`). In the first window (`w = 1`), `<WindowCorrectionCritiqueHistory>` contains every completed iteration `1 <= n < k`. After a global update (`w > 1`), the history starts with the branch's last retained pre-update correction-critique pair (iteration `w - 1`, or the rollback target `last_good_iteration` if the branch underwent `EVOLVE (rollback)`), followed by `<DistilledMemoryBank>`, followed (for correction calls when a packet exists) by `<LatestCustomCuratedContext>`, followed by `<WindowCorrectionCritiqueHistory>` containing every completed iteration `w <= n < k` in the current window.
- **The memory bank** is the branch's current bank. It is replaced, not accumulated, at each update.
- **Replacement branches** created at a global update have no memory bank and start from the first execution and critique they ran during that update.

**Packet.** The newest heartbeat block's modules that were marked for all branches or that target this branch, each as:

```text
Module {id}: {text}
Testing of that Module:
{the tester's complete output}

Module {id}: {text}
...
```

The block is left out when there is no heartbeat yet, when modules are off, or when nothing is mapped to the branch. The packet is replaced at every heartbeat, not added to.

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

For a correction in iteration `k`, each peer's latest solution and latest critique are from iteration `k - 1`, captured at the start of the iteration before parallel corrections run.

**Critique, iteration 2 and later.** Same template as the iteration 1 critique, with `<BranchHistoryAndMemory>` above, where `<WindowCorrectionCritiqueHistory>` includes `<Iteration n="k">` at the end containing `<Correction>{the correction that was just written}</Correction>` (with no `<Critique>` tag yet, since that is what the critique agent is producing). After it finishes, the critique is recorded on iteration `k` in the branch's history.

### Stage 4: heartbeat

Order of calls: DOS (a heartbeat that does not end an update, modules on), Modules Generator and Modules Impact Reviewer turns, testers in parallel. The new heartbeat block is stored and committed at the end.

**Heartbeat DOS.**

```text
# Core Challenge
{challenge}

# Dissected Observations Synthesis - Heartbeat DOS
<HarnessNote>
{note, below}
</HarnessNote>

<PreviousHeartbeatModulesAndTests>
[
  {
    "module_id": "{id}",
    "text": "{text}",
    "target_branches": ["main1", "main3"],
    "testing_output": "{the tester's complete output}"
  }
]
</PreviousHeartbeatModulesAndTests>

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

The modules block reads `None.` when there is no previous heartbeat or it had no modules. `ActiveBranchesState` is built from the stored fields at this moment, after the critique of the iteration that just finished.

The heartbeat note: "The modules below were generated at the previous heartbeat, tested independently and mapped to branches, and the branches then ran corrections with those mapped packets. You also have the latest correction and critique of every branch. Synthesize where each branch stands, and for every module → branch assignment report only what you can actually observe: whether the packet was used, and whether the later critique gives real counterevidence against the tester's verdict."

If the DOS returns feedback, it is attached to the previous heartbeat's records before modules are generated.

**Modules Generator & Modules Impact Reviewer (Heartbeat 1, Heartbeat 2, Heartbeat $h$).**

Both **Modules Generator (MG)** and **Modules Impact Reviewer (MIR)** share the same system prompt (`modulesGeneration`) and receive the **exact same user prompt** prefix at the start of a heartbeat loop, with the active role indicated on the final line (`Immediate Role: Modules Generator` or `Immediate Role: Modules Impact Reviewer`, with JSON output for MG and text output for MIR). When sandbox tools are enabled, MG and MIR each maintain their own separate continuous append-only trajectory across all rounds within Heartbeat $h$ (resolving each round's `final_output` tool call with the peer's latest output and `Immediate Role: ...`), scoped strictly to Heartbeat $h$. When sandbox tools are disabled, each turn runs directly with `<CurrentHeartbeatImpactReviewTurns>` in the prompt.

**Short forms:**
- **`[Challenge + Count]`**:
  ```text
  # Core Challenge
  {challenge}

  Requested Number of Modules: {modulesCount}
  ```
- **`[HB-h G↔R]`**: The back-and-forth turns from Heartbeat $h$ (`MG-hb-1` → `MIR-hb-1` → … → `MG-hb-final`).
- **`{HB_Note(1)}`**: Active note for Heartbeat 1 (no previous modules exist yet):
  > *"The branches have executed, critiqued, and corrected up to this first heartbeat. You have received the DOS synthesis of where each branch currently stands, along with the currently running strategies and their latest corrections. Now generate the initial modules object."*
- **`[HB-1 Context]`**:
  1. Current running strategies (`main1`…`mainN`) + latest correction from each active branch
  2. DOS core synthesis for Heartbeat 1 (`DOS_heartbeat_01`)
- **`{HB_Note(h)}`** (for $h \ge 2$): Active note before Heartbeat $h$:
  > *"The modules from Heartbeat `h-1` were finalized, tested independently by dedicated tester agents, and mapped as packets to the target branches, which then executed corrections with them. Below is the context for Heartbeat `h`: the finalized modules from Heartbeat `h-1` and their independent test outputs, the mapped branch packets showing the current running strategies, their latest corrections, and which modules were routed to which branches, the realized module feedback (observed test outcome, utilization across branches, and critique counterevidence), the ledger of modules finalized and used so far across prior heartbeats, and the new DOS synthesis. Now generate the new modules object."*
- **`[HB-h Context]`** (for $h \ge 2$): Strictly these items (no raw branch critiques):
  1. Final generated module object from Heartbeat $h-1$ + corresponding independent testing outputs
  2. Mapped branch packets (schema showing current running strategies `main1`…`mainN`, their latest corrections, and which modules from Heartbeat $h-1$ were mapped to which branches)
  3. Realized module feedback for Heartbeat $h-1$ (`observed_test_outcome`, `utilization` vector `[C/T, P/T, N/T, M/T]`, and `critique_counterevidence`)
  4. `<ModulesFinalizedAndUsedSoFar>`: Ledger of every module finalized and tested across prior heartbeats (`Modules/modules_finalized_and_used_so_far.md`)
  5. DOS core synthesis for Heartbeat $h$
- **`{HB_Reframed_Note(h)}`**: Compact note that **replaces** `{HB_Note(h)} + [HB-h Context]` once Heartbeat $h$ is in the past:
  - For $h = 1$:
    > *"In Heartbeat 1, you received the initial DOS synthesis (`{dosFilePath}`), the active strategies, and their latest corrections, and went back and forth with your impact reviewer friend:"*
  - For $h \ge 2$:
    > *"Yes, the modules from Heartbeat `h-1` were finalized, tested independently, and mapped to branches. For Heartbeat `h`, you received the DOS synthesis inside `{dosFilePath}`, the latest corrections from the corresponding strategy directories, and the prior test outputs and realized feedback records inside `Modules/Heartbeat-{h-1}/`. After this, you went back and forth with your impact reviewer friend:"*
  *(Here `{dosFilePath}` is `DOS_history/DOS_heartbeat_0{h}.md` for a standalone heartbeat, or `DOS_history/DOS_global_update_0{u}_step_ii.md` when Heartbeat $h$ concluded Global Update $u$.)*

**Exact chronological order across Heartbeats (`MG & MIR`):**

- **During Heartbeat 1:**
  1. `[Challenge + Count]`
  2. `{HB_Note(1)} + [HB-1 Context]`
  3. `[HB-1 G↔R so far]` (empty on MG Turn 1; `MG-hb1-1` on MIR Turn 1; `MG-hb1-1 → MIR-hb1-1` on MG Turn 2; etc.)

- **During Heartbeat 2** (`{HB_Note(1)} + [HB-1 Context]` is removed and replaced by `{HB_Reframed_Note(1)}`):
  1. `[Challenge + Count]`
  2. `{HB_Reframed_Note(1)}`
  3. `[HB-1 G↔R]`
  4. `{HB_Note(2)} + [HB-2 Context]`
  5. `[HB-2 G↔R so far]`

- **During Heartbeat 3** (`{HB_Note(2)} + [HB-2 Context]` is removed and replaced by `{HB_Reframed_Note(2)}`):
  1. `[Challenge + Count]`
  2. `{HB_Reframed_Note(1)}`
  3. `[HB-1 G↔R]`
  4. `{HB_Reframed_Note(2)}`
  5. `[HB-2 G↔R]`
  6. `{HB_Note(3)} + [HB-3 Context]`
  7. `[HB-3 G↔R so far]`

- **During Heartbeat $h$ ($h \ge 3$):**
  1. `[Challenge + Count]`
  2. `{HB_Reframed_Note(1)}` → `[HB-1 G↔R]`
  3. `{HB_Reframed_Note(2)}` → `[HB-2 G↔R]`
  4. …
  5. `{HB_Reframed_Note(h-1)}` → `[HB-(h-1) G↔R]`
  6. `{HB_Note(h)} + [HB-h Context]`
  7. `[HB-h G↔R so far]`

**Tester.**

```text
# Core Challenge
{challenge}

Assigned Module {id}:
{module text}

Test this module within your assigned folder.
```

### Stage 5: global update

**Step 1, in parallel: step-i DOS and BSR.** Both read the state after the critique of iteration `n`, before any decision is applied.

Step-i DOS:

```text
# Core Challenge
{challenge}

# Dissected Observations Synthesis - Global Update (Step-i)
<HarnessNote>
{note, below}
</HarnessNote>

<ActiveBranchesState>
{same per-branch blocks as in the heartbeat DOS}
</ActiveBranchesState>
```

The step-i note: "Your output is going to the strategy agents that are about to decide which strategies to continue, evolve or replace in this global update. So write it for them: where exactly each branch is failing, what the branches share, what looks worth keeping. Here you only receive the latest correction and critique of every branch, so there is no module feedback to produce in this call."

BSR, one call per branch:

```text
# Core Challenge
{challenge}

Branch ID: main1
Current Strategy: {strategy text}

<StandingEventLedger>
[Iter 6] PROGRESS (large): {reason}
[Iter 9] REGRESSION (large): {reason}
</StandingEventLedger>

<MemoryBankBeforeWindow>
{memory bank, or "None available."}
</MemoryBankBeforeWindow>

<WindowCorrectionCritiqueHistory>
Iteration 6:
Correction: {solution of iteration 6}
Critique: {critique of iteration 6}

Iteration 7:
Correction: {...}
Critique: {...}
</WindowCorrectionCritiqueHistory>
```

- `<StandingEventLedger>` appears first (since it is append-only across windows), followed by `<MemoryBankBeforeWindow>` (the distilled state prior to the window, read before this update's distillation) and `<WindowCorrectionCritiqueHistory>`.
- The window is iterations `n - j + 1` through `n`, inclusive: 1 to 5 for the first update and 6 to 10 for the second. It uses plain `Iteration x:` headings, not the tags used in the correction history.
- The ledger has only events from earlier windows. This window's events are added after the decisions are made. An empty ledger prints `Empty ledger.`.

**Step 3: Strategy Generator & Strategy Proximity (Global Update 1, Global Update 2, Global Update $u$).** Runs only when at least one branch is EVOLVE or PRUNE.

Both **Strategy Generator (SG)** and **Strategy Proximity (SP)** share the same system prompt (`initialStrategy`) and receive the **exact same user prompt** prefix at the start of a global update loop, with the active role indicated on the final line (`Immediate Role: Strategy Generator` or `Immediate Role: Strategy Proximity Reviewer`, with JSON output for SG and text output for SP). When sandbox tools are enabled, SG and SP each maintain their own separate continuous append-only trajectory across all rounds within Global Update $u$ (resolving each round's `final_output` tool call with the peer's latest output and `Immediate Role: ...`), scoped strictly to Global Update $u$. When sandbox tools are disabled, each turn runs directly with `<CurrentGlobalUpdateProximityTurns>` in the prompt.

**Short forms:**
- **`[Challenge + Count]`**:
  ```text
  # Core Challenge
  {challenge}

  Requested Number of Strategies: {strategiesCount}
  ```
- **`[Seed G↔P]`**: The full back-and-forth turns from Seed (`SG-seed-1` → `SP-seed-1` → … → `SG-seed-final`).
- **`[GU-u G↔P]`**: The back-and-forth turns from Global Update $u$ (`SG-gu-1` → `SP-gu-1` → … → `SG-gu-final`).
- **`{GU_Note(u)}`**: Active note for Global Update $u$:
  > *"These strategies were actually finalized and were executed, critiqued, and corrected for `j` iterations. The DOS output is a synthesis of the critique across each branch so that you understand where each branch is failing exactly. For richer context, you have also received the latest corrections in every branch. Finally, you will receive a BSR object calculated by the harness from each branch's observed window and standing event ledger, containing the decisions about what to continue, evolve, and prune. Now generate the new strategies object for the changed slots only."*
- **`[GU-u Context]`**: The context for Global Update $u$:
  1. `<CurrentActiveStrategies>`: Current actual strategies (`main1`…`mainN`) + latest correction from every branch
  2. `<ConsolidatedBsrDecisions>`: Every branch's decision (`CONTINUE`, `EVOLVE (in_place)`, `EVOLVE (rollback to iteration N / window start)`, or `PRUNE`) + event reasons from the window (carries no window scores or pressures)
  3. `<DosSynthesisForStrategies>`: `dos_output.for_strategies` (`core_synthesis` from Step-i DOS for GU-$u$)
  4. `<StrategiesFinalizedAndUsedSoFar>`: Ledger of every strategy actually finalized and executed so far (seed strategies at iteration 0, plus one entry per EVOLVE or PRUNE replacement at its update iteration)
- **`{GU_Reframed_Note(u)}`**: Compact note that **replaces** `{GU_Note(u)} + [GU-u Context]` once Global Update $u$ is in the past:
  > *"Yes, these strategies were actually finalized and were executed, critiqued, and corrected for `j` iterations. You received the DOS output for previous global update `u` too, which you can find inside `DOS_history/DOS_global_update_0{u}_step_i.md`. You can view the past corrections by going to their corresponding `Strategy-N/history/` directories. After this, you went back and forth with your proximity friend:"*

**Exact chronological order across Global Updates (`SG & SP`):**

- **During Global Update 1:**
  1. `[Challenge + Count]`
  2. `[Seed G↔P]`
  3. `{GU_Note(1)} + [GU-1 Context]`
  4. `[GU-1 G↔P so far]` (empty on SG Turn 1; `SG-gu1-1` on SP Turn 1; `SG-gu1-1 → SP-gu1-1` on SG Turn 2; etc.)

- **During Global Update 2** (`{GU_Note(1)} + [GU-1 Context]` is removed and replaced by `{GU_Reframed_Note(1)}`):
  1. `[Challenge + Count]`
  2. `[Seed G↔P]`
  3. `{GU_Reframed_Note(1)}`
  4. `[GU-1 G↔P]`
  5. `{GU_Note(2)} + [GU-2 Context]`
  6. `[GU-2 G↔P so far]`

- **During Global Update $u$ ($u \ge 3$):**
  1. `[Challenge + Count]`
  2. `[Seed G↔P]`
  3. `{GU_Reframed_Note(1)}` → `[GU-1 G↔P]`
  4. `{GU_Reframed_Note(2)}` → `[GU-2 G↔P]`
  5. …
  6. `{GU_Reframed_Note(u-1)}` → `[GU-(u-1) G↔P]`
  7. `{GU_Note(u)} + [GU-u Context]`
  8. `[GU-u G↔P so far]`

The strategy text of every changed slot is replaced when the last generator turn is applied. Everything after this point sees the new text.

**Step 4: repository.** Rolled-back folders are restored from commit. Pruned folders are archived. This changes files only. The stored latest solution, latest critique, and iteration history of a rolled-back branch are not changed by the rollback, so they keep showing the last iteration until the branch's next correction and critique replace them. For a pruned slot, the iteration history and memory bank are cleared.

**Step 5, in parallel: memory bank and replacement branches.**

Memory bank, once per surviving branch:

```text
# Core Challenge
{challenge}

Branch ID: main1

Strategy Text: {strategy text, after this update's changes}

Previous Memory Bank:
{memory bank}                         or "No previous memory bank."

Window History:
Iteration 6:
Correction: {solution of iteration 6}
Critique: {critique of iteration 6}

Iteration 7:
...
```

- The iterations are `n - j + 1` through `n`, or through the rollback iteration when the branch rolled back. When a branch rolled back to the window start, no memory bank call is made and the old bank stays.
- The result replaces the stored memory bank, and is also written to `Strategy-N/history/memory_bank_NN.md`.

Replacement branch, first execution:

```text
# Core Challenge
{challenge}

Assigned Strategy: main4
{new strategy text}

First execution for replacement branch in slot main4.
```

Then its critique uses the critique template with `<WindowCorrectionCritiqueHistory>` holding `<Iteration n="{n}"><Correction>{first execution}</Correction></Iteration>`. Once the critique completes, the pair is stored as iteration `n`.

Every active strategy folder is then committed as the next window's starting state.

**Step 6: step-ii DOS** (modules on).

```text
# Core Challenge
{challenge}

# Dissected Observations Synthesis - Global Update (Step-ii)
<HarnessNote>
{note, below}
</HarnessNote>

<StepIOutputBaseline>
{the complete step-i DOS output as pretty JSON}
</StepIOutputBaseline>

<PreviousHeartbeatModulesAndTests>
{same format as in the heartbeat DOS}
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

The step-ii note is built from the decisions:

```text
This is your second call in this global update. Since your first output, the decisions were applied and the status of every slot is listed below:
- main1: CONTINUE (surviving uninterrupted)
- main2: EVOLVE with rollback (reverted to iteration 8, discarded later iterations)
- main3: EVOLVE in place (re-aimed strategy text, progress standing)
- main4: PRUNE (archived, freed slot now holds a new branch starting with first execution + critique)

Branches that were pruned are gone and their slots now hold new branches that only have a first execution and critique.
A branch that was rolled back no longer contains the iterations after its rollback point.
You also receive your own first output from this global update, unchanged.
The previous heartbeat's modules, testing outputs and mappings are included now, so produce module feedback, but only for assignments you can really observe, which means the branches that survived.
You cannot say anything about the new branches and that is fine, leave them out.
Do not repeat your first output: use it as a base and give a more nuanced, natural synthesis of the state you see now.
```

A rollback to the window start prints `reverted to window start`.

**Step 7: Heartbeat inside a Global Update (The Exception).**
When a Global Update $u$ finishes Step 5 (memory bank distillation on surviving branches + first execution & critique on replacement branches), Step 6 runs `step_ii` DOS, and Step 7 immediately runs a Heartbeat (say Heartbeat $h$) that **reuses `step_ii` DOS** instead of running a standalone Heartbeat DOS.

During this post-update Heartbeat $h$, **MG & MIR** receive the exact same chronological structure as Stage 4 (`1. [Challenge + Count]`, prior `{HB_Reframed_Note} + [HB G↔R]` blocks, `{HB_Note(h)} + [HB-h Context]`, and `[HB-h G↔R so far]`), with two Global-Update-specific properties inside `[HB-h Context]`:
1. **Mapped branch packets** reflect the **post-update active strategies** (including evolved strategy texts and new replacement branches in pruned slots), their **latest corrections** (which for replacement branches is their first execution), and the Heartbeat $h-1$ branch mappings.
2. **Realized module feedback for Heartbeat $h-1$** and **DOS core synthesis** come directly from **Global Update $u$ Step-ii DOS** (where utilization and counterevidence were graded on surviving branches only).
3. On the *next* heartbeat ($h+1$), when `{HB_Note(h)} + [HB-h Context]` is replaced by `{HB_Reframed_Note(h)}`, that reframed note points to `DOS_history/DOS_global_update_0{u}_step_ii.md`.

### Stage 6: final iteration

Iteration `i` uses the exact same Stage 3 correction template and context as iterations `2` to `i-1`, including `LatestCustomCuratedContext` when a heartbeat has run. In iteration `i`, only the branch corrections run (no critiques are generated), and the pipeline completes once all branch corrections finish.

## Repository

Prompts carry the curated context: the memory bank and recent history. The repository holds everything else, so an agent late in a long run can still open any file and see what was tried, what failed, and what has not been touched. Prompts keep their history objects anyway, since a model's memory of a long prompt is imperfect and the files back it up.

### Layout

Each run operates in a single Git repository located at `Results/deepthink_<timestamp>/` (mounted inside sandboxed agent containers at `/workspace`).

```text
Results/deepthink_<timestamp>/
├── latest.gz                        live compressed run state checkpoint, excluded from git commits
├── shared_workspace.md              live document (≤ 5,000 tokens), excluded from git commits
├── tmp/                             shared R/W scratch & verification harnesses, excluded from git commits
├── user_uploaded/                   copies of the files the user attached
├── DOS_history/                     one .md + .jsonl pair per DOS call
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
│   │   ├── Module-1/                                 module.md (+ .jsonl), test files, feedback record
│   │   └── Module-2/
│   └── Heartbeat-2/
├── Pruned_Strategies/               for example Strategy-1_pruned_01/
├── Strategy-1/
│   ├── strategy.md
│   ├── solution files
│   ├── iterations/
│   │   └── iteration_01.md          solution and critique
│   └── history/
│       ├── iteration_01.jsonl       raw agent trajectory for iteration 1
│       └── memory_bank_01.md        one per memory bank (+ memory_bank_01.jsonl)
└── Strategy-2/
```

File numbers in `history/` are global iteration numbers. Every agent invocation that writes a durable `.md` output file is accompanied in the same directory by a `.jsonl` file containing the raw agent trajectory for that invoke. Heartbeat folders are never deleted. File and folder names are indicative.

### Git

The repository has one git branch and one working tree. Every strategy folder, the heartbeat folders, and the strategy histories sit side by side. All branches run in parallel, and each agent writes in its own folder while reading everyone else's, so every folder needs to be on disk at once. Restoring one folder from an earlier commit does not affect the others, because no file is shared between strategies.

Only the harness uses git. Agents can read history but cannot commit or restore. The harness runs git operations one at a time, always when no agent is writing, so a commit never captures a half-written file. `shared_workspace.md` and `tmp/` are untracked via git exclude / `.gitignore`.

Commits are kept few:

- At the end of every iteration, each strategy folder is committed separately and in turn, named after its strategy and iteration. These commits are what a rollback goes back to.
- At the end of a global update, after memory banks and replacement branches are done, each active strategy folder is committed again. This is the starting point of the next window, and it is where a rollback to `window_start` returns.
- Shared folders are committed when a heartbeat finishes and after each strategy history file is written.

When a branch is pruned, its folder is moved to `Pruned_Strategies/` under an ordinal name such as `Strategy-1_pruned_01`, and a new empty `Strategy-1/` takes its place. The ordinal keeps a reused slot name from clashing with archived data.

When a branch rolls back, its folder on disk is restored from the chosen iteration's commit (`last_good_iteration` or `window_start`), its standing BSR event ledger and iteration history are trimmed to the rollback point, and its active solution and critique fields are restored to that checkpoint. This is a revert on the working directory, so nothing in git commit history is rewritten.

At the end of the run, nothing is merged. The strategy folders are already in the repository, which is the record of the run.

### Access

Every agent can read the entire repository and has full read and write access to the shared untracked `tmp/` directory at the repository root (for scratch work, shared verification scripts, and test harnesses). In addition, agents with a dedicated folder write into their own working directory. Nobody writes directly to the repository root or to `.git`.

| Role | Working directory |
|---|---|
| Strategy generator and proximity | Repo root, read-only. Read/write in `tmp/` |
| DOS | Repo root, read-only. Read/write in `tmp/` |
| Modules Generator and Modules Impact Reviewer | Repo root, read-only. Read/write in `tmp/` |
| Modules Tester | Its own `Module-M/` folder (read/write), full repository read, and read/write in `tmp/` |
| Solution attempt, critique, correction | `Strategy-N/` (read/write), full repository read, and read/write in `tmp/` |
| Memory bank, BSR | `Strategy-N/` (read-only), full repository read, and read/write in `tmp/` |

The harness creates directories, writes strategy history files and module feedback records (along with `.jsonl` trajectory files), makes the commits, restores folders, and moves pruned folders into `Pruned_Strategies/`.

Agents with sandbox access get three tools: `sandbox_exec`, `shared_workspace`, and `final_output`, plus a runtime-appended `<Virtual Sandbox Tool>` system prompt block describing detected runtimes (Python, Node.js, Lean 4 / Mathlib, Rust, and CLI utilities), mount permissions, and inline file/image marker syntax (`[[image:path|Label]]` and `[[file:path|Label]]`, which expand into inline previews in the UI). Each sandboxed agent invocation has a default budget of $m = 64$ tool-call turns and a 60-minute wall-clock timeout. The harness injects countdown reminders at $m - 10$ and $m - 5$ remaining tool calls, as well as wall-clock warnings at 10 minutes and 5 minutes remaining. If an agent reaches $m$ tool calls without submitting, the harness injects an urgent final-submission prompt and grants 5 overtime grace turns; if still not submitted (or if the 60-minute wall-clock limit expires), `sandbox_exec` and `shared_workspace` are revoked for up to 5 finalization turns where only `final_output` remains. Individual `sandbox_exec` commands have a 120-second default timeout (300-second maximum), automatic `rtk` command wrapping, `view`/`open` shell helpers for inspecting generated images, and 5,000-token truncation on `stdout` and `stderr` individually. `final_output` validates both the role's required output format and its maximum output token cap (5,000 tokens for Strategy Generator, Strategy Proximity, Modules Generator, Modules Impact Reviewer, DOS, BSR, Solution Critique, Modules Tester, and Solution Attempt; 10,000 tokens for Solution Correction and Memory Bank). If a submission exceeds the token cap, the tool call and its error remain in conversation history and a harness note instructs the agent to condense and resubmit within its token limit.

### Shared workspace

Every agent gets the `shared_workspace` tool with three actions: `read`, `edit` (targeted `old_string` $\to$ `new_string` replacement with optional `replace_all`), and `append`. Targeted edits update specific sections in place while preserving peer notes across the file. `shared_workspace.md` is capped at 5,000 tokens; any `edit` or `append` that would push the file past 5,000 tokens records the tool error in conversation history and triggers a harness note instructing the agent to trim stale notes or make a more concise update. The latest copy is always at the repo root, even between iterations.

### Attached files

Text files the user attaches are included in `state.challenge`. Images are included as `<!-- EXECUTION_IMAGE_START -->` blocks in `state.challenge` and converted into native provider image inputs when prompts are sent. All attached files are also written into `user_uploaded/` inside the run repository so agents can inspect them on disk.

## Failures and retries

- **Retries.** Transient provider errors and failed output validation checks are retried with backoff (`1m`, `3m`, `5m` for provider retries, and up to 4 attempts with `30s`, `60s`, `5m` waits for orchestrator format/contract retries), with a rolling 5-minute silence watchdog on streaming turns.
- **Pausing on unrecovered failure.** If an agent call exhausts its retries (whether on a global synthesis call or a branch's solution attempt, critique, correction, memory bank, or modules tester), the orchestrator pauses the pipeline (`status = 'stopped'`), preserving the latest checkpoint in `latest.gz` so the run can be resumed without losing completed work.
- **Format checks.** Every structured output is checked before it is used. The checks cover:
  - exact slot names
  - one decision per branch
  - for a global update, exactly one strategy entry per EVOLVE or PRUNE slot and none for any other slot
  - a BSR report whose `branch_id` matches its branch, with valid progress and regression event arrays

  A failed check is retried, and a partly valid output is never applied.
- **Stopping.** A stop request takes effect between steps and during waits for a retry.

## Saving and resuming

The run's settings and prompts are fixed when it starts. A snapshot of the run, `latest.gz`, is written into the run's repository whenever the state changes, and it carries the state version.

The orchestrator also saves its place in the run: the current iteration, the heartbeat count, the counter since the last heartbeat, each slot's commit for every iteration (the targets for rollback), the list of strategies used so far, the strategy histories of global updates, and the shared workspace text.

Resuming rebuilds the orchestrator from the saved state and skips whatever is done: seed strategies that exist, and iterations where every branch has a history entry and where the global update or heartbeat that followed is recorded.

The saved state also holds BSR records, ledgers, DOS outputs, heartbeat blocks, archived branches, and the live event feed.

## Interface

| Tab | Shows |
|---|---|
| Branches | Active strategies and each branch's history |
| Curated Context | Generator and impact review history, heartbeats, which branches each module was sent to, test results, and feedback |
| Live | Each agent's lifecycle, prompts, responses, traces, retries, and failures |
| Filesystem | The run's repository |

The configuration panel has only the settings listed above. The prompt editor lists these agents: Strategy Generator, Modules Generator, Modules Testing, Solution Attempt, Solution Critique, Solution Correction, Memory Bank, DOS, and BSR.

## Code map

| Module | Responsibility |
|---|---|
| `pipelineOrchestrator.ts` | The run loop, each iteration phase, heartbeats, global updates, retries, and commits |
| `deepthinkCore.ts` | Starting and resuming a run, reading settings, saving snapshots, and assembling the challenge from attached files |
| `loopController.ts` | Bounds on `i`, `j`, `k`, the heartbeat rule, and what runs after each iteration |
| `formulas.ts` | BSR window scoring, pressures, and decisions; module utilization |
| `contextBuilders.ts` | The prompt contents for each agent, and conversion of image blocks |
| `harnessNotes.ts` | The notes added to the strategy generator and DOS, and the assembly of strategy proximity history |
| `agentRegistry.ts` | Each agent's label, sandbox role, system prompt key, and model key |
| `gitRepository.ts` | Repository commits, window starts, rollbacks, and archiving of pruned branches |
| `sharedWorkspace.ts` | The `shared_workspace` tool and its live document |
| `types.ts` | Types for settings, branches, modules, BSR, DOS, heartbeats, and run state |
