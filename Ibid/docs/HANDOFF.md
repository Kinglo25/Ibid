# Ibid engineering handoff

Last updated: 2026-08-12

## Goal

Ibid is a Word task-pane add-in for lawyers. It detects EU-law citations in Word footnotes and helps the user inspect the relevant official source. It is an inspection aid, not a legal-correctness engine.

## What is implemented

- `addin/` reads individual Word footnotes with Office.js and renders recognised citations as selectable review items. Outside Word it shows sample footnotes for browser preview.
- `shared/src/index.ts` resolves citations against the whole document, not one footnote at a time — see "Document-context citation resolution" below for the short-form, ambiguity, and gap-reporting behaviour. It detects ECLI identifiers, CJEU/General Court case numbers, directives, regulations, EU decisions, Commission `C(yyyy)` decisions, and DG Competition's own case numbers (`AT.` antitrust, `SA.` State aid, `M.`/`COMP/M.` merger). Acts are recognised in both the pre-2015 style (`Directive 2002/58/EC`; regulations as `Regulation (EC) No 1049/2001`) and the current style shared by all act types (`Regulation (EU) 2016/679`, or informally without the bracket — `Regulation 2016/679` — as long as the year is unambiguous). It derives CELEX only where the mapping is reliable, resolving each case number's two-digit year against the real clock rather than assuming the 2000s (`C-6/64` → 1964, not 2064), and flags when nearby wording ("Opinion of Advocate General…", "Order of the Court…") means a citation is not the main judgment. Article/point locators are recognised from the full words and their common abbreviations and symbols (`Art.`, `para.`, `pt.`, `§`, `¶`), not only the spelled-out form.
- `api/src/index.ts` dispatches by source family:
  - EUR-Lex/CELLAR: fetches a bounded official passage and focuses it on the cited Article or point.
  - CURIA: when the citation is confidently the main judgment, fetches the actual judgment text from EUR-Lex/CELLAR (which mirrors CJEU/General Court case law under its own CELEX) and focuses it on the cited point, the same as legislation. Falls back to a direct, official CURIA case-record link — without ever attempting a fetch — when the citation is an Advocate General opinion or an order (the derived CELEX would name the wrong document), when no CELEX could be derived, or when the fetch itself fails (older cases CELLAR does not mirror, network errors, etc).
  - European Commission: returns a direct official Competition Case Register search link.
- EUR-Lex/CELLAR retrieval (used for both legislation and case law) has an in-memory cache, 12-second timeout, one-second default request spacing shared across both, and exponential retry/backoff for `429` and transient `5xx` responses. Its base URL, credentials, limits, and CORS origin are server-side environment configuration.
- `api/server.mjs` reports a clear `EADDRINUSE` error rather than an unhandled Node exception.

## Important files

| Path | Purpose |
| --- | --- |
| `addin/src/ui/App.tsx` | Word document/footnote integration and review UI |
| `addin/vite.config.ts` | HTTPS Vite server and API proxy; reads `IBID_API_PORT` |
| `shared/src/index.ts` | Citation detection and CELEX normalisation |
| `api/src/index.ts` | Source adapters, retry, throttling, caching, excerpt extraction |
| `api/server.mjs` | HTTP API and environment configuration |
| `api/README.md` | Production environment variables |
| `shared/test/detect-citations.test.ts` | Detection, CELEX derivation, locators, known gaps |
| `shared/test/resolve-citations.test.ts` | Pinpoint grammar, case names, short-form resolution, ambiguity policy, and the collected-pattern acceptance set |
| `shared/test/citation-formats.test.ts` | The English/French language boundary, pre-1989 case numbers, false positives, case names next to identifiers |
| `shared/test/real-citations.test.ts` | A realistic memo built from real, live-verified citations; also the browser-preview document |
| `api/test/resolver.test.ts` | Adapters, excerpt focusing, cache, retry, throttling |
| `api/test/lookup-contract.test.ts` | Type-level guard that `api`'s `EuLookup` still accepts a shared `CitationMatch` |
| `eslint.config.base.js` | Shared lint rules; each workspace has a thin config |
| `tsconfig.test.json` | Type-checks the test files (not part of any build) |
| `samples/ibid-demo-docx/EU_Data_Retention_Memo.docx` | Manual Word test document (all full citations; exercises detection, not resolution) |
| `samples/ibid-demo-docx/eu-case-law-citation-test.docx` | The 20 collected citation patterns; the document-context test case. Its footnotes are pinned as a fixture in `resolve-citations.test.ts` |

