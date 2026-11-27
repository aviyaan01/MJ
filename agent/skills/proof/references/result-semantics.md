# Result semantics and failure sensitivity

Read when skips, expected failures, retries, mutation, or partial suites matter.

A process exit and a test outcome are separate evidence. Record the runner,
selected tests, actual collected/executed/passed/failed/skipped counts when
available, unexpected passes, setup errors, and known failures. Zero selected
checks, skipped tests, and xfail are not verified behavior. A green subset
supports that subset; it does not erase a previously red full suite.

For pytest, xfail can record a known expected failure without failing the suite,
and a non-strict unexpected pass can leave the process green. Select reason,
raises and strict behavior to fit the known issue and installed runner version.
Do not adopt a moving main-branch config spelling from a research ledger without
checking the repository's installed version. Do not silently convert an unknown
race or regression into xfail, skip, or retry-until-green.

For regression tests, retain expected assertion failure on the broken revision
and pass on the fix. A syntax/import/setup error is not that failure. When a
failing signal feeds automation (`git bisect run` or equivalent), map
outcomes to the bisect contract: exit 0 means good, 1-127 except 125
means bad, 125 means untestable (revision skipped), anything else aborts.
Mutation probes belong in an isolated copy or controlled worktree; restore them before
running the final suite and preserve unrelated user changes. A mutation that
survives means that probe did not establish sensitivity; inspect the oracle,
reachable path or equivalent mutation before making a correctness claim.

Use a real engine for dialect/locking/RLS properties. A seeded unit property
can verify a state-machine invariant, but cannot prove a separate persistence
transaction. Assert forbidden side effects and persistence as well as statuses.
Tests should target the business rule, not the helper's exact call sequence.
