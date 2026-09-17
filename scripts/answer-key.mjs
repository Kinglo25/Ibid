#!/usr/bin/env node
/**
 * Check detection against an answer key: every citation in a real document, written down by
 * someone reading it, compared citation by citation with what the pane would report.
 *
 * Why this exists alongside `npm run corpus`. The corpus asks CELLAR whether an identifier Ibid
 * derived names the document the citation's ECLI names — which is exact, and needs no
 * labelling, and is blind to everything a citation is besides an identifier. It cannot tell
 * that `Ibid.` pointed at the wrong footnote, that a paragraph was taken from the case cited
 * after it, or that a decision's annex paragraph was shown as the decision's recital, because
 * none of those produces a wrong identifier. They produce the right document open at the wrong
 * place, and a reviewer who trusts the pane reads the wrong passage. The unit tests did not find
 * them either: each is written by the same understanding that wrote the code. A reviewer found
 * them by opening documents, one after another, after being told the suite was green.
 *
 * An answer key is that reviewer's reading, done once and kept. `scripts/answer-keys/` holds, for
 * each document, what every footnote cites — the authority meant, the pinpoint as written, how
 * it was cited — built from the published PDF without reference to Ibid's output, and the
 * footnote text it was built from, so any entry can be checked against its note.
 *
 * Six outcomes for a citation in the key, and one for a citation Ibid reports that the key does
 * not hold:
 *
 *   wrong-document    resolved to a document other than the one cited
 *   wrong-pinpoint    the right document, pinpointed somewhere the citation does not point
 *   pinpoint-missing  the right document, and a place cited that Ibid does not pinpoint
 *   unresolved        found, and left for the reviewer to decide
 *   missed            not reported at all
 *   lost              its footnote never reached the pane
 *   unexpected        reported, and not a citation in the key
 *
 * and two about the document as the pane reads it: `merged`, a footnote read as part of the one
 * before it, and `not-a-footnote`, a paragraph of the document's own text read as a note.
 *
 * `wrong-document` and `wrong-pinpoint` must be zero, the same line `corpus` draws at
 * `wrong-source`: each puts a passage in front of a reviewer that the citation does not point
 * to, with every appearance of being the one it does. The only exception is where the Word
 * document itself says so — a conversion that turned `paragraphs 97- 99` into `paragraphs 9799`
 * — and that is not taken on trust: an accepted entry names what the note reads, and the check
 * confirms the note reads it.
 *
 * Every other outcome is compared with `<key>.known.json`, the gaps already known, each with its
 * reason. It exits non-zero on anything not in that list, which is how a regression shows up,
 * and on anything in the list that no longer happens, which is how a fix is locked in rather
 * than left to regress unnoticed. And on a run that checked nothing.
 *
 *   npm run answer-key                          every key whose document is present
 *   npm run answer-key -- --write-known         rewrite the known lists from this run
 *
 * `--write-known` keeps the reason already given for an entry and marks a new one `TODO`, and
 * the check fails while any `TODO` remains: an accepted gap needs a reason someone wrote.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCitationContextsForFootnotes, reresolveBackReferences } from '../shared/dist/index.js';
import { parentheticalsInBody } from '../addin/src/ui/citation-view.ts';
import { docxBody, notesFromDocx } from './corpus-sources.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const keys = join(root, 'scripts', 'answer-keys');
const samples = join(root, 'samples', 'ibid-demo-docx');
const writeKnown = process.argv.includes('--write-known');

const MUST_BE_ZERO = new Set(['wrong-document', 'wrong-pinpoint']);

// ---------------------------------------------------------------------------------------------
// Reading the pane's list the way the pane builds it.

/**
 * Every entry the pane lists for a document: Word's footnotes, the notes a conversion left in
 * the body, and the parenthesised spans of the running text — detected and back-references
 * resolved exactly as `App.tsx` does.
 */
