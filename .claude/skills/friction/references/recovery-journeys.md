# Recovery journeys: loss of connection, session, or usable space

Read when tasks collect data, save work, or run across a mobile interruption.

Walk submit → interrupted response → retry/reload/back → reconnect. Distinguish
not sent, pending, failed, saved locally, and confirmed remotely. A timeout can
leave the server outcome unknown; repeated taps must not become repeated
purchases or create duplicate records. Friction specifies understandable status
and recovery; backend owns safe retry/reconciliation. A success toast alone
cannot settle an unknown durable result.

Preserve entered values on validation and recoverable errors when the product
allows it. Re-entry of information within one process can be an accessibility
barrier (WCAG 3.3.7, including its exceptions). Test recovery from session expiry
without inventing a new identity or bypassing authorization. A new account or
tenant must not inherit a prior user's draft, error, or cached private view.

Do not prescribe browser persistence universally. Sensitive forms, shared
machines, logout, storage quota/eviction, and retention policy can make it unsafe.
If offline work is supported, distinguish local durable storage from confirmed
server state, explain conflict resolution and queued work, and test a failed
storage write. If offline work is unsupported, retain an honest recoverable
error rather than promising background synchronization.

For mobile forms, test the focused field and next action with the on-screen
keyboard, long localized errors, zoom, back navigation, and orientation when
supported. Emulation is partial evidence; report unavailable device testing.

Record observed completion/recovery and wrong turns. Improved conversion or
reduced abandonment remains a research hypothesis without real user evidence.
