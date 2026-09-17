import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getCitationContextsForFootnotes, type CitationContext } from '../../shared/src/index.ts';
import { prefetchStatus, prefetchTargets, startPrefetch, type PrefetchTarget } from '../src/ui/prefetch.ts';

/**
 * Warming the source cache at document open.
 *
 * Two things are being asserted here and they pull in opposite directions. One is that the
 * work starts early and follows the reviewer's cursor, so the first inspection of an
 * authority is not a cold retrieval. The other is that it stays a well-behaved client:
 * strictly one request at a time, no parallelism anywhere, and everything abandoned the
 * moment the document it belongs to goes away.
 */

const citations = (footnotes: string[]): CitationContext[][] => getCitationContextsForFootnotes(footnotes);

describe('which documents are worth warming', () => {
  test('one entry per authority, however many footnotes cite it', () => {
    // The reason this deduplicates at all: the resolver caches the document and cuts each
    // excerpt out of it locally, so twenty pinpoints into one judgment are one retrieval.
    const targets = prefetchTargets(citations([
      'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.',
      'Digital Rights Ireland, para. 62.',
      'Digital Rights Ireland, paras 65-67.',
    ]));

    assert.equal(targets.length, 1);
    assert.equal(targets[0].celex, '62012CJ0293');
    assert.deepEqual(targets[0].footnotes, [0, 1, 2], 'every footnote citing it, so the cursor can promote from any of them');
  });

  test('keeps reading order, which is the best guess before the cursor says otherwise', () => {
    const targets = prefetchTargets(citations([
      'Regulation (EU) 2016/679, Article 15.',
      'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.',
      'Directive 2002/58/EC, Article 15.',
    ]));
    assert.deepEqual(targets.map((target) => target.celex), ['32016R0679', '62012CJ0293', '32002L0058']);
  });

  test('never warms a citation the reviewer has not resolved', () => {
    // An unresolved short form has nothing to look up. Guessing at one in the background
    // would be the same confidently-wrong citation the pane refuses to produce in the
    // foreground, only without anyone watching it happen.
    const targets = prefetchTargets(citations(['See Post Danmark, para. 25.']));
    assert.deepEqual(targets, []);
  });

  test('skips a resolved citation that resolves to a link rather than to text', () => {
    // A Commission case number has no CELEX and is never fetched — it resolves to the
    // official case register. There is no network result to warm.
    const targets = prefetchTargets(citations(['Commission decision in Case AT.37990 Intel.']));
    assert.deepEqual(targets.map((target) => target.celex), []);
  });

  test('a back-reference is warmed as the authority it points at', () => {
    // Ibid./supra chains are resolved before this runs, so a document whose footnotes are
    // mostly back-references collapses to the few authorities it really cites.
    const targets = prefetchTargets(citations([
      'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.',
      'Ibid., para. 62.',
    ]));
    assert.equal(targets.length, 1, 'the back-reference is the same authority, not a second one');
    assert.equal(targets[0].celex, '62012CJ0293');
  });
  test('two documents deriving one CELEX are two documents', () => {
    // Footnotes 39 and 460 of the 2026 draft merger guidelines. The second calls Advocate
    // General Rantos's Opinion a judgment, so both derive 62021CJ0333, and the resolver fetches
    // each by its ECLI. Keyed by the CELEX, the Opinion was folded into the judgment and never
    // warmed.
    const targets = prefetchTargets(citations([
      'Judgment of 21 December 2023, European Superleague Company SL v FIFA, C-333/21, EU:C:2023:1011, paragraph 202.',
      'Judgment of 15 December 2002, Superleague v FIFA, C-333/21, EU:C:2022:993, paragraph 251.',
    ]));
    assert.deepEqual(targets.map((target) => [target.celex, target.citation.ecli]), [
      ['62021CJ0333', 'ECLI:EU:C:2023:1011'],
      ['62021CJ0333', 'ECLI:EU:C:2022:993'],
    ]);
  });
});

const target = (celex: string, footnote: number): PrefetchTarget => ({
  celex, footnote, footnotes: [footnote],
  citation: { celex, value: celex, label: celex, index: 0, source: 'eur-lex', status: 'resolved', context: '' },
});

