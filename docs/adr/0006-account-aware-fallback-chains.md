# ADR-0006: Account-aware fallback chains with tier consent

## Decision

Each Role binds to an ordered **chain** of profiles instead of a single adapter. A profile is an agent account plus a model plus a **tier** (`top` or `lite`). Planning chains start with top-tier models (e.g. GPT-6 Sol, Claude Opus); execution chains start with lighter ones (e.g. Claude Sonnet, GPT-6 Luna, GLM).

When a headless run hits a usage limit, Role Router pauses that **account** in a user-wide ledger, writes a handoff file, and continues the same work on the next profile in the chain.

When the next usable profile is a lower tier than the chain head and the Role's policy is `ask` (the default for Architect), Role Router stops and asks the user to **wait** for the earliest reset, **switch** to the lighter model (the resulting plan is flagged for re-review), or **abort**. Execution Roles fall through automatically.

Reviews prefer a profile on a different account from the task's Builder.

## Why

Every paid plan has usage windows; a dead run that needs manual restarting on another tool is the main friction in daily use. Limits apply per account, so tracking them per model would keep retrying an exhausted plan. Planning quality is the point of the top tier, so dropping it is the user's call, while execution work is interchangeable enough to fall through silently.

## Consequences

- Listing a profile in a Role's chain is the user's standing consent to fall back to it. The Consent Boundary's ban on silent cross-provider fallback now applies only to profiles outside the chain and to tier drops on `ask` Roles.
- Limits are detected automatically only in headless runs. Interactive sessions consult the ledger before launch; `role-router limits pause` records a limit seen interactively.
- Configs at `version: 1` keep working: each binding becomes a one-profile chain.
- Design rationale: [docs/design/dispatch.md](../design/dispatch.md).
