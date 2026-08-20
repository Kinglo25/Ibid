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

Exactly one outbound request, from one line of code (`addin/src/ui/App.tsx`), sent only
when the reviewer selects a citation:

```
GET {api-origin}/api/sources?lookup={...}
```

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

Notably **not** sent: the document, the footnote as written, the citation's surrounding
context, the file name, the user's identity, or anything about the matter.

The exclusion is structural rather than incidental. The object handed to the lookup
function is a `CitationContext`, which is defined as `CitationMatch & { context: string }`
(`shared/src/index.ts`) — the surrounding prose *is* present on the object, in memory, at
the moment the request is built. The request is nonetheless assembled by naming its nine
fields one by one (`addin/src/ui/App.tsx`), not by spreading the citation object. A
developer adding a new field to the citation type therefore cannot cause it to start
crossing the wire by accident: it would have to be typed out inside the lookup. That is
the difference between "context is not sent today" and "context is not sent".

The server then requests the cited document from the EU Publications Office
(`publications.europa.eu`) and returns the relevant passage.

## Third parties contacted

| Host | By | Why |
| --- | --- | --- |
| `appsforoffice.microsoft.com` | Word | Microsoft's own Office.js library. Required by every Office add-in; loaded by Word, not by Ibid. |
| Your Ibid host | The pane | The single lookup request above. |
| `publications.europa.eu` | The Ibid server | Retrieves the cited official text. Public EU legal database; equivalent to opening EUR-Lex in a browser. |

There are no analytics, no telemetry, no error-reporting service, no advertising, no
fonts or scripts from any CDN, and no cookies. The pane uses neither `localStorage` nor
`sessionStorage`. Grep the source for `fetch(`: there is one occurrence.

## Third-party code in the running system

A supply-chain question is usually the next one asked, and the answer here is unusually
short.

| Component | Runtime dependencies |
| --- | --- |
| The API server | **None.** `api/package.json` declares no `dependencies` at all. It runs on the Node standard library — `node:http` and the built-in `fetch`. TypeScript and ESLint are build-time only. |
| The task pane | **Two:** `react` and `react-dom`. Everything else in `addin/package.json` is a `devDependency` and is not shipped. |

No analytics SDK, no error reporter, no UI component library, no CDN. The pane's bundle is
built from this repository's own source plus React.

## Accounts, storage and retention

No user accounts, no sign-in, no user identifier of any kind. The server keeps an
**in-memory** cache of retrieved passages, keyed by document identifier and paragraph,
which is lost when the process restarts. Nothing is written to disk. The server logs only
its own startup and startup failures (`api/server.mjs`) — it does not log requests.

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
requests by `minRequestIntervalMs` (default 1000ms) through a single queue held in the
resolver closure (`api/src/index.ts`). That is a politeness limit toward EUR-Lex, not a
defence: it is shared by every caller, so one client issuing continuous lookups delays
everyone else's behind it. Together with point 1, an unauthenticated public deployment can
be rendered unusable by a single script. Per-IP rate limiting belongs at the proxy.

**3. The retrieved-passage cache is unbounded.** Previews are held in a `Map` with no size
limit and no expiry (`api/src/index.ts`); only an explicit `clearCache()` empties it, and
part of the cache key is caller-supplied. Growth is slow — an entry is stored only after a
successful upstream fetch, which the throttle caps at roughly one per second — and the
cache holds public EU legal text, not client material. But it is unbounded in a process
intended to run for months. Restarting the process is today's mitigation; a bounded LRU is
the fix.

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
nothing either, and it is the fact on which the hosting decision should turn:

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
that input can make the server fetch. The answer is: only a CELEX document on the
configured host. The outbound URL is built by `cellarUrl` (`api/src/index.ts`) as the
fixed base URL plus `encodeURIComponent(celex)`. Percent-encoding the identifier means a
caller cannot introduce `/`, `:`, `?` or `#`, and therefore cannot traverse out of the
path segment, change the host, or append a query. The base URL comes from environment
configuration, never from the request.

## Verifying these claims

```bash
# One outbound request in the pane, and no browser storage. Expect a single hit.
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|WebSocket\|localStorage\|sessionStorage" addin/src/ shared/src/

# The add-in cannot write to the document. Expect no hits.
grep -rn "insertText\|insertParagraph\|insertHtml\|insertOoxml" addin/src/

# Read-only permission. Expect: <Permissions>ReadDocument</Permissions>
grep -n "Permissions" addin/manifest.xml

# Exactly what is put on the wire — nine named fields, no spread.
sed -n '/const lookup = {/,/};/p' addin/src/ui/App.tsx

# Nothing is written to disk, anywhere in the server. Expect no hits.
grep -rn "node:fs\|writeFile\|createWriteStream\|appendFile" api/src/ api/server.mjs

# The server logs startup only, never requests.
grep -n "console\." api/server.mjs

# Runtime supply chain: none for the API, react + react-dom for the pane.
grep -A4 '"dependencies"' api/package.json addin/package.json

# Dependency advisories, runtime and build-time. Expect: found 0 vulnerabilities.
npm audit

# The claims above that are weaknesses, checkable the same way.
grep -n "Content-Security-Policy" addin/index.html          # expect no hits (point 4)
grep -n "request.headers" api/server.mjs                     # only origin and host (point 1)
sed -n '/function cellarUrl/,/^}/p' api/src/index.ts        # encodeURIComponent, fixed base
```
