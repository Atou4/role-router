# Use Case: Full-Stack Web Developer with Codex + Zhipu GLM

A concrete journey from installation to daily productivity across multiple web codebases.

**Persona: Alex, Full-Stack Web Developer**

**Has:**
- OpenAI Codex plan (o3-mini, o1)
- Zhipu GLM plan (GLM-5.2, GLM-4-flash)
- 3 active web projects:
  - `my-app` — Next.js SaaS dashboard (TypeScript, React)
  - `shop-theme` — Shopify headless theme (React, Shopify CLI)
  - `api-gateway` — NestJS backend (TypeScript, Postgres)
- Claude Code Max subscription (uses it for planning)

**Pain point:** Spending too much time on boilerplate, test scaffolding, and PR reviews — Codex quota drains fast on routine work.

---

## Phase 1 — Discovery & Install (20 minutes)

Alex finds `role-router` on GitHub. Skimming the README, he realizes: he's been burning Codex on review work and test scaffolding — things a cheaper GLM model could do. But he already pays for Zhipu, so why add OpenRouter?

**He installs:**

```bash
git clone https://github.com/Atou4/role-router.git && cd role-router
./install.sh
```

**The interactive CLI walks him through:**

```
┌─ Which plans/providers do you have? ────────────────┐
│ ☑ Claude Code Max    (Architect stays on vanilla)   │
│ ☑ OpenAI Codex                                          │
│ ☑ Zhipu GLM                                             │
│ ☐ OpenRouter API                                      │
└──────────────────────────────────────────────────────┘
```

He skips OpenRouter (already has what he needs), enters his API keys, and the CLI proposes:

```
┌─────────────────┬──────────────┬─────────────┐
│ Role            │ Model        │ Provider    │
├─────────────────┼──────────────┼─────────────┤
│ Architect       │ Claude Opus  │ Max         │
│ Builder         │ o3-mini      │ OpenAI      │
│ Worker          │ glm-4-flash  │ Zhipu       │
│ Escalation      │ glm-5.2      │ Zhipu       │
└─────────────────┴──────────────┴─────────────┘
```

He accepts. The CLI prints the shell exports to add, he runs `ccr restart`, and 5 minutes later he's configured.

---

## Phase 2 — First Use on `my-app` (his main SaaS)

**Context:** `my-app` has no existing task board, just GitHub issues and a messy `TODO.md`.

### Step 1 — Plan the work (Architect, Max)

```bash
cd ~/projects/my-app
claude
```

```
/plan add a user settings page with profile photo upload, dark mode toggle, and email preferences
```

The Architect (Claude Opus on Max) reads the codebase, writes a `PLAN.md` with two tasks:

```markdown
## TASK-001 — User settings UI layout
- status: planned
- depends: 

### Scope
- Create /settings route with three sections: Profile, Appearance, Notifications
- Reusable form components (input, toggle, file upload)

### Acceptance Criteria
- [ ] Page renders without console errors
- [ ] Dark mode toggle persists to localStorage
- [ ] Photo upload shows preview before submission

## TASK-002 — Backend API for user settings
- status: planned
- depends: TASK-001

### Scope
- PUT /api/user/settings endpoint
- Profile photo upload to S3
- Email preference update

### Acceptance Criteria
- [ ] Endpoint returns 401 for unauthenticated
- [ ] Photo upload validates file type/size
- [ ] Email preferences update within 200ms
```

Alex reviews the spec — it's clear, handles edge cases, and matches his codebase conventions.

### Step 2 — Build the tasks (Builder + Worker, routed)

```bash
ccr code
```

```
/next
```

**First iteration:** `/next` picks `TASK-001` (no dependencies) and runs `/build → /review → /docs`.

- **Builder (o3-mini)** implements the React components, runs `npm run typecheck` and `npm test`
- **Worker (glm-4-flash)** reviews the diff against the spec, emits status `passed`
- **Worker (glm-4-flash)** writes the PR body and opens the PR

Alex reviews the PR, merges it. **Time elapsed: 18 minutes.**

```
/next
```

