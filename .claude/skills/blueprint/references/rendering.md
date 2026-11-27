# Renderer and architecture evidence boundaries

Read when producing HTML or accepting external Mermaid definitions.

The bundled checker is a heuristic, not Mermaid's grammar: valid repeated node
references or delimiters in labels can be flagged, and invalid syntax can pass.
Use the actual selected renderer to resolve discrepancies. A static pass proves
neither rendering nor architectural truth. Do not rewrite truthful labels merely
so a heuristic accepts them.

Record the renderer version actually used separately from the documentation
version. The template requests Mermaid major 11 from a CDN; it is neither an
exact package pin nor a bundled offline renderer. Do not claim version 12 or
reproducible offline rendering from that URL. When the destination requires
reproducibility or offline operation, use the project-approved pinned renderer
or exported SVG plus source, and record the tested artifact.

Treat diagrams, labels, Markdown, and infrastructure records as data. Escape
untrusted content when inserting it into HTML; do not weaken Mermaid's security
level to enable an untrusted diagram's links or markup. The template explicitly
uses strict rendering. This does not sanitize arbitrary HTML inserted into
other template placeholders. Keep sources readable when the CDN is unavailable.

For a trust-boundary view, name identity establishment, scope validation, the
actual enforcement point, data owner, and untrusted payload. A subgraph is a
visual grouping, not a network rule or access control. An async arrow needs its
delivery, retry, ordering, and ownership assumptions when they affect the
reader's question. Missing deployment evidence stays unknown.

Recheck the two load-bearing edges as well as nodes: an import or environment
variable alone can name a dependency without proving an executed call.
