# Role Router

Route engineering work to the cheapest capable model **by the role it needs** — so your Claude/Max quota is spent only on high-leverage planning, and the 60–80% bulk of building and admin runs ~7–128× cheaper on OpenRouter models. Drops into any repo; shareable via one install script.

> **The one rule:** _route on **roles**, not models._ Today's cheap coder is replaced in months — bind each role to a swappable Engine and the workflow never changes. See [`docs/adr/0001`](docs/adr/0001-roles-not-engines.md).

## The three roles

| Role | Does | Command | Engine (default) | Billing |
|---|---|---|---|---|
| **Architect** | plan, decompose, harden specs | `/plan` | Claude Opus — **Max, vanilla** | quota |
| **Builder** | implement, test, refactor | `/build` | `moonshotai/kimi-k2.6` (CCR) | ~$3.4/1M out |
| **Worker** | review, docs, PR bodies, status | `/review` `/docs` | `deepseek/deepseek-v4-flash` (CCR) | ~$0.2/1M out |

## How it works

```
   Vanilla Context (Max)              CCR Context (`ccr code` → OpenRouter)
   ┌────────────────┐                 ┌──────────────────────────────────┐
   │ /plan          │  ── task file → │ /build  →  /review  →  /docs      │
   │ Architect      │   (Handoff      │ Builder    Worker      Worker     │
   │ Claude / Max   │    Artifact)    │ Kimi       DeepSeek    DeepSeek   │
   └────────────────┘                 └──────────────────────────────────┘
```

The Architect writes a self-contained spec (board task or `PLAN.md`); the Builder reads it in a fresh session on a cheap Engine. State crosses the boundary through **files**, not shared context — so the cheap Engine never needs Claude's reasoning in-context.

**Two launch contexts, on purpose:** CCR can't reuse your Max subscription (it uses API keys), so `/plan` runs in a plain `claude` session to stay on Max quota, and only `/build`/`/review`/`/docs` run via `ccr code`. See [`docs/adr/0002`](docs/adr/0002-architect-on-max-vanilla-context.md). **This is also a money guardrail** — running Claude through CCR bills the paid API.

## Install

```bash
git clone <this-repo> role-router && cd role-router
export OPENROUTER_API_KEY="sk-or-..."   # https://openrouter.ai/keys
./install.sh
```

The installer adds CCR, writes `~/.claude-code-router/config.json`, and copies the six commands (`/plan` `/build` `/review` `/docs` `/next` `/fan-out`) + the Hint Hook + the fan-out spawner into `~/.claude`. Then enable the hook (snippet printed by the installer) and run `ccr restart`.

## Daily use

```bash
claude            # Vanilla — Max
  /plan add phone verification to onboarding   # → writes TASK specs

ccr code          # Routed — OpenRouter
  /build TASK-001   # Kimi implements + runs gates; escalates to Claude on 2× gate fail
  /review TASK-001  # DeepSeek reviews the diff      (switch: /model openrouter,deepseek/deepseek-v4-flash)
  /docs TASK-001    # DeepSeek writes the PR body + updates the board

  # …or chain all three and auto-pick the next planned task:
  /next             # build → review → docs for the next task; stops at the PR (human gate)
```

`/next` is one supervised loop iteration: it reconciles merged PRs, guards that the previous task's PR is settled, picks the next **planned** task (board planning-gate state, or the next `## TASK-XXX` in `PLAN.md`), then runs the pipeline. It refuses to build an un-planned task — that's the Architect's job, on Max.

## Parallel Builders — `/fan-out`

For a batch of **independent** planned tasks, skip the one-at-a-time loop and build them all at once:

```bash
ccr code
  /fan-out TASK-001 TASK-002 TASK-003   # one fresh-context Builder per task, in parallel
```

Each task runs as its own headless `claude -p "/build …"` process — a **fresh 200k context window** with full tool access — in its **own git worktree** so parallel builds never clobber each other's branch. Every child is pointed at the CCR proxy, so all the parallel Builders bill to the **cheap Engine**, not Max.

This is the [`nested-subagent`](https://github.com/gruckion/nested-subagent) mechanism (headless `claude -p` per task) adapted for cost: the upstream plugin spawns children on your Max quota; we route them through CCR instead. The installer mentions how to add that plugin too, if you want in-session nested subagents on Max. Engine of the fan-out is `scripts/fan-out.mjs` (`--concurrency`, `--base`, `--engine=ccr|vanilla`).

> Use `/next` for **dependent** work (build in order, one PR at a time) and `/fan-out` for **independent** work (a whole wave at once).

## The Hint Hook

A free, local `UserPromptSubmit` hook (`hooks/route-hint.mjs`) keyword-classifies your prompt and *suggests* a Role command (e.g. "this looks like Builder work — consider /build"). Suggestion only — it never switches Engines, never blocks, and costs zero model tokens.

## Swapping Engines

Engines are config, not architecture. Edit `~/.claude-code-router/config.json` `Router` block:

```jsonc
"default":    "openrouter,z-ai/glm-5",            // try GLM-5 as Builder
"background": "openrouter,deepseek/deepseek-v4-flash"
```

Re-check live model IDs/prices on OpenRouter before committing — slugs and prices shift.

## Skill catalog

[`catalog/`](catalog/) classifies 25 recommended agent skills **by domain** (mobile RN, Flutter, web/UI-UX, backend/data, planning, delivery, quality, meta) and maps each to a Role. We don't vendor skill bodies — each points to its **original source** + install command (no redistribution-license risk; skills stay current with upstream). Browse [`catalog/README.md`](catalog/README.md); machine-readable [`catalog/skills.json`](catalog/skills.json).

```bash
./install-skills.sh                 # list domains
./install-skills.sh mobile-flutter  # install one domain from source
./install-skills.sh role:architect  # install all Architect-role skills
./install-skills.sh all             # everything with a remote source
```

Most are MIT (Matt Pocock's `mattpocock/skills`, Vercel's RN pack, Supabase's, ui-ux-pro-max). The `flutter-*` pack had no public source — it's marked first-party/local.

## Customising per repo

`skills-manifest.json` maps each Role to recommended skills. Load only your stack's subset (e.g. `react-native-skills` for RN, `flutter-*` for Flutter). Builder/Worker skills are deliberately checklist-style so a weaker Engine can follow them; heavy reasoning skills (`grill-with-docs`, `improve-codebase-architecture`) stay on the Architect.

## Docs

- [`CONTEXT.md`](CONTEXT.md) — the shared vocabulary (Role, Engine, Vanilla/CCR Context, Handoff Artifact, Escalation, Fan-out).
- [`docs/adr/`](docs/adr/) — the three load-bearing decisions and why.
- [`docs/comparison-gsd.md`](docs/comparison-gsd.md) — how Role Router stacks up against [GSD Core](https://github.com/open-gsd/gsd-core), and the prioritized list of things to steal from it.
