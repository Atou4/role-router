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

# 3. A passed task opens its PR by itself (GitHub); merging it is the human gate
role-router status               # accounts, board, last runs, pending handoffs
```

What `/plan` produces: a spec with a **Grounding** section (traced subsystems), the caller's **Usage**, an **Interface sketch** (types and signatures with stub bodies), the **Design decision** (chosen shape vs the strongest rejected alternative), and tracer-bullet tickets with `depends:` edges. When the sketch is cross-cutting, the first ticket lands the sketch itself so later tickets build in parallel against a fixed contract. For a design one session cannot settle, `/plan` offers a **multi-model design round**: with your OK it sends architect's runner brief to one top profile per account through `fan --worktree`, each model writes an independent design package, and `/plan` scores them against a rubric, picks a base, grafts the best ideas from the others and records the synthesis decision. No code is written. For risky designs it also recommends `/interrogate` before tickets.

The Builder implements against the sketch and never invents a public type or signature: a needed change sets `human_needed` and stops. Review enforces the sketch and the acceptance criteria and emits the status the loop routes on.

Too big for one planning session? Run `/wayfinder` yourself to chart it, then `/plan <map reference>`.

### Projects: one Architect session per product

A **project** groups the repos of one product and gives it a persistent Architect session: the place to plan, decide, unblock stuck tasks and dispatch work across all of them.

```bash
role-router project create incacook --repos IncaCook-Server,IncaCook,incacook-admin [--profile openai-top]
role-router project open incacook          # start, or resume, the project's Architect session
role-router -P incacook status             # any command, scoped to the project: inbox, launch --ready, sync, watch, stop --all
```

- **Files stay the truth.** Every `project open` regenerates a *live brief* from the boards, the inbox, running work, recent launches, account pauses and the project's decision log, and hands it to the session; it overrides anything older in the conversation. The conversation itself is resumed (Codex `resume`, Claude `--resume`) for continuity; `--fresh` starts over.
- **The session is a console, not a coder.** It reads run records and escalations, edits plans and specs, and acts through role-router (`resolve`, `launch --detach`, `sync`, `pr`, `stop`), asking you before anything that spends agent time or changes shared state. Feature code is still written by Builders in task worktrees.
- **Decisions** are kept in the project's private decision log (`~/.role-router/state/projects/<name>/decisions.md`): record one with `role-router project decide <name> "<decision>" --why "…" --affects Repo:TASK,…`, and answers given with `resolve` are copied in automatically. **Every Builder, Reviewer and Architect run in any repo of the project receives the recent decisions as binding**, so a decision made once applies to all later work.
- **One message without the screen:** `role-router project ask <name> "<question>"` talks to the same session. It is read-only unless you add `--act`: inside it, role-router refuses every command that changes state or spends agent time and the session gives you the command instead (`project open --read-only` does the same interactively).
- **Host:** the profile you choose (`--profile` on `open`, or `project set <name> --profile ID`), otherwise the first usable profile of your Architect chain. Because it starts other agents, the session runs without the Codex workspace sandbox.

### Plans that span several repos

When a feature touches several repos (say a server, a Flutter app and an admin panel that live side by side), `/plan` writes each repo's tasks into that repo's `PLAN.md` and writes cross-repo dependencies as `<repo-folder>:<id>`:

```markdown
## TASK-012 — Prove the release gates in staging
- status: planned
- depends: TASK-010, TASK-011, IncaCook:TASK-102, incacook-admin:TASK-030
```

TASK-012 stays unbuildable until those tasks are `done` in their own repos. Drive each repo from anywhere with `-C`, and watch them all at once:

```bash
role-router status --all                                   # every repo: counts and what is buildable now
role-router -C ~/code/IncaCook-Server fanout TASK-001 TASK-011
role-router -C ~/code/IncaCook next
```

Tasks written as `.agent-board/tasks/<ID>.md` in the same `## <ID> — title` / `status:` / `depends:` format are read too (PLAN.md wins if an id is in both).

### Many tasks at once, across repos: launch, watch, stop

```bash
role-router launch IncaCook-Server:TASK-001 IncaCook-Server:TASK-011 IncaCook:TASK-101 --detach
role-router launch --ready --detach        # every buildable task in every repo role-router knows
role-router watch                          # live: what each agent is doing, for how long, account pauses
role-router stop IncaCook:TASK-101         # or: role-router stop --all
```

Each launched task gets its own worktree and runs the **whole** loop (build → review on another vendor → docs), with at most `--concurrency` (default 3) running at once. Anything not buildable, including tasks whose cross-repo dependencies are still open, is refused up front. `--detach` keeps the launch running after you close the terminal (log under `~/.role-router/state/launches/`).

While a launch, `fanout`, `next`, `fix` or `quick` runs, role-router keeps the Mac awake (macOS `caffeinate`, only as long as the work runs; `ROLE_ROUTER_KEEP_AWAKE=0` turns it off). Closing the lid still sleeps the Mac, which freezes every agent until it wakes.