describe('the warming queue', () => {
  test('retrieves in order, and only ever one at a time', async () => {
    // Never parallelised, deliberately. The resolver spaces its own requests to CELLAR, so
    // issuing these together would not make them arrive sooner — it would only present the
    // API with a burst, which is the fingerprint anti-bot protection reacts to.
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;

    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1), target('c', 2)],
      retrieve: async (asked) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        order.push(asked.celex);
        inFlight -= 1;
      },
      onProgress: () => undefined,
    });
    await queue.finished;

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(peak, 1, 'exactly one request in flight at any moment');
  });

  test('the cursor moves what it lands on to the front of what is left', async () => {
    const order: string[] = [];
    let promoted = false;

    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1), target('c', 2)],
      retrieve: async (asked) => {
        order.push(asked.celex);
        // Once the first has been retrieved, the reviewer's cursor lands on footnote 2.
        if (!promoted) { promoted = true; queue.promote(2); }
      },
      onProgress: () => undefined,
    });
    await queue.finished;

    assert.deepEqual(order, ['a', 'c', 'b'], 'the cursor beats reading order for whatever has not been reached');
  });

  test('promoting something already retrieved fetches nothing again', async () => {
    const order: string[] = [];
    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1)],
      retrieve: async (asked) => { order.push(asked.celex); queue.promote(0); },
      onProgress: () => undefined,
    });
    await queue.finished;
    assert.deepEqual(order, ['a', 'b']);
  });

  test('cancelling stops the queue and aborts what is in flight', async () => {
    // What a document being closed or changed has to do. At most one request is ever open,
    // so this abandons one response rather than twenty.
    const order: string[] = [];
    let aborted = false;

    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1), target('c', 2)],
      retrieve: async (asked, signal) => {
        order.push(asked.celex);
        signal.addEventListener('abort', () => { aborted = true; });
        if (asked.celex === 'a') queue.cancel();
      },
      onProgress: () => undefined,
    });
    await queue.finished;

    assert.deepEqual(order, ['a'], 'nothing is started after the cancel');
    assert.ok(aborted, 'and the request that was open is abandoned');
  });

  test('a document CELLAR does not hold does not stop the ones after it', async () => {
    const order: string[] = [];
    const progress: string[] = [];

    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1), target('c', 2)],
      retrieve: async (asked) => {
        order.push(asked.celex);
        if (asked.celex === 'b') throw new Error('EUR-Lex/CELLAR lookup failed (404).');
      },
      onProgress: (state) => progress.push(`${state.retrieved}/${state.attempted}/${state.total}`),
    });
    await queue.finished;

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(progress.at(-1), '2/3/3', 'two retrieved of three tried — the failure is counted, not hidden');
  });

  test('reports progress as it goes, starting from nothing retrieved', async () => {
    const progress: number[] = [];
    const queue = startPrefetch({
      targets: [target('a', 0), target('b', 1)],
      retrieve: async () => undefined,
      onProgress: (state) => progress.push(state.retrieved),
    });
    await queue.finished;
    assert.deepEqual(progress, [0, 1, 2]);
  });
});

describe('what the pane says about it', () => {
  test('counts what has been retrieved while it is still going', () => {
    assert.equal(prefetchStatus({ retrieved: 8, attempted: 8, total: 23 }), 'Retrieved 8 of 23 sources…');
  });

  test('says plainly what it could not get, rather than stalling short of the total', () => {
    // A count that stops at 21 of 23 with no explanation invites the reader to wait for
    // something that is not coming.
    assert.equal(
      prefetchStatus({ retrieved: 21, attempted: 23, total: 23 }),
      'Retrieved 21 of 23 sources; 2 could not be retrieved and open as a link instead.',
    );
    assert.equal(
      prefetchStatus({ retrieved: 22, attempted: 23, total: 23 }),
      'Retrieved 22 of 23 sources; 1 could not be retrieved and opens as a link instead.',
    );
  });

  test('does not blame EUR-Lex for a lookup that never completed', () => {
    // The wording this replaced said the missing documents were "not held by EUR-Lex",
    // which is a statement about the authorities the lawyer is citing. What actually
    // reaches this count is a lookup that failed — and observed live, with the API
    // stopped, that turned a dead server into the pane asserting that all 38 authorities
    // of a Commission decision were absent from EUR-Lex. A document CELLAR genuinely does
    // not hold never arrives here at all: it comes back as a link-only preview, which is a
    // successful lookup and is counted as one.
    const everythingFailed = prefetchStatus({ retrieved: 0, attempted: 38, total: 38 });
    assert.ok(!/EUR-Lex/.test(everythingFailed!.replace('reach its server', '')),
      'must not claim EUR-Lex does not hold the documents');
    assert.match(everythingFailed!, /may not be able to reach its server/);
    // And it still says what the reviewer can do, because they can: the official link is
    // built on this machine and does not depend on the server that just failed.
    assert.match(everythingFailed!, /open their official link/);
  });

  test('does not diagnose the server from a single failure', () => {
    // One document failing among many is an ordinary miss. Only a clean sweep is evidence
    // about the connection, so a lone failure gets the plain count and no theory.
    assert.equal(
      prefetchStatus({ retrieved: 0, attempted: 1, total: 1 }),
      'Retrieved 0 of 1 sources; 1 could not be retrieved and opens as a link instead.',
    );
  });

  test('says so when everything was retrieved', () => {
    assert.equal(prefetchStatus({ retrieved: 23, attempted: 23, total: 23 }), 'Retrieved all 23 sources.');
  });

  test('says nothing at all when there was nothing to warm', () => {
    assert.equal(prefetchStatus({ retrieved: 0, attempted: 0, total: 0 }), undefined);
  });
});
