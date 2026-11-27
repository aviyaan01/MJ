# Screenshot comparison controls

Read when producing or reviewing visual regression evidence.

Record source and target browser/version, platform, viewport, device scale,
theme, locale, font availability, content and UI state. Stabilize fonts and
relevant content with a condition rather than sleeping an arbitrary duration.
Move the pointer when hover changes the image; choose animation treatment
explicitly. Match fixtures or explain differences before changing CSS.

Playwright's visual assertion stabilizes screenshots and compares with a golden
image, but environment differences still matter. Separate a missing baseline
from a matching baseline. Snapshot update modes can create or replace expected
images; a green update run is baseline authorship, not independent comparison.
Retain the original expected, actual, and diff artifacts for a mismatch. Review
why the product changed before accepting an update; do not increase tolerance
or mask the primary action merely to get green.

Mask only genuinely variable or sensitive regions, record each mask, and use
a separate assertion for important content hidden by it. Do not hide a broken
layout, missing error, unauthorized content, or semantic regression in a mask.
A numerical pixel threshold needs an environment-specific rationale; no
universal similarity percentage proves fidelity.

One screenshot cannot establish DOM, focus, navigation, hidden states or
responsive transitions. Preserve native accessible controls even when a source
uses an inaccessible imitation; report the explicit fidelity tradeoff.
