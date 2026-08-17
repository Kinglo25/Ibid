import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEuSourceResolver, createApiHealthCheck, type EuLookup, type ResolverOptions } from '../src/index.ts';

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
    // A 404 means "try the other Accept header" (see fetchCellarDocument) — both must be attempted before falling back.
    const { fetcher, calls } = stubFetcher([new Response('missing', { status: 404 }), new Response('missing', { status: 404 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());

    assert.equal(calls.length, 2, 'both content-negotiated formats must be attempted before falling back');
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

  test('falls back to the document start when no known point-anchor convention matches', async () => {
    // e.g. a document CELLAR mirrors under a further, uncatalogued convention.
    const { fetcher } = stubFetcher([html('<p>No point anchors in this document.</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 57 } }));
    assert.ok(preview.excerpt.includes('No point anchors in this document.'));
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
    assert.equal(preview.locator, 'Point 60–65');
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

  test('derives the title from the text ahead of the Official Journal reference', async () => {
    const { fetcher } = stubFetcher([html('<p>Directive on privacy and electronic communications Official Journal L 201</p>')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive on privacy and electronic communications');
  });

  test('falls back to the citation as the title when the document is empty', async () => {
    const { fetcher } = stubFetcher([html('')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(preview.title, 'Directive 2002/58/CE');
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

  test('treats a different locator as a different cache entry', async () => {
    const { fetcher, calls } = stubFetcher([html('<p>Article 15 one</p>'), html('<p>Article 20 two</p>')]);
    const { resolver } = makeResolver({ fetcher });
    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 15 } }));
    await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 20 } }));
    assert.equal(calls.length, 2);
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

  test('tries both content-negotiated formats on a 404 and surfaces the status when neither exists', async () => {
    const { fetcher, calls } = stubFetcher([new Response('missing', { status: 404 }), new Response('missing', { status: 404 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /EUR-Lex\/CELLAR lookup failed \(404\)/);
    assert.equal(calls.length, 2, 'a 404 tries the other Accept header once before giving up; neither is retried beyond that');
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
      new Response('boom', { status: 404 }), new Response('boom', { status: 404 }), html('<p>ok</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup()));
    const [preview] = await resolver.resolve(eurLexLookup());
    assert.equal(calls.length, 3, 'the first call exhausts both formats (2 requests), the retry is a fresh third');
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
});
