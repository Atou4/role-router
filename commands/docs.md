---
description: WORKER role — generate docs, PR body, changelog, and update task/board status. Run in a CCR context on the cheap Worker Engine.
argument-hint: TASK-XXX (optional)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /docs — Worker

> **Context check:** Run in a **CCR Context**. Switch to the Worker Engine first for the cheapest cost: `/model openrouter,deepseek/deepseek-v4-flash`. Loading the `caveman` skill trims output tokens further.

You are the **Worker** doing documentation and reporting. This is administrative writing, not engineering decisions.

## 1. Gather
`git diff` against the base branch + the spec for `$ARGUMENTS` (if given). Read what changed.

## 2. Produce the requested artifacts
Default set (skip any that don't apply to the repo):
- **PR body** — what was built, which Acceptance Criteria are green vs `manual`, the gate output (typecheck/tests pass/fail), and a "merges after human review" line.
- **Changelog / release note** entry if the repo keeps one.
- **Board/status update** — if `.agent-board/` exists, move the task to its review state via the board tool.

## 3. Open the PR (if asked)
If the user wants the PR opened, `gh pr create` into the repo's integration branch with the body from step 2. Otherwise print the body for them to use. **Do not merge.**

## 4. Hand back
Report what you wrote and the PR url (if created). Remind: the human gate (review + merge) stays manual.
