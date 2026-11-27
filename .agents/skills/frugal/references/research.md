Current access pass: 2026-10-14. Publication dates and versions below remain
source claims, not inferred from access date. Previously cited sources not
listed in the current pass are preserved historical provenance, not newly
verified. No agent-effectiveness or compatibility claim follows from this ledger.

# frugal research ledger

## Source 1

Title: Effective context engineering for AI agents

Author / Organization: Anthropic

Publication date: 2025-09-29

Version: Web article

URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

Source type: official docs

What it establishes:
Context is finite; selective retrieval and compact, high-signal context improve maintainability.

What this skill adopts:
Protect task-critical evidence, search before bulk reading, compress redundant state, and retain source pointers.

What it does NOT establish:
It does not prove that fewer tokens always improve outcomes or support unsupported savings percentages.

Numbers taken from source:
No numerical savings target is adopted.

Reverify when:
Runtime telemetry or context-engineering evidence changes.

## Current decision and source records

Changed artifacts: `measurement.md` (cost denominator/invalidation), `SKILL.md` (routing) and `cost-report.py` (observed arithmetic)

Behavior changed: Compute all-attempt cost per independently correct task; unknown usage stays unknown; invalidate stale summaries and preserve producer exit status under output caps.

Title: Effective context engineering for AI agents

Author / Organization: Anthropic

Publication date: 2025-09-29

Version: engineering article

URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

Source type: official docs

What it establishes:
Select relevant context and retain high-signal state; this is not proof of cost savings.

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