async function paneReading(path) {
  const notes = await notesFromDocx(path);
  const { footnoteReferences, paragraphs } = await docxBody(path);
  // The body's own prose is every paragraph that is not one of the notes, which is the split
  // the pane's paragraph reader makes. Matched on the note's opening, because a note flattened
  // into the body reaches the list without the number typed in front of it.
  const openings = notes.map((note) => note.slice(0, 60));
  const prose = paragraphs.filter((paragraph) => !openings.some((opening) => paragraph.includes(opening)));
  const inText = parentheticalsInBody(prose).map((span) => span.text);
  const texts = [...notes, ...inText];
  const citations = reresolveBackReferences(getCitationContextsForFootnotes(texts));
  return {
    wordFootnotes: Math.min(footnoteReferences, notes.length),
    notes: notes.map((text, index) => ({ text, citations: citations[index] })),
    inText: inText.map((text, index) => ({ text, citations: citations[notes.length + index] })),
  };
}

// ---------------------------------------------------------------------------------------------
// Which of the pane's notes is which footnote of the published document.

const tokens = (text) => new Set(text.toLowerCase().replace(/[‑–—]/g, '-').match(/[\p{L}\p{N}]+/gu) ?? []);
const jaccard = (a, b) => { let shared = 0; for (const t of a) if (b.has(t)) shared += 1; return shared / Math.max(1, a.size + b.size - shared); };
const coverage = (part, whole) => { let shared = 0; for (const t of part) if (whole.has(t)) shared += 1; return shared / Math.max(1, part.size); };

/**
 * Word's footnotes are in document order, so they are aligned to the PDF's in order; the notes
 * found in the body come after them in the pane's list and are placed by their text alone. A
 * footnote left over is then looked for inside the note before it, which is where a conversion
 * that stored two footnotes in one Word footnote puts it.
 */
function align(published, pane) {
  const numbers = Object.keys(published).map(Number).sort((a, b) => a - b);
  const pdf = numbers.map((number) => tokens(published[number]));
  const ours = pane.notes.map((note) => tokens(note.text));
  const n = numbers.length;
  const m = pane.wordFootnotes;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const similarity = jaccard(pdf[i - 1], ours[j - 1]);
      let best = score[i - 1][j - 1] + (similarity >= 0.5 ? similarity : -1);
      let from = 0;
      if (score[i - 1][j] > best) { best = score[i - 1][j]; from = 1; }
      if (score[i][j - 1] > best) { best = score[i][j - 1]; from = 2; }
      score[i][j] = best; back[i][j] = from;
    }
  }
  const noteOf = new Map();
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (back[i][j] === 0) { noteOf.set(numbers[i - 1], j - 1); i -= 1; j -= 1; } else if (back[i][j] === 1) i -= 1; else j -= 1;
  }
  for (let j = m; j < pane.notes.length; j += 1) {
    let best;
    numbers.forEach((number, i) => {
      if (noteOf.has(number)) return;
      const similarity = jaccard(pdf[i], ours[j]);
      if (similarity >= 0.5 && (!best || similarity > best.similarity)) best = { number, similarity };
    });
    if (best) noteOf.set(best.number, j);
  }
  const merged = [];
  numbers.forEach((number, i) => {
    if (noteOf.has(number)) return;
    const before = noteOf.get(numbers[i - 1]);
    // Not all of it: the PDF leaves stray page furniture in a note (`Article 22 European Media
    // Freedom Act. 395.`) that the conversion did not carry across.
    if (before !== undefined && coverage(pdf[i], ours[before]) >= 0.85) {
      noteOf.set(number, before);
      merged.push(number);
    }
  });
  const aligned = new Set(noteOf.values());
  return {
    noteOf,
    merged,
    notAFootnote: pane.notes.map((_, index) => index).filter((index) => !aligned.has(index)),
  };
}

// ---------------------------------------------------------------------------------------------
// Pinpoints, as the key writes them and as detection reports them.

