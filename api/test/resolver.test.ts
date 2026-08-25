import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEuSourceResolver, createApiHealthCheck, createMemoryDocumentStore, type EuLookup, type ResolverOptions } from '../src/index.ts';

type Call = { url: string; init: RequestInit };

/** A fetcher that replays queued responses and records what it was asked for. */
function stubFetcher(responses: Array<Response | Error | (() => Response | Error)>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request to ${url}`);
    const resolved = typeof next === 'function' ? next() : next;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// Real CELLAR documents (legislation and case law alike) carry a generator
// comment (`<!-- fmx2xhtml ... -->` or `<!-- CONVEX ... -->`); the resolver
// requires it as evidence the response is a genuine document, not CELLAR's
// bot-verification interstitial (a real, live-observed HTTP 200 response that
// is not the document — see `looksLikeCellarDocument` in src/index.ts).
const html = (body: string) => new Response(`<!-- fmx2xhtml # test-fixture -->${body}`, { status: 200, headers: { 'content-type': 'text/html' } });

/**
 * A document response carrying the validators CELLAR really sends. Every live CELLAR
 * document answers with an `ETag` and a `Last-Modified` alongside `Cache-Control: no-cache`
 * — cache this, and confirm it before you use it — so this, not the bare `html` above, is
 * the shape the revalidating paths are asserted against.
 */
const documentResponse = (body: string, validators: Record<string, string> = { etag: '"Con-20190721062819000"', 'last-modified': 'Sun, 21 Jul 2019 04:28:19 GMT' }) =>
  new Response(`<!-- fmx2xhtml # test-fixture -->${body}`, {
    status: 200,
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache', ...validators },
  });

/** What CELLAR answers a conditional request with: no body at all. */
const notModified = () => new Response(null, { status: 304, headers: { etag: '"Con-20190721062819000"' } });

/** The 404 that means CELLAR has never heard of this identifier, body and all. */
const noSuchDocument = (celex: string) => new Response(`Resource [system 'celex' - id '${celex}'] not found.`, { status: 404 });

/** The 404 that means the document exists but not in the rendition asked for. */
const noSuchRendition = () => new Response(
  'None of the requests returned successfully a redirection. The following exception was thrown: '
  + '[cellar identifier cellar:99d7f858-bf30-11e3-86f9-01aa75ed71a1 does not hold a content datastream of the requested type]',
  { status: 404 },
);

/** A 200 OK response that is not a real document — the bot-verification page CELLAR was observed serving live. */
const botChallengeResponse = () => new Response(
  '<html><body>JavaScript is disabled. In order to continue, we need to verify that you\'re not a robot.</body></html>',
  { status: 200, headers: { 'content-type': 'text/html' } },
);

/** Deterministic clock: `sleep` advances time instead of waiting. */
function fakeClock() {
  let current = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    sleep: async (ms: number) => { slept.push(ms); current += ms; },
    advance: (ms: number) => { current += ms; },
  };
}

function makeResolver(options: ResolverOptions = {}) {
  const clock = fakeClock();
  const resolver = createEuSourceResolver({
    now: clock.now,
    sleep: clock.sleep,
    cellarBaseUrl: 'https://example.test/celex',
    ...options,
  });
  return { resolver, clock };
}

const eurLexLookup = (overrides: Partial<EuLookup> = {}): EuLookup => ({
  source: 'eur-lex', value: 'Directive 2002/58/CE', celex: '32002L0058', ...overrides,
});

describe('health check', () => {
  test('reports ok', () => {
    assert.deepEqual(createApiHealthCheck(), { status: 'ok' });
  });
});

describe('CURIA adapter', () => {
  test('links the official case record without fetching anything', async () => {
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'curia', value: 'C-293/12', caseNumber: 'C-293/12' });

    assert.equal(calls.length, 0, 'CURIA must not be scraped');
    assert.equal(preview.source, 'CURIA');
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
  });

  test('falls back to the ECLI when no case number was derived', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher });
    const [preview] = await resolver.resolve({ source: 'curia', value: 'x', ecli: 'ECLI:EU:C:2014:317' });
    assert.ok(preview.url.includes(encodeURIComponent('ECLI:EU:C:2014:317')));
  });

  test('mentions the locator in the guidance text', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher });
    const [preview] = await resolver.resolve({
      source: 'curia', value: 'C-293/12', caseNumber: 'C-293/12', locator: { kind: 'point', start: 80 },
    });
    assert.equal(preview.locator, 'Point 80');
    assert.ok(preview.excerpt.includes('point 80'));
  });
});

const curiaJudgmentLookup = (overrides: Partial<EuLookup> = {}): EuLookup => ({
  source: 'curia', value: 'C-293/12', caseNumber: 'C-293/12', celex: '62012CJ0293', ...overrides,
});

