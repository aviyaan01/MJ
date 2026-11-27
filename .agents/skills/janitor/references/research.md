Current access pass: 2026-10-14. Publication dates and versions below remain
source claims, not inferred from access date. Previously cited sources not
listed in the current pass are preserved historical provenance, not newly
verified. No agent-effectiveness or compatibility claim follows from this ledger.

# janitor research ledger

## Source 1

Title: Git reference manual

Author / Organization: Git project

Publication date: Living documentation

Version: Current documentation

URL: https://git-scm.com/docs

Source type: official docs

What it establishes:
Git exposes repository state, history, branches, tags, and safe or destructive operations through explicit commands.

What this skill adopts:
Read repository conventions first and gate history rewrites, force pushes, branch deletion, and remote mutation.

What it does NOT establish:
It does not establish universal commit-title lengths or stale-branch ages.

Numbers taken from source:
No numerical threshold is adopted.

Reverify when:
Git behavior or repository policy changes.

## Current decision and source records

Changed artifacts: `SKILL.md` (authorization/candidates), `maintenance-protocol.md` (dirty state) and `hygiene-checklists.md` (commands)

Behavior changed: Snapshot staged/unstaged/untracked/ignored boundaries and attached worktrees; path-scoped dry-run; preserve prior scope authorization; candidate branch never classified from name/age alone.

Title: git-status

Author / Organization: Git project

Publication date: living; manual shows 2.53.0 update

Version: local Git version recorded separately

URL: https://git-scm.com/docs/git-status

Source type: official docs

What it establishes:
Porcelain separates index/worktree state; ignored files require explicit inspection.

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

Title: git-clean

Author / Organization: Git project

Publication date: living; date not established

Version: current manual; verify local help

URL: https://git-scm.com/docs/git-clean

Source type: official docs

What it establishes:
Dry-run lists deletion candidates; ignored files can be included by destructive options.

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

Title: git-worktree

Author / Organization: Git project

Publication date: living; date not established

Version: current manual

URL: https://git-scm.com/docs/git-worktree

Source type: official docs

What it establishes:
Branches can be attached to other checkouts.

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
