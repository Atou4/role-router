---
description: WORKER role — review the current diff against conventions and skills through the configured Worker adapter.
argument-hint: TASK-XXX (optional)
allowed-tools: Bash, Read, Glob, Grep, Skill, Agent
---

# /review — Worker

> **Engine check:** Prefer `role-router run worker $ARGUMENTS`; it launches the configured Worker Adapter. This is read/critique work, so bind it to your cheaper engine.

You are the **Worker** doing review. Review the diff, do not change code.

## 1. Scope the diff
`git diff` against the base branch (default branch). If `$ARGUMENTS` is given, also read its spec (`.agent-board/tasks/$ARGUMENTS.md` or the `PLAN.md` section) to check the diff actually satisfies the Acceptance Criteria.

## 2. Review
- Use the `code-review` skill and any stack rule skills listed under **Skills for this run**. Run its Standards and Spec axes independently, including the refactoring-smell baseline, then map any hard failure to the normalized status below.
- **Interface sketch:** if the spec has one, the diff must implement it as written. A public type, signature, or module boundary that differs from the sketch is a Must-fix unless the spec records an approved change.
- **Requirement coverage, not just a diff scan:** go through every Acceptance Criterion / REQ-ID in the spec and confirm the diff actually implements it. A criterion ticked-but-unverified is a Must-fix.
- Also check: convention violations, obvious correctness or security issues.
- **Risk flag:** if the diff touches money, auth or permissions, data migrations, a status/enum mapping, or anything another repo reads, add a **Risk** line to the report recommending the user run `/blast-radius` on it before merge. This is a recommendation for the human, not a status change.

## 3. Report
Output a tight findings list grouped **Must-fix / Should-fix / Nit**, each with `file:line`.

## 4. Emit the status — this is the point of the command
The loop routes on your **status**, not your prose. End by writing exactly one (`role-router board set-status $ARGUMENTS <status>`, or the repo's board tool):

| Status | When |
|---|---|
| `passed` | every Acceptance Criterion is met, no Must-fix findings → ready for `/docs` |
| `gaps_found` | one or more **Must-fix** findings (incl. an uncovered criterion) → goes back to `/build` |
| `human_needed` | the diff raises a question only a human can settle (product decision, risky migration, ambiguous spec) |

State the chosen status on its own line. Do not open or edit anything else. If `$ARGUMENTS` wasn't given (ad-hoc review of the working tree), skip the write and just print the status word. See [`docs/task-spec.md`](../docs/task-spec.md).
