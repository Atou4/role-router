# Dispatch: account-aware fallback across paid agents

Design rationale for [ADR-0006](../adr/0006-account-aware-fallback-chains.md). Implemented in `lib/`; tests in `test/`.

## Problem

Role Router launches one fixed agent per Role. Every paid plan behind those agents (ChatGPT Plus/Pro for Codex, Claude Pro/Max for Claude Code, a Z.AI or similar plan for OpenCode) has usage windows, so a run that hits a limit simply dies and the user restarts it by hand on another tool. We want each Role to walk an ordered chain of agent+model profiles, skip exhausted accounts, and hand partial work to the next profile — while planning stays on top-tier models unless the user explicitly accepts a lighter one.

Constraints from the existing system:

- Prompts stay in `commands/*.md`; any agent must be able to run any Role.
- `PLAN.md` + `board.mjs` own task status. Dispatch must not invent statuses.
- Credentials never pass through Role Router (ADR-0005). Agents keep their own sign-ins.
- Limits belong to an **Account**, not a model: an exhausted Claude plan blocks Opus and Sonnet together.
- Interactive sessions inherit the terminal, so their output cannot be parsed. Only headless runs can detect limits automatically.
- `fan-out.mjs` currently parses Claude-shaped `{"type":"result"}` events for every agent, which is already wrong for Codex and OpenCode.

## Usage (caller's view)

```text
$ role-router run architect "add phone verification"
  codex-top   OpenAI account paused until 17:40 (usage limit)
  claude-top  Anthropic account paused until 19:00 (usage limit)
All top-tier planners are limited.
  [w] wait   earliest reset 17:40 (codex-top)
  [s] switch to codex-lite (gpt-6-luna); the plan is flagged for re-review
  [a] abort
> s

$ role-router fanout TASK-004 TASK-005
✓ TASK-004  claude-mid
✓ TASK-005  claude-mid → usage limit → handoff → codex-lite

$ role-router limits
openai     ok
anthropic  paused until 19:00   usage limit, seen on TASK-005
zai        ok

$ role-router limits pause openai --until 18:00   # after an interactive session hit a limit
$ role-router limits clear anthropic
```

In-process callers (`run-role.mjs`, `fan-out.mjs`, later `next`):

```js
import { dispatch } from '../lib/dispatch.mjs';

// one-off / interactive
const outcome = await dispatch({ role: 'architect', message: feature, mode: 'interactive', cwd });

// fan-out lane: no child process, no event parsing in the scheduler
const outcome = await dispatch({ role: 'builder', task: id, mode: 'headless', cwd: worktree });
if (outcome.status === 'waiting') report(`${id} paused until ${outcome.resumeAt}`);
```

## Shape

**Data.** `Config` (v2) = `accounts` (which agent + credentials hint) → `profiles` (account + model + tier) → `roles` (ordered `chain` of profile ids + `onTierDrop` policy). v1 configs are upgraded on load: each v1 binding becomes one account, one profile, and a chain of one.

**Flow.** `dispatch(request)`:

1. Resolve the Role's chain; when the Role is `worker` and a task is given, move profiles on the builder's account to the end (cross-vendor review).
2. Drop profiles whose account the ledger says is paused.
3. If the first usable profile has a lower tier than the chain head and the Role's policy is `ask`: on a TTY, prompt *wait / switch / abort*; headless, return `needs_choice`.
4. Launch the profile's agent. Headless runs stream events into the agent's classifier, which yields an `AgentResult`.
5. `rate_limited` → retry the same profile with backoff (`transientRetries`). `usage_limit` → pause the account in the ledger, write `handoff.md`, continue with the next profile (re-checking step 3). `ok` / `crashed` → record and return.
6. Chain exhausted → `waiting` with the earliest `resumeAt`.

**Public surface.** Three modules:

| Module | Exports | Hides |
|---|---|---|
| `lib/dispatch.mjs` | `dispatch(request) → Outcome` | chain walk, tier consent, retries, agent launch flags, event parsing, run records, handoff writing |
| `lib/config.mjs` | `loadConfig()` | file location, v1→v2 upgrade, validation |
| `lib/accounts.mjs` | `accountStates()`, `pauseAccount()`, `clearAccount()` | ledger file, merge rules under concurrent writers |

