# Release protocol: authorize, observe, recover

Use this reference for production, traffic changes, migrations, or a failed
release. Preview work uses the entrypoint unless it exposes material risk.

## Release record

Capture target, immutable artifact or commit, explicit authorization, method,
environment names, migration sequence, fingerprint, health and smoke checks,
observation boundary, rollback method, and owner. Rebuild record if target,
artifact, authorization, or migration state changes.

## Migration sequencing

Prefer compatible expand, deploy, backfill, contract sequencing when old and new
versions overlap. A destructive migration needs backup/restore or approved
forward-fix plan before release. Require contract-phase evidence (old path
removed, or removal scheduled with a named owner), not strategy prose alone.
Green build does not prove data compatibility.

## Evidence boundary

Record command or CI result, release identifier, public response fingerprint,
smoke outcomes, logs, cache or async completion signal, and observation end.
Dashboard green is deployment evidence, not product behavior evidence.

## Incident decision

Contain traffic expansion first. Roll back only when prior artifact and data
compatibility are known; otherwise propose forward fix, maintenance action, or
owner escalation. Preserve evidence, expose no secret values, and do not repeat
unchanged deployment attempts.

## Bounded observation and rollback proof

Set a target-specific observation window and maximum attempts before deployment.
On pending remote build, stale fingerprint, network outage or failed smoke,
record deployed/pending/unverified/failed separately. Stop traffic expansion;
do not repeat a deploy to manufacture success. Test a cache-busted request only
when safe and compare it with the normal user-facing path.

Rollback needs available previous artifact, authorization and compatibility
with current schema, secrets, external services and jobs. Vercel rollback can
restore earlier build/configuration assumptions without undoing external DB
changes; check these separately. After authorized recovery, verify the prior
fingerprint and core behavior through the same public route. CLI zero or
controller availability alone cannot prove recovery.
