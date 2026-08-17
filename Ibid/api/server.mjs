import http from 'node:http';
import { createEuSourceResolver } from './dist/index.js';

const eurLexHeaders = {};
if (process.env.IBID_EURLEX_API_KEY) eurLexHeaders['X-API-Key'] = process.env.IBID_EURLEX_API_KEY;
if (process.env.IBID_EURLEX_BEARER_TOKEN) eurLexHeaders.Authorization = `Bearer ${process.env.IBID_EURLEX_BEARER_TOKEN}`;
const resolver = createEuSourceResolver({
  cellarBaseUrl: process.env.IBID_EURLEX_CELLAR_BASE_URL,
  userAgent: process.env.IBID_USER_AGENT,
  minRequestIntervalMs: Number(process.env.IBID_EURLEX_MIN_INTERVAL_MS ?? 1000),
  maxRetries: Number(process.env.IBID_EURLEX_MAX_RETRIES ?? 2),
  eurLexHeaders,
});
const port = Number(process.env.IBID_API_PORT ?? 4000);
const allowedOrigin = process.env.IBID_ALLOWED_ORIGIN ?? 'https://localhost:3000';

const server = http.createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  if (requestOrigin === allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (url.pathname === '/health') return response.end(JSON.stringify({ status: 'ok' }));
  if (url.pathname !== '/sources') { response.statusCode = 404; return response.end(JSON.stringify({ error: 'Not found' })); }

  try {
    const lookup = JSON.parse(url.searchParams.get('lookup') ?? '{}');
    if (!lookup.source || !lookup.value) { response.statusCode = 400; return response.end(JSON.stringify({ error: 'A source and citation are required.' })); }
    response.end(JSON.stringify({ documents: await resolver.resolve(lookup) }));
  } catch (error) {
    response.statusCode = 502;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Official-source lookup failed.' }));
  }
});

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Ibid API could not start: port ${port} is already in use. Stop the existing API, or run IBID_API_PORT=${port + 1} npm run dev.`);
  } else {
    console.error('Ibid API could not start:', error);
  }
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => console.log(`Ibid API listening on http://127.0.0.1:${port}`));
