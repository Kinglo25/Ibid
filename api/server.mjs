import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createCommissionCaseIndexLoader, createEuSourceResolver, createFileDocumentStore, createStaticFiles, defaultCacheDirectory } from './dist/index.js';

const eurLexHeaders = {};
if (process.env.IBID_EURLEX_API_KEY) eurLexHeaders['X-API-Key'] = process.env.IBID_EURLEX_API_KEY;
if (process.env.IBID_EURLEX_BEARER_TOKEN) eurLexHeaders.Authorization = `Bearer ${process.env.IBID_EURLEX_BEARER_TOKEN}`;
/**
 * Retrieved CELLAR documents, kept across restarts.
 *
 * This is the one thing the server writes to disk, and what it writes is public EU legal
 * text fetched from `publications.europa.eu` — never anything from the user's document,
 * which never leaves the task pane (see `docs/DATA-FLOW.md`). It lives outside the
 * repository by default; set `IBID_CACHE_DIR` to place it deliberately, or
 * `IBID_CACHE_ENTRIES=0` to run with no disk cache at all, which falls back to the bounded
 * in-memory one.
 */
const cacheEntries = Number(process.env.IBID_CACHE_ENTRIES ?? 512);
const documentStore = cacheEntries > 0
  ? createFileDocumentStore({ directory: process.env.IBID_CACHE_DIR, maxEntries: cacheEntries })
  : undefined;

/**
 * Where the Commission publishes its competition decisions, from its own open data.
 *
 * On by default, because it is what the tool is for: without it a competition citation gets a
 * link to a search page, which is the work the reviewer came here to be spared. What makes
 * that safe as a default is the shape of its failures — a dataset that will not download, a
 * decision published as a scan, two decisions that both carry the cited recital — every one
 * of them ends at the case-register link, which is exactly the behaviour of a deployment with
 * this switched off. The worst outcome of leaving it on is the pane a reviewer had before it
 * existed.
 *
 * `IBID_COMMISSION_CASE_DATA=off` turns it off, for a deployment whose IT wants to approve
 * the outbound hosts first: it contacts `data.europa.eu`'s distribution host and
 * `ec.europa.eu`, both public sites of the Commission, and downloads about 42MB when it first
 * builds its index plus the decisions actually cited. Nothing from the user's document is
 * involved either way — see `docs/DATA-FLOW.md`.
 */
const commissionCases = process.env.IBID_COMMISSION_CASE_DATA === 'off'
  ? undefined
  : createCommissionCaseIndexLoader({ userAgent: process.env.IBID_USER_AGENT });

const resolver = createEuSourceResolver({
  documentStore,
  commissionCases,
  cellarBaseUrl: process.env.IBID_EURLEX_CELLAR_BASE_URL,
  userAgent: process.env.IBID_USER_AGENT,
  // Order of preference, e.g. "en,fr". CELLAR answers 404 for a language a document was
  // never published in, so this is a real fallback chain.
  preferredLanguages: process.env.IBID_LANGUAGES?.split(',').map((l) => l.trim()).filter(Boolean),
  minRequestIntervalMs: Number(process.env.IBID_EURLEX_MIN_INTERVAL_MS ?? 1000),
  maxRetries: Number(process.env.IBID_EURLEX_MAX_RETRIES ?? 2),
  eurLexHeaders,
});
/**
 * The task pane, served from this process when asked to be.
 *
 * The documented deployment puts Caddy in front: it serves `addin/dist` and forwards `/api`
 * here. That stays the right shape for a host you control. But a proxy is something you
 * must have somewhere to configure, and a free or platform-as-a-service host gives you one
 * process, one port, and no proxy layer at all — so without this there is no way to put
 * Ibid in front of a client without first paying for a VM.
 *
 * Opt-in, and staying opt-in: a server that begins serving files because it was started
 * from the wrong directory is a worse failure than one that serves none.
 */
const staticFiles = process.env.IBID_STATIC_DIR ? createStaticFiles(process.env.IBID_STATIC_DIR) : undefined;

