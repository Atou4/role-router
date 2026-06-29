<div align="center">

# Role Router

**Route engineering work to the cheapest *capable* model — by the role it needs, not the model you remember.**

Spend your Claude Max quota only on high-leverage planning; let the 60–80% bulk of building and admin run **~7–128× cheaper** on OpenRouter models. Drops into any repo. Shareable with one install script.

[![Claude Code](https://img.shields.io/badge/runs%20on-Claude%20Code-d97757)](https://claude.com/claude-code)
[![CCR](https://img.shields.io/badge/proxy-claude--code--router-555)](https://github.com/musistudio/claude-code-router)
[![Shell](https://img.shields.io/badge/install-bash-4EAA25?logo=gnubash&logoColor=white)](install.sh)
[![Status](https://img.shields.io/badge/status-active-success)](#)

</div>

> **The one rule:** _route on **roles**, not models._ Today's cheap coder is replaced in months — bind each role to a swappable **Engine** and the workflow never changes. ([ADR-0001](docs/adr/0001-roles-not-engines.md))

```
   Vanilla Context (Max)              CCR Context (`ccr code` → OpenRouter)
   ┌────────────────┐                 ┌──────────────────────────────────┐
   │ /plan          │  ── task file → │ /build  →  /review  →  /docs      │
   │ Architect      │   (Handoff      │ Builder    Worker      Worker     │
   │ Claude / Max   │    Artifact)    │ Kimi       DeepSeek    DeepSeek   │
   └────────────────┘                 └──────────────────────────────────┘
```

---

## Table of contents

- [Why Role Router](#why-role-router)
- [The three roles](#the-three-roles)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Guide: ship your first feature](#guide-ship-your-first-feature)
- [Command reference](#command-reference)
- [Parallel builders — `/fan-out`](#parallel-builders--fan-out)
- [How the loop knows what's next](#how-the-loop-knows-whats-next)
- [The Hint Hook](#the-hint-hook)
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

- **Planning** is rare, high-leverage, and worth your Claude Max quota.
- **Building** is the bulk — run it on a cheap, capable coder.
- **Admin** (review, docs, PR bodies) is the cheapest tier of all.

You keep one workflow; the models behind it are config you can swap in a month when something cheaper ships.

## The three roles

| Role | Does | Command(s) | Engine (default) | Billing |
|---|---|---|---|---|
| 🧠 **Architect** | plan, decompose, harden specs | `/plan` | Claude Opus — **Max, vanilla** | quota |
| 🔨 **Builder** | implement, test, refactor | `/build` | `moonshotai/kimi-k2.6` (CCR) | ~$3.4 / 1M out |
| 🧹 **Worker** | review, docs, PR bodies, status | `/review` `/docs` | `deepseek/deepseek-v4-flash` (CCR) | ~$0.2 / 1M out |

> An **Engine** is the concrete model bound to a Role right now. Engines change; Roles don't. ([CONTEXT.md](CONTEXT.md) is the full glossary.)

## Prerequisites

| Need | Why | Get it |
|---|---|---|
| **Node.js** ≥ 18 | runs the installer, `board.mjs`, `fan-out.mjs` | <https://nodejs.org> |
| **Claude Code** | the harness all commands run in | `npm i -g @anthropic-ai/claude-code` |
| A **Claude Max** plan | so `/plan` (Architect) bills to quota, not the API | <https://claude.com/claude-code> |
| An **OpenRouter** key | the cheap Engines for Builder/Worker | <https://openrouter.ai/keys> |
| **git** | the workflow is branch- and worktree-based | preinstalled on most systems |
| **`gh`** (optional) | lets `/next` reconcile and open PRs | <https://cli.github.com> |

## Quickstart

```bash
# 1. Clone
git clone https://github.com/Atou4/role-router.git && cd role-router

# 2. Add your OpenRouter key (put this in your shell profile to persist it)
export OPENROUTER_API_KEY="sk-or-..."

# 3. Install — adds CCR, writes its config, copies the commands + hook + drivers
./install.sh

# 4. Apply the CCR config
ccr restart
```

The installer:

- installs **CCR** (`@musistudio/claude-code-router`) if missing,
- writes `~/.claude-code-router/config.json` (Builder = Kimi, Worker = DeepSeek),
- copies the **six commands** (`/plan` `/build` `/review` `/docs` `/next` `/fan-out`), the **Hint Hook**, and the `board.mjs` + `fan-out.mjs` drivers into `~/.claude`,
- prints a one-line snippet to enable the Hint Hook in `~/.claude/settings.json`.

> ⚠️ **Money guardrail:** CCR authenticates with **API keys**, not your Max subscription. Anything launched via `ccr code` bills the paid Anthropic API — so `/plan` is the *only* command you run in a plain `claude` session, and it stays on Max quota. The installer repeats this warning before it does anything. ([ADR-0002](docs/adr/0002-architect-on-max-vanilla-context.md))

## Guide: ship your first feature

A complete loop, from idea to an open PR. **Two terminals (or two sessions)** — one vanilla, one routed.

### 1 · Plan it (Architect — Max quota)

Open a **plain** Claude Code session:

```bash
claude
```
```text
/plan add phone verification to onboarding
```

`/plan` hardens the idea into one or more **self-contained task specs** — written to a root `PLAN.md` (or a `.agent-board/` task if your repo uses one). Each task carries a `status:` and a `depends:` list. This is the only step that uses Claude/Max.

> 💡 Nothing else needs the Architect in-context again — the spec **is** the handoff.

### 2 · Build it (Builder — cheap Engine)

Open a **routed** session:

```bash
ccr code
```
```text
/build TASK-001
```

The Builder (Kimi, via CCR) reads the spec in a fresh context, implements the task, and runs your project's quality gates (typecheck / tests / Maestro). If the gates fail **twice**, that single task **escalates** to Claude automatically — capping the cheap model's rework tax. Green gates flip the task to `review`.

### 3 · Review it (Worker — cheapest Engine)

```text
/review TASK-001
```

The Worker (DeepSeek) checks the diff against the spec's acceptance criteria and **emits a status** — `passed`, `gaps_found`, or `human_needed`. That status, not its prose, is what the loop routes on next.

### 4 · Document it & open the PR (Worker)

```text
/docs TASK-001
```

The Worker writes the PR body, updates the board, and opens the PR. The loop **pauses here** — merging is a human decision.

### 5 · Let the loop drive

Instead of running steps 2–4 by hand, chain them and auto-pick the next task:

```text
/next
```

One supervised iteration: reconcile merged PRs → `done`, guard that the previous PR is settled, then **route on status** — re-build a `gaps_found`, stop on `human_needed`, otherwise build the next task whose dependencies are all `done`. It refuses to build an un-planned task; that's the Architect's job, on Max.

```
  claude   →  /plan          ┐
  ccr code →  /next          │  repeat /next until the queue drains;
            (build→review→docs)┘  each iteration stops at a PR (human gate)
```

## Command reference

| Command | Role | Context | What it does |
|---|---|---|---|
| `/plan <feature>` | Architect | `claude` (Max) | Harden an idea into task specs with `status:` + `depends:` |
| `/build <id>` | Builder | `ccr code` | Implement one task, run gates, escalate on 2× fail |
| `/review <id>` | Worker | `ccr code` | Check the diff vs. spec; emit `passed` / `gaps_found` / `human_needed` |
| `/docs <id>` | Worker | `ccr code` | Write the PR body, update the board, open the PR |
| `/next` | Builder+Worker | `ccr code` | One loop turn: pick next buildable task → build → review → docs |
| `/fan-out <ids…>` | Builder ×N | `ccr code` | Build many **independent** tasks in parallel, fresh context each |

**Board driver** (`board.mjs`, installed at `~/.claude/role-router/`):

```bash
node ~/.claude/role-router/board.mjs next                 # next buildable task (JSON, or NONE)
node ~/.claude/role-router/board.mjs wave                 # the buildable wave (JSON array)
node ~/.claude/role-router/board.mjs list                 # summary, flags BUILDABLE
node ~/.claude/role-router/board.mjs status TASK-003      # one task's status
node ~/.claude/role-router/board.mjs set-status TASK-003 review
```

## Parallel builders — `/fan-out`

For a batch of **independent** tasks, skip the one-at-a-time loop and build them all at once:

```text
ccr code
/fan-out TASK-001 TASK-002 TASK-003
```

Each task runs as its own headless `claude -p "/build …"` process — a **fresh 200k context window** with full tool access — in its **own git worktree**, so parallel builds never clobber each other's branch. Every child is pointed at the CCR proxy, so all the parallel Builders bill to the **cheap Engine**, not Max.

This is the [`nested-subagent`](https://github.com/gruckion/nested-subagent) mechanism (headless `claude -p` per task) adapted for cost: the upstream plugin spawns children on your Max quota; we route them through CCR instead. The spawner is [`scripts/fan-out.mjs`](scripts/fan-out.mjs):

```bash
node ~/.claude/role-router/fan-out.mjs --concurrency=3 --base=origin/dev TASK-001 TASK-002
```

| Flag | Default | Meaning |
|---|---|---|
| `--concurrency=N` | `3` | how many Builders run at once |
| `--base=<ref>` | `origin/dev` | branch each worktree forks from |
| `--engine=ccr\|vanilla` | `ccr` | route children through CCR (cheap) or plain (Max) |
| `--no-worktree` | off | build in the current dir (single task only) |
| `--prompt=<tmpl>` | `/build {id}` | the command each child runs |
| `--yes` | off | skip the confirmation prompt |

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

## The Hint Hook

A free, local `UserPromptSubmit` hook ([`hooks/route-hint.mjs`](hooks/route-hint.mjs)) keyword-classifies your prompt and *suggests* a Role command (e.g. _"this looks like Builder work — consider /build"_). Suggestion only — it never switches Engines, never blocks, and costs zero model tokens.

## Swapping Engines

Engines are config, not architecture. Edit the `Router` block in `~/.claude-code-router/config.json`:

```jsonc
"default":    "openrouter,z-ai/glm-5",            // try GLM-5 as Builder
"background": "openrouter,deepseek/deepseek-v4-flash"
```

Then `ccr restart`. Re-check live model IDs/prices on OpenRouter before committing — slugs and prices shift.

## Skill catalog

[`catalog/`](catalog/) classifies 25 recommended agent skills **by domain** (mobile RN, Flutter, web/UI-UX, backend/data, planning, delivery, quality, meta) and maps each to a Role. We don't vendor skill bodies — each points to its **original source** + install command, so skills stay current with upstream and there's no redistribution-license risk.

```bash
./install-skills.sh                 # list domains
./install-skills.sh mobile-flutter  # install one domain from source
./install-skills.sh role:architect  # install all Architect-role skills
./install-skills.sh all             # everything with a remote source
```

[`skills-manifest.json`](skills-manifest.json) maps each Role to recommended skills — load only your stack's subset. Builder/Worker skills are deliberately checklist-style so a weaker Engine can follow them; heavy reasoning skills (`grill-with-docs`, `improve-codebase-architecture`) stay on the Architect.

## How it works under the hood

The Architect writes a self-contained spec (board task or `PLAN.md`); the Builder reads it in a fresh session on a cheap Engine. **State crosses the boundary through files, not shared context** — so the cheap Engine never needs Claude's reasoning in-window.

**Two launch contexts, on purpose:** CCR can't reuse your Max subscription (it uses API keys), so `/plan` runs in a plain `claude` session to stay on Max quota, and only `/build` / `/review` / `/docs` run via `ccr code`. This is both the routing mechanism and the money guardrail. ([ADR-0002](docs/adr/0002-architect-on-max-vanilla-context.md), [ADR-0003](docs/adr/0003-split-pipeline-per-role.md))

## Troubleshooting & FAQ

<details>
<summary><strong>Will this accidentally bill my Claude Max usage to the paid API?</strong></summary>

No — as long as you run `/plan` in a plain `claude` session and everything else in `ccr code`. CCR only ever talks to OpenRouter (and to Anthropic *only* on an explicit Escalation, which is billed on purpose). The installer warns about this before writing anything.
</details>

<details>
<summary><strong><code>ccr: command not found</code> after install</strong></summary>

CCR is a global npm package. Make sure your global npm bin is on `PATH` (`npm bin -g`), then re-open the shell. Re-run `./install.sh` — it's safe to run again.
</details>

<details>
<summary><strong><code>/build</code> says the model is unauthorized / 401</strong></summary>

Your `OPENROUTER_API_KEY` isn't set in the environment CCR sees. Export it in your shell profile and `ccr restart`. The CCR config references it as `${OPENROUTER_API_KEY}`.
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

- [`CONTEXT.md`](CONTEXT.md) — the shared vocabulary (Role, Engine, Vanilla/CCR Context, Handoff Artifact, Escalation, Fan-out, Wave, Worktree).
- [`docs/adr/`](docs/adr/) — the three load-bearing decisions and why.
- [`docs/task-spec.md`](docs/task-spec.md) — the task format + status contract (`planned`→…→`done`) and `depends:` scheduling.
- [`docs/comparison-gsd.md`](docs/comparison-gsd.md) — how Role Router stacks up against [GSD Core](https://github.com/open-gsd/gsd-core), and the prioritized list of ideas to steal.

## Contributing

Issues and PRs welcome. The repo is small on purpose — before adding a command, check it can't be expressed as a Role + an Engine swap. Keep the glossary in `CONTEXT.md` authoritative: if you introduce a term, define it there.

## License

No license file yet — add one before sharing publicly (**MIT** is recommended for a tool like this). The bundled skill catalog only *references* upstream skills under their own licenses; it doesn't redistribute them.
