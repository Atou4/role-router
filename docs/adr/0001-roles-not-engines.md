# Route on Roles, not Engines

The system classifies every request by the **Role** it needs — Architect (planning), Builder (implementation), Worker (admin/docs/review) — and binds each Role to a swappable **Engine** (model). Routing decisions, commands, and workflows are expressed in terms of Roles; the concrete model behind a Role is config.

We did this because models churn fast: today's best cheap coder will be replaced within months. By building the workflow on three stable Roles and treating Engines (Claude, Kimi-tier, DeepSeek-tier) as replaceable bindings in the CCR config, we can adopt a new model by editing one config line without touching commands, hooks, or muscle memory — ours or anyone else's who adopts the repo.

## Consequences

- Commands are named `/plan` `/build` `/review` `/docs` (Roles), never `/kimi` or `/opus` (Engines).
- Engine IDs live only in `ccr/config.template.json` and are verified live at install time.
- The shared vocabulary in `CONTEXT.md` forbids using a model name where a Role is meant.
