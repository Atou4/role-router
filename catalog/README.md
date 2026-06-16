# Skill Catalog

The agent skills this workflow recommends, **classified by domain** and mapped to Role Router roles. We don't vendor skill bodies — each entry points to its **original source** + an install command, so there's no redistribution-license risk and skills stay current with upstream. Machine-readable version: [`skills.json`](./skills.json).

**Install one:** `npx skills add <owner/repo@skill> -g -y` (`-g` → `~/.claude/skills`).
**Install by domain / all:** `./install-skills.sh <domain|all>` (see repo root).

> Aggregator repos (`mattpocock/skills`, `openclaw/skills`, `alirezarezvani/claude-skills`) nest skills in folders. If a `@skill` id 404s, fall back to the repo-level install, e.g. `npx skills add mattpocock/skills -g -y`. Re-verify sources/licenses before relying on them.

Roles: **architect** → `/plan` · **builder** → `/build` · **worker** → `/review` `/docs` · **meta** → cross-cutting.

## Mobile · React Native / Expo
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| react-native-skills | builder | `vercel-labs/agent-skills` | MIT | `npx skills add vercel-labs/agent-skills@vercel-react-native-skills -g -y` |
| In-App Purchases | builder | `openclaw/skills` | MIT-0¹ | `npx skills add openclaw/skills@in-app-purchases -g -y` |

## Mobile · Flutter / Dart
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| flutter-coding-rules | builder | first-party² | unknown | copy from `~/.claude/skills/flutter-coding-rules` |
| flutter-performance | builder | first-party² | unknown | copy from `~/.claude/skills/flutter-performance` |
| flutter-security | builder | first-party² | unknown | copy from `~/.claude/skills/flutter-security` |
| flutter-cicd | worker | first-party² | unknown | copy from `~/.claude/skills/flutter-cicd` |

## Web · UI / UX Design
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| ui-ux-pro-max | builder | `nextlevelbuilder/ui-ux-pro-max-skill` | MIT | `claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill && claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill` |

## Backend · Data / Postgres
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| supabase | builder | `supabase/agent-skills` | Apache-2.0 | `npx skills add supabase/agent-skills@supabase -g -y` |
| supabase-postgres-best-practices | builder | `supabase/agent-skills` | Apache-2.0 | `npx skills add supabase/agent-skills@supabase-postgres-best-practices -g -y` |
| senior-backend | builder | `alirezarezvani/claude-skills` | see repo | `npx skills add alirezarezvani/claude-skills@senior-backend -g -y` |

## Planning · Architecture / Design
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| grill-with-docs | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@grill-with-docs -g -y` |
| grill-me | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@grill-me -g -y` |
| improve-codebase-architecture | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@improve-codebase-architecture -g -y` |
| prototype | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@prototype -g -y` |
| to-prd | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@to-prd -g -y` |
| zoom-out | architect | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@zoom-out -g -y` |

## Delivery · Workflow / Issue tracking
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| to-issues | worker | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@to-issues -g -y` |
| triage | worker | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@triage -g -y` |
| handoff | worker | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@handoff -g -y` |
| setup-matt-pocock-skills | worker | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@setup-matt-pocock-skills -g -y` |

## Quality · Testing / Debugging
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| tdd | builder | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@tdd -g -y` |
| diagnose | builder | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@diagnose -g -y` |

## Meta · Skill tooling / Output control
| Skill | Role | Source | License | Install |
|---|---|---|---|---|
| write-a-skill | meta | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@write-a-skill -g -y` |
| find-skills | meta | `openclaw/skills` | MIT¹ | `npx skills add openclaw/skills@find-skills -g -y` |
| caveman | meta | `mattpocock/skills` | MIT | `npx skills add mattpocock/skills@caveman -g -y` |

---
¹ License not individually confirmed — verify before redistributing.
² **first-party**: no public source found for the `flutter-*` pack (no author metadata, private clean-architecture vocabulary). Treated as your own. If you want these shareable, add a LICENSE and we can vendor them into `catalog/first-party/`.
