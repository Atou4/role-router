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

## Issue-tracker flow (optional; Role Router itself uses PLAN.md)
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| to-spec | human | you | `mattpocock/skills` | MIT | Publish the conversation as a spec on the issue tracker. |
| to-tickets | human | you | `mattpocock/skills` | MIT | Publish tracer-bullet tickets with blocking edges to the tracker. |
| triage | human | you | `mattpocock/skills` | MIT | Move issues through triage states and write agent-ready briefs. |
| setup-matt-pocock-skills | human | you | `mattpocock/skills` | MIT | Configure tracker, labels and doc layout for the tracker skills. |

## Meta · skill tooling
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| find-skills | human | model | `vercel-labs/skills` | MIT | Discover installable skills. |

## pstack · design, investigation, verification (you invoke these)
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| architect | human | you | `cursor/plugins` | MIT | Sketch types and module structure before code; design twice via arena; implement against the sketch. |
| arena | human | you | `cursor/plugins` | MIT | Fan out N candidates at one task, pick a base, graft the best of the rest. |
| interrogate | human | you | `cursor/plugins` | MIT | Adversarial multi-model review of a change; synthesised verdict. |
| how | human | you | `cursor/plugins` | MIT | How a subsystem works: traced runtime flow, ownership, placement. |
| why | human | you | `cursor/plugins` | MIT | Why code is shaped the way it is, from history, issues and docs. |
| blast-radius | human | you | `cursor/plugins` | MIT | What a change breaks beyond the diff; prove the safety fact by running code. |
| create-verification-skill | human | you | `cursor/plugins` | MIT | Generate a project-local skill that drives the real app end to end. |
| maintain-verification-skill | human | you | `cursor/plugins` | MIT | Keep a generated verification skill's feature map honest. |
| unslop | human | you | `cursor/plugins` | MIT | Strip AI-sounding prose from writing (used by blast-radius write-ups). |

## pstack principles (cited by architect, arena and poteto-mode)
| Skill | Use | Loaded by | Source | License | What it does |
|---|---|---|---|---|---|
| principle-boundary-discipline | human | you | `cursor/plugins` | MIT | Principle: boundary discipline. |
| principle-encode-lessons-in-structure | human | you | `cursor/plugins` | MIT | Principle: encode lessons in structure. |
| principle-exhaust-the-design-space | human | you | `cursor/plugins` | MIT | Principle: exhaust the design space. |
| principle-fix-root-causes | human | you | `cursor/plugins` | MIT | Principle: fix root causes. |
| principle-foundational-thinking | human | you | `cursor/plugins` | MIT | Principle: foundational thinking. |
| principle-guard-the-context-window | human | you | `cursor/plugins` | MIT | Principle: guard the context window. |
| principle-laziness-protocol | human | you | `cursor/plugins` | MIT | Principle: laziness protocol. |
| principle-make-operations-idempotent | human | you | `cursor/plugins` | MIT | Principle: make operations idempotent. |
| principle-minimize-reader-load | human | you | `cursor/plugins` | MIT | Principle: minimize reader load. |
| principle-outcome-oriented-execution | human | you | `cursor/plugins` | MIT | Principle: outcome oriented execution. |
| principle-prove-it-works | human | you | `cursor/plugins` | MIT | Principle: prove it works. |
| principle-redesign-from-first-principles | human | you | `cursor/plugins` | MIT | Principle: redesign from first principles. |
| principle-separate-before-serializing-shared-state | human | you | `cursor/plugins` | MIT | Principle: separate before serializing shared state. |
| principle-subtract-before-you-add | human | you | `cursor/plugins` | MIT | Principle: subtract before you add. |

## Obsolete
- `to-prd`: renamed to-spec upstream
- `to-issues`: renamed to-tickets upstream
- `diagnose`: renamed diagnosing-bugs upstream
- `zoom-out`: removed upstream
- `caveman`: removed upstream
- `write-a-skill`: removed upstream; skill-creator covers it
- `resolving-merge-conflicts`: removed upstream
- `grill-me`: duplicate of grilling for this workflow
