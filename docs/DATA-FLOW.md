# Ibid — what crosses the wire

Written for an IT or information-security review. Every statement here is checkable against
this repository; file references are given so it can be verified rather than taken on
trust.

## What Ibid is

A Word task-pane add-in that reads the footnotes of the open document, recognises EU-law
citations in them (CJEU case numbers, ECLI identifiers, directives, regulations, Treaty
articles, Commission case numbers), and displays the corresponding official passage from
the EU's own public databases. It is a reading aid. It never edits the document and offers
no opinion on whether a citation is legally correct.

## Permission requested

`ReadDocument` — read-only (`addin/manifest.xml`). The add-in makes no mutating Word API
call anywhere in its source; `insertText`, `insertParagraph`, `insertHtml` and property
assignment appear zero times. It is not capable of altering the document, and Word will
not grant it write access.

## What stays on the machine

**The document, and effectively all of its text.** Citation recognition runs *inside the
task pane* — `shared/src/index.ts` is compiled into the pane's own JavaScript bundle and
executes in Word's embedded browser. Footnote text is read, parsed and resolved locally.
The document body, the footnote as written, and the prose surrounding each citation are
never transmitted anywhere.

The whole of the analysis is local: detecting citations, resolving short forms against
earlier footnotes, following `Ibid.`/`supra` chains, and deriving CELEX identifiers all
happen in the pane. None of it requires a server, and none of it sends anything. The
network is reached only at the last step, to fetch a public EU document by its identifier.

**Stated precisely, because a reviewer will check it:** two of the fields below are
substrings of the footnote — `value`, the citation exactly as written (`C-293/12`), and
`caseName`, the case name where one was recognised (`Digital Rights Ireland`). Those are
the citation itself, which is the thing being looked up; a lookup cannot happen without
them. What never crosses the wire is everything *around* the citation — the sentence it
sits in, the argument it supports, the rest of the footnote, the rest of the document.

## What leaves the machine

Exactly one kind of outbound request, built and sent from one line of code
(`addin/src/ui/App.tsx`):

```
GET {api-origin}/api/sources?confirm=later&lookup={...}
```

`confirm=later` carries nothing from the document: it asks the server to answer a Commission
decision it already holds straight away rather than first confirming it against
`ec.europa.eu`. Such an answer is marked as not yet confirmed, and the pane then sends the
same lookup a second time without the parameter, once the warming queue below has drained,
to have it confirmed. So a Commission citation Ibid has read before produces two identical
lookups rather than one — same fields, one at a time, like every other request here.

It is sent when the reviewer selects a citation, and — since the pane began warming the
cache at document open — also once per distinct authority the document cites, in reading
order, in the background. **The content of the request is identical either way**: both paths
build it through the same `lookupFor` function, which names the ten fields below one by
one. Warming changes *when* lookups happen and how many, not what is in them.

What that means for a reviewer of this document: opening a file in Word now produces a
lookup for each authority it cites, rather than one per citation the reviewer clicks. The
requests are issued one at a time, never in parallel, and are abandoned when the document is
closed or changed. If lookup volume rather than lookup content is the concern — see point 6
below, which is about exactly that — this is the paragraph that matters, and warming can be
removed without touching anything else in the pane.

The `lookup` object contains only these fields, and nothing else:

| Field | Example |
| --- | --- |
| `source` | `curia` |
| `value` | `C-293/12` |
| `celex` | `62012CJ0293` |
| `ecli` | `ECLI:EU:C:2014:238` |
| `caseNumber` | `C-293/12` |
| `caseName` | `Digital Rights Ireland` |
| `documentType` | `judgment` |
| `locator` | `{ kind: 'point', start: 40 }` |
| `paragraphs` | `[40]` |
| `alternativeCelexes` | `['62012CJ0594']` |

`alternativeCelexes` is present only where the footnote cites a joined case, and carries the
other case numbers of that same group as CELEX identifiers — CELLAR files a joined judgment
under one of its numbers and not the others, so this is what lets the passage be found under
whichever one the drafter wrote. It is the group's own identifiers and nothing else: it can
never name an authority the footnote did not cite.

