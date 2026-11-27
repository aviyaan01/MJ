# Mobile and accessible rendered evidence

Read for sticky UI, overlays, zoom, dense data, and visual comparisons.

Keep before/after viewport, browser, device scale, theme, locale, content, fonts,
and state comparable. Capture loading and error states only when applicable.
A screenshot shows geometry; keyboard operation and semantic inspection show
other evidence. Do not claim accessibility or responsive behavior from pixels.

For sticky headers/footers and modal actions, tab to the control after scroll,
validation, and content growth. Focus must remain perceivable and not entirely
hidden by author-created content (WCAG 2.4.11, with its scope/exceptions). Check
reflow with long text and zoom rather than one fixed phone width. For mobile
forms, the on-screen keyboard changes usable height: a desktop viewport
emulation is partial evidence. Test on a supported device when available;
otherwise name virtual-keyboard and assistive-technology behavior unverified.

For dialogs, preserve initial focus, trap only while modal, allow the specified
close/cancel behavior, and return focus to a meaningful trigger. Copying an APG
example is not proof it works with the product's browser/assistive technology
combinations; the example itself warns about support gaps.

For offline/error/loading, keep the action's actual state legible. A color-only
badge or disabled button can hide an unresolved save. Preserve existing error
and retry semantics; route a changed durability policy to backend/friction.

Use content-pressure breakpoints, target sizes with applicable exceptions,
visible labels, reduced-motion alternatives, and existing tokens. Do not
replace a user's explicitly requested style because a decorative technique
appears on a generic banned list; fix the concrete barrier and verify it.
