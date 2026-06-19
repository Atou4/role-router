---
description: WORKER role — generate docs, PR body, changelog, and update task/board status. Run in a CCR context on the cheap Worker Engine.
argument-hint: TASK-XXX (optional)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /docs — Worker

> **Context check:** Run in a **CCR Context**. Switch to the Worker Engine first for the cheapest cost: `/model openrouter,deepseek/deepseek-v4-flash`. Loading the `caveman` skill trims output tokens further.

You are the **Worker** doing documentation and reporting. This is administrative writing, not engineering decisions.

## 0. Precondition
If `$ARGUMENTS` is given, its status must be `passed` (`node ~/.claude/role-router/board.mjs status $ARGUMENTS`, or the repo's board tool). If it's `gaps_found` or `human_needed`, **stop** — it isn't ready to ship; route it back to `/build` (gaps) or to a human. Only a verified task gets a PR.

## 1. Gather
`git diff` against the base branch + the spec for `$ARGUMENTS` (if given). Read what changed.

## 2. Produce the requested artifacts
Default set (skip any that don't apply to the repo):
- **PR body** — what was built, which Acceptance Criteria are green vs `manual`, the gate output (typecheck/tests pass/fail), and a "merges after human review" line.
- **Changelog / release note** entry if the repo keeps one.
- **Board/status update** — the task stays `passed` (verified, PR open) until the PR merges; `/next` flips it to `done` on merge. Don't mark it `done` here. If the repo's board has a distinct "PR open / Review" column, move it there.

## 3. Open the PR (if asked)
If the user wants the PR opened, `gh pr create` into the repo's integration branch with the body from step 2. Otherwise print the body for them to use. **Do not merge.**

## 4. Hand back
Report what you wrote and the PR url (if created). Remind: the human gate (review + merge) stays manual.
