<div align="center">

# Role Router

**Orchestrate your paid coding agents — Codex, Claude Code, OpenCode — by the role each piece of work needs.**

Plan on top-tier models, execute on lighter ones, across whichever paid plans you hold. Drops into any repo and keeps authentication boundaries explicit.

[![Codex](https://img.shields.io/badge/harness-Codex-111)](https://developers.openai.com/codex/)
[![Claude Code](https://img.shields.io/badge/harness-Claude%20Code-d97757)](https://claude.com/claude-code)
[![OpenCode](https://img.shields.io/badge/API%20harness-OpenCode-111)](https://opencode.ai/)
[![Shell](https://img.shields.io/badge/install-bash-4EAA25?logo=gnubash&logoColor=white)](install.sh)
[![Status](https://img.shields.io/badge/status-active-success)](#)

</div>

> **The one rule:** _route on **roles**, not models._ Today's cheap coder is replaced in months — bind each role to a swappable **Engine** and the workflow never changes. ([ADR-0001](docs/adr/0001-roles-not-engines.md))

```
   Codex CLI (Plus/Pro)               OpenCode → Z.AI / OpenRouter
   ┌────────────────┐                 ┌──────────────────────────────────┐
   │ Architect      │  ── task file → │ Builder  →  Worker  →  Worker    │
   │ /plan          │   (Handoff      │ /build     /review    /docs      │
   │ subscription   │    Artifact)    │ API key     API key    API key    │
   └────────────────┘                 └──────────────────────────────────┘
```

---

## Table of contents

- [Why Role Router](#why-role-router)
- [The three roles](#the-three-roles)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Planning paths](#planning-paths)
- [Guide: ship your first feature](#guide-ship-your-first-feature)
- [Command reference](#command-reference)
- [Parallel builders — `/fan-out`](#parallel-builders--fan-out)
- [How the loop knows what's next](#how-the-loop-knows-whats-next)
- [Swapping Engines](#swapping-engines)
- [Skill catalog](#skill-catalog)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

---

## Why Role Router

Coding agents are cheap to run *wrong* and expensive to run *well*. Most setups pick one model and pay top-of-the-line rates for work — boilerplate, test scaffolding, PR descriptions — that a model 10× cheaper does just fine. The waste isn't the model; it's spending an **Architect-grade** model on **Worker-grade** work.

Role Router splits the work by the *kind of thinking it needs* and binds each kind to its own Engine:

- **Planning** is rare, high-leverage — run it on your strongest subscription-backed or API engine.
- **Building** is the bulk — run it on a cheap, capable coder.
- **Admin** (review, docs, PR bodies) is the cheapest tier of all.

You keep one workflow; the models behind it are config you can swap in a month when something cheaper ships.

## The three roles

| Role | Does | Command(s) | Engine (default) | Billing |
|---|---|---|---|---|
| 🧠 **Architect** | plan, decompose, harden specs | `/plan` | Codex CLI subscription | included usage/credits |
| 🔨 **Builder** | implement, test, refactor | `/build` | Z.AI `glm-4.7` via OpenCode | Z.AI plan/API |
| 🧹 **Worker** | review, docs, PR bodies, status | `/review` `/docs` | Z.AI `glm-4.7` via OpenCode | Z.AI plan/API |

> An **Engine** is the concrete model bound to a Role right now. Engines change; Roles don't. ([CONTEXT.md](CONTEXT.md) is the full glossary.)

## Prerequisites

| Need | Why | Get it |
|---|---|---|
| **Node.js** ≥ 18 | runs the installer, `configure.mjs`, `board.mjs`, `fan-out.mjs` | <https://nodejs.org> |
| **Codex CLI** *(optional)* | uses ChatGPT Plus/Pro for subscription-backed roles | `npm i -g @openai/codex` then `codex login` |
| **OpenCode** | hosts API-backed Z.AI/OpenRouter roles | `npm i -g opencode-ai` |
| A paid **Claude** plan (Pro or Max) *(optional)* | Claude Code-backed roles | <https://claude.com/claude-code> |
| At least **one** provider plan | Builder/Worker need a cheap Engine | see below |
| **git** | the workflow is branch- and worktree-based | preinstalled on most systems |
| **`gh`** (optional) | lets `/next` reconcile and open PRs | <https://cli.github.com> |

**Provider options** (the installer will ask which you have):

| Provider | Get it |
|---|---|
| ChatGPT Plus/Pro with Codex | sign in using `codex login`; API-provider keys remain separate |
| Z.AI GLM Coding Plan | dedicated `https://api.z.ai/api/coding/paas/v4` endpoint |
| Z.AI General API | `https://api.z.ai/api/paas/v4` |
| OpenAI API *(separate billing)* | <https://platform.openai.com/api-keys> |
| OpenRouter (aggregates many) | <https://openrouter.ai/keys> |
| Anthropic API (paid, escalation only) | <https://console.anthropic.com/settings/keys> |

## Quickstart

```bash
# 1. Clone
git clone https://github.com/Atou4/role-router.git && cd role-router

# 2. Run the interactive installer
./install.sh
```

The installer launches an **interactive CLI** that:

1. ✅ Checks prerequisites (Node.js, Codex CLI, OpenCode)
2. 🔐 **Asks which subscription harnesses you have** (Codex Plus/Pro, Claude Pro/Max)
3. 🔑 **Asks which API providers you have** (Z.AI Coding Plan/General API, OpenAI API, OpenRouter, Anthropic API)
4. ⚙️ **Proposes role bindings** (Architect → Codex, Builder/Worker → Z.AI)
5. 🎛️ **Lets you customize** which model serves each Role
6. 📝 **Generates** `~/.role-router/config.json`
7. 📦 **Installs** the `role-router` launcher (runs straight from this checkout)

Then it prints the **shell exports** you need to add to your profile (`~/.zshrc` or `~/.bash_profile`):

```bash
export OPENAI_API_KEY="sk-..."        # if you selected OpenAI
export ZAI_API_KEY="..."             # either Z.AI mode
export OPENROUTER_API_KEY="sk-or-..." # if you selected OpenRouter
```

> **Authentication guardrail:** Codex subscriptions use Codex CLI login. API-backed roles use OpenCode provider credentials. Role Router never extracts or converts subscription credentials. ([ADR-0005](docs/adr/0005-engine-adapters-separate-harnesses-from-providers.md))

## Planning paths

Role Router adopts the mattpocock/skills v1.1 lifecycle without replacing its role commands. `/plan` is the local-board adapter for **Grilling → Spec → Tickets**: it uses the upgraded grilling rules, synthesizes spec decisions, and writes approved tracer-bullet tickets as the Handoff Artifact.

Choose by planning size:

| Situation | Architect path | Result |
|---|---|---|
| Clear enough for one strong session | `/plan <feature>` | `PLAN.md` or `.agent-board/` specs ready for `/build` |
| Too large or foggy for one session | `/wayfinder <idea>` across sessions, then `/plan <map reference>` | a collaborative decision map, then Role Router task specs |
| Tracker-native workflow without Role Router's board | `/grill-with-docs` → `/to-spec` → `/to-tickets` | tracker tickets worked with `/implement`, then `/code-review` |

The grilling gate is explicit: the Architect looks up facts, asks the user to make decisions one at a time, and does not write tickets until the user confirms shared understanding and approves the dependency graph. See [ADR-0004](docs/adr/0004-adopt-skills-v1-1-within-role-pipeline.md).

## Guide: ship your first feature

A complete loop, from idea to an open PR, with each command launching the configured adapter.

### 1 · Plan it (Architect — Codex subscription)

```bash
role-router run architect "add phone verification to onboarding"
```

`/plan` grills decisions, synthesizes the spec, and decomposes it into approved **self-contained tracer-bullet task specs** — written to a root `PLAN.md` (or a `.agent-board/` task if your repo uses one). Each task carries a `status:` and a `depends:` list. This is the only step that uses Claude/Max.

> Nothing else needs the Architect context again — the spec is the handoff.

### 2 · Build it (Builder — cheap Engine)

```bash
role-router run builder TASK-001
```

The Builder reads the spec in a fresh context, implements the task, and runs quality gates. With the recommended setup this is GLM-4.7 through OpenCode. Difficult work escalates to GLM-5.2.

### 3 · Review it (Worker — cheapest Engine)

```bash
role-router run worker TASK-001
```

The configured Worker checks the diff against the spec's acceptance criteria and **emits a status** — `passed`, `gaps_found`, or `human_needed`. That status, not its prose, is what the loop routes on next.

### 4 · Document it & open the PR (Worker)

```bash
role-router run docs TASK-001
```

The Worker writes the PR body, updates the board, and opens the PR. The loop **pauses here** — merging is a human decision.

### 5 · Let the loop drive

Instead of running steps 2–4 by hand, chain them and auto-pick the next task:

```text
/next
```

One supervised iteration: reconcile merged PRs → `done`, guard that the previous PR is settled, then **route on status** — re-build a `gaps_found`, stop on `human_needed`, otherwise build the next task whose dependencies are all `done`. It refuses to build an un-planned task; that's the Architect's job, on Max.

```
  role-router run architect  → PLAN.md
  /next → role-router run builder → worker → docs
```

## Command reference

| Command | Role | Adapter | What it does |
|---|---|---|---|
| `role-router run architect <feature>` | Architect | configured, normally Codex | Harden an idea into task specs |
| `role-router run builder <id>` | Builder | configured, normally OpenCode/Z.AI | Implement one task and run gates |
| `role-router run worker <id>` | Worker | configured, normally OpenCode/Z.AI | Emit `passed` / `gaps_found` / `human_needed` |
| `role-router run docs <id>` | Worker | configured | Write PR body, update board, open PR |
| `role-router limits` | — | — | Show or edit paused accounts |
| `role-router next [TASK] [--loop]` | Builder+Worker | each Role's chain | One deterministic build → review → docs turn, driven by code |
| `role-router status` | — | — | Accounts, board, last run per task, pending handoffs |
| `/next` | Builder+Worker | launches each binding | The same loop as a prompt; also reconciles merged PRs |
| `/fan-out <ids…>` | Builder ×N | Builder binding | Parallel independent tasks in fresh contexts |

**Board driver** (`scripts/board.mjs`):

```bash
role-router board next                 # next buildable task (JSON, or NONE)
role-router board wave                 # the buildable wave (JSON array)
role-router board list                 # summary, flags BUILDABLE
role-router board status TASK-003      # one task's status
role-router board set-status TASK-003 review
```

## Parallel builders — `/fan-out`

For a batch of **independent** tasks, skip the one-at-a-time loop and build them all at once:

```bash
role-router fanout TASK-001 TASK-002 TASK-003
```

Each task runs through the configured Builder adapter in its own git worktree. An API binding launches `opencode run`; a Codex binding launches `codex exec`.

The spawner is [`scripts/fan-out.mjs`](scripts/fan-out.mjs); each child uses the configured role adapter and a fresh context:

```bash
role-router fanout --concurrency=3 TASK-001 TASK-002
```

| Flag | Default | Meaning |
|---|---|---|
| `--concurrency=N` | `3` | how many Builders run at once |
| `--base=<ref>` | `HEAD` | branch each worktree forks from |
| `--no-worktree` | off | build in the current dir (single task only) |
| `--yes` | off | skip the confirmation prompt |
| `--dry-run` | off | validate config and print the launch plan without creating worktrees |

> Use `/next` for **dependent** work (build in order, one PR at a time) and `/fan-out` for **independent** work (a whole wave at once).

## How the loop knows what's next

Each task carries two scheduler fields — a **status** and a **`depends:`** list:

```markdown
## TASK-003 — Add phone verification
- status: planned        # planned→building→review→{passed|gaps_found|human_needed}→done
- depends: TASK-001, TASK-002

### Scope
…
### Acceptance Criteria
- [ ] …
```

A task is **buildable** when its status is `planned` **and** every `depends:` task is `done`. `/next` builds the first buildable task; `/fan-out` builds the whole buildable **wave**. `/review` writes the status that decides what happens next.

The portable driver is [`scripts/board.mjs`](scripts/board.mjs) (operates on `PLAN.md`); `.agent-board/` repos use their own board tool. Full contract: [`docs/task-spec.md`](docs/task-spec.md).

## Fallback chains & usage limits

Each Role lists **profiles** in preference order (an account + model + tier). Copy [`config/role-router.v2.example.json`](config/role-router.v2.example.json) to `~/.role-router/config.json` and edit it — model ids are passed to the agent untouched, so any model your plan offers works. Old v1 configs keep working.

```
accounts  → which paid plan/agent:      openai (codex) · anthropic (claude) · zai (opencode)
profiles  → account + model + tier:     codex-top = openai + gpt-6-sol (top) · claude-mid = anthropic + sonnet (lite)
roles     → ordered chain of profiles:  builder: claude-mid → codex-lite → glm
```

What happens in a headless run (`--headless`, and everything `fanout` launches):

- **Usage limit hit** → that *account* is paused until its reset time (or `cooldownMinutes`), a `handoff.md` is written under `.role-router/runs/<task>/`, and the next profile continues from the handoff. The worktree is kept as is.
- **Transient 429** → the same profile is retried a couple of times, then the chain moves on.
- **Planning Roles (`onTierDrop: "ask"`)** never silently drop to a lighter model: interactively you choose *wait / switch / abort*; headless it exits `2` and waits for you.
- **Reviews** prefer an account other than the one that built the task, and ask before reviewing on the same one.
- **Every profile limited** → exit `75` with the earliest reset time.

Limits can only be detected automatically in headless runs. After hitting one in an interactive session, record it:

```bash
role-router limits                              # which accounts are paused
role-router limits pause anthropic --until=17:30   # or +90m, +2h, an ISO date
role-router limits clear anthropic
```

**Continuity.** Files and git carry the state, not the agent's session:

- `handoff.md` is written when a run ends on a limit or a crash. It lists the task's acceptance criteria split into verified (ticked) and still open, gives `git` commands to re-read the live state instead of a stale snapshot, and tells the next agent to run the verification gates first.
- When the *same* profile returns after its account resets, it resumes its own session (`claude --resume`, `codex exec resume`, `opencode --session`); if that fails it starts fresh from the handoff.
- Every headless run leaves `.role-router/runs/<task>/NNN-<profile>.json` (+ `.jsonl` events): agent, result, tokens/cost when reported, and **evidence** the orchestrator observed itself (git commit, uncommitted files, diff stat).

 Design: [ADR-0006](docs/adr/0006-account-aware-fallback-chains.md), [dispatch.md](docs/design/dispatch.md).

## Swapping Engines

Engines are config, not architecture. You have two options:

**Option 1 — Re-run the interactive CLI:**

```bash
cd /path/to/role-router
role-router configure
```

This re-prompts you for providers and models, and regenerates the config.

To jump directly into any repository without creating a plan first:

```bash
cd /path/to/repository
role-router chat architect "inspect this codebase and help me continue the current work"
role-router chat builder "fix the failing checkout test"
```

`chat` starts an interactive conversation with the initial message immediately. Use `run` when you want the structured plan/build/review workflow and its file-based handoffs.

**Option 2 — Edit the config directly:**

Edit role-to-adapter bindings in `~/.role-router/config.json`:

```jsonc
"architect": { "adapter": "codex" },
"builder": { "adapter": "opencode", "provider": "zai-coding-plan", "model": "zai-coding-plan/glm-4.7", "keyEnv": "ZAI_API_KEY" },
"worker": { "adapter": "opencode", "provider": "zai-coding-plan", "model": "zai-coding-plan/glm-4.7", "keyEnv": "ZAI_API_KEY" }
```

Authenticate API providers using `opencode auth login` or their documented environment variable. Subscription-backed Codex uses the existing `codex login` session.

OpenRouter models use the same adapter. For example, Kimi for building and DeepSeek for review:

```jsonc
"builder": { "adapter": "opencode", "provider": "openrouter", "model": "openrouter/moonshotai/kimi-k2.7-code", "keyEnv": "OPENROUTER_API_KEY" },
"worker": { "adapter": "opencode", "provider": "openrouter", "model": "openrouter/deepseek/deepseek-v4-flash", "keyEnv": "OPENROUTER_API_KEY" }
```

This is a binding change only; the `/plan`, `/build`, `/review`, `/docs`, and fan-out workflow stays the same.

## Skill catalog

[`catalog/`](catalog/) classifies 32 recommended agent skills **by domain** (mobile RN, Flutter, web/UI-UX, backend/data, planning, delivery, quality, meta) and maps each to a Role. We don't vendor skill bodies — each points to its **original source** + install command, so skills stay current with upstream and there's no redistribution-license risk.

```bash
./install-skills.sh                 # list domains
./install-skills.sh mobile-flutter  # install one domain from source
./install-skills.sh role:architect  # install all Architect-role skills
./install-skills.sh all             # everything with a remote source
```

[`skills-manifest.json`](skills-manifest.json) maps each Role to recommended skills — load only your stack's subset. Builder/Worker skills are deliberately checklist-style so a weaker Engine can follow them; heavy reasoning skills (`grill-with-docs`, `improve-codebase-architecture`) stay on the Architect.

The v1.1 names are canonical: `to-spec` replaces `to-prd`, and `to-tickets` replaces `to-issues`/upstream `to-plan`. Because installers do not remove renamed skills, delete stale copies after reinstalling upstream; `install-skills.sh` warns when it finds them:

```bash
npx skills add mattpocock/skills
```

## How it works under the hood

The Architect writes a self-contained spec (board task or `PLAN.md`); the Builder reads it in a fresh session on a cheap Engine. **State crosses the boundary through files, not shared context** — so the cheap Engine never needs Claude's reasoning in-window.

**Adapters separate harnesses from providers:** `run-role.mjs` loads the same role prompt, then launches Codex, Claude Code, or OpenCode. `PLAN.md`, git diffs, and task status remain the cross-harness contract. ([ADR-0003](docs/adr/0003-split-pipeline-per-role.md), [ADR-0005](docs/adr/0005-engine-adapters-separate-harnesses-from-providers.md))

## Troubleshooting & FAQ

<details>
<summary><strong>Can OpenCode spend my Codex Plus subscription?</strong></summary>

No. Codex subscription roles launch through Codex CLI. OpenCode uses its own provider credentials.
</details>

<details>
<summary><strong><code>opencode: command not found</code> after install</strong></summary>

OpenCode is installed globally. Make sure your global npm bin is on `PATH`, then reopen the shell. Re-run `./install.sh`; it is safe to run again.
</details>

<details>
<summary><strong><code>/build</code> says the model is unauthorized / 401</strong></summary>

Check the environment variable referenced by the selected provider. Z.AI uses `ZAI_API_KEY`; OpenRouter uses `OPENROUTER_API_KEY`. You can also run `opencode auth login`.
</details>

<details>
<summary><strong><code>/next</code> stops saying a PR is still open</strong></summary>

By design — the loop never starts a new task while the previous one's PR is unmerged. Merge or close it, then run `/next` again. (It also fail-closes if the `gh` query is flaky, rather than risk double-building.)
</details>

<details>
<summary><strong>Can I use a different cheap model?</strong></summary>

Yes — that's the whole point. See [Swapping Engines](#swapping-engines). Roles stay; Engines are config.
</details>

<details>
<summary><strong>Do I have to use <code>PLAN.md</code>?</strong></summary>

No. If your repo has an `.agent-board/`, the commands use its board tool instead. `PLAN.md` + `board.mjs` is just the portable default for repos without one.
</details>

## Docs

- [`CONTEXT.md`](CONTEXT.md) — the shared vocabulary (Role, Engine, Adapter, Handoff Artifact, Escalation, Fan-out, Wave, Worktree).
- [`docs/adr/`](docs/adr/) — the load-bearing decisions and why.
- [`docs/task-spec.md`](docs/task-spec.md) — the task format + status contract (`planned`→…→`done`) and `depends:` scheduling.
- [`docs/adr/0004-adopt-skills-v1-1-within-role-pipeline.md`](docs/adr/0004-adopt-skills-v1-1-within-role-pipeline.md) — how Wayfinder and the renamed lifecycle skills fit Role Router.
- [`docs/adr/0005-engine-adapters-separate-harnesses-from-providers.md`](docs/adr/0005-engine-adapters-separate-harnesses-from-providers.md) — why Codex subscriptions and Z.AI API routes use different Adapters.
- [`docs/comparison-gsd.md`](docs/comparison-gsd.md) — how Role Router stacks up against [GSD Core](https://github.com/open-gsd/gsd-core), and the prioritized list of ideas to steal.

## Contributing

Issues and PRs welcome. The repo is small on purpose — before adding a command, check it can't be expressed as a Role + an Engine swap. Keep the glossary in `CONTEXT.md` authoritative: if you introduce a term, define it there.

## License

No license file yet — add one before sharing publicly (**MIT** is recommended for a tool like this). The bundled skill catalog only *references* upstream skills under their own licenses; it doesn't redistribute them.