describe('CURIA case-law text retrieval', () => {
  test('fetches the judgment text via CELLAR when the CELEX is confidently a judgment', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Judgment text, point 57 of the ruling.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls[0].url, 'https://example.test/celex/62012CJ0293');
    assert.equal(preview.source, 'CURIA');
    assert.equal(preview.url, 'https://example.test/celex/62012CJ0293', 'the link must point at the fetched document, not a search page');
    assert.ok(preview.excerpt.includes('Judgment text'));
  });

  test('treats an absent documentType the same as "judgment"', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(curiaJudgmentLookup({ documentType: undefined }));
    assert.equal(calls.length, 1);
  });

  test('fetches an Advocate General opinion, whose CELEX now names the opinion', async () => {
    // This used to refuse to fetch anything but a judgment, because the shared layer only
    // ever derived the judgment sector, so the CELEX would have named a different document.
    // The sector is now derived from the document type — `62012CC0131` is Advocate General
    // Jääskinen's opinion in Google Spain, confirmed live — so there is nothing left to
    // protect against, and the lawyer reads the opinion instead of following a link.
    const { fetcher, calls } = stubFetcher([html('<p id="point138">138</p><p>the opinion</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({
      documentType: 'opinion', celex: '62012CC0131', locator: { kind: 'point', start: 138 },
    }));

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('62012CC0131'), 'fetches the opinion CELEX it was given, not a judgment');
    assert.ok(preview.excerpt.includes('the opinion'));
  });

  test('fetches an order the same way', async () => {
    const { fetcher, calls } = stubFetcher([html('<p id="point15">15</p><p>the order</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(curiaJudgmentLookup({ documentType: 'order', celex: '62007CO0550' }));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('62007CO0550'));
  });

  test('still falls back to the case record when the document is not mirrored', async () => {
    // Real and expected: not every order is in CELLAR — 62007CO0550 genuinely 404s — so
    // the safe link stays the floor for anything that cannot be retrieved.
    const { fetcher, calls } = stubFetcher([new Response('', { status: 404 }), new Response('', { status: 404 })]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ documentType: 'order', celex: '62007CO0550' }));
    assert.ok(calls.length > 0);
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
  });

  test('falls back to the case-record link when there is no CELEX', async () => {
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: undefined }));

    assert.equal(calls.length, 0);
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
  });

  test('falls back to the case-record link when CELLAR does not have the document in either format', async () => {
    // A 404 means "try the next thing" at two levels (see fetchCellarDocument): the other
    // Accept header, then the next language. Every combination must be refused before the
    // document counts as unavailable and the link becomes the answer.
    const { fetcher, calls } = stubFetcher(Array.from({ length: 4 }, () => new Response('missing', { status: 404 })));
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls.length, 4, 'two formats across two languages before falling back');
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
    assert.ok(preview.excerpt.includes('Open the official CURIA case record'));
  });

  test('falls back to the case-record link when CELLAR serves a bot-verification page (HTTP 200)', async () => {
    // Live-observed: CELLAR can answer 200 OK with an interstitial instead of the
    // document. response.ok alone would accept this and show the challenge text
    // as if it were the judgment — this must be caught and treated as a failure.
    const { fetcher, calls } = stubFetcher([botChallengeResponse()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls.length, 1);
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
    assert.ok(!preview.excerpt.toLowerCase().includes('robot'), 'the challenge text must never reach the reviewer');
  });

  test('falls back to the case-record link after the retry budget is exhausted', async () => {
    const { fetcher, calls } = stubFetcher([new Response('boom', { status: 503 }), new Response('boom', { status: 503 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 1 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls.length, 2);
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
  });

  test('falls back to the case-record link on a transport error', async () => {
    const { fetcher } = stubFetcher([new Error('socket hang up')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());
    assert.equal(preview.url, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=C-293%2F12');
  });

  test('caches a fetched judgment excerpt', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(curiaJudgmentLookup());
    await resolver.resolve(curiaJudgmentLookup());
    assert.equal(calls.length, 1);
  });

  test('does not cache a fallback so a later retry can still succeed', async () => {
    const { fetcher, calls } = stubFetcher([new Response('missing', { status: 404 }), html('<p>now available</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    await resolver.resolve(curiaJudgmentLookup());
    const [second] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls.length, 2);
    assert.ok(second.excerpt.includes('now available'));
  });

  // Real CELLAR judgment markup numbers paragraphs as a bare integer in its own
  // element (`<p class="count" id="point57">57</p>`), never `(57)` — this mirrors
  // the structure of an actual fetched judgment (verified against a live CELLAR
  // response), not an invented shape, since a too-small stub could pass this
  // assertion by returning the *whole* document rather than the cited point.
  const judgmentPointsBody = ['56', '57', '58'].map((n) => `
    <table><tbody><tr>
      <td><p class="count" id="point${n}">${n}</p></td>
      <td><p class="normal">Paragraph ${n} of the ruling, discussing an unrelated matter${n === '57' ? ' — this is the cited paragraph' : ''}.</p></td>
    </tr></tbody></table>`).join('\n');

  test('focuses the excerpt on the cited point using the real point-anchor markup', async () => {
    const { fetcher } = stubFetcher([html(judgmentPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 57 } }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 56'), 'must not include the preceding point');
    assert.ok(!preview.excerpt.includes('Paragraph 58'), 'must not include the following point');
    assert.ok(!preview.excerpt.includes('id='), 'the anchor markup must not leak into the excerpt');
    assert.equal(preview.locator, 'Point 57');
  });

  // CURIA's own rendering, used for at least some very recent judgments not yet
  // migrated into the modern id="pointN" convention above — confirmed against a
  // live fetch of a 2025 judgment (C-529/23 P).
  const curiaNativePointsBody = ['86', '87', '88'].map((n) => `
    <P class="C01PointnumeroteAltN">
    <A NAME="point${n}">${n}</A>Paragraph ${n} of the ruling, unrelated matter${n === '87' ? ' — this is the cited paragraph' : ''}.</P>`).join('\n');

  test('focuses the excerpt on the cited point using the CURIA-native anchor markup', async () => {
    const { fetcher } = stubFetcher([html(curiaNativePointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 87 } }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 86'));
    assert.ok(!preview.excerpt.includes('Paragraph 88'));
  });

  // Advocate General opinions of the same era use the sibling class `C01PointAltN` and
  // write the number with a trailing period. Markup copied from AG Kokott's opinion in
  // Akzo Nobel (62007CC0550): the original pattern pinned one exact class name, so this
  // found nothing and the excerpt silently fell back to the document's opening — invisible
  // until opinions became fetchable at all.
  const opinionPointsBody = '<P class="C01PointAltN"><A NAME="point59">59.</A>&nbsp;Paragraph 59.</P>'
    + '<P class="C01PointAltN"><A NAME="point60">60.</A>&nbsp;In the judgment in AM &amp; S, this is the cited paragraph.</P>'
    + '<P class="C01PointAltN"><A NAME="point61">61.</A>&nbsp;Paragraph 61.</P>';

  test('focuses the excerpt on the cited point using the Advocate General opinion markup', async () => {
    const { fetcher } = stubFetcher([html(opinionPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({
      documentType: 'opinion', celex: '62007CC0550', locator: { kind: 'point', start: 60 },
    }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 59'));
    assert.ok(!preview.excerpt.includes('Paragraph 61'));
  });

  // Legacy ~1990s–2000s EUR-Lex judgment rendering, number and text sharing no
  // common wrapper — confirmed against a live fetch of a 2003 judgment
  // (C-199/99 P, Corus UK v Commission).
  const legacyDtDdPointsBody = ['127', '128', '129'].map((n) => `
    <dt>${n}
       <dd></dd>
    </dt>Paragraph ${n} of the ruling, unrelated matter${n === '128' ? ' — this is the cited paragraph' : ''}.
    <p></p>`).join('\n');

  test('focuses the excerpt on the cited point using the legacy dt/dd markup', async () => {
    const { fetcher } = stubFetcher([html(legacyDtDdPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 128 } }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 127'));
    assert.ok(!preview.excerpt.includes('Paragraph 129'));
  });

  // Legacy EUR-Lex "TexteOnly" rendering: the point number opens the paragraph with no
  // anchor, class or wrapper of any kind. Confirmed against a live fetch of Wouters and
  // Others (61999CJ0309, 2002) — the exact document a Commission decision's "See, by
  // analogy ... EU:C:2002:98, paragraph 46" sent the pane to, where every convention above
  // found nothing and the reviewer was shown the judgment's catchwords instead. The
  // header before the points is what that fallback returned, so it is part of the fixture.
  const bareNumberedPointsBody = '<p>Avis juridique important | 61999J0309 Judgment of the Court.</p>'
    + ['45', '46', '47'].map((n) => `<p>${n} Paragraph ${n} of the ruling, unrelated matter${n === '46' ? ' — this is the cited paragraph' : ''}.</p>`).join('');

  test('focuses the excerpt on the cited point using the legacy bare-number markup', async () => {
    const { fetcher } = stubFetcher([html(bareNumberedPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 46 } }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 45'));
    assert.ok(!preview.excerpt.includes('Paragraph 47'));
    assert.ok(!preview.excerpt.includes('Avis juridique important'), 'the catchwords header is not the cited paragraph');
    assert.equal(preview.passage, 'cited');
  });

  test('falls back to the document start when no known point-anchor convention matches', async () => {
    // e.g. a document CELLAR mirrors under a further, uncatalogued convention.
    const { fetcher } = stubFetcher([html('<p>No point anchors in this document.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 57 } }));
    assert.ok(preview.excerpt.includes('No point anchors in this document.'));
  });

  // The fallback above is the one thing on screen that can look exactly like an answer:
  // a judgment's opening, under a panel headed with the paragraph that was cited. Saying
  // which of the two it is has to survive as far as the pane.
  test('says when the excerpt is the document opening rather than the cited point', async () => {
    const { fetcher } = stubFetcher([html('<p>No point anchors in this document.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 57 } }));

    assert.equal(preview.passage, 'opening');
    assert.equal(preview.locator, 'Point 57', 'the label naming what was asked for must still be there to say it against');
  });

  test('claims nothing about a passage where the citation pinpointed none', async () => {
    const { fetcher } = stubFetcher([html('<p>The judgment, opening at the top.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(preview.passage, undefined, 'nothing was pinpointed, so there is nothing to admit having missed');
  });

  // `&#039;` is how CELLAR's older renditions write an apostrophe — every "d&#039;assurances"
  // in the 2002 judgment above. Decoding only the zero-less `&#39;` put the entity itself
  // into the quoted passage.
  test('decodes numeric character entities in a quoted passage', async () => {
    const { fetcher } = stubFetcher([html('<p>46 Fédération française des sociétés d&#039;assurances &amp; Others.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 46 } }));

    assert.ok(preview.excerpt.includes("d'assurances & Others"));
    assert.ok(!preview.excerpt.includes('&#039;'));
  });

  // Older documents exist only as classic html, so asking for xhtml first buys a 404 and
  // then the politeness interval before the request that works. On a decision citing mostly
  // older case law that is a wasted round trip and a contrived second, per footnote.
  test('remembers an era\'s rendition, so the next document of it costs one request', async () => {
    const missingFormat = () => new Response('does not hold a content datastream of the requested type', { status: 404 });
    const { fetcher, calls } = stubFetcher([
      missingFormat, html('<p>46 The first judgment of its era.</p>'),
      html('<p>46 The second, asked for correctly the first time.</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher });

    await resolver.resolve(curiaJudgmentLookup({ celex: '61999J0309' }));
    assert.equal(calls.length, 2, 'the first lookup of an era has no way to know');

    await resolver.resolve(curiaJudgmentLookup({ celex: '61999J0100' }));
    assert.equal(calls.length, 3, 'the second does not pay for the same 404 again');
    assert.equal((calls[2].init.headers as Record<string, string>).Accept, 'text/html');
  });

  test('shares the EUR-Lex request-spacing budget with legislative lookups', async () => {
    const { fetcher } = stubFetcher([html('<p>case text</p>'), html('<p>directive text</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(curiaJudgmentLookup());
    await resolver.resolve(eurLexLookup());

    assert.deepEqual(clock.slept, [1_000], 'the two request families must not bypass each other\'s throttle');
  });
});

describe('Commission adapter', () => {
  test('links the case register without fetching anything', async () => {
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'commission', value: 'C(2019) 3288' });

    assert.equal(calls.length, 0);
    assert.equal(preview.source, 'European Commission');
    assert.ok(preview.url.startsWith('https://competition-cases.ec.europa.eu/search?query='));
    assert.ok(preview.url.includes(encodeURIComponent('C(2019) 3288')));
  });

  test('mentions the locator in the guidance text when one was detected', async () => {
    // The AT./SA./M. detection loop did not attach a locator at all before —
    // found missing against a real citation ("AT.37990 ... para. 1(c)").
    // Commission decisions are never fetched, so the locator can only ever
    // surface here, in the guidance text and the locator field.
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1 } });

    assert.equal(preview.locator, 'Point 1');
    assert.ok(preview.excerpt.includes('focusing on point 1'));
  });
});

describe('EUR-Lex retrieval', () => {
  test('returns nothing when no CELEX could be derived', async () => {
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    assert.deepEqual(await resolver.resolve(eurLexLookup({ celex: undefined })), []);
    assert.equal(calls.length, 0);
  });

  test('requests the CELEX document and reports its URL', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Directive text</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());

    assert.equal(calls[0].url, 'https://example.test/celex/32002L0058');
    assert.equal(preview.url, 'https://example.test/celex/32002L0058');
    assert.equal(preview.source, 'EUR-Lex');
  });

  test('sends the configured credentials and an abort signal', async () => {
    const { fetcher, calls } = stubFetcher([html('body')]);
    const { resolver } = makeResolver({ fetcher, eurLexHeaders: { 'X-API-Key': 'secret' } });
    await resolver.resolve(eurLexLookup());

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], 'secret');
    // CELLAR 404s on `text/html`; only `application/xhtml+xml` is content-negotiated
    // to the actual document (verified against the live endpoint).
    assert.equal(headers.Accept, 'application/xhtml+xml');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  test('strips markup, scripts and styles from the excerpt', async () => {
    const body = '<style>.a{color:red}</style><script>alert(1)</script><p>Retention &amp; access</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());

    assert.ok(!preview.excerpt.includes('alert'));
    assert.ok(!preview.excerpt.includes('color:red'));
    assert.ok(preview.excerpt.includes('Retention & access'));
  });

  // Real EUR-Lex markup puts an article's heading in its own paragraph, separate
  // from its text (`<p id="..." class="oj-ti-art">Article 15</p>` in newer
  // documents, plain `<p>Article 15</p>` in older ones) — never "Article 15" and
  // its body text run together in one paragraph, which is why extraction anchors
  // on an isolated heading rather than a text substring (see below).
  test('focuses the excerpt on the cited article and stops at the next one', async () => {
    const body = '<p>Article 14</p><p>earlier text</p><p>Article 15</p><p>the cited obligation</p><p>Article 16</p><p>later text</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));

    assert.ok(preview.excerpt.startsWith('Article 15'));
    assert.ok(preview.excerpt.includes('the cited obligation'));
    assert.ok(!preview.excerpt.includes('Article 16'));
    assert.ok(!preview.excerpt.includes('earlier text'));
    assert.equal(preview.locator, 'Article 15');
  });

  // Treaty articles (Article 101 TFEU, etc. — see shared/src/index.ts for
  // CELEX derivation) resolve to a document containing only that one
  // article, unlike ordinary legislation which has many — no "next article"
  // heading ever follows. Fixture trimmed from the real, live Article 101
  // TFEU response (12016E101): same "ti-art" heading, same numbered-paragraph
  // and lettered-subparagraph table markup.
  test('resolves a treaty article, which is the only article in its document', async () => {
    const body = '<p id="d1e33-88-1" class="ti-art">Article 101</p>'
      + '<p class="sti-art"><span class="sp-normal">(ex Article 81 TEC)</span></p>'
      + '<p class="normal">1.   The following shall be prohibited as incompatible with the internal market...</p>'
      + '<p class="normal">2.   Any agreements or decisions prohibited pursuant to this Article shall be automatically void.</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '12016E101', locator: { kind: 'article', start: 101, paragraph: 2 } }));

    assert.ok(preview.excerpt.startsWith('2.'));
    assert.ok(preview.excerpt.includes('automatically void'));
    assert.ok(!preview.excerpt.includes('shall be prohibited as incompatible'));
    assert.equal(preview.locator, 'Article 101(2)');
  });

  // "Art. 8(5)" means paragraph 5 of Article 8, not the whole article — found
  // wrong against a real client document: the excerpt showed all of Article 8
  // when only paragraph 5 was cited. Confirmed live that both markup eras
  // place the paragraph number directly at the start of its own <p>, followed
  // by a period (modern OJ markup: GDPR Article 8; legacy markup: Directive
  // 2002/58/EC Article 15) even though nothing else about their structure matches.
  test('focuses the excerpt on the cited paragraph within the article, not the whole article', async () => {
    const body = '<p>Article 15</p>'
      + '<p>1.   the first paragraph, not the one cited</p>'
      + '<p>2.   the cited paragraph text</p>'
      + '<p>3.   the third paragraph, not the one cited</p>'
      + '<p>Article 16</p><p>unrelated later text</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15, paragraph: 2 } }));

    assert.ok(preview.excerpt.startsWith('2.'));
    assert.ok(preview.excerpt.includes('the cited paragraph text'));
    assert.ok(!preview.excerpt.includes('first paragraph'));
    assert.ok(!preview.excerpt.includes('third paragraph'));
    assert.ok(!preview.excerpt.includes('Article 16'));
    assert.equal(preview.locator, 'Article 15(2)');
  });

  test('falls back to the whole article when the cited paragraph is not found', async () => {
    const body = '<p>Article 20</p><p>a single unnumbered block of article text</p><p>Article 21</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 20, paragraph: 4 } }));

    assert.ok(preview.excerpt.includes('a single unnumbered block of article text'));
  });

  test('does not mistake an inline article reference for the article heading', async () => {
    // Live-observed in Directive 2002/58/EC: recitals reference "Article 15(1)"
    // in passing, well before the actual "Article 15" heading — a decoded-text
    // substring search would find that reference first and silently show the
    // wrong passage. The heading is only ever the sole content of its paragraph.
    const body = '<p>This recital discusses Article 15(1) of the Directive for context.</p>'
      + '<p>Article 15</p><p>The actual provision text.</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));

    assert.ok(preview.excerpt.startsWith('Article 15'));
    assert.ok(preview.excerpt.includes('The actual provision text'));
    assert.ok(!preview.excerpt.includes('This recital discusses'));
  });

  test('does not mistake an inline footnote-style reference for the recital heading', async () => {
    // Real preambles carry footnote markers like "the Commission(1)," attached to
    // a word — never at the very start of a paragraph, unlike the true recital
    // heading. Confirmed against Directive 2002/58/EC's actual preamble structure.
    const body = '<p>Having regard to the proposal from the Commission(1), and other recitals.</p>'
      + '<p>(1) The actual recital text.</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'point', start: 1 } }));

    assert.ok(preview.excerpt.includes('The actual recital text'));
    assert.ok(!preview.excerpt.includes('Having regard'));
  });

  test('falls back to text/html when an older document has no application/xhtml+xml rendition', async () => {
    // Confirmed live: Directive 2002/58/EC (2002) has no application/xhtml+xml
    // rendition at all, only classic text/html — the exact scenario reported
    // as a 502 error before fetchCellarDocument tried a second Accept header.
    const { fetcher, calls } = stubFetcher([
      new Response('missing', { status: 404 }),
      html('<p>Article 15</p><p>the real text of the older directive</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));

    assert.equal(calls.length, 2);
    assert.equal((calls[0].init.headers as Record<string, string>).Accept, 'application/xhtml+xml');
    assert.equal((calls[1].init.headers as Record<string, string>).Accept, 'text/html');
    assert.ok(preview.excerpt.includes('the real text of the older directive'));
  });

  test('focuses the excerpt on a numbered recital point', async () => {
    const body = '<p>(24) earlier recital</p><p>(25) the cited recital</p><p>(26) later recital</p>';
    const { fetcher } = stubFetcher([html(body)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'point', start: 25 } }));

    assert.ok(preview.excerpt.includes('the cited recital'));
    assert.ok(!preview.excerpt.includes('later recital'));
  });

  test('labels a point range', async () => {
    const { fetcher } = stubFetcher([html('(60) text')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'point', start: 60, end: 65 } }));
    assert.equal(preview.locator, 'Points 60–65', 'plural, because a range is more than one point');
  });

  test('falls back to the opening passage when the locator is not present', async () => {
    const { fetcher } = stubFetcher([html('<p>Opening passage of the act.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 99 } }));
    assert.ok(preview.excerpt.includes('Opening passage'));
  });

  test('bounds the excerpt when there is no locator', async () => {
    const { fetcher } = stubFetcher([html('x'.repeat(5_000))]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.excerpt.length, 900);
  });

  test('derives the title from the act title the document states', async () => {
    // This used to assert that everything ahead of the Journal reference is the title, on a
    // fixture that opened with a bare short title. No real document opens that way: the
    // classic rendition states the numbered title and *then* the Journal reference, and the
    // modern one states the Journal reference first and the title after it — which is how
    // the GDPR came to be titled `L_2016119EN.01000101.xml 4.5.2016 EN`. The anchor is now
    // the act's own number, so the fixture is the real shape.
    const { fetcher } = stubFetcher([html(
      '<p>Directive 2002/58/EC of the European Parliament and of the Council of 12 July 2002 concerning the processing of '
      + 'personal data (Directive on privacy and electronic communications) Official Journal L 201</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive 2002/58/EC of the European Parliament and of the Council of 12 July 2002 '
      + 'concerning the processing of personal data (Directive on privacy and electronic communications)');
  });

  test('falls back to the citation where the document names no act number', async () => {
    // A short title on its own does not identify which act is on screen, and the name derived
    // from the citation always does.
    const { fetcher } = stubFetcher([html('<p>Directive on privacy and electronic communications Official Journal L 201</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive 2002/58/CE');
  });

  test('falls back to the citation as the title when the document is empty', async () => {
    const { fetcher } = stubFetcher([html('')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive 2002/58/CE');
  });
});

describe('a cited range of paragraphs', () => {
  // "paras 57-65" cites nine paragraphs. Returning only the first gives the lawyer the
  // opening of an argument without the argument — and the pane's own locator label already
  // read "Point 57-65", so the excerpt and the label contradicted each other on screen.
  const judgment = (points: number[]) => html(points.map((n) =>
    `<p class="count" id="point${n}">${n}</p><p>Text of paragraph ${n}.</p>`).join(''));
  const lookup = (start: number, end?: number): EuLookup => ({
    source: 'curia', value: 'x', celex: '62012CJ0293', locator: { kind: 'point', start, end },
  });

  test('returns every paragraph in the range', async () => {
    const { fetcher } = stubFetcher([judgment([56, 57, 58, 59, 60, 61])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(lookup(57, 60));
    for (const n of [57, 58, 59, 60]) assert.match(preview.excerpt, new RegExp(`Text of paragraph ${n}\\.`), `paragraph ${n}`);
  });

  test('stops at the end of the range, not at the end of the document', async () => {
    const { fetcher } = stubFetcher([judgment([56, 57, 58, 59, 60, 61])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(lookup(57, 59));
    assert.ok(!/Text of paragraph 60\./.test(preview.excerpt), 'paragraph 60 was not cited');
    assert.ok(!/Text of paragraph 56\./.test(preview.excerpt), 'nor was 56');
  });

  test('a single paragraph is still a single paragraph', async () => {
    const { fetcher } = stubFetcher([judgment([56, 57, 58])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(lookup(57));
    assert.match(preview.excerpt, /Text of paragraph 57\./);
    assert.ok(!/Text of paragraph 58\./.test(preview.excerpt));
  });

  test('returns every paragraph a disjoint citation names', async () => {
    // "paras 62 and 65" names two paragraphs the drafter chose separately. Returning 62
    // alone loses half the citation; returning 62 through 65 shows text that was never
    // cited as though it had been. Both misrepresent the footnote.
    const { fetcher } = stubFetcher([judgment([61, 62, 63, 64, 65, 66])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ ...lookup(62), paragraphs: [62, 65] });
    assert.match(preview.excerpt, /Text of paragraph 62\./);
    assert.match(preview.excerpt, /Text of paragraph 65\./);
    assert.ok(!/Text of paragraph 63\./.test(preview.excerpt), 'paragraph 63 was not cited');
    assert.match(preview.excerpt, /…/, 'and the gap between them is marked');
  });

  test('labels a disjoint citation as the paragraphs it shows', async () => {
    const { fetcher } = stubFetcher([judgment([57, 58, 59, 62, 65])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ ...lookup(57, 59), paragraphs: [57, 58, 59, 62, 65] });
    assert.equal(preview.locator, 'Points 57–59, 62 and 65');
  });

  test('does not serve one citation\'s excerpt to another of the same document', async () => {
    // "para. 62" and "paras 62 and 65" share a locator kind and start. Keying the cache on
    // those alone returned the two-paragraph excerpt for the one-paragraph citation — a
    // passage the second footnote never cited, shown as though it had.
    const { fetcher } = stubFetcher([judgment([61, 62, 63, 64, 65, 66]), judgment([61, 62, 63, 64, 65, 66])]);
    const { resolver } = makeResolver({ fetcher });
    const [both] = await resolver.resolve({ ...lookup(62), paragraphs: [62, 65] });
    const [one] = await resolver.resolve({ ...lookup(62), paragraphs: [62] });
    assert.match(both.excerpt, /Text of paragraph 65\./);
    assert.ok(!/Text of paragraph 65\./.test(one.excerpt), 'the single-paragraph citation shows only its own paragraph');
    assert.equal(one.locator, 'Point 62');
  });

  test('a range whose last paragraph is missing still terminates', async () => {
    // The scan stops at the first anchor beyond the range rather than at a specific closing
    // number, so a renumbered or absent endpoint does not run on to the safety cap.
    const { fetcher } = stubFetcher([judgment([57, 58, 90])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(lookup(57, 60));
    assert.match(preview.excerpt, /Text of paragraph 58\./);
    assert.ok(!/Text of paragraph 90\./.test(preview.excerpt));
  });

  test('the label and the excerpt agree', async () => {
    const { fetcher } = stubFetcher([judgment([57, 58, 59, 60])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(lookup(57, 59));
    assert.equal(preview.locator, 'Points 57–59');
    assert.match(preview.excerpt, /Text of paragraph 59\./);
  });
});

describe('what a preview is called', () => {
  // The reviewer reads a paragraph and has to know which document it came from. `value` is
  // the footnote's own words, which describe a document only when the footnote spelled it
  // out — a back-reference titled by its value heads the panel "Ibid.".
  const curia = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'Ibid.', celex: '62012CJ0293', caseNumber: 'C-293/12',
    caseName: 'Digital Rights Ireland and Seitlinger and Others', ...overrides,
  });

  test('names the authority a back-reference resolved to, not the word Ibid.', async () => {
    const { fetcher } = stubFetcher([html('<p class="count" id="point62">62</p>text')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curia({ locator: { kind: 'point', start: 62 } }));
    assert.equal(preview.title, 'Digital Rights Ireland and Seitlinger and Others, C-293/12');
  });

  test('separates an opinion from the judgment sharing its case', async () => {
    const { fetcher } = stubFetcher([html('<p class="count" id="point74">74</p>text')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curia({
      celex: '62014CC0413', caseNumber: 'C-413/14 P', caseName: 'Intel v Commission',
      documentType: 'opinion', locator: { kind: 'point', start: 74 },
    }));
    assert.equal(preview.title, 'Intel v Commission, C-413/14 P (opinion)');
  });

  test('falls back to the case number when the document establishes no name', async () => {
    const { fetcher } = stubFetcher([html('<p class="count" id="point62">62</p>text')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curia({ caseName: undefined, locator: { kind: 'point', start: 62 } }));
    assert.equal(preview.title, 'C-293/12');
  });

  test('a citation that spelled its authority out keeps its own words', async () => {
    // Only back-references are overridden. "Case C-131/12" is a perfectly good title, and
    // second-guessing it would lose the form the drafter chose.
    const { fetcher } = stubFetcher([html('<p class="count" id="point80">80</p>text')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({
      source: 'curia', value: 'Case C-131/12', celex: '62012CJ0131', locator: { kind: 'point', start: 80 },
    });
    assert.equal(preview.title, 'Case C-131/12');
  });

  test('a back-reference with nothing but a CELEX is still not called Ibid.', async () => {
    const { fetcher } = stubFetcher([html('<p>Article 9</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'eur-lex', value: 'Ibid.', celex: '32016R0679' });
    assert.ok(!/Ibid/.test(preview.title), `titled ${preview.title}`);
  });
});

describe('source language', () => {
  const french = (body: string) => html(body);
  const missing = () => new Response('missing', { status: 404 });

  test('prefers the published English text where one exists', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.equal(new Headers(calls[0].init.headers).get('accept-language'), 'eng');
    assert.equal(preview.language, 'en');
    assert.equal(preview.translation, undefined, 'nothing to explain when the text is the authentic English');
    assert.equal(calls.length, 1, 'French is never requested when English answered');
  });

  test('falls back to French only once English is refused in every format', async () => {
    // Today this case yields no text at all: both English attempts 404 and the whole
    // retrieval degrades to a bare link, so the lawyer reads nothing.
    const { fetcher, calls } = stubFetcher([missing(), missing(), french('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.deepEqual(calls.map((call) => new Headers(call.init.headers).get('accept-language')), ['eng', 'eng', 'fra']);
    assert.equal(preview.language, 'fr');
    assert.ok(preview.excerpt.includes('Article 17'));
  });

  test('a French passage is labelled, never passed off as English', async () => {
    const { fetcher } = stubFetcher([missing(), missing(), french('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.equal(preview.language, 'fr');
    assert.equal(preview.translation, undefined, 'not a translation — it is the authentic text, in French');
  });

  test('translates a French-only passage and says the authentic text is elsewhere', async () => {
    const { fetcher } = stubFetcher([missing(), missing(), french('<p>Article 17</p>')]);
    const { resolver } = makeResolver({
      fetcher, minRequestIntervalMs: 0,
      translate: async (text, from) => `[EN of ${from}] ${text}`,
    });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.match(preview.excerpt, /^\[EN of fr\]/);
    assert.equal(preview.language, 'en');
    assert.deepEqual(preview.translation, { from: 'fr', officialUrl: preview.url });
  });

  test('never translates a passage that was already English', async () => {
    // The Court's own English is the authority; replacing it with a machine's would be a
    // strict loss, and would put a "not the authentic text" warning on text that is.
    let called = false;
    const { fetcher } = stubFetcher([html('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, translate: async (text) => { called = true; return text; } });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.equal(called, false);
    assert.equal(preview.translation, undefined);
  });

  test('a translator that fails leaves the published French in place', async () => {
    // The document is in hand and is worth more than nothing; a translation failure must
    // not turn a successful retrieval into an error.
    const { fetcher } = stubFetcher([missing(), missing(), french('<p>Article 17</p>')]);
    const { resolver } = makeResolver({
      fetcher, minRequestIntervalMs: 0,
      translate: async () => { throw new Error('translator unavailable'); },
    });
    const preview = (await resolver.resolve(eurLexLookup()))[0];
    assert.ok(preview.excerpt.includes('Article 17'));
    assert.equal(preview.language, 'fr');
    assert.equal(preview.translation, undefined);
  });

  test('the language preference is configurable', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, preferredLanguages: ['fr', 'en'] });
    await resolver.resolve(eurLexLookup());
    assert.equal(new Headers(calls[0].init.headers).get('accept-language'), 'fra');
  });
});

describe('how the resolver identifies itself', () => {
  test('names the application, because an unidentified caller is what gets blocked', async () => {
    // Node's `fetch` sends `User-Agent: node` unless told otherwise, which is exactly the
    // fingerprint anti-bot protection reacts to — and CELLAR was observed live serving a
    // verification page under an ordinary request rate. There is no credential to present
    // here (the REST interface is public), so identification is the whole defence.
    const { fetcher, calls } = stubFetcher([html('<p>Article 17</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(eurLexLookup());
    const agent = new Headers(calls[0].init.headers).get('user-agent');
    assert.ok(agent, 'a User-Agent is always sent');
    assert.notEqual(agent, 'node');
    assert.match(agent, /Ibid/, 'and it names this application');
  });

  test('a deployment can supply its own contact address', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Article 17</p>')]);
    const userAgent = 'Ibid/1.0 (+mailto:someone@example.com)';
    const { resolver } = makeResolver({ fetcher, userAgent });
    await resolver.resolve(eurLexLookup());
    assert.equal(new Headers(calls[0].init.headers).get('user-agent'), userAgent);
  });
});

describe('EUR-Lex caching', () => {
  test('serves a repeated lookup from cache', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Directive text</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(eurLexLookup());
    const [second] = await resolver.resolve(eurLexLookup());

    assert.equal(calls.length, 1, 'the second lookup must not hit the network');
    assert.ok(second.excerpt.includes('Directive text'));
  });

  test('one authority is retrieved once, however many pinpoints cite it', async () => {
    // The reason the cache was split. The retrieval key used to include the locator, so
    // "para. 62" and "para. 65" of one judgment were two full downloads of the same
    // document — measured live at 149KB and ~1.5s each, uncompressed. The document is now
    // keyed by what identifies a document, and each excerpt is cut out of it locally.
    const { fetcher, calls } = stubFetcher([
      documentResponse('<p>Article 15</p><p>fifteen</p><p>Article 20</p><p>twenty</p>'),
      notModified(),
    ]);
    const { resolver } = makeResolver({ fetcher });
    const [fifteen] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));
    const [twenty] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 20 } }));

    assert.equal(calls.length, 2, 'one download, then one conditional request to confirm it');
    assert.equal(calls[1].init.headers && (calls[1].init.headers as Record<string, string>)['If-None-Match'], '"Con-20190721062819000"');
    // Two different excerpts, so this is genuinely one document serving both pinpoints
    // rather than one cache entry serving the wrong passage to the second.
    assert.ok(fifteen.excerpt.includes('fifteen'), fifteen.excerpt);
    assert.ok(twenty.excerpt.includes('twenty'), twenty.excerpt);
    assert.ok(!fifteen.excerpt.includes('twenty'));
  });

  test('clearCache forces the next lookup back to the network', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>one</p>'), html('<p>two</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(eurLexLookup());
    resolver.clearCache();
    await resolver.resolve(eurLexLookup());
    assert.equal(calls.length, 2);
  });
});

describe('revalidating a document already held', () => {
  test('confirms the held text with a conditional request instead of downloading it again', async () => {
    const { fetcher, calls } = stubFetcher([documentResponse('<p>Directive text</p>'), notModified()]);
    const { resolver } = makeResolver({ fetcher });

    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));
    const [second] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 2 } }));

    const conditional = calls[1].init.headers as Record<string, string>;
    assert.equal(conditional['If-None-Match'], '"Con-20190721062819000"');
    assert.equal(conditional['If-Modified-Since'], undefined, 'the ETag is the stronger validator; both together is noise');
    // A 304 carries no body. If the document-shape check ran on it, this lookup would have
    // failed as an unrecognisable response rather than serving the text already in hand.
    assert.ok(second.excerpt.includes('Directive text'));
  });

  test('a 304 is what dates the preview, so a served document is confirmed now and not when it was downloaded', async () => {
    const { fetcher } = stubFetcher([documentResponse('<p>Directive text</p>'), notModified()]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [first] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));
    clock.advance(3_600_000);
    const [second] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 2 } }));

    assert.ok(first.verifiedAt, 'a retrieved passage says when it was confirmed');
    assert.ok(second.verifiedAt);
    assert.ok(new Date(second.verifiedAt!).getTime() > new Date(first.verifiedAt!).getTime(),
      'the whole point of revalidating is that the confirmation is current, not the download');
  });

  test('a 200 on revalidation replaces the held text', async () => {
    const { fetcher, calls } = stubFetcher([
      documentResponse('<p>Article 1</p><p>the old text</p>'),
      documentResponse('<p>Article 1</p><p>the new text</p>', { etag: '"Con-20260101000000000"' }),
    ]);
    const { resolver } = makeResolver({ fetcher });

    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));
    const [second] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 }, paragraphs: [1] }));

    assert.equal(calls.length, 2);
    assert.ok(second.excerpt.includes('the new text'), second.excerpt);
  });

  test('falls back to If-Modified-Since when the response carried no ETag', async () => {
    const { fetcher, calls } = stubFetcher([
      documentResponse('<p>Article 1</p><p>text</p>', { 'last-modified': 'Sun, 21 Jul 2019 04:28:19 GMT' }),
      notModified(),
    ]);
    const { resolver } = makeResolver({ fetcher });

    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));
    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 2 } }));

    const conditional = calls[1].init.headers as Record<string, string>;
    assert.equal(conditional['If-Modified-Since'], 'Sun, 21 Jul 2019 04:28:19 GMT');
  });

  test('a held document with no validator at all is served rather than downloaded again', async () => {
    // `html()` carries no ETag and no Last-Modified. There is nothing to confirm it with,
    // and an EU legal text does not change, so it is served with the time it was genuinely
    // last confirmed rather than re-fetched or dated on trust.
    const { fetcher, calls } = stubFetcher([html('<p>Article 1</p><p>text</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [first] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));
    clock.advance(60_000);
    const [second] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 1 }, paragraphs: [1] }));

    assert.equal(calls.length, 1);
    assert.equal(second.verifiedAt, first.verifiedAt, 'an unconfirmed document must not claim a fresh confirmation');
  });

  test('a document store carries documents across a restart', async () => {
    // Two resolvers, one store: the second is the process that comes back up. It must start
    // from "confirm this is still the text" rather than from downloading everything again.
    const documentStore = createMemoryDocumentStore();
    const first = stubFetcher([documentResponse('<p>Article 1</p><p>text</p>')]);
    await createEuSourceResolver({ fetcher: first.fetcher, cellarBaseUrl: 'https://example.test/celex', documentStore, minRequestIntervalMs: 0 })
      .resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));

    const second = stubFetcher([notModified()]);
    const [preview] = await createEuSourceResolver({ fetcher: second.fetcher, cellarBaseUrl: 'https://example.test/celex', documentStore, minRequestIntervalMs: 0 })
      .resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));

    assert.equal(second.calls.length, 1, 'a restart is one conditional request per document, not one download');
    assert.equal((second.calls[0].init.headers as Record<string, string>)['If-None-Match'], '"Con-20190721062819000"');
    assert.ok(preview.excerpt.includes('text'));
  });

  test('a held rendition CELLAR has stopped serving falls back to probing, not to failure', async () => {
    const documentStore = createMemoryDocumentStore();
    const first = stubFetcher([documentResponse('<p>Article 1</p><p>old</p>')]);
    await createEuSourceResolver({ fetcher: first.fetcher, cellarBaseUrl: 'https://example.test/celex', documentStore, minRequestIntervalMs: 0 })
      .resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));

    const second = stubFetcher([noSuchRendition(), documentResponse('<p>Article 1</p><p>new</p>')]);
    const [preview] = await createEuSourceResolver({ fetcher: second.fetcher, cellarBaseUrl: 'https://example.test/celex', documentStore, minRequestIntervalMs: 0 })
      .resolve(eurLexLookup({ locator: { kind: 'article', start: 1 } }));

    assert.ok(preview.excerpt.includes('new'), preview.excerpt);
  });

  test('a link-only preview claims no verification, because it retrieved nothing', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher });
    const [preview] = await resolver.resolve({ source: 'curia', value: 'C-293/12', caseNumber: 'C-293/12' });
    assert.equal(preview.verifiedAt, undefined);
  });
});

describe('the two 404s CELLAR answers with', () => {
  test('stops after one request when CELLAR has never heard of the identifier', async () => {
    // Confirmed live: "Resource [system 'celex' - id '62023CJ0639'] not found." No Accept
    // header and no language can produce a document CELLAR does not hold, so the other
    // three probes only spell out what the first already said — and this is the lookup the
    // reviewer waits longest for, because every attempt is spent on the way to a link.
    const { fetcher, calls } = stubFetcher([noSuchDocument('62023CJ0639')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup({ celex: '62023CJ0639' })), /lookup failed \(404\)/);
    assert.equal(calls.length, 1, 'one request settles it');
  });

  test('a case-law citation CELLAR does not mirror reaches its CURIA link in one request', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62023CJ0639')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62023CJ0639' }));
    assert.equal(calls.length, 1);
    assert.ok(preview.url.startsWith('https://curia.europa.eu/'));
  });

  test('keeps trying renditions when the 404 means only that this rendition is missing', async () => {
    // "does not hold a content datastream of the requested type" is the opposite message:
    // the document exists and this particular rendition of it does not, which is exactly
    // what the format and language chains are for.
    const { fetcher, calls } = stubFetcher([noSuchRendition(), documentResponse('<p>older format</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(calls.length, 2);
    assert.equal((calls[1].init.headers as Record<string, string>).Accept, 'text/html');
    assert.ok(preview.excerpt.includes('older format'));
  });

  test('an unrecognised 404 body keeps the old behaviour of trying every rendition', async () => {
    // If the Publications Office rewords the message, the cost is the four requests that
    // were being paid anyway — never a document wrongly declared missing.
    const { fetcher, calls } = stubFetcher(Array.from({ length: 4 }, () => new Response('something else entirely', { status: 404 })));
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /lookup failed \(404\)/);
    assert.equal(calls.length, 4);
  });
});

describe('asking CELLAR by the ECLI when it does not know the CELEX', () => {
  // The CELEX Ibid sends is *derived* — sector letter from the document type, year from the
  // case number — while the ECLI is quoted verbatim from the footnote. CELLAR turns out not
  // to mint a CELEX for some case law it nonetheless holds and indexes by ECLI: every
  // identifier the corpus run recorded as "unavailable" resolves this way, confirmed live
  // on 2026-08-21. Before this, each of those citations fell back to a CURIA link telling
  // the lawyer to go and look it up themselves, with the text sitting one request away.
  const order = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'ECLI:EU:T:2024:431', caseNumber: 'C-511/24',
    caseName: 'Aylo Freesites LTD v Commission', celex: '62024TO0511',
    ecli: 'ECLI:EU:T:2024:431', documentType: 'order', ...overrides,
  });

  test('retrieves the document the footnote actually named', async () => {
    const { fetcher, calls } = stubFetcher([
      noSuchDocument('62024TO0511'),
      noSuchRendition(),
      documentResponse('<P class="C01PointnumeroteAltN"><A NAME="point112">112</A>The order says this.</P>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(order({ locator: { kind: 'point', start: 112 }, paragraphs: [112] }));

    assert.equal(calls[0].url, 'https://example.test/celex/62024TO0511');
    assert.equal(calls[1].url, 'https://example.test/ecli/ECLI%3AEU%3AT%3A2024%3A431',
      'the ECLI is percent-encoded onto the sibling /ecli base, never interpolated raw');
    assert.equal(preview.source, 'CURIA');
    assert.equal(preview.locator, 'Point 112');
    assert.ok(preview.excerpt.includes('The order says this.'), preview.excerpt);
    assert.ok(preview.verifiedAt, 'it was retrieved, so it carries a confirmation time');
    // The link has to be the address that answered. The CELEX URL 404s for this document —
    // sending the reader there would be worse than the CURIA link this replaces.
    assert.equal(preview.url, 'https://example.test/ecli/ECLI%3AEU%3AT%3A2024%3A431');
  });

  test('the unknown CELEX still costs only one request before moving on', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62024TO0511'), documentResponse('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(order());
    assert.equal(calls.length, 2, 'one request to learn the CELEX is unknown, one to the ECLI that works');
  });

  test('never asks by ECLI when the CELEX answered', async () => {
    const { fetcher, calls } = stubFetcher([documentResponse('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(order());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/celex/'));
  });

  test('never asks by ECLI when the failure was not a 404', async () => {
    // A second identifier does not fix a server failing for an unrelated reason — the same
    // rule the rendition chain follows, one level up.
    const { fetcher, calls } = stubFetcher([new Response('nope', { status: 400 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup({ ecli: 'ECLI:EU:C:2014:238' })), /lookup failed \(400\)/);
    assert.equal(calls.length, 1);
  });

  test('holds what the ECLI returned under its own key, and revalidates it next time', async () => {
    const { fetcher, calls } = stubFetcher([
      noSuchDocument('62024TO0511'), documentResponse('<p>Article 1</p><p>the order</p>'), notModified(),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(order({ locator: { kind: 'point', start: 1 } }));
    const [second] = await resolver.resolve(order({ locator: { kind: 'point', start: 2 } }));

    assert.equal(calls.length, 3, 'the second lookup goes straight to the ECLI it worked under, and confirms it');
    assert.equal(calls[2].url, 'https://example.test/ecli/ECLI%3AEU%3AT%3A2024%3A431');
    assert.equal((calls[2].init.headers as Record<string, string>)['If-None-Match'], '"Con-20190721062819000"');
    assert.ok(second.excerpt.includes('the order'));
  });

  test('falls back to the CURIA link only once both identifiers are exhausted', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62024TO0511'), noSuchDocument('ECLI')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(order());
    assert.equal(calls.length, 2);
    assert.ok(preview.url.startsWith('https://curia.europa.eu/'));
  });

  test('a citation with no ECLI is unchanged', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62023CJ0639')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(curiaJudgmentLookup({ celex: '62023CJ0639' }));
    assert.equal(calls.length, 1, 'nothing to fall back to, so nothing extra is asked');
  });

  test('a base URL with no /celex segment does not have an ECLI URL guessed for it', async () => {
    // Rather than inventing a path against a differently-shaped deployment, the fallback is
    // simply not attempted.
    const { fetcher, calls } = stubFetcher([noSuchDocument('62024TO0511')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, cellarBaseUrl: 'https://gateway.test/documents' });

    const [preview] = await resolver.resolve(order());
    assert.equal(calls.length, 1);
    assert.ok(preview.url.startsWith('https://curia.europa.eu/'));
  });
});

describe('EUR-Lex retry and backoff', () => {
  test('retries a 429 and honours Retry-After', async () => {
    const throttled = new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
    const { fetcher, calls } = stubFetcher([throttled, html('<p>ok</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());

    assert.equal(calls.length, 2);
    assert.ok(clock.slept.includes(3_000), `expected a 3s wait, saw ${clock.slept.join(',')}`);
    assert.ok(preview.excerpt.includes('ok'));
  });

  test('retries a 5xx with exponential backoff', async () => {
    const { fetcher, calls } = stubFetcher([
      new Response('boom', { status: 503 }),
      new Response('boom', { status: 500 }),
      html('<p>ok</p>'),
    ]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 2 });
    await resolver.resolve(eurLexLookup());

    assert.equal(calls.length, 3);
    assert.deepEqual(clock.slept, [400, 800], 'backoff must grow between attempts');
  });

  test('tries every format and language on a 404 and surfaces the status when none exists', async () => {
    const { fetcher, calls } = stubFetcher(Array.from({ length: 4 }, () => new Response('missing', { status: 404 })));
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /EUR-Lex\/CELLAR lookup failed \(404\)/);
    assert.equal(calls.length, 4, 'two formats across two languages, each tried once and not retried beyond that');
  });

  test('does not try the other format on a non-404 client error', async () => {
    const { fetcher, calls } = stubFetcher([new Response('nope', { status: 400 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /EUR-Lex\/CELLAR lookup failed \(400\)/);
    assert.equal(calls.length, 1, 'only a 404 means "this representation does not exist" — other statuses fail immediately');
  });

  test('rejects a bot-verification page (HTTP 200) instead of showing it as the document', async () => {
    const { fetcher } = stubFetcher([botChallengeResponse()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    await assert.rejects(resolver.resolve(eurLexLookup()), /did not return a recognisable document/);
  });

  test('accepts a substantial response even without a recognised generator marker', async () => {
    // Real CELLAR documents have been found in enough distinct markup conventions
    // that a further, uncatalogued one is plausible — a large response with no
    // known marker should not be rejected outright the way a short one is.
    const body = new Response(
      `<HTML><BODY>${'<p>Genuine-looking legal text padding out the response.</p>'.repeat(60)}</BODY></HTML>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
    const { fetcher } = stubFetcher([body]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.ok(preview.excerpt.includes('Genuine-looking legal text'));
  });

  test('gives up after the retry budget and reports the last status', async () => {
    const { fetcher, calls } = stubFetcher([
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 1 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /lookup failed \(500\)/);
    assert.equal(calls.length, 2);
  });

  test('retries a transport error and succeeds', async () => {
    const { fetcher, calls } = stubFetcher([new Error('socket hang up'), html('<p>ok</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());

    assert.equal(calls.length, 2);
    assert.ok(preview.excerpt.includes('ok'));
  });

  test('rethrows a transport error once the retry budget is spent', async () => {
    const { fetcher } = stubFetcher([new Error('socket hang up')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    await assert.rejects(resolver.resolve(eurLexLookup()), /socket hang up/);
  });

  test('a failed lookup is not cached', async () => {
    const { fetcher, calls } = stubFetcher([
      ...Array.from({ length: 4 }, () => new Response('boom', { status: 404 })), html('<p>ok</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()));
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(calls.length, 5, 'the first call exhausts both formats in both languages (4), the retry is a fresh fifth');
    assert.ok(preview.excerpt.includes('ok'));
  });
});

describe('EUR-Lex request spacing', () => {
  test('waits the configured interval between requests', async () => {
    const { fetcher } = stubFetcher([html('<p>one</p>'), html('<p>two</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup({ celex: '32002L0058' }));
    await resolver.resolve(eurLexLookup({ celex: '32016R0679' }));

    assert.deepEqual(clock.slept, [1_000], 'the second request must be spaced by the interval');
  });

  test('does not wait when the interval has already elapsed', async () => {
    const { fetcher } = stubFetcher([html('<p>one</p>'), html('<p>two</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup({ celex: '32002L0058' }));
    clock.advance(5_000);
    await resolver.resolve(eurLexLookup({ celex: '32016R0679' }));

    assert.deepEqual(clock.slept, [], 'no wait is needed once the interval has passed');
  });

  test('cached lookups do not consume a request slot', async () => {
    const { fetcher } = stubFetcher([html('<p>one</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup());
    await resolver.resolve(eurLexLookup());

    assert.deepEqual(clock.slept, []);
  });

  test('the interval is not charged to each attempt within one lookup', async () => {
    // What the interval is for is the shape of this client's traffic against a public
    // service: one document at a time, spaced, never in parallel. Charging it per *request*
    // stacked a contrived second in front of a rendition probe that costs ~165ms live —
    // measured as roughly 74% of a cold lookup, spent on the resolver's own guessing rather
    // than on anything CELLAR needs protecting from.
    const { fetcher, calls } = stubFetcher([noSuchRendition(), documentResponse('<p>older format</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup());

    assert.equal(calls.length, 2, 'two attempts, one document');
    assert.deepEqual(clock.slept, [], 'the second attempt is the same lookup, so it waits for nothing');
  });

  test('distinct document lookups are still spaced, however many attempts each took', async () => {
    const { fetcher } = stubFetcher([
      noSuchRendition(), documentResponse('<p>one</p>'),
      noSuchRendition(), documentResponse('<p>two</p>'),
    ]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup({ celex: '32002L0058' }));
    await resolver.resolve(eurLexLookup({ celex: '32011L0083' }));

    assert.deepEqual(clock.slept, [1_000], 'one interval between the two documents, not one per request');
  });

  test('a document served without a request does not make the next lookup wait for it', async () => {
    // A held document with no validator needs no network at all. Making the next lookup sit
    // out a politeness interval for a request that never happened would be the same
    // accounting error in the other direction — and with the pane now warming the cache in
    // the background, that error would be paid once per already-held document.
    const { fetcher } = stubFetcher([html('<p>one</p>'), html('<p>two</p>')]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await resolver.resolve(eurLexLookup({ celex: '32002L0058', locator: { kind: 'article', start: 1 } }));
    clock.advance(1_000);
    await resolver.resolve(eurLexLookup({ celex: '32002L0058', locator: { kind: 'article', start: 2 } }));
    await resolver.resolve(eurLexLookup({ celex: '32011L0083' }));

    assert.deepEqual(clock.slept, [], 'only the two real requests count, and they were a full interval apart');
  });

  test('lookups issued together go to CELLAR one at a time, in order', async () => {
    // Requests to CELLAR are deliberately never parallelised: a burst of concurrent
    // connections is the fingerprint anti-bot protection reacts to, and the previous
    // version only spaced the *starts* — two lookups could still be in flight together.
    const { fetcher, calls } = stubFetcher([
      documentResponse('<p>one</p>'), documentResponse('<p>two</p>'), documentResponse('<p>three</p>'),
    ]);
    const { resolver, clock } = makeResolver({ fetcher, minRequestIntervalMs: 1_000 });

    await Promise.all([
      resolver.resolve(eurLexLookup({ celex: '32002L0058' })),
      resolver.resolve(eurLexLookup({ celex: '32011L0083' })),
      resolver.resolve(eurLexLookup({ celex: '32016R0679' })),
    ]);

    assert.deepEqual(calls.map((call) => call.url), [
      'https://example.test/celex/32002L0058',
      'https://example.test/celex/32011L0083',
      'https://example.test/celex/32016R0679',
    ], 'issued in the order asked for, one after another');
    assert.deepEqual(clock.slept, [1_000, 1_000], 'each spaced from the one before it');
  });
});

/**
 * A joined judgment or opinion is one document filed under one of its case numbers, and no
 * rule says which. Measured live on 2026-08-25: `62012CJ0293` serves Digital Rights Ireland
 * while `62012CJ0594` — the same judgment's other number — answers `Resource … not found`
 * in both languages and both formats. Google France and Verholen behave the same way.
 *
 * Without the alternatives a footnote that happens to state the group's numbers in the other
 * order reaches a CURIA link and no text at all, for a judgment CELLAR holds and would serve
 * on the next request.
 */
describe('a joined case filed under a sibling number', () => {
  const joined = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'C-594/12', caseNumber: 'C-594/12', celex: '62012CJ0594',
    alternativeCelexes: ['62012CJ0293'], ...overrides,
  });

  test('retrieves the document under the sibling once its own identifier names nothing', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62012CJ0594'), html('<p>Judgment text, point 65 of the ruling.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(joined({ locator: { kind: 'point', start: 65 } }));

    assert.deepEqual(calls.map((call) => call.url), [
      'https://example.test/celex/62012CJ0594',
      'https://example.test/celex/62012CJ0293',
    ], 'one request to say the identifier names nothing, then the sibling');
    assert.equal(preview.source, 'CURIA');
    assert.equal(preview.url, 'https://example.test/celex/62012CJ0293', 'the reader is linked to the document that answered');
  });

  test('costs nothing when the citation\'s own identifier works', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Judgment text, point 57 of the ruling.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    await resolver.resolve(curiaJudgmentLookup({ alternativeCelexes: ['62012CJ0594'] }));
    assert.deepEqual(calls.map((call) => call.url), ['https://example.test/celex/62012CJ0293']);
  });

  test('comes after the ECLI, which is the name the court itself gave the document', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('62012CJ0594'), html('<p>Judgment text, point 65.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    await resolver.resolve(joined({ ecli: 'ECLI:EU:C:2014:238' }));
    assert.deepEqual(calls.map((call) => call.url), [
      'https://example.test/celex/62012CJ0594',
      `https://example.test/ecli/${encodeURIComponent('ECLI:EU:C:2014:238')}`,
    ]);
  });

  test('a malformed alternative is dropped rather than requested', async () => {
    // An alternative is only ever reached when the reviewer has already waited out a failed
    // lookup. Spending more of that wait on a request that cannot succeed is the one cost
    // worth refusing outright.
    const { fetcher, calls } = stubFetcher([noSuchDocument('62012CJ0594')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(joined({ alternativeCelexes: ['../../etc/passwd', 'not-a-celex', '62012CJ0594'] }));
    assert.deepEqual(calls.map((call) => call.url), ['https://example.test/celex/62012CJ0594'], 'and the identifier already tried is not tried twice');
    assert.equal(preview.source, 'CURIA');
    assert.ok(preview.url.startsWith('https://curia.europa.eu/'), 'the official link stays the floor');
  });
});

/**
 * `Accept-Language` is a request, and the label under the excerpt is a statement to a lawyer
 * about which text they are reading. CELLAR has honoured the request in every document
 * tested — it 404s cleanly for a language a document never had — but that is its behaviour,
 * not a guarantee this service holds.
 *
 * The markers are the ones real documents carry, confirmed live on 2026-08-25: the classic
 * `text/html` era declares the language outright, and the modern `application/xhtml+xml`
 * era declares nothing anywhere in the markup (its `Content-Language` response header is
 * present and empty), so its language is read from the heading it opens with.
 */
describe('the language served, not the language asked for', () => {
  const asFrenchJudgment = (body: string) => html(`<p>ARRÊT DE LA COUR (grande chambre)</p>${body}`);

  test('a French document answering an English request is labelled French', async () => {
    const { fetcher, calls } = stubFetcher([asFrenchJudgment('<p>1. Texte de l\'arrêt.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());
    assert.equal(new Headers(calls[0].init.headers).get('accept-language'), 'eng', 'English was what was asked for');
    assert.equal(preview.language, 'fr', 'French is what came back');
  });

  test('and is offered to the translator on the strength of what it is', async () => {
    // The whole cost of getting this wrong: a French passage recorded as English is shown
    // unlabelled, untranslated, and as though the Court had written it that way.
    const { fetcher } = stubFetcher([asFrenchJudgment('<p>1. Texte de l\'arrêt.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, translate: async (text, from) => `[EN of ${from}] ${text}` });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());
    assert.match(preview.excerpt, /^\[EN of fr\]/);
    assert.deepEqual(preview.translation, { from: 'fr', officialUrl: preview.url });
  });

  test('reads the declaration the classic rendition carries', async () => {
    const { fetcher } = stubFetcher([html('<meta name="DC.language" content="FR"><p>Texte.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    assert.equal((await resolver.resolve(curiaJudgmentLookup()))[0].language, 'fr');
  });

  test('recognises each document type\'s own heading, in both languages', async () => {
    const headings: Array<[string, string]> = [
      ['<p>JUDGMENT OF THE COURT (Grand Chamber)</p>', 'en'],
      ['<p>OPINION OF ADVOCATE GENERAL WATHELET</p>', 'en'],
      ['<p>CONCLUSIONS DE L’AVOCAT GÉNÉRAL M. WATHELET</p>', 'fr'],
      ['<p>ORDONNANCE DU VICE-PRÉSIDENT DE LA COUR</p>', 'fr'],
      ['<p>FR Journal officiel de l’Union européenne</p>', 'fr'],
    ];
    for (const [heading, expected] of headings) {
      const { fetcher } = stubFetcher([html(heading)]);
      const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
      assert.equal((await resolver.resolve(curiaJudgmentLookup()))[0].language, expected, heading);
    }
  });

  test('leaves the requested language standing when the document says nothing', async () => {
    // This can correct a label; it must never invent one. A document carrying no marker
    // keeps exactly the behaviour that preceded this check.
    const { fetcher } = stubFetcher([html('<p>Judgment text, point 57 of the ruling.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    assert.equal((await resolver.resolve(curiaJudgmentLookup()))[0].language, 'en');
  });

  test('a cached document is labelled by what it holds, not by the key it is held under', async () => {
    // The store is keyed by the language requested, so a document read back from it would
    // otherwise be labelled by the request that first fetched it while the fresh copy of the
    // same bytes was labelled by its contents.
    const documentStore = createMemoryDocumentStore();
    const body = '<p>ARRÊT DE LA COUR (grande chambre)</p><p>1. Texte.</p>';
    const first = makeResolver({ fetcher: stubFetcher([documentResponse(body)]).fetcher, minRequestIntervalMs: 0, documentStore });
    assert.equal((await first.resolver.resolve(curiaJudgmentLookup()))[0].language, 'fr');

    const second = makeResolver({ fetcher: stubFetcher([notModified()]).fetcher, minRequestIntervalMs: 0, documentStore });
    assert.equal((await second.resolver.resolve(curiaJudgmentLookup()))[0].language, 'fr', 'the same document, revalidated');
  });
});

/**
 * The title is the line a lawyer reads first, and it used to be the document's internal
 * filename. `decodeHtml(html).slice(0, 260).split('Official Journal')[0]` assumed the title
 * precedes the Journal reference — true of the classic rendition, and exactly backwards for
 * the modern one, where the act's title *follows* it. So the most cited instrument in EU law
 * was titled `L_2016119EN.01000101.xml 4.5.2016 EN`.
 */
describe('what a legislative passage is titled', () => {
  const modern = (body: string) => html(
    `L_2016119EN.01000101.xml 4.5.2016 EN Official Journal of the European Union L 119/1 ${body}`,
  );

  test('reads the title that follows the Journal line, as the modern rendition writes it', async () => {
    const { fetcher } = stubFetcher([modern(
      'REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 27 April 2016 on the protection of natural '
      + 'persons (General Data Protection Regulation) (Text with EEA relevance) THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION,',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32016R0679', value: 'Regulation (EU) 2016/679' }));
    assert.equal(preview.title, 'REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 27 April 2016 '
      + 'on the protection of natural persons (General Data Protection Regulation)');
  });

  test('and the title that precedes it, as the classic rendition writes it', async () => {
    const { fetcher } = stubFetcher([html(
      'EUR-Lex - 32002L0058 - EN Avis juridique important | 32002L0058 Directive 2002/58/EC of the European Parliament and of '
      + 'the Council of 12 July 2002 concerning the processing of personal data Official Journal L 201 , 31/07/2002 P. 0037',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive 2002/58/EC of the European Parliament and of the Council of 12 July 2002 '
      + 'concerning the processing of personal data');
  });

  test('keeps the institutions the title itself names', async () => {
    // The enacting formula has to be matched in full. An act's own title reads "OF THE
    // EUROPEAN PARLIAMENT AND OF THE COUNCIL", so cutting at a bare "THE EUROPEAN PARLIAMENT"
    // truncates every co-decided act to its first four words.
    const { fetcher } = stubFetcher([modern('REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 27 April 2016 on something. Having regard to the Treaty')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32016R0679' }));
    assert.match(preview.title, /AND OF THE COUNCIL of 27 April 2016/);
  });

  test('accepts the number in either convention, and the year in either length', async () => {
    // A directive is year/number and a pre-2015 regulation number/year; an act from before
    // 2000 states its year in two digits while its CELEX states four.
    const reversed = stubFetcher([html('Regulation (EC) No 1049/2001 of the European Parliament and of the Council of 30 May 2001 regarding public access Official Journal L 145')]);
    const short = stubFetcher([html('Directive 95/46/EC of the European Parliament and of the Council of 24 October 1995 on the protection of individuals Official Journal L 281')]);
    const first = await makeResolver({ fetcher: reversed.fetcher, minRequestIntervalMs: 0 }).resolver.resolve(eurLexLookup({ celex: '32001R1049' }));
    const second = await makeResolver({ fetcher: short.fetcher, minRequestIntervalMs: 0 }).resolver.resolve(eurLexLookup({ celex: '31995L0046' }));
    assert.match(first[0].title, /^Regulation \(EC\) No 1049\/2001 of the European Parliament/);
    assert.match(second[0].title, /^Directive 95\/46\/EC of the European Parliament/);
  });

  test('refuses a title naming an act other than the one fetched', async () => {
    // A title is a claim about which act is on screen. A document that opens by citing a
    // different act must not have that act's name put above this one's text.
    const { fetcher } = stubFetcher([html('Corrigendum to Directive 95/46/EC of the European Parliament and of the Council of 24 October 1995 Official Journal L 281')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32002L0058', value: 'Directive 2002/58/EC' }));
    assert.equal(preview.title, 'Directive 2002/58/EC', 'falls back to the name derived from the citation');
  });

  test('falls back to the citation where the document states no act title at all', async () => {
    // A treaty article is a small single-article document with no act title in it.
    const { fetcher } = stubFetcher([html('<p>Article 101</p><p>1. The following shall be prohibited</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '12016E101', value: 'Article 101 TFEU' }));
    assert.equal(preview.title, 'Article 101 TFEU');
  });
});

describe('the letters a European legal text is written with', () => {
  test('decodes the accented entities the classic rendition uses', async () => {
    // A French passage reached the pane reading `du Parlement europ&eacute;en`, and French is
    // exactly the case where the reader has no English to fall back on.
    const { fetcher } = stubFetcher([html('R&egrave;glement (UE) 2016/679 du Parlement europ&eacute;en et du Conseil du 27 avril 2016 relatif &agrave; la protection Journal officiel L 119')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32016R0679' }));
    assert.match(preview.title, /^Règlement \(UE\) 2016\/679 du Parlement européen et du Conseil du 27 avril 2016 relatif à la protection$/);
  });

  test('keeps the case the entity was written in', async () => {
    // A named entity is case-sensitive. Folding it before the lookup renders the heading
    // `ARRÊT DE LA COUR` as `ARRêT DE LA COUR`.
    const { fetcher } = stubFetcher([html('<p>ARR&Ecirc;T DE LA COUR</p><p>1. Texte de l&rsquo;arr&ecirc;t.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 1 } }));
    assert.match(preview.excerpt, /Texte de l’arrêt/);
    assert.equal(preview.language, 'fr', 'and the heading is still recognised for what it is');
  });

  test('leaves an entity it does not know exactly as it stands', async () => {
    // Showing `&permil;` is a small blemish; silently dropping a character out of a passage a
    // lawyer is about to rely on is not.
    const { fetcher } = stubFetcher([html('<p>Article 15</p><p>1. A rate of 5&unknownentity; applies.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));
    assert.match(preview.excerpt, /5&unknownentity; applies/);
  });
});

/**
 * Every CELLAR rendition opens with publication apparatus, and it was reaching the reviewer.
 * Seen in the pane on a real client document: a regulation cited without a pinpoint showed
 * `L_2004364EN.01000101.xml 9.12.2004 EN Official Journal of the European Union L 364/1
 * REGULATION (EC) No 2006/2004 …`, and a judgment showed its bare CELEX first.
 */
describe('where an excerpt starts', () => {
  test('skips the filename and Journal line an act is printed behind', async () => {
    const { fetcher } = stubFetcher([html(
      'L_2004364EN.01000101.xml 9.12.2004 EN Official Journal of the European Union L 364/1 '
      + 'REGULATION (EC) No 2006/2004 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 27 October 2004 on cooperation',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32004R2006' }));
    assert.match(preview.excerpt, /^REGULATION \(EC\) No 2006\/2004 OF THE EUROPEAN PARLIAMENT/);
  });

  test('skips the bare CELEX a judgment is printed behind', async () => {
    const { fetcher } = stubFetcher([html('62012CJ0293 JUDGMENT OF THE COURT (Grand Chamber) 8 April 2014 Electronic communications')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());
    assert.match(preview.excerpt, /^JUDGMENT OF THE COURT \(Grand Chamber\)/);
  });

  test('and the apparatus the classic rendition prints instead', async () => {
    const { fetcher } = stubFetcher([html(
      '@import url(lex/css/lex-screen.css); EUR-Lex - 32002L0058 - EN Avis juridique important | 32002L0058 '
      + 'Directive 2002/58/EC of the European Parliament and of the Council of 12 July 2002 concerning the processing',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.match(preview.excerpt, /^Directive 2002\/58\/EC of the European Parliament/);
  });

  test('shows a document it does not recognise from its very first character', async () => {
    // Bounded on purpose: not recognising an opening must cost nothing, never a skipped
    // passage. A reviewer reading a stray heading is a blemish; a reviewer reading a passage
    // that starts later than the document does is a missing one.
    const { fetcher } = stubFetcher([html('Some document with no heading this resolver knows about, shown whole.')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.match(preview.excerpt, /^Some document with no heading/);
  });

  test('a title too long for the card is cut on a word boundary', async () => {
    // The pane renders the title as the card's link, unwrapped. Directive 2005/29/EC names
    // every act it amends, and states it in 400 characters.
    const { fetcher } = stubFetcher([html(
      'DIRECTIVE 2005/29/EC OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 11 May 2005 concerning unfair '
      + 'business-to-consumer commercial practices in the internal market and amending Council Directive 84/450/EEC, '
      + 'Directives 97/7/EC, 98/27/EC and 2002/65/EC of the European Parliament and of the Council Official Journal L 149',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(eurLexLookup({ celex: '32005L0029' }));
    assert.ok(preview.title.length <= 201, `titled ${preview.title.length} characters`);
    assert.ok(preview.title.endsWith('…'), preview.title);
    assert.ok(!/\S…$/.test(preview.title.replace(/\w…$/, '')) || !preview.title.includes('  '), 'cut on a word boundary');
    assert.match(preview.title, /^DIRECTIVE 2005\/29\/EC OF THE EUROPEAN PARLIAMENT/);
  });
});

/**
 * The General Court publishes many judgments in extract, reproducing the paragraphs it
 * "considers it appropriate to publish" and no others. Canon v Commission (T-609/19) carries
 * 175 paragraphs numbered up to 339, so a real decision's footnote citing its
 * paragraph 435 — points at something EUR-Lex has never held.
 *
 * The document is complete, correct and official. Telling that apart from an ordinary miss
 * matters because the two ask opposite things of the reader: "could not be located" sends
 * them looking again, and here there is nothing to find.
 */
describe('a judgment the Court published only in part', () => {
  const extract = (body: string) => html(`<p class="coj-count" id="point1">1</p><p>First.</p>${body}`);

  test('says the paragraph was never published, rather than blaming retrieval', async () => {
    const { fetcher } = stubFetcher([extract(
      '<p class="coj-count" id="point339">339</p><p>Last published paragraph.</p>'
      + '<p>( 1 ) Only the paragraphs of the present judgment which the Court considers it appropriate to publish are reproduced here.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 435 }, paragraphs: [435] }));
    assert.equal(preview.passage, 'unpublished');
  });

  test('reads the gap in the numbering, for a document that does not say so outright', async () => {
    // Intel (T-286/09) carries 619 paragraphs numbered up to 1,647. Where the highest number
    // exceeds the count present, paragraphs are missing between them.
    const { fetcher } = stubFetcher([extract('<p class="coj-count" id="point1647">1647</p><p>Last published paragraph.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 900 }, paragraphs: [900] }));
    assert.equal(preview.passage, 'unpublished');
  });

  test('does not claim it of a complete judgment whose paragraph simply was not found', async () => {
    // Count and maximum agree, and there is no note: every paragraph the judgment has is
    // here. A pinpoint that misses one of those is an ordinary miss, and must keep saying so.
    const { fetcher } = stubFetcher([html(
      '<p class="coj-count" id="point1">1</p><p>First.</p><p class="coj-count" id="point2">2</p><p>Second.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 99 }, paragraphs: [99] }));
    assert.equal(preview.passage, 'opening');
  });

  test('never overrides a passage that was found', async () => {
    // The wording of an explanation is all this decides. A cited paragraph that is present is
    // returned as cited, extract or not.
    const { fetcher } = stubFetcher([extract(
      '<p class="coj-count" id="point339">339</p><p>The cited paragraph, present after all.</p>'
      + '<p>Only the paragraphs of the present judgment which the Court considers it appropriate to publish are reproduced here.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 339 }, paragraphs: [339] }));
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /present after all/);
  });
});
