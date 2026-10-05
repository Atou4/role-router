<div align="center">

# Role Router

**A personal orchestrator for your paid coding agents: Codex, Claude Code and OpenCode.**

Plan on top-tier models, build on lighter ones, fall through to another account when one hits its usage limit, and review on a different vendor than the one that built it. Works in any repo; your sign-ins never leave their own CLIs.

[![Codex](https://img.shields.io/badge/agent-Codex-111)](https://developers.openai.com/codex/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code-d97757)](https://claude.com/claude-code)
[![OpenCode](https://img.shields.io/badge/agent-OpenCode-111)](https://opencode.ai/)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-active-success)](#)

</div>

> **The one rule:** _route on **roles**, not models._ Models change every few months; each role is bound to a swappable chain of your accounts and the workflow never changes. ([ADR-0001](docs/adr/0001-roles-not-engines.md))

```
                 ┌──────────── Architect (top tier) ───────────┐
  "add X"  ───▶  │ openai-top → anthropic-top → (ask) → lighter │ ──▶ PLAN.md: spec + interface sketch + tickets
                 └──────────────────────────────────────────────┘
                 ┌──────────── Builder (lite tier) ────────────┐
  TASK-001 ───▶  │ anthropic-lite → openai-lite → zai-lite → …  │ ──▶ branch + gates + evidence
                 └───── usage limit? pause account, handoff, next profile
                 ┌──────────── Review (other vendor) ──────────┐
                 │ prefers an account that did not build it     │ ──▶ passed / gaps_found / human_needed
                 └──────────────────────────────────────────────┘
```

---

## Contents

- [Why](#why)
- [Roles and chains](#roles-and-chains)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Ship your first feature](#ship-your-first-feature)
- [Command reference](#command-reference)
- [Fallback chains and usage limits](#fallback-chains-and-usage-limits)
- [Multi-model runs: `fan` and pstack](#multi-model-runs-fan-and-pstack)
- [Verification and retro](#verification-and-retro)
- [Skills](#skills)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Docs](#docs)

---

## Why

You pay for several coding agents. Each has usage windows, each is best at something, and none of them talks to the others. Role Router sits above them:

- **Right model for the work.** Planning is rare and high-leverage: top-tier models. Building and admin are the bulk: lighter models.
- **Limits stop being a wall.** When an account runs out mid-task, the work continues on the next account in the chain from a written handoff, and the exhausted account is skipped until it resets.
- **A second pair of eyes from another vendor.** Review prefers a model family other than the one that wrote the code.
- **Deterministic orchestration.** Picking tasks, walking chains, and routing on review status is plain code. Models only do role work.

## Roles and chains

| Role | Does | Command | Default chain (from `role-router configure`) |
|---|---|---|---|
| 🧠 **Architect** | ground, grill, design it twice, spec + interface sketch, tickets | `/plan` | every **top** profile, then lighter ones *only after asking you* |
| 🔨 **Builder** | implement against the sketch, run gates, drive the real app | `/build` | **lite** profiles in your preferred order |
| 🧹 **Worker** | review against spec and sketch; PR body | `/review` `/docs` | same as Builder, preferring another account than the Builder's |
| 🚑 **Escalation** | take over a Builder task stuck after two diagnosed attempts | `/build` | **top** profiles |

A **profile** is an account plus a model plus a tier, e.g. *ChatGPT plan via Codex on `gpt-6-luna` (lite)*. Full vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Prerequisites

| Need | Why | Get it |
|---|---|---|
| **Node.js** ≥ 18 | runs Role Router | <https://nodejs.org> |
| At least one agent, signed in | the work runs there | **Codex**: `npm i -g @openai/codex` then `codex login` · **Claude Code**: <https://claude.com/claude-code> · **OpenCode**: `npm i -g opencode-ai` then `opencode auth login` |
| **git** | branches, worktrees, evidence | preinstalled on most systems |
| **`gh`** *(optional)* | the `/next` prompt reconciles merged PRs | <https://cli.github.com> |

Any paid plan works: ChatGPT Plus/Pro for Codex, Claude Pro/Max for Claude Code, and any provider OpenCode supports (Z.AI, OpenRouter, OpenCode Go, ...).

## Quickstart

```bash
git clone https://github.com/Atou4/role-router.git && cd role-router
./install.sh                 # detects your agents, runs the setup wizard, puts `role-router` on PATH
```

The wizard (`role-router configure`, re-runnable any time):

1. detects which of Codex, Claude Code and OpenCode are installed and signed in, and which OpenCode providers have credentials;
2. asks which accounts to use, with a planning model and an execution model for each (ids are passed to the agent untouched; blank means the agent's default);
3. asks your preferred execution order;
4. shows the resulting chains and writes `~/.role-router/config.json` (an existing config is backed up first).

`role-router configure --print` shows the proposal without writing anything. Then, optionally:

```bash
role-router pstack           # let pstack skills (architect, arena, interrogate, how) run their model panels on your accounts
role-router skills doctor    # check the skills each role uses are installed for every agent
```

> **Authentication guardrail:** Codex and Claude Code run with their own sign-ins; OpenCode uses its provider credentials or the env var you name. Role Router never reads, copies or proxies a token. ([ADR-0005](docs/adr/0005-engine-adapters-separate-harnesses-from-providers.md))

## Ship your first feature

```bash
cd ~/code/my-app

# 1. Plan (interactive): ground, grill, design it twice, approve tickets
role-router run architect "add phone verification to onboarding"

# 2. Build → review → docs, one task at a time, driven by code
role-router next                 # or: role-router next --loop
# …or independent tasks in parallel, each in its own worktree
role-router fanout TASK-002 TASK-003

# 3. Merge the PR yourself; that is the human gate
role-router status               # accounts, board, last runs, pending handoffs
```

What `/plan` produces: a spec with a **Grounding** section (traced subsystems), the caller's **Usage**, an **Interface sketch** (types and signatures with stub bodies), the **Design decision** (chosen shape vs the strongest rejected alternative), and tracer-bullet tickets with `depends:` edges. When the sketch is cross-cutting, the first ticket lands the sketch itself so later tickets build in parallel against a fixed contract. For designs one session cannot settle, `/plan` sends you to `/architect`; for risky ones it recommends `/interrogate` before tickets.

The Builder implements against the sketch and never invents a public type or signature: a needed change sets `human_needed` and stops. Review enforces the sketch and the acceptance criteria and emits the status the loop routes on.

Too big for one planning session? Run `/wayfinder` yourself to chart it, then `/plan <map reference>`. ([ADR-0004](docs/adr/0004-adopt-skills-v1-1-within-role-pipeline.md))

## Command reference

| Command | What it does |
|---|---|
| `role-router configure [--print]` | Setup wizard: accounts, models, chains → `~/.role-router/config.json` |
| `role-router run <role> [arg] [--headless] [--profile=ID] [--dry-run]` | Run one role (`architect`, `builder`, `worker`/`review`, `docs`, `escalation`) through its chain |
| `role-router chat <role> "<message>"` | Same, with your message as the prompt instead of the role workflow |
| `role-router next [TASK] [--loop]` | One build → review → docs iteration, status read from `PLAN.md` after each step |
| `role-router fanout <TASK…> [--concurrency=N] [--base=REF]` | Independent tasks in parallel, one worktree each |
| `role-router fan "<prompt>" [--profiles=a,b] [--worktree]` | One prompt on several models, one answer file each |
| `role-router pstack [--print]` | Point pstack skills' model panels at your profiles |
| `role-router status` | Accounts, chains, board, last run per task, pending handoffs |
| `role-router limits [pause <account> --until=WHEN \| clear <account>]` | Show or edit paused accounts |
| `role-router board <next\|wave\|list\|status\|set-status>` | The `PLAN.md` task driver |
| `role-router skills <doctor\|install\|readme>` | Check and install the skills roles use |

Exit codes for `run`, `chat` and `next`: `0` ok · `1` failed · `2` needs a decision · `3` aborted · `75` every profile limited (retry after the printed reset).

Inside an agent session the same steps exist as prompts: `/plan`, `/build`, `/review`, `/docs`, `/next` (also reconciles merged PRs via `gh`) and `/fan-out`.

## Fallback chains and usage limits

What happens in a headless run (`--headless`, and everything `next`, `fanout` and `fan` launch):

- **Usage limit hit** → that *account* is paused until its reset time (or `cooldownMinutes`), a `handoff.md` is written under `.role-router/runs/<task>/`, and the next profile continues. The worktree is kept as is.
- **Transient 429** → the same profile is retried a couple of times, then the chain moves on.
- **Planning roles never silently drop to a lighter model**: interactively you choose *wait / switch / abort*; headless it exits `2`. A plan made on a lighter model is marked `plan-tier: lite`.
- **Reviews** prefer an account other than the one that built the task, and ask before reviewing on the same one.
- **Every profile limited** → exit `75` with the earliest reset time.

Limits are detected automatically only in headless runs. After hitting one in an interactive session:

```bash
role-router limits                                 # which accounts are paused
role-router limits pause anthropic --until=17:30   # or +90m, +2h, an ISO date
role-router limits clear anthropic
```

**Continuity.** Files and git carry the state, not the agent's session:

- `handoff.md` is written when a run ends on a limit or a crash: acceptance criteria split into verified and still open, `git` commands to re-read the live state, and an instruction to run the gates before new work.
- When the *same* profile returns after its account resets, it resumes its own session (`claude --resume`, `codex exec resume`, `opencode --session`); if that fails it starts fresh from the handoff.
- Every headless run leaves `.role-router/runs/<task>/NNN-<profile>.json` (+ `.jsonl` events): agent, result, tokens or cost when reported, and **evidence** the orchestrator observed itself (commit, uncommitted files, diff stat).

Design: [ADR-0006](docs/adr/0006-account-aware-fallback-chains.md), [dispatch.md](docs/design/dispatch.md).

## Multi-model runs: `fan` and pstack

Skills that compare model families (`architect`, `arena`, `interrogate`, `how`) need runners on *different* models. Inside Claude Code a subagent can only be Claude. `fan` runs one prompt on several of your profiles in parallel instead, through the same dispatcher, so limits and run records apply:

```bash
role-router fan --list                                   # default lanes: one top profile per account
role-router fan "Review this design: ..."                # one answer per model
role-router fan --profiles=openai-top,anthropic-top --prompt-file=task.md
role-router fan --worktree --prompt-file=candidate.md    # each lane writes in its own detached worktree
```

Answers land in `.role-router/fan/<stamp>/<profile>.md`, indexed by `fan.json`.

**pstack integration.** The pstack skills choose runners, reviewers and judges from `~/.cursor/rules/pstack-models.mdc` when it exists. `role-router pstack` writes that rule with your profiles (`role-router:openai-top, role-router:anthropic-top, ...`) and tells the agent to run those lanes through `fan` instead of spawning same-vendor subagents. Panels get one top profile per account; judges and explainers get your strongest planning profile; explorers and workers get your preferred execution profile. Re-run it after `role-router configure`. An existing rule is backed up first.

## Verification and retro

- **Repo verification skill.** If a repo has a `verify-<app>` skill (made by `/create-verification-skill`, in `.cursor/`, `.claude/`, `.agents/` or `.opencode/skills/`), dispatch hands it to the Builder, Escalation and Review roles. The Builder must drive the changed feature in the real app and record evidence; Review re-drives at least one user-visible criterion.
- **Retro.** `role-router next` ends a passed task by suggesting `/retro`; when a task needed more than one review round it says so, so the repeated finding becomes a lint rule, hook or CI check instead of another round.

`.role-router/` in each repo carries its own `.gitignore`, so run state never shows in `git status`.

## Skills

Each role run is **handed its skills by dispatch**, not left to guess. [`skills-manifest.json`](skills-manifest.json) lists each role's core and optional skills; dispatch keeps only those the target agent can read, caps the set at 6, adds the repo's verification skill where relevant, and appends their `SKILL.md` paths to the prompt. Paths work the same on all three agents.

| Role | Core | Plus |
|---|---|---|
| Architect | `grilling`, `domain-modeling`, `codebase-design` | `prototype`, `research` |
| Builder / Escalation | `tdd`, `diagnosing-bugs` (+ `codebase-design` for Escalation) | repo `verify-<app>` |
| Review | `code-review` | repo `verify-<app>` |
| Docs | `pr` | |

A role only gets skills the model is allowed to load. User-only skills (`architect`, `arena`, `interrogate`, `how`, `why`, `blast-radius`, `wayfinder`, ...) are never called by a role; the role prompt tells *you* when to run them. Stack-specific rule skills are deliberately not part of the setup (add a `stacks` entry to the manifest to bring one back).

[`catalog/`](catalog/README.md) lists every skill this workflow uses with its upstream source, generated from [`catalog/skills.json`](catalog/skills.json).

```bash
role-router skills doctor              # per agent: missing role skills, user-only in a role, diverged copies, list size
role-router skills install all         # or: architect | builder | review | docs | human | <group>
role-router skills readme              # regenerate catalog/README.md
```

Installs target Claude Code, Codex and OpenCode together (`~/.agents/skills`, symlinked into `~/.claude/skills`). The doctor never touches skills outside the role set.

## Configuration

`~/.role-router/config.json` (v2), as the wizard writes it:

```jsonc
{
  "version": 2,
  "accounts": {
    "openai":    { "agent": "codex" },
    "anthropic": { "agent": "claude" },
    "zai":       { "agent": "opencode", "provider": "zai-coding-plan", "keyEnv": "ZAI_API_KEY" }
  },
  "profiles": {
    "openai-top":     { "account": "openai",    "model": "gpt-6-sol",  "tier": "top" },
    "openai-lite":    { "account": "openai",    "model": "gpt-6-luna", "tier": "lite" },
    "anthropic-top":  { "account": "anthropic", "model": "opus",       "tier": "top" },
    "anthropic-lite": { "account": "anthropic", "model": "sonnet",     "tier": "lite" },
    "zai-lite":       { "account": "zai",       "model": "zai-coding-plan/glm-4.7", "tier": "lite" }
  },
  "roles": {
    "architect":  { "chain": ["openai-top", "anthropic-top", "anthropic-lite", "openai-lite", "zai-lite"], "onTierDrop": "ask" },
    "builder":    { "chain": ["anthropic-lite", "openai-lite", "zai-lite", "anthropic-top", "openai-top"], "onTierDrop": "auto" },
    "worker":     { "chain": ["anthropic-lite", "openai-lite", "zai-lite", "anthropic-top", "openai-top"], "onTierDrop": "auto", "avoidBuilderAccount": true, "onSameAccountReview": "ask" },
    "escalation": { "chain": ["openai-top", "anthropic-top"], "onTierDrop": "ask" }
  },
  "defaults": { "cooldownMinutes": 60, "transientRetries": 2 }
}
```

Edit it freely or re-run `role-router configure`. Model ids are opaque: any id your plan offers works on release day. Usage limits are tracked per **account**, so all profiles of an exhausted plan pause together. Version 1 configs (one adapter per role) still load and are upgraded in memory.

## How it works

- **Dispatch** (`lib/dispatch.mjs`) is the single entry point: resolve the role's chain, skip paused accounts, ask before a tier drop, hand over skills, launch the agent, classify the result, then pause and hand off or return. No model participates in these decisions.
- **Agents** (`lib/agents/`) own everything specific to one CLI: launch flags, headless event format, limit-message parsing, session ids for resume. Adding one is one file.
- **State crosses roles through files**: the `PLAN.md` spec and status, git, handoffs and run records. A Builder on another vendor never needs the Architect's context. ([ADR-0003](docs/adr/0003-split-pipeline-per-role.md))
- **The loop** (`lib/next.mjs`) reads task status after each step and stops at `gaps_found`, `human_needed`, a limit or a crash. It never merges.

## FAQ

<details>
<summary><strong>Can OpenCode spend my ChatGPT or Claude subscription?</strong></summary>

No. Codex and Claude Code run with their own sign-ins. OpenCode uses its own provider credentials or the env var named in `keyEnv`.
</details>

<details>
<summary><strong>A run exited 75. What now?</strong></summary>

Every profile in that role's chain is limited. The message prints the earliest reset; `role-router status` shows the paused accounts and any handoff. Re-run after the reset: the same profile resumes its own session, or the next one continues from the handoff.
</details>

<details>
<summary><strong>Why did planning stop and ask me about a lighter model?</strong></summary>

All top-tier planning profiles are limited. Planning quality is the point of the top tier, so dropping it is your call: wait for the reset, switch (the plan is marked `plan-tier: lite` for re-review), or abort.
</details>

<details>
<summary><strong><code>/build</code> says the model is unauthorized / 401</strong></summary>

For an OpenCode profile, check the env var named in the account's `keyEnv`, or run `opencode auth login`. For Codex run `codex login`; for Claude Code, `claude auth login`.
</details>

<details>
<summary><strong>Do I have to use <code>PLAN.md</code>?</strong></summary>

No. If your repo has an `.agent-board/`, the role prompts use its board tool instead. `PLAN.md` + `role-router board` is the portable default.
</details>

## Docs

- [`GLOSSARY.md`](GLOSSARY.md): the shared vocabulary (Role, Profile, Account, Tier, Chain, Usage Limit, Handoff Artifact, Fan, Fan-out, ...).
- [`docs/adr/`](docs/adr/): the load-bearing decisions and why; [ADR-0006](docs/adr/0006-account-aware-fallback-chains.md) covers chains and limits.
- [`docs/design/dispatch.md`](docs/design/dispatch.md): the dispatcher's design rationale.
- [`docs/task-spec.md`](docs/task-spec.md): task format, status contract and `depends:` scheduling.
- [`catalog/README.md`](catalog/README.md): every skill the workflow uses, with sources.
- [`docs/comparison-gsd.md`](docs/comparison-gsd.md): comparison with GSD Core. [`docs/HANDOFF.md`](docs/HANDOFF.md) is a historical snapshot of the CCR era.

## Contributing

Issues and PRs welcome. Before adding a command, check it can't be expressed as a role plus a chain change. Keep `GLOSSARY.md` authoritative: define new terms there.

**Tests.** `node --test test/` runs the unit suite in seconds and never launches an agent. `node e2e/run.mjs` is the testing ground: it builds a throwaway sandbox repo with its own config and limits ledger (your `~/.role-router` is never touched) and drives the real CLIs end to end: chains and skills, pstack, tier consent, `fan` on all three agents, a full `next` loop, a simulated usage limit with handoff and fallback, and parallel `fanout`. It spends a little real usage on your accounts; `--only=setup,pstack,tier` runs the free scenarios.

## License

No license file yet. MIT is recommended. The skill catalog only *references* upstream skills under their own licenses; it does not redistribute them.