## Current verification

Run everything with one command:

```bash
npm run verify   # lint → test type-check → tests → build
```

- `npm run lint` passes with no errors or warnings across all three workspaces.
- `npm run test` passes: 288 tests (228 detection and resolution, 60 resolver and contract).
- `npm run typecheck:test` passes (`tsconfig.test.json`).
- `npm run build` passes (shared TypeScript, API TypeScript, and Vite production build).

Tests use the Node built-in runner (`node:test`) against the TypeScript sources
directly — Node strips the types, so there is no build step or test dependency.
They live in `shared/test/` and `api/test/`, outside each workspace's `include`,
so they never reach `dist`.

The resolver tests inject `fetcher`, `sleep`, and `now`, so retry, backoff, and
request spacing are asserted deterministically without real network or timers.
This is fast and reliable, but every EUR-Lex/CELLAR assumption in those tests
is only as good as the stub HTML matches the real service. That gap was real:
see "Verified against the live EUR-Lex/CELLAR endpoint" below for two bugs the
mocked suite could not have caught, found by actually calling the real
service. There is no live-network check in `npm run verify` (CI should not
depend on a third party being up), so re-verify by hand — with
`createEuSourceResolver()` and no `fetcher` override, so it uses the real
`fetch` — after touching `fetchEurLex`, `extractLocator`, or
`extractJudgmentPoint`.

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

- A back-reference is read only against the citation *immediately* before it. If the
  preceding footnote establishes no authority — it is pure commentary, or its own
  citation went unresolved — the reference is reported unresolved rather than
  skipping further back to the last footnote that did. Skipping would usually be
  right and occasionally, silently, wrong.
- Pre-1989 case numbers as actually written (`Case 26/62`, no `C-` prefix) are
  still not detected — an existing gap, unchanged by this round.
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

1. Obtain and configure authorised EUR-Lex/CELLAR access. Set the server-only variables listed in `api/README.md`; never expose credentials through `VITE_*` variables or browser code.
2. Deploy the API over HTTPS and set `IBID_ALLOWED_ORIGIN` to the deployed add-in origin.
3. Validate CURIA, EUR-Lex, and Commission links with representative real client documents and record any unrecognised citation patterns.

## Recommended next implementation work

1. Run the Word end-to-end validation above and fix Office.js compatibility/UI issues that appear.
2. Add explicit Commission-family classification (competition, state aid, merger, infringement) from citation context, then route each family to the appropriate official register. The current generic Commission adapter is intentionally conservative.
3. Add task-pane tests for `addin/src/ui/App.tsx`. There is no DOM/React test dependency installed yet, so this needs a deliberate choice of runner before it can start. This is now the largest untested surface in the repo, and back-references raised the stakes: `confirmationKey` is what stops one reviewer's decision about one `Ibid.` being applied to every other `Ibid.` in the document, and nothing but a type currently holds it in place.
4. Replace in-memory cache/rate limiting with shared, observable infrastructure before horizontal scaling.
5. Broaden `documentTypeNear` in `shared/src/index.ts` if real documents surface more opinion/order phrasings than the current signal set (English "Opinion of [the] Advocate General" / "Order of the [General] Court", French "conclusions de l'avocat général" / "ordonnance"). Missing a signal is safe — it only causes an unnecessary fetch attempt that 404s and falls back to the link — but it is worth tightening once real client documents are seen.
6. Clean up the legislation title heuristic in `resolveCellarPreview` (`api/src/index.ts`) — it currently surfaces the document's internal filename for at least the GDPR instead of a human title. Cosmetic; the excerpt text is unaffected.

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
