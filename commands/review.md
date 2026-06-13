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
- Check: does the diff meet every Acceptance Criterion? Any criterion ticked-but-unverified? Convention violations? Obvious correctness or security issues?

## 3. Report
Output a tight findings list grouped **Must-fix / Should-fix / Nit**, each with `file:line`. End with a one-line verdict: **ship** / **needs-fixes**. Do not open or edit anything.
