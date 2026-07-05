# Role Router — Handoff Document

**Session:** 2025-01-04 to 2025-07-05  
**Repo:** `Atou4/role-router` (public, `/Users/macbookpro/Documents/role-router`)  
**Focus:** Interactive CLI installer, no-Max support, multi-provider routing

---

## What Role Router Is

A portable workflow that routes software engineering work to the cheapest capable model **by the role it needs**:

- **Architect** (`/plan`) — planning, decomposition, spec hardening
- **Builder** (`/build`) — implementation, testing, refactoring
- **Worker** (`/review` `/docs`) — review, documentation, PR bodies

**Two launch contexts:**
- **Vanilla** (`claude`) — Architect runs here if Max is available (stays on quota)
- **CCR** (`ccr code`) — Builder/Worker always run here (routes to cheap providers via CCR)

State crosses between contexts via **files** (task specs), not shared context.

---

## Current State — Latest Commits

```
e3cf245 Add no-Max subscription support and web developer use case
e097cad Add interactive CLI installer with provider catalog
a6f5a11 Rewrite README as a guide — quickstart, first-feature walkthrough, command reference, FAQ
a28baca Add status contract + depends/wave scheduling (GSD steals #1, #2)
```

**Recent work:**
1. **Interactive CLI installer** (`scripts/configure.mjs`) — prompts for providers, collects API keys, proposes routing, lets customize per role
2. **Provider catalog** (`providers/catalog.json`) — 30+ current model IDs (OpenRouter, OpenAI, Zhipu, Anthropic) with role hints and pricing
3. **No-Max support** — Architect can route through CCR if user doesn't have Max subscription
4. **Status-driven routing** — `planned→building→review→{passed|gaps_found|human_needed}→done` lifecycle with `depends:` wave scheduling
5. **Parallel fan-out** — `/fan-out` builds independent tasks in parallel, each in its own git worktree

---

## File Structure

```
role-router/
├── commands/              # Claude Code commands (installed to ~/.claude/commands/)
│   ├── plan.md            # Architect role — grill + decompose → task specs
│   ├── build.md           # Builder role — implement + gates (+ escalation on 2× fail)
│   ├── review.md          # Worker role — verify vs spec, emit status
│   ├── docs.md            # Worker role — PR body + board update
│   ├── next.md            # Loop driver — reconcile → pick next buildable → build→review→docs
│   └── fan-out.md         # Parallel builder spawner
├── scripts/
│   ├── configure.mjs      # Interactive configuration CLI ✨ NEW
│   ├── board.mjs          # PLAN.md driver (next, wave, list, status, set-status)
│   └── fan-out.mjs        # Parallel spawner (worktree isolation)
├── providers/
│   └── catalog.json       # Provider + model registry ✨ NEW
├── docs/
│   ├── adr/               # Architecture Decision Records
│   ├── use-case-web-dev.md # Full journey for web dev with Codex + Zhipu ✨ NEW
│   ├── task-spec.md       # Status contract + depends/wave scheduling
│   ├── comparison-gsd.md  # GSD Core comparison + things to steal
│   └── HANDOFF.md         # This file
├── hooks/
│   └── route-hint.mjs     # Free local hook that suggests role commands
├── install.sh             # Main installer (now calls configure.mjs)
├── install-skills.sh      # Skills catalog installer
├── catalog/               # Domain-classified agent skills (not vended, references upstream)
├── skills-manifest.json   # Role → skill mappings
└── README.md              # Full user guide
```

---

## Key Concepts & Vocab

See [`CONTEXT.md`](CONTEXT.md) for the full glossary.

| Term | Meaning |
|---|---|
| **Role** | Architect/Builder/Worker — routing unit, not model names |
| **Engine** | Concrete model bound to a Role (swappable via config) |
| **CCR** | `@musistudio/claude-code-router` proxy — routes requests to OpenRouter/custom providers |
| **Vanilla Context** | Plain `claude` session (Max quota) |
| **CCR Context** | `ccr code` session (cheap providers) |
| **Handoff Artifact** | Task spec that crosses the Architect→Builder boundary |
| **Escalation** | Single Builder task promoted to Architect Engine on 2× gate fail |
| **Fan-out** | Parallel Builders via headless `claude -p` per task |
| **Wave** | All buildable tasks at once (`depends:` all `done`) |
| **Worktree** | Git worktree per task during fan-out (isolates parallel builds) |

---

## The Status Contract (Critical)

[`docs/task-spec.md`](docs/task-spec.md) defines the lifecycle:

```
planned ──/build──▶ building ──gates green──▶ review ──/review──▶ {passed | gaps_found | human_needed}
                                                              │
                                                              ├─▶ gaps_found  ──/build──▶ review
                                                              └─▶ human_needed ─▶ stop
passed ──/docs──▶ (PR) ──merge──▶ done
```

**Buildable** = `status: planned` AND every `depends:` task is `done`.

**Commands route on status:**
- `/next` — reconciles merged PRs→done, re-builds `gaps_found`, stops on `human_needed`, else picks next buildable
- `/review` — emits exactly one of `passed` / `gaps_found` / `human_needed` — that status, not prose, is what the loop routes on
- `/fan-out` — builds the buildable wave (`board.mjs wave`)

---

## Driver Commands

```bash
node ~/.claude/role-router/board.mjs next                 # Next buildable task (JSON)
node ~/.claude/role-router/board.mjs wave                 # Buildable wave (JSON array)
node ~/.claude/role-router/board.mjs list                 # Summary, flags BUILDABLE
node ~/.claude/role-router/board.mjs status TASK-003      # One task's status
node ~/.claude/role-router/board.mjs set-status TASK-003 review
```

