# api

Local resolver for official EU legal sources. It accepts normalised CJEU, EUR-Lex, and Commission references from the task pane and returns a short source preview.

Run it with:

```bash
npm run dev -w api
```

The endpoint is `GET /sources?lookup=<JSON>`. During local development, Vite proxies `/api` from the add-in to `http://127.0.0.1:4000`.

EUR-Lex content is retrieved through the configurable CELLAR CELEX endpoint. Requests have a bounded timeout, a minimum interval (one request per second by default), and retries for `429` and transient server failures. Results are cached by CELEX and locator. CURIA and Commission lookups intentionally return their official case/register records directly instead of scraping search pages.

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
resolver does all four — one request per second by default, exponential backoff, an
in-memory cache, and a descriptive `User-Agent`.

Set `IBID_USER_AGENT` in production so that agent carries a real contact address. Anonymous
traffic that nobody can contact is what gets blocked; a named client with an address gets an
email first. Anonymous access was once observed being served a bot-verification page under
an ordinary request rate, which is the failure this guards against — and note the resolver
verifies that a response is a genuine CELLAR document before showing it, because that page
arrived with an ordinary `HTTP 200`.

For genuine bulk work, harvest rather than hammer the REST endpoint: see the Publications
Office's [Cellar documentation](https://op.europa.eu/en/web/cellar/documentation) and its
dataset guide for developers.

## Server environment

Configure limits in the server environment—never in Vite variables or the add-in:

```bash
IBID_EURLEX_CELLAR_BASE_URL=https://publications.europa.eu/resource/celex
IBID_USER_AGENT='Ibid/0.1 (EU-law citation review; +mailto:you@example.com)'
IBID_EURLEX_API_KEY=...                 # only if you front CELLAR with your own gateway
IBID_EURLEX_BEARER_TOKEN=...            # only if you front CELLAR with your own gateway
IBID_EURLEX_MIN_INTERVAL_MS=1000
IBID_EURLEX_MAX_RETRIES=2
IBID_ALLOWED_ORIGIN=https://your-addin-host.example
```