`lib/agents/*.mjs` and `lib/runs.mjs` are private to dispatch. An agent module owns *everything* specific to one CLI: flags, model flag spelling, headless event format, and limit-message parsing (per information-hiding). Adding ACP later is one more file in `lib/agents/`.

**Load-bearing decisions.**

- *No model in the coordination loop.* Chain walking, consent, and retries are plain code; agents only do Role work.
- *Dispatch never touches task status.* The Builder prompt already sets `building`/`review`; on `waiting` the task stays `building` and the next Builder run finds `handoff.md` and resumes.
- *Handoff is written by the orchestrator, not the dying agent.* It contains the task spec path, `git diff --stat`, the last assistant messages from the run log, and the limit reason. No model call.
- *The ledger is user-wide* (`~/.role-router/state/accounts.json`) because a limit hit in one repo applies to all of them.
- *Unknown reset time* → pause for `cooldownMinutes` (default 60) rather than guess.

## Synthesis decision

Arena runners were not available in this session, so the two candidates were drafted inline and screened against the red-flag list.

- **Base: A — in-process dispatcher with per-agent classifiers.** One deep entry point; agent specifics live behind a small private interface.
- **Adapted from B (CodePass-style PTY supervisor):** the handoff file format and the "switch on limit, keep going" behaviour.
- **Rejected from B:** scraping a live terminal. It needs a native PTY dependency, misreads output that only *mentions* limits, and still cannot tell a plan limit from a transient 429.

## Tradeoffs accepted

- We accept no automatic detection in interactive sessions in exchange for not wrapping agents in a PTY; `role-router limits pause` covers it manually.
- We accept limit detection by message patterns per agent, which can break when a CLI rewords its errors, in exchange for supporting all three agents today. Fixtures in `test/fixtures/<agent>/` pin each pattern.
- We accept a last-writer-merge ledger (pauses only ever extend) instead of file locking, because parallel lanes may write at once.
- We accept that a lighter-tier plan is flagged by a `plan-tier: lite` line the Architect prompt is told to write, rather than by parsing the plan.

## Alternatives considered

- **B — PTY supervisor** (above): broader coverage including interactive sessions, but exposes fragile text matching as the core mechanism and adds a native dependency.
- **C — Delegate fallback to each harness** (`claude --fallback-model`, OpenCode provider fallbacks): zero code, but cannot cross vendors, shares no ledger, and Claude's flag covers overload rather than plan limits.
- **D — ACP via acpx as the only agent layer:** one event schema, but ACP's `stopReason` has no usage-limit value, Claude and Codex need third-party wrappers, and subscription auth through those wrappers is unverified. Kept as a future `lib/agents/acp.mjs`.

## Decisions from review

- **Model ids are opaque.** Profiles pass `model` to the agent untouched, so any family (GPT-6, 6.1, Claude, GLM, ...) works without a Role Router release. An unknown id surfaces as the agent's own error, classified `crashed`.
- **A builder that exhausts its whole chain leaves its worktree as is.** The task stays `building`; the next Builder run resumes from `handoff.md`.
- **Review on the Builder's account asks first** (`onSameAccountReview: "ask"`). Headless, it returns `needs_choice` instead of reviewing silently.

## Open questions and risks

- Success output of Codex and Claude Code is captured as fixtures; real *limit* output is not. Limit patterns come from public docs, so add fixtures under `test/fixtures/<agent>/` the first time each account hits a limit.
- `fanout` worktree creation and resume was not exercised live, only `dispatch()` itself.
- Native resume is verified live for Claude Code and Codex; OpenCode's `--session` is untested (no stored login available when written).
- `role-router next` does not reconcile merged PRs or guard against open PRs; that remains in the `/next` prompt.

## Next implementation step

Implement `lib/agents/codex.mjs` classifier against captured `codex exec --json` fixtures, then `dispatch` for a single-profile chain, then fallback.
