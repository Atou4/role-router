---
description: WORKER role — generate docs, PR body, changelog, and update task/board status using the configured Worker Engine.
argument-hint: TASK-XXX (optional)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /docs — Worker

> **Engine check:** Prefer `role-router run docs $ARGUMENTS`; it uses the configured Worker chain.

You are the **Worker** doing documentation and reporting. This is administrative writing, not engineering decisions.

## 0. Precondition
If `$ARGUMENTS` is given, its status must be `passed` (`role-router board status $ARGUMENTS`, or the repo's board tool). If it's `gaps_found` or `human_needed`, **stop** — it isn't ready to ship; route it back to `/build` (gaps) or to a human. Only a verified task gets a PR.

## 1. Gather
`git diff` against the base branch + the spec for `$ARGUMENTS` (if given). Read what changed. Role Router's run records for this task are in `.role-router/runs/$ARGUMENTS/*.json`: each records which agent built or reviewed it, the result, and git evidence (commit, uncommitted files, diff stat). Use them as evidence; do not paste them raw.

## 2. Produce the requested artifacts
Default set (skip any that don't apply to the repo):
- **PR body** — follow the `pr` skill if it is listed under **Skills for this run**. Otherwise use its shape: a summary as the smallest visual that makes the change clear (call tree, file tree, before/after snippet), before/after evidence that it works (gate output, which Acceptance Criteria are verified vs `manual`), and a merge-danger call (one-way or two-way door, plus blast radius). Note which agents built and reviewed it, and whether the review ran on a different vendor. End with a "merges after human review" line.
- **Changelog / release note** entry if the repo keeps one.
- **Board/status update** — the task stays `passed` (verified, PR open) until the PR merges; `/next` flips it to `done` on merge. Don't mark it `done` here. If the repo's board has a distinct "PR open / Review" column, move it there.

## 3. Open the PR (if asked)
If the user wants the PR opened, `gh pr create` into the repo's integration branch with the body from step 2. Otherwise print the body for them to use. **Do not merge.**

## 4. Hand back
Report what you wrote and the PR url (if created). Remind: the human gate (review + merge) stays manual.
