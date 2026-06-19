---
description: WORKER role — review the current diff against conventions and skills. Run in a CCR context on the cheap Worker Engine.
argument-hint: TASK-XXX (optional)
allowed-tools: Bash, Read, Glob, Grep, Skill
---

# /review — Worker

> **Context check:** Run in a **CCR Context**. For the cheapest cost, switch to the Worker Engine first: `/model openrouter,deepseek/deepseek-v4-flash`. This is read/critique work — a cheap Engine handles it well.

You are the **Worker** doing review. Review the diff, do not change code.

## 1. Scope the diff
`git diff` against the base branch (default branch). If `$ARGUMENTS` is given, also read its spec (`.agent-board/tasks/$ARGUMENTS.md` or the `PLAN.md` section) to check the diff actually satisfies the Acceptance Criteria.

## 2. Review
- Invoke the repo's review skills (`code-review`, `simplify`, and any stack rule skills like `supabase-postgres-best-practices`).
- **Requirement coverage, not just a diff scan:** go through every Acceptance Criterion / REQ-ID in the spec and confirm the diff actually implements it. A criterion ticked-but-unverified is a Must-fix.
- Also check: convention violations, obvious correctness or security issues.

## 3. Report
Output a tight findings list grouped **Must-fix / Should-fix / Nit**, each with `file:line`.

## 4. Emit the status — this is the point of the command
The loop routes on your **status**, not your prose. End by writing exactly one (`node ~/.claude/role-router/board.mjs set-status $ARGUMENTS <status>`, or the repo's board tool):

| Status | When |
|---|---|
| `passed` | every Acceptance Criterion is met, no Must-fix findings → ready for `/docs` |
| `gaps_found` | one or more **Must-fix** findings (incl. an uncovered criterion) → goes back to `/build` |
| `human_needed` | the diff raises a question only a human can settle (product decision, risky migration, ambiguous spec) |

State the chosen status on its own line. Do not open or edit anything else. If `$ARGUMENTS` wasn't given (ad-hoc review of the working tree), skip the write and just print the status word. See [`docs/task-spec.md`](../docs/task-spec.md).
