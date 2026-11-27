# friction research ledger

Accessed 2026-10-14. Sources below were inspected in this upgrade; moving
documentation/branches are not evidence of installed versions or host compatibility.
No numerical default, empirical prevalence, or comparative lift is adopted.

## Source 1

Title: Understanding Redundant Entry

Author / Organization: W3C WAI

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: WCAG 2.2 explanatory guidance; no conformance claim adopted

URL: https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html

Source type: official docs

What it establishes:
Redundant input in one process creates barriers, with documented exceptions.

What this skill adopts:
Test entered-value preservation and recovery in the relevant process.

What it does NOT establish:
Does not require saving sensitive data persistently in all forms.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 2

Title: Offline data

Author / Organization: web.dev / Google

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living tutorial with IndexedDB examples; not a required library

URL: https://web.dev/learn/pwa/offline-data

Source type: implementation evidence

What it establishes:
Browser persistence has distinct storage choices, transactions and shared quotas.

What this skill adopts:
Distinguish local storage from remote confirmation; test failed storage and privacy boundaries.

What it does NOT establish:
Its example can insert duplicate rows if repeated; it is not a synchronization/conflict protocol.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.
