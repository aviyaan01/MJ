# Performance experiment hazards

Read for database execution, load generation, or ambiguous before/after data.

PostgreSQL EXPLAIN plans without running the statement; EXPLAIN ANALYZE executes
it, including side effects. A transaction rollback can revert transactional DB
writes but cannot undo arbitrary external calls or every nontransactional effect
(such as consumed sequence values). Inspect the statement/functions and prefer
a scratch database or ordinary EXPLAIN when execution is unsafe. Never run a
production modifying query merely to profile it.

For load tests, declare whether arrivals are independent of response time
(open) or wait on previous completion (closed). A closed workload can reduce
arrival rate as the system slows, hiding overload. An open executor can still
run out of load-generator capacity and drop scheduled iterations. Record
scheduled, started, successful, rejected, timed-out and dropped work. Compare
latency distributions with offered load, not successful samples alone.

For before/after, keep hardware/runtime/build/data/query parameters/arrival
shape/warmup equivalent. Separate cold-cache and warm-cache runs; interleave
or repeat where drift matters. Record spread and the predeclared noise rule.
The measure-report helper computes a delta; it does not estimate variance,
statistical significance or causal attribution. Its significant field means
only that a supplied effect threshold was met. Zero change remains NOISE even
when the threshold is zero. Preserve regressions and reverted experiments.

Operation-count reductions are useful deterministic evidence, but not latency
or user-perceived speedup. Recheck output, auth, consistency and nearby write,
memory or queue costs before retaining an optimization.
