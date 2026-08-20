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

## Two things a reviewer should weigh

**1. Lookups appear in reverse-proxy access logs by default.** The lookup travels in the
query string of a `GET`, so Caddy, nginx or any load balancer in front of the API will
record it in its access log unless configured otherwise. The application does not log it;
the infrastructure might. Disable access logging on the `/api` route, or change the
endpoint to accept `POST`, if lookup retention is unacceptable.

**2. Citation lookups are matter intelligence, even without document text.** Ibid does not
transmit client material. It does transmit *which authorities are being researched, and
when*, to whichever host runs the API. That is not privileged content, but it is not
nothing either, and it is the fact on which the hosting decision should turn:

- **Hosted inside the firm's own infrastructure** — nothing leaves the firm's control
  except the onward request to the EU's public database. Recommended for real use.
- **Hosted externally, stateless, access logging off** — appropriate for evaluation.
- **Run locally on the reviewer's machine** — nothing leaves at all, but requires Node and
  local certificate trust, which is generally impractical on a managed device.

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
```
