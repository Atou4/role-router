# Role Router vs. GSD Core — what to learn, what to keep

A grounded comparison against [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core) (`@opengsd/gsd-core`, MIT, "Git. Ship. Done."), the most mature spec-driven multi-agent system in the same space. Read this to decide what to steal — not to feel behind. The two systems optimize different things.

## TL;DR

GSD is a **product** (≈33 agents, ≈70 commands, npm + plugin + 10-runtime installer, i18n docs). Role Router is a **focused tool** (3 roles, ~6 commands, one install script). GSD is bigger and more capable on parallelism, verification, and state. Role Router wins on **simplicity** and on the one thing GSD structurally *can't* do: optimize **Claude Max quota** as a budget.

## The core difference: what each one optimizes

| | Role Router | GSD Core |
|---|---|---|
| **Founding problem** | minimize spend — **Max quota *and* API $** | context rot (quality decay as the window fills) |
| **Routing axis** | by **Role**, across **providers** (Claude Max ↔ cheap OpenRouter via CCR) | by **agent/tier**, within one provider family (Opus/Sonnet/Haiku); other providers are a config option |
| **Cost lever** | cheap Engine for 60–80% of work; Architect stays on Max | tier-escalation (start cheap, bump one tier on soft-failure) |
| **Max-quota awareness** | **yes — the design center** | **no** — GSD's own research notes Claude Code doesn't expose Max limits to hooks ([CC #32796]); it can't see or target Max quota |
| **Granularity** | 3 roles | 6-stage loop (Discuss→Plan→Execute→Verify→Ship) over ~33 agents |
| **Handoff** | files (board task / `PLAN.md`) | files (`.planning/` — `STATE.md`, `PLAN.md`, `CONTEXT.md`, `SUMMARY.md`, `VERIFICATION.md`) |
| **Parallelism** | `/fan-out` (worktree-isolated parallel Builders) + sequential `/next` | **wave-based**: dependency-grouped parallel execution + 4 parallel researchers |
| **Verification** | Worker reviews the diff | `gsd-verifier` checks **REQ-ID + decision coverage** and emits routable status |
| **Human gate** | manual PR merge | status-driven (`passed`/`gaps_found`/`human_needed`) + plan-check convergence + supply-chain checkpoint |
| **Distribution** | clone + `install.sh` | npx installer, CC plugin, 10+ runtimes, 5-language docs |

**The headline correction:** GSD is *not* Claude-only and *does* cost-route (tier profiles `quality`/`balanced`/`budget`/`inherit`, per-agent model overrides incl. `openai/o3`, `google/gemini-2.5-pro`, and `--ollama` for zero-API-cost local review). Where it differs is the axis: GSD routes **tiers inside Anthropic** by default and treats cross-provider as config; Role Router makes **cross-provider, Max-vs-cheap** the spine. And GSD has **no Max-quota budget** at all — that remains Role Router's genuine moat.

## Things to steal from GSD (prioritized)

1. **Status-driven router contract.** *(highest leverage, cheap)* Make `/review`/verify emit a normalized status — `passed` / `gaps_found` / `human_needed` — into the task's board frontmatter, and have `/next` branch on it instead of on prose. Mirrors GSD's `STATE.md.next_action` + `VERIFICATION.md` routing. Turns the loop from "read the report and decide" into a deterministic state machine.
2. **Dependency-wave execution.** Add an explicit `depends:` field to every task spec. `/fan-out` already runs an independent wave in parallel; `depends:` lets `/next` *compute* the next wave automatically (build all dep-free tasks, wait, repeat) instead of one task at a time. This is GSD's biggest functional edge.
3. **Requirement-coverage verification, not just diff review.** Have the Worker check every acceptance criterion / REQ-ID and every `CONTEXT.md` decision was actually implemented — not only "tests pass." GSD's `gsd-verifier` is its quality backbone.
4. **Multi-model adversarial plan review before any build.** Route 2–3 of the *cheapest* Engines as blind plan reviewers and converge the spec until zero HIGH-severity concerns (GSD's `plan-review-convergence`, ≤3 cycles, stall-detect). Cheap insurance against a bad spec sending an expensive Builder down the wrong path.
5. **Context-headroom hooks.** A long `/next` (or Architect) session can silently compact and drop board state. GSD hooks `PreCompact`/`Stop`/`SubagentStop` to warn first. Add a `PreCompact` hook that flushes loop state to disk.
6. **Lightweight escape hatches.** GSD ships `/gsd-quick`, `/gsd-fast`, `/gsd-spike` for sub-phase work and concedes the full loop is overkill for small tasks. Add a `/quick` that skips plan→build→review ceremony for a one-file change.
7. **Supply-chain / package-legitimacy checkpoint** that survives autonomous mode — halt the Builder on a suspicious dependency even under `/fan-out`.
8. **Atomic state locking.** If we parallelize Builders that write a shared board (today `/fan-out` sidesteps this with one worktree per task), a merged board write needs an `O_EXCL` lock like GSD's `STATE.md.lock`.

## What Role Router already does that GSD does not

1. **Cross-provider role routing as the architecture**, not a config corner — cheap OpenRouter Builder via CCR *inside* the Claude Code harness, vs GSD shelling out to separate CLIs (Gemini/Codex/Ollama) for non-Anthropic work.
2. **Dual cost objective incl. Max quota** — GSD optimizes API dollars only and literally can't see Max limits.
3. **Radical simplicity** — 3 roles vs 33 agents / 70 commands. GSD's docs admit "overhead… latency… ceremony for simple tasks." Far lower adoption cost.
4. **In-harness CCR routing** for the build step — lighter than spawning a second CLI per non-Anthropic call.

## Suggested roadmap order

`/fan-out` (done) → `depends:` in specs → wave-aware `/next` → status-driven verify contract → adversarial plan review → context-headroom hook → `/quick` escape hatch. Each is independently shippable; the first three together close GSD's parallelism gap while keeping the 3-role model intact.

[CC #32796]: https://github.com/anthropics/claude-code/issues/32796
