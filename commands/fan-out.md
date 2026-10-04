---
description: BUILDER fan-out — run independent planned tasks in parallel through the configured Builder adapter, each with a fresh context and worktree.
argument-hint: TASK-001 TASK-002 …  (or omit to auto-pick a wave of independent Ready tasks)
allowed-tools: Bash, Read, Glob, Grep
---

# /fan-out — parallel Builders

> **Engine check:** each child runs through `run-role.mjs` using the Builder binding in `~/.role-router/config.json`. It may launch Codex or OpenCode; no subscription credential is proxied or copied.

Use this instead of `/next` when you have **several tasks with no dependencies on each other** and want them built at once. Sequential dependent work still belongs to `/next`.

## 0. Preconditions — verify, then stop if any fail
1. **The Builder adapter is ready.** Fan-out validates the role config and the selected harness performs its own authentication preflight.
2. **The tasks are planned.** Fan-out only builds. If any id is not planned, stop and send it through the Architect Adapter first.
3. **The tasks are independent.** If two ids touch the same files or one depends on the other, do **not** fan them out together — build them in order with `/next`. When unsure, check each spec's scope/`depends:` and say which ids you excluded and why.

## 1. Pick the wave
- If the user passed ids, use exactly those (after the independence check above).
- Otherwise compute the buildable wave: `node ~/.claude/role-router/board.mjs wave` (or the repo's board tool) returns every `planned` task whose `depends:` are all `done`. The driver guarantees dependency-independence; **you** still drop any two that touch the same files (it can't see file overlap). Report the wave you chose, and anything you dropped + why, before launching.

## 2. Launch
Run the spawner with a sensible concurrency cap (default 3; raise only if the machine and your OpenRouter rate limits allow):

```bash
# installed location (works in any repo — it operates on the current git root):
node ~/.claude/role-router/fan-out.mjs --concurrency=3 --base=origin/dev TASK-001 TASK-002 TASK-003
# (inside the role-router repo itself it's scripts/fan-out.mjs)
```

Each child:
- gets its own git worktree under `.role-router/worktrees/<id>` on branch `task/<id>` (parallel builds never clobber each other),
- runs the Builder role headlessly through its configured adapter,
- streams to `.role-router/runs/<id>.jsonl`.

The script prints a per-task ✓/✗ summary with estimated cost.

## 3. Hand back
Report the summary table: which tasks went green, which failed (with the failing stage), the total estimated cost, and the branch + worktree per task. Then tell the user the next step per built task:
> Review each branch — `/review <id>` then `/docs <id>` (Worker Engine) — or open PRs. Remove a finished worktree with `git worktree remove .role-router/worktrees/<id>`.

A failed child is **not** an escalation by itself — point at its `.jsonl` log; the user decides whether to retry it or fall back to a supervised `/next`. Do **not** auto-merge anything; the human gate stays manual.
