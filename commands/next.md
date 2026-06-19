---
description: BUILDER+WORKER loop — pick the next planned task and run /build → /review → /docs for it. Run in a CCR context (cheap Engines). One supervised iteration.
argument-hint: TASK-XXX (optional — omit to auto-pick the next task)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /next — the CCR-side loop

> **Context check:** Run in a **CCR Context** (`ccr code`). This chains the three cheap-Engine steps; no Architect reasoning happens here. If `$ARGUMENTS` names an un-planned task, stop and tell the user to `/plan` it first in a Vanilla Context — the loop never builds what the Architect hasn't hardened (ADR-0003).

You are **one supervised iteration** of the build loop. The rule: never start a new task while the previous one's PR is still open and unmerged. Work the steps in order; **stop and report** the moment a gate or guard fails — do not thrash.

## 1. Reconcile finished work
If the repo uses PRs (`gh` available) and a board (`.agent-board/`):
- List recently merged loop PRs: `gh pr list --state merged --search "head:task/" --limit 10 --json number,headRefName`.
- For each merged `task/TASK-XXX` whose board task isn't `Done`, mark it Done via the board tool (e.g. `node scripts/agent-board.mjs set-status TASK-XXX Done`). This is what unblocks the next task in the DAG.

If there's no board, skip this step.

## 2. Guard: is the previous task settled?
If `gh` is available:
- List open loop PRs: `gh pr list --state open --search "head:task/" --json number,headRefName,title,statusCheckRollup,reviewDecision`.
- If an open `task/TASK-XXX` PR exists, **stop** and report its CI + review status. Tell the user to merge/approve (or fix red CI) first. Do not build.
- If one is green + approved but unmerged, offer `gh pr merge --squash` — but wait for the user's go-ahead.

**Fail closed:** the `--search "head:task/"` query is flaky and has returned empty on a network blip. Never treat an errored/uncertain query as "no open PRs." If it fails or you're not certain it succeeded, re-check the latest task PR directly (`gh pr view <n> --json state`) and **halt unless you can positively confirm no open task PR.**

## 3. Pick the task
- If `$ARGUMENTS` is given, use it — but verify it's actually planned (a `.agent-board/tasks/$ARGUMENTS.md` exists in the planning-gate state, or a `## $ARGUMENTS` section exists in `PLAN.md`). If it isn't planned, stop: "run `/plan` first in a Vanilla Context."
- Otherwise auto-pick:
  - **Board:** the next task in the planning-gate state (e.g. `node scripts/agent-board.mjs next-ready`). If that's `NONE` but a plain `next` returns a task, the queue only has un-planned (Backlog) work — **stop** and tell the user to `/plan` it. If both are `NONE`, report the board is drained and stop.
  - **PLAN.md:** the first `## TASK-XXX` section with no corresponding merged `task/TASK-XXX` branch. If none remain, report PLAN.md is drained and stop.

## 4. Run the pipeline
For the chosen task id, run in sequence — each must pass before the next:
1. **`/build <id>`** — Builder Engine. If it escalates (2× gate fail), **stop** and surface the escalation; do not continue to review/docs.
2. **`/review <id>`** — switch to the Worker Engine first (`/model openrouter,deepseek/deepseek-v4-flash`). If the verdict is **needs-fixes**, stop and report the Must-fix list; loop back to `/build` only after the user decides.
3. **`/docs <id>`** — Worker Engine. Writes the PR body / opens the PR and moves the task to its review state.

## 5. Hand back
Report: the task id, the gate output, the review verdict, and the PR url (if opened). Remind the user the loop is **paused** until that PR is green + human-approved + merged. To continue: merge, then run `/next` again.
