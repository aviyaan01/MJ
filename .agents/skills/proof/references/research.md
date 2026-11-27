# proof research ledger

Accessed 2026-10-14. Sources below were inspected in this upgrade; moving
documentation/branches are not evidence of installed versions or host compatibility.
No numerical default, empirical prevalence, or comparative lift is adopted.

## Source 1

Title: How to use skip and xfail

Author / Organization: pytest developers

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living stable docs; verify installed runner/config names

URL: https://docs.pytest.org/en/stable/how-to/skipping.html

Source type: official docs

What it establishes:
Skip, XFAIL and XPASS have outcome semantics different from a verified assertion.

What this skill adopts:
Report selected, executed, skipped and expected-failure outcomes separately.

What it does NOT establish:
A green process is not evidence skipped behavior works.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 2

Title: Skipping and expected-failure implementation

Author / Organization: pytest developers

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Moving main branch; not installed pytest evidence

URL: https://raw.githubusercontent.com/pytest-dev/pytest/main/src/_pytest/skipping.py

Source type: implementation evidence

What it establishes:
Strict unexpected pass is failed; non-strict unexpected pass can be passed.

What this skill adopts:
Review reason and strict behavior rather than silently greening failures.

What it does NOT establish:
Does not authorize quarantine, external issue creation or broad mutation.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.
