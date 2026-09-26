import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommissionCaseIndex, createEuSourceResolver, createApiHealthCheck, createMemoryDocumentStore, decisionTextKey, documentTypeOf, type EuLookup, type ResolverOptions } from '../src/index.ts';

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

  // The ECR-era CURIA rendering: the same `C01PointnumeroteAltN` class as the anchored
  // convention above, but with no anchor at all — the number opens the paragraph and a run
  // of `&nbsp;` entities separates it from the text. Markup copied from Groupe Danone
  // (62002TJ0038) and Atlantic Container Line/TACA (61998TJ0191), both cited in the
  // Commission's Intel decision. `&nbsp;` is six literal characters in raw HTML, so the
  // `\s+` the bare-number pattern relies on never matched, and both citations fell back to
  // the headnote.
  //
  // The headnote is the trap, and it is in the fixture for that reason. These documents open
  // with the Reports' "Summary of the Judgment", whose items carry the sibling `S` classes
  // and start again at 1 — Danone holds 31 of them ahead of the judgment's own paragraph 1.
  // The slice takes the first match numbered as the target, so a pattern blind to the class
  // prefix answers a citation to paragraph 2 with headnote 2: a different text, with nothing
  // on screen to say so.
  const ecrEraPointsBody = ['1', '2', '3'].map((n) =>
    `<P class="S01PointnumeroteAltN">${n}.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Headnote ${n}, from the summary of the judgment.</P>`).join('')
    + ['1', '2', '3'].map((n) =>
      `<P class="C01PointnumeroteAltN">${n}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Paragraph ${n} of the ruling`
      + `${n === '2' ? ' — this is the cited paragraph' : ', unrelated matter'}.</P>`).join('');

  test('focuses the excerpt on the cited point using the ECR-era unanchored markup', async () => {
    const { fetcher } = stubFetcher([html(ecrEraPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62002TJ0038', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('Paragraph 1'));
    assert.ok(!preview.excerpt.includes('Paragraph 3'));
    assert.equal(preview.passage, 'cited');
  });

  test('reads the judgment paragraph, never the headnote item that shares its number', async () => {
    const { fetcher } = stubFetcher([html(ecrEraPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62002TJ0038', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));

    assert.ok(!preview.excerpt.includes('Headnote'), 'the summary of the judgment is not the judgment');
  });

  test('carries a cited range across the ECR-era markup, stopping after the last point asked for', async () => {
    // TACA is cited at paragraphs 349-359 and runs to 1,648, so a range that failed to
    // terminate would return the rest of the judgment rather than the passage.
    const { fetcher } = stubFetcher([html(['348', '349', '350', '351'].map((n) =>
      `<P class="C01PointnumeroteAltN">${n}&nbsp;&nbsp;&nbsp;Paragraph ${n} of the ruling.</P>`).join(''))]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({
      celex: '61998TJ0191', locator: { kind: 'point', start: 349, end: 350 }, paragraphs: [349, 350],
    }));

    assert.ok(preview.excerpt.includes('Paragraph 349'));
    assert.ok(preview.excerpt.includes('Paragraph 350'));
    assert.ok(!preview.excerpt.includes('Paragraph 348'), 'the range starts where it was told to');
    assert.ok(!preview.excerpt.includes('Paragraph 351'), 'and ends where it was told to');
    assert.equal(preview.locator, 'Points 349\u2013350');
  });

  // The Reports' oldest rendering: all capitals, and the number runs straight into the first
  // word with no separator of any kind. Markup copied from Hoffmann-La Roche (61976CJ0085),
  // whose paragraphs 38, 41, 71, 74, 76, 89, 90 and 125 the Commission's Intel decision
  // cites, and United Brands (61976CJ0027, paragraph 65) — the two judgments that define
  // dominance and the abuse of it, and the two the pane answered with a headnote.
  const allCapitalsPointsBody = ['37', '38', '39'].map((n) =>
    `<p>  ${n}ARTICLE 86 IS AN APPLICATION OF THE GENERAL OBJECTIVE`
    + `${n === '38' ? ' - THIS IS THE CITED PARAGRAPH' : ', UNRELATED MATTER'} .</p>`).join('');

  test('focuses the excerpt on the cited point where the number runs into the text', async () => {
    const { fetcher } = stubFetcher([html(allCapitalsPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '61976CJ0085', locator: { kind: 'point', start: 38 }, paragraphs: [38] }));

    assert.ok(preview.excerpt.includes('THIS IS THE CITED PARAGRAPH'));
    assert.ok(!preview.excerpt.includes('37ARTICLE'));
    assert.ok(!preview.excerpt.includes('39ARTICLE'));
    assert.equal(preview.passage, 'cited');
  });

  // The "Parties / Grounds / Operative part" rendering, where the paragraph number takes a
  // period. Markup copied from France Télécom (62007CJ0202), cited at paragraphs 104 and
  // 107-111. This is the one convention that collides with the numbering of a provision
  // quoted inside a judgment, which is why it is tried last of all — see the pattern list.
  const periodNumberedPointsBody = ['103', '104', '105'].map((n) =>
    `<p>${n}. In that context, in prohibiting the abuse of a dominant market position`
    + `${n === '104' ? ' — this is the cited paragraph' : ', unrelated matter'}.</p>`).join('');

  test('focuses the excerpt on the cited point where the number takes a period', async () => {
    const { fetcher } = stubFetcher([html(periodNumberedPointsBody)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0202', locator: { kind: 'point', start: 104 }, paragraphs: [104] }));

    assert.ok(preview.excerpt.includes('this is the cited paragraph'));
    assert.ok(!preview.excerpt.includes('103.'));
    assert.ok(!preview.excerpt.includes('105.'));
    assert.equal(preview.passage, 'cited');
  });

  test('the period-numbered shape never outranks a convention that carries a marker', async () => {
    // A judgment that quotes a directive article by its own numbering, and marks its own
    // paragraphs properly. The quoted `1.` must not be reachable as "paragraph 1": the
    // marked convention is tried first and answers, so the loose shape is never consulted.
    const { fetcher } = stubFetcher([html(
      '<p>1. Member States shall ensure that this quoted provision is applied.</p>'
      + '<p class="coj-count" id="point1">1</p><p>The judgment\u2019s own first paragraph.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 1 }, paragraphs: [1] }));

    assert.match(preview.excerpt, /own first paragraph/);
    assert.ok(!preview.excerpt.includes('Member States shall ensure'), 'a quoted provision is not the judgment\u2019s paragraph 1');
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

  test('a case number links to the case, not to a search for it', async () => {
    // Confirmed by hand in a browser on 2026-09-10: the register serves the same Angular
    // shell for every path, so nothing outside a browser can tell a real case page from an
    // invented one, and this shape had to be checked by a person before it could be relied on.
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'commission', value: 'M.8713' });

    assert.equal(calls.length, 0, 'the register is still never fetched');
    assert.equal(preview.url, 'https://competition-cases.ec.europa.eu/cases/M.8713');
  });

  test('COMP/ is dropped, because the register numbers the case without it', async () => {
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'commission', value: 'COMP/M.8713' });

    assert.equal(preview.url, 'https://competition-cases.ec.europa.eu/cases/M.8713');
  });

  test('a pre-2012 file number opens the case under the number the register gives it', async () => {
    // Detection carries `COMP/C-3/37.990` as written and `AT.37990` as its case number.
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ source: 'commission', value: 'COMP/C-3/37.990', caseNumber: 'AT.37990' });

    assert.equal(preview.url, 'https://competition-cases.ec.europa.eu/cases/AT.37990');
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

describe('Commission decisions, through the Commission’s own case data', () => {
  const INTEL_2009 = 'https://ec.europa.eu/competition/antitrust/cases/dec_docs/37990/37990_3581_18.pdf';
  const INTEL_2023 = 'https://ec.europa.eu/competition/antitrust/cases1/202346/AT_37990_9687627_5129_3.pdf';

  const decision = (link: string, date: string) => ({
    metadata: {
      attachmentLink: [link],
      attachmentCategory: [JSON.stringify({ code: 'DocumentCategory0352', label: 'Prohibition Decision (Art. 7)' })],
      attachmentLanguage: ['EN'],
      attachmentDocumentDate: [date],
    },
  });

  const indexOf = (attachments: ReturnType<typeof decision>[]) => buildCommissionCaseIndex([
    JSON.stringify({ 'AT.37990': { decisions: [{ decisionAttachments: attachments }] } }),
  ]);

  const loaderFor = (attachments: ReturnType<typeof decision>[]) => {
    const index = indexOf(attachments);
    return { get: async () => index };
  };

  test('links the decision itself rather than a search for the case', async () => {
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([decision(INTEL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 223 } });

    assert.equal(preview.url, INTEL_2009);
    assert.equal(preview.source, 'European Commission');
    assert.equal(preview.locator, 'Point 223');
    assert.match(preview.excerpt, /13 May 2009/, 'the date is what tells one decision in a case from another');
  });

  test('no PDF is fetched, and so nothing claims to have been verified', async () => {
    // The improvement is the link, not the passage: a dependency-free text extractor was
    // measured against `pdftotext` and recovered the characters but not the line structure
    // the recital numbers anchor to, which turns a `(223)` inside a cross-reference into a
    // heading. `verifiedAt` means "confirmed against the publisher", and nothing was.
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([decision(INTEL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990' });

    assert.equal(calls.length, 0, 'the decision itself is never downloaded');
    assert.equal(preview.verifiedAt, undefined);
    assert.equal(preview.passage, undefined, 'no passage was cut, so none is described');
  });

  test('a case decided twice offers both, the original first', async () => {
    // Intel was decided on 13 May 2009 and re-adopted on 22 September 2023, both labelled
    // `Prohibition Decision`. A footnote citing paragraph 1000 names neither, so the reviewer
    // is shown the choice rather than handed a guess.
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({
      fetcher,
      commissionCases: loaderFor([decision(INTEL_2023, '2023-09-22'), decision(INTEL_2009, '2009-05-13')]),
    });

    const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990' });

    assert.equal(previews.length, 2);
    assert.equal(previews[0].url, INTEL_2009);
    assert.equal(previews[1].url, INTEL_2023);
    assert.match(previews[0].excerpt, /One of 2 decisions/);
  });

  test('a case the data does not name keeps the register link', async () => {
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([decision(INTEL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'M.8713' });

    assert.equal(preview.url, 'https://competition-cases.ec.europa.eu/cases/M.8713');
  });

  test('a loader that fails costs the decision link and nothing else', async () => {
    const { fetcher } = stubFetcher([]);
    const { resolver } = makeResolver({
      fetcher,
      commissionCases: { get: async () => { throw new Error('the dataset is unreachable'); } },
    });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990' });

    assert.equal(preview.url, 'https://competition-cases.ec.europa.eu/cases/AT.37990');
    assert.equal(preview.source, 'European Commission');
  });
});

/**
 * A citation whose case number is another case's, as the Commission's own 2026 draft merger
 * guidelines cite `Case M.7967 – Ball/Rexam`: M.7967 is Apax Partners / Neuberger Berman /
 * Engineering, and Ball/Rexam is M.7567.
 */
describe('a Commission citation whose number is not the case it names', () => {
  const APAX = 'https://ec.europa.eu/competition/mergers/cases/decisions/m7967_114_3.pdf';
  const BALL_REXAM = 'https://ec.europa.eu/competition/mergers/cases/decisions/m7567_4959_3.pdf';
  const decided = (title: string, link: string) => ({
    metadata: { caseTitle: [title] },
    decisions: [{ decisionAttachments: [{ metadata: {
      attachmentLink: [link],
      attachmentCategory: [JSON.stringify({ code: 'DocumentCategory0587', label: 'Decision - web publication' })],
      attachmentLanguage: ['EN'], attachmentDocumentDate: ['2016-01-15'],
    } }] }],
  });
  const index = buildCommissionCaseIndex([JSON.stringify({
    'M.7967': decided('APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', APAX),
    'M.7567': decided('BALL / REXAM', BALL_REXAM),
  })]);
  const commissionCases = { get: async () => index };

  test('shows the case it names, and carries the mismatch with it', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher, commissionCases });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'M.7967', caseName: 'Ball/Rexam' });

    assert.equal(preview.url, BALL_REXAM, 'Ball/Rexam’s decision, not Apax Partners’');
    assert.equal(preview.title, 'M.7567 – BALL / REXAM');
    assert.deepEqual(preview.numberMismatch, {
      cited: 'M.7967', citedTitle: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', name: 'Ball/Rexam', caseNumber: 'M.7567',
    });
  });

  test('where no case carries the name, shows no decision and searches the register for the name', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher, commissionCases });

    const previews = await resolver.resolve({ source: 'commission', value: 'M.7967', caseName: 'Nonexistent/Parties' });

    assert.equal(previews.length, 1);
    assert.equal(previews[0].url, 'https://competition-cases.ec.europa.eu/search?query=Nonexistent%2FParties');
    assert.equal(previews[0].title, 'M.7967 – Nonexistent/Parties', 'as the footnote wrote it, since nothing else is known to be it');
    assert.equal(previews[0].numberMismatch?.caseNumber, undefined);
    assert.equal(previews[0].numberMismatch?.citedTitle, 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING');
  });

  test('a name that agrees is the case as cited, titled as the register titles it', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([]).fetcher, commissionCases });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'M.7567', caseName: 'Ball/Rexam' });

    assert.equal(preview.url, BALL_REXAM);
    assert.equal(preview.title, 'M.7567 – BALL / REXAM');
    assert.equal(preview.numberMismatch, undefined);
  });
});

/**
 * Reading the decision, rather than linking it.
 *
 * Driven through the document store rather than through a real PDF: `extractPdfText` is
 * exercised against the real files by hand and by the corpus run — Microsoft/LinkedIn and
 * Intel both agree with `pdftotext` exactly, 451 recital markers against 451 and 1,857
 * against 1,857 — and a 4MB PDF has no business in `npm run verify`. What is pinned here is
 * everything the resolver decides once the text is in hand.
 */
describe('the passage of a Commission decision', () => {
  const URL_2009 = 'https://ec.europa.eu/competition/antitrust/cases/dec_docs/37990/37990_3581_18.pdf';
  const URL_2023 = 'https://ec.europa.eu/competition/antitrust/cases1/202346/AT_37990_9687627_5129_3.pdf';

  const attachment = (link: string, date: string) => ({
    metadata: {
      attachmentLink: [link],
      attachmentCategory: [JSON.stringify({ code: 'c', label: 'Prohibition Decision (Art. 7)' })],
      attachmentLanguage: ['EN'],
      attachmentDocumentDate: [date],
    },
  });

  const loaderFor = (attachments: ReturnType<typeof attachment>[]) => {
    const index = buildCommissionCaseIndex([
      JSON.stringify({ 'AT.37990': { decisions: [{ decisionAttachments: attachments }] } }),
    ]);
    return { get: async () => index };
  };

  const DECISION_TEXT = [
    '(999) An earlier recital of the decision.',
    '(1000) The Commission concludes that the rebates were capable of foreclosing.',
    '(1001) The recital after the one cited.',
  ].join('\n');

  /** Decisions already read, which is the state every second citation of a case arrives in. */
  async function storeHolding(...texts: string[]) {
    const store = createMemoryDocumentStore();
    const urls = [URL_2009, URL_2023];
    for (const [at, text] of texts.entries()) {
      await store.set(decisionTextKey(urls[at]), { html: text, etag: '"decision"', fetchedAt: 1_000 });
    }
    return store;
  }

  test('cuts the cited recital out of the decision itself', async () => {
    const documentStore = await storeHolding(DECISION_TEXT);
    const { fetcher } = stubFetcher([new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^\(1000\) The Commission concludes/);
    assert.ok(!preview.excerpt.includes('(1001)'), 'and stops where the next recital begins');
    assert.equal(preview.url, URL_2009, 'the link opens what the passage was cut from');
    assert.ok(preview.verifiedAt, 'a passage confirmed against the publisher says when');
    assert.equal(preview.confirmation, undefined, 'and confirmed is the default, so nothing is pending');
  });

  test('text an older extraction left in the cache is read again, not cut from', async () => {
    // Outokumpu/Inoxum recital (510) kept showing `EN 101 EN` from the disk cache after the
    // extraction learned to drop the page mark.
    const documentStore = createMemoryDocumentStore();
    await documentStore.set(`pdf:${URL_2009}`, { html: DECISION_TEXT, etag: '"decision"', fetchedAt: 1_000 });
    const { fetcher, calls } = stubFetcher([new Response(null, { status: 503 })]);
    const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('if-none-match'), null, 'the old text is not revalidated as if current');
    assert.notEqual(preview.passage, 'cited', 'and no passage is cut from it');
  });

  test('asked to confirm later, a decision already held answers without touching the wire', async () => {
    // What makes a second look at a decision instant. The text is held; the second it used to
    // cost was the turn at the wire its `304` waited for, and a case with several decisions
    // waited for several.
    const documentStore = await storeHolding(DECISION_TEXT, '(1) A short procedural decision in the same case.');
    const { fetcher, calls } = stubFetcher([]);
    const { resolver, clock } = makeResolver({
      fetcher, documentStore,
      commissionCases: loaderFor([attachment(URL_2009, '2009-05-13'), attachment(URL_2023, '2023-09-22')]),
    });
    clock.advance(86_400_000);

    const previews = await resolver.resolve(
      { source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } },
      { confirm: 'later' },
    );

    assert.equal(calls.length, 0);
    assert.deepEqual(clock.slept, [], 'nor waited for a turn at it');
    assert.equal(previews.length, 1);
    assert.equal(previews[0].passage, 'cited');
    assert.match(previews[0].excerpt, /^\(1000\) The Commission concludes/);
    assert.equal(previews[0].confirmation, 'pending');
    assert.equal(previews[0].verifiedAt, new Date(1_000).toISOString(),
      'the time it was last confirmed, not the time of this answer');
  });

  test('asked again without it, the held decision is confirmed', async () => {
    const documentStore = await storeHolding(DECISION_TEXT);
    const { fetcher, calls } = stubFetcher([new Response(null, { status: 304 })]);
    const { resolver, clock } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });
    const lookup: EuLookup = { source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } };

    await resolver.resolve(lookup, { confirm: 'later' });
    clock.advance(60_000);
    const [confirmed] = await resolver.resolve(lookup);

    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('if-none-match'), '"decision"', 'a conditional request, not a download');
    assert.equal(confirmed.confirmation, undefined);
    assert.equal(confirmed.verifiedAt, new Date(clock.now()).toISOString());
  });

  test('a confirmation that cannot reach the Commission keeps the old date, and is not pending', async () => {
    // The pane asks once, and a pending mark nothing will ever clear would say "checking"
    // forever. So a failed confirmation answers as a confirmed one would have failed today:
    // the held text, dated when it really was last confirmed.
    const documentStore = await storeHolding(DECISION_TEXT);
    const { fetcher } = stubFetcher([new Error('ECONNRESET')]);
    const { resolver, clock } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });
    clock.advance(60_000);

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(preview.passage, 'cited');
    assert.equal(preview.confirmation, undefined);
    assert.equal(preview.verifiedAt, new Date(1_000).toISOString());
  });

  test('a decision never read is fetched even when confirmation may wait', async () => {
    // There is nothing held to answer from, so `later` has nothing to offer here.
    const { fetcher, calls } = stubFetcher([new Error('ECONNRESET')]);
    const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve(
      { source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } },
      { confirm: 'later' },
    );

    assert.equal(calls.length, 1);
    assert.equal(preview.confirmation, undefined, 'nothing was answered from a held copy');
    assert.equal(preview.url, URL_2009);
  });

  test('a decision published as a scan says so, and shows no passage', async () => {
    // Stored as an empty string: that records "fetched, and there is no text in it", so the
    // next citation of the same decision does not download 4MB to learn it again.
    const documentStore = await storeHolding('');
    const { fetcher } = stubFetcher([new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(preview.passage, 'unreadable');
    assert.equal(preview.excerpt, '', 'nothing is put on screen under the citation');
    assert.equal(preview.url, URL_2009);
  });

  test('a recital the decision does not carry falls back to its opening', async () => {
    const documentStore = await storeHolding('THE EUROPEAN COMMISSION, having regard to the Treaty, HAS ADOPTED THIS DECISION.');
    const { fetcher } = stubFetcher([new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(preview.passage, 'opening', 'said to be the opening, never presented as the passage');
    assert.match(preview.excerpt, /^THE EUROPEAN COMMISSION/);
  });

  test('of two decisions, the one carrying the cited recital is the answer', async () => {
    // Which decision was meant is settled by evidence rather than by date. Measured on
    // Dow/DuPont: the decision of 27 March 2017 carries 5,269 recitals including 1975, and
    // neither of the two published on 28 July 2017 carries any.
    const documentStore = await storeHolding(DECISION_TEXT, '(1) A short procedural decision in the same case.');
    const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({
      fetcher, documentStore,
      commissionCases: loaderFor([attachment(URL_2009, '2009-05-13'), attachment(URL_2023, '2023-09-22')]),
    });

    const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(previews.length, 1, 'the ambiguity is resolved, not handed over');
    assert.equal(previews[0].passage, 'cited');
    assert.equal(previews[0].url, URL_2009, 'the decision that actually has recital 1000');
    assert.match(previews[0].excerpt, /^\(1000\) The Commission concludes/);
  });

  test('two decisions carrying the same recital is an ambiguity, not a pick', async () => {
    // Here the citation genuinely does not distinguish them, so both are offered and neither
    // is opened — the failure this guards against is the right paragraph of the wrong decision.
    const documentStore = await storeHolding(DECISION_TEXT, DECISION_TEXT);
    const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({
      fetcher, documentStore,
      commissionCases: loaderFor([attachment(URL_2009, '2009-05-13'), attachment(URL_2023, '2023-09-22')]),
    });

    const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(previews.length, 2);
    for (const preview of previews) assert.equal(preview.passage, undefined, 'neither is presented as the passage');
  });

  describe('the date a footnote gives the decision', () => {
    // Microsoft (AT.37792): ten decisions in the register, more than are read to find the
    // recital, so "EC decision of 24 March 2004 … para. 841" was answered with ten links.
    const others = ['2005-11-10', '2006-03-10', '2006-07-12', '2008-02-27', '2009-03-04']
      .map((date, at) => attachment(`https://ec.europa.eu/competition/antitrust/cases/dec_docs/37792/other_${at}.pdf`, date));

    test('says which of many it cites', async () => {
      const documentStore = await storeHolding(DECISION_TEXT);
      const { fetcher, calls } = stubFetcher([new Response(null, { status: 304 })]);
      const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([...others, attachment(URL_2009, '2004-03-24')]) });

      const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', decisionDate: '2004-03-24', locator: { kind: 'point', start: 1000 } });

      assert.equal(previews.length, 1);
      assert.equal(previews[0].passage, 'cited');
      assert.equal(previews[0].url, URL_2009);
      assert.equal(calls.length, 1, 'only the decision of that date is read');
    });

    test('narrows nothing where no decision is dated so', async () => {
      const { fetcher } = stubFetcher([]);
      const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([...others, attachment(URL_2009, '2004-03-24')]) });
      const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', decisionDate: '1999-01-01', locator: { kind: 'point', start: 1000 } });
      assert.equal(previews.length, 6, 'every decision offered, as before');
    });
  });

  describe('a decision about an earlier decision in the case', () => {
    // Hoffmann-La Roche/Boehringer Mannheim (M.950), cited at paragraph 13: the register
    // holds only the 2011 decision waiving the commitments — its recital (1) opens "By
    // Decision 98/526/EC of 4 February 1998 in Case No IV/M.950" — and not the 1998 decision
    // itself. Its recital (13) was shown as the paragraph cited: the right number of the
    // wrong decision.
    const WAIVER = [
      '(1) By Decision 98/526/EC of 4 February 1998 in Case No IV/M.950 - Hoffmann La Roche/Boehringer Mannheim the Commission declared the concentration compatible.',
      ...Array.from({ length: 12 }, (_, at) => `(${at + 2}) The waiver of the commitments is considered in point ${at + 2}.`),
    ].join('\n');

    test('is not given as the passage cited', async () => {
      const documentStore = await storeHolding(WAIVER);
      const { fetcher } = stubFetcher([new Response(null, { status: 304 })]);
      const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2011-05-04')]) });

      const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 13 } });

      assert.equal(preview.passage, undefined, 'a link, not a passage');
      assert.equal(preview.url, URL_2009);
    });

    test('and still stands against another decision carrying the same number', async () => {
      // Excluding it would hand the answer to the other decision — wrong whenever the
      // later one is the decision cited, as a re-adopted decision can be.
      const main = Array.from({ length: 30 }, (_, at) => `(${at + 1}) The concentration is assessed in point ${at + 1}.`).join('\n');
      const documentStore = await storeHolding(main, WAIVER);
      const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
      const { resolver } = makeResolver({
        fetcher, documentStore,
        commissionCases: loaderFor([attachment(URL_2009, '1998-02-04'), attachment(URL_2023, '2011-05-04')]),
      });

      const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 13 } });

      assert.equal(previews.length, 2);
      for (const preview of previews) assert.equal(preview.passage, undefined);
    });
  });

  describe('one decision published in several languages', () => {
    // Lufthansa/Austrian Airlines (M.5440), cited at recital 85: the register lists the
    // decision in English, French and German — the French one with no language at all — and
    // all three carry a recital 85, numbered 1 to 406 alike. Treated as three decisions, the
    // citation was answered with three links and no passage.
    const numbered = (count: number, recital: (at: number) => string) =>
      Array.from({ length: count }, (_, at) => `(${at + 1}) ${recital(at + 1)}`).join('\n');
    const ENGLISH = numbered(406, (at) => `The Commission considers that the effects of the transaction are set out in point ${at}.`);
    const FRENCH = numbered(406, (at) => `La Commission considère que les effets de la concentration sont exposés au considérant ${at}.`);

    test('are one decision, shown in English', async () => {
      const documentStore = await storeHolding(FRENCH, ENGLISH);
      const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
      const { resolver } = makeResolver({
        fetcher, documentStore,
        commissionCases: loaderFor([attachment(URL_2009, '2010-02-11'), attachment(URL_2023, '2009-08-28')]),
      });

      const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 85 } });

      assert.equal(previews.length, 1);
      assert.equal(previews[0].passage, 'cited');
      assert.equal(previews[0].url, URL_2023, 'the English version');
      assert.match(previews[0].excerpt, /^\(85\) The Commission considers/);
    });

    test('numbered differently, they are two decisions and neither is picked', async () => {
      const documentStore = await storeHolding(numbered(120, () => 'La Commission considère que la concentration est compatible.'), ENGLISH);
      const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
      const { resolver } = makeResolver({
        fetcher, documentStore,
        commissionCases: loaderFor([attachment(URL_2009, '2010-02-11'), attachment(URL_2023, '2009-08-28')]),
      });

      const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 85 } });

      assert.equal(previews.length, 2);
      for (const preview of previews) assert.equal(preview.passage, undefined);
    });
  });

  test('a recital no decision in the case carries leaves both as links', async () => {
    const documentStore = await storeHolding('(1) One decision.', '(2) The other decision.');
    const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({
      fetcher, documentStore,
      commissionCases: loaderFor([attachment(URL_2009, '2009-05-13'), attachment(URL_2023, '2023-09-22')]),
    });

    const previews = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(previews.length, 2);
    for (const preview of previews) assert.equal(preview.passage, undefined);
  });

  test('every recital a footnote cites is shown, and one the decision lacks is reported', async () => {
    // Tata Steel/thyssenkrupp, cited "paragraphs 189 et seq., 1324 et seq. and 1398 et seq.":
    // the list reaches the resolver whole now, and a recital not found must not be passed
    // over in silence while the others are shown as the passage cited.
    const documentStore = await storeHolding(DECISION_TEXT);
    const { resolver } = makeResolver({ fetcher: stubFetcher([new Response(null, { status: 304 })]).fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({
      source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 999 }, paragraphs: [999, 1001, 1398],
    });

    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^\(999\) An earlier recital/);
    assert.match(preview.excerpt, /\n\n…\n\n\(1001\) The recital after/);
    assert.ok(!preview.excerpt.includes('(1000)'), 'what was not cited is not shown');
    assert.deepEqual(preview.unlocated, ['1398']);
  });

  test('of two decisions, the one carrying every cited recital is the answer', async () => {
    // A short decision in the same case reaching recital 999 is not the decision a footnote
    // citing 999 and 1001 means: it lacks a passage the footnote says is there.
    const documentStore = await storeHolding(DECISION_TEXT, '(999) A procedural recital of a later decision.');
    const { fetcher } = stubFetcher([new Response(null, { status: 304 }), new Response(null, { status: 304 })]);
    const { resolver } = makeResolver({
      fetcher, documentStore,
      commissionCases: loaderFor([attachment(URL_2009, '2009-05-13'), attachment(URL_2023, '2023-09-22')]),
    });

    const previews = await resolver.resolve({
      source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 999 }, paragraphs: [999, 1001],
    });

    assert.equal(previews.length, 1);
    assert.equal(previews[0].url, URL_2009);
    assert.equal(previews[0].unlocated, undefined);
  });

  test('a decision cited by a numbered section shows that section', async () => {
    // "Case M.10658 – Norsk Hydro/Alumetal, section 9.1.3.3.7", from the 2026 draft merger guidelines.
    const documentStore = await storeHolding([
      '9.1.3.3.7. The Parties are not close competitors .................... 60',
      '9.1.3.3.7. The Parties are not close competitors',
      '(299) The Commission considers that the Parties have differentiated offerings.',
      '9.1.3.3.8. Conclusion',
      '(322) Based on the analysis of the evidence.',
    ].join('\n'));
    const { resolver } = makeResolver({ fetcher: stubFetcher([new Response(null, { status: 304 })]).fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({
      source: 'commission', value: 'AT.37990', locator: { kind: 'section', start: 9, sections: [{ from: '9.1.3.3.7' }] },
    });

    assert.equal(preview.passage, 'cited');
    assert.equal(preview.locator, 'Section 9.1.3.3.7');
    assert.equal(preview.excerpt, '9.1.3.3.7. The Parties are not close competitors\n(299) The Commission considers that the Parties have differentiated offerings.');
  });

  test('a citation with no pinpoint is a link, not a download', async () => {
    // There is no passage to cut, so there is nothing to spend four megabytes on.
    const documentStore = await storeHolding(DECISION_TEXT);
    const { fetcher, calls } = stubFetcher([]);
    const { resolver } = makeResolver({ fetcher, documentStore, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990' });

    assert.equal(calls.length, 0);
    assert.equal(preview.passage, undefined);
    assert.equal(preview.url, URL_2009);
  });

  test('a decision that will not download keeps the link', async () => {
    const { fetcher } = stubFetcher([new Error('ECONNRESET')]);
    const { resolver } = makeResolver({ fetcher, commissionCases: loaderFor([attachment(URL_2009, '2009-05-13')]) });

    const [preview] = await resolver.resolve({ source: 'commission', value: 'AT.37990', locator: { kind: 'point', start: 1000 } });

    assert.equal(preview.passage, undefined, 'no passage is claimed');
    assert.equal(preview.url, URL_2009, 'and the decision is still one click away');
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
    assert.equal(preview.unlocated, undefined, 'both were found, so nothing is reported missing');
  });

  test('a paragraph of a disjoint citation that is not in the text is reported, not dropped', async () => {
    // Showing 62 alone for "paras 62 and 70" presents half the citation as all of it.
    const { fetcher } = stubFetcher([judgment([61, 62, 63])]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve({ ...lookup(62), paragraphs: [62, 70, 71] });
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /Text of paragraph 62\./);
    assert.deepEqual(preview.unlocated, ['70–71']);
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

describe('asking CELLAR by the ECLI the footnote wrote', () => {
  // The CELEX Ibid sends is *derived* — sector letter from the document type, year from the
  // case number — while the ECLI is quoted verbatim from the footnote. The ECLI is asked
  // first, because the two can name different documents, and the ECLI is the one the drafter
  // wrote down. CELLAR also holds some case law only under its ECLI: every identifier the
  // corpus run recorded as "unavailable" resolves this way, confirmed live on 2026-08-21.
  const order = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'ECLI:EU:T:2024:431', caseNumber: 'C-511/24',
    caseName: 'Aylo Freesites LTD v Commission', celex: '62024TO0511',
    ecli: 'ECLI:EU:T:2024:431', documentType: 'order', ...overrides,
  });
  const ECLI_URL = 'https://example.test/ecli/ECLI%3AEU%3AT%3A2024%3A431';

  test('retrieves the document the footnote actually named', async () => {
    const { fetcher, calls } = stubFetcher([
      documentResponse('<P class="C01PointnumeroteAltN"><A NAME="point112">112</A>The order says this.</P>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(order({ locator: { kind: 'point', start: 112 }, paragraphs: [112] }));

    assert.equal(calls[0].url, ECLI_URL, 'the ECLI is percent-encoded onto the sibling /ecli base, never interpolated raw');
    assert.equal(preview.source, 'CURIA');
    assert.equal(preview.locator, 'Point 112');
    assert.ok(preview.excerpt.includes('The order says this.'), preview.excerpt);
    assert.ok(preview.verifiedAt, 'it was retrieved, so it carries a confirmation time');
    // The link has to be the address that answered.
    assert.equal(preview.url, ECLI_URL);
  });

  test('never asks by the CELEX when the ECLI answered', async () => {
    const { fetcher, calls } = stubFetcher([documentResponse('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(order());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/ecli/'));
  });

  test('an ECLI CELLAR has never heard of costs one request before the CELEX', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('ECLI'), documentResponse('<p>text</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(order());
    assert.deepEqual(calls.map((call) => call.url), [ECLI_URL, 'https://example.test/celex/62024TO0511']);
    assert.equal(preview.url, 'https://example.test/celex/62024TO0511');
  });

  test('never asks by the CELEX when the failure was not a 404', async () => {
    // A second identifier does not fix a server failing for an unrelated reason — the same
    // rule the rendition chain follows, one level up.
    const { fetcher, calls } = stubFetcher([new Response('nope', { status: 400 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await assert.rejects(resolver.resolve(eurLexLookup({ ecli: 'ECLI:EU:C:2014:238' })), /lookup failed \(400\)/);
    assert.equal(calls.length, 1);
  });

  test('holds what the ECLI returned under its own key, and revalidates it next time', async () => {
    const { fetcher, calls } = stubFetcher([documentResponse('<p>Article 1</p><p>the order</p>'), notModified()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(order({ locator: { kind: 'point', start: 1 } }));
    const [second] = await resolver.resolve(order({ locator: { kind: 'point', start: 2 } }));

    assert.equal(calls.length, 2, 'the second lookup goes straight to the ECLI it worked under, and confirms it');
    assert.equal(calls[1].url, ECLI_URL);
    assert.equal((calls[1].init.headers as Record<string, string>)['If-None-Match'], '"Con-20190721062819000"');
    assert.ok(second.excerpt.includes('the order'));
  });

  test('falls back to the CURIA link only once both identifiers are exhausted', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('ECLI'), noSuchDocument('62024TO0511')]);
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

describe('a footnote that calls an Opinion a judgment', () => {
  // Footnote 460 of the Commission's 2026 draft merger guidelines: "Judgment of 15 December
  // 2002, Superleague v FIFA, C-333/21, EU:C:2022:993, paragraph 251". The word "Judgment"
  // derives 62021CJ0333, the judgment; EU:C:2022:993 is Advocate General Rantos's Opinion
  // (CELLAR's own metadata, checked 2026-09-17), which is the document the footnote named.
  const superleague = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'EU:C:2022:993', caseNumber: 'C-333/21', caseName: 'Superleague v FIFA',
    celex: '62021CJ0333', ecli: 'ECLI:EU:C:2022:993', documentType: 'judgment',
    locator: { kind: 'point', start: 251 }, paragraphs: [251], ...overrides,
  });
  const OPINION = () => documentResponse('<p>OPINION OF ADVOCATE GENERAL RANTOS delivered on 15 December 2022</p>'
    + '<P class="C01PointnumeroteAltN"><A NAME="point251">251</A>The Advocate General says this.</P>');
  const JUDGMENT = () => documentResponse('<p>JUDGMENT OF THE COURT (Grand Chamber)</p>'
    + '<p>after hearing the Opinion of the Advocate General</p>'
    + '<P class="C01PointnumeroteAltN"><A NAME="point251">251</A>The Court says this.</P>');
  const OPINION_URL = `https://example.test/ecli/${encodeURIComponent('ECLI:EU:C:2022:993')}`;

  test('shows the Opinion its ECLI names, and says what it is', async () => {
    const { fetcher, calls } = stubFetcher([OPINION()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(superleague());
    assert.deepEqual(calls.map((call) => call.url), [OPINION_URL]);
    assert.ok(preview.excerpt.includes('The Advocate General says this.'), preview.excerpt);
    assert.equal(preview.documentType, 'opinion');
    assert.equal(preview.title, 'Superleague v FIFA, C-333/21 (opinion)');
  });

  test('says nothing where the document is what the citation called it', async () => {
    const { fetcher } = stubFetcher([JUDGMENT()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [preview] = await resolver.resolve(superleague({ ecli: 'ECLI:EU:C:2023:1011', value: 'EU:C:2023:1011' }));
    assert.equal(preview.documentType, undefined, 'the lower-case "Opinion of the Advocate General" in a judgment is not its heading');
    assert.equal(preview.title, 'Superleague v FIFA, C-333/21');
  });

  test('the judgment already held under the derived CELEX is not served in its place', async () => {
    // The store a deployment already has was filled while the CELEX came first. The judgment
    // cited in footnote 39 is held under 62021CJ0333, the same CELEX footnote 460 derives, and
    // the same paragraph under both would also have shared one cached excerpt.
    const { fetcher, calls } = stubFetcher([JUDGMENT(), OPINION()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    const [judgment] = await resolver.resolve(superleague({ ecli: undefined }));
    const [opinion] = await resolver.resolve(superleague());

    assert.ok(judgment.excerpt.includes('The Court says this.'));
    assert.deepEqual(calls.map((call) => call.url), ['https://example.test/celex/62021CJ0333', OPINION_URL]);
    assert.ok(opinion.excerpt.includes('The Advocate General says this.'), opinion.excerpt);
  });

  test('an ECLI CELLAR does not know still reaches the document held under the CELEX', async () => {
    const { fetcher, calls } = stubFetcher([JUDGMENT(), noSuchDocument('ECLI'), notModified()]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });

    await resolver.resolve(superleague({ ecli: undefined }));
    const [preview] = await resolver.resolve(superleague({ ecli: 'ECLI:EU:C:2099:1', locator: { kind: 'point', start: 251 }, paragraphs: [251, 252] }));

    assert.deepEqual(calls.map((call) => call.url), [
      'https://example.test/celex/62021CJ0333',
      `https://example.test/ecli/${encodeURIComponent('ECLI:EU:C:2099:1')}`,
      'https://example.test/celex/62021CJ0333',
    ], 'one request to learn the ECLI names nothing, then the held document confirmed as before');
    assert.ok(preview.excerpt.includes('The Court says this.'));
  });
});

describe('documentTypeOf', () => {
  test('reads the heading a court document opens with, in English and in French', () => {
    assert.equal(documentTypeOf('<p>JUDGMENT OF THE GENERAL COURT (Ninth Chamber)</p>'), 'judgment');
    assert.equal(documentTypeOf('<p>OPINION OF ADVOCATE GENERAL WAHL</p><p>delivered on 20 October 2016</p>'), 'opinion');
    assert.equal(documentTypeOf('<p>ORDER OF THE PRESIDENT OF THE GENERAL COURT</p>'), 'order');
    assert.equal(documentTypeOf('<p>ARRÊT DU TRIBUNAL (deuxième chambre élargie)</p>'), 'judgment');
    assert.equal(documentTypeOf("<p>CONCLUSIONS DE L'AVOCAT GÉNÉRAL</p>"), 'opinion');
  });

  test('takes the first heading, and says nothing where there is none', () => {
    assert.equal(documentTypeOf('<p>(see para. 52) JUDGMENT OF THE COURT</p><p>… ORDER OF THE COURT of 3 May …</p>'), 'judgment');
    assert.equal(documentTypeOf('<p>Judgment of the Court of 3 July 1991. AKZO Chemie BV v Commission</p>'), undefined);
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
    // A service in trouble (503); a plain 500 is one rendition's, and the next is asked — see
    // "a rendition CELLAR fails on".
    const { fetcher, calls } = stubFetcher([
      new Response('boom', { status: 503 }),
      new Response('boom', { status: 503 }),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 1 });

    await assert.rejects(resolver.resolve(eurLexLookup()), /lookup failed \(503\)/);
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

  test('comes after the ECLI and the CELEX, which the citation itself carries', async () => {
    const { fetcher, calls } = stubFetcher([noSuchDocument('ECLI'), noSuchDocument('62012CJ0594'), html('<p>Judgment text, point 65.</p>')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    await resolver.resolve(joined({ ecli: 'ECLI:EU:C:2014:238' }));
    assert.deepEqual(calls.map((call) => call.url), [
      `https://example.test/ecli/${encodeURIComponent('ECLI:EU:C:2014:238')}`,
      'https://example.test/celex/62012CJ0594',
      'https://example.test/celex/62012CJ0293',
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

/**
 * The Reports published many orders — the President's interim-measures orders above all —
 * as a summary rather than a text: title, catchwords, subject-matter, operative part, and
 * not one paragraph of the grounds. That summary is the whole of what CELLAR holds under
 * the CELEX, in every language.
 *
 * Recital 91 of the Commission's Intel decision cites paragraph 87 of the order in
 * T-457/08 R. The paragraph exists — the 2014 judgment in T-286/09 restates it at its own
 * paragraph 332 — and EUR-Lex holds 2,945 bytes of summary in which no paragraph 87 could
 * ever appear. Told as an ordinary miss, that reads as a broken tool, and the first reviewer
 * who read it went looking for a fault that was not there.
 *
 * The fixtures below are the real markup, cut down: CURIA's `REF` rendition marker in the
 * filename comment, and the summary's own operative-part heading class.
 */
describe('a document EUR-Lex holds only in summary', () => {
  const summary = (marker: string) => html(
    `<!--Filename : ${marker}-->`
    + '<P class="C10Titre"><B>Order of the President of 27 January 2009 \u2013 Intel v Commission</B></P>'
    + '<P class="C10Titre"><B>(Case T-457/08 R)</B></P>'
    + '<P class="C03MotCle">Application for interim measures (see paras 46-48)</P>'
    + '<P class="C11ObjetIntroduction"><B>Re: </B></P>'
    + '<P class="C12DispositifIntroduction"><B>Operative part</B></P>'
    + '<P class="C13Dispositifnonnumerote">Dismisses the application for interim relief.</P>',
  );

  const orderLookup = (overrides: Partial<EuLookup> = {}): EuLookup => ({
    source: 'curia', value: 'T-457/08 R', caseNumber: 'T-457/08 R', celex: '62008TO0457',
    documentType: 'order', locator: { kind: 'point', start: 87 }, paragraphs: [87], ...overrides,
  });

  test('says the text was never published here, rather than blaming retrieval', async () => {
    const { fetcher } = stubFetcher([summary('RTO@TRA-DOC-EN-REF-T-0457-2008-200905691-05_00')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(orderLookup());
    assert.equal(preview.passage, 'summary');
  });

  test('sends the reviewer to CURIA, which has the grounds', async () => {
    const { fetcher } = stubFetcher([summary('RTO@TRA-DOC-EN-REF-T-0457-2008-200905691-05_00')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(orderLookup());
    assert.equal(preview.fullTextUrl, 'https://curia.europa.eu/juris/liste.jsf?language=en&num=T-457%2F08%20R');
    // The card's own link still opens what the excerpt was cut from. Two links, each
    // meaning what it says.
    assert.equal(preview.url, 'https://example.test/celex/62008TO0457');
  });

  test('recognises the summary by its operative-part heading, with no filename marker', async () => {
    // Not every rendition carries the comment; the class is the second, independent signal.
    // A full text spells the same heading `C41DispositifIntroduction`, so the number is
    // what separates them.
    const { fetcher } = stubFetcher([summary('nothing-recognisable-here')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(orderLookup());
    assert.equal(preview.passage, 'summary');
  });

  test('does not claim it of a full text whose paragraph simply was not found', async () => {
    // The classic-era full-text rendition of an order: an `ORD` marker, numbered points, and
    // the operative part under its own class. An ordinary miss here must keep saying so, and
    // must not offer a CURIA link implying there is more text elsewhere.
    const { fetcher } = stubFetcher([html(
      '<!--Filename : BDU@TRA-DOC-EN-ORD-T-0393-2010-200910123-05_00-->'
      + '<P class="C01PointnumeroteAltN"><A NAME="point1">1</A></P><P>First.</P>'
      + '<P class="C41DispositifIntroduction"><B>On those grounds,</B></P>',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(orderLookup({ locator: { kind: 'point', start: 99 }, paragraphs: [99] }));
    assert.equal(preview.passage, 'opening');
    assert.equal(preview.fullTextUrl, undefined);
  });

  test('never overrides a passage that was found', async () => {
    // As with an extract judgment, this only ever chooses the wording of an explanation for
    // a passage already missing. One that is present is returned as cited.
    const { fetcher } = stubFetcher([html(
      '<!--Filename : RTO@TRA-DOC-EN-REF-T-0457-2008-200905691-05_00-->'
      + '<P class="C12DispositifIntroduction"><B>Operative part</B></P>'
      + '<p class="coj-count" id="point87">87</p><p>The cited paragraph, present after all.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0 });
    const [preview] = await resolver.resolve(orderLookup());
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /present after all/);
    assert.equal(preview.fullTextUrl, undefined);
  });
});

/**
 * The passage shown must be the passage cited, and nothing else.
 *
 * Two ways a correct document could still put the wrong words on screen under a citation.
 * The same number heads more than one paragraph — a provision quoted with its own numbering,
 * a summary numbered from 1 above the grounds — and the first to appear is not always the
 * Court's. And the last paragraph of a run has no next paragraph to stop at, so the excerpt
 * ran on into whatever follows it: the operative part, the enacting formula and the articles,
 * the signatures and the annexes.
 */
describe('the cited passage and nothing else', () => {
  test('a quoted provision numbered like a paragraph is said to be there', async () => {
    // Paragraph 1 of the grounds quotes a directive article, whose own paragraphs are numbered
    // "1." and "2." exactly as this era numbers the grounds. The citation is to paragraph 2.
    const { fetcher } = stubFetcher([html(
      '<p>1. The directive provides, in Article 3:</p>'
      + '<p>1. Member States shall ensure that the quoted provision applies.</p>'
      + '<p>2. The quoted provision’s second paragraph.</p>'
      + '<p>2. The grounds’ own second paragraph, the one cited.</p>'
      + '<p>3. The third paragraph of the grounds.</p>'
      + '<p>4. The fourth.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0202', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));
    // Which "2." is the Court's cannot be read off the numbering (see `headingRepeats`), so
    // the first is shown as before — and the reviewer is told there is another.
    assert.deepEqual(preview.repeated, ['2']);
  });

  test('so is a summary numbered from 1 above the grounds', async () => {
    const summary = ['The right of access', 'Rights of defence', 'Fines'].map((text, index) => `<p>${index + 1}. Summary: ${text}.</p>`).join('');
    const grounds = [1, 2, 3, 4, 5, 6].map((n) => `<p>${n}. Grounds paragraph ${n}${n === 2 ? ', the one cited' : ''}.</p>`).join('');
    const { fetcher } = stubFetcher([html(summary + grounds)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0202', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));
    assert.deepEqual(preview.repeated, ['2']);
  });

  test('a paragraph whose number appears once is not flagged', async () => {
    const { fetcher } = stubFetcher([html([1, 2, 3].map((n) => `<p>${n}. Grounds paragraph ${n}.</p>`).join(''))]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0202', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));
    assert.ok(preview.excerpt.includes('Grounds paragraph 2'));
    assert.equal(preview.repeated, undefined);
  });

  test('the last paragraph of the grounds stops where the operative part begins', async () => {
    const { fetcher } = stubFetcher([html(
      '<p class="count" id="point74">74</p><p>The penultimate paragraph.</p>'
      + '<p class="count" id="point75">75</p><p>Since the Commission has been unsuccessful, it must be ordered to pay the costs.</p>'
      + '<p>On those grounds, the Court (Grand Chamber) hereby:</p>'
      + '<p>1. Sets aside the judgment of the General Court;</p><p>2. Orders the Commission to pay the costs.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 75 }, paragraphs: [75] }));
    assert.ok(preview.excerpt.includes('ordered to pay the costs'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('On those grounds'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('Sets aside'), preview.excerpt);
  });

  test('the last recital stops at the enacting formula, before the articles', async () => {
    const { fetcher } = stubFetcher([html(
      '<p>(49) The penultimate recital.</p>'
      + '<p>(50) Since the objectives of this Regulation cannot be sufficiently achieved by the Member States.</p>'
      + '<p>HAVE ADOPTED THIS REGULATION:</p>'
      + '<p>Article 1</p><p>1. This Regulation lays down rules on something else entirely.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'point', start: 50 }, paragraphs: [50] }));
    assert.ok(preview.excerpt.includes('cannot be sufficiently achieved'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('HAVE ADOPTED'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('something else entirely'), preview.excerpt);
  });

  test('the last article stops before the signatures and the annexes', async () => {
    const { fetcher } = stubFetcher([html(
      '<p>Article 21</p><p>1. The penultimate article.</p>'
      + '<p>Article 22</p><p>This Regulation shall enter into force on the twentieth day following that of its publication.</p>'
      + '<p>This Regulation shall be binding in its entirety and directly applicable in all Member States.</p>'
      + '<p>Done at Brussels, 27 April 2016.</p>'
      + '<p>ANNEX I</p><p>1. A list that belongs to the annex.</p>',
    )]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(eurLexLookup({ locator: { kind: 'article', start: 22 } }));
    assert.ok(preview.excerpt.includes('twentieth day'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('Done at Brussels'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('belongs to the annex'), preview.excerpt);
  });
});

describe('a long paragraph', () => {
  test('is shown whole, however much markup it is wrapped in', async () => {
    // Modern renderings wrap words in spans; a cap on raw markup cut this paragraph after
    // under 2,000 characters of its text, mid-tag, and lost the qualification at its end.
    const words = '<span class="bold">It</span> <span>follows</span> <span>from</span> <span>settled</span> <span>case-law.</span> '.repeat(60);
    const { fetcher } = stubFetcher([html(`<p class="count" id="point7">7</p><p class="normal">${words} That is so, unless the contrary is shown.</p><p class="count" id="point8">8</p><p>Next.</p>`)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 7 }, paragraphs: [7] }));
    assert.ok(preview.excerpt.endsWith('unless the contrary is shown.'), preview.excerpt.slice(-80));
    assert.equal(preview.truncated, undefined);
  });

  test('beyond what can be shown, is cut where a sentence ends and marked', async () => {
    const sentences = Array.from({ length: 1200 }, (_, i) => `Sentence ${i} of a very long paragraph.`).join(' ');
    const { fetcher } = stubFetcher([html(`<p class="count" id="point7">7</p><p>${sentences}</p><p class="count" id="point8">8</p><p>Next.</p>`)]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 7 }, paragraphs: [7] }));
    assert.equal(preview.truncated, true);
    assert.ok(preview.excerpt.endsWith('paragraph. […]'), preview.excerpt.slice(-40));
  });
});

/**
 * The document an ECLI names is the one retrieved (see `loadCellarDocument`), and a mistyped
 * ECLI can be a valid one — another case's. The document states its own case number in its
 * heading, and where that is not the footnote's, the reviewer has to be told: the passage on
 * screen is from a different case than the footnote names.
 */
describe('a judgment of the Court\'s earliest renderings, whose parties are numbered too', () => {
  // Walt Wilhelm (61968CJ0014, 1969), cited at paragraph 6: the parties to the main action
  // are listed "<p>6 . FARBWERKE HOECHST AG, …" before the grounds begin "<p>6 THE EEC TREATY
  // HAS ESTABLISHED ITS OWN SYSTEM OF LAW", and the pane showed the sixth party as the
  // paragraph. A number followed by " ." is a list's or a headnote's, never a paragraph's.
  const judgment = () => html([
    '<p>1 . EEC - COMMUNITY LEGAL SYSTEM - SUPREMACY OF RULES OF COMMUNITY LAW</p>',
    '<p>IN CASE 14/68</p>',
    '<p>5 . FARBENFABRIKEN BAYER AG, LEVERKUSEN,</p>',
    '<p>6 . FARBWERKE HOECHST AG, FRANKFURT-AM-MAIN-HOECHST,</p>',
    '<p>4 MOREOVER THIS INTERPRETATION IS CONFIRMED.</p>',
    '<p>6 THE EEC TREATY HAS ESTABLISHED ITS OWN SYSTEM OF LAW.</p>',
    '<p>7 IT FOLLOWS FROM THE FOREGOING.</p>',
  ].join(''));

  test('shows the paragraph, not the party numbered like it', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([judgment()]).fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-14/68', celex: '61968CJ0014', ecli: 'ECLI:EU:C:1969:4', locator: { kind: 'point', start: 6 }, paragraphs: [6] }));
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^6 THE EEC TREATY HAS ESTABLISHED/);
    assert.equal(preview.repeated, undefined, 'the parties are not a second numbering');
  });
});

describe('a judgment whose operative part opens on a paragraph of its own', () => {
  // IMS Health (C-418/01, 2004): "<p>On those grounds,</p>" and then "THE COURT (Fifth
  // Chamber)," in another element. Paragraph 53, on costs and the judgment's last, was shown
  // with the whole operative part and the signatures after it.
  const judgment = () => html('<p class="count" id="point52">52</p><p>The answer to the question.</p><p class="count" id="point53">53</p><p>The costs incurred are not recoverable.</p><p></p><p>On those grounds,</p><dt><dd></dd><P ALIGN="center">THE COURT (Fifth Chamber),</P></dt><P></P> in answer to the questions referred to it, hereby rules: 1. The refusal constitutes an abuse.');

  test('the last paragraph stops where it begins', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([judgment()]).fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 53 }, paragraphs: [53] }));
    assert.match(preview.excerpt, /are not recoverable\.$/);
  });

  test('but a paragraph of reasoning that opens with the same words does not end the run', async () => {
    const reasoning = html('<p class="count" id="point7">7</p><p>The first ground.</p><p>On those grounds, the plea must be rejected.</p><p class="count" id="point8">8</p><p>Next.</p>');
    const { resolver } = makeResolver({ fetcher: stubFetcher([reasoning]).fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 7 }, paragraphs: [7] }));
    assert.match(preview.excerpt, /the plea must be rejected\.$/);
  });
});

describe('an opinion of the Reports era, its points classed but not anchored', () => {
  // Kokott in Cementbouw (62006CC0202): "<P class="C01PointAltN">44.&nbsp;&nbsp;&nbsp;However,
  // in order to ensure…" — the class the anchored pattern reads, with no anchor, and the
  // number taking a period. Point 44 was answered with the opening.
  test('is read', async () => {
    const opinion = html('<P class="S01PointAltN">1.&nbsp;Headnote one.</P><P class="C01PointAltN">43.&nbsp;&nbsp;&nbsp;The point before.</P><P class="C01PointAltN">44.&nbsp;&nbsp;&nbsp;However, in order to ensure maximum legal certainty.</P><P class="C01PointAltN">45.&nbsp;&nbsp;&nbsp;Next.</P>');
    const { resolver } = makeResolver({ fetcher: stubFetcher([opinion]).fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-202/06 P', celex: '62006CC0202', ecli: 'ECLI:EU:C:2007:255', documentType: 'opinion', locator: { kind: 'point', start: 44 }, paragraphs: [44] }));
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^44\.\s+However, in order to ensure maximum legal certainty\.$/);
  });
});

describe('an opinion numbered with a spaced period', () => {
  // Darmon in Wood Pulp (61985CC0089): "<p>1 . By order of 16 December 1987 the Court
  // decided…", all 82 points so — the shape the parties list of that era takes too.
  test('is read, in ordinary case', async () => {
    const opinion = html('<p>Opinion of Mr Advocate General Darmon delivered on 25 May 1988. - Joined cases 89, 104 and 125 to 129/85.</p><p>1 . By order of 16 December 1987 the Court decided to join the cases.</p><p>2 . The parties to the proceedings agree.</p><p>3 . It is the basis on which the Commission relied.</p>');
    const { resolver } = makeResolver({ fetcher: stubFetcher([opinion]).fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-89/85', celex: '61985CC0089', ecli: 'ECLI:EU:C:1988:258', documentType: 'opinion', locator: { kind: 'point', start: 2 }, paragraphs: [2] }));
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^2 \. The parties to the proceedings agree\.$/);
  });
});

describe('an opinion exported from Word, numbered outside its paragraphs', () => {
  // Tizzano in Commission v Tetra Laval (62003CC0012, 2004): each point is an empty `<p></p>`
  // followed by its number and Word's tab, `<p></p>  73.<span style="mso-tab-count:1">&nbsp;
  // </span> It is plain…`, and no pattern read it: point 73 was answered with the opening.
  // After its own point 5 the opinion quotes the judgment under appeal's paragraphs 11 to 26
  // in the same markup, so the first "11." in the document is the General Court's, not the
  // Advocate General's.
  const point = (n: number, text: string) => `<p></p>  ${n}.<span style="mso-tab-count:1">&nbsp;&nbsp;&nbsp;</span> ${text}`;
  const opinion = () => html([
    '<p>OPINION OF ADVOCATE GENERAL TIZZANO</p><p>delivered 25 May 2004 (1)</p><p>Case C‑12/03 P</p>',
    ...[1, 2, 3, 4].map((n) => point(n, `Own point ${n}.`)),
    point(5, 'The facts are set out in the judgment under appeal as follows:'),
    point(11, 'Quoted paragraph 11 of the judgment under appeal.'),
    point(12, 'Quoted paragraph 12 of the judgment under appeal.'),
    ...[6, 7, 8, 9, 10, 11, 12, 13].map((n) => point(n, `Own point ${n}.`)),
  ].join('\n'));
  const lookup = (n: number) => curiaJudgmentLookup({ caseNumber: 'C-12/03 P', celex: '62003CC0012', ecli: 'ECLI:EU:C:2004:318', documentType: 'opinion', locator: { kind: 'point', start: n }, paragraphs: [n] });

  test('reads the point cited', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([opinion()]).fetcher });
    const [preview] = await resolver.resolve(lookup(8));
    assert.equal(preview.passage, 'cited');
    assert.match(preview.excerpt, /^8\.\s+Own point 8\.$/);
  });

  test('the opinion\'s own point, not the quoted paragraph numbered like it, and says so', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([opinion()]).fetcher });
    const [preview] = await resolver.resolve(lookup(11));
    assert.match(preview.excerpt, /^11\.\s+Own point 11\.$/);
    assert.deepEqual(preview.repeated, ['11']);
  });

  test('its last point stops where the footnotes begin', async () => {
    // Tetra Laval's point 198, the opinion's last, was shown with all 197 of its footnotes
    // after it — 18,000 characters, the case law of the notes presented as the point cited.
    const withNotes = html(`${point(1, 'Own point 1.')}\n${point(2, 'I propose that the Court should dismiss the appeal.')}\n<hr>\n<dl compact=""><dt><A HREF="#Footref1" NAME="Footnote1"> 1</A> –</dt><dd>Original language: Italian.</dd></dl>`);
    const { resolver } = makeResolver({ fetcher: stubFetcher([withNotes]).fetcher });
    const [preview] = await resolver.resolve(lookup(2));
    assert.match(preview.excerpt, /dismiss the appeal\.$/);
  });

  test('and so does a modern opinion\'s', async () => {
    const modern = html('<p class="count" id="point1">1</p><p>Own point 1.</p><p class="count" id="point2">2</p><p>I propose that the Court should dismiss the appeal.</p><p class="note"><span class="note"><a id="footnote1" href="#footref1">1</a></span> Original language: English.</p>');
    const { resolver } = makeResolver({ fetcher: stubFetcher([modern]).fetcher });
    const [preview] = await resolver.resolve(lookup(2));
    assert.match(preview.excerpt, /dismiss the appeal\.$/);
  });

  test('a point that introduces a quotation carries it', async () => {
    const { resolver } = makeResolver({ fetcher: stubFetcher([opinion()]).fetcher });
    const [preview] = await resolver.resolve(lookup(5));
    assert.match(preview.excerpt, /as follows:[\s\S]*Quoted paragraph 12/);
    assert.ok(!preview.excerpt.includes('Own point 6'));
  });
});

describe('a document of another case than the footnote names', () => {
  const heading = (cases: string) => html(`<p>JUDGMENT OF THE COURT (Grand Chamber)</p><p>6 September 2017</p><p>${cases},</p><p>APPEAL under Article 56 of the Statute</p><p class="count" id="point138">138</p><p>The paragraph shown.</p>`);

  test('is said to be so, with both numbers', async () => {
    const { fetcher } = stubFetcher([heading('In Case C‑999/15 P')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-413/14 P', celex: '62014CJ0413', ecli: 'ECLI:EU:C:2017:623', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
    assert.deepEqual(preview.caseMismatch, { cited: 'C-413/14 P', named: ['C-999/15 P'] });
  });

  test('is not said of the same case, however its number is written', async () => {
    for (const cases of ['In Case C‑413/14 P', 'In Case C-413/14P', 'In Joined Cases C‑412/14 P and C‑413/14 P', 'Dans l’affaire C‑413/14 P']) {
      const { fetcher } = stubFetcher([heading(cases)]);
      const { resolver } = makeResolver({ fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-413/14 P', celex: '62014CJ0413', ecli: 'ECLI:EU:C:2017:632', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
      assert.equal(preview.caseMismatch, undefined, cases);
    }
  });

  test('nor of a document that states no case number, nor of a citation that gave none', async () => {
    const { fetcher } = stubFetcher([heading('Between the parties')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-413/14 P', celex: '62014CJ0413', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
    assert.equal(preview.caseMismatch, undefined);
    const second = makeResolver({ fetcher: stubFetcher([heading('In Case C‑999/15 P')]).fetcher });
    const [bare] = await second.resolver.resolve(curiaJudgmentLookup({ caseNumber: undefined, value: 'EU:C:2017:623', ecli: 'ECLI:EU:C:2017:623', celex: '62014CJ0413', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
    assert.equal(bare.caseMismatch, undefined);
  });

  describe('an Advocate General\'s opinion', () => {
    // An opinion heads itself "Case C‑12/03 P", with no "In", and its first point names the
    // judgment under appeal: "an appeal … against the judgment … in Case T‑5/02". Read by the
    // judgment's pattern, Tizzano's opinion in Commission v Tetra Laval was said to be of case
    // T‑5/02 — a warning, on the right document, that the passage was of another case. Found
    // live on four citations in the opinions in Illumina/Grail, Super League and CK Telecoms.
    const tetraLaval = (own: string) => html(`<p>OPINION OF ADVOCATE GENERAL TIZZANO</p><p>delivered 25 May 2004 (1)</p><p>${own}</p><p>Commission of the European Communities v Tetra Laval BV</p><p>(Regulation No 4067/89 – Leveraging effect)</p><p class="count" id="point1">1</p><p>The subject-matter of this case is an appeal against the judgment of the Court of First Instance in Case T‑5/02 Tetra Laval v Commission, which annulled a decision in Case COMP/M.2416.</p><p class="count" id="point73">73</p><p>The point cited.</p>`);
    const lookup = { caseNumber: 'C-12/03 P', celex: '62003CC0012', ecli: 'ECLI:EU:C:2004:318', documentType: 'opinion' as const, locator: { kind: 'point' as const, start: 73 }, paragraphs: [73] };

    test('is of the case its heading names, not of the judgment its first point discusses', async () => {
      const { resolver } = makeResolver({ fetcher: stubFetcher([tetraLaval('Case C‑12/03 P')]).fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup(lookup));
      assert.equal(preview.passage, 'cited');
      assert.equal(preview.caseMismatch, undefined);
    });

    test('and is said to be of another case where its heading names another', async () => {
      const { resolver } = makeResolver({ fetcher: stubFetcher([tetraLaval('Case C‑999/15 P')]).fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup(lookup));
      assert.deepEqual(preview.caseMismatch, { cited: 'C-12/03 P', named: ['C-999/15 P'] });
    });

    test('a joined list that writes its year once, at the end', async () => {
      // Darmon in Wood Pulp (61985CC0089): "Joined cases 89, 104, 114, 116, 117 and 125 to
      // 129/85." Read for full numbers alone, the list was case 129/85, and a citation of case
      // 89/85 — the right opinion — was said to show another case's passage.
      const woodPulp = (heading: string) => html(`<p>Opinion of Mr Advocate General Darmon delivered on 25 May 1988. - A. Ahlström Osakeyhtiö and others v Commission. - ${heading} European Court reports 1988 Page 05193</p><p>57. The point cited.</p><p>58. Next.</p>`);
      for (const [cited, heading, mismatch] of [
        ['C-89/85', 'Joined cases 89, 104, 114, 116, 117 and 125 to 129/85.', false],
        ['C-127/85', 'Joined cases 89, 104, 114, 116, 117 and 125 to 129/85.', false],
        ['C-90/85', 'Joined cases 89, 104, 114, 116, 117 and 125 to 129/85.', true],
      ] as const) {
        const { resolver } = makeResolver({ fetcher: stubFetcher([woodPulp(heading)]).fetcher });
        const [preview] = await resolver.resolve(curiaJudgmentLookup({ ...lookup, caseNumber: cited, celex: '61985CC0089', ecli: 'ECLI:EU:C:1988:258', locator: { kind: 'point', start: 57 }, paragraphs: [57] }));
        assert.equal(preview.caseMismatch !== undefined, mismatch, cited);
      }
    });

    test('a judgment that lists the opinions delivered in its cases is not an opinion', async () => {
      // Aalborg Portland (C-204/00 P, EU:C:2004:6): "Arrêt de la Cour Joined Cases C-204/00 P,
      // C-205/00 P, … Opinion of Advocate General Ruiz-Jarabo Colomer delivered on 11 February
      // 2003 in Case C-204/00 P …" — read as an opinion's heading, the judgment was said to be
      // of cases C-211/00 P and others.
      const aalborg = html('<p>Arrêt de la Cour Joined Cases C-204/00 P, C-205/00 P, C-211/00 P, C-213/00 P, C-217/00 P and C-219/00 P Aalborg Portland A/S and Others v Commission</p><p>Opinion of Advocate General Ruiz-Jarabo Colomer delivered on 11 February 2003 in Case C-204/00 P Opinion of Advocate General Ruiz-Jarabo Colomer delivered on 11 February 2003 in Case C-211/00 P</p><p>260 The paragraph cited.</p><p>261 Next.</p>');
      const { resolver } = makeResolver({ fetcher: stubFetcher([aalborg]).fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup({ ...lookup, documentType: 'judgment', caseNumber: 'C-204/00 P', celex: '62000CJ0204', ecli: 'ECLI:EU:C:2004:6', locator: { kind: 'point', start: 260 }, paragraphs: [260] }));
      assert.equal(preview.caseMismatch, undefined);
    });

    test('in the older format, which names its case at the end of the heading', async () => {
      // Léger in Wouters (C‑309/99): the heading runs "Opinion of Mr Advocate General Léger
      // delivered on 10 July 2001. - J. C. J. Wouters … - Case C-309/99." and the opinion then
      // discusses Arduino, "In Case C‑35/99".
      const wouters = html('<p>Opinion of Mr Advocate General Léger delivered on 10 July 2001. - J. C. J. Wouters and Others v Algemene Raad van de Nederlandse Orde van Advocaten. - Reference for a preliminary ruling: Raad van State - Netherlands. - Article 85 of the EC Treaty (now Article 81 EC). - Case C-309/99.</p><p>1. In Case C‑35/99 Arduino the Court considered a tariff.</p><p>62. The point cited.</p><p>63. Next.</p>');
      const { resolver } = makeResolver({ fetcher: stubFetcher([wouters]).fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup({ ...lookup, caseNumber: 'C-309/99', celex: '61999CC0309', ecli: 'ECLI:EU:C:2001:390', locator: { kind: 'point', start: 62 }, paragraphs: [62] }));
      assert.equal(preview.caseMismatch, undefined);
    });
  });

  describe('where the ECLI is the one mistake', () => {
    // The Commission's Amazon and Starbucks decisions cite "C-78/08 to C-80/08 Paint Graphos
    // ECLI:EU:C:2009:417, paragraph 50". That ECLI is Har Vaessen Douane Service (C-7/08), and
    // its paragraph 50 was shown, warned of. The case number and the name agree with each other
    // against the ECLI, and the document filed under that number is the one they name.
    const vaessen = () => html('<p>JUDGMENT OF THE COURT (Third Chamber)</p><p>In Case C‑7/08,</p><p>Har Vaessen Douane Service BV v Staatssecretaris van Financiën</p><p class="count" id="point50">50</p><p>Har Vaessen’s paragraph.</p>');
    const paintGraphos = (name = 'Ministero dell’Economia e delle Finanze v Paint Graphos Soc. coop. arl') => html(`<p>JUDGMENT OF THE COURT (First Chamber)</p><p>In Joined Cases C‑78/08 to C‑80/08,</p><p>${name}</p><p class="count" id="point50">50</p><p>The paragraph filed under the number.</p>`);
    const lookup = (caseName?: string) => curiaJudgmentLookup({ caseNumber: 'C-78/08', celex: '62008CJ0078', ecli: 'ECLI:EU:C:2009:417', ...(caseName ? { caseName } : {}), locator: { kind: 'point', start: 50 }, paragraphs: [50] });

    test('the case the footnote names by number and name is shown, and the ECLI said to be another case\'s', async () => {
      const { fetcher, calls } = stubFetcher([vaessen(), paintGraphos()]);
      const { resolver } = makeResolver({ fetcher });
      const [preview] = await resolver.resolve(lookup('Paint Graphos'));
      assert.ok(preview.excerpt.includes('The paragraph filed under the number.'), preview.excerpt);
      assert.deepEqual(preview.ecliOfAnotherCase, { ecli: 'ECLI:EU:C:2009:417', named: ['C-7/08'] });
      assert.equal(preview.caseMismatch, undefined);
      assert.ok(calls[1].url.includes('62008CJ0078'));
    });

    test('but not where the name does not agree, nor where there is no name', async () => {
      for (const name of ['Paint Graphos', undefined]) {
        const { fetcher } = stubFetcher([vaessen(), paintGraphos('Some Other Party v Ministero')]);
        const { resolver } = makeResolver({ fetcher });
        const [preview] = await resolver.resolve(lookup(name));
        assert.ok(preview.excerpt.includes('Har Vaessen’s paragraph.'), String(name));
        assert.ok(preview.caseMismatch, 'the warning stands');
        assert.equal(preview.ecliOfAnotherCase, undefined);
      }
    });
  });

  test('a table of contents naming the judgment under appeal is not the heading', async () => {
    // ISU v Commission (C-124/21 P): the Grand Chamber's table of contents, before the heading,
    // lists "V. The action in Case T‑93/18", and the judgment was said to be of that case.
    for (const [cases, mismatch] of [['Table of contents I. Background V. The action in Case T‑93/18 A. Arguments</p><p>In Case C‑124/21 P', false], ['IN CASE 14/68', true]] as const) {
      const { fetcher } = stubFetcher([heading(cases)]);
      const { resolver } = makeResolver({ fetcher });
      const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-124/21', celex: '62021CJ0124', ecli: 'ECLI:EU:C:2023:1012', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
      assert.equal(preview.caseMismatch !== undefined, mismatch, cases);
    }
  });

  test('a case of the Court before 1989 is read as the Court writes it', async () => {
    const { fetcher } = stubFetcher([heading('In Case 85/76')]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ caseNumber: 'C-85/76', celex: '61976CJ0085', ecli: 'ECLI:EU:C:1979:36', locator: { kind: 'point', start: 138 }, paragraphs: [138] }));
    assert.equal(preview.caseMismatch, undefined);
  });
});

describe('fetching the official text', () => {
  test('follows CELLAR’s redirect over HTTPS, never plain HTTP', async () => {
    const { fetcher, calls } = stubFetcher([
      new Response(null, { status: 303, headers: { location: 'http://publications.europa.eu/resource/cellar/abc.0015.05/DOC_1' } }),
      html('<p class="count" id="point80">80</p><p>The cited paragraph.</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 80 }, paragraphs: [80] }));
    assert.equal(calls[1].url, 'https://publications.europa.eu/resource/cellar/abc.0015.05/DOC_1');
    assert.ok(preview.excerpt.includes('The cited paragraph.'));
  });

  test('does not follow a redirect to another scheme', async () => {
    const { fetcher, calls } = stubFetcher([new Response(null, { status: 302, headers: { location: 'ftp://example.test/doc' } })]);
    const { resolver } = makeResolver({ fetcher });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 80 }, paragraphs: [80] }));
    assert.ok(calls.every((call) => !call.url.startsWith('ftp:')));
    assert.equal(preview.source, 'CURIA');
  });
});

describe('a rendition CELLAR fails on', () => {
  test('is passed over for the next, rather than giving up on the document', async () => {
    // Tele Columbus (EU:T:2024:816): the English answers 500 on every attempt, the French is there.
    const serverError = () => new Response('String index out of range: -1', { status: 500 });
    const { fetcher, calls } = stubFetcher([
      serverError, serverError,
      () => html('<p>ARRÊT DU TRIBUNAL</p><p class="count" id="point145">145</p><p>Le point cité.</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ locator: { kind: 'point', start: 145 }, paragraphs: [145] }));
    assert.ok(preview.excerpt.includes('Le point cité.'), preview.excerpt);
    assert.equal(calls.length, 3, 'English in both formats, then French');
  });

  test('but a service in trouble is not asked for every rendition', async () => {
    const { fetcher, calls } = stubFetcher([new Response('busy', { status: 503 })]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup());
    assert.equal(calls.length, 1);
    assert.equal(preview.source, 'CURIA');
  });
});

describe('a document CELLAR holds twice', () => {
  const choices = (items: Array<[string, string]>) => new Response(
    `<html><body> List of URI's:<ul>${items.map(([doc, label]) => `<li title="manifestation">x<ul><li title="item"><a href="http://publications.europa.eu/resource/cellar/${doc}"><span class="url">(x)</span></a><ul><li title="stream_name">x.html</li><li title="stream_label">${label}</li></ul></li></ul></li>`).join('')}</ul></body></html>`,
    { status: 300, headers: { 'content-type': 'application/xhtml+xml' } },
  );

  test('follows the one in the format asked for, over HTTPS', async () => {
    const { fetcher, calls } = stubFetcher([
      choices([['aaa.0002.01/DOC_3', 'celex-62012TJ0079.ENG.html.techmd.rdf'], ['aaa.0002.03/DOC_1', 'celex-62012TJ0079.ENG.xhtml.techmd.rdf']]),
      html('<p class="count" id="point69">69</p><p>The Cisco paragraph.</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62012TJ0079', locator: { kind: 'point', start: 69 }, paragraphs: [69] }));
    assert.equal(calls[1].url, 'https://publications.europa.eu/resource/cellar/aaa.0002.03/DOC_1');
    assert.ok(preview.excerpt.includes('The Cisco paragraph.'));
  });

  test('and follows it again when confirming the copy already held', async () => {
    // Electrabel (EU:T:2012:672), point 246: found the first time, and a link on every look
    // after, because confirming the stored copy met the same `300` and gave up on it.
    const list = () => choices([['aaa.0002.01/DOC_3', 'celex-62009TJ0332.ENG.html.techmd.rdf'], ['aaa.0002.03/DOC_1', 'celex-62009TJ0332.ENG.xhtml.techmd.rdf']]);
    const { fetcher, calls } = stubFetcher([
      list(),
      documentResponse('<p class="count" id="point246">246</p><p>The Electrabel paragraph.</p><p class="count" id="point247">247</p><p>The next one.</p>'),
      list(),
      notModified(),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const lookup = (n: number) => curiaJudgmentLookup({ celex: '62009TJ0332', locator: { kind: 'point', start: n }, paragraphs: [n] });
    await resolver.resolve(lookup(246));
    const [again] = await resolver.resolve(lookup(247));
    assert.equal(again.passage, 'cited');
    assert.ok(again.excerpt.includes('The next one.'), again.excerpt);
    assert.equal(calls[3].url, 'https://publications.europa.eu/resource/cellar/aaa.0002.03/DOC_1');
    assert.ok(new Headers(calls[3].init.headers).get('if-none-match'), 'confirmed, not downloaded again');
  });

  test('chooses nothing where two are in that format', async () => {
    const { fetcher, calls } = stubFetcher([
      choices([['a/DOC_1', 'celex-x.ENG.xhtml.techmd.rdf'], ['b/DOC_1', 'celex-y.ENG.xhtml.techmd.rdf']]),
      noSuchDocument('62012TJ0079'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62012TJ0079', locator: { kind: 'point', start: 69 }, paragraphs: [69] }));
    assert.ok(calls.every((call) => !call.url.includes('/cellar/')));
    assert.equal(preview.source, 'CURIA');
  });
});

describe('a judgment held in English only as a summary', () => {
  // Commission v Spain (C-196/07, EU:C:2008:146): 5 KB of English headnotes, the text in French.
  const summary = () => html('<!--Filename : JJA@TRA-DOC-EN-INF-C-0196-2007-200804278-05_00--><p>Judgment of the Court (Third Chamber) of 6 March 2008 – Commission v Spain</p><p>1. Actions for failure to fulfil obligations (see paras 25-26)</p>');

  test('is shown from the French where the cited paragraph is there, and says so', async () => {
    const { fetcher, calls } = stubFetcher([
      summary(),
      html('<!--Filename : JJA@TRA-DOC-FR-ARRET-C-0196-2007--><p>ARRÊT DE LA COUR (troisième chambre)</p><p class="count" id="point35">35</p><p>Le point trente-cinq.</p><p class="count" id="point36">36</p><p>Le point trente-six.</p><p class="count" id="point37">37</p><p>Suite.</p>'),
    ]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0196', locator: { kind: 'point', start: 35, end: 36 }, paragraphs: [35, 36] }));
    assert.equal(preview.passage, 'cited');
    assert.equal(preview.language, 'fr');
    assert.ok(preview.excerpt.includes('Le point trente-cinq.') && preview.excerpt.includes('Le point trente-six.'), preview.excerpt);
    assert.ok(!preview.excerpt.includes('Suite.'));
    assert.equal(calls.length, 2);
  });

  test('is labelled a summary where the French does not have the paragraph either', async () => {
    const { fetcher } = stubFetcher([summary(), noSuchDocument('62007CJ0196')]);
    const { resolver } = makeResolver({ fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
    const [preview] = await resolver.resolve(curiaJudgmentLookup({ celex: '62007CJ0196', locator: { kind: 'point', start: 35 }, paragraphs: [35] }));
    assert.equal(preview.passage, 'summary');
    assert.ok(preview.fullTextUrl);
  });
});
