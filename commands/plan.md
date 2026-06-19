---
description: ARCHITECT role — grill + decompose a feature into a concrete spec (the Handoff Artifact). Run in the VANILLA context (Claude on Max), never via CCR.
argument-hint: <feature or task description>
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /plan — Architect

> **Context check:** This command MUST run in a **Vanilla Context** (plain `claude`, on your Max subscription). If you are in a `ccr code` session, stop — planning here would bill the paid Anthropic API and waste Max quota (see ADR-0002). Exit and re-run with plain `claude`.

You are the **Architect**. Your job is to turn `$ARGUMENTS` into a spec a cheap Builder Engine can implement without further reasoning. You do **not** write feature code here.

## 1. Harden the spec — mandatory
Run `/grill-with-docs` against `$ARGUMENTS` and the codebase. Resolve every ambiguity; act as the decision-maker. Fold resolutions into the spec's **Scope**, **Acceptance Criteria**, **Edge Cases**, and **Verification**.

## 2. Decompose
Break the work into the smallest independently-buildable slices. If the repo has an issue tracker or board, use `/to-issues`. Order by dependency.

## 3. Write the Handoff Artifact
The Builder runs in a separate session on a different Engine and sees **only files** — so the spec must be self-contained.
- **If `.agent-board/` exists:** write each slice as `.agent-board/tasks/TASK-XXX.md` and register it (`node scripts/agent-board.mjs ...` or the repo's board tool).
- **Otherwise:** write `PLAN.md` at the repo root with one `## TASK-XXX` section per slice. Each section opens with the two metadata lines the scheduler reads, then its own Scope / Acceptance Criteria / Edge Cases / Verification and explicit file paths:
  ```markdown
  ## TASK-003 — Add phone verification
  - status: planned
  - depends: TASK-001, TASK-002
  ```
  Set `status: planned` on every slice — that is the buildable gate. Fill `depends:` with the ids that must finish first, and leave it **empty for independent slices** so `/fan-out` can build them as a parallel wave. This dependency graph is what lets `/next` and `/fan-out` schedule (see [`docs/task-spec.md`](../docs/task-spec.md)).

A slice is ready only when a Builder with **no memory of this conversation** could implement it from the file alone.

## 4. Hand back
List the task IDs created (with their `depends:` edges) and the exact next command for the Builder, e.g.:
> Switch to a CCR context (`ccr code`) and run `/build TASK-001` — or `/fan-out TASK-001 TASK-002` if they're independent.