Notably **not** sent: the document, the footnote as written, the citation's surrounding
context, the file name, the user's identity, or anything about the matter.

The exclusion is structural rather than incidental. The object handed to the lookup
function is a `CitationContext`, which is defined as `CitationMatch & { context: string }`
(`shared/src/index.ts`) — the surrounding prose *is* present on the object, in memory, at
the moment the request is built. The request is nonetheless assembled by naming its ten
fields one by one, in `lookupFor` (`addin/src/ui/App.tsx`), not by spreading the citation
object. A developer adding a new field to the citation type therefore cannot cause it to
start crossing the wire by accident: it would have to be typed out inside that function.
That is the difference between "context is not sent today" and "context is not sent".

There is exactly one such function, and both the click path and the background warming go
through it — which makes the guarantee stronger than it was when only one caller existed,
because a second caller spelling the fields out again is precisely how a field like
`context` gets added to one of them and not the other. `addin/test/App.test.tsx` asserts
the exact key set on a warming request for this reason — twice, because an absent field is
dropped by `JSON.stringify`: once for an ordinary citation and once for a joined case, which
is the only citation that sends the tenth field.

The server then requests the cited document from the EU Publications Office
(`publications.europa.eu`) and returns the relevant passage — or, for a competition citation
from the Commission's own site instead, since a
competition decision is published there and nowhere else. See the table below.

## Third parties contacted

| Host | By | Why |
| --- | --- | --- |
| `appsforoffice.microsoft.com` | Word | Microsoft's own Office.js library. Required by every Office add-in; loaded by Word, not by Ibid. |
| Your Ibid host | The pane | The single lookup request above. |
| `publications.europa.eu` | The Ibid server | Retrieves the cited official text, by CELEX or by ECLI. Public EU legal database; equivalent to opening EUR-Lex in a browser. |
| `compcases-open-data-portal-files-prod.s3.eu-west-1.amazonaws.com` | The Ibid server, **unless `IBID_COMMISSION_CASE_DATA=off`** | Downloads the Commission's own published competition case data (the distribution `data.europa.eu` lists for "EU Competition: Antitrust and Cartel case publications" and its merger counterpart), so a competition citation can link the decision itself instead of a search page. ~42MB on first use and roughly once a day after. Nothing is sent but the request for the file. |
| `ec.europa.eu` | The Ibid server, **unless `IBID_COMMISSION_CASE_DATA=off`** | Downloads the published competition decision named by the case data above, so the cited recital can be shown rather than linked. Up to four of a case's published decisions on the first citation of it — the one carrying the cited recital is the one shown — each cached thereafter and only revalidated. The request carries the URL the Commission itself published and nothing else. |

**Why `pdfjs-dist` is here, since this document used to say the server had no dependencies.**
A Commission decision is published as a PDF and in no other form — CELLAR holds a summary, an
advisory opinion and a hearing officer's report, and no text of the decision — so showing the
cited recital means reading a PDF. A dependency-free extractor was written first and refused:
it recovers most of the characters and loses the line structure the recital anchors depend on,
which would put a wrong passage under a lawyer's citation. `pdfjs-dist` is one Apache-2.0
package with no transitive dependencies; its only declared dependency, `@napi-rs/canvas`, is
*optional*, is loaded by a guarded `require` on the page-rendering path, is never reached by
text extraction, and is omitted by installing with `--omit=optional`. It is imported lazily,
so a deployment with the flag off never loads it. Parsing is given the bytes already in hand
and `useWorkerFetch: false`, so pdfjs makes no network request of its own.

