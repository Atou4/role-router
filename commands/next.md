---
description: BUILDER+WORKER loop — pick the next planned task and launch build → review → docs through their configured adapters. One supervised iteration.
argument-hint: TASK-XXX (optional — omit to auto-pick the next task)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /next — adapter-driven loop

> **Engine check:** Each stage is a fresh `role-router run ... --headless` process. Builder and Worker may use different harnesses or providers. If `$ARGUMENTS` names an unplanned task, stop and send it back to the Architect.

You are **one supervised iteration** of the build loop. The rule: never start a new task while the previous one's PR is still open and unmerged. Work the steps in order; **stop and report** the moment a gate or guard fails — do not thrash.

Driver: `.agent-board/` repos use the repo's board tool; otherwise use `role-router board` over `PLAN.md`. The status names below are the normalized contract in [`docs/task-spec.md`](../docs/task-spec.md).

## 1. Reconcile finished work → `done`
If the repo uses PRs (`gh` available):
- List recently merged loop PRs: `gh pr list --state merged --search "head:task/" --limit 10 --json number,headRefName`.
- For each merged `task/TASK-XXX` not yet `done`, set it `done` (`board.mjs set-status TASK-XXX done`, or the board tool). This is what unblocks dependents in the graph.

## 2. Guard: is the previous task settled?
If `gh` is available:
- List open loop PRs: `gh pr list --state open --search "head:task/" --json number,headRefName,title,statusCheckRollup,reviewDecision`.
- If an open `task/TASK-XXX` PR exists, **stop** and report its CI + review status. Tell the user to merge/approve (or fix red CI) first. Do not build.
- If one is green + approved but unmerged, offer `gh pr merge --squash` — but wait for the user's go-ahead.

**Fail closed:** the `--search "head:task/"` query is flaky and has returned empty on a network blip. Never treat an errored/uncertain query as "no open PRs." If it fails or you're not certain it succeeded, re-check the latest task PR directly (`gh pr view <n> --json state`) and **halt unless you can positively confirm no open task PR.**

## 3. Branch on status, then pick the task
Look at the board (`board.mjs list`, or the board tool):
- **Any `human_needed` task?** Stop and surface its question — a human must resolve it before the loop continues.
- **Any `gaps_found` task?** That's the priority: re-build it. Take it as the task id and go to step 4 (it re-enters at `/build`).
- **Otherwise pick the next buildable task** — `planned` with every `depends:` task `done`:
  - If `$ARGUMENTS` is given, use it, but verify it's buildable; if its deps aren't `done` or it isn't `planned`, stop and say why.
  - Else `board.mjs next` (or the board tool). If it's `NONE`, every task is `done`, in flight, or blocked — report the queue is drained and stop. Send unplanned work to the Architect Adapter.

> Building **independent** tasks in parallel? Stop here and use `/fan-out` instead — it runs the whole buildable wave at once. `/next` is the **one-at-a-time** path for dependent work.

## 4. Run the pipeline
For the chosen task id, run in sequence — each must pass before the next:
1. **Build:** `role-router run builder <id> --headless`. If it escalates (2× gate fail, status stays `building`), **stop** and surface the escalation; do not continue.
2. **Review:** `role-router run worker <id> --headless`. Read the status it emits: `gaps_found` → stop and report; `human_needed` → stop and surface it; `passed` → continue.
3. **Docs:** `role-router run docs <id> --headless`. It writes the PR body / opens the PR. The task stays `passed` until merge.

## 5. Hand back
Report: the task id, the gate output, the review **status**, and the PR url (if opened). Remind the user the loop is **paused** until that PR is green + human-approved + merged. To continue: merge, then run `/next` again.
