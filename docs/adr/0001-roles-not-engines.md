# Route on Roles, not Engines

The system classifies every request by the **Role** it needs — Architect (planning), Builder (implementation), Worker (admin/docs/review) — and binds each Role to a swappable **Engine** (model). Routing decisions, commands, and workflows are expressed in terms of Roles; the concrete model behind a Role is config.

We did this because models churn fast. By treating Engines as replaceable bindings in `~/.role-router/config.json`, we can adopt a new model or harness without touching commands, hooks, or muscle memory.

## Consequences

- Commands are named `/plan` `/build` `/review` `/docs` (Roles), never `/kimi` or `/opus` (Engines).
- Role-to-Adapter and provider/model bindings live in `~/.role-router/config.json`; credentials stay in each harness's authentication store or environment.
- The shared vocabulary in `CONTEXT.md` forbids using a model name where a Role is meant.