For `.agent-board/` repos, use the repo's own board tool instead.

---

## Interactive Installer Flow

```bash
./install.sh
```

Prompts:
1. "Do you have Claude Code Max?" — **new, determines Architect routing**
2. Select providers (OpenAI, Zhipu, OpenRouter, Anthropic API)
3. Collect API keys for selected providers
4. Proposes routing (Builder→o3-mini if OpenAI, Worker→DeepSeek-flash if OpenRouter, etc.)
5. Customize per role (interactive picker)
6. Generates `~/.claude-code-router/config.json`
7. Prints shell exports to add to profile

**No-Max case:** If user answers "no" to Max, Architect routes through strongest model (o1 → GLM-5.2 → Claude Opus via OpenRouter) via CCR.

---

## Provider Catalog

[`providers/catalog.json`](providers/catalog.json) — current model IDs, grouped by provider:

- **OpenRouter:** Kimi K2.6/K2.7, DeepSeek V4-flash/pro, GLM-5.2, GPT-5.4/mini/nano, Claude Opus/Sonnet 5
- **OpenAI:** o3-mini, o1, GPT-4.1, GPT-4o-mini
- **Zhipu:** GLM-5.2, GLM-5-turbo, GLM-4-flash
- **Anthropic:** Claude Opus/Sonnet (escalation only, paid API)

Each model tagged with `role_hint` (strong_coder, cheap_worker, etc.) and `pricing_per_m`.

**Keeping it fresh:** Run `curl -s https://openrouter.ai/api/v1/models | node -e '...'` to fetch latest IDs before updating.

---

## External Relationships

**R2R Workflow** (Requirement-to-Review, user's deck + PDF at `~/Downloads/`):
- Separate workflow, not merged
- R2R = vertical pipeline (requirement→review) + state model
- Role Router = horizontal substrate (cost routing, parallelism)
- R2R vocabulary wins on collision (READY/IN_PROGRESS/REVIEW vs our planned/building/review)
- See memory: `role-router-r2r-relationship.md`

**GSD Core** ([`docs/comparison-gsd.md`](docs/comparison-gsd.md)):
- Mature multi-agent system (33 agents, 70 commands)
- Stole #1 (status-driven router) ✅ and #2 (depends/wave) ✅
- Still open: auto wave-by-wave driver, decision-coverage verification, adversarial plan review
- Our moat: Max-quota awareness (GSD structurally cannot have it)

---

## Pending Work / Ideas

These are **not committed tasks** — just conversation threads or README-roadmap items:

1. **Auto wave-by-wave driver** — loop `/fan-out` → wait → recompute until graph drains (today user re-invokes per wave) — see `comparison-gsd.md` steal #2
2. **Decision-coverage verification** — check that every documented decision (CONTEXT.md/ADR) was implemented — partial steal from GSD
3. **Adversarial plan review** — route 2-3 cheapest Engines as blind plan reviewers before any build — GSD steal #4
4. **Context-headroom hooks** — `PreCompact`/`Stop` hooks to warn before compaction drops board state
5. **`/quick` escape hatch** — skip plan→build→review ceremony for one-file changes — GSD steal #6
6. **Supply-chain checkpoint** — halt Builder on suspicious dependency even under `/fan-out`
7. **Atomic state locking** — `O_EXCL` lock if parallel Builders ever write a shared board

---

## R2R Integration Note

The user has R2R workflow materials (PDF + PPTX in `~/Downloads/`). We extracted and compared:

- R2R vocab wins on collision (use READY/IN_PROGRESS/REVIEW/NEEDS_CHANGES/BLOCKED/DONE instead of our planned/building/review)
- Keep workflows separate; Role Router is the cost/parallel layer **under** R2R
- Roles map: Requirement Analyst + Domain Griller = Architect; Implementation Agent = Builder; Review Agent = Worker
- `.agent-board/` is the shared backend

**Decision:** Reconcile vocab, add requirements front (`/intake-meeting`, `/diff-requirements`, `/grill-feature`), absorb removed-req check — NOT yet implemented, just analyzed.

---

## How to Continue

**For the next agent:**

1. **Read CONTEXT.md** — the vocabulary is authoritative
2. **Skim README.md** — full user guide with walkthrough
3. **Check recent commits** — `e3cf245`, `e097cad`, `a6f5a11` for the new installer + catalog
4. **Read use-case-web-dev.md** — concrete example of Codex+Zhipu user
5. **Before adding features:** Check ADR-0001 (roles not engines) — don't bind roles to specific models in prose

**If continuing the R2R sync:**
- R2R deck/PDF at `~/Downloads/` (R2R Workflow- Requirement-to-Review Agentic Delivery.pdf + R2R_AI_Assisted_Workflow_Presentation.pptx)
- We agreed: R2R vocab wins, workflows stay separate, Role Router is the cost/parallel layer
- Add `/intake-meeting`, `/diff-requirements`, `/grill-feature` commands (Architect role)
- Update status vocab in board.mjs and commands to match R2R's two-axis model

**Suggested skills for next session:**
- `grill-with-docs` — already integrated into `/plan` Step 1
- `to-issues` — if breaking work into GitHub issues
- `diagnose` — if debugging install/CCR issues

---

## Repo State

- Branch: `master`
- Remote: `https://github.com/Atou4/role-router.git`
- Last push: `e3cf245` (no-Max support + web dev use case)
- Working tree: clean