**On those two server-side hosts, because they are the new thing here.** Both are on by
default and are turned off together by
`IBID_COMMISSION_CASE_DATA=off`, and neither carries anything of the user's: no part of either
request comes from the document, because nothing from the document ever reaches the server at
all. The first downloads two public files describing published competition cases; what comes
back is reduced to a case-number → decision-URL index held **in memory**, and the files
themselves are not kept. The second downloads a published decision — **the server does fetch
the PDF**, which it did not before this feature — reads its text, and keeps *the extracted
text* in the same disk cache as the CELLAR documents, keyed by the decision's own public URL.
The PDF itself is not kept. Both are public documents anyone can download without an account,
and with the flag off neither host is contacted at all.

There are no analytics, no telemetry, no error-reporting service, no advertising, no
fonts or scripts from any CDN, and no cookies. The pane uses neither `localStorage` nor
`sessionStorage`. Grep the source for `fetch(`: there is one occurrence, used by both the
click path and the background warming.

## Third-party code in the running system

A supply-chain question is usually the next one asked, and the answer here is unusually
short.

| Component | Runtime dependencies |
| --- | --- |
| The API server | **One: `pdfjs-dist`** (Apache-2.0), imported lazily and only when a Commission decision is actually read, so a deployment that never meets one never loads it. Everything else runs on the Node standard library — `node:http` and the built-in `fetch`. TypeScript and ESLint are build-time only. |
| The task pane | **Two:** `react` and `react-dom`. Everything else in `addin/package.json` is a `devDependency` and is not shipped. |

No analytics SDK, no error reporter, no UI component library, no CDN. The pane's bundle is
built from this repository's own source plus React.

## Accounts, storage and retention

No user accounts, no sign-in, no user identifier of any kind. The server logs only its own
startup and startup failures (`api/server.mjs`) — it does not log requests.

**The server does write to disk, in exactly one place, and it is worth being precise about
what.** It keeps the EU legal documents it has retrieved from `publications.europa.eu` —
the judgments and legislation themselves — in a cache directory
(`api/src/document-store.ts`), so that a citation of an authority already retrieved costs a
conditional request that CELLAR answers with `304` and no body, rather than another download
of the same text. Each entry is the document's HTML plus its `ETag`, `Last-Modified`, and
the time it was last confirmed.

- **What is written:** public EU legal texts, byte for byte as the Publications Office
  serves them. The same documents anyone can fetch from EUR-Lex without an account. It also holds the *text extracted from* a published
  Commission decision — the text, never the PDF, keyed by the decision's own public URL. A
  decision published as a scan is stored as an empty string, which records that it was read
  and has no text, so it is not downloaded again to learn the same thing.
- **What is never written:** anything from the user's document. Nothing from the document
  reaches the server in the first place — the analysis is entirely local to the task pane —
  so there is nothing of the user's for this to hold. The cache key is the CELEX identifier,
  the language, and the format; no part of it comes from the user's text.
- **Where:** outside the repository by default (`$XDG_CACHE_HOME/ibid/documents`,
  `%LOCALAPPDATA%\Ibid\Cache\documents`, or `~/.cache/ibid/documents`). Set
  `IBID_CACHE_DIR` to place it deliberately, or `IBID_CACHE_ENTRIES=0` to run with no disk
  cache at all, which falls back to the bounded in-memory one. The server prints the
  directory it is using at startup.
- **Bounded:** an entry count (512 by default) and a byte ceiling, oldest confirmation
  evicted first. There is deliberately no expiry: a published EU legal text does not change
  — an amended directive is a different instrument with its own CELEX — so revalidation on
  every use, not a timer, is what keeps it correct.

Derived excerpts are still held only in memory, and are now bounded too (see point 3 below,
which this closes).

## What a reviewer should weigh

Everything above is what Ibid does well, so this section is deliberately the other half:
the points we would raise ourselves if we were reviewing this. None of them is a defect in
how document content is handled — that analysis never leaves the pane. All of them are
properties of how the API is deployed and operated, and the first two are the reason the
hosting decision matters.

