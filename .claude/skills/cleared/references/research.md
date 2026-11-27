Current access pass: 2026-10-14. Publication dates and versions below remain
source claims, not inferred from access date. Previously cited sources not
listed in the current pass are preserved historical provenance, not newly
verified. No agent-effectiveness or compatibility claim follows from this ledger.

# cleared research ledger

## Source 1

Title: Secure Software Development Framework (SSDF) Version 1.1

Author / Organization: NIST

Publication date: 2022-02-03

Version: SP 800-218

URL: https://csrc.nist.gov/pubs/sp/800/218/final

Source type: standard

What it establishes:
Software-release practices should be selected and evidenced according to risk and context.

What this skill adopts:
Choose gate dimensions by artifact type and risk; critical unverified requirements cannot silently pass.

What it does NOT establish:
It does not define one universal release checklist or guarantee production readiness.

Numbers taken from source:
Version 1.1 is the adopted reference version.

Reverify when:
NIST publishes a newer final SSDF version or project risk changes.

## Build provenance

Title: Security levels

Author / Organization: SLSA

Publication date: Versioned page; publication date not established

Version: SLSA specification 1.0 archived guidance

URL: https://slsa.dev/spec/v1.0/levels

Source type: standard

What it establishes:
Build provenance describes the build platform, process, and inputs. Trust and
tamper resistance depend on how provenance is generated and verified.

What this skill adopts:
Bind release evidence to the candidate artifact/commit, distinguish a current
artifact from a remembered green result, and avoid treating provenance presence
as a universal security guarantee.

What it does NOT establish:
It does not require every project to meet a named SLSA level or replace
application, recovery, or acceptance testing.

Numbers taken from source:
No SLSA level is adopted as a release threshold.

Reverify when:
The build platform, artifact provenance, distribution process, or SLSA
specification changes.

## Current decision and source records

Changed artifacts: `SKILL.md` and `gate-dimensions.md` (critical unknown, applicability/recovery)

Behavior changed: Unknown critical auth/data evidence blocks regardless headline feature; immutable candidate-scoped evidence; build/test selection proportional; compatible recovery rather than unsafe down requirement.

Title: Secure Software Development Framework

Author / Organization: NIST

Publication date: 2022-02-03

Version: SP 800-218 1.1 final

URL: https://csrc.nist.gov/pubs/sp/800/218/final

Source type: official docs

What it establishes:
Select secure lifecycle practices by context; framework is not a universal pass checklist.

What this skill adopts:
Apply the current decision above at the affected boundary; preserve existing
workflow when evidence does not justify change.

What it does NOT establish:
It does not prove this skill improves an agent or validate an unobserved runtime.

Numbers taken from source:
Only version identifiers; no comparative measurement.

Reverify when:
The source, installed version, affected contract or tool capability changes.

Access: fetched 2026-10-14; source-specific breadth and live evaluations remain
pending. Offline fallback: inspect available code/configuration and label
source-sensitive behavior unverified.

Title: Security levels

Author / Organization: SLSA

Publication date: versioned; date not established

Version: 1.0 archived guidance, not 1.2

URL: https://slsa.dev/spec/v1.0/levels

Source type: official docs

What it establishes:
Provenance concerns artifact/build identity; presence is not application correctness.

What this skill adopts:
Apply the current decision above at the affected boundary; preserve existing
workflow when evidence does not justify change.

What it does NOT establish:
It does not prove this skill improves an agent or validate an unobserved runtime.

Numbers taken from source:
Only version identifiers; no comparative measurement.

Reverify when:
The source, installed version, affected contract or tool capability changes.

Access: fetched 2026-10-14; source-specific breadth and live evaluations remain
pending. Offline fallback: inspect available code/configuration and label
source-sensitive behavior unverified.
