# Completion gate: what must be verified before "done"

The gate maps the **type of change** to the **required verification**.
Report every applicable row as verified (with evidence) or unverified
(with reason). Any unverified required gate means the report says
"complete with unverified items", never a bare "complete".

## Gate matrix

| Change touches | Required gates |
| --- | --- |
| Any changed behavior | affected acceptance/regression checks · applicable project-required checks · diff self-review; broaden when shared dependencies or failures justify it |
| UI / user-visible behavior | changed interaction/viewport checks with browser evidence when available; assess console/network against the expected contract, including deliberate denial paths |
| Changed auth, session, permission, payment or PII trust boundary | scoped security review and relevant negative-principal/replay checks; `harden` when specialist review is needed |
| Data model / migrations | forward migration on a disposable representative copy · preservation/compatibility checks · demonstrated recovery appropriate to the change: safe down migration, backup restore or forward fix; an irreversible change never earns a fictional down path |
| Public API contract | consumer check: existing callers updated or compatible · versioning/deprecation noted |
| Performance-sensitive path | before/after benchmark with numbers, or an explicit "not measured" |
| Background jobs / queues | idempotency check · retry behavior exercised |
| Docs / README claims | claims match reality (commands actually run) |

## Evidence format

One line per gate:

```text
verified:   npm test: 42 passing, 0 skipped (run 2026-09-14 14:02)
unverified: browser flow: no browser automation available this session
```

## Self-review without subagents

When no fresh-context reviewer is available, do a disciplined second pass
instead of skipping review:

1. Wait until the full diff exists (don't review slice-by-slice only).
2. Read the diff **as the reviewer**, against the plan's acceptance
   criteria: list what you'd flag.
3. Fix blockers/majors. Nits go in the report as findings, un-fixed is
   fine.
4. Say in the report that review was self-review (fresh-context review
   unavailable): honesty about the review's weakness is part of the gate.

## Non-negotiables

- "Tests pass" without having run them = fabrication. Never.
- **Scope containment:** Never modify a test simply to make it pass (unless the test was fundamentally broken). Do not touch files outside the planned slice without explicit authorization (this is "silent scope improvisation" and causes severe agent drift).
- An unverified gate is reported in those words, with the reason.
- Gate results never get bulked up to look complete ("everything works"
  is not evidence; command output is).
- A code revert cannot restore deleted data or undo an external side effect.
  Record the recovery owner and authorization separately; missing critical
  evidence blocks release even when implementation is finished.