`watch` shows every running agent in every repo, including runs started by `next` or `fanout`, with the last thing it did ("ran npm test", "Edit src/orders.ts"), plus queued and finished launch tasks. `watch --once` prints a single snapshot. `stop` ends an agent within about a second; nothing is retried on another account after a stop, and the handoff is kept so `role-router next <task>` or a new launch resumes the work.

### What to do next: the NEXT panel and `do`

`watch`, `inbox` and `status --all` (or `-P <project> status`) end with a **NEXT** panel: the steps that move the board, worked out from the files (no model), ranked by how many tasks each one unblocks down the dependency chain, across repos.

```
NEXT  (ranked by what each step unblocks)
  1  Open the PR for IncaCook-Server:TASK-002   unblocks 11
       role-router pr IncaCook-Server:TASK-002
  2  Decide incacook-admin:TASK-030 [environment]: …   unblocks 2
       role-router resolve incacook-admin:TASK-030 --option 1
 ·   blocked: IncaCook-Server:TASK-003 waits on TASK-002 (passed); …
```

The steps are: open the PR of a `passed` task, review and merge an open PR (with its CI state; merging stays yours), `sync` after a merge, decide an inbox item (the recommended option when there is one), and launch what can run. Rework (`gaps_found`) only counts as runnable once its dependencies are `done`, here and in `launch --ready`. While agents run, the panel is a single line. When the last launch finishes, a notification names the next step.

```bash
role-router do 1            # run step 1 (shows the command, asks first; --yes skips)
role-router do 2 --agent    # hand step 2 to the project session
```

With `--agent`, routine steps (pr, sync, launch) are handed over with `project ask --act`; decisions and merges go read-only: the agent recommends and gives the command, you run it.

### PRs: opened for you, feedback goes back to the Builder

**Opening.** When a task passes review and its docs step is done, role-router pushes the task branch and opens the PR into the branch it was cut from, with the docs step's PR body (repos on GitHub with `gh` signed in; `"pr": { "auto": false }` turns it off, `"draft": true` opens drafts). If the PR is already open, the new commits are pushed and its description refreshed. `role-router pr <task>` still does it by hand.

**Feedback → rework.** `sync` (and so `launch`, `launch --ready` and `next`) reads every open task PR. Each of these sends the task back to `gaps_found`:
- CI failing on the PR's latest commit,
- a review that requests changes,
- a comment starting with `/rework` from anyone, you included (GitHub does not let you request changes on your own PR).

The failing-check logs, reviews, inline comments and comments are written to `.role-router/runs/<ID>/pr-feedback.md`. The next Builder pass gets that file as binding and fixes it on the same branch, the Reviewer checks each item, and when the task passes again the open PR updates. Feedback is never acted on twice: CI by the commit it failed on, reviews and comments by time. After `pr.fixRounds` rounds (default 2) the task goes to your inbox instead. The NEXT panel shows these as "Rework X from PR #n feedback".

**Review on demand.** `role-router pr-review <[Repo:]TASK | #PR | PR-url>` reviews the PR as it is now: its real diff, after `main` moved on, after hand edits, or a PR nobody planned. It runs on a top-tier profile of an account that neither built nor reviewed the task. `--panel` uses one top-tier profile per account, with the strongest verdict winning. The result is posted as one comment, never an approval (`--no-post` keeps it local). When the review asks for changes on a passed role-router task, the findings go back to the Builder as above (`--no-rework` to just comment). Without GitHub it reviews the task branch against its base and posts nothing.

### After you merge: sync

`role-router sync` marks a task `done` when its `task/<ID>` PR is merged on GitHub (through `gh`), or, without `gh`, when a `passed` task's branch is merged into the default branch. Its worktree is removed and dependent tasks become buildable. `launch --ready` and `next` (when it picks the task) sync first, so a dependency chain keeps moving as you merge; `sync --all` covers every known repo.

### When work stops: escalations

Routine stops are handled without you (all configurable under `escalation` in the config):

| Stop | What role-router does |
|---|---|
| Review finds gaps | back to the Builder with the findings, up to `maxReviewRounds` (default 2) |
| Build stuck after two diagnosed attempts | one automatic run of the Escalation role on a top-tier model (`autoEscalate`) |
| Every account limited (in a launch) | waits for the earliest reset and resumes from the handoff (`waitForLimits`) |

Everything else lands in **one inbox across all repos**, with a desktop notification (`notify`):

```bash
role-router inbox
#  1  IncaCook:TASK-101  [design]  How does the adapter get the deliveryId?
#        1. Order-keyed topic on the server   2. Pass a deliveryId
#        blocks: TASK-102, IncaCook-Server:TASK-012
role-router resolve IncaCook:TASK-101 --option 1        # or --note "…", --repos IncaCook-Server, --no-run
```

