# Payment events and tenant authority

Read only for a payment/webhook/tenant boundary. Use the provider's actual event
and API contract; these decisions do not mandate Stripe or PostgreSQL.

## Durable event acceptance

- Verify the signature using the provider SDK's required raw bytes before parsing
  trusted business values. Signature validity proves origin, not authorization
  for the target order, account, amount, currency, or environment.
- Acknowledge after safe durable acceptance (inbox/queue or committed effect),
  not after an in-memory enqueue that a crash can lose. Keep ingress bounded.
- Track delivery identity separately from effect identity. A repeat event ID
  and two event IDs describing one paid object can both repeat fulfillment.
  Define the business transition and unique effect key, scoped by the relevant
  provider account/tenant/environment. Do not blanket-deduplicate all events
  for one object: later refunds and other legitimate transitions must survive.
- Bind a client idempotency key to its original tenant/operation and validated
  intent. Reusing the key with changed parameters is a conflict, not success for
  the old operation. Conversely, two intentional commands with identical bodies
  and different request identities must not be collapsed by a body-hash guess.
- Treat ordering as unspecified unless the provider guarantees it. A timestamp
  alone may tie or describe creation rather than causal order. Reconcile current
  provider state when required; reject stale transitions without blocking a
  valid refund or compensation. Record the unresolved reconciliation path.
- Couple local effect and dedup/inbox state atomically. If an external effect
  cannot join that transaction, cover crash-after-effect with a provider
  idempotency key or durable reconciliation. Marking done before a failing
  effect silently loses work; marking done after an unprotected effect repeats it.

## Tenant enforcement

Trace authority from authenticated principal through membership/role validation
to every object query, job, cache key, export, and file URL. A client-selected
workspace ID is a requested scope, not trusted authority. Validate scope before
lookup and before enqueuing; workers need an explicit trusted scope too.

For PostgreSQL RLS, verify the real application database role. Superuser,
BYPASSRLS, and ordinary table-owner connections can bypass policies; an admin
fixture does not prove application isolation. Exercise permitted and forbidden
reads AND writes as the deployed app role. With connection pools, keep tenant
settings transaction-scoped or reset correctly; test tenant A followed by B on
one reused connection. Do not claim SQLite reproduces RLS or PostgreSQL locking.

## Smallest faithful verification

Replay one event twice, replay a second event ID for the same effect, reorder
pending/paid events, and inject a failure between effect and ledger commit.
Assert effect count, final state, retry/recovery, and no cross-tenant access.
Use sandbox/fake effects; no real charges, messages, or production replay.

## Interrupted client commands

Client acknowledgment and server commit are separate events. A connection loss
can leave the result unknown after a committed effect. Keep a stable, persisted
operation identity until acknowledged or reconciled; retrying with a new identity
can duplicate the effect. Never delete queued work before the send completes.
This requires both durable client storage and a correctly scoped server receipt;
an in-memory mock establishes neither physical-device durability nor real
provider guarantees. Route uncertain save feedback to the UX owner when needed.

## Authoritative real-time input

Resolve player/tenant ownership from the authenticated server principal, not a
client-selected player or claimed result. Validate bounded commands against the
server's state and session generation. Define duplicate and ordering semantics
for the actual transport: sequence tracking, reorder window, retry or resync.
Do not silently discard a valid gap if the contract requires reconciliation.
Old-session packets must not mutate a new session. Exercise replay, forged owner,
invalid input and reconnect ordering using a fixed event sequence before changing
the handler. A pure state model does not prove socket timing, engine behavior,
anti-cheat completeness or multiplayer deployment health.