/** A key pinpoint, read into what detection could report for it. Anything else cannot be located. */
function readPin(pin) {
  let match = /^(?:paras?|points?|recitals?) (\d+)(?:-(\d+))?( et seq\.)?$/.exec(pin);
  if (match) {
    const from = Number(match[1]);
    const to = Number(match[2] ?? from);
    return { paragraphs: Array.from({ length: to - from + 1 }, (_, k) => from + k) };
  }
  match = /^sections? (\d+(?:\.\d+)*)(?:-(\d+(?:\.\d+)*))?$/.exec(pin);
  if (match) return { section: match[2] ? `${match[1]}-${match[2]}` : match[1] };
  match = /^(?:arts?|article) (\d+)(?:\((\d+)\))?(?:\([a-z]\))?(?:-(\d+))?(?: of the decision)?$/.exec(pin);
  if (match) return { article: { start: Number(match[1]), paragraph: match[2] ? Number(match[2]) : undefined, end: match[3] ? Number(match[3]) : undefined } };
  return { unlocatable: pin };
}

function keyPins(entries) {
  const pins = { paragraphs: new Set(), sections: new Set(), articles: [], unlocatable: [] };
  for (const entry of entries) {
    for (const pin of entry.pin ?? []) {
      const read = readPin(pin);
      read.paragraphs?.forEach((paragraph) => pins.paragraphs.add(paragraph));
      if (read.section) pins.sections.add(read.section);
      if (read.article) pins.articles.push(read.article);
      if (read.unlocatable) pins.unlocatable.push(read.unlocatable);
    }
  }
  return pins;
}

function reportedPins(citations) {
  const pins = { paragraphs: new Set(), sections: new Set(), articles: [] };
  for (const citation of citations) {
    const locator = citation.locator;
    if (!locator) continue;
    if (locator.kind === 'section') locator.sections?.forEach((s) => pins.sections.add(s.to ? `${s.from}-${s.to}` : s.from));
    else if (locator.kind === 'article') pins.articles.push(locator);
    else {
      const listed = citation.pinpoint?.paragraphs;
      const paragraphs = listed?.length ? listed : Array.from({ length: (locator.end ?? locator.start) - locator.start + 1 }, (_, k) => locator.start + k);
      paragraphs.forEach((paragraph) => pins.paragraphs.add(paragraph));
    }
  }
  return pins;
}

const articleCovers = (cited, reported) => reported.start >= cited.start && reported.start <= (cited.end ?? cited.start)
  && (reported.paragraph === undefined || reported.paragraph === cited.paragraph);

/** What is wrong with where Ibid pinpoints an authority, and what it leaves out. */
function comparePins(entries, citations) {
  const cited = keyPins(entries);
  const reported = reportedPins(citations);
  const wrong = [];
  const missing = [];
  const extraParagraphs = [...reported.paragraphs].filter((p) => !cited.paragraphs.has(p));
  if (extraParagraphs.length) wrong.push(`paragraphs ${extraParagraphs.join(', ')}`);
  const extraSections = [...reported.sections].filter((s) => !cited.sections.has(s));
  if (extraSections.length) wrong.push(`sections ${extraSections.join(', ')}`);
  for (const article of reported.articles) {
    if (!cited.articles.some((c) => articleCovers(c, article))) wrong.push(`article ${article.start}${article.paragraph ? `(${article.paragraph})` : ''}`);
  }
  const missingParagraphs = [...cited.paragraphs].filter((p) => !reported.paragraphs.has(p));
  if (missingParagraphs.length) missing.push(`paragraphs ${compress(missingParagraphs)}`);
  const missingSections = [...cited.sections].filter((s) => !reported.sections.has(s));
  if (missingSections.length) missing.push(`sections ${missingSections.join(', ')}`);
  if (cited.articles.length && !reported.articles.length) missing.push('article');
  return { wrong, missing };
}

