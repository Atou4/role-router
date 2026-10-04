# Role Router

A personal orchestrator that dispatches software-engineering work across paid coding agents (Codex, Claude Code, OpenCode) **by the role the work needs**. Planning runs on top-tier models; execution runs on lighter ones.

## Language

**Role**:
The kind of engineering work a request needs — the routing unit. One of Architect, Builder, or Worker. The system routes on Role; models are swappable behind it.
_Avoid_: Task type, model name

**Role Override**:
An explicit user choice of Architect, Builder, or Worker for an invocation. It is the escape hatch when the user already knows which kind of work is needed.
_Avoid_: Model override

**Operation**:
The concrete activity performed within a Role, such as planning, direct implementation, review, documentation, or fan-out. Operation determines the workflow prompt and Permission Policy; Role determines the Engine binding.
_Avoid_: Role, command name

**Work Item**:
A persistently identified unit of user intent that survives sessions and Role transitions. Every invocation creates or resumes one; planned tasks reuse their task ID, while direct requests receive an automatic identity. A Work Item does not require a plan unless its scope demands one.
_Avoid_: Conversation, model session

**Passed**:
A non-terminal Work Item state meaning its Operation-specific evidence satisfies the current acceptance criteria and it is ready for human delivery. Passed is not Done; an open PR remains Passed until merge.
_Avoid_: Complete, delivered

**Review Gate**:
The default independent Worker review required after a code-changing Builder Operation passes its verification gates and before a PR is proposed. It is read-only and may be waived only by explicit repository policy, with the waiver disclosed to the user.
_Avoid_: Builder self-review, automatic approval

**Done**:
The terminal state for human-accepted delivery. A code-changing Work Item becomes Done only after its PR is merged by the user; a non-code Work Item requires explicit human acceptance.
_Avoid_: Agent finished, tests passed, PR opened

**Architect**:
The planning/reasoning/decomposition role: design, strategy, spec-hardening, tradeoff analysis. Runs on the configured Architect Adapter, commonly Codex CLI with ChatGPT Plus/Pro.
_Avoid_: Planner-model, Opus (the model is an implementation detail of the role)

**Builder**:
The implementation role: writing code, tests, flows, refactors, executing a plan. The 60-80% bulk. Commonly runs on Z.AI GLM through OpenCode.
_Avoid_: Coder-model, GLM (the model is an implementation detail)

**Worker**:
The administrative-engineering role: documentation, review, summaries, changelogs, PR bodies, status updates. Runs on the configured Worker Adapter.
_Avoid_: Reviewer-model, GLM

**Engine**:
The concrete model currently assigned to a Role. Engines change; Roles do not. A Role binding selects an Adapter and, for API-backed engines, a provider/model route.
_Avoid_: Model (acceptable loosely, but Engine names the role-bound slot)

**Adapter**:
The launcher for an authenticated agent harness: `codex`, `opencode`, or vanilla `claude`. Adapters own process invocation; they never translate or copy subscription credentials.
_Avoid_: Provider

**Provider**:
An API service selected through OpenCode, such as Z.AI General API, Z.AI GLM Coding Plan, OpenRouter, or direct OpenAI API. Providers authenticate with explicit API keys.
_Avoid_: Harness, subscription

**Binding Resolution**:
The precedence rule that determines the Adapter and Engine serving a Role: an explicit command-line override wins over an explicitly created repository policy, which wins over the user-wide default. The selected binding remains explainable to the user.
_Avoid_: Provider routing, model selection

**Consent Boundary**:
The rule that Role Router proposes rather than performs consequential transitions. Changing Role after launch, crossing a provider or billing boundary, opening a PR, or replacing an unavailable Engine requires explicit user confirmation. PR merge remains exclusively human-controlled. Confident initial Role selection and ordinary launch within the resolved binding do not cross this boundary.
_Avoid_: Confirmation for everything, silent fallback

**Permission Policy**:
The effective approval and workspace-access constraints for an invocation. Interactive work inherits the Adapter's safe native behavior; headless or parallel work declares its policy before launch, and unattended approval requires explicit user or repository authorization.
_Avoid_: Engine capability, auto-approve by default

