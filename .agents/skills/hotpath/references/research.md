# hotpath research ledger

Accessed 2026-10-14. Sources below were inspected in this upgrade; moving
documentation/branches are not evidence of installed versions or host compatibility.
No numerical default, empirical prevalence, or comparative lift is adopted.

## Source 1

Title: EXPLAIN

Author / Organization: PostgreSQL Global Development Group

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Page identifies PostgreSQL 18; verify target DB version

URL: https://www.postgresql.org/docs/current/sql-explain.html

Source type: official docs

What it establishes:
ANALYZE executes statements, including their effects.

What this skill adopts:
Inspect side effects and prefer safe scratch execution or ordinary planning.

What it does NOT establish:
Rollback does not guarantee every external/nontransactional effect is reversible.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 2

Title: Open and closed models

Author / Organization: Grafana Labs

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living docs; no installed generator version adopted

URL: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/

Source type: official docs

What it establishes:
Completion-coupled iterations can reduce load as response time grows.

What this skill adopts:
Retain offered load and result classes when interpreting latency.

What it does NOT establish:
Does not choose a universal load model.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 3

Title: Constant arrival executor implementation

Author / Organization: Grafana Labs

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Moving master branch; not a pinned tested generator

URL: https://raw.githubusercontent.com/grafana/k6/master/lib/executor/constant_arrival_rate.go

Source type: implementation evidence

What it establishes:
Executor records dropped iterations when scheduled work cannot start.

What this skill adopts:
Check generator capacity alongside target capacity.

What it does NOT establish:
Does not establish application latency or comparative skill lift.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.
