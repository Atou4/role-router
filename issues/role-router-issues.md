# Role Router issues

## ISSUE-RR-001 — Replan Architect failure leaves a recorded decision unapplied
- status: deferred
- reported: 2026-10-26

### Observed
`role-router resolve IncaCook-Server:TASK-017 --note "…"` recorded the decision and appended it to the project decision log, then the headless Architect exited with `codex exited 1 without completing a turn`. The command returned an error before applying the decision to the task specs or relaunching the Builder. The user must inspect task state to determine whether the decision was applied.

The subsequent review launch also stopped before a reviewer turn: the base merge found a `PLAN.md` conflict, then the Builder selected for conflict resolution exited with the same empty Codex failure. The Anthropic profile failed preflight because Claude Code was signed out. Retrying the Architect outside the sandbox succeeded, so runner startup behavior varies by role and execution context.

The same failure recurred when resuming IncaCook mobile TASK-103 through Role Router on 2026-10-26: the launch exited after about three seconds with `codex exited 1 without completing a turn`, before the Builder produced any output.

### Additional diagnosis (2026-10-26)
The same Codex CLI cannot initialize its app-server client inside the default sandbox (`failed to initialize in-process app-server client: Operation not permitted`), but a minimal read-only Codex turn succeeds when the local process is allowed host IPC. Running the Role Router task launch with that permission allowed it to start. This points to a runner sandbox/IPC requirement, not a task-specific prompt failure.

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

## ISSUE-RR-003 — Stale task base makes the review diff include upstream task work
- status: deferred
- reported: 2026-10-26

### Observed
TASK-017 was created from `plan/staging-phone-otp`, while its Builder had already merged newer `origin/main` into the task branch. Before review, Role Router correctly merged the recorded base into the task branch, but review compared against that stale base and treated an existing production scheme line from upstream work as a TASK-017 change. This produced a staging-scope finding for code already present in the newer upstream history.

### Expected
Before review, Role Router should identify that a task branch contains commits from a newer upstream base and choose/update the recorded PR base, or clearly exclude already-upstream commits from task-specific findings. The reviewed diff should match the intended merge target.

### Follow-up
Keep the current review finding visible until its ownership is resolved; then fix base selection/integration so stale task plans cannot misattribute prior changes.

## ISSUE-RR-004 — PR handoff fails without GitHub connectivity and valid auth
- status: deferred
- reported: 2026-10-26

### Observed
After TASK-017 passed review and docs, the automatic PR step failed with `Head sha can't be blank, Base sha can't be blank, No commits between ...`. `role-router pr IncaCook-Server:TASK-017 --dry-run` then failed while listing PRs because it could not connect to `api.github.com`; `gh auth status` also reports the configured GitHub token is invalid. No PR was opened or merge performed.

### Expected
The PR stage should preflight GitHub connectivity/auth and return a clear blocked status without reporting a misleading head/base or no-commits error.

### Follow-up
After GitHub connectivity and auth are restored, retry `role-router pr IncaCook-Server:TASK-017`; review the proposed base/head before merge.

## ISSUE-RR-005 — Inbox keeps resolved escalations for completed tasks
- status: deferred
- reported: 2026-10-26

### Observed
After syncing IncaCook mobile, TASK-104 is `done` on the Role Router board and its PR is merged, but `role-router inbox` still presents TASK-104's environment escalation as open and says it blocks TASK-103 and TASK-105. `role-router next` also continues to recommend resolving that stale escalation.

### Expected
When a task completes or an escalation is otherwise resolved, the inbox and dependency recommendations should stop surfacing it as an actionable blocker. If completion does not resolve an escalation automatically, Role Router should clearly distinguish stale/non-blocking escalations from open decisions.

### Follow-up
Reconcile escalation state with the task board during sync, and ensure inbox/next only treat unresolved escalations on active tasks as blockers.

## ISSUE-RR-006 — Restricted preflight reports Anthropic signed out despite usable credentials
- status: deferred
- reported: 2026-10-26

### Observed
`role-router status` lists the Anthropic account as `ok`, but an unprivileged Builder run on `anthropic-lite` fails preflight with `Claude Code is not signed in`, and unprivileged `claude auth status` reports `loggedIn: false`. Later, the normal TASK-103 launch with host IPC access successfully ran the Anthropic Builder (`claude-sonnet-5-5`). The account was usable; the restricted preflight context could not see its auth state.

### Expected
Provider readiness/preflight should distinguish genuinely missing credentials from credentials inaccessible because the runner lacks host IPC/keychain access, and name the needed execution context.

### Follow-up
Make provider preflight use the same permitted host context as the launched agent, or return an actionable IPC/keychain permission diagnosis instead of claiming the user is signed out.
