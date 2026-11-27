Current access pass: 2026-10-14. Publication dates and versions below remain
source claims, not inferred from access date. Previously cited sources not
listed in the current pass are preserved historical provenance, not newly
verified. No agent-effectiveness or compatibility claim follows from this ledger.

# runway research ledger

## Source 1

Title: Deployments

Author / Organization: Kubernetes project

Publication date: Living documentation

Version: Current documentation

URL: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

Source type: official docs

What it establishes:
Deployments support controlled rollout status and rollback for applicable workloads.

What this skill adopts:
Detect the real release model, sequence configuration, data, and code safely, then verify public state and rollback triggers.

What it does NOT establish:
It does not imply every platform uses Kubernetes or that a successful CLI command proves the release is live.

Numbers taken from source:
No universal timeout or rollout percentage is adopted.

Reverify when:
The target platform or its release model changes.

## Current decision and source records

Changed artifacts: `SKILL.md`, `platforms.md`, `release-protocol.md` and `check-receipt.py` (bounded observations)

Behavior changed: Scope preview data/cost/exposure; accept trusted candidate CI build; preserve dirty work; platform-checked recovery; bounded fingerprint/smoke observations and data-compatible rollback.

Title: Deployments

Author / Organization: Kubernetes project

Publication date: living; date not established

Version: current concepts documentation; target cluster version required

URL: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

Source type: official docs

What it establishes:
Controller progress and Deployment revision rollback do not restore application data.

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

Title: Performing an Instant Rollback

Author / Organization: Vercel

Publication date: living; date not established

Version: current platform guidance; plan and CLI verified per project

URL: https://vercel.com/docs/instant-rollback

Source type: official docs

What it establishes:
Rollback restores previous deployment assumptions; external data and configuration must be checked separately.

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
