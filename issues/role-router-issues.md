# Role Router issues

## ISSUE-RR-001 — Replan Architect failure leaves a recorded decision unapplied
- status: fixed (2026-10-30)
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

### Fix (2026-10-30)
Root cause: `resolve` recorded and logged the decision before the Architect ran, and a failed run left it resolved, so it vanished from the inbox. Fix: a failed apply marks the decision `unapplied`; the inbox shows it as decided-not-applied, NEXT offers the retry, and `role-router resolve <task>` with no option reapplies it without logging it again. Codex's own failure reason (e.g. the sandbox IPC error) now reaches the message, with a hint when a sandbox around role-router is the likely cause.

## ISSUE-RR-002 — Replan can mark an unmerged implementation task done
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
After a direct headless Architect replan of IncaCook-Server TASK-017, its shared board status became `done`, although `task/TASK-017` was not merged into the base branch and review/integration had not run. `role-router sync` reported nothing newly merged. The task branch's PLAN.md also remained stale relative to the later replan commit on the base branch.

### Expected
A planning-only replan must not promote an implementation task to `done`. Completion should require the normal review/integration lifecycle, and a task branch should receive the updated base spec before review or merge.

### Follow-up
Keep the task at `review` while reviewing; fix the Architect/replan status transition and ensure base sync happens before review. Do not let downstream dependencies treat the unmerged branch as completed.

### Fix (2026-10-30)
Root cause: the headless Architect itself ran `board set-status TASK-017 done` (run adhoc-20261026-100101); nothing stopped an agent from setting `done`. Fix: every agent process carries `ROLE_ROUTER_AGENT`, and `board set-status … done` refuses it; done comes from `sync` after a merge, or from a human. `/replan` and `/next` no longer tell agents to set done.

## ISSUE-RR-003 — Stale task base makes the review diff include upstream task work
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
TASK-017 was created from `plan/staging-phone-otp`, while its Builder had already merged newer `origin/main` into the task branch. Before review, Role Router correctly merged the recorded base into the task branch, but review compared against that stale base and treated an existing production scheme line from upstream work as a TASK-017 change. This produced a staging-scope finding for code already present in the newer upstream history.

### Expected
Before review, Role Router should identify that a task branch contains commits from a newer upstream base and choose/update the recorded PR base, or clearly exclude already-upstream commits from task-specific findings. The reviewed diff should match the intended merge target.

### Follow-up
Keep the current review finding visible until its ownership is resolved; then fix base selection/integration so stale task plans cannot misattribute prior changes.

### Fix (2026-10-30)
Root cause: the recorded base (`plan/staging-phone-otp`) was used even after the Builder merged newer `origin/main` into the branch, so the review diff carried main's work. Fix: `effectiveBase` (lib/pr.mjs) moves the base to the default branch when the task head already contains newer default-branch commits than the recorded base; the record, the merge step, the review prompt and the PR all follow.

## ISSUE-RR-004 — PR handoff fails without GitHub connectivity and valid auth
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
After TASK-017 passed review and docs, the automatic PR step failed with `Head sha can't be blank, Base sha can't be blank, No commits between ...`. `role-router pr IncaCook-Server:TASK-017 --dry-run` then failed while listing PRs because it could not connect to `api.github.com`; `gh auth status` also reports the configured GitHub token is invalid. No PR was opened or merge performed.

### Expected
The PR stage should preflight GitHub connectivity/auth and return a clear blocked status without reporting a misleading head/base or no-commits error.

### Follow-up
After GitHub connectivity and auth are restored, retry `role-router pr IncaCook-Server:TASK-017`; review the proposed base/head before merge.

### Fix (2026-10-30)
Fix: the PR step runs `gh auth status` first and stops with the real cause (nothing pushed or opened); GitHub's "Head sha can't be blank / No commits between" is translated into which branches GitHub cannot see and how to check them.

## ISSUE-RR-005 — Inbox keeps resolved escalations for completed tasks
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
After syncing IncaCook mobile, TASK-104 is `done` on the Role Router board and its PR is merged, but `role-router inbox` still presents TASK-104's environment escalation as open and says it blocks TASK-103 and TASK-105. `role-router next` also continues to recommend resolving that stale escalation.

