# headroom research ledger

Accessed 2026-10-14. Sources below were inspected in this upgrade; moving
documentation/branches are not evidence of installed versions or host compatibility.
No numerical default, empirical prevalence, or comparative lift is adopted.

## Source 1

Title: Horizontal Pod Autoscaling

Author / Organization: Kubernetes Authors

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living docs; no controller version adopted

URL: https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/

Source type: official docs

What it establishes:
Readiness and missing metrics affect scaling decisions.

What this skill adopts:
Model ready-capacity delay and downstream caps when Kubernetes is present.

What it does NOT establish:
Does not require Kubernetes or a universal utilization target.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 2

Title: Replica calculator implementation

Author / Organization: Kubernetes Authors

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Moving master branch; not a deployed controller version

URL: https://raw.githubusercontent.com/kubernetes/kubernetes/master/pkg/controller/podautoscaler/replica_calculator.go

Source type: implementation evidence

What it establishes:
Replica calculation groups missing/unready pods and adjusts scaling calculation.

What this skill adopts:
A desired replica count is not immediate usable capacity.

What it does NOT establish:
Does not predict this application's throughput.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 3

Title: Open and closed models

Author / Organization: Grafana Labs

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living docs; no installed k6 version adopted

URL: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/

Source type: official docs

What it establishes:
Closed iterations couple new arrivals to completion.

What this skill adopts:
Match workload model to arrival contract; retain offered and dropped demand.

What it does NOT establish:
Does not make open load universally preferable for fixed-user journeys.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.