function compress(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

// ---------------------------------------------------------------------------------------------
// Which reported citation is which authority in the key.

const caseId = (value) => (value ?? '').toUpperCase().replace(/[\s‑–—]/g, '').replace(/-/g, '-').replace(/^(\d)/, 'C-$1');
const decisionId = (value) => (value ?? '').replace(/^IV\//, '').replace(/[:\s]/g, (c) => (c === ':' ? '.' : '')).replace(/\.{2,}/g, '.');
const ecliId = (value) => (value ?? '').toUpperCase().replace(/^ECLI:/, '');

function names(entry, citation) {
  // A short form is found by a citation of that short form. `EUMR, Article 14` is not found by
  // the `Regulation (EC) No 139/2004` named in the title of the act cited after it, though both
  // are the same regulation: one is the citation, the other is part of another act's name.
  if (entry.via === 'short' && !(citation.resolutionMethod || citation.backReference
    || (entry.name && citation.value.toLowerCase().includes(entry.name.toLowerCase())))) return false;
  switch (entry.k) {
    case 'decision':
      return citation.source === 'commission' && [entry.m, entry.written?.m].filter(Boolean).map(decisionId).includes(decisionId(citation.value));
    case 'judgment': case 'opinion': case 'order': {
      if (citation.source !== 'curia') return false;
      const cited = [entry.case, ...(entry.joined ?? []), entry.written?.case].filter(Boolean).map(caseId);
      const reported = [citation.caseNumber, ...(citation.joinedCaseNumbers ?? [])].filter(Boolean).map(caseId);
      return reported.some((id) => cited.includes(id)) || Boolean(entry.ecli && ecliId(citation.ecli) === ecliId(entry.ecli));
    }
    case 'legislation':
      return citation.source === 'eur-lex' && citation.celex === entry.celex;
    case 'treaty': {
      const letter = { TFEU: 'E', TEU: 'M' }[entry.treaty];
      return citation.source === 'eur-lex' && new RegExp(`^1\\d{4}${letter}\\d+$`).test(citation.celex ?? '')
        && keyPins([entry]).articles.some((article) => citation.locator && articleCovers({ ...article, paragraph: undefined }, { ...citation.locator, paragraph: undefined }));
    }
    default:
      return false;
  }
}

/**
 * Whether a resolved citation will retrieve the document the key means.
 *
 * The resolver asks CELLAR by the citation's ECLI first and by its CELEX only where there is no
 * ECLI or CELLAR does not know it, so a citation carrying an ECLI retrieves whatever that ECLI
 * names — and one without retrieves whatever its CELEX names, which is derived from the case
 * number and the kind of document the words around it say it is.
 */
function sameDocument(entry, citation) {
  if (!['judgment', 'opinion', 'order'].includes(entry.k)) return true;
  if (citation.ecli && entry.ecli) return ecliId(citation.ecli) === ecliId(entry.ecli);
  return (citation.documentType ?? 'judgment') === entry.k;
}

const identity = (entry) => {
  switch (entry.k) {
    case 'decision': return `${entry.m} ${entry.name ?? ''}`.trim();
    case 'judgment': case 'opinion': case 'order': return `${entry.k} ${entry.case} ${entry.name ?? ''}`.trim();
    case 'legislation': return `${entry.celex} ${entry.name ?? ''}`.trim();
    case 'treaty': return `${entry.treaty} ${(entry.pin ?? []).join(', ')}`;
    default: return entry.name;
  }
};

// ---------------------------------------------------------------------------------------------

function check(key, published, pane) {
  const { noteOf, merged, notAFootnote } = align(published, pane);
  const outcomes = [];
  const add = (note, outcome, what, detail) => outcomes.push({ note, outcome, identity: what, ...(detail ? { detail } : {}) });

  const entries = key.filter((line) => 'n' in line);
  const byPaneNote = new Map();
  for (const entry of entries) {
    const index = noteOf.get(entry.n);
    if (index === undefined) {
      if (entry.role !== 'incidental') add(String(entry.n), 'lost', identity(entry));
      continue;
    }
    if (!byPaneNote.has(index)) byPaneNote.set(index, []);
    byPaneNote.get(index).push(entry);
  }
  for (const number of merged) add(String(number), 'merged', `read as part of footnote ${[...noteOf].find(([n, i]) => i === noteOf.get(number) && n !== number)?.[0]}`);
  for (const index of notAFootnote) add('not a footnote', 'not-a-footnote', pane.notes[index].text.slice(0, 80));

  for (const [index, noteEntries] of byPaneNote) {
    const note = [...new Set(noteEntries.map((entry) => entry.n))].join('+');
    const citations = pane.notes[index].citations;
    const claimed = new Set();
    // One authority cited twice in a note is one authority: its pinpoints are compared together.
    const groups = new Map();
    for (const entry of noteEntries) {
      const id = `${entry.role ?? 'cited'}|${identity(entry)}|${entry.decisionDate ?? ''}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(entry);
    }
    // Two decisions in one case cited in one note — `M.4197 – E.ON/Endesa (decision of
    // 20.12.2006), paragraph 25; Case M.4197 – E.ON/Endesa (decision of 26.09.2006), paragraph
    // 24` — are two authorities that name the same case, so each takes the citation in its turn.
    const turns = new Map();
    for (const group of groups.values()) {
      const [entry] = group;
      const sameCase = [...groups.values()].filter((other) => identity(other[0]) === identity(entry) && (other[0].role ?? '') === (entry.role ?? ''));
      const turn = sameCase.indexOf(group);
      const hits = citations.filter((citation, at) => {
        if (!group.some((member) => names(member, citation))) return false;
        if (sameCase.length > 1) {
          const seen = turns.get(identity(entry)) ?? [];
          if (!seen.includes(at)) seen.push(at);
          turns.set(identity(entry), seen);
          if (seen.indexOf(at) !== turn) return false;
        }
        claimed.add(at);
        return true;
      });
      const what = identity(entry);
      if (entry.role === 'incidental') {
        for (const hit of hits.filter((citation) => citation.status === 'resolved')) {
          const { wrong } = comparePins(group, [hit]);
          if (wrong.length) add(note, 'wrong-pinpoint', what, `named only incidentally, pinpointed at ${wrong.join('; ')}`);
        }
        continue;
      }
      const resolved = hits.filter((citation) => citation.status === 'resolved');
      if (!resolved.length) {
        const shortForm = citations.findIndex((citation, at) => !claimed.has(at) && citation.status !== 'resolved'
          && entry.name && citation.value.toLowerCase() === entry.name.toLowerCase());
        if (shortForm >= 0) claimed.add(shortForm);
        if (hits.length || shortForm >= 0) add(note, 'unresolved', what);
        else if (['judgment', 'opinion', 'order', 'decision', 'legislation', 'treaty'].includes(entry.k)) add(note, 'missed', what);
        else add(note, 'missed', what, `a ${entry.k}, which detection does not read`);
        continue;
      }
      const other = resolved.filter((citation) => !sameDocument(entry, citation));
      if (other.length) {
        add(note, 'wrong-document', what, other.map((c) => `${c.ecli ?? c.celex} (${c.documentType})`).join('; '));
        continue;
      }
      const { wrong, missing } = comparePins(group, resolved);
      if (wrong.length) add(note, 'wrong-pinpoint', what, wrong.join('; '));
      if (missing.length) add(note, 'pinpoint-missing', what, missing.join('; '));
    }
    citations.forEach((citation, at) => {
      if (!claimed.has(at)) add(note, 'unexpected', `${citation.label}: ${citation.value}`, citation.status);
    });
  }
  pane.inText.forEach((span) => span.citations.forEach((citation) => add('running text', 'unexpected', `${citation.label}: ${citation.value}`, `(${span.text.slice(0, 60)})`)));
  return { outcomes, noteText: (number) => pane.notes[noteOf.get(Number(number))]?.text ?? '' };
}

const keyOf = (outcome) => `${outcome.note}|${outcome.outcome}|${outcome.identity}`;

async function main() {
  const files = (await readdir(keys)).filter((file) => file.endsWith('.jsonl'));
  const report = { documents: [] };
  let failed = false;
  let checked = 0;

  for (const file of files) {
    const base = file.replace(/\.jsonl$/, '');
    const key = (await readFile(join(keys, file), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const header = key[0];
    const path = join(samples, header.document);
    if (!existsSync(path)) {
      console.log(`${base}: skipped, ${header.document} is not in this checkout`);
      report.documents.push({ id: base, skipped: `${header.document} is not present` });
      continue;
    }
    const published = JSON.parse(await readFile(join(keys, `${base}.notes.json`), 'utf8')).notes;
    const knownPath = join(keys, `${base}.known.json`);
    const known = existsSync(knownPath) ? JSON.parse(await readFile(knownPath, 'utf8')) : { accepted: [] };
    const reasons = new Map(known.accepted.map((entry) => [keyOf(entry), entry]));

    const pane = await paneReading(path);
    const { outcomes, noteText } = check(key, published, pane);
    checked += 1;

    const counts = {};
    for (const outcome of outcomes) counts[outcome.outcome] = (counts[outcome.outcome] ?? 0) + 1;
    const cited = key.filter((line) => 'n' in line && line.role !== 'incidental').length;
    console.log(`\n${base}: ${cited} citations in the key, ${pane.notes.length} notes and ${pane.inText.length} parenthesised spans read`);
    console.log('  ' + Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(' · '));

    const problems = [];
    for (const outcome of outcomes) {
      const accepted = reasons.get(keyOf(outcome));
      if (!accepted) { problems.push(['new', outcome]); continue; }
      if (accepted.reason === 'TODO') problems.push(['no reason given', outcome]);
      if (MUST_BE_ZERO.has(outcome.outcome)) {
        // Accepted only where the Word document itself reads that way, and only if it does.
        if (!accepted.reads) problems.push(['must be zero', outcome]);
        else if (!noteText(outcome.note.split('+')[0]).includes(accepted.reads)) problems.push([`the note does not read "${accepted.reads}"`, outcome]);
      }
    }
    const occurred = new Set(outcomes.map(keyOf));
    for (const entry of known.accepted) if (!occurred.has(keyOf(entry))) problems.push(['fixed — take it out of the known list', entry]);

    for (const [why, outcome] of problems) {
      console.log(`  ✖ ${why}: footnote ${outcome.note} ${outcome.outcome} — ${outcome.identity}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
    if (problems.length) failed = true;
    report.documents.push({ id: base, counts, problems: problems.map(([why, outcome]) => ({ why, ...outcome })), outcomes });

    if (writeKnown) {
      const accepted = outcomes.map((outcome) => {
        const previous = reasons.get(keyOf(outcome));
        return { ...outcome, reason: previous?.reason ?? 'TODO', ...(previous?.reads ? { reads: previous.reads } : {}) };
      });
      await writeFile(knownPath, `${JSON.stringify({ about: known.about ?? 'Gaps already known in how Ibid reads this document, each with the reason it is accepted for now. See scripts/answer-key.mjs.', accepted }, null, 1)}\n`);
      console.log(`  wrote ${accepted.length} entries to ${base}.known.json`);
    }
  }

  await writeFile(join(root, 'answer-key-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (!checked) {
    console.log('\nNo answer key could be checked: every document was absent. A run that checks nothing is not a pass.');
    process.exitCode = 1;
  } else if (failed && !writeKnown) {
    process.exitCode = 1;
  }
}

await main();