**1. The API has no authentication, and the deployment in `HOSTING.md` exposes it
publicly.** `api/server.mjs` performs no authentication of any kind: no key, no session,
no allowlist. It binds to `127.0.0.1`, but the reverse-proxy configuration we recommend
then publishes `/api/*` from a public hostname. Anyone who learns that hostname can issue
lookups. They cannot reach the document — it never leaves the pane — and they cannot
redirect the outbound fetch (see the note on URL construction below), but they can consume
the service and cause requests to `publications.europa.eu` that carry the operator's
`User-Agent`. Before production use, place the API behind the firm's network boundary, a
shared secret, or an authenticating proxy. The CORS header is not a control here:
`Access-Control-Allow-Origin` constrains browsers, not `curl`.

`api/server.mjs` does read `IBID_EURLEX_API_KEY` and `IBID_EURLEX_BEARER_TOKEN`, which can
look like authentication at a glance. They are the opposite direction: credentials this
server presents *to* EUR-Lex, never anything it demands of a caller. The only inbound
headers the handler reads at all are `origin` and `host`.

**2. Request throttling is global, not per-caller.** The resolver spaces its outbound
requests by `minRequestIntervalMs` (default 1000ms) through a single serial queue held in
the resolver closure (`api/src/index.ts`); lookups run one at a time, in the order they
arrive. That is a politeness limit toward EUR-Lex, not a defence: it is shared by every
caller, so one client issuing continuous lookups delays everyone else's behind it. Together
with point 1, an unauthenticated public deployment can be rendered unusable by a single
script. Per-IP rate limiting belongs at the proxy.

The interval spaces *lookups* rather than individual requests, so the retries a single
document needs — a second `Accept` header for an older document, a fallback language — are
not each charged a full second. The rate of traffic CELLAR sees is unchanged; what changed
is that the delay is no longer multiplied by however many attempts one document happened to
need.

**3. The caches are now bounded — and one of them is on disk.** This was previously listed
here as a defect: previews were held in a `Map` with no size limit, in a process intended to
run for months, with part of the key caller-supplied. Both caches are now bounded by entry
count, oldest-first (`api/src/index.ts`, `api/src/document-store.ts`).

What replaces it as the thing to weigh is the disk cache described under "Accounts, storage
and retention" above. It holds public EU legal text and nothing of the user's, but it is
persistent state on the host, and an operator should know it exists, know where it is, and
be able to point it elsewhere or switch it off — `IBID_CACHE_DIR` and `IBID_CACHE_ENTRIES`
do both, and the server prints the directory at startup. There is deliberately no expiry;
freshness comes from revalidating every entry against EUR-Lex before it is used, not from a
timer.

**4. The task pane declares no Content-Security-Policy.** `addin/index.html` ships without
one. Nothing in the pane writes markup to the DOM: there is no `dangerouslySetInnerHTML`,
`innerHTML`, `eval` or `srcdoc` anywhere in `addin/src/` or `shared/src/`, and retrieved
passages are rendered as React text nodes and therefore escaped. So there is no known
injection path for a policy to close — this is defence in depth that is currently absent,
not an open hole.

**5. Lookups appear in reverse-proxy access logs by default.** The lookup travels in the
query string of a `GET`, so Caddy, nginx or any load balancer in front of the API will
record it in its access log unless configured otherwise. The application does not log it;
the infrastructure might. Disable access logging on the `/api` route, or change the
endpoint to accept `POST`, if lookup retention is unacceptable.

**6. Citation lookups are matter intelligence, even without document text.** Ibid does not
transmit client material. It does transmit *which authorities are being researched, and
when*, to whichever host runs the API. That is not privileged content, but it is not
nothing either, and it is the fact on which the hosting decision should turn.

Warming the cache at document open sharpens this rather than changing its nature. Before,
the host learned which authorities a reviewer *clicked*; now it learns which authorities the
document *cites*, as soon as it is opened — a fuller picture, and arguably a more revealing
one, since it is the shape of the whole memo rather than a reading path through it. The
mitigation is the same and is the point of this section: run the API inside the firm's own
infrastructure, where "the host" is the firm. Where that is not possible and lookup volume
is the concern, warming is one effect in `addin/src/ui/App.tsx` and removing it returns the
pane to click-triggered lookups with nothing else affected.

