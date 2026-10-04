# Architect subscription auth stays in its native CLI

> **Status:** Superseded in part by ADR-0005. Vanilla Claude Max remains supported, but Codex CLI is also a subscription-backed Architect Adapter.

Architect work that uses a subscription runs through that product's native authenticated CLI. API-backed roles run through OpenCode.

The reason is load-bearing: subscription authentication and API keys are different products. Keeping planning in the native Codex or Claude CLI preserves the subscription entitlement, while OpenCode uses explicit provider credentials for API-backed work.

## Considered Options

- **Everything through one API harness.** Rejected: it would turn subscription-backed planning into separately billed API traffic.
- **Copy subscription credentials between harnesses.** Rejected: unsupported and unsafe.

## Consequences

- `run-role.mjs` selects the correct native Codex, Claude, or OpenCode Adapter from the role binding.
- The plan cannot be passed in-context across the boundary; it is carried by the **Handoff Artifact** (board task spec + diff + `board.json`) — see ADR-0003.