**OpenCode**:
The API-backed coding-agent harness. It supports Z.AI, OpenRouter, DeepSeek, Moonshot/Kimi, and many other providers without a local proxy daemon.
_Avoid_: Router (ambiguous with the whole system), proxy

**OpenCode Context**:
An OpenCode session launched in the target repository with a role prompt and explicit provider/model ID.
_Avoid_: Routed session

**Handoff Artifact**:
The file(s) that carry state between Roles across separate sessions/Engines — the board task spec, the working diff, and `board.json`. Replaces in-context model-switching: the Architect can hand planned work to Builder, and Builder can hand discovered planning blockers back to Architect.
_Avoid_: Context passing, shared memory

**Escalation**:
A user-confirmed transition from Builder to the configured Architect after a planning blocker is discovered or the configured failure threshold is reached. Builder writes a Handoff Artifact before the transition; Role Router never changes Roles silently. When Architect finishes, Role Router offers to return the work to Builder; declining preserves a resumable continuation.
_Avoid_: Automatic model switch, fallback

**Fan-out**:
Running many independent Builder tasks at once, each through the configured Builder Adapter with a fresh context and its own git **Worktree**.
_Avoid_: Nested subagent (that's the upstream mechanism, not the Role-Router feature), Swarm

**Wave**:
A set of tasks whose dependencies are all already Done, so they can be fanned out together. `/next` builds one task; `/fan-out` builds a Wave.
_Avoid_: Batch (acceptable loosely), Sprint

**Work Graph**:
An approved set of Work Items and their blocking relationships. The Architect may propose decomposition, but no queue or Wave exists until the user approves the items and edges.
_Avoid_: Automatic task list, unapproved queue

**Worktree**:
A separate git working directory checked out for an isolated Work Item, created only through an explicitly approved parallel or isolation workflow. Ordinary interactive work remains in the user's current checkout; Role Router proposes rather than performs branch or worktree transitions during resume.
_Avoid_: Clone, Sandbox

## Relationships

- A **Role** is served by exactly one **Engine** at a time; an **Engine** can be swapped without changing the **Role** or the workflow.
- Every invocation creates or resumes one **Work Item**, which can move between Roles without depending on a model session's private context.
- Verification can move a Work Item to **Passed**; only human-accepted delivery moves it to **Done**.
- A code-changing Work Item normally crosses the **Review Gate** before a PR proposal.
- A multi-task request may produce a proposed **Work Graph**; only an approved graph can expose a **Wave** for fan-out.
- Each Role binding selects an **Adapter**. Subscription-backed Codex/Claude and API-backed OpenCode credentials remain separate.
- **Binding Resolution** applies command-line override, then repository policy, then user-wide defaults.
- The **Consent Boundary** prevents silent Role transitions and cross-provider fallback.
- A **Permission Policy** is resolved independently from the Engine and cannot be silently elevated by Role Router.
- A Role command maps to a Role: `/plan` → Architect, `/build` → Builder, `/review` + `/docs` → Worker.
- An **Operation** selects the workflow prompt and **Permission Policy** independently from Role-to-Engine routing.
- The **Architect** produces a **Handoff Artifact**; the **Builder** consumes it; the **Worker** documents/reviews the result.
- **Escalation** moves a blocked **Builder** task to the configured **Architect** only after user confirmation and a written **Handoff Artifact**.

## Example Dialogue

> **Dev:** "Routing decides Codex vs GLM per request, right?"
> **Domain expert:** "No — routing decides the **Role**. The Role binding then chooses its Adapter and Engine. We can swap either without changing the workflow."

## Flagged Ambiguities

- **Role Router** selects role adapters; OpenCode performs provider/model selection for API-backed roles.
- "minimize usage" meant both Max quota AND API dollars; resolved: **Architect** stays on Max (protects quota), **Builder**/**Worker** go to cheap OpenRouter Engines (protects dollars).
- "model" was used where "role" was meant; resolved: requests route on **Role**; the **Engine** is the swappable model bound to a Role.
