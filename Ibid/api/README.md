# api

Local resolver for official EU legal sources. It accepts normalised CJEU, EUR-Lex, and Commission references from the task pane and returns a short source preview.

Run it with:

```bash
npm run dev -w api
```

The endpoint is `GET /sources?lookup=<JSON>`. During local development, Vite proxies `/api` from the add-in to `http://127.0.0.1:4000`.

EUR-Lex content is retrieved through the configurable CELLAR CELEX endpoint. Requests have a bounded timeout, a minimum interval (one request per second by default), and retries for `429` and transient server failures. Results are cached by CELEX and locator. CURIA and Commission lookups intentionally return their official case/register records directly instead of scraping search pages.

For production, configure credentials and limits in the server environment—never in Vite variables or the add-in:

```bash
IBID_EURLEX_CELLAR_BASE_URL=https://publications.europa.eu/resource/celex
IBID_EURLEX_API_KEY=...                 # if supplied by your authorised gateway
IBID_EURLEX_BEARER_TOKEN=...            # if supplied by your authorised gateway
IBID_EURLEX_MIN_INTERVAL_MS=1000
IBID_EURLEX_MAX_RETRIES=2
IBID_ALLOWED_ORIGIN=https://your-addin-host.example
```

The EUR-Lex SOAP search service and CELLAR REST document retrieval have different access arrangements. Configure the URL and authentication to match the authorised service your organisation has provisioned; do not assume that public HTML endpoints are suitable for bulk access.