Agents raise escalations in a fixed format (type, question, options, recommendation, affected tasks) at `.role-router/escalations/<TASK>.md`; when one stops without it, role-router files one from the stop and the agent's own words. `resolve` records your decision, which every later prompt for that task receives, then routes it: a **design** decision is applied by a headless Architect to the affected specs (also in other repos) and the task is relaunched; then the task is relaunched **at the stage that stopped**, never an earlier one:
- a stop at review re-runs the review with your decision, and the reviewer sends it back to the Builder itself if the code has to change;
- a stop at docs re-runs docs;
- only build stops go back to the Builder.

A task that is already `review`, `passed` or `gaps_found` keeps its status. `watch` shows how many items are waiting.

**Stopped and interrupted work.** Stopping a run puts the board back to the status the task had before that run, so stopping a needless rerun never costs a result. After every run, role-router records the files it left uncommitted (with a content hash) in `.role-router/runs/<ID>/wip.json`. The next agent on the task is told that this is the task's own work in progress, left by an interrupted, limited or escalated run, and continues it instead of stopping at the clean-tree rule. Only unexplained changes stop it: files no run left, or files edited since.

Each headless agent runs in its own process group. A stop, a timeout or Ctrl+C ends the agent and everything it started, and when an agent exits, whatever it left running (a dev server, a test database) is ended too, so a finished run never hangs on a leftover process.

### Bugs and small changes: skip the planning

```bash
role-router fix   "checkout total is wrong when a coupon is applied"
role-router quick "add a --json flag to the export command"
```

Your description becomes the spec of a **quick task** (`FIX-001`, `QUICK-001`, kept in `.role-router/tasks/`, never committed), which then runs the normal loop: Builder on the lite chain with fallback, review on another vendor, docs. For a fix the Builder reproduces the bug with a failing test first and writes the root cause into the task's Notes; for a small change it works test-first. **Size guard:** if the work needs a new or changed public interface, a design or product decision, or is bigger than it sounded, the Builder stops with `human_needed` and points you to `/plan` instead of improvising a design on a lighter model. `--no-run` only creates the task. ([ADR-0004](docs/adr/0004-adopt-skills-v1-1-within-role-pipeline.md))

## Command reference

| Command | What it does |
|---|---|
| `role-router configure [--print]` | Setup wizard: accounts, models, chains → `~/.role-router/config.json` |
| `role-router run <role> [arg] [--headless] [--profile=ID] [--dry-run]` | Run one role (`architect`, `builder`, `worker`/`review`, `docs`, `escalation`) through its chain |
| `role-router chat <role> "<message>"` | Same, with your message as the prompt instead of the role workflow |
| `role-router fix "<bug>"` / `quick "<change>"` | Bug or small change without planning: quick task → build → review → docs |
| `role-router next [TASK] [--loop]` | One build → review → docs iteration, status read from the board after each step |
| `role-router fanout <TASK…> [--concurrency=N] [--base=REF]` | Independent tasks in parallel, one worktree each (build only) |
| `role-router launch <[Repo:]TASK…> \| --ready [--detach]` | Many tasks across repos through the full loop at once, optionally in the background |
| `role-router watch [--once]` | Live view of every running agent, queued and finished launch tasks, account pauses, and what to do next |
| `role-router stop <[Repo:]TASK…> \| --all` | Stop running or queued tasks; handoffs kept for resume |
| `role-router sync [--all]` | Merged `task/<ID>` PRs (or merged `passed` branches) → `done`; worktrees cleaned up |
| `role-router inbox` | Everything waiting on a human decision, across repos |
| `role-router do <n> [--agent] [--yes]` | Run step n of the NEXT panel, or hand it to the project session |
| `role-router pr <[Repo:]TASK…> [--draft] [--dry-run]` | Open a passed task's PR by hand (it opens by itself on GitHub) |
| `role-router pr-review <[Repo:]TASK \| #PR \| url> [--panel] [--no-post] [--no-rework]` | Fresh review of the real PR diff on another account; one comment, rework on blockers |
| `role-router resolve <Repo:TASK \| #n> --option N \| --note "…"` | Answer it; the decision is applied and the task relaunched |
| `role-router fan "<prompt>" [--profiles=a,b] [--worktree]` | One prompt on several models, one answer file each |
| `role-router pstack [--print]` | Point pstack skills' model panels at your profiles |
| `role-router status [--all]` | This repo's board, runs and handoffs; `--all` (or outside a repo) summarises every repo |
| `role-router -C <repo> <command>` | Run any command as if started inside `<repo>`, from anywhere |
| `role-router project create\|list\|show\|add\|remove\|set\|open` | Projects: group repos, open the project's Architect session |
| `role-router -P <project> <command>` | Scope status, inbox, launch --ready, sync, watch, stop --all to one project |
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
| Architect | `grilling`, `domain-modeling`, `codebase-design` | `prototype`, `research`; `architect` references (read-only, for the design round) |
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
  "defaults": { "cooldownMinutes": 60, "transientRetries": 2, "runTimeoutMinutes": 30 },
  "escalation": { "maxReviewRounds": 2, "autoEscalate": true, "waitForLimits": true, "notify": true },
  "pr": { "auto": true, "draft": false, "fixRounds": 2 }
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
