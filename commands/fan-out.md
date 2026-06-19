---
description: BUILDER fan-out — run many INDEPENDENT planned tasks as parallel Builders, each in a fresh-context headless agent + its own git worktree, routed to the cheap Engine. Run in a CCR context.
argument-hint: TASK-001 TASK-002 …  (or omit to auto-pick a wave of independent Ready tasks)
allowed-tools: Bash, Read, Glob, Grep
---

# /fan-out — parallel Builders

> **Context check:** the orchestration runs in a **CCR Context**, but the real work happens in **N headless `claude -p` child processes** that `scripts/fan-out.mjs` spawns — each a brand-new main agent with a **fresh 200k window** and full tool access. The script points every child at the CCR proxy, so all the parallel Builders bill to the cheap Engine, not Max (that routing is the only reason we don't just use the upstream `nested-subagent` plugin verbatim — its children would run on your Max quota).

Use this instead of `/next` when you have **several tasks with no dependencies on each other** and want them built at once. Sequential dependent work still belongs to `/next`.

## 0. Preconditions — verify, then stop if any fail
1. **CCR is running.** `scripts/fan-out.mjs` pre-flights the proxy and refuses to start otherwise; you can confirm with `ccr status`.
2. **The tasks are planned.** Fan-out only *builds* — it never plans. Each id must already be hardened by the Architect (a board task in the planning-gate state, or a `## TASK-XXX` section in `PLAN.md`). If any id isn't planned, stop: "run `/plan` first in a Vanilla Context."
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
- runs `/build <id>` headless with `--dangerously-skip-permissions` so its gates run unattended,
- streams to `.role-router/runs/<id>.jsonl`.

The script prints a per-task ✓/✗ summary with estimated cost.

## 3. Hand back
Report the summary table: which tasks went green, which failed (with the failing stage), the total estimated cost, and the branch + worktree per task. Then tell the user the next step per built task:
> Review each branch — `/review <id>` then `/docs <id>` (Worker Engine) — or open PRs. Remove a finished worktree with `git worktree remove .role-router/worktrees/<id>`.

A failed child is **not** an escalation by itself — point at its `.jsonl` log; the user decides whether to retry it or fall back to a supervised `/next`. Do **not** auto-merge anything; the human gate stays manual.
