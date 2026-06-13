# Split the build pipeline into per-Role commands

Instead of one monolithic command that grills, builds, reviews, and opens a PR in a single session (as take-my-pic's original `/build-task` does), the workflow is split into per-Role commands: `/plan` (Architect), `/build` (Builder), `/review` + `/docs` (Worker). Each runs in its own session on its own Engine; state moves between them through the **Handoff Artifact** (the board task spec, the working diff, `board.json`).

This split is forced by the mechanism: CCR routes per *request* by static rules and is not stage-aware inside a single running command, so we cannot cleanly flip Claude→Kimi→DeepSeek partway through one `/build-task`. The only way to put each Role on its proper Engine is to make each Role a separate command/session and let the artifact carry state — which the agent-board already does, so the split costs little and aligns with the existing file-based handoff.

## Consequences

- The monolithic `/build-task` is decomposed; the Architect grilling step that used to live inside it becomes `/plan`.
- Each Role command must be able to fully reconstruct its inputs from files (no reliance on prior in-session context).
- Worker quality gates (typecheck/Maestro) still run in `/build`; failing twice triggers **Escalation** back to the Architect Engine.
