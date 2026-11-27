# Workload-sensitive capacity experiments

Read when load results, queue recovery, or autoscaling determine a decision.

Separate demand offered, accepted, completed successfully, retried, shed, and
abandoned. A closed test issues its next iteration after completion and can
reduce offered load precisely when the service slows. This is appropriate for
some fixed-user journeys, but cannot establish an independent arrival-rate
objective. For externally arriving demand use an open arrival model and record
scheduled versus achieved arrivals and dropped iterations. The load generator
itself may be the limit. Do not silently omit rejected or timed-out work from
user completion and latency conclusions.

Keep classes separate: cheap reads, write transactions, uploads, exports,
long-lived sessions, per-tenant bursts, and periodic jobs can saturate different
resources at the same average request rate. Derive connection/fanout demand
from each class; identify the downstream cap before suggesting more workers.

For backlog B (jobs), admitted rate A and successful completion rate C (jobs/s),
a steady planning estimate of recovery time is B/(C-A) seconds ONLY when C>A.
If C<=A there is no finite drain time under those assumptions. Include startup,
retries, poison work, burst duration, deadlines and quota changes as exclusions
or separate scenarios. These formulas are scenario arithmetic, not observed
capacity or a queueing guarantee.

When Kubernetes is present, inspect resource requests, readiness, missing
metrics, stabilization and cluster/provider headroom. Autoscaler calculations
can dampen or skip actions with unavailable metrics and not-ready pods. More
replicas may exhaust a database pool or quota. Retain the measured delay from
signal to ready capacity; never treat a controller's target as supplied capacity.

State the smallest measurement that could reverse the decision. Keep the
monolith when it meets the objective; name the evidenced isolation or ownership
constraint that would justify distribution.