- **Hosted inside the firm's own infrastructure** — nothing leaves the firm's control
  except the onward request to the EU's public database. Recommended for real use.
- **Hosted externally, stateless, access logging off** — appropriate for evaluation.
- **Run locally on the reviewer's machine** — nothing leaves at all, but requires Node and
  local certificate trust, which is generally impractical on a managed device.

**Smaller items, for completeness.** API responses do not set `X-Content-Type-Options:
nosniff`; every response is `application/json` and the pane does not interpret them as
anything else. On an upstream failure, `api/server.mjs` returns the underlying error
message to the caller, which can name the upstream host and HTTP status — it does not
include any request data.

## Why the lookup cannot be turned into a server-side request forgery

Point 1 means untrusted input can reach the resolver, so the natural next question is what
that input can make the server fetch. The answer is: only a document on the configured
host, under one of two fixed paths.

The outbound URL is built by `cellarUrl` or `ecliUrl` (`api/src/index.ts`) as a fixed base
URL plus `encodeURIComponent(identifier)` — the CELEX for the first, the ECLI for the
second. Percent-encoding the identifier means a caller cannot introduce `/`, `:`, `?` or
`#`, and therefore cannot traverse out of the path segment, change the host, or append a
query. (An ECLI's own colons are percent-encoded by this, which is what CELLAR expects.)
The base URL comes from environment configuration, never from the request; `ecliUrl`
derives its base from the same configured value by replacing a trailing `/celex` segment
with `/ecli`, and returns nothing at all — so no request is made — if that segment is not
there to replace. Neither function can be reached with a base the caller supplied.

## Verifying these claims

```bash
# One outbound request in the pane, and no browser storage. Expect a single hit.
grep -rnE "\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage" addin/src/ shared/src/

# Both request paths — a click and the background warming — build the lookup here, and
# only here. Expect one definition and no other place naming these fields.
grep -n "function lookupFor" -A 10 addin/src/ui/App.tsx

# The add-in cannot write to the document. Expect no hits.
grep -rn "insertText\|insertParagraph\|insertHtml\|insertOoxml" addin/src/

# Read-only permission. Expect: <Permissions>ReadDocument</Permissions>
grep -n "Permissions" addin/manifest.xml

# Exactly what is put on the wire — ten named fields, no spread.
sed -n '/^function lookupFor/,/^}/p' addin/src/ui/App.tsx

# Everything the server writes to disk, and the only place it does. Expect hits in
# document-store.ts alone — the retrieved-document cache described above.
grep -rn "node:fs\|writeFile\|createWriteStream\|appendFile" api/src/ api/server.mjs

# What goes into a cache entry: the document, its validators, and when it was confirmed.
# Nothing caller-supplied beyond the CELEX, language and format that form the key.
sed -n '/export type StoredDocument/,/^};/p' api/src/document-store.ts
grep -n "function documentKey" -A 3 api/src/index.ts

# The server logs startup only, never requests.
grep -n "console\." api/server.mjs

# Runtime supply chain: pdfjs-dist for the API, react + react-dom for the pane.
# Expect @napi-rs/canvas to be absent on a server installed with --omit=optional.
grep -A4 '"dependencies"' api/package.json addin/package.json

# Dependency advisories, runtime and build-time. Expect: found 0 vulnerabilities.
npm audit

# The claims above that are weaknesses, checkable the same way.
grep -n "Content-Security-Policy" addin/index.html          # expect no hits (point 4)
grep -n "MAX_CACHED_PREVIEWS\|DEFAULT_MAX_ENTRIES" api/src/index.ts api/src/document-store.ts   # bounded (point 3)
grep -n "request.headers" api/server.mjs                     # only origin and host (point 1)
sed -n '/^function cellarUrl/,/^}/p' api/src/index.ts       # encodeURIComponent, fixed base
sed -n '/^function ecliUrl/,/^}/p' api/src/index.ts         # the same, for the /ecli path
```