### Expected
When a task completes or an escalation is otherwise resolved, the inbox and dependency recommendations should stop surfacing it as an actionable blocker. If completion does not resolve an escalation automatically, Role Router should clearly distinguish stale/non-blocking escalations from open decisions.

### Follow-up
Reconcile escalation state with the task board during sync, and ensure inbox/next only treat unresolved escalations on active tasks as blockers.

### Fix (2026-10-30)
Root cause: `sync` archived escalations only when it marked a task done itself, and the inbox listed escalations whatever the task's status. Fix: the inbox and NEXT skip escalations of done tasks, and `sync` archives them for every done task.

## ISSUE-RR-006 — Restricted preflight reports Anthropic signed out despite usable credentials
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
`role-router status` lists the Anthropic account as `ok`, but an unprivileged Builder run on `anthropic-lite` fails preflight with `Claude Code is not signed in`, and unprivileged `claude auth status` reports `loggedIn: false`. Later, the normal TASK-103 launch with host IPC access successfully ran the Anthropic Builder (`claude-sonnet-5-5`). The account was usable; the restricted preflight context could not see its auth state.

### Expected
Provider readiness/preflight should distinguish genuinely missing credentials from credentials inaccessible because the runner lacks host IPC/keychain access, and name the needed execution context.

### Follow-up
Make provider preflight use the same permitted host context as the launched agent, or return an actionable IPC/keychain permission diagnosis instead of claiming the user is signed out.

### Fix (2026-10-30)
Root cause: inside another agent's sandbox the macOS keychain is unreachable (`security show-keychain-info` exits 206), so `claude auth status` reports signed out. Fix: the Claude preflight probes the keychain and reports the sandbox, not a sign-out.

## ISSUE-RR-007 — Human-needed stop writes a generic escalation without options
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
When IncaCook TASK-103 stopped as `human_needed`, Role Router wrote an escalation asking only whether the generic stop should be resolved, with empty `options`, `recommendation`, and `affects` fields. The actual missing inputs and completed work were present in the Builder summary, but the escalation could not be resolved with `--option` and did not present the needed actions directly.

### Expected
The escalation should preserve the Builder's concrete blockers and choices in structured fields, or clearly expose the summary as the decision prompt and provide a supported resolution path.

### Follow-up
Map structured and free-form `human_needed` stops into actionable escalation records; avoid replacing a detailed Builder result with a generic question.

### Fix (2026-10-30)
Root cause: the Builder listed its blockers as bullets under "Not done", and the stand-in escalation only extracted numbered choices. Fix: stand-ins name the blockers from the agent's "Not done / Blocked / Missing / Waiting on" section and always offer resolvable options; older option-less stand-ins are rewritten when the inbox opens.

## ISSUE-RR-008 — `fan` crashes on Codex lanes outside a git repo
- status: fixed (2026-10-30)
- reported: 2026-10-26

### Observed
`role-router fan --profiles=openai-top --prompt-file=prompt.md` run from a folder that is not a git repository (a scratch research folder) returned `✗ openai-top crashed: codex exited 1 without completing a turn`. Running `codex exec` by hand in the same folder showed the cause: `Not inside a trusted directory and --skip-git-repo-check was not specified.` After `git init` in that folder, the same `fan` command succeeded.

`lib/agents/codex.mjs` passes `--skip-git-repo-check` only when `fullAccess && mode === 'headless'` (both the `exec` and `exec resume` branches). `fan` dispatches lanes in headless mode without full access (`lib/fan.mjs`, `dispatch({ role: 'fan', … mode: 'headless' … })`), so the flag is never added.

### Expected
`fan` works from any folder, git repo or not, since its lanes are read-only answer runs (the `--worktree` variant still needs a repo and can keep failing with a clear message). Crash messages should surface Codex's stderr reason instead of the generic `exited 1`.

### Follow-up
Pass `--skip-git-repo-check` for headless Codex runs that don't need a repo (at least `fan` lanes), or whenever `cwd` is not inside a git work tree. Include the first line of Codex stderr in the lane's `message` in `fan.json`.

### Fix (2026-10-30)
Fix: headless Codex runs always pass `--skip-git-repo-check`, and a crashed agent's message carries the last meaningful stderr line (e.g. "Not inside a trusted directory …").
