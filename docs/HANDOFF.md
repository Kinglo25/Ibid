# Ibid engineering handoff

Last updated: 2026-08-21

## Goal

Ibid is a Word task-pane add-in for lawyers. It detects EU-law citations in Word footnotes and helps the user inspect the relevant official source. It is an inspection aid, not a legal-correctness engine.

## What is implemented

- `addin/` reads individual Word footnotes with Office.js and renders recognised citations as selectable review items. Outside Word it shows sample footnotes for browser preview.
- `shared/src/index.ts` resolves citations against the whole document, not one footnote at a time — see "Document-context citation resolution" below for the short-form, ambiguity, and gap-reporting behaviour. It detects ECLI identifiers, CJEU/General Court case numbers, directives, regulations, EU decisions, Commission `C(yyyy)` decisions, and DG Competition's own case numbers (`AT.` antitrust, `SA.` State aid, `M.`/`COMP/M.` merger). Acts are recognised in both the pre-2015 style (`Directive 2002/58/EC`; regulations as `Regulation (EC) No 1049/2001`) and the current style shared by all act types (`Regulation (EU) 2016/679`, or informally without the bracket — `Regulation 2016/679` — as long as the year is unambiguous). It derives CELEX only where the mapping is reliable, resolving each case number's two-digit year against the real clock rather than assuming the 2000s (`C-6/64` → 1964, not 2064), and flags when nearby wording ("Opinion of Advocate General…", "Order of the Court…") means a citation is not the main judgment. Article/point locators are recognised from the full words and their common abbreviations and symbols (`Art.`, `para.`, `pt.`, `§`, `¶`), not only the spelled-out form.
- `api/src/index.ts` dispatches by source family:
  - EUR-Lex/CELLAR: fetches a bounded official passage and focuses it on the cited Article or point. It asks by the derived CELEX first and, where CELLAR has never heard of that identifier, by the ECLI the footnote quoted — which is how several recent orders and judgments are held. See "The CELEX is derived; the ECLI is quoted".
  - CURIA: when the citation is confidently the main judgment, fetches the actual judgment text from EUR-Lex/CELLAR (which mirrors CJEU/General Court case law under its own CELEX) and focuses it on the cited point, the same as legislation. Falls back to a direct, official CURIA case-record link — without ever attempting a fetch — when the citation is an Advocate General opinion or an order (the derived CELEX would name the wrong document), when no CELEX could be derived, or when the fetch itself fails (older cases CELLAR does not mirror, network errors, etc).
  - European Commission: returns a direct official Competition Case Register search link.
- EUR-Lex/CELLAR retrieval (used for both legislation and case law) caches the *document* — keyed by CELEX, language and Accept header — and derives each excerpt from it locally, so one authority is retrieved once however many pinpoints cite it. That cache persists across restarts and is revalidated on every use with `If-None-Match`/`If-Modified-Since`, which CELLAR answers with `304` and no body; each preview carries the time it was last confirmed. Retrieval also has a 12-second timeout, one-second default spacing between *lookups* (not between the attempts within one), a strictly serial request queue, and exponential retry/backoff for `429` and transient `5xx` responses. Its base URL, credentials, cache location, limits, and CORS origin are server-side environment configuration. See "Retrieval latency — measured against the live service, then fixed".
- The task pane warms that cache when a document is opened: it deduplicates the document's citations to distinct authorities and retrieves them in reading order in the background, one at a time, promoting whatever the cursor lands near and cancelling when the document changes.
- `api/server.mjs` reports a clear `EADDRINUSE` error rather than an unhandled Node exception.

## Important files

| Path | Purpose |
| --- | --- |
| `addin/src/ui/App.tsx` | Word document/footnote integration and review UI |
| `addin/vite.config.ts` | HTTPS Vite server and API proxy; reads `IBID_API_PORT` |
| `shared/src/index.ts` | Citation detection and CELEX normalisation |
| `api/src/index.ts` | Source adapters, retry, throttling, revalidation, excerpt extraction |
| `api/src/document-store.ts` | The retrieved-document cache — bounded, persistent, and the only thing that writes to disk |
| `api/server.mjs` | HTTP API and environment configuration |
| `api/README.md` | Production environment variables |
| `shared/test/detect-citations.test.ts` | Detection, CELEX derivation, locators, known gaps |
| `shared/test/resolve-citations.test.ts` | Pinpoint grammar, case names, short-form resolution, ambiguity policy, and the collected-pattern acceptance set |
| `shared/test/citation-formats.test.ts` | The English/French language boundary, pre-1989 case numbers, false positives, case names next to identifiers |
| `shared/test/real-citations.test.ts` | A realistic memo built from real, live-verified citations; also the browser-preview document |
| `api/test/resolver.test.ts` | Adapters, excerpt focusing, cache, revalidation, the two CELLAR `404`s, retry, throttling |
| `api/test/document-store.test.ts` | The document cache: persistence, bounds, and degrading safely when the disk will not cooperate |
| `api/test/lookup-contract.test.ts` | Type-level guard that `api`'s `EuLookup` still accepts a shared `CitationMatch` |
| `addin/src/ui/citation-view.ts` | The pane's presentation decisions, kept JSX-free so they can be tested directly |
| `addin/src/ui/prefetch.ts` | Which authorities to warm, in what order, and when to stop — also JSX-free |
| `addin/test/prefetch.test.ts` | Deduplication, reading order, cursor promotion, cancellation, progress wording |
| `addin/test/citation-view.test.ts` | Confirmation scope, resolution and gap wording, source URLs |
| `addin/test/App.test.tsx` | The pane rendered and clicked through, against the browser-preview document |
| `addin/test/setup-dom.ts` | Registers happy-dom and a non-networked `fetch`; loaded with `--import` |
| `addin/tsconfig.test.json` | Covers `test` as well as `src`, so the JSX transform applies to tests |
| `eslint.config.base.js` | Shared lint rules; each workspace has a thin config |
| `tsconfig.test.json` | Type-checks the test files (not part of any build) |
| `samples/ibid-demo-docx/EU_Data_Retention_Memo.docx` | Manual Word test document (all full citations; exercises detection, not resolution) |
| `samples/ibid-demo-docx/eu-case-law-citation-test.docx` | The 20 collected citation patterns; the document-context test case. Its footnotes are pinned as a fixture in `resolve-citations.test.ts` |
| `samples/ibid-demo-docx/back-reference-test.docx` | Manual Word check for back-references; 22 footnotes, also pinned in `resolve-citations.test.ts`. Expected results per footnote are in that folder's README.md |
| `samples/ibid-demo-docx/build-back-reference-test.py` | Regenerates that document. Not part of any build — python-docx cannot write real footnotes, so the OOXML is assembled by hand |

## Current verification

Run everything with one command:

```bash
npm run verify   # lint → test type-check → tests → build
```

- `npm run lint` passes with no errors or warnings across all three workspaces.
- `npm run test` passes: 486 tests (273 detection and resolution, 124 resolver, document store and contract, 89 task pane). Note the pre-existing intermittent hang in `addin/test/App.test.tsx` recorded under "Known issue" below — re-run if a verify stalls.
- `npm run typecheck:test` passes (`tsconfig.test.json`, plus `addin/tsconfig.test.json`).
- `npm run build` passes (shared TypeScript, API TypeScript, and Vite production build).

Tests use the Node built-in runner (`node:test`) against the TypeScript sources
directly — Node strips the types, so there is no build step or test dependency.
They live in `shared/test/` and `api/test/`, outside each workspace's `include`,
so they never reach `dist`.

### Task-pane tests

`addin/test/` runs under the same Node test runner as everything else, with two additions
Node cannot supply itself: `tsx` (Node cannot strip JSX, only types) and `happy-dom` via
`@happy-dom/global-registrator`, registered through `--import` so the DOM exists before
React is evaluated. `@testing-library/react` and `user-event` drive the rendered component.

Two levels, deliberately:

- `citation-view.test.ts` covers `addin/src/ui/citation-view.ts`, which holds the pane's
  presentation decisions as plain functions — how far a confirmation reaches, what the
  reviewer is told about a resolution or a gap, which URL a citation links to. No DOM, no
  React, so these stay fast and are where the edge cases live.
- `App.test.tsx` renders the pane and clicks through it. Outside Word the component falls
  back to the browser-preview document, so this needs no Office.js mock — only a DOM and a
  `fetch` that does not leave the machine.

`addin/tsconfig.json` includes only `src`, which means a test file falls outside it and the
JSX transform silently reverts to the classic runtime — failing at run time with "React is
not defined". `addin/tsconfig.test.json` covers the tests too, and both the runner
(`TSX_TSCONFIG_PATH`) and the type-check are pointed at it.

What is stubbed is the source lookup, which has its own suite in `api/test`. The pane's
retrieval states are therefore only seen in their 'empty' form.

The resolver tests inject `fetcher`, `sleep`, and `now`, so retry, backoff, and
request spacing are asserted deterministically without real network or timers.
This is fast and reliable, but every EUR-Lex/CELLAR assumption in those tests
is only as good as the stub HTML matches the real service. That gap was real:
see "Verified against the live EUR-Lex/CELLAR endpoint" below for two bugs the
mocked suite could not have caught, found by actually calling the real
service. There is no live-network check in `npm run verify` (CI should not
depend on a third party being up), so re-verify by hand — with
`createEuSourceResolver()` and no `fetcher` override, so it uses the real
`fetch` — after touching `fetchEurLex`, `loadCellarDocument`, `extractLocator`,
or `extractJudgmentPoint`. Pass a `createFileDocumentStore({ directory })` over a
temporary directory when checking the revalidation paths, and resolve the same
document twice: the second lookup should be a `304` in a few hundred
milliseconds, not another download.

### Verified against the live EUR-Lex/CELLAR endpoint

Every claim in this document about EUR-Lex/CELLAR retrieval — including that
it worked at all, before this pass — had only ever been checked against a
stubbed fetcher. Calling the real `https://publications.europa.eu/resource/celex/…`
endpoint surfaced five bugs the mocks could not see, across two rounds of live
testing (the second round triggered by a real 502 a user hit reviewing an
actual document — Directive 2002/58/EC — in the running add-in):

1. **Wrong `Accept` header.** `fetchEurLex` sent `Accept: text/html`, which
   CELLAR 404s on. Only `Accept: application/xhtml+xml` is content-negotiated
   to the real document (via a `303` redirect, followed transparently by
   `fetch`). This means EUR-Lex retrieval — for legislation, not just the new
   case-law path — had never actually returned real text against the live
   service. Fixed in `fetchEurLex`.
2. **Wrong point-locator markup assumption for judgments.** CJEU/General Court
   judgments number paragraphs as a bare integer in its own element
   (`<p class="count" id="point57">57</p>`), never the parenthesised `(57)`
   form legislative recitals use — `extractLocator`'s pattern could never have
   matched a judgment. A bare number is also unsafe to search for in decoded
   running text (it collides with years, other point references, page
   numbers). Fixed with a separate `extractJudgmentPoint`, which locates the
   `id="pointN"` anchor in the *raw* HTML (before `decodeHtml` strips it) and
   slices to the next such anchor.
3. **CELLAR can answer `HTTP 200` with a bot-verification page instead of the
   document.** Observed live, not hypothetical: a real end-to-end test through
   the running add-in returned a "JavaScript is disabled… verify that you're
   not a robot" interstitial as the excerpt, for both a legislation and a
   case-law citation, decoded and shown as if it were the source text —
   `response.ok` is `true` for this response, so nothing in the original code
   caught it. This is very likely CELLAR's anonymous-access traffic
   protection reacting to the volume of automated requests this verification
   pass itself made; a fresh request minutes later succeeded normally, and
   requests made directly from this environment throughout testing mostly
   succeeded. Whether it recurs at real usage volumes is unknown — this is
   exactly the kind of thing "Obtain and configure **authorised**
   EUR-Lex/CELLAR access" under Production prerequisites is warning about;
   anonymous access appears rate/pattern-sensitive.

   Fixed defensively, not by working around the anti-bot system: every real
   CELLAR document response observed (legislation and case law, across
   converter versions and decades) carries a generator comment
   (`<!-- fmx2xhtml … -->` or `<!-- CONVEX … -->`). `looksLikeCellarDocument`
   requires it before any content is decoded or shown; a `200` response
   without it is now treated as a failure — surfaced as an error for
   legislation, falling back to the safe CURIA link for case law — rather
   than silently displayed as if it were verified source text. This is a
   detection, not a bypass: if CELLAR serves a different challenge page that
   happens to carry a real converter comment, or blocks access entirely
   rather than serving a 200, this check will not catch it. Treat "no excerpt
   shown, link still works" as the honest current ceiling for anonymous
   access, not a guarantee that every real block is caught.
