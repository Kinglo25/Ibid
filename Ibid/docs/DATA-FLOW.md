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

**The document, and all of its text.** Citation recognition runs *inside the task pane* —
`shared/src/index.ts` is compiled into the pane's own JavaScript bundle and executes in
Word's embedded browser. Footnote text is read, parsed and resolved locally. No document
body, no footnote text, and no surrounding context is transmitted anywhere.

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

Notably **not** sent: the document, the footnote, the citation's surrounding context
(`citation.context` exists in the pane and is deliberately excluded from the lookup), the
file name, the user's identity, or anything about the matter.

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
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|localStorage\|sessionStorage" addin/src/
grep -rn "insertText\|insertParagraph\|insertHtml" addin/src/
grep -n "console\." api/server.mjs
grep -n "Permissions" addin/manifest.xml
```
