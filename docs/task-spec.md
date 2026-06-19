# Task spec & status contract

Two small conventions let `/next` and `/fan-out` schedule work deterministically instead of re-reading prose every time: a **status** every Role writes, and a **`depends:`** field the scheduler reads. They are the role-router equivalent of GSD's `STATE.md` routing — see [`comparison-gsd.md`](comparison-gsd.md).

## Where tasks live

- **`.agent-board/` repos** (e.g. a board.json state machine): use the repo's own board tool; map its columns onto the statuses below.
- **Everything else:** a root `PLAN.md`, one level-2 section per task. The portable driver `scripts/board.mjs` reads/writes it.

## PLAN.md task format

```markdown
## TASK-003 — Add phone verification
- status: planned
- depends: TASK-001, TASK-002

### Scope
…
### Acceptance Criteria
- [ ] REQ-1 …
### Edge Cases
### Verification
```

- The heading id must match `TASK-\S+`. Title after a `—`, `-`, or `:` is optional.
- `status:` and `depends:` are read only **above** the first `###` subsection.
- `depends:` is a comma/space list of task ids; empty = independent.

## The status lifecycle

```
planned ──/build──▶ building ──gates green──▶ review ──/review──▶ passed ──/docs──▶ (PR) ──merge──▶ done
                                                          │
                                                          ├─▶ gaps_found  ──/build (re-fix)──▶ review
                                                          └─▶ human_needed ─▶ stop (a human decides)
```

| Status | Meaning | Set by |
|---|---|---|
| `planned` | Architect hardened it; **buildable** | `/plan` |
| `building` | a Builder is working it | `/build` (start) |
| `review` | built, gates green, awaiting verification | `/build` (green gates) |
| `passed` | verification clean — ready to ship | `/review` |
| `gaps_found` | verification found Must-fixes — back to the Builder | `/review` |
| `human_needed` | verification hit a question only a human can answer | `/review` |
| `done` | merged | `/next` reconcile / `/docs` on merge |

**Buildable** = `status: planned` **and** every `depends:` task is `done`. A **wave** is every buildable task at once (what `/fan-out` builds); `/next` builds the first buildable task.

## How the commands branch on status

- `/next` — marks merged tasks `done`; if any task is `gaps_found`, it offers to re-`/build` it first; if `human_needed`, it stops and surfaces the question; otherwise it builds the next buildable task. Never builds a non-`planned` task.
- `/fan-out` — builds the buildable wave (`board.mjs wave`), minus tasks that touch the same files (a judgment the command makes — the driver only knows dependencies, not file overlap).
- `/review` — its whole job is to emit one of `passed` / `gaps_found` / `human_needed`. That status, not its prose, is what the loop routes on.

## Driver commands

```bash
node scripts/board.mjs next               # JSON of the next buildable task (or NONE)
node scripts/board.mjs wave               # JSON array of the buildable wave
node scripts/board.mjs list               # summary, flags BUILDABLE
node scripts/board.mjs status TASK-003    # prints one task's status
node scripts/board.mjs set-status TASK-003 review
```

(Installed globally at `~/.claude/role-router/board.mjs`; inside this repo it's `scripts/board.mjs`.)
