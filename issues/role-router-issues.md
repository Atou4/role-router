# Role Router issues

## ISSUE-RR-001 — Replan Architect failure leaves a recorded decision unapplied
- status: deferred
- reported: 2026-10-26

### Observed
`role-router resolve IncaCook-Server:TASK-017 --note "…"` recorded the decision and appended it to the project decision log, then the headless Architect exited with `codex exited 1 without completing a turn`. The command returned an error before applying the decision to the task specs or relaunching the Builder. The user must inspect task state to determine whether the decision was applied.

### Expected
If the replan Architect fails, Role Router should report that the decision is durable but unapplied, preserve the escalation for retry, and offer a safe retry/fallback. A subsequent resolve retry should not append duplicate decisions.

### Follow-up
Improve headless replan fallback/diagnostics and make resolve idempotent across Architect failures. For now, manually apply the already-recorded decision after checking task files, then relaunch through Role Router.
