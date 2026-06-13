# Architect work runs in the Vanilla Context, never through CCR

Architect/`/plan` work runs only in a normal Claude Code session (the **Vanilla Context**), authenticated by the Max subscription. Builder and Worker work runs in a **CCR Context** (`ccr code`) that routes to OpenRouter Engines. This is why the workflow has two ways to launch Claude Code.

The reason is non-obvious and load-bearing: CCR intercepts *all* Claude Code traffic and authenticates providers with API keys, not the Max OAuth token. If `/plan` ran inside a CCR Context, the highest-value Architect calls would be billed to the paid Anthropic API *and* would not draw down the Max quota we already pay for — defeating both goals (protect quota, cut dollars) on the exact work we most wanted Max to cover. Keeping planning in the Vanilla Context is the only way to spend Max quota on Architect work.

## Considered Options

- **Everything through CCR (one launch method).** Rejected: simplest UX, but pays API dollars for Architect calls and wastes Max quota.
- **CCR Anthropic-provider with Max OAuth passthrough.** Rejected for now: CCR isn't built for subscription auth; fragile and hard to teach others. Revisit only if CCR adds first-class Max support.

## Consequences

- Users launch two ways: plain `claude` for `/plan`, `ccr code` for `/build` `/review` `/docs`.
- The plan cannot be passed in-context across the boundary; it is carried by the **Handoff Artifact** (board task spec + diff + `board.json`) — see ADR-0003.