// `IBID_API_PORT` is this repository's own; `PORT` is what every platform host sets, and is
// not optional there — the process is unreachable on any other.
const port = Number(process.env.IBID_API_PORT ?? process.env.PORT ?? 4000);
/**
 * Loopback unless told otherwise, which is the safe default and the wrong one on a platform
 * host: there the process must accept the platform's own forwarded connections, so
 * `IBID_BIND_HOST=0.0.0.0` is required. Deliberately not inferred from `IBID_STATIC_DIR` —
 * what a server listens on should be something an operator said, not something another
 * setting implied.
 */
const bindHost = process.env.IBID_BIND_HOST ?? '127.0.0.1';
const allowedOrigin = process.env.IBID_ALLOWED_ORIGIN ?? 'https://localhost:3000';

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  /**
   * The pane always calls `/api/...`. Behind Caddy that prefix is stripped before it
   * arrives; served from this process there is nothing to strip it, so both spellings are
   * answered here and the pane does not have to know which deployment it is in.
   */
  const route = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
  const isApi = route === '/health' || route === '/sources';

  const json = (status, body) => {
    // Only the API answers with CORS, and only to the one configured origin. A page served
    // from this process is same-origin with it by definition and needs none.
    const requestOrigin = request.headers.origin;
    if (requestOrigin === allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.statusCode = status;
    response.end(JSON.stringify(body));
  };

  if (isApi) {
    if (route === '/health') return json(200, { status: 'ok' });
    try {
      const lookup = JSON.parse(url.searchParams.get('lookup') ?? '{}');
      if (!lookup.source || !lookup.value) return json(400, { error: 'A source and citation are required.' });
      // `confirm=later` is the pane asking for a decision already held to be answered from at
      // once and confirmed on a second request — see `ResolveOptions` in `src/index.ts`.
      const confirm = url.searchParams.get('confirm') === 'later' ? 'later' : 'first';
      return json(200, { documents: await resolver.resolve(lookup, { confirm }) });
    } catch (error) {
      return json(502, { error: error instanceof Error ? error.message : 'Official-source lookup failed.' });
    }
  }

  if (staticFiles && (request.method === 'GET' || request.method === 'HEAD')) {
    const asset = await staticFiles.find(url.pathname);
    if (asset) {
      response.setHeader('Content-Type', asset.contentType);
      response.setHeader('Content-Length', asset.size);
      response.setHeader('Cache-Control', asset.cacheControl);
      // The pane is framed by Word itself, so it cannot deny framing outright — but it has
      // no business being framed by anyone else, and it loads no plugins of its own.
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method === 'HEAD') return response.end();
      try {
        return await pipeline(staticFiles.open(asset), response);
      } catch {
        // The reader died mid-stream, which is a client that navigated away rather than a
        // fault here. Headers are already sent, so there is nothing left to say.
        return response.destroy();
      }
    }
  }

  return json(404, { error: 'Not found' });
});

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Ibid API could not start: port ${port} is already in use. Stop the existing API, or run IBID_API_PORT=${port + 1} npm run dev.`);
  } else {
    console.error('Ibid API could not start:', error);
  }
  process.exitCode = 1;
});

server.listen(port, bindHost, () => {
  console.log(`Ibid API listening on http://${bindHost}:${port}`);
  console.log(staticFiles
    ? `Serving the task pane from ${staticFiles.root}; the API answers under /api.`
    : 'Serving no static files; put a proxy in front, or set IBID_STATIC_DIR to serve the pane from here.');
  // Said once, at startup, so an operator knows where the only files this process writes
  // are going — and can point them somewhere else, or switch them off.
  console.log(documentStore
    ? `Retrieved EUR-Lex documents cached in ${process.env.IBID_CACHE_DIR ?? defaultCacheDirectory()} (${cacheEntries} max).`
    : 'Retrieved EUR-Lex documents cached in memory only; nothing is written to disk.');
  // The second outbound host, named at startup for the same reason the cache directory is:
  // an operator should learn what this process talks to from the process itself.
  console.log(commissionCases
    ? 'Commission decisions read from the Commission’s own open case data; set IBID_COMMISSION_CASE_DATA=off to link the case register instead.'
    : 'Commission citations link to the case register (IBID_COMMISSION_CASE_DATA=off); the cited recital is not retrieved.');
});
