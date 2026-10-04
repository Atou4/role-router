# ADR-0004: Adopt skills v1.1 within the role pipeline

## Decision

Keep Role Router's `/plan -> /build -> /review -> /docs` commands as the executable delivery pipeline, while adopting mattpocock/skills v1.1 concepts inside the matching Roles.

- `/plan` is the local-board adapter for **Grilling -> Spec -> Tickets**. It uses `grill-with-docs`, `to-spec` semantics, and `to-tickets` semantics, then writes the existing Handoff Artifact rather than publishing duplicate tracker artifacts.
- `/wayfinder` is the Architect path for planning that cannot fit safely in one strong-model session. It produces a collaborative map across sessions; once the route is clear, `/plan <map reference>` converts it to Role Router task specs.
- `/build` remains the routed implementation command and uses `tdd` at the seams agreed in the spec. It incorporates `implement`'s focused-test/typecheck cadence without invoking that skill, because `implement` also reviews and commits in the Builder session.
- `/review` remains the routed verification command and uses `code-review` as supporting guidance while preserving Role Router's normalized review statuses.

The canonical upstream names are `to-spec` and `to-tickets`. The superseded `to-prd` and `to-issues` names are removed from the catalog and role manifest.

## Why

The upstream lifecycle improves planning quality: facts are discovered, decisions remain with the human, confirmation gates prevent premature implementation, test seams are agreed before building, and ticket dependencies expose a parallel frontier. Role Router still needs its own commands because they carry cost-routing context and its `PLAN.md`/`.agent-board/` status contract across separate Engines.

Replacing `/plan` with tracker-native `/to-spec` and `/to-tickets` would bypass the Handoff Artifact understood by `board.mjs`, `/next`, and `/fan-out`. Duplicating both outputs would create competing sources of truth.

## Consequences

- Standard features keep the same user-facing Role Router commands.
- Large planning efforts take multiple Architect sessions through Wayfinder before entering the delivery loop.
- `/plan` is interactive: it cannot decide product or architecture questions for the user, and it must wait for ticket approval.
- Users choosing the fully tracker-native upstream flow can still do so, but that path does not use Role Router's board scheduler unless it is later converted through `/plan`.
