## Deepthink Pipeline Flow

Deepthink is a carefully thought multi-agent pipeline that co-ordinates agents with highly focused roles by routing very precise and surgical context to explore the solution search space. More broadly, it explores diverse "correct trajectories" or "implementations" or "executions" in parallel for any given user request. The system is based on the following ideas: "strategies proximity", "modules impact review", "parallel exploration", "iterative corrections/refinements", "cross-strategy-learning through curated context", "independent modules generation & testing", and a "meta strategies evolving loop (pruning)". Each agent role can be steered surgically by the user as needed.

**Full Deepthink Flow:**

The user provides the problem or attaches files into the virtual environment and starts the run. The system first generates high-level, distinct ways to approach the core challenge (strategies). In a global context, these act as parallel branches where each branch tries to solve the challenge using its assigned approach. Strategies are not generated in a single shot: a Strategy Generator and a Strategy Proximity Reviewer go back and forth for a few rounds so that surface-level variations, overlapping ideas, or blind spots are caught and refined before any execution starts.

In Iteration 1, every branch runs in parallel to produce its initial work. Once all branches finish, a Critique agent runs on each branch in parallel to evaluate the solution for correctness, completeness, broken constraints, structural weaknesses, and whether the strategy itself still looks viable. The critique diagnoses issues without rewriting the solution.

From the second iteration onward, every branch runs a Correction agent followed by a Critique agent in parallel. The Correction agent receives the core challenge, its assigned strategy, the back-and-forth correction and critique history of its branch, any tested module packets routed to it, and the latest work and critiques from the other active branches so it can learn from what worked or failed across peer strategies. It produces an improved solution, which is then critiqued again.

On top of this core loop, two periodic mechanisms keep the branches sharp and prevent wasted compute:

**Heartbeats (Modules Generation and Testing):**
After every few iterations, a heartbeat runs to refresh the curated evidence fed into the branches. First, an observation synthesis agent (DOS) reads the latest work and critiques across all branches to summarize where every branch stands and how well earlier modules were actually used. Next, a Modules Generator and a Modules Impact Reviewer go back and forth to propose high-leverage modules about key uncertainties, bottlenecks, or smaller cases worth verifying. When generating new modules, they also see the previous test verdicts and whether branches actually benefited from them. Each module is then tested independently in parallel by a dedicated tester agent with full attention, so the branch execution agents do not have to spend their own tokens testing those ideas. The verified results are mapped back as focused information packets to the specific branches that need them.

**Global Updates (Branch Evaluation, Rollbacks, Pruning, and Memory Distillation):**
After a fuller window of iterations, a global update runs to evaluate how each branch has been trending as a whole trajectory. A Branch State Representation (BSR) agent reviews the window for each branch and reports confirmed progress events, confirmed regressions, and how well corrections followed critiques. Deterministic formulas turn that report and the branch's standing history into one of four outcomes:
- **Continue:** The branch is making real progress and keeps going.
- **Evolve in place:** The branch has built strong progress that is worth keeping, but its current angle has plateaued. Its strategy is updated to push further while keeping its work intact.
- **Evolve with rollback:** The branch started well earlier in the window and then regressed into a worse trajectory. The system reverts the branch back to its last good iteration and updates its strategy so it does not repeat the same dead end.
- **Prune:** The branch is stuck or failing with little standing progress. It is archived and replaced by a brand new strategy, which runs its first execution and critique before the next window begins.

At the same time, every surviving branch distills its window history into a compact memory bank (what worked, what improved, and what critique patterns kept recurring) so future iterations stay focused without losing hard-won lessons.

After all iterations complete, the final solutions and critiques from the surviving branches are sent to the Final Judge, which evaluates the candidates and selects the best execution.

**Sandbox Environment and Shared Workspace:**
When the sandbox environment is enabled, every agent works inside a shared git-backed repository. Each branch writes inside its own strategy directory, modules testers work in their own dedicated test directories, and every agent can read across the repository, use a shared scratch directory for verification scripts, and read or update a live shared workspace document to pass verified findings to other agents. Agents run their experiments using the sandbox execution tool and submit their clean final artifact through a validated output tool, so raw command logs and scratch work never pollute downstream prompts.

See the full documentation for complete details:
- [Deepthink Architecture and Context Flow](Deepthink/docs/DeepthinkDocs.md)
- [Architecture Visuals](Deepthink/docs/deepthink_architecture.html)

## Adaptive Deepthink

Adaptive Deepthink is an orchestrator-directed, pass-based workflow that uses the same core worker pairs without a fixed schedule or a separate final judge. Basically it is like giving access of the deepthink mode to an agent. A central orchestrator decides at each pass when to generate or replace strategies, when to formulate and independently test modules from critiques, which branches to execute, critique, and correct in parallel, which promising branches to save permanently, and when to compact a completed pass and submit the final answer.

## License

Apache-2.0
