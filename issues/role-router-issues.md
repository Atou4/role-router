# Role Router issues

## ISSUE-RR-001 — Replan Architect failure leaves a recorded decision unapplied
- status: deferred
- reported: 2026-10-26

### Observed
`role-router resolve IncaCook-Server:TASK-017 --note "…"` recorded the decision and appended it to the project decision log, then the headless Architect exited with `codex exited 1 without completing a turn`. The command returned an error before applying the decision to the task specs or relaunching the Builder. The user must inspect task state to determine whether the decision was applied.

The subsequent review launch also stopped before a reviewer turn: the base merge found a `PLAN.md` conflict, then the Builder selected for conflict resolution exited with the same empty Codex failure. The Anthropic profile failed preflight because Claude Code was signed out. Retrying the Architect outside the sandbox succeeded, so runner startup behavior varies by role and execution context.

### Expected
If the replan Architect fails, Role Router should report that the decision is durable but unapplied, preserve the escalation for retry, and offer a safe retry/fallback. A subsequent resolve retry should not append duplicate decisions.

### Follow-up
Improve headless replan fallback/diagnostics and make resolve idempotent across Architect failures. For now, manually apply the already-recorded decision after checking task files, then relaunch through Role Router.

## ISSUE-RR-002 — Replan can mark an unmerged implementation task done
- status: deferred
- reported: 2026-10-26

### Observed
After a direct headless Architect replan of IncaCook-Server TASK-017, its shared board status became `done`, although `task/TASK-017` was not merged into the base branch and review/integration had not run. `role-router sync` reported nothing newly merged. The task branch's PLAN.md also remained stale relative to the later replan commit on the base branch.

### Expected
A planning-only replan must not promote an implementation task to `done`. Completion should require the normal review/integration lifecycle, and a task branch should receive the updated base spec before review or merge.

### Follow-up
Keep the task at `review` while reviewing; fix the Architect/replan status transition and ensure base sync happens before review. Do not let downstream dependencies treat the unmerged branch as completed.
