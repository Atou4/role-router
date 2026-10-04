# Split the build pipeline into per-Role commands

Instead of one monolithic command that grills, builds, reviews, and opens a PR in a single session (as take-my-pic's original `/build-task` does), the workflow is split into per-Role commands: `/plan` (Architect), `/build` (Builder), `/review` + `/docs` (Worker). Each runs in its own session on its own Engine; state moves between them through the **Handoff Artifact** (the board task spec, the working diff, `board.json`).

This split is required across harnesses as well as models: a Codex subscription process cannot turn into an OpenCode/Z.AI process mid-session. Each Role therefore runs as a separate Adapter invocation and shares state through files.

## Consequences

- The monolithic `/build-task` is decomposed; the Architect grilling step that used to live inside it becomes `/plan`.
- Each Role command must be able to fully reconstruct its inputs from files (no reliance on prior in-session context).
- Worker quality gates (typecheck/Maestro) still run in `/build`; failing twice triggers **Escalation** back to the Architect Engine.
