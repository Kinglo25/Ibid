# api

Local resolver for official EU legal sources. It accepts normalised CJEU, EUR-Lex, and Commission references from the task pane and returns a short source preview.

Run it with:

```bash
npm run dev -w api
```

The endpoint is `GET /sources?lookup=<JSON>`. During local development, Vite proxies `/api` from the add-in to `http://127.0.0.1:4000`.

EUR-Lex content is retrieved through the configurable CELLAR CELEX endpoint. Requests have a bounded timeout, a minimum interval between lookups (one per second by default), and retries for `429` and transient server failures. CURIA and Commission lookups intentionally return their official case/register records directly instead of scraping search pages.

## Caching, and why there is no expiry

Two caches, doing different jobs.

The **document cache** holds the retrieved CELLAR document itself, keyed by CELEX, language
and Accept header. It is what makes one authority cost one download however many pinpoints
cite it — CELLAR serves no compression, so a repeat is the full 149KB of a judgment or 807KB
of the GDPR. It persists across restarts (`api/src/document-store.ts`) and is bounded by
entry count and total bytes, oldest confirmation evicted first.

The **excerpt cache** holds the passages derived from those documents, keyed by the citation
that asked for one. It is in-memory, bounded, and is a cache of work rather than of
retrieval.

Neither has a TTL, deliberately. A published EU legal text does not change: a directive is
amended by another instrument carrying its own CELEX, and a judgment is never rewritten. An
arbitrary expiry would throw away a document that is still correct. What keeps the cache
honest instead is **revalidation on every use**: CELLAR sends `ETag` and `Last-Modified`
under `Cache-Control: no-cache`, and answers a conditional request with `304` and no body —
measured live at ~270ms, against ~1.5s to download the same judgment. So every passage shown
has been confirmed with the Publications Office at the moment it was shown, and the pane
prints the time it was confirmed.

Note for anyone touching this: a `304` has no body, so the "is this a genuine CELLAR
document" check must not run on it.

### Where the cache lives

Outside the repository, in a platform cache directory — `$XDG_CACHE_HOME/ibid/documents`,
`%LOCALAPPDATA%\Ibid\Cache\documents`, or `~/.cache/ibid/documents`. The server prints the
directory it is using at startup.

```bash
IBID_CACHE_DIR=/var/cache/ibid      # put it somewhere deliberate
IBID_CACHE_ENTRIES=512              # how many documents to keep; 0 disables the disk cache
```

It holds public EU legal texts and nothing else. Nothing from the user's document reaches
this server at all — citation analysis is entirely local to the task pane — so there is
nothing of theirs for it to hold. See `docs/DATA-FLOW.md`.

## Access to CELLAR

CELLAR's REST interface — `https://publications.europa.eu/resource/celex/…`, which is what
this resolver reads — is a public service. There is no authenticated tier for it and no
credential to obtain, so `IBID_EURLEX_API_KEY` and `IBID_EURLEX_BEARER_TOKEN` exist only for
a gateway you might place in front of it; the Publications Office issues neither.

The thing that *is* registrable is a different service: the [EUR-Lex
web service](https://eur-lex.europa.eu/protected/web-service-registration.html), a SOAP
**search** API over EUR-Lex metadata, requested through EU Login. It returns search results,
not document text, so it does not help retrieval and this resolver does not use it.

What keeps public access working is behaving like an identifiable, well-mannered client,
which is also what the Publications Office asks of callers of its sibling SPARQL endpoint:
identify the application, keep concurrency low, back off on `429`/`503`, and cache. This
resolver does all four — one lookup per second by default, issued strictly one at a time
and never in parallel, exponential backoff, a revalidating cache that turns a repeat
retrieval into a zero-byte `304`, and a descriptive `User-Agent`.

Set `IBID_USER_AGENT` in production so that agent carries a real contact address. Anonymous
traffic that nobody can contact is what gets blocked; a named client with an address gets an
email first. Anonymous access was once observed being served a bot-verification page under
an ordinary request rate, which is the failure this guards against — and note the resolver
verifies that a response is a genuine CELLAR document before showing it, because that page
arrived with an ordinary `HTTP 200`.

For genuine bulk work, harvest rather than hammer the REST endpoint: see the Publications
Office's [Cellar documentation](https://op.europa.eu/en/web/cellar/documentation) and its
dataset guide for developers.

## Language and translation

Retrieval negotiates language with CELLAR, which answers `404` for a language a document was
never published in — so `IBID_LANGUAGES` is a real fallback chain, not a hint. It defaults to
`en,fr`: the published English text where one exists, the French where it does not. Both
Accept headers are tried for a language before that language is judged absent, because an
older document is `text/html` only and a format `404` means something different from a
language `404`.

Before this, `Accept-Language` was pinned to English, so a document published only in French
returned nothing at all and the pane degraded to a bare link.

Re-confirmed live on 21 August 2026: `Accept-Language: gle` returns `404` for both a
directive and a judgment, because neither was published in Irish. A judgment returning
Maltese for `mlt` is not a counter-example — CJEU judgments are translated into every
official language *except* Irish, so Maltese genuinely exists for it.

## Two identifiers, not one

A document is asked for by its CELEX first and, if CELLAR answers that it has never heard of
that identifier, by its ECLI (`https://publications.europa.eu/resource/ecli/…`). The CELEX
Ibid sends is derived from the citation; the ECLI is quoted from it. CELLAR holds some case
law — recent orders in particular — indexed by the second and not the first, so this is the
difference between showing the cited paragraph and showing a link to go and find it.

Only a `404` falls through to the ECLI; any other status fails immediately, since a second
identifier will not fix a server failing for an unrelated reason. Each identifier is cached
under its own key, so a document that resolved by ECLI is revalidated by ECLI.

## Language and translation, continued

The chain is cheap now for a different reason. CELLAR distinguishes "this identifier does not
exist" (`Resource [system 'celex' - id '…'] not found.`) from "this rendition of it does not"
(`… does not hold a content datastream of the requested type`), in the body of an otherwise
identical `404`. Only the second is worth trying another format or language for, so a
document CELLAR does not hold ends the whole chain after one request instead of four — which
was the only case in which the language fallback ever cost anything for case law.

A French passage is shown in French and labelled. To show it in English instead, supply a
`translate` function to `createEuSourceResolver`:

```ts
createEuSourceResolver({ translate: async (text, from) => /* → English */ });
```

There is deliberately no default. A translation is not the authority, so whenever one is
shown the pane says so and links to the authentic text, and the Court's own English is
always preferred over a machine's. A translator that throws or times out degrades to the
published French rather than failing the retrieval — the real text is worth more than
nothing.

## Server environment

Configure limits in the server environment—never in Vite variables or the add-in:

```bash
IBID_EURLEX_CELLAR_BASE_URL=https://publications.europa.eu/resource/celex
IBID_USER_AGENT='Ibid/0.1 (EU-law citation review; +mailto:you@example.com)'
IBID_LANGUAGES=en,fr                    # retrieval preference order
IBID_EURLEX_API_KEY=...                 # only if you front CELLAR with your own gateway
IBID_EURLEX_BEARER_TOKEN=...            # only if you front CELLAR with your own gateway
IBID_EURLEX_MIN_INTERVAL_MS=1000        # between lookups, not between the attempts within one
IBID_EURLEX_MAX_RETRIES=2
IBID_CACHE_DIR=/var/cache/ibid          # retrieved documents; defaults outside the repository
IBID_CACHE_ENTRIES=512                  # 0 disables the disk cache entirely
IBID_ALLOWED_ORIGIN=https://your-addin-host.example
```
