# handsfree research ledger

## Source 1

Title: Effective context engineering for AI agents

Author / Organization: Anthropic

Publication date: 2025-09-29

Version: Web article

URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

Source type: official docs

What it establishes:
Agent autonomy depends on tools, context, and execution environment, while unnecessary scaffolding can create maintenance cost.

What this skill adopts:
Authorize reversible in-scope work by default, gate destructive or external effects, and never bypass host controls.

What it does NOT establish:
It does not grant permissions, waive host policy, or define one approval model for every runtime.

Numbers taken from source:
No fixed retry count or cost threshold is adopted.

Reverify when:
Host permission models or security guidance changes.

## Source 2

Title: Security

Author / Organization: Anthropic / Claude Code

Publication date: Living docs; update date not exposed

Version: current fetched docs; host version not pinned; accessed 2026-10-14

URL: https://code.claude.com/docs/en/security

Source type: official security guidance

What it establishes:
Host permission remains separate from task intent.

What this skill adopts:
Host permission remains separate from task intent. Apply only within the handsfree decision boundary; the local counterexample determines the narrow correction. This source does not establish every revised instruction.

What it does NOT establish:
No cross-host permission guarantee; no measured lift for this revision.

Numbers taken from source:
No empirical numbers or threshold adopted.

Reverify when:
Relevant source, target environment, permissions or acceptance criterion changes.

## Source 3

Title: git-status documentation

Author / Organization: Git project

Publication date: Living manual; update not assigned here

Version: current fetched manual; local git version not pinned; accessed 2026-10-14

URL: https://git-scm.com/docs/git-status

Source type: official tool docs

What it establishes:
Index/worktree evidence must be read before editing.

What this skill adopts:
Index/worktree evidence must be read before editing. Apply only within the handsfree decision boundary; the local counterexample determines the narrow correction. This source does not establish every revised instruction.

What it does NOT establish:
A branch name alone does not isolate dirty state; no measured lift for this revision.

Numbers taken from source:
No empirical numbers or threshold adopted.

Reverify when:
Relevant source, target environment, permissions or acceptance criterion changes.

## Source 4

Title: Effective harnesses for long-running agents

Author / Organization: Anthropic

Publication date: 2025-11-26

Version: reported Claude Agent SDK setup; accessed 2026-10-14

URL: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Source type: official implementation report

What it establishes:
Incremental work and recoverable handoff.

What this skill adopts:
Incremental work and recoverable handoff. Apply only within the handsfree decision boundary; the local counterexample determines the narrow correction. This source does not establish every revised instruction.

What it does NOT establish:
Specific setup, not mandatory per-step ceremony; no measured lift for this revision.

Numbers taken from source:
No empirical numbers or threshold adopted.

Reverify when:
Relevant source, target environment, permissions or acceptance criterion changes.
