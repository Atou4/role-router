# Skill catalog

Generated from [`skills.json`](./skills.json) by `role-router skills readme`; edit the JSON, not this file.

Skills are not vendored: each entry points at its upstream source. **use** is who calls it: a Role (handed to it by dispatch via [`skills-manifest.json`](../skills-manifest.json)) or **human** for skills you invoke yourself. **loaded by** `you` means the skill sets `disable-model-invocation`, so no role can load it.

```bash
role-router skills install all            # or a group, or a use: architect | builder | review | docs | human
role-router skills doctor                 # per-agent check: missing, user-only, obsolete, diverged, budget
```

Installs go to Claude Code, Codex and OpenCode together (`claude-code, codex, opencode`).

## Planning · grounding, grilling, design
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| grilling | architect | model | `mattpocock/skills` | MIT | Interview loop: facts from the code, decisions from the user one at a time. |
| domain-modeling | architect | model | `mattpocock/skills` | MIT | Pin domain vocabulary in GLOSSARY.md and record decisions as ADRs. |
| codebase-design | architect | model | `mattpocock/skills` | MIT | Deep-module vocabulary: seams, interface depth, information hiding. |
| prototype | architect | model | `mattpocock/skills` | MIT | Throwaway prototype to answer a behaviour or UI question by seeing it. |
| research | architect | model | `mattpocock/skills` | MIT | Primary-source research written to a Markdown file in the repo. |
| why | architect | model | `cursor/plugins` | see repo | Recover the rationale behind existing code from history, issues and docs. |
| wayfinder | human | you | `mattpocock/skills` | MIT | Chart work too large for one session as a map of investigation tickets. |
| improve-codebase-architecture | human | you | `mattpocock/skills` | MIT | Find deepening opportunities and grill through the one you pick. |

## Delivery · build, review, ship
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| tdd | builder | model | `mattpocock/skills` | MIT | Red-green-refactor at the seams the spec agreed. |
| diagnosing-bugs | builder | model | `mattpocock/skills` | MIT | Reproduce, minimise, hypothesise, fix: used before a Builder escalates. |
| code-review | review | model | `mattpocock/skills` | MIT | Standards and Spec axes reviewed independently. |
| pr | docs | model | `mattpocock/skills` | MIT | PR body: summary visual, before/after evidence, merge-danger call. |
| retro | human | you | `mattpocock/skills` | MIT | After a session: improve the agent's environment, not the code. |
| blast-radius | human | you | `cursor/plugins` | see repo | Find what a change breaks beyond the diff and prove the safety fact by running code. |
| create-verification-skill | human | you | `cursor/plugins` | see repo | Generate a project-local skill that drives the real app end to end. |

## Issue-tracker flow (optional; Role Router itself uses PLAN.md)
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| to-spec | human | you | `mattpocock/skills` | MIT | Publish the conversation as a spec on the issue tracker. |
| to-tickets | human | you | `mattpocock/skills` | MIT | Publish tracer-bullet tickets with blocking edges to the tracker. |
| triage | human | you | `mattpocock/skills` | MIT | Move issues through triage states and write agent-ready briefs. |
| setup-matt-pocock-skills | human | you | `mattpocock/skills` | MIT | Configure tracker, labels and doc layout for the tracker skills. |

## Stack rules · mobile
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| react-native-skills | builder | model | `vercel-labs/agent-skills` | MIT | React Native and Expo performance and best-practice rules. |
| flutter-coding-rules | builder | model | `local` | yours | Dart/Flutter coding standards (first-party, not published). |
| flutter-performance | builder | model | `hoangnguyen0403/agent-skills-standard` | see repo | Flutter rebuild and memory optimisation rules. |
| flutter-security | builder | model | `hoangnguyen0403/agent-skills-standard` | see repo | OWASP Mobile rules for Flutter. |
| swiftui-expert-skill | builder | model | `local` | see source | SwiftUI state, composition and performance rules. |
| In-App Purchases | builder | model | `openclaw/skills` | MIT-0 (unverified) | IAP and subscriptions across iOS, Android and Flutter. |

## Stack rules · backend
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| supabase | builder | model | `supabase/agent-skills` | Apache-2.0 | Supabase database, auth, edge functions, RLS. |
| supabase-postgres-best-practices | builder | model | `supabase/agent-skills` | Apache-2.0 | Postgres query, schema and index rules. |
| firebase-basics | builder | model | `firebase/agent-skills` | see repo | Firebase CLI, project setup and config files. |

## Stack rules · UI
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| ui-ux-pro-max | builder | model | `nextlevelbuilder/ui-ux-pro-max-skill` | MIT | UI/UX styles, palettes, typography and UX guidelines (large: load only for UI tasks). |

## Meta · skill tooling
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| find-skills | human | model | `vercel-labs/skills` | MIT | Discover installable skills. |

## Obsolete
- `to-prd`: renamed to-spec upstream
- `to-issues`: renamed to-tickets upstream
- `diagnose`: renamed diagnosing-bugs upstream
- `zoom-out`: removed upstream
- `caveman`: removed upstream
- `write-a-skill`: removed upstream; skill-creator covers it
- `resolving-merge-conflicts`: removed upstream
- `grill-me`: duplicate of grilling for this workflow
