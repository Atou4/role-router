# Role Router

A portable workflow that routes software-engineering work to the cheapest capable model **by the role the work needs**, not by technology — so Claude/Max quota is spent only on high-leverage planning, and the bulk of building and admin work runs on cheap models. Reusable across any repo and shareable with others via a git repo + install script.

## Language

**Role**:
The kind of engineering work a request needs — the routing unit. One of Architect, Builder, or Worker. The system routes on Role; models are swappable behind it.
_Avoid_: Task type, model name

**Architect**:
The planning/reasoning/decomposition role: design, strategy, spec-hardening, tradeoff analysis. Runs on Claude via the Max subscription.
_Avoid_: Planner-model, Opus (the model is an implementation detail of the role)

**Builder**:
The implementation role: writing code, tests, flows, refactors, executing a plan. The 60-80% bulk. Runs on a cheap-but-capable coder model via OpenRouter.
_Avoid_: Coder-model, Kimi (Kimi is the current engine, not the role)

**Worker**:
The administrative-engineering role: documentation, review, summaries, changelogs, PR bodies, status updates. Runs on the cheapest model via OpenRouter.
_Avoid_: Reviewer-model, DeepSeek

**Engine**:
The concrete model currently assigned to a Role. Engines change; Roles do not. Pinned in the CCR config and verified live at install time.
_Avoid_: Model (acceptable loosely, but Engine names the role-bound slot)

**CCR**:
Claude Code Router — the proxy between Claude Code and model providers that, when Claude Code is launched through it (`ccr code`), routes requests to OpenRouter Engines instead of Anthropic.
_Avoid_: Router (ambiguous with the whole system), proxy

**Vanilla Context**:
A normal Claude Code session (not launched through CCR), authenticated by the Max subscription. The only place Architect/`/plan` work runs, so it stays on Max quota and never hits the paid Anthropic API.
_Avoid_: Default session, Claude session

**CCR Context**:
A Claude Code session launched via `ccr code`, where Builder/Worker commands route to OpenRouter Engines. Never used for Architect work.
_Avoid_: Routed session

**Handoff Artifact**:
The file(s) that carry state between Roles across separate sessions/Engines — the board task spec, the working diff, and `board.json`. Replaces in-context model-switching: the Architect writes the spec, the Builder reads it.
_Avoid_: Context passing, shared memory

**Hint Hook**:
A free, local `UserPromptSubmit` hook that keyword-classifies a prompt and *suggests* a Role command (e.g. "looks like Builder — run /build?"). Suggests only; never auto-switches; costs no model call.
_Avoid_: Classifier, auto-router

**Escalation**:
The rule that promotes a single Builder task to the Architect Engine (Claude) when it fails its quality gates (typecheck / Maestro) twice — capping the rework tax of a cheap Builder.
_Avoid_: Retry, fallback

**Fan-out**:
Running many independent Builder tasks at once, each as a separate headless `claude -p` process with a fresh context window, each in its own git **Worktree**, all routed through CCR to the cheap Engine. The parallel counterpart to the sequential `/next` loop; only valid for tasks with no dependency between them.
_Avoid_: Nested subagent (that's the upstream mechanism, not the Role-Router feature), Swarm

**Wave**:
A set of tasks whose dependencies are all already Done, so they can be fanned out together. `/next` builds one task; `/fan-out` builds a Wave.
_Avoid_: Batch (acceptable loosely), Sprint

**Worktree**:
A separate git working directory (`git worktree`) checked out to a task's `task/<id>` branch, created per task during a Fan-out so concurrent Builders never collide on a shared checkout.
_Avoid_: Clone, Sandbox

## Relationships

- A **Role** is served by exactly one **Engine** at a time; an **Engine** can be swapped without changing the **Role** or the workflow.
- **Architect** runs only in a **Vanilla Context** (Max); **Builder** and **Worker** run in a **CCR Context** (OpenRouter).
- A Role command maps to a Role: `/plan` → Architect, `/build` → Builder, `/review` + `/docs` → Worker.
- The **Architect** produces a **Handoff Artifact**; the **Builder** consumes it; the **Worker** documents/reviews the result.
- The **Hint Hook** suggests a Role command but never selects an **Engine** itself.
- **Escalation** moves a failing **Builder** task to the **Architect** **Engine**.

## Example Dialogue

> **Dev:** "Routing decides Kimi vs Claude per request, right?"
> **Domain expert:** "No — routing decides the **Role**. Right now Builder's **Engine** happens to be Kimi, but if a better coder ships next month we swap the Engine and nothing else changes. The workflow is built on Roles, not models."

## Flagged Ambiguities

- "router" was used for both CCR and the whole system; resolved: **CCR** is the proxy mechanism, **Role Router** is the overall workflow.
- "minimize usage" meant both Max quota AND API dollars; resolved: **Architect** stays on Max (protects quota), **Builder**/**Worker** go to cheap OpenRouter Engines (protects dollars).
- "model" was used where "role" was meant; resolved: requests route on **Role**; the **Engine** is the swappable model bound to a Role.