**Second iteration:** `/next` now picks `TASK-002` (its dependency `TASK-001` is `done`). Same flow — Codex builds the backend, GLM reviews.

---

## Phase 3 — Parallel work on `shop-theme` (same day)

**Context:** `shop-theme` has a list of 5 independent tweaks from the design team — none of them depend on each other.

Instead of `/next` one-by-one, Alex fans them out:

```bash
cd ~/projects/shop-theme
claude
/plan implement the 5 design tweaks (button radius, font weights, spacing adjustments, cart icon update, mobile menu fix)
```

The Architect writes 5 independent tasks (`TASK-001` through `TASK-005`), all `status: planned`, no `depends:`.

```bash
ccr code
/fan-out TASK-001 TASK-002 TASK-003 TASK-004 TASK-005
```

The fan-out spawner:
- Creates 5 git worktrees (`.role-router/worktrees/TASK-001` through `TASK-005`)
- Launches 5 parallel Builders (o3-mini), each in a fresh context
- Streams progress to `.role-router/runs/*.jsonl`

**Result:** 5 tasks built in parallel in ~12 minutes (wall-clock), vs. ~45 minutes sequentially. Each task gets its own PR; Alex reviews and merges them one by one.

---

## Phase 4 — Adopting across all 3 codebases

**`api-gateway` (NestJS backend):**

Alex repeats the same flow:

1. `/plan add rate limiting to the /checkout endpoint`
2. `/next` (Codex builds the middleware, GLM reviews)
3. Merge and repeat

**The beauty:** No per-project configuration needed. The same `~/.claude/commands/*` work in `my-app`, `shop-theme`, and `api-gateway` — role-router is project-agnostic.

---

## Phase 5 — Alex's daily workflow (3 weeks in)

**Morning:** 

```bash
claude
/plan summarize today's priorities based on open issues
```

Architect reads all 3 repos' GitHub issues, writes a consolidated `PLAN.md` with tasks ranked by priority.

**Workday:**

```bash
ccr code
/next     # or /fan-out for independent batches
```

He lets Codex (o3-mini) handle the bulk implementation and GLM-4-flash handle review/docs. His **Codex quota lasts 3× longer** because he's not burning it on review anymore.

**Escalation happens once:**

A task fails its quality gates twice (typecheck + NestJS tests both fail). The escalation rule fires, and **that single task** automatically gets bumped to the escalation Engine (GLM-5.2 in his config). GLM-5.2 fixes the type-level bug, and the task continues. Alex didn't have to intervene — the system self-corrected.

---

## What Alex got out of it

| Before role-router | After role-router |
|---|---|
| Burned Codex on everything (build, review, docs) | Codex only for building; GLM for review/docs |
| Manual PR reviews and PR body writing | GLM handles review + PR bodies automatically |
| Sequential work even on independent tasks | `/fan-out` builds independent tasks in parallel |
| No consistent workflow across 3 codebases | Same `/plan → /build → /review → /docs` everywhere |
| Claude Max quota went unused (didn't know how to use it efficiently) | Max stays on planning; cheaper models handle the bulk |

**Cost impact:** His monthly spend dropped from ~$120 (mostly Codex review work) to ~$40 (Codex for build, GLM for review, Max stays on quota). And he's shipping faster because the parallel builds.

---

## The exact commands Alex runs daily

```bash
# Across any of his 3 repos:
cd ~/projects/my-app    # or shop-theme or api-gateway

# Plan the work (Architect, Max/vanilla):
claude
  /plan [feature description]

# Execute (Builder/Worker, routed):
ccr code
  /next                 # one task at a time
  # or
  /fan-out TASK-A TASK-B TASK-C    # parallel for independent work
```

That's it. No per-project setup, no config files to edit, just the same 3 commands everywhere.

---

## Adapting this story to your setup

- **No Max subscription?** Architect would route through your strongest model (o1 or GLM-5.2) via CCR instead of vanilla Max.
- **Different provider combo?** The interactive CLI proposes a routing based on what you have; you customize per role.
- **One repo instead of three?** The same flow applies — role-router works on any codebase, any size.
