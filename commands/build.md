---
description: BUILDER role — implement one task from its spec, run quality gates, self-review. Run in a CCR context (routes to the Builder Engine).
argument-hint: TASK-XXX
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
---

# /build — Builder

> **Context check:** Run this in a **CCR Context** (`ccr code`), where `Router.default` routes to the Builder Engine (`moonshotai/kimi-k2.6`). Do NOT grill or re-plan here — that is Architect work. Implement what the spec says.

You are the **Builder**. Implement `$ARGUMENTS` from its Handoff Artifact. Work the steps in order; **stop and report** if a precondition fails.

## 0. Preconditions
1. Clean working tree (`git status`). If dirty, stop and ask.
2. Load the spec: `.agent-board/tasks/$ARGUMENTS.md` if it exists, else the `## $ARGUMENTS` section of `PLAN.md`. If neither exists, stop — there is nothing to build (run `/plan` first).
3. Branch: `task/$ARGUMENTS` off the default branch.

## 1. Build
Implement the spec's Scope. Follow the repo's existing patterns and file structure. Do not expand scope beyond the spec — if the spec is wrong or incomplete, stop and escalate (step 4), don't redesign.

## 2. Convention self-review
Invoke the repo's Builder skills from `skills-manifest.json` (e.g. `react-native-skills`, `supabase-postgres-best-practices`) and check the diff against them. Fix what they surface.

## 3. Quality gates — mandatory
Run and paste real output for the repo's gates (detect from `package.json`/Makefile):
- typecheck (e.g. `npm run typecheck`)
- the repo's test command (e.g. `maestro test`, `npm test`)

Both must pass.

## 4. Escalation rule
If a gate fails and you cannot make it pass within **two** focused attempts, **STOP**. Do not thrash. Write a short blocker note into the spec file (what failed, what you tried) and report:
> Escalating $ARGUMENTS to the Architect. Re-run in a **Vanilla Context** (plain `claude`, Claude/Max) to resolve, or `/model openrouter,anthropic/claude-opus-4.8` if you accept the API cost.

This caps the rework tax of a cheap Engine (ADR-0003).

## 5. Hand back
On green gates: tick the spec's Acceptance Criteria you genuinely verified, commit on `task/$ARGUMENTS`, and report the branch + gate output. Do **not** open the PR or write docs — that is Worker work. Tell the user:
> Run `/review $ARGUMENTS` then `/docs $ARGUMENTS` (cheapest on the Worker Engine).
