# backend research ledger

Accessed 2026-10-14. Sources below were inspected in this upgrade; moving
documentation/branches are not evidence of installed versions or host compatibility.
No numerical default, empirical prevalence, or comparative lift is adopted.

## Source 1

Title: Receive Stripe events in your webhook endpoint

Author / Organization: Stripe

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Living documentation; no fixed API or SDK version adopted

URL: https://docs.stripe.com/webhooks

Source type: official docs

What it establishes:
Delivery can repeat or arrive out of order; raw bytes are required for signature verification.

What this skill adopts:
Separate event receipt and business-effect deduplication; verify current state when needed.

What it does NOT establish:
Does not prove atomic local effects or tenant authorization.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 2

Title: Row Security Policies

Author / Organization: PostgreSQL Global Development Group

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Page identifies PostgreSQL 18; check target engine/version separately

URL: https://www.postgresql.org/docs/current/ddl-rowsecurity.html

Source type: official docs

What it establishes:
Superusers, BYPASSRLS roles and ordinarily table owners bypass RLS.

What this skill adopts:
Run tenant read/write tests with the real application role.

What it does NOT establish:
Does not establish another database's isolation behavior.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Source 3

Title: Webhook implementation

Author / Organization: Stripe

Publication date: Not verified; living documentation/source accessed 2026-10-14

Version: Moving master branch; inspected, not a pinned installed SDK

URL: https://raw.githubusercontent.com/stripe/stripe-node/master/src/Webhooks.ts

Source type: implementation evidence

What it establishes:
Signature construction performs authenticity/recency checks.

What this skill adopts:
Use the installed provider SDK rather than custom signature parsing.

What it does NOT establish:
Signature verification does not supply a fulfillment ledger or authorize an order.

Numbers taken from source:
None. Version identifiers describe source scope, not measurements.

Reverify when:
The target installed version, protocol, runtime, standard or relevant behavior changes.

## Follow-through source, accessed 2026-10-14

Title: Making retries safe with idempotent APIs

Author / Organization: Malcolm Featonby / Amazon Web Services

Publication date: Living page; publication date not established

Version: Current source accessed; use installed API/runtime version in a project

URL: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/

Source type: official docs

What it establishes:
Same request identity with different parameters is a conflict; distinct intentional requests must not be collapsed merely because payloads match.

What this skill adopts:
Bind idempotency keys to validated operation/tenant/intent; reject mismatches and preserve separate intentional commands. Encoded in boundary-cases.md.

What it does NOT establish:
It does not prove the local app, host or skill behavior; no provider/browser trial is implied.

Numbers taken from source:
No efficacy, latency or prevalence figures adopted.

Reverify when:
Installed tool/provider version, affected boundary or source semantics change.
