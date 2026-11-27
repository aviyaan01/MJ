# SEO checklist: verify on rendered HTML, per page type

Use HTTP requests for status, headers and initial HTML, and a browser/URL
inspection for JavaScript-rendered DOM. Curl is not a renderer. A local static
HTML fixture can validate metadata, not Google indexing or rich-result delivery.

## Per-page metadata

| Check | Good | Broken tell |
| --- | --- | --- |
| Title | unique, descriptive, and checked in target result surfaces | every page: "Home: MyApp" |
| Meta description | unique and useful to searchers | missing, or one description site-wide |
| Canonical | absolute, self-referencing, protocol+host exact | missing; canonical to homepage everywhere |
| Open Graph | og:title, og:description, og:image (1200×630), og:url | absent; image 404s; relative URL |
| Twitter card | summary_large_image + matching tags | absent |
| Robots meta | index,follow on public pages | noindex left from staging (the classic) |

## Structure

- A clear primary heading and meaningful `h2`/`h3` outline; heading count
  alone is not an indexing criterion. Respect accessibility and content scope.
- Semantic landmarks: `header/nav/main/article/footer`; lists are
  `<ul>`, not div stacks.
- Links: descriptive anchors ("read the migration guide", never
  "click here"); no orphan pages (every public page reachable from
  internal links); no broken internal links.
- Images: descriptive alt; width/height set (CLS); modern formats where
  cheap.

## Crawlability

- `robots.txt`: exists, doesn't block public paths, sitemap referenced.
- `sitemap.xml`: only canonical 200s, lastmod honest, size limits
  respected.
- Duplicate content: parameter URLs (utm, sort, page) canonicalized;
  trailing-slash/case variants resolve to one canonical when equivalent.
  Signal strength runs redirects, then rel=canonical, then sitemap (weak):
  when tag and sitemap disagree, the stronger signal wins the finding.
  Pagination pages with different items are not automatically equivalent.
  Canonical is a consolidation signal; it is not an access control or noindex.
- Avoid unnecessary redirect chains; no soft-404s (successful status with
  not-found content).
- Staging/private environments: authentication is the privacy control.
  Noindex does not restrict access. For an intentionally public noindex page,
  do not block crawling with robots.txt or the crawler cannot read the directive.

## Structured data (schema.org)

- Types that match reality: Organization, WebSite (+ SearchAction if a
  search exists), Article/BlogPosting for posts, Product with offers for
  products, BreadcrumbList for deep sites, FAQPage for actual FAQs.
- Validates (Rich Results Test / validator.schema.org); required
  properties present; **describes only content actually on the page**.
- **Anti-Hallucination Check:** Verify the JSON-LD does not contain fake 5-star `AggregateRating` reviews, hallucinated authors, or URLs that 404. Fabricating schema data is an anti-pattern.
- JSON-LD verified in initial or rendered HTML for the actual target consumer;
  validate eligibility separately from syntax and current rich-result support.

## Performance & accessibility overlap (flag, don't deep-dive)

- LCP image not lazy-loaded; hero under 2.5s budget → `hotpath`.
- Render-blocking chains and uncompressed assets → `hotpath`.
- Alt text, heading order, link purpose → `friction`; dual-value work
  gets done once, credited twice.

## GEO/AEO (answer engines): evidence-based only

What's defensible: stable URLs, semantic HTML, structured data, factual
self-contained content, clear headings that answer questions. What
isn't: "llms.txt will boost your rank", keyword-stuffed "AI summaries",
any claim of guaranteed AI citations. Present the defensible part as
standard good practice; decline the rest as unproven.
