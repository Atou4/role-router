---
description: BUILDER role — implement one task from its spec, run quality gates, self-review. Launch through the configured Builder adapter.
argument-hint: TASK-XXX
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /build — Builder

> **Engine check:** Prefer `role-router run builder $ARGUMENTS`. The adapter selects Codex, Claude Code, or OpenCode from `~/.role-router/config.json`. Do NOT grill or re-plan here — that is Architect work.

You are the **Builder**. Implement `$ARGUMENTS` from its Handoff Artifact. Work the steps in order; **stop and report** if a precondition fails.

## 0. Preconditions
1. Clean working tree (`git status`). If dirty, stop and ask.
2. Load the spec: `.agent-board/tasks/$ARGUMENTS.md` if it exists, else the `## $ARGUMENTS` section of `PLAN.md`. If neither exists, stop — there is nothing to build (run `/plan` first).
3. Check the status is buildable — `planned` (or `gaps_found`, a re-fix) with every `depends:` task `done`: `role-router board status $ARGUMENTS` (or the repo's board tool). If it isn't buildable, stop and say which dependency is open. See [`docs/task-spec.md`](../docs/task-spec.md).
4. Branch: `task/$ARGUMENTS` off the default branch.
5. Mark it building: `role-router board set-status $ARGUMENTS building` (or move it to the repo board's "In Progress").

## 1. Build
Implement the spec's Scope. Follow the repo's existing patterns and file structure. Do not expand scope beyond the spec — if the spec is wrong or incomplete, stop and escalate (step 4), don't redesign.

Use `/tdd` where the spec's Testing Decisions define a pre-agreed seam: one failing behavior test, the minimum implementation to pass it, then the next vertical slice. Do not invent or ask the user to approve a new test seam in this Builder context; a missing seam is a spec gap to escalate. Run focused tests and typechecking regularly, then the full suite once at the end. Leave refactoring findings for the independent `/review` gate; if review returns `gaps_found`, fix them in the next `/build` pass.

## 2. Convention self-review
Invoke the repo's Builder skills from `skills-manifest.json` (e.g. `react-native-skills`, `supabase-postgres-best-practices`) and check the diff against them. Fix what they surface.

## 3. Quality gates — mandatory
Run and paste real output for the repo's gates (detect from `package.json`/Makefile):
- typecheck (e.g. `npm run typecheck`)
- the repo's test command (e.g. `maestro test`, `npm test`)

Both must pass.

## 4. Escalation rule
If a gate fails and you cannot make it pass within **two** focused attempts, **STOP**. Do not thrash. Write a short blocker note into the spec file (what failed, what you tried), leave the status `building` (do **not** advance it to `review`), and report:
> Escalating $ARGUMENTS. Run `role-router run escalation $ARGUMENTS`; the configured Escalation Adapter determines its authentication and billing.

This caps the rework tax of a cheap Engine (ADR-0003).

## 5. Hand back
On green gates: tick the spec's Acceptance Criteria you genuinely verified, commit on `task/$ARGUMENTS`, and advance the status to `review`: `role-router board set-status $ARGUMENTS review` (or the repo board's review column). Report the branch + gate output. Do **not** open the PR or write docs — that is Worker work. Tell the user:
> Run `/review $ARGUMENTS` then `/docs $ARGUMENTS` (cheapest on the Worker Engine).