4. **`application/xhtml+xml` isn't available for every document.** Fix #1
   above (switching to `application/xhtml+xml`) was necessary but incomplete:
   confirmed live, Directive 2002/58/EC (2002) has *no* `application/xhtml+xml`
   rendition at all — CELLAR 404s with "does not hold a content datastream of
   the requested type" — only classic `text/html` (plus PDF, not used). Newer
   documents are the opposite: `text/html` 404s, only `application/xhtml+xml`
   works. There is no single Accept header that covers both eras. This is
   what actually produced the reported 502: the fix for #1 traded "always
   broken" for "broken specifically on older documents."

   Fixed in `fetchCellarDocument`: try `application/xhtml+xml` first: it
   covers newer documents in one request. Only a `404` specifically — meaning
   "this representation does not exist," not a transient failure — falls
   through to `text/html`. Any other status fails immediately rather than
   doubling up against a server that's already struggling for an unrelated
   reason. The older format has no `CONVEX`/`fmx2xhtml` generator comment
   either, so `looksLikeCellarDocument` (bug #3's fix) needed a second,
   independent signal for it: `<meta name="DC.title" content="EUR-Lex - …">`,
   confirmed present in the older format and absent from the newer one, so
   there is no overlap risk between the two signals.
5. **First-match substring search finds the wrong passage, silently.** While
   fixing #4, found separately, on the same document: EU legislative
   preambles routinely reference an article or recital number in passing
   before the actual provision — Directive 2002/58/EC's recitals mention
   "Article 15(1)" four times before its real "Article 15" heading appears.
   The original `extractLocator` searched decoded, tag-stripped text for the
   *first* occurrence of "Article 15" or "(1)" as a bare substring — it had
   no way to tell a heading from a passing reference, so for this document it
   would have silently returned a recital's text instead of Article 15's, or
   a stray footnote-style marker like "...the Commission(1)," instead of
   recital 1. No error, no sign anything was wrong — exactly the failure mode
   this tool exists to prevent. (Legislation with only one incidental mention
   worked by coincidence, not because the logic was sound — GDPR Article 15
   happens to have none before its heading.)

   Fixed by replacing the substring search with `extractByHeadingAnchor`,
   which runs on the *raw* HTML and requires a heading-shaped anchor, not
   just the number appearing somewhere: an article heading is a paragraph
   containing *only* "Article N" (`<p id="..." class="oj-ti-art">Article
   15</p>` in newer documents, plain `<p>Article 15</p>` in older ones — an
   inline reference always has other text sharing its paragraph); a recital
   heading has "(N)" immediately after the paragraph opens (`<p
   class="oj-normal">(1)</p>` in newer documents with the text following in a
   separate paragraph, `<p>(1) Directive 95/46/EC ...</p>` in older ones with
   the text in the same paragraph — a footnote-style marker like
   "Commission(1)," is never immediately preceded by a `<p>` open tag). This
   is the same anchor-based approach `extractJudgmentPoint` (bug #2's fix)
   already used for judgment points; both now share `extractByHeadingAnchor`.

All five are now confirmed working against the real service, including the
two failure modes bug #5 fixes: a live fetch of Directive 2002/58/EC's
Article 15 returns the actual provision ("Application of certain provisions
of Directive 95/46/EC…"), not the recital that mentions it in passing, and
recital 1 returns the actual recital ("(1) Directive 95/46/EC…"), not the
"Having regard to the proposal from the Commission(1)," footnote marker. GDPR
Article 15 and Digital Rights Ireland point 57 still work as before — no
regression from generalising the extraction. A live fetch of Van Gend en Loos
(`61962CJ0026`, 1962) correctly falls back to the CURIA link — CELLAR does
not mirror it — with no error surfaced, which is the documented, tested
fallback behaviour, not a new gap.

One pre-existing, cosmetic issue surfaced during this check and left as-is
(out of scope for this pass): the legislation title heuristic
(`text.slice(0, 260).split('Official Journal')[0]`) picks up navigational
boilerplate for older documents (`EUR-Lex - 32002L0058 - EN Avis juridique
important | …`) and the internal filename for at least the GDPR
(`L_2016119EN.01000101.xml 4.5.2016 EN`), rather than a clean title. The
excerpt text itself — the part that matters for verification — is correct in
both cases; only the title line is ugly.

**Operational note, not a code issue:** after this fix landed, the user still
saw the old failure. The API server is a plain background process
(`node server.mjs`) that loads `dist/index.js` once at startup — it has no
file-watcher and does not restart on a rebuild. A stale instance holding port
4000 also silently blocks a fresh `npm run dev` from binding, with nothing
in the terminal output making that obvious. After any fix to `api/src/`,
confirm the *running* process is actually new (`ps -o lstart -p <pid>`
against the source's last-modified time), not just that `dist/` rebuilt.

### Validated against a real client document — six citations, six real gaps found

The "validate against representative real client documents" item under
Production prerequisites turned up a document with 6 footnotes; only 2 were
handled correctly beforehand. All 6 now work, live. Two were detection gaps
(the citation itself went unrecognised); the other four were real documents
that fetched successfully but weren't shown correctly, or at all, because
extraction and validation had only ever been checked against two document
eras. Every fix below was verified against the actual cited document, not
just plausible-looking test fixtures.

1. **Commission competition case numbers weren't recognised at all.**
   `AT.37990` (DG Competition's own case-number convention) is a completely
   different citation shape from the `C(yyyy) NNNN` decision number already
   handled, and wasn't preceded by any recognisable keyword. Added detection
   for `AT.` (antitrust), `SA.` (State aid), and `M.`/`COMP/M.` (merger) —
   the three DG Competition case-number families, all routed to the existing
   competition-case-register link. (`M.` alone is deliberately narrow — it
   only matches with a digit immediately after the dot, so it cannot collide
   with "M. Dupont"-style name abbreviations, which always have a space.)
2. **A bracket-less act citation was rejected outright.** "Implementing
   Regulation 2023/814" (no `(EU)`/`(EC)` bracket at all) failed the
   "bracket or trailing suffix required" rule designed to avoid false
   positives on arbitrary number pairs. Relaxed `parseActNumbers`: the
   keyword itself (Directive/Regulation/etc.) is what makes this safe, not
   the bracket — a bracket is now only needed to disambiguate the "No"
   (pre-2015 regulation) case, which reverses the number order. Confirmed
   against the CELEX this implies (`32023R0814`) on the live endpoint.
3. **Locator abbreviations and symbols weren't recognised.** "para. 1(c)",
   "Art. 8(5)", "§128", "¶87" all went undetected — the citation itself was
   still found in each case, only the "jump to the cited passage" part
   silently failed (falling back to the document's opening instead). Added
   `Art.`, `para.`, and the `§`/`¶` symbols to `locatorAfter`. The bare words
   "art"/"para" without a period are deliberately still not matched, to
   avoid colliding with ordinary English/French text. One real regex bug
   surfaced fixing this: `\b` (word boundary) never matches immediately
   before `§` or `¶`, since both are non-word characters — wrapping the
   whole alternation in `\b(?:...)` would have silently prevented the symbol
   forms from ever matching; `\b` now wraps only the word alternatives.
4. **Two more judgment paragraph-numbering conventions, beyond the two
   already found.** C-199/99 P (2003) and C-529/23 P (2025) both fetched
   successfully but showed the document's opening instead of the cited
   paragraph — a third and fourth real markup convention, neither matching
   the `id="pointN"` pattern extraction already handled:
   - **CURIA-native rendering** (used for at least some very recent
     judgments not yet migrated into the convention above): the number is
     an anchor name at the start of the paragraph,
     `<P class="C01PointnumeroteAltN"><A NAME="point87">87</A>text...`.
   - **Legacy ~1990s–2000s EUR-Lex rendering**: a definition-term holding
     just the number, with the text following outside it,
     `<dt>128<dd></dd></dt>text...`.

   Given four distinct real conventions turned up in two rounds of testing,
   `extractJudgmentPoint` now tries a *list* of patterns in order (the first
   one that anchors the target point number wins) rather than assuming a
   single format — treating a fifth undiscovered convention as expected, not
   exceptional. `looksLikeCellarDocument` also gained a general fallback:
   real documents run from tens of KB to hundreds of KB once actual legal
   text is included, while every bot-verification page observed or
   constructed for testing was under 1&nbsp;KB — a substantial response
   (>2,000 characters) is now accepted even without a recognised generator
   marker, rather than risk rejecting a genuine document in a convention not
   yet catalogued. (Neither of these two judgments carried the
   `CONVEX`/`fmx2xhtml`/`DC.title` markers the previous check required, so
   without this fallback both would have been wrongly rejected as
   unrecognisable and silently fallen back to the CURIA link — technically
   safe, but strictly worse than before this round, since the text was
   actually available.)

All six citations from the source document now return the correct result
live: two legislation citations (one requiring the `text/html` fallback),
two judgments (one via each of the two newly-added paragraph conventions),
and one Commission case number (link-only, as designed — DG Competition
decisions are not machine-fetchable). See `shared/test/detect-citations.test.ts`
and `api/test/resolver.test.ts` for the corresponding coverage; each new
extraction pattern has a test built from the real document's actual markup
shape, not an invented one, following the same discipline as the previous
round (a too-permissive stub can pass an assertion by accident — see the
`focuses the excerpt on the cited point` tests for the precision checks this
guards against).

### A second real client document — locator plurals and paragraph-within-article

Testing the six-citation-fix build against another real document surfaced two
more real gaps, both about locators rather than detection itself.

1. **"paras." (plural abbreviation) wasn't recognised.** `locatorAfter`
   handled `para.` (singular) and the spelled-out `paragraphs?`, but not
   `paras.` — it matches neither, since `para\.` requires the period
   immediately after "para" and `paragraphs?` requires the full word. Found
   against a real citation ("paras. 35-36"): the locator was silently lost,
   the same failure mode as the earlier missing-abbreviation round. Fixed by
   changing the alternative to `paras?\.`.
2. **"Art. 8(5)" showed the whole of Article 8, not paragraph 5.** The
   locator regex captured the article number but discarded the parenthesised
   `(5)` entirely — there was no way to represent "a paragraph within an
   article" at all, only a top-level number plus an optional dash-range.
   Added a `paragraph` field to the locator type, captured directly after the
   article number when immediately followed by `(N)`. On the extraction side,
   confirmed live that both markup eras place a paragraph's number at the
   very start of its own `<p>`, followed by a period, despite nothing else
   about their structure matching:
   - Modern OJ markup (GDPR Article 8): `<p class="oj-normal">1.   text`.
   - Legacy markup (Directive 2002/58/EC Article 15): `<p>1. text`.

   `extractLegislativeLocator` now isolates the article first (as before),
   then, when a paragraph was requested, narrows further within that slice
   using this pattern — falling back to the whole article, not an error, if
   the specific paragraph isn't found (an undiscovered fifth markup
   convention should degrade gracefully, the same posture taken for judgment
   points). Also fixed: the `AT.`/`SA.`/`M.` Commission case-number loop never
   called `locatorAfter` at all, so a locator like "para. 1(c)" attached to
   `AT.37990` was silently dropped even though the underlying regex could
   already parse it — Commission decisions aren't fetched, so this only
   surfaces in the guidance text and the `locator` field, but it was still a
   real gap in what the lawyer sees.

   Verified live against the actual GDPR and Directive 2002/58/EC documents
   (fetched directly from CELLAR) through the full resolver pipeline, then
   again through the actual running HTTP server via `/sources`:
   `GET /sources?lookup={"source":"eur-lex","celex":"32016R0679","locator":{"kind":"article","start":8,"paragraph":3}}`
   returns exactly GDPR Article 8(3)'s text, not the whole article.

### Proactive format sweep — Commission Recommendations and treaty articles

Rather than waiting for the next real document to surface a gap, tested a
batch of realistic citation formats not yet covered. Most already worked
correctly (old ECR-style citations, joined bare case numbers, the French
`affaire` prefix, General Court `T-` numbers, `Commission Implementing
Decision`, State aid/merger full forms). Two did not:

1. **`Commission Recommendation 2003/361/EC` wasn't detected.** "Recommendation"
   was simply missing from the keyword list (only Directive/Regulation/Decision
   were there). Fixed, including deriving the correct CELEX sector letter —
   confirmed live that recommendations use `H`, not `D`
   (`32003H0361` resolves against the real endpoint; `32003D0361` 404s).
   Verified end-to-end against the real document: the resolved text is
   genuinely the Commission's SME-definition recommendation.
2. **Treaty articles (`Article 101 TFEU`, `Article 6(3) TEU`, `Article 47 of
   the Charter`) — now resolved.** This is likely the single most common
   EU-law citation format of all, and the first attempt at it (fetching the
   whole-treaty CELEX and searching for the article heading inside) hit a
   dead end: CELLAR splits the whole-treaty document (`12016E` for TFEU,
   `12016M` for TEU, `12016P` for the Charter) across several `DOC_N` parts,
   and the part a plain fetch returns is only the table of contents and
   protocols — `Article 101` never appears as a heading in it at all.
   The fix: individual treaty articles turn out to carry their own dedicated
   CELEX identifier, confirmed live — `12016E101` (TFEU Art. 101),
   `12016M006` (TEU Art. 6), `12016P047` (Charter Art. 47) each resolve
   directly to a small, single-article document using the exact same
   "Article N" heading and "N.   text" paragraph markup as ordinary
   legislation. So `celexForTreatyArticle` derives that per-article CELEX
   directly (`1{2016}{E|M|P}{article, 3-digit padded}`), and the existing
   legislative extraction machinery (including the paragraph-within-article
   narrowing from the round above) applies completely unchanged — no new
   extraction code needed. Detection covers TFEU/TFUE, TEU/TUE, and the
   Charter (spelled out, "CFR"/"CDFUE", and the French "de la Charte" form),
   with or without a paragraph locator, and the `Art.` abbreviation.
   `'2016'` is the year of the current consolidated republication (OJ C 202,
   7.6.2016, post-Croatia accession) — still the version in force.

   Verified live end-to-end for all three treaty families (TFEU Art. 101 and
   102, TEU Art. 6 paragraph 3, Charter Art. 47), through the full resolver
   pipeline and again through the actual running HTTP server — including
   confirming `Article 6(3) TEU` narrows to exactly paragraph 3 (the ECHR
   general-principles clause), not paragraph 1 (the Charter clause), proving
   the paragraph-narrowing logic composes correctly with the new CELEX
   derivation rather than just accidentally returning the right document.
   Deliberately out of scope: pre-Lisbon article numbering (e.g. "Article 81
   EC", the old TFEU numbering before renumbering) and the ECHR (which is not
   an EU source at all) — neither is attempted, so the gap stays visible
   rather than silently wrong.

### Document-context citation resolution — short forms, ambiguity, and gaps

Abbreviated citations (`Akzo Nobel, para. 40`) were failing because each citation
was matched against EUR-Lex/CURIA independently. A short form carries no
information on its own; it means something only relative to a full citation
stated earlier in the same document. This is a document-context resolution
problem, not a citation-format problem, and it is now solved the way eyecite
solves the analogous problem for US citations: a syntax layer for *extraction*,
and a stateful, document-scoped algorithm for *resolution*. There is no
EU equivalent of `reporters-db` (no single abbreviation table spans all member
states), but the EU case is easier on one axis — citations anchor on ECLI and
case numbers, not free-text reporter names.

All of it lives in `shared/src/index.ts`. `detectCitations` is the extraction
layer and still works on one footnote at a time; `detectCitationsAcrossFootnotes`
is the resolution layer and needs the whole document in reading order.

**Extraction.** Additions this round, each because the previous pattern silently
lost a real citation:

- Case numbers now accept the non-breaking hyphen (U+2011) and en/em dashes, not
  just ASCII `-`. This is not hypothetical: CELLAR's own XHTML of C-131/12 writes
  `C‑131/12` with U+2011, confirmed live. The old pattern read such a footnote as
  containing no citation at all.
- Procedural suffixes are kept (`C-550/07 P`, `T-286/09 RENV`). They do not change
  the derived CELEX, but dropping them reported a different case number than the
  one the drafter wrote. `normaliseCaseNumber` folds every accepted spelling to
  one canonical identity, which is what the registry keys on.
- Pinpoints are parsed as a list, with their own small grammar: a number, an
  optional range, joined by commas and/or "and" — `paras 40–44, 46 and 48`,
  `§§ 40-44, 46`. `pinpoint.paragraphs` reports everything cited; `locator` still
  reports just the first range, because that is what the source adapters can
  narrow a fetched document to. Nothing downstream changed.
- The provision-then-act form (`Article 6(5) of Regulation (EU) 2022/1925`,
  `recital 65 of …`) is read. This is probably the most common way legislation is
  cited and it produced no locator at all before, because the scan only ever ran
  forwards. It is only accepted when the "of" runs straight into the citation, so
  a provision belonging to an earlier act in the same sentence cannot be attached
  to this one.
- Case names are read from the fragment before the identifier or after a case
  number, stepping over intervening identifiers (`… v Commission, C-550/07 P,
  ECLI:…`). A fragment is only accepted as a name when something corroborates it:
  a party separator, a case number it directly follows, or a document-type prefix
  before it. Merely being capitalised is not enough — a wrongly registered name
  would go on to generate short forms that match ordinary prose.
- Footnotes are split on `;` into independent segments, and every outward scan —
  pinpoint, case name, defined-term parenthetical — is bounded by its segment. A
  footnote citing two authorities used to let the first one's forward scan run
  past the semicolon and report the *second* authority's pinpoint as its own.

**Resolution.** Two passes over the document in reading order:

- Pass A registers every full citation under the short forms it could later be
  referred to by: any short form declared in quotes (`("Akzo Nobel")`), plus
  generated variants of its case name (`shortNameVariants`) — drop the defendant,
  drop the secondary applicant, then keep successively shorter prefixes of the
  lead party. Generic institutional defendants (`v Commission`, `v Council`) and
  bare Member State names are never emitted as variants: they identify hundreds
  of cases, so they can shorten none of them.
- Pass B resolves the remaining spans. A declared short form wins outright — it
  is the drafter stating in the document what the term means — and a later
  redefinition simply governs from that point on rather than creating an
  ambiguity. A generated variant only counts where the text is unmistakably
  citing rather than narrating, which in practice means it has to carry a
  pinpoint: "Akzo Nobel, para. 45" is a citation, "the Akzo Nobel line of cases"
  is prose.

**Two deliberate behaviour reversals.** Both were previously encoded as tests
asserting the old behaviour, and both have been rewritten with the reasoning:

1. A party name cited in full but never declared in quotes now resolves. The
   previous rule (explicit parenthetical required, no exceptions) was safe but
   missed the common case: most drafting states a case in full once and
   abbreviates from then on without ever declaring anything.
2. An unresolvable short form is now reported instead of returning nothing.
   `Intel, para. 132` used to produce an empty result — indistinguishable, to the
   reviewer, from a footnote with no citation in it.

**Ambiguity policy — the hard rule.** A short form matching more than one
authority, with nothing in the document to choose between them, is reported
`unresolved_ambiguous` with the candidates listed, and it carries *no* resolved
identifier: `celex`, `ecli`, and `caseNumber` are all left undefined so nothing
downstream can accidentally fetch a guess. The task pane marks the chip as
unconfirmed, offers the candidates as links, and does not offer an "official
source" link at all, because Ibid does not know which document that would be.
A span that reads like a citation and matches nothing is reported
`unresolved_not_found` for the same reason. Only segments containing no citation
at all are scanned for these, since inside a segment that already identifies an
authority a capitalised name is part of that citation, not a separate reference.

**Document type is never inferred from the ECLI.** The ordinal segment of an ECLI
is a per-court sequential counter and encodes nothing about document type, so it
is not used. `documentType` still defaults to `'judgment'` because that is what
retrieval needs, but `documentTypeStated` now records whether the text actually
said so ("Judgment of …", "Opinion of Advocate General …", "Order of …"). An
opinion the text never labels as one therefore comes through as an assumption
rather than a fact, and the source lookup is what confirms it.

### Advocate General opinions and orders now retrieve their own text

Previously an opinion or an order showed only "Open the official CURIA case
record and inspect point N" — a link, when the whole point of the add-in is to
put the passage in front of the lawyer. The documented reason was that the
derived CELEX always names the *judgment*, so fetching it for an opinion would
show a different document with full confidence.

That reason was real but it described a limitation of the derivation, not of what
CELLAR holds. A case number identifies the **case**; the CELEX *sector*
identifies which document within it. Confirmed live:

| Document | Sector | Example |
| --- | --- | --- |
| Court of Justice judgment | `CJ` | `62012CJ0131` |
| Advocate General opinion | `CC` | `62012CC0131` (AG Jääskinen, Google Spain) |
| Court of Justice order | `CO` | `62014CO0413` |
| General Court judgment | `TJ` | `62009TJ0286` |
| General Court order | `TO` | `62009TO0286` |

`celexForCase` now takes the document type and derives the matching sector, so
the CELEX names the document that was actually cited, and `resolveCuria` fetches
whatever CELEX it is given. General Court Advocate General opinions are
deliberately *not* derived: they barely exist and no sector for them has been
confirmed, so nothing is guessed.

**Case numbers are borrowed across documents in the same case.** "Opinion of
Advocate General Jääskinen … in Google Spain, ECLI:EU:C:2013:424" states no case
number, so there was nothing to derive a CELEX from at all. The number belongs to
the case, so it is taken from the judgment the document cites in full elsewhere —
only the number: `sameAuthority` still keeps the opinion and the judgment apart,
because their document types differ. The borrow is refused unless exactly one case
number is on offer *and* its court matches the one the citation's own ECLI states,
so an appeal's General Court twin can never supply it.

Reading the name out of "…in Google Spain" needed one more fix: the whole fragment
is a document-type preamble, which `caseNameBefore` rejects outright, so an opinion
carried no case name and therefore no route to the number.

**A fifth judgment-point markup convention.** With opinions finally fetchable, AG
Kokott's opinion in Akzo Nobel (`62007CC0550`) came back as the document's opening
rather than point 60. `JUDGMENT_POINT_HEADINGS` pinned one exact class name,
`C01PointnumeroteAltN`, taken from a judgment; opinions of the same era use the
sibling `C01PointAltN` and write the number with a trailing period
(`<A NAME="point60">60.</A>`). Generalised to any paragraph class carrying a named
point anchor — `NAME=` is what makes that safe, since a cross-reference to a point
is an `HREF="#pointN"`, never a `NAME`.

Confirmed live end to end: AG Jääskinen point 138 (his actual conclusion in Google
Spain), AG Wahl points 73–75, and AG Kokott point 60 all return the cited passage.
An order that CELLAR does not mirror (`62007CO0550` genuinely 404s) still falls
back to the CURIA link, which remains the floor for anything unretrievable.

### Codebase health check

A read-through of the whole codebase after several rounds of change, plus probes
for robustness and cost. No correctness defects; everything below is structural.

**Resolution was superlinear, and the cause was duplicate registration.** A
1,000-footnote document took 1.5 s. Every footnote citing a case in full pushed
its whole variant set again, so the registry grew with how *often* authorities
were cited rather than how *many* there were, and each later footnote scans the
text once per distinct key. Registrations for the same key and same authority are
now folded together — **1.5 s → 0.18 s**, and roughly linear.

Note the first attempt at this was wrong and the suite caught it: skipping the
duplicate instead of merging it silently discarded identifiers, because two
registrations of one authority need not hold the same ones (one footnote gives
the ECLI, another the case number). Merging keeps the pooling that makes
ECLI-only footnotes fetchable.

**One preview document, not two copies.** The browser-preview footnotes and the
`real citations` fixture were two identical literal arrays with nothing keeping
them so — the claim that they are the same document was true only by luck. The
array now lives in `shared/src` as `PREVIEW_FOOTNOTES` and both import it.

**The two workspaces' types could drift silently.** `api/src/index.ts` imports
nothing by design, so it declares its own `EuLookup` duplicating the shared
citation shape. A field added to `CitationLocator` would have been dropped on the
way to the resolver, giving an unfocused excerpt with no error anywhere.
`api/test/lookup-contract.test.ts` now fails type-checking if they diverge.

**Robustness probes all passed**: empty and whitespace-only input, empty
footnotes among real ones, a 200 KB footnote, 5,000 consecutive semicolons, a
500-item pinpoint list, 2,000 nested parentheses, and astral-plane characters —
no throws, no catastrophic backtracking, every case under 10 ms.

Smaller items fixed: a dead `locatorAfter` export (nothing referenced it since
`parsePinpoint` replaced it); the joined-cases pattern rebuilt on every call
rather than once at module scope, and the case-number pattern constructed three
times per call; duplicate `"type": "module"` keys in `shared/package.json` and
`api/package.json`; and `detectCitationsAcrossFootnotes` now accepts a
`readonly string[]`, which it never mutated.

**Left as-is, deliberately.** `shared/src/index.ts` is ~1,290 lines doing
extraction, resolution, and the frequent-case table. Splitting it is blocked by
module resolution rather than taste: the tests import source directly with
explicit `.ts` extensions so Node's type stripping can run them without a build,
and `allowImportingTsExtensions` is only set in `tsconfig.test.json` — a
cross-file `import './extract.ts'` inside `src` would break the build, while an
extensionless import would break the tests. Worth revisiting alongside the test
runner setup, not before.

**Enforcement note.** "Never fetch an unconfirmed citation" is enforced in the
React client. The shared layer makes it *enforceable* — a non-`resolved` citation
carries no identifier to fetch with — but nothing stops a future client from
sending a lookup built out of `candidates`. If a second client is ever written,
that rule needs to move into the API.

### Language scope: English and French

The scope is English. French is kept because it predates this work and real
client documents are drafted in it —
`samples/ibid-demo-docx/EU_Data_Retention_Memo.docx` is entirely French, and
all six of its footnotes resolve.

German, Spanish, Italian and Dutch were built and then removed by decision, not
by oversight: working well in English beats working less well across more
languages. Every extra keyword widens the surface on which a pinpoint can be
matched wrongly, and breadth that is not needed buys nothing while costing
precision. A German or Spanish citation still resolves through its ECLI — that is
language-independent — but its pinpoint word is not recognised, so no paragraph
is claimed rather than a wrong one. `citation-formats.test.ts` pins the boundary
in both directions so neither half drifts back by accident.

### The French-only corpus, measured

Translation is **deferred by decision**, not unbuilt: the `translate` seam exists
and is tested, no provider is wired, and a French-only document is shown in
French with a note saying so.

The size of the problem was measured live against CELLAR rather than guessed:
**207 CJEU documents** have a French text and no English one — 5,930,852
characters, roughly $163 at DeepL's per-million rate. Breakdown: 37 General
Court judgments, 18 Court of Justice judgments, 114 CJ orders, 32 GC orders, 6
AG opinions. The substantive core is 61 documents; the rest are short procedural
orders. Accrual runs ~10–18/year, but 2024 and 2025 show 49 and 57 — almost
certainly translation lag rather than permanent absence, so the stable set is the
~89 documents from 2014–2023.

**Do not re-derive this with the obvious query.** Asking SPARQL for works with a
French expression and `FILTER NOT EXISTS` an English one returns **3,427, which
is wrong**: one CELEX maps to several work URIs, and `62018CJ0389` has a
French-only work alongside a 23-language one. The correct method is a set
difference on `cdm:resource_legal_id_celex` at CELEX level, then verification
against live CELLAR — which still leaves two false-positive classes, English
simply being present, and English filed under a joined-case sibling.

**Re-derived on 2026-08-25, after a reader said 207 sounded far too low. They were right
about the corpus and the 207 is right about Ibid — the two count different things.** Three
tiers, each measured by CELEX-level set difference on the SPARQL endpoint and then verified
against live CELLAR on a spread sample, trying *both* Accept headers before believing a 404:

| Scope | Count | What it is |
| --- | --- | --- |
| Base case-law documents Ibid can derive (`6yyyy(CJ\|CC\|CO\|TJ\|TO)nnnn`) | **209**, ~201 after live check | The figure this section records. Breakdown reproduced almost exactly: CO 114, TJ 37, TO 32, CJ 18, CC 8. |
| All of sector 6 | 1,531 | Adds ~1,300 `_SUM` and `_INF` documents — the Official Journal's summary of a judgment and the notice announcing a case. |
| Legislation Ibid can derive (`3yyyy[LRDH]nnnn`) | 15,303 | Effectively all pre-1973: 32 from the 1950s, 7,354 from the 1960s, 7,916 from the 1970s, one later. Mostly short agricultural and customs regulations (13,324 are `R`). |
| Every sector, no shape filter | 65,773 | The number a reader is imagining when they say "way more". |

The 207 survives because of what Ibid actually asks for. It derives base-document CELEXes
only, so the `_SUM`/`_INF` mass is unreachable by construction and nobody pinpoint-cites a
case notice. And the pre-1973 mass is untranslated because English was not an official
language until the UK and Ireland acceded on 1 January 1973 — the instruments from that era
that are still cited got English Special Edition translations, confirmed live for Regulation
17/62, Regulation 1612/68, Regulation 1408/71, Directive 64/221 and Regulation 1251/70, all
five of which serve English.

What that leaves as a real, if narrow, gap: a practice touching 1960s–70s agricultural or
customs law would meet French-only acts that Ibid shows in French with a label. That is the
designed behaviour rather than a failure, and it is not the case-law translation question
this section is about.

The sample also re-found the joined-case false positive named above: `62013CC0613` appears
French-only in the metadata and serves English on request, because CELLAR files it under the
group's lead. One in 25 sampled, which is about the rate this section predicted.

If translation is taken up: pre-translate the stable pre-2024 set, ship it as
data, and drop the runtime dependency entirely. The refresh job must **re-check
English availability** on documents already translated, or Ibid will go on
showing a machine translation after the authentic one lands.

### Adversarial format sweep — three more defects

A deliberate sweep for *failures* rather than confirmations, across areas nothing
had touched: text shaped like a citation but not one, forward references, the
appeal-versus-first-instance guard, pinpoint oddities, line-broken footnotes, and
pre-1989 forms. Covered by `shared/test/citation-formats.test.ts`.

1. **A case name stated before its case number was lost.** `Akzo Nobel v
   Commission, Case T-125/03, para. 10` — one of the commonest citation shapes —
   yielded no case name at all, because the backward scan stops at the case number
   and the fragment left in hand is the bare word "Case".

   This one was worse than a missing name: it *silently disabled the
   appeal-versus-first-instance guard*. That guard exists because an appeal and
   the judgment under appeal share their case name exactly, and it only engages
   when both sides register a name. With one side registering nothing, the guard
   looked correct in testing while never actually running. It is now exercised:
   a document citing T-125/03 and C-550/07 P and then "Akzo Nobel, para. 41"
   reports an ambiguity rather than silently picking one.
2. **Joined cases without an ECLI produced a chip per case number.** "Joined
   Cases C-293/12 and C-594/12" is one judgment cited under two numbers. The ECLI
   scan already collapsed the group whenever an ECLI followed — which is what hid
   this — but with no ECLI, each number became its own citation and derived a
   CELEX that need not name any document.
3. **Pre-1989 case numbers were invisible.** Van Gend en Loos is cited as "Case
   26/62", Costa as "Case 6/64"; neither matched. That also left the frequent-case
   table inconsistent with detection, since it holds those cases under their
   modern `C-` form. A bare number pair is far too ambiguous to detect on its own,
   so two things are required and both are facts rather than guesses: an explicit
   "Case"/"Affaire" keyword, and a resolved year before the General Court existed
   (it was created in 1989, so a case predating it can only be a Court of Justice
   case). `Case 26/12` and "the meeting on 26/62" are both correctly ignored.

Confirmed live afterwards: `Case 26/62` and `Case 120/78` fetch their real
judgments.

**Deliberately still not matched**, each because the failure mode of matching is
worse than the failure mode of missing:

- **Bare `para 40`** (no period). A mandatory digit follows, so it looks safe —
  but it is an ordinary word and the scan reaches 160 characters past the
  citation, so prose could produce a confidently wrong paragraph.
- **`at [40]`.** Indistinguishable from a footnote marker.
- **`Regulation (EEC) No 1612/68`.** The pre-1994 two-digit-year form, already a
  documented gap: the century is not resolved and the number order is genuinely
  ambiguous in that convention.
- **`C-14/15` inside ordinary prose.** Contrived enough to leave; the `C-`/`T-`
  prefix plus `NN/NN` shape is distinctive in practice.

### Validated against a corpus of real Advocate General opinions

Twenty-six Advocate General opinions were fetched from CELLAR and their 2346 footnotes run
through resolution — the largest body of real drafting this has been tested against, and
the cheapest bug-finding available: opinions are footnote-dense, use every convention the
Court uses, and are free. 1865 citations, 96.4% resolved, in six seconds.

The corpus spans both citation eras deliberately, because they are different languages:
2012-2018 opinions cite by ECLI, pre-2012 ones by European Court Reports volume. Older
documents are served as `text/html` only — the same era split already documented for
legislation — so the harvest must fall back to that Accept header or they 404.

It found seven defects that no hand-written case had, the largest of them last:

1. **The bare ECLI was not recognised.** Since 2014 the Court and its Advocates General
   write the identifier without its prefix and in parentheses — "Judgment in Achmea
   (C-284/16, EU:C:2018:158, paragraph 35)". Requiring `ECLI:` missed the identifier in the
   dominant form of modern EU legal writing.
2. **Joined cases in that style read as two authorities.** A consequence of the first: with
   no ECLI recognised, "(C-293/12 and C-594/12, EU:C:2014:238)" had nothing tying its two
   numbers together, so one case was reported as two and every `Ibid.` after such a footnote
   was ambiguous between a case and its own sibling. The machinery for "one ECLI represents
   several case numbers" already existed; it simply never fired. Fixing the ECLI fixed this.
3. **"Above, point 19." was reported as an authority named "Above"** — four times in one
   opinion. The same family as the "See" false positive; a position word can never begin a
   case name.
4. **The European Court Reports reference was swallowed into the case name.** "Case C-558/08
   Portakabin [2010] ECR I-6963" registered the case under "Portakabin [2010] ECR I-6963", a
   key no later short form could match — so effectively every case name in a pre-2012
   document was unreachable. The single highest-value fix of the round.
5. **A joined-cases range read as two authorities.** "Joined Cases C-87/90 to C-89/90" — the
   group pattern knew list separators but not range ones, and the range form carries no
   shared ECLI to fall back on.
6. **A group named after its last number went nameless.** Once ranges collapsed correctly,
   the name had to be read past the rest of the group; "Joined Cases C-236/08 to C-238/08
   Google France and Google" otherwise lost its name entirely, which is worse than the split
   it replaced. Caught by diffing corpus output before and after, not by any test.

7. **A short form declared in single quotation marks was invisible.** The Court declares its
   own short forms as `(‘Hoffmann-La Roche’)`, and so does most EU and British drafting;
   only double quotes were recognised. Every declared short form in every Court document
   was therefore unreachable, and the drafter's own disambiguating labels — "Post Danmark
   I" against "Post Danmark II", "Michelin I" against "Michelin II" — went with them. These
   labels exist precisely because the bare name is ambiguous, so losing them cost exactly
   the citations hardest to resolve any other way. Fixing it resolved 81 further citations
   on its own and took the modern era from 93% to 98%.

Net across the corpus: 129 citations newly resolved, none newly unresolved, and resolution
runs about 40% faster because clean case names make for a smaller registry.

Of the 68 short forms still unresolved, roughly half name an authority the document never
cites in full anywhere — a reader is expected to know it — and the rest are non-EU sources
(Strasbourg judgments, Article 29 Working Party opinions, ICSID awards) that this tool does
not claim to resolve. The method for telling those apart is worth keeping: for each
unresolved short form, ask whether its name appears next to a case number or ECLI anywhere
in the same document. If it does, it is a resolution failure rather than a refusal.

Back-references in the corpus went from 4 of 14 resolving to 11 of 14, including a
three-deep `Ibid.` chain in AG Bot's opinion in Schrems. The three that still do not resolve
are correct refusals: one points at an Article 29 Working Party opinion, which is not EU
case law, and two follow bare "Paragraph 65." cross-references that establish no authority.

Known false positives left in place, both soft — they flag something for review rather than
resolving it wrongly, which is the direction to fail in: a named principle in a Council of
Europe recommendation ("Principle III"), and a fragment of an ICSID arbitral decision's
title ("Applicable Law and Liability"). Tightening the name filter enough to exclude them
would risk losing real case names.

One class that did have to go, found later against a real Commission decision: a reference
to a document in the case file. `Reply to the Preliminary Findings, paragraph 47.` is a
capitalised name in front of a pinpoint, which is the shape a short-form citation has, and
the corpus of academic opinions above contains almost none of it — a decision refers to its
own file in nearly every footnote, and on the large real decision behind this it produced 173 of
266 detections, 171 of them that one phrase. `readsAsDocumentReference` excludes them on
shape rather than by title: a definite article in front of the name, or a document noun at
the end of it. It runs only in the unresolved scan, so it cannot turn a resolved citation
into a missed one, and the argument above still holds for "Principle III" — that one has
neither signal and stays. Both directions are pinned in `regression — a case file is not a
table of authorities`.

Worth repeating with a fresh set of opinions after any change to detection. The harvest is
a loop over CELEX ids of the form `6YYYYCC0NNN` against the CELLAR REST endpoint, spaced one
per second; opinions before about 2012 were not mirrored under that pattern when tried.

### The real-citation memo, and how to verify a citation before fixturing it

`shared/test/real-citations.test.ts` holds an eighteen-footnote data-protection
and competition memo built from genuine citations, and `addin/src/ui/App.tsx`
uses the same footnotes as its browser preview — so what a reviewer can click
through at `https://localhost:3000` and what CI asserts are the same document.

**Verifying an identifier before it goes in a fixture.** A fixture asserting a
made-up ECLI is worse than no fixture: it passes while being wrong. The first
attempt at verification here checked the judgment *text* for its own ECLI and
reported all fourteen candidates as mismatched — because CELLAR's rendering of a
judgment body does not contain its ECLI at all. The check that works is the RDF
metadata:

```bash
curl -s -H 'Accept: application/rdf+xml' \
  https://publications.europa.eu/resource/celex/62012CJ0131 | grep -o 'ECLI:EU:[CT]:[0-9]*:[0-9]*'
```

Every case number and ECLI in that file was confirmed this way on 2026-08-14,
including both Advocate General opinions (which carry their own `CC` CELEX —
`62014CC0413` is AG Wahl in Intel). Do the same before adding any citation.

**A real case, cited realistically, found a real bug.** Short-name variants were
generated from the applicant side only. That is wrong for a large class of EU
case law, because a case is not always known by whoever is first on the record:
Schrems II is *Data Protection Commissioner v Facebook Ireland and Schrems* —
Schrems is the respondent. So the name every lawyer uses could never match it,
and in a memo citing **both** Schrems judgments in full, a later bare "Schrems,
para. 94" resolved silently to Schrems I. Paragraph 94 exists in both; nothing in
the document says which is meant. `shortNameVariants` now generates from every
named party on both sides — `isUsableVariant` is what still keeps "v Commission"
from becoming a short form for hundreds of cases — and that footnote is now
correctly `unresolved_ambiguous` with both candidates.

Confirmed live through the full resolver: GDPR Article 17(1) returns the
right-to-erasure text, `Google Spain, para. 97` the balancing paragraph, the two
short forms sharing footnote 8 return Digital Rights Ireland ¶62 and Tele2 ¶119
respectively (each keeping its own pinpoint across the semicolon), Schrems II
¶168 the Privacy Shield passage, `Intel, para. 133` the Article 102 passage, and
`Article 102 TFEU` the Article itself. Sixteen of eighteen footnotes resolve; the
two that do not are the ones that should not.

### Where confirmation is asked for, and why not everywhere

The obvious safest-looking design is to ask the reviewer to confirm every resolved
short form. It is rejected deliberately. A prompt that fires on every citation
becomes a reflex rather than a decision — on an eighty-footnote brief it is
clicked through unread — and at that point it is *worse* than no prompt, because
a wrong citation now carries a human approval it never really got. The scarce
resource is the reviewer's attention, not the number of prompts, so it is spent
only where Ibid genuinely does not know:

| Outcome | Confirmed? | Why |
| --- | --- | --- |
| Stated in the footnote | no | Nothing was inferred |
| `explicit_alias` | no | The drafter wrote the definition; asking is asking them to confirm their own document |
| `generated_variant`, one authority | no | Inferred, but from a name the document states in full, and shown as such |
| `generated_variant`, several | **yes** | Genuinely ambiguous |
| `preceding_citation` / `numbered_footnote`, one authority | no | Positional, not inferred — see the back-reference section |
| back-reference, several | **yes** | The text it points at cites more than one authority |
| `unresolved_not_found` | **yes** | Ibid has nothing |
| `fallback_table` | **yes** | Outside knowledge, not something the document said |

What replaces the missing prompts is transparency: `resolutionMethod` is rendered
in the pane on every resolved citation ("Resolved from the short form this
document defines for it", "Inferred from a case name this document cites in full
earlier"), so a reviewer can see which citations rest on inference and check those,
without being made to click through the ones that do not.

Two supports make the confirmations that *are* asked for actually answerable, and
both were missing in the first pass — the pane said "confirm the intended
authority" while offering no way to do it, which is worse than saying nothing:

- **Confirmation is a real action.** Picking a candidate resolves the citation,
  fetches its source immediately, and applies to that short form for the rest of
  the document, so "Intel" is answered once rather than at every footnote. It is
  layered on top of detection rather than fed back into it — refreshing re-derives
  the same citations and only explicit human choices sit over them — and it is
  deliberately not persisted between documents.
- **`citedAuthorities` turns a dead end into a pick-list.** An `unresolved_not_found`
  span has no candidates of its own, but everything the reviewer needs is already
  in their document. It returns the distinct authorities the document establishes,
  deduplicated by `sameAuthority`, so a case stated by ECLI in one footnote and by
  case number in another appears once holding both. Candidates are labelled with
  their document type, because the judgment, the AG opinion, and the order in one
  case share a name exactly and are otherwise indistinguishable at the moment of
  choosing.

### Back-references — `Ibid.`, `Id.`, `supra note 4`

Resolved by `resolveBackReferences`, running after name resolution and before the
unresolved scan, per footnote, in document order.

These are the references the product is named after, and the key point is that most
of them are **not inferences at all**. Where the text a reference points at
established exactly one authority, `Ibid.` *is* that authority by the definition of
the word — a firmer warrant than `generated_variant`, which rests on a drafter having
shortened a case name the way we guessed they would. So they resolve without a prompt,
and say so: "Read as the authority cited immediately before it, in footnote 12."

The earlier objection to building this — which authority is meant when the preceding
footnote cites two — turned out to need no new machinery. It is the ambiguity policy
that already exists. What each form does:

| Situation | Outcome |
| --- | --- |
| Text pointed at established exactly one authority | `resolved`, `preceding_citation` or `numbered_footnote` |
| It established several | `unresolved_ambiguous`, candidates ordered nearest-cited first |
| It established none, or the reference is the first footnote | `unresolved_not_found` |

Ordering the candidates nearest-first encodes the OSCOLA reading — *ibid* means the
immediately preceding *citation* — as a hint to the reviewer, never as a pick. A
convention this tool decided to trust would still be a guess.

Details that are load-bearing:

- **Only `resolved` citations holding an identifier are targets.** A back-reference
  can never point at an ambiguous span or a `fallback_table` suggestion, which would
  launder a guess one step further from the doubt that produced it.
- **`Ibid.` looks inside its own footnote first.** In `… Case C-1/10, para 5; ibid.,
  para 9`, the nearest citation is in the same footnote, not the previous one.
- **Chains resolve transitively**, because `history` is filled as each footnote is
  processed: a resolved `Ibid.` becomes an established citation like any other, so the
  next one finds it. Footnotes 19–20 of the preview memo exercise this.
- **Pinpoints inherit as a pair, or not at all.** A bare `Ibid.` repeats the authority
  *and* the locator/pinpoint; `Ibid., para. 44` keeps the authority and states a new
  one. A new locator married to a stale paragraph list would report paragraphs the
  footnote does not cite.
- **`supra note n` refuses to point forward or at itself.** *Supra* means above.
- **`Ibid.` is anchored to the start of its segment; `supra note n` is not.** The ibid
  tokens are short and common enough that scanning for them anywhere would eventually
  read prose as a citation; position is what makes them citations. `supra note n`
  carries its own structure and conventionally trails the name it repeats ("Akzo
  Nobel, supra note 4"), which the "segment already names an authority" rule keeps
  from being reported twice.
- **Confirmation is scoped per occurrence, not per text** (`confirmationKey` in the
  pane). A name means one thing throughout a document; `Ibid.` means something
  different every time it appears. This is why `backReference` is a marker on the
  match rather than something inferred from `resolutionMethod` — an unresolved
  back-reference has no resolution method, and is exactly the case that gets confirmed.

Not built: resolving a back-reference by skipping past a footnote that establishes
nothing. See the known limits.

**Frequent-case fallback table** (`FREQUENT_CASES`). Citation frequency is
heavily skewed, and landmark cases are exactly the ones named without ever being
cited in full. This table is the last resort — consulted only when a short form
has no anchor anywhere in the document — and the ambiguity policy applies to it
in full: "Schrems" and "Intel" each list two cases and resolve to neither.

A table hit is now surfaced as `unconfirmed_suggestion` rather than resolved: the
identifiers stay in `candidates` until a person picks one, so it can never be
fetched on Ibid's say-so. This closes the one real inconsistency in the first
pass, where a landmark case Ibid recognised from its own list was presented
identically to one the document had established itself.

It deliberately stores no ECLI. An ECLI cannot be derived from anything else, so
it would be hand-entered data with nothing checking it, and a wrong ECLI here
would be a wrong citation presented with full confidence — the exact failure the
rest of this design exists to prevent. The case number is enough: the CELEX
derives from it, and the source lookup confirms the document. All 20 entries were
verified against the live CELLAR record the case number derives to — every one
returns a document that names the case it claims. The four pre-1989 entries state
their number in the old form without the `C-` prefix (`IN CASE 26/62`), which is
consistent, not a mismatch.

**Open decision, flagged rather than settled:** how far to extend this table and
how it stays current as case law moves. Twenty entries is a starting point chosen
to be defensible, not a considered coverage target — extending it is a product
call about what a lawyer should expect Ibid to recognise unprompted, and it
needs deciding before the list grows ad hoc.

**Known limits, left visible rather than papered over:**

- An empty footnote is carried through resolution rather than dropped, because numbering
  is positional and dropping one shifts every footnote after it. A consequence worth
  knowing: an `Ibid.` directly after an empty footnote points at the empty one, establishes
  nothing, and is reported. That is the rule below doing its job — an empty footnote is
  usually a citation someone deleted, which is exactly when the `Ibid.` after it has gone
  stale — but it is a refusal a reviewer will meet in real documents.
- A back-reference is read only against the citation *immediately* before it. If the
  preceding footnote establishes no authority — it is pure commentary, or its own
  citation went unresolved — the reference is reported unresolved rather than
  skipping further back to the last footnote that did. Skipping would usually be
  right and occasionally, silently, wrong.
- Pre-1989 case numbers as written (`Case 26/62`, no `C-` prefix) *are* detected — the
  `Case`/`Affaire` keyword carries them — and derive the right CELEX. They are normalised to
  the modern `C-26/62` spelling, which that era never used, so the pane displays a form the
  document did not write. Cosmetic: retrieval turns on the CELEX. Left alone because the
  `C-`/`T-` prefix is what `courtOf` reads to keep an appeal and the judgment under appeal
  apart, and destabilising identity matching to fix a display string is a bad trade.
- A generated variant needs a pinpoint, so a genuine short-form reference written
  without one is missed. This is the deliberate direction to fail in.
- A short form is only available to footnotes *after* the one that declares it, so
  a footnote that both defines a term and reuses it (`… (the "DMA"); and recital 65
  of the DMA`) resolves only the first mention. Loosening this needs care: the
  guard is what stops a definition matching its own parenthetical.
- Retrieval for a very old judgment still degrades to the document's opening rather
  than the cited paragraph — confirmed live for Van Gend en Loos, whose 1962
  rendering uses none of the four known paragraph-numbering conventions. The
  citation itself resolves correctly; only the excerpt is unfocused. Pre-existing
  behaviour, not introduced here.

### Validated against the real citation-pattern document — four defects found

`samples/ibid-demo-docx/eu-case-law-citation-test.docx` holds the 20 collected
patterns as 22 footnotes. Running it found four defects that none of the
hand-written tests caught, three of them breaking the headline feature outright.
The document's footnotes are now pinned as a fixture in
`shared/test/resolve-citations.test.ts` so this cannot regress.

1. **The same case stated two ways read as two different authorities.** Footnote 1
   gives `…v Commission, ECLI:EU:C:2010:512`; footnote 3 gives `Case C-550/07 P,
   …v Commission`. Identity was "first identifier present", so those registered as
   two separate authorities, and footnotes 5–7 — `Akzo Nobel, para. 40` and its
   range variants, the plainest possible short-form drafting — were all reported
   `unresolved_ambiguous` between a case and itself. Replaced with `sameAuthority`:
   the first identifier kind *both sides have* decides, so conflicting ECLIs are
   always different documents, and only when they share no identifier at all does
   the case name decide.

   That name fallback has a trap: an appeal and the judgment under appeal share
   their case name exactly. `courtOf` closes it — both an ECLI and a case number
   carry the court letter, so `ECLI:EU:T:…` never merges with `C-550/07 P` even
   though the names match and neither shares an identifier kind with the other.

2. **`Akzo Nobel v Commission` resolved to nothing.** Applicant-side variants all
   drop the defendant, so the shortened-applicant-with-defendant form — which
   drafters use constantly — was unreachable. `shortNameVariants` now also emits
   `<applicant variant> v <defendant>`. The defendant is only ever carried along,
   never matched on alone.

3. **…and the span scan reported `Commission` as an unidentified authority.** The
   short-form span pattern had no party separator in its connector list, so it
   started at the defendant, and `looksLikeCaseName` did not reject generic
   institutional names. Both fixed — the second one matters independently, since
   it was manufacturing review items out of the most common word in EU case law.

4. **An AG opinion reverted to a judgment when cited bare.** Footnote 13 states
   `Opinion of Advocate General Kokott …, ECLI:EU:C:2010:229`; footnote 14 cites
   the same ECLI with no label, and came back `judgment`. `inheritStatedDocumentType`
   now carries a stated type forward to later citations of the same identifier.
   This is the one thing document context can settle that extraction cannot, and
   it is the only place a document type is adopted from outside the text at hand —
   still from the document's own words, never from the ECLI's shape.

The same work produced a real capability gain rather than only fixes. `enrichFromRegistry`
folds in every identifier the document has already given for the same authority, so
a footnote citing only an ECLI now carries the case number — and therefore the
CELEX — that a different footnote supplied. An ECLI derives to no CELEX on its own,
so those footnotes could previously only ever offer a search link. In this document
every citation from footnote 3 onwards now fetches the actual judgment text.

Confirmed live through the full resolver: footnotes 5 and 7 (`Akzo Nobel`, resolved
by generated variant) return the real paragraph 40 of C-550/07 P; footnote 12 returns
paragraph 45, whose text itself refers to "points 60 and 61 of her Opinion" —
independently confirming footnote 13's AG opinion is the right document; footnote 14
correctly falls back to the CURIA link rather than fetching a judgment CELEX for an
opinion; footnote 16 returns exactly Article 6(5) of the DMA and footnote 19 exactly
recital 65. Footnote 22 (`Intel, para. 132`) stays `unresolved_ambiguous` with both
candidates and no identifier, which is the pass condition for that pattern.

Footnotes 1 and 2 still carry no CELEX, correctly: at that point in reading order the
document has not yet stated a case number, and enrichment never reaches forwards.

Verified end to end against the live service on an eight-footnote document
exercising all of the above: an explicitly declared short form, a generated
variant, a fallback-table hit, an ambiguous short form, an unmatched name, and
the provision-then-act legislation form. Every resolved citation fetched its real
document and focused on the right passage — `Google Spain, paras 80–82, 88 and 97`
returns paragraph 80's actual text, `Digital Rights Ireland, para. 65` returns
paragraph 65, and `Article 6(5) of Regulation (EU) 2022/1925` returns exactly
Article 6(5). `Intel, para. 132` returned `unresolved_ambiguous` with both
candidates and no identifier, which is the pass condition for that case.

### Retrieval latency — measured against the live service, then fixed

The pane felt slow. Every number below was measured against the real CELLAR
endpoint on 2026-08-21 and re-confirmed after the change; re-verify before
relying on any of it, the same way every other live claim in this document
should be.

**What CELLAR actually does.** Documents come back with an `ETag`
(`"Con-20190721062819000"`) and a `Last-Modified`, under
`Cache-Control: no-cache` — cache this freely, confirm it before you use it.
There is no compression: `gzip` is requested and ignored, so a judgment is 149KB
on the wire every single time and the GDPR is 807KB. A conditional `GET`
carrying `If-None-Match` against the canonical CELEX URL answers `304` with zero
bytes in ~270ms, redirect included; `If-Modified-Since` does the same. Both
survive the `303`, which matters because its target is `http://` rather than
`https://` and header stripping across that hop would have quietly defeated the
whole scheme — checked through Node's own `fetch`, not only through `curl`.

Do **not** cache the redirect target. The `303` carries `Cache-Control:
no-store` and its `Location` embeds a manifestation version
(`…99d7f858….0006.01/DOC_1`); always go through the CELEX URL.

**1. The cache was keyed by pinpoint, so one authority was fetched once per
citation of it.** `resolveCellarPreview`'s key included the locator, which meant
"para. 62" and "para. 65" of one judgment were two full downloads of the same
149KB document. Now split in two: documents are keyed by CELEX + language +
Accept header (`documentKey`) and excerpts are cut out of them locally, so an
authority cited twenty times in a brief is retrieved once. The excerpt cache
remains, keyed as before — it is now a cache of work rather than of retrieval —
and is bounded, which closes point 3 of `docs/DATA-FLOW.md` against itself.

**2. That document cache is persistent, and revalidated on every use.**
`api/src/document-store.ts` holds `{html, etag, lastModified, fetchedAt}` per
document, in a directory outside the repository
(`$XDG_CACHE_HOME/ibid/documents` by default; `IBID_CACHE_DIR` to place it,
`IBID_CACHE_ENTRIES=0` to switch it off). The API server is a plain background
process with no supervisor — restarting it is how it is deployed and how it is
fixed — and before this, every restart threw away every document it held.

There is deliberately **no TTL**. A published EU legal text does not change: an
amended directive is a different instrument with its own CELEX, and a judgment is
never rewritten. Expiring an entry after an arbitrary interval would discard a
document that is still correct. Revalidation is the freshness mechanism instead,
so the cache is never older than the request that just served it.

Two things to keep hold of when touching this. A `304` has **no body**, so
`looksLikeCellarDocument` must not run on it — it would reject every revalidated
document as unrecognisable and send the reviewer to a link, having just been told
by CELLAR that the text in hand is current. And a stored entry with no validator
at all is served rather than re-downloaded, dated with the time it genuinely was
last confirmed rather than with now; every real CELLAR response carries an
`ETag`, so that path is for a store written by something else.

**3. The pane states when each passage was last confirmed.** "Verified against
EUR-Lex at 14:32", as a plain fact and not as a disclaimer — a revalidated cache
is the official text with proof, not a copy with a caveat, and it should not be
dressed as one. `verificationNote` (`addin/src/ui/citation-view.ts`) adds the
date when the confirmation was not today, which is what keeps it honest for a
passage served from a store with nothing left to revalidate against: rendered as
"at 14:32" alone, last week's confirmation reads as this afternoon's.

**4. The politeness interval is charged to lookups, not to attempts.** It was
costing ~74% of a cold lookup. A wrong-`Accept` `404` costs ~165ms live, and the
resolver was stacking a contrived 1,000ms in front of the retry that works — so
most of the wait was the resolver's own format guessing, not CELLAR. Everything
one lookup does now happens inside a single slot (`onTheWire`), and the next
lookup waits a full interval after it. The rate of traffic CELLAR sees is
unchanged; the delay is simply no longer multiplied by however many attempts one
document needed. The queue is also genuinely serial now, where before it reserved
the next slot *before* awaiting and so spaced starts while allowing two lookups
to be in flight together. Requests to CELLAR are never parallelised.

**5. The pane warms the cache at document open.** It already has every citation
before the reviewer clicks anything — detection and short-form resolution run
over the whole document locally at open — so `addin/src/ui/prefetch.ts`
deduplicates to distinct authorities (with `Ibid.`/`supra` chains already
resolved to what they point at) and retrieves them in reading order, in the
background, one at a time. When the cursor lands on a footnote, whatever it cites
goes to the front of the queue. Progress is stated plainly, including what could
not be retrieved: `Retrieved 21 of 23 sources; 2 are not held by EUR-Lex and will
open as a link.` Everything is cancelled when the document changes or the pane
closes.

The win here is starting earlier, not going faster. The request spacing is
untouched and nothing is parallelised, because a burst of concurrent fetches is
exactly the fingerprint anti-bot protection reacts to — see bug #3 under
"Verified against the live EUR-Lex/CELLAR endpoint", which was that protection
being triggered by a verification pass. The browser preview deliberately warms
nothing: its sample citations are real, and firing live retrievals at whoever
opens the demo page is not what the sample is for.

**6. CELLAR answers two different `404`s, and telling them apart is worth more
than either fallback chain.** This came out of checking the assumption that
CELLAR `404`s for a language a document was not published in. Both messages
arrive with an ordinary `404` status and only the body distinguishes them:

```
Resource [system 'celex' - id '62023CJ0639'] not found.
None of the requests returned successfully a redirection. … [cellar identifier
cellar:99d7f858-… does not hold a content datastream of the requested type]
```

The first means CELLAR has never heard of the identifier — no Accept header and
no language will ever produce it. The second means the document exists and this
rendition of it does not, which is exactly what the format and language chains
are for. A citation CELLAR does not mirror used to cost four requests and three
full seconds of interval on the way to the CURIA link; it now costs one request.
Measured live end to end: **59ms**, against roughly four seconds before.

Matched loosely, and an unrecognised `404` body keeps the old
try-every-rendition behaviour — if the Publications Office rewords this, the cost
is the four requests that were being paid anyway, never a document wrongly
declared missing.

**On the language loop, which prompted the check.** The assumption is correct and
stays: `Accept-Language: gle` returns `404` for both a directive (32002L0058) and
a judgment (62012CJ0293), because neither was published in Irish. The
contradicting observation — `Accept-Language: mlt` returning a Maltese judgment
with `200` — is CELLAR answering correctly rather than ignoring the header: CJEU
judgments are translated into every official language *except* Irish, so Maltese
genuinely exists for that document.

What the check did establish is that for **case law** the `en`→`fr` fallback has
never been observed to fire usefully. English exists for every judgment CELLAR
mirrors — confirmed across 1962 (Van Gend en Loos), 1964 (Costa v ENEL) and 2014
(Digital Rights Ireland) — so French was only ever reached for a document CELLAR
does not hold at all, where it `404`s too and merely doubled the requests before
the fallback link. Those are precisely the lookups the `NO_SUCH_DOCUMENT` check
above now ends after one request, so the chain no longer has a case in which it
costs anything, and it stays for legislation, where a French-only document is
real. Removing it outright would have traded a real capability for a saving that
fix 6 already delivers.

Two side findings from the same sweep, neither acted on here. Format availability
is a property of the document rather than of the language (`32002L0058` `404`s for
`application/xhtml+xml` in both `eng` and `fra`), so the two dimensions are not
independent — but the "no datastream" message is identical for a missing format
and a missing language, so nothing can act on that without guessing. And a
quality-ranked `Accept-Language: eng, fra;q=0.8` does work in a single request —
but the response does not say which language it served (`Content-Language` comes
back empty, and only the older `text/html` rendition names it, in
`<meta name="DC.title" content="EUR-Lex - 32002L0058 - FR">`). Collapsing the
chain that way would mean showing a French passage without being able to label it
as French, which is the one thing the language handling exists to prevent. Item 7
under "Recommended next implementation work" is the other half of this.

**Also worth knowing:** Van Gend en Loos (`61962CJ0026`) *is* retrievable, as
`text/html` in English, 21KB. This document previously recorded it as one CELLAR
does not mirror. That was true when it was written — before the `text/html`
fallback and the length-based arm of `looksLikeCellarDocument` existed — and is
no longer.

**Measured end to end after the change**, one judgment, real service:

| | before | after |
| --- | --- | --- |
| First pinpoint of a judgment | ~1.5s + interval | 547ms |
| Another pinpoint of the same judgment | another full fetch | 1,179ms (1,000ms of it the interval between lookups) |
| The same pinpoint again | full fetch | 0ms |
| First pinpoint after a restart | full fetch | 211ms |
| A citation CELLAR does not hold | ~4s to the CURIA link | 59ms |

`api/test/document-store.test.ts` covers the store; the revalidation, the two
`404`s and the request spacing are in `api/test/resolver.test.ts`; the queue's
ordering, promotion and cancellation are in `addin/test/prefetch.test.ts`, with
the component wiring in `addin/test/App.test.tsx` — including an assertion on the
exact key set a warming request puts on the wire, because warming happens without
the reviewer asking and is therefore the path most worth pinning against a stray
field.

### The CELEX is derived; the ECLI is quoted — so ask CELLAR by both

Reported from a real document, whose footnote 265 cites *Order of the
President of the General Court of 2 July 2024, Aylo Freesites LTD v Commission,
ECLI:EU:T:2024:431, paragraph 112*, and the pane showed the CURIA fallback — "Open the
official CURIA case record and inspect point 112" — instead of the paragraph. Telling a
lawyer to go and look it up themselves is the work this tool exists to save them, so it is
worth being exact about why it happened.

Detection was entirely correct: `62024TO0511`, `documentType: 'order'`, the court taken
from the ECLI rather than from the document's own `C‑511/24` (which is a slip in the
source — an order of the *General* Court cannot be a `C‑` case), point 112 parsed. The
fallback was correct too, given what it knew. What was wrong was the assumption underneath
both: that a document CELLAR holds can be reached by the CELEX Ibid derives for it.

`https://publications.europa.eu/resource/celex/62024TO0511` answers
`Resource [system 'celex' - id '62024TO0511'] not found` — the identifier-unknown `404`, in
every format and language. But
`https://publications.europa.eu/resource/ecli/ECLI%3AEU%3AT%3A2024%3A431` answers `200`
with 70KB of the actual order, whose paragraph 112 is anchored in the CURIA-native
`NAME="point112"` convention `extractJudgmentPoint` already handles. CELLAR holds the
document. It simply does not mint a CELEX for it.

**The asymmetry is the point.** The CELEX is *derived* — sector letter from the document
type, year from the case number, number from the case number — so it is Ibid's best guess
at what CELLAR calls the document. The ECLI is quoted verbatim from the footnote and is the
name the issuing court gave it. Where CELLAR says it has never heard of the derived CELEX,
asking by the ECLI is not a guess at some other document; it is the same document under its
own name.

This is not one awkward citation. **Every** identifier the corpus run recorded as
`unavailable` — all six, being recent orders of the President of the General Court and of
the Vice-President of the Court, and a 2005 judgment — resolves through the ECLI path,
confirmed live on 2026-08-21 end to end through the resolver. The `unavailable` column of
`corpus-report.json` was measuring a gap in how Ibid asked, not a gap in what CELLAR holds.

How it works (`loadCellarDocument`, `cellarTargets`, `probeEveryTarget`):

- The CELEX is tried first and unchanged, so nothing that works today changes.
- Only a `404` moves on to the ECLI. Any other status still fails immediately — a second
  identifier does not fix a server failing for an unrelated reason, which is the rule the
  rendition chain already follows, applied one level up.
- The `NO_SUCH_DOCUMENT` check added in the pass above is what makes this cheap: an unknown
  CELEX costs one request, not four, before the ECLI is tried.
- Each identifier gets its own cache key (`celex:…` / `ecli:…`), so a document that resolved
  by ECLI is revalidated by ECLI next time and never re-probes the CELEX that does not
  exist.
- `ecliUrl` builds the URL the same way `cellarUrl` does — fixed configured base plus
  `encodeURIComponent` — and returns nothing, attempting no request, if the configured base
  has no `/celex` segment to swap for `/ecli`. See the SSRF note in `docs/DATA-FLOW.md`.

One thing this also fixed, which was a live bug in its own right: the preview's `url` was
always built from the CELEX, so an ECLI-resolved document would have linked the reader to a
URL that `404`s. `LoadedDocument` now carries the address that actually answered, and the
preview links that.

Live, through the full pipeline, on the reported footnote: point 112 in **824ms**, reading
"Furthermore, the mere fact of being listed in the advertisement repository as a natural
person does not necessarily make it possible to identify the nature of the activities…" —
where it previously showed a link and no text at all.

**Worth knowing for whatever comes next:** CURIA's own `liste.jsf` case-record page, which
is what the fallback link points at, is now an Angular single-page application. Fetching it
returns 130KB of shell with two `<noscript>` tags and no case data whatsoever — no case
name, no case number, nothing. The link still works for a person in a browser, but the
long-standing decision not to fetch from CURIA (see the Commission adapter's reasoning) has
gone from "scraping search pages is unreliable" to "there is nothing there to scrape
without running JavaScript". Anything that tries to widen retrieval should go through
CELLAR, by whichever identifier, rather than at CURIA.

### The joined-case gap is not a language gap

This document used to say that CELLAR files the English of a joined case under the lead
case number only, citing `62013CC0613` as 404ing for English while `62013CC0609` served it.
**That is not what happens, and the real fault is larger.** Re-measured live on 2026-08-25:

    62013CC0613  eng  application/xhtml+xml   200, 438,018 bytes
    62013CC0613  eng  text/html               404  "does not hold a content datastream"

Both are the same document. The earlier finding was one Accept header mistaken for the
whole answer — and the resolver tries both formats within a language, so it was never
affected. Asked for English, CELLAR serves the non-lead CELEX the *lead's* English file
(the returned document's own internal name is `62013CC0609`).

What is actually wrong is that for most joined groups CELLAR mints **no CELEX at all** for
the members after the lead — not a missing language, a missing document, in every language
and both formats:

| Group | Lead | The rest |
| --- | --- | --- |
| Digital Rights Ireland, C-293/12 + C-594/12 | `62012CJ0293` serves | `62012CJ0594` — *Resource not found* |
| Google France, C-236/08 to C-238/08 | `62008CJ0236` serves | `62008CJ0237`, `62008CJ0238` — *not found* |
| Verholen, C-87/90 to C-89/90 | `61990CJ0087` serves | `61990CJ0088`, `61990CJ0089` — *not found* |
| AG Keramag, C-609/13 P + C-613/13 P | `62013CC0609` serves | `62013CC0613` also serves — the exception |

So the citation that reaches a dead identifier is one naming a non-lead member, and
detection was generating those itself. `JOINED_GROUP` accepted only members separated by a
bare connector, so the moment a group gave each member its own parties — an entirely
ordinary shape —

    Joined Cases C-293/12 Digital Rights Ireland and C-594/12 Seitlinger and Others

the group ended at its first number and the rest became citations of their own. One judgment
was reported as two authorities, the second deriving `62012CJ0594`, and both were named
"Digital Rights Ireland and C-594/12 Seitlinger and Others" — a case name with an identifier
inside it, which no short form later in the document can ever match.

Three changes, in `shared/src/index.ts` and `api/src/index.ts`:

- **A group member may carry its own party name.** The run between two numbers is now a
  connector optionally preceded by a name, bounded to letters (so it can never contain
  another case number or a pinpoint), at most six words, and excluding any word that starts
  a citation of its own — so a group still ends where it really ends, and
  `…, para. 65; Case C-362/14 Schrems` is untouched.
- **The word connectors and the range dash are kept apart.** Allowed together, a name could
  run on into the hyphen of the number after it: `C-293/12 and C-594/12` then read its second
  member as the name "C" plus the connector "-", and the group ended mid-identifier. A dash
  joins two numbers directly and never follows a name.
- **Every member is carried as an alternative identifier.** A citation now reports
  `alternativeCelexes`, and the resolver tries them as CELLAR targets *after* the CELEX and
  the ECLI — so a footnote stating the group's numbers in the other order still reaches the
  document. They are derived from the same document type as the citation itself, so an
  opinion's alternatives are opinions; the resolver checks each against the CELEX shape
  before spending a request on it.

Live, through the full pipeline, on a group written in the order CELLAR does not file under:

    Joined Cases C-594/12 Seitlinger and Others and C-293/12 Digital Rights Ireland, para. 65.
      -> 909ms, paragraph 65 of the judgment, linked to 62012CJ0293

Before this it derived `62012CJ0594`, was told no such resource exists, and showed a CURIA
link with no text.

**Found by asking what the corpus actually contains**, after the above was already written.
The corpus holds 22 joined-group mentions across its 1,502 notes, and the shape the fix was
built for — each member carrying its own parties — occurs in **none** of them. What it does
contain is a group that restates the keyword: AG Poiares Maduro's "Joined Cases C‑120/06 P
and Case C-121/06 P FIAMM and Others v Council and Commission". That split into two
citations, and the second derived `62006CJ0121` — live, an identifier CELLAR has never heard
of, while the lead `62006CJ0120` serves the judgment. A restated `Case` is now read as part
of the group, but only where a connector has just been crossed, so it cannot reach past a
pinpoint and a semicolon into the citation after it.

Three more groups in the corpus turn out to sit on the same CELLAR behaviour, all confirmed
live: `62011CJ0014`, `62001CJ0138` and `62001CJ0139` do not exist, while their leads
`62010CJ0628` and `62000CJ0465` serve. Those groups already collapsed correctly, so nothing
was broken for them — they now carry the alternatives as insurance rather than as a fix.

**The corpus did not find any of this, and could not have.** Its three outcomes are `missed`
(a citation in the text that detection did not report), `wrong-source` (an identifier
belonging to a different document) and `unavailable`. A split group produces an *extra*
citation, not a missing one; its dead identifier names no document rather than the wrong one.
The defect fell between all three categories. Worth remembering before treating a clean
corpus run as coverage: it is a strong check on the things it measures and silent on the
rest.

Fixing it did surface one harness bug, now fixed. `missedIn` in `scripts/corpus.mjs` read
`citation.caseNumbers` to account for the members of a collapsed group — a field that has
never existed on `CitationMatch`, so it silently did nothing. It went unnoticed because the
loose net only sees a number the word "Case" precedes, which no ordinary group continuation
has. The moment a group with a restated keyword collapsed correctly, the harness called it a
missed citation. Citations now carry `joinedCaseNumbers` — the numbers read from the text, as
against the identifiers derived from them — and the harness reads that.

**What is still not reachable**, deliberately: a non-lead number cited entirely alone, with
no group anywhere in the footnote and no ECLI — `Case C-594/12 Seitlinger and Others, para.
65`. Nothing in that text says it is one of a group, and inventing a sibling would be
inventing a document. It falls to the CURIA link, which is the honest floor. Resolving it
would mean asking CELLAR which CELEX carries that case number, which is a SPARQL query and a
different piece of work.

### Reading the language off the document

`loadCellarDocument` used to report the language it *asked* for. CELLAR has honoured
`Accept-Language` in every document tested, so nothing was mislabelled — but that is
CELLAR's behaviour, not a property of this service, and the label under an excerpt is a
statement to a lawyer about which text they are reading. It is also what decides whether a
passage is offered to the translator at all: a French passage recorded as English is shown
unlabelled, untranslated, and as though the Court had written it that way.

`languageOf` in `api/src/index.ts` now reads it off the document, and every path that
produces a retrieved document goes through it — including the two that serve a stored copy,
since the store is keyed by the language *requested* and would otherwise label a cache hit
differently from the identical fresh bytes.

What the two CELLAR eras give you, all confirmed live on 2026-08-25:

- **Classic `text/html`** declares it outright: `<meta name="DC.language" content="FR">` and
  `<html lang="FR">`. Definitive, and checked first.
- **Modern `application/xhtml+xml`** declares nothing whatsoever. No language attribute
  anywhere in the markup, and a `Content-Language` response header that is *present and
  empty*. Its language comes from the heading every such document opens with — `JUDGMENT OF
  THE COURT` against `ARRÊT DE LA COUR`, `OPINION OF ADVOCATE GENERAL` against `CONCLUSIONS
  DE L'AVOCAT GÉNÉRAL`, the order forms of both — and for legislation from the Official
  Journal line plus the language code in the internal filename (`L_2016119EN.01000101.xml`).

Accented characters are matched as the character or either entity spelling; only the opening
20,000 characters are read, so a heading quoted inside a judgment cannot outvote the one at
its head; and nothing recognised — *or both recognised* — returns `undefined`, leaving the
requested language standing. This can correct a label; it cannot invent one.

Validated live across both eras, both languages and every document type Ibid retrieves —
judgment (2014 and 2002), AG opinion, regulation, directive. **Ten of ten agreed with what
was requested**, which is the result that matters: the guard is silent on real traffic, so a
correction is evidence of something genuinely wrong rather than noise.

### The title line, and the letters underneath it

Both found by asking a plain question — *is this fit to put in front of a client?* — and
looking at what the pane would actually display, rather than at whether the tests pass.

**The title was the document's internal filename.** This list called it cosmetic. It is the
first line a lawyer reads, and on the most cited instrument in EU law it read:

    L_2016119EN.01000101.xml 4.5.2016 EN

The old rule took the opening 260 characters and cut at "Official Journal". That assumed the
title precedes the Journal reference — true of the classic rendition, and exactly backwards
for the modern one, where the act's title *follows* it. The ePrivacy directive fared no
better, running 200 characters of `EUR-Lex - 32002L0058 - EN Avis juridique important |
32002L0058 Directive 2002/58/EC of…` into one line.

`actTitle` now anchors on the title itself — the act word and its number, which is where
every such title begins — and cuts at whatever ends it: the Journal reference, the EEA
relevance note, or the enacting formula. Two things had to be got right and neither was
guessable:

- **The enacting formula must be matched in full.** An act's own title reads "OF THE EUROPEAN
  PARLIAMENT AND OF THE COUNCIL"; the recitals begin with the same institutions in the other
  order. Cutting at a bare "THE EUROPEAN PARLIAMENT" truncated every co-decided act to
  `REGULATION (EU) 2016/679 OF`.
- **The year is matched at two digits or four.** An act from before 2000 states it short —
  `Directive 95/46/EC` against CELEX `31995L0046` — and comparing against the four-digit
  CELEX year silently rejected every one of them.

The number it finds is then checked against the CELEX actually fetched, in both conventions
(a directive is year/number, a pre-2015 regulation number/year). A title is a claim about
which act is on screen; one lifted from a *reference* to another act would be that claim made
wrongly. Failing the check falls back to the name derived from the citation, which is what
the reader wrote and always names the right act.

**The excerpt started in the same place.** Confirmed in the pane, on a real decision: a
regulation cited without a pinpoint showed `L_2004364EN.01000101.xml 9.12.2004 EN Official
Journal of the European Union L 364/1 REGULATION (EC) No 2006/2004 …`, and a judgment showed
its bare CELEX before its heading. `documentOpening` now starts at the document's own content
— the heading of a judgment, opinion or order, or an act's designation and number — anchored
on what the content begins with rather than on a list of preambles to strip, because the
preambles differ by era and language and the content does not. Bounded to the first 1,200
characters: failing to recognise an opening costs nothing, and must never skip past a passage.

**And the title had to be capped.** The pane renders it as the card's link, unwrapped, and an
act's real title names every act it amends — Directive 2005/29/EC states its own in 400
characters. Cut at 200 on a word boundary with an ellipsis; the whole of it is one click away
in the source.

**And the accented letters were not being decoded.** `NAMED_ENTITIES` held six entries —
`nbsp`, `amp`, `quot`, `apos`, `lt`, `gt` — so the classic rendition's accents reached the
pane as source text: `du Parlement europ&eacute;en et du Conseil`. French is precisely the
case where the reader has no English to fall back on, and a French client memo is already in
`samples/`. The table now carries the Latin-1 letters and the common marks.

Matched **case-sensitively**, which was a live bug in the old lookup rather than a
precaution: it folded the entity name to lower case first, and the cached corpus contains
`&Ouml;`/`&ouml;`, `&Uuml;`/`&uuml;` and `&Oacute;`/`&oacute;`. Had the accented letters been
in the table under the old lookup, `ARR&Ecirc;T DE LA COUR` would have rendered as
`ARRêT DE LA COUR` — and that heading is also what `languageOf` reads a document's language
from. An unrecognised name is still left exactly as written, for the reason already recorded:
a visible `&sect;` is a blemish, a silently dropped character in a passage a lawyer is about
to rely on is not.

### Why a competition decision is a link and not a passage

Asked of a real footnote citing five Commission cases by number and paragraph:

    See e.g., Case AT.40178 – CAR EMISSIONS, paragraph 223; Case M.8181 MERCK / SIGMA-ALDRICH,
    paragraph 473; Case M.7993 - ALTICE / PT PORTUGAL, paragraph 573; Case M.8228 -
    FACEBOOK / WHATSAPP, paragraph 97…

Every one of them resolves to a case-register link and no text. The resolver's comment said
there is "no equivalent machine-fetchable mirror". Measured on 2026-08-25, that is right, and
the detail matters more than the conclusion.

**They do have CELEX identifiers.** Found through CELLAR's public SPARQL endpoint
(`https://publications.europa.eu/webapi/rdf/sparql`, no registration), which is worth knowing
about on its own:

| Cited | CELEX | What CELLAR actually serves |
| --- | --- | --- |
| AT.40178 | `52021AT40178` | Opinion of the Advisory Committee on a *draft* decision, 6.3KB |
| M.8181 | `52022M8181` | Opinion of the Advisory Committee on mergers, 5.9KB |
| M.8228 | `52017M8228` | Opinion of the Advisory Committee, 4.8KB |
| M.4994 | `32008M4994` | An OJ non-opposition notice, 2.8KB — **for a different case** |

None is the decision. They are the procedural documents the Official Journal prints *about*
the decision, and their highest numbered marker is 2, against footnote 529's paragraphs 223,
473, 573 and 97. The Journal notice says so itself: "The full text of the decision … will be
available from the Europa competition website."

**And the last row is the reason not to reach for these.** The document CELLAR serves under
`32008M4994` never mentions M.4994. It is a 980-character notice about Case COMP/M.5050 —
Eaton/Moeller, and it states its own document number as `32008M5050`. A resolver that derived
a CELEX from a merger number and fetched it would have put an unrelated merger on screen under
the citation the reviewer wrote — a wrong source, presented with every appearance of being
right, which is the one outcome this project holds must stay at zero.

**The full text is not addressable.** The decision PDF's filename carries an internal document
id (`m8181_2986_3.pdf`) that no rule derives from the case number, and
`competition-cases.ec.europa.eu` serves the same 57KB Angular shell for every path — case
pages, invented paths and API-shaped paths alike — so there is nothing to read the id from
without running JavaScript. This is the same wall CURIA's `liste.jsf` turned into.

So the link is the floor here in a stronger sense than for case law: for CJEU citations the
link was a convenience being replaced, and for Commission decisions it is the only honest
answer available. What could still be worth doing is making the link land on the case rather
than on a search for it — but the register's URL shape cannot be confirmed from outside a
browser, and a link that 404s is worse than one that searches.

### A paragraph that was never published is not a retrieval failure

A footnote of a real decision cites two judgments, and neither produced a passage. Both
turned out to be right, and the pane was blaming itself for both.

    See judgements of 18 May 2022, Canon v. Commission, T-609/19, EU:T:2022:299, paragraph 435
    and the case-law cited; and of 17 December 2014, Pilkington Group and Others v Commission
    (T-72/09, not published, EU:T:2014:1094, paragraphs 247 and 248 and the case-law cited).

**Canon.** The document retrieves, and paragraph 435 is not in it. The General Court
publishes many judgments in *extract*: 62019TJ0609 carries 175 paragraphs numbered up to 339,
and closes by saying so — "Only the paragraphs of the present judgment which the Court
considers it appropriate to publish are reproduced here." The Commission is citing a
paragraph of the full judgment that EUR-Lex has never held. Intel is the same shape at
another scale: 62009TJ0286 holds 619 paragraphs numbered up to 1,647.

The pane said "could not be located in the retrieved text", which invites the reader to
suspect the tool and look again when there is nothing to find. It now distinguishes the case
— `passage: 'unpublished'` — and says the Court published only part of this judgment. The
document in hand is complete, correct and official; it is simply not all of the judgment, and
only the Court decides that.

Detected two ways, either sufficient: the closing note, in English or French; and the
numbering, where the highest paragraph number exceeding the count of paragraphs present means
paragraphs are missing between them. The second is language-independent and catches Intel,
which carries the note but not the `_EXT_` marker some extracts put in their anchor ids.
This only ever chooses the wording of an explanation for a passage already not found, so a
wrong answer costs a sentence and never a wrong passage.

**Pilkington.** The footnote says "not published" itself, and CELLAR agrees: `62009TJ0072`
and `ECLI:EU:T:2014:1094` both answer `404` with "does not hold a content datastream" rather
than "Resource not found" — the record exists, no text rendition does, in either format. The
CURIA link is the floor and is the correct answer.

Worth keeping in mind when a citation shows no passage: three distinct causes now, and they
are told apart. The identifier names nothing CELLAR holds (`NO_SUCH_DOCUMENT`, one request);
the document exists but no text rendition does, as here; or the text exists and the cited
paragraph was never published in it.

### Known issue: `addin/test/App.test.tsx` intermittently hangs

Found while running `npm run verify` for the retrieval work above, and **not caused by
it** — reproduced on an unmodified checkout of `080791e` in a separate worktree, failing
1 run in 6 with the identical signature. Recorded here because it makes `npm run verify`
unreliable and the next person to hit it should not have to re-establish that it is old.

What it looks like: the file stops after `following the cursor` completes and before
`finding the footnote the cursor is actually in` starts, then sits there until the runner
gives up, reporting `✖ test/App.test.tsx … 'test failed'` with no individual test having
failed and no assertion error. Roughly one run in three on this machine at the time of
writing, in that region of the file every time.

What has been ruled out:

- **Not caused by the cache warming or anything else in this pass** — it reproduces at
  `080791e`, before any of it existed.
- **Not parallel test files.** It happens with the two original test files, with three, and
  when `App.test.tsx` is run entirely on its own.
- **Not fixed by `--test-concurrency=1`.** That was tried and reverted rather than left in,
  because a run still hung with it set and shipping it would have claimed a fix that is not
  one.
- **Not a `findBy*` timeout.** Those reject after a second with a readable error; this
  produces neither.
- **Not the main thread spinning, in either process.** Diagnostic reports were taken from
  both (`--report-on-signal`, then SIGUSR2). The parent runner shows an empty JavaScript
  stack and an active child `process` handle — it is idle, waiting on the worker. The
  worker (`--test-isolation=process` gives each file its own) shows an empty JavaScript
  stack too, with two live `timer` handles and libuv's `idle`/`prepare`/`check` set
  active. Nothing is executing; the loop is alive and nothing is progressing.

So: the worker is awaiting something that never settles, while timers keep its loop from
exiting. The teardown between those two suites is where to look — `cleanup` unmounting the
pane, against the Word stub's `remove()` deleting the `Office`/`Word` globals and handlers
registered through `queueMicrotask`. Note that node:test runs the innermost `afterEach`
first, so the stub's globals are removed *before* React unmounts the component that is
still using them.

One detail worth knowing before starting: the runner is invoked with `--test-timeout=0`,
so a stuck `await` hangs indefinitely instead of failing.

**`--test-timeout` does not help, and this was worth finding out.** Run with
`--test-timeout=5000`, the file still fails as a whole at 35s with no individual test or
hook named. Whatever is stuck is therefore *between* tests, in the runner's own
progression, not inside a test body or a hook where the timeout applies. That is a
sharper statement of the fault than "something hangs", and it removes the step this
document used to recommend taking first.

**Four more hypotheses, all falsified** (2026-08-24), measured rather than reasoned about
— the rate is ~40%, so nothing below was called on a single run:

- **Not teardown ordering.** The obvious reading of the note above — `cleanup` unmounting
  after the Word stub has already deleted the globals — is wrong. Unmounting *first*
  (`afterEach(() => { cleanup(); word?.remove(); })`) made it **worse**: 3 of 6 runs hung
  before, 7 of 10 after. Reverted rather than kept. Whatever this is, unmounting while the
  stub is still installed provokes it more often, which is a clue pointing the opposite way.
- **Not the worker or the IPC channel.** With `--test-isolation=none`, which runs the file
  in the runner's own process instead of a child, the rate is unchanged: 3 of 8. So it is
  in-process, and the parent's "idle, waiting on the worker" report is a symptom rather
  than the site.
- **Not `cleanup()` returning a thenable** that `node:test` would await. It returns
  `undefined` in `@testing-library/react` 16 — checked directly, not assumed.
- **Not confined to one place in the file.** This document recorded it as always stalling
  between `following the cursor` and the suite after it. It has also been seen stalling
  immediately after `a footnote carrying Word's reference mark…`, in a different suite.
  The region is not the signal it was taken for.

What is left, then: something in-process that blocks the runner between one test and the
next while the event loop stays alive — happy-dom's own task manager and React 19's `act`
environment are the two candidates neither ruled in nor out. The cheapest next move is a
bisect of the file by suite, remembering that a single green run proves nothing at a 40%
rate and each measurement needs eight or so.

Capture the report from the **child**, not the parent. Working that out took the longest:

```bash
cd addin
NODE_OPTIONS="--report-on-signal --report-directory=/tmp/ibid-reports" \
  TSX_TSCONFIG_PATH=./tsconfig.test.json \
  node --import tsx --import ./test/setup-dom.ts --test test/App.test.tsx &
# once it stalls, signal the worker rather than the runner:
pkill -USR2 -P $!
```

Until it is fixed: re-run `npm run verify`. A run that completes is a real pass — the
failure mode is a hang, never a wrong assertion, so it cannot turn a broken change into a
green one.

### Previously blocked tooling — now fixed

`npm run lint` used to fail before linting because every shim in
`node_modules/.bin` had been flattened to a zero-byte file (a Windows-to-WSL copy
artifact; the stray `:Zone.Identifier` files throughout `node_modules` are from
the same copy). The package contents were intact, so the 13 damaged shims were
restored as symlinks to their packages' real bin entries. ESLint 9 then needed a
flat config, which had never been written — see `eslint.config.base.js`.

If the shims break again after another Windows-side copy, `npm ci` restores them.

## Start locally

```bash
npm run dev
```

The Vite add-in runs at `https://localhost:3000` and the API defaults to `127.0.0.1:4000`. If 4000 is already occupied, either stop its existing listener or use one shared alternate port so the Vite proxy remains aligned:

```bash
IBID_API_PORT=4001 npm run dev
```

Then sideload `addin/manifest.xml` in Word and open the sample document. Select each citation in the task pane and verify its official link and, for EUR-Lex, passage retrieval.

## Production prerequisites

1. Set `IBID_USER_AGENT` and the other server-only variables listed in `api/README.md`; never expose configuration through `VITE_*` variables or browser code. Note that there is no authorised CELLAR tier to obtain — see "Access to CELLAR" in `api/README.md` for what was checked and what the registrable EUR-Lex service actually is.
2. Deploy the API over HTTPS and set `IBID_ALLOWED_ORIGIN` to the deployed add-in origin.
3. Validate CURIA, EUR-Lex, and Commission links with representative real client documents and record any unrecognised citation patterns.

## Recommended next implementation work

1. Run the Word end-to-end validation above and fix Office.js compatibility/UI issues that appear.
2. Add explicit Commission-family classification (competition, state aid, merger, infringement) from citation context, then route each family to the appropriate official register. The current generic Commission adapter is intentionally conservative. **Note before starting: routing will not get you the decision text.** See "Why a competition decision is a link and not a passage" below — that was measured, and the answer changes what this item is worth.
3. Extend the task-pane tests. The runner covers the presentation logic, the confirmation flow, the success state with each language outcome, the cursor-following code (through the Word stub), and the cache warming. The **retrieval-error** state is still unexercised.
4. Replace the per-process document cache and rate limiting with shared, observable infrastructure before horizontal scaling. The store is behind a four-method `DocumentStore` interface (`api/src/document-store.ts`), so a shared backend is a third implementation of it rather than a change to the resolver.
5. Broaden `documentTypeNear` in `shared/src/index.ts` if real documents surface more opinion/order phrasings than the current signal set (English "Opinion of [the] Advocate General" / "Order of the [General] Court", French "conclusions de l'avocat général" / "ordonnance"). Missing a signal is safe — it only causes an unnecessary fetch attempt that 404s and falls back to the link — but it is worth tightening once real client documents are seen.
6. ~~Fix the joined-case CELEX gap.~~ **Done, and the diagnosis in this list was wrong** — see "The joined-case gap is not a language gap" below.
7. ~~Verify the served language rather than assuming it.~~ **Done** — see "Reading the language off the document" below.
8. ~~Clean up the legislation title heuristic.~~ **Done, and it was not cosmetic** — see "The title line, and the letters underneath it" below.

### Resolved: post-2015 legislation citations

Legislation detection previously required the pre-2015 trailing sector suffix
(`Directive 2002/58/EC`), missing the current bracketed style shared by every
act type (`Regulation (EU) 2016/679`) — including the GDPR, the most cited EU
instrument in practice. This is now handled: `shared/src/index.ts` recognises
both conventions, plus the pre-2015 regulation form that reverses the number
order (`Regulation (EC) No 1049/2001` is number/year, not year/number like
directives). A bracket or trailing suffix is always required to accept a
match, so a bare number pair after "Regulation" is never mistaken for a
citation — see `known detection gaps` in
`shared/test/detect-citations.test.ts` for the two cases still intentionally
unmatched (no sector marker at all; the pre-1994 two-digit-year EEC form).

### Resolved: CURIA case law now shows the actual judgment text

Previously, selecting a CJEU/General Court citation only produced a link to
CURIA's case-search page — the lawyer still had to leave Word, search, find
the right document among possibly several (judgment, opinion, order), and
locate the paragraph by hand. This was the weakest point relative to Ibid's
actual purpose: presenting the case-law source in its original form so the
lawyer can independently judge whether it supports the proposition.

EUR-Lex/CELLAR also mirrors CJEU/General Court case law under its own CELEX
identifiers, and detection already derived this CELEX (`C-293/12` →
`62012CJ0293`) without ever using it. The resolver now attempts the same
fetch-and-focus-on-locator path already proven for legislation, so most
modern judgments show the actual cited paragraph inline, with the link
pointing at the fetched document instead of a search page.

Two correctness issues had to be fixed first, since a wrong document shown
with false confidence would be worse than the original link-only behaviour:

- **Century.** `celexForCase` used to hardcode the 2000s, so any case before
  2000 — Costa v ENEL (`6/64`), Van Gend en Loos (`26/62`), Cassis de Dijon
  (`120/78`) — got a silently wrong CELEX. It now resolves the two-digit year
  against the real clock (there is no genuine ambiguity: the Court has only
  existed since 1952, a span under 100 years), and refuses to derive a CELEX
  at all if the result would predate the Court rather than emit one. See
  `resolveTwoDigitYear` and `celexForCase` in `shared/src/index.ts`, both
  exported for direct testing of this boundary.
- **Document type.** The derived CELEX always names the judgment (`CJ`/`TJ`
  sector). A citation to an Advocate General opinion or an order would get a
  CELEX pointing at the wrong document. `documentTypeNear` scans the text
  around each case citation for such wording and sets `documentType`;
  whenever it is `'opinion'` or `'order'`, both the resolver
  (`api/src/index.ts`) and the client's persistent "Open official source"
  link (`addin/src/ui/App.tsx`) skip the CELEX-based path entirely and use
  the safe CURIA link instead — the fetch is never even attempted, not just
  caught if it fails.

Any other fetch failure (an older case CELLAR does not mirror, a network
error, throttling exhausting its retry budget) falls back to the same safe
link without surfacing an error to the reviewer — the existing link-only
behaviour was always correct, just less convenient, so it remains the floor.

## Working-tree caution

The repository already contained uncommitted changes and untracked files before this handoff work. Inspect `git status` and preserve unrelated edits; do not reset or discard the worktree wholesale.
