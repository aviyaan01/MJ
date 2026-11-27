# Discovery evidence protocol

Use this for deep maps, risk maps, monorepos, or work that a later planner or
debugger will rely on. Quick answers need only the relevant observed path.

## Evidence record

| Field | Capture |
| --- | --- |
| Question and target | decision to support and app/package boundary |
| Provenance | repository root, commit or tree state, and check date |
| Observed paths | manifests, entrypoints, configuration, symbols, tests read |
| Traced path | one real route, command, or lifecycle with symbol anchors |
| Inferences | conclusion plus observed evidence supporting it |
| Unknowns | missing runtime, ownership, generated, or external evidence |
| Recheck trigger | commit, package, config, or task change that invalidates map |

## Monorepo routing

Identify workspace manager, package graph, target app, shared packages, and
deployment ownership. Follow only dependencies that change the target behavior.
Report sibling packages as not covered unless read; do not generalize one app's
scripts or patterns to the whole repository.

## Risk-map evidence

A hotspot needs an observed complexity signal, churn signal when Git is
available, trust boundary, test gap, or contradiction. Churn alone is not a
defect. Name the likely owning skill and the evidence gap before recommending a
change.

## Handoff rule

Give next worker source paths, symbols, command definitions, active unknowns,
and the next narrow read. Do not paste inventory output or turn a map into an
implementation plan.

## Dynamic and generated ownership

An import or file name is not proof of runtime registration. For plugins,
reflection, dependency injection, dynamic routes, and generated clients, inspect
registration/config plus a representative caller or test. Mark the runtime edge
inferred when execution cannot be observed. Name the generator and source of
truth before suggesting edits; do not make a generated output the primary owner.

Use ignore-aware file discovery when available. Vendor/build/cache directories
are excluded by default, then entered deliberately only for the question that
needs them. Inventory counts and churn are heuristics, not defect or coverage
scores. A changed branch/tree/config invalidates affected map claims even when
`docs/repo-map.md` has a recent timestamp.

## Inventory helper contract

The `inventory` helper named by the entrypoint takes `[directory] [--json]`.
It is read-only and uses Bash plus
standard Unix find/awk/grep/sort/wc tools; JSON mode additionally needs Python 3.
Git enriches churn when present. Missing tooling means use targeted manual
search and disclose which inventory dimensions were unavailable. Counts are
filename/extension heuristics, not test coverage or maintainability metrics.

The scanner excludes node_modules, Git, dist/build, virtual environments,
Python caches, vendor and generated directories in its source statistics.
Custom generated/cache locations require an explicit scoped investigation;
this heuristic does not implement every ecosystem's ignore rules.
