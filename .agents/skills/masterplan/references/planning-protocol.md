# Planning protocol: make execution independent of planner memory

Use this for full plans, high-risk slices, or replanning. Lightweight plans can
stay in the entrypoint format.

## Decision record

For a material choice, record decision, evidence, scope, alternatives,
consequence, reversibility, owner, and recheck trigger. Mark unverified premise
and create its discovery slice before actions that depend on it.

## Slice contract

| Field | Required content |
| --- | --- |
| Outcome | one observable behavior or state change |
| Evidence | confirmed files, existing behavior, dependency context |
| Action | coherent work, not microsteps |
| Invariants | contracts, data, security, compatibility, or operations preserved |
| Verification | command, test, observation, or explicit unavailable boundary |
| Recovery | reversible action, migration path, or user checkpoint |
| Dependencies | prerequisite slice, conflict, and postponed work |

## Replan rule

Replan when assumption changes architecture, public behavior, data model,
security posture, deployment order, cost, or acceptance criteria. A local file
adjustment preserving these is an execution deviation. Never use a replan to
conceal scope expansion.

## Discovery-first examples

- Validate installed library capability before designing around it.
- Map migration and deployment sequence before proposing data change.
- Trace authorization boundary before adding protected route.

Discovery ends with evidence and decision, not endless research.

## Acceptance and evidence coverage

Assign stable criterion IDs from the brief to slices and their verification.
Every criterion has an owner and oracle; every slice earns its place by a
criterion, prerequisite evidence, or required recovery work. Keep headings
like `Slice 1` explicit in durable plans for downstream navigation, while
allowing different project-native formats to express the same contract.

Separate code rollback from data restoration. A reverted application commit
cannot undo deleted data or new writes made under a changed schema. For staged
migrations, plan compatible readers/writers, backfill checks, cutover evidence,
and restoration or irreversible owner gate before removing the old path.
For expand/migrate work, the contract (removal) phase is its own owned
slice with deprecation markers: skipping contract leaves the system worse
than before, so a migration plan without a contract step is incomplete.

A compiler pass checks static integration; a file's existence is not functional
proof. If verification is unavailable, name the unavailable boundary rather
than invent a command. Discovery slices may close with evidence instead of a
user-visible feature, but must have a question and stop predicate.
