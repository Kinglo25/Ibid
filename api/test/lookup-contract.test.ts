import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLookup, type EuLookup } from '../src/index.ts';
import { detectCitations, detectCitationsAcrossFootnotes, type CitationMatch } from '../../shared/src/index.ts';

/**
 * `api/src/index.ts` deliberately imports nothing — it is a standalone service — so it
 * declares its own `EuLookup` rather than reusing the shared citation types. That keeps the
 * workspaces decoupled, but it also means the locator shape is written out twice with
 * nothing stopping the two from drifting: a field added to `CitationLocator` would be
 * silently dropped on its way to the resolver, and the reviewer would get an unfocused
 * excerpt with no error anywhere.
 *
 * This is the only thing tying them together. It has teeth at type-check time
 * (`npm run typecheck:test`), not at runtime — the assertions below are incidental.
 */
const toLookup = (citation: CitationMatch): EuLookup => ({
  source: citation.source,
  value: citation.value,
  celex: citation.celex,
  alternativeCelexes: citation.alternativeCelexes,
  ecli: citation.ecli,
  caseNumber: citation.caseNumber,
  caseName: citation.caseName,
  documentType: citation.documentType,
  locator: citation.locator,
  paragraphs: citation.pinpoint?.paragraphs,
});

describe('the detected-citation to lookup contract', () => {
  test('a detected citation is a valid lookup, field for field', () => {
    const [citation] = detectCitations('Case C-131/12, ECLI:EU:C:2014:317, para. 80.');
    const lookup = toLookup(citation);
    assert.equal(lookup.celex, '62012CJ0131');
    assert.deepEqual(lookup.locator, { kind: 'point', start: 80, paragraph: undefined, end: undefined });
  });

  test('an article locator survives the crossing unchanged', () => {
    const [citation] = detectCitations('Article 15(1) of Directive 2002/58/EC.');
    assert.deepEqual(toLookup(citation).locator, { kind: 'article', start: 15, paragraph: 1, end: undefined });
  });

  test('a citation Ibid will not resolve carries no identifier to look up', () => {
    // The rule that an unconfirmed citation is never fetched is enforced in the client.
    // What the shared layer guarantees is the precondition that makes it enforceable:
    // there is nothing here to fetch with.
    const [citation] = detectCitations('Some Unknown Authority, para. 4.');
    assert.equal(citation, undefined, 'a bare name is not a citation on its own');
  });
});

describe('what the server accepts as a lookup', () => {
  // As the pane sends it: serialised, so absent fields are gone rather than undefined.
  const onTheWire = (citation: CitationMatch) => JSON.parse(JSON.stringify(toLookup(citation))) as unknown;

  test('every lookup a real document produces is accepted, unchanged', () => {
    // The 478 footnotes of the Commission's 2026 draft merger guidelines, as its answer key
    // holds them: 573 citations of every kind the pane sends. A check that refused one of
    // them would leave a reviewer with a source that never loads.
    const notes = JSON.parse(readFileSync(new URL('../../scripts/answer-keys/merger-guidelines-2026.notes.json', import.meta.url), 'utf8')).notes as Record<string, string>;
    const texts = Object.keys(notes).sort((a, b) => Number(a) - Number(b)).map((key) => notes[key]);
    const citations = detectCitationsAcrossFootnotes(texts).flat();
    assert.ok(citations.length > 500);
    for (const citation of citations) {
      const sent = onTheWire(citation);
      assert.deepEqual(parseLookup(sent), sent, `refused: ${citation.value}`);
    }
  });

  test('a lookup of the wrong shape is refused, not passed on', () => {
    const valid = { source: 'curia', value: 'ECLI:EU:C:2014:317', ecli: 'ECLI:EU:C:2014:317' };
    assert.ok(parseLookup(valid));
    for (const wrong of [
      null, [], 'text', { source: 'curia' }, { value: 'x' },
      { ...valid, source: 'elsewhere' },
      { ...valid, value: 42 }, { ...valid, value: { x: 1 } }, { ...valid, value: ' ' }, { ...valid, value: 'x'.repeat(501) },
      { ...valid, celex: { a: 1 } }, { ...valid, celex: '32016R0679&foo=bar' },
      { ...valid, ecli: 42 }, { ...valid, ecli: 'EU:C:2014:317 OR 1' },
      { ...valid, caseName: 42 }, { ...valid, documentType: 'essay' },
      { ...valid, alternativeCelexes: '62012CJ0293' },
      { ...valid, paragraphs: '1,2' }, { ...valid, paragraphs: [1.5] }, { ...valid, paragraphs: Array(2001).fill(1) },
      { ...valid, locator: { kind: 'point', start: 'abc' } }, { ...valid, locator: { kind: 'page', start: 1 } },
      { ...valid, locator: { kind: 'section', start: 9, sections: [{ from: 9 }] } },
    ]) assert.equal(parseLookup(wrong), undefined, JSON.stringify(wrong)?.slice(0, 80));
  });

  test('keeps only the fields a lookup has', () => {
    assert.deepEqual(parseLookup({ source: 'commission', value: 'AT.37990', context: 'the text around it', extra: 1 }), { source: 'commission', value: 'AT.37990' });
  });
});
