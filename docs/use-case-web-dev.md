# Use case: Codex Plus with Z.AI GLM

This is the recommended mixed-authentication setup for a developer who has:

- ChatGPT Plus or Pro with Codex access
- A Z.AI GLM Coding Plan or General API key
- No requirement for a Claude Max subscription

## Why two adapters

Codex access is consumed through the locally signed-in Codex CLI. Z.AI is consumed through its native OpenCode provider using an API key. Role Router never attempts to convert one authentication type into the other.

## Setup

Run `./install.sh` and select:

1. Codex CLI subscription: yes
2. Claude Max: no, unless you also want it as an alternative
3. Exactly one Z.AI mode:
   - GLM Coding Plan for `https://api.z.ai/api/coding/paas/v4`
   - General API for `https://api.z.ai/api/paas/v4`

Export the key printed by the installer:

```bash
export ZAI_API_KEY="..."
```

The generated `~/.role-router/config.json` recommends:

```json
{
  "roles": {
    "architect": { "adapter": "codex" },
    "builder": { "adapter": "opencode", "provider": "zai-coding-plan", "model": "zai-coding-plan/glm-4.7", "keyEnv": "ZAI_API_KEY" },
    "worker": { "adapter": "opencode", "provider": "zai-coding-plan", "model": "zai-coding-plan/glm-4.7", "keyEnv": "ZAI_API_KEY" },
    "escalation": { "adapter": "opencode", "provider": "zai-coding-plan", "model": "zai-coding-plan/glm-5.2", "keyEnv": "ZAI_API_KEY" }
  }
}
```

For the General API selection, the provider prefix is `zai` instead of `zai-coding-plan`.

## Daily flow

```bash
role-router run architect "add phone verification to onboarding"
role-router run builder TASK-001
role-router run worker TASK-001
role-router run docs TASK-001
```

The Architect writes `PLAN.md`; Builder and Worker reconstruct their context from that file and the git diff. If the Builder records a two-attempt blocker:

```bash
role-router run escalation TASK-001
```

Independent tasks can use the configured Builder Adapter in parallel:

```bash
node ~/.claude/role-router/fan-out.mjs TASK-001 TASK-002
```

## Authentication checks

```bash
codex login status
test -n "$ZAI_API_KEY"
opencode auth list
```

Do not put Codex OAuth data into OpenCode and do not use an `OPENAI_API_KEY` merely because you have ChatGPT Plus. OpenAI API billing is separate.
