# Execution protocol: one verified slice at a time

Use this reference for medium or high-risk work, deviations, failures, or an
interrupted implementation. Low-risk slices can use entrypoint loop.

## Slice record

Record outcome, current evidence, files touched, protected invariants,
verification, recovery path, deviations, and status: done, blocked, deferred,
or needs replan. A checkbox is evidence-backed state, not intent.

## Deviation triage

| Type | Action |
| --- | --- |
| Local implementation adjustment | record reason and verification; continue after checks |
| Unknown file or behavior | discovery before implementation continues |
| Architecture or scope change | stop and return affected slices to masterplan |
| New external, destructive, paid, or production effect | apply gate and await authorization |

## Failed-check response

1. Preserve command output, diff, and baseline comparison if available.
2. Identify a distinct hypothesis or diagnostic.
3. Repair inside active slice unless evidence requires replan.
4. Re-run relevant verification and inspect diff.
5. Stop after two unproductive attempts; report blocker.

## Interruption handoff

State active slice, changed paths, checks and results, dirty-tree overlap,
recovery path, unresolved risk, and next safe action. Never claim completion
from partial implementation.

## Secret denial and exact completion evidence

Configuration inspection begins with names in source or `.env.example`, never
a blanket `.env` read. When the host denies a read, stop that read branch. Use
permitted names-only artifacts when enough, continue independent implementation,
and report the limitation. Do not retry the protected file through another tool.

Before marking a slice done, record changed behavior, current diff scope,
command/observation, exit/result, and which criterion it proves. Distinguish
`implemented`, `verified`, `blocked`, and `unverified`; a plan checkbox or an
existing file is not runtime evidence. Report verification in chat even when
a durable decision log exists, without manufacturing green for absent tooling.

On resume, compare the active slice record to actual diff/tree and relevant
commands. Do not redo completed work or reuse results from another candidate.
A flaky check gets a bounded diagnostic; rerunning until green is not proof.
