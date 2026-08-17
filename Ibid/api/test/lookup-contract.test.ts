import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { EuLookup } from '../src/index.ts';
import { detectCitations, type CitationMatch } from '../../shared/src/index.ts';

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
  ecli: citation.ecli,
  caseNumber: citation.caseNumber,
  caseName: citation.caseName,
  documentType: citation.documentType,
  locator: citation.locator,
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
