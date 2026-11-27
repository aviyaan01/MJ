# Adverse browser conditions

Read only for critical journeys affected by mobile/network/recovery behavior.

Choose cases from the journey contract: offline before submit, loss during
submit, reconnect, failed API response, expired session, duplicate tap, refresh,
back/deep-link, touch target, focused input with keyboard, or reduced motion.
For an unknown write outcome, check both visible feedback and persisted result
through an authorized test surface. Reconnect must not repeat a charge or
silently overwrite newer work. Unsupported offline behavior can correctly show
a recoverable error; it must not falsely show success.

Playwright offline emulation changes regular browser network traffic; it does
not establish OS-wide connectivity loss or WebRTC interruption. Existing media
connections can remain active. Physical keyboard/touch and assistive technology
coverage also require appropriate devices. State the boundary rather than
calling viewport emulation a mobile-device certification.

Establish the actual offline prerequisite, including service-worker registration,
activation, page control and cached data needed by that journey. A mock-routing
test that blocks service workers cannot establish service-worker-backed offline
behavior. Keep those test modes separate and observe whether the expected
request went through the page, service worker or external network.

Wait for the journey's bounded visible/business readiness assertion. A network
quiet period is not proof that hydration, a save or a background subscription is
ready; polling/streams can also prevent it indefinitely. With Playwright, use
the matching installed-version locator/assertion APIs rather than a mandatory
`networkidle` wait. Preserve timeouts and missing readiness as real findings.

Expected error traffic and expected console output are assertions to evaluate.
A 422 with correct inline feedback can PASS; a 200 that never persisted the
order can FAIL. Record unexpected failures separately. The generated matrix
uses console-assessed and network-matches-contract, not an all-2xx requirement.

Evidence status is per capability: interaction/assertion, screenshot, console,
network, persistence. If tooling lacks one, record that gap explicitly and
narrow the verdict. Keep the original failure directory and separate reruns.
Redact before writing durable logs; do not capture secrets first and rely on a
later report to hide them. A screenshot is not proof of the whole journey.
