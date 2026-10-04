# ADR-0005: Engine adapters separate harnesses from providers

## Decision

Bind every Role to an Adapter in `~/.role-router/config.json`:

- `codex` launches the locally installed Codex CLI and uses its existing ChatGPT sign-in.
- `claude` launches vanilla Claude Code and uses its existing subscription authentication.
- `opencode` launches OpenCode with an explicit provider/model ID and initial role prompt.

API-provider credentials remain in environment variables or OpenCode's credential store. Z.AI General API and GLM Coding Plan remain distinct OpenCode providers because their billing modes are not interchangeable.

`scripts/run-role.mjs` loads the canonical role prompt and launches its Adapter. `/next` and `/fan-out` call this runner instead of assuming `claude -p`.

## Why

ChatGPT Plus/Pro Codex access is a product subscription, not an OpenAI API key. OpenCode handles API-backed providers without a local proxy, while Codex CLI preserves subscription authentication. Treating both as the same credential type would fail authentication or encourage unsafe credential copying.

The Handoff Artifact already lets Roles run in fresh sessions, so crossing harness boundaries does not require shared model context.

## Consequences

- Subscription tokens are never read, exported, or proxied by Role Router.
- Codex must be installed and signed in before a `codex` binding can run.
- OpenCode must be installed and the provider must be authenticated before an `opencode` binding can run.
- Prompt behavior remains centralized in `commands/*.md` and is shared by every Adapter.
