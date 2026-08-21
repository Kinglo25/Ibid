#!/usr/bin/env node
/**
 * Run citation detection over a corpus of real documents and report what it gets wrong.
 *
 * The premise, earned rather than assumed: every defect of consequence this project has
 * found came from a real document, not from a case someone thought to write. A round
 * against twenty-six Advocate General opinions found seven; a single converted Commission
 * decision found that all eleven of its orders were being read as judgments. Hand-written
 * tests pin a fix in place — they do not find the next one, because they are written by the
 * same understanding that produced the bug.
 *
 * What it will not do is score itself out of ten. "Every citation matched" is not the goal
 * and is not reachable: the decision this was built against cites a case number that does
 * not exist, and no algorithm should resolve it. So the report separates three outcomes,
 * and only one of them is a defect:
 *
 *   missed        a citation in the text that detection did not report — a recall gap
 *   wrong-source  a citation resolved to an identifier belonging to a different document
 *   unavailable   resolved correctly, but the source is not in CELLAR
 *
 * `wrong-source` is the one that matters. A missed citation is visibly missing; an
 * unavailable one says so. A wrong one is presented to a reviewer with every appearance of
 * being right, which is the only failure here that can put a false authority in a legal
 * document.
 *
 *   npm run corpus              read the corpus and report recall (no network beyond harvest)
 *   npm run corpus -- --verify  also ask CELLAR what each derived identifier really is
 *   npm run corpus -- --offline use only what is already cached
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCitationsAcrossFootnotes } from '../shared/dist/index.js';
import { ecliOf, fetchCellar, notesFromCellar, notesFromDocx } from './corpus-sources.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(root, '.corpus-cache');
const flags = new Set(process.argv.slice(2));
const verify = flags.has('--verify');
const offline = flags.has('--offline');

/**
 * A deliberately loose net, cast to catch what the detector missed.
 *
 * It has to be looser than detection or it measures nothing — it would only ever agree.
 * Being loose, it also catches things that are not citations, so its hits are candidates
 * for review rather than defects: the report says "look at these", not "these are wrong".
 */
const LOOSE = [
  /\b(?:ECLI:)?EU:[CTF]:\d{4}:\d+\b/gi,
  /\b(?:Cases?|Affaires?)\s+[CT][-‐-―]?\d{1,4}\/\d{2}\b/gi,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function harvest(entry) {
  if (entry.kind === 'docx') {
    const path = join(root, entry.path);
    if (!existsSync(path)) return { skipped: 'file not present' };
    return { notes: await notesFromDocx(path) };
  }
  const file = join(cache, `${entry.celex}.html`);
  if (existsSync(file)) {
    const notes = notesFromCellar(await readFile(file, 'utf8'));
    if (notes) return { notes, cached: true };
    return { skipped: 'what is cached is not the document; delete it and re-run' };
  }
  if (offline) return { skipped: 'not cached, and --offline was given' };
  // Spaced out on purpose. This is a public service run for everyone's benefit and a corpus
  // run is the one thing here that could look like abuse of it.
  await sleep(1_000);
  const got = await fetchCellar(entry.celex);
  if (!got) return { skipped: 'CELLAR holds no rendition of this' };
  const notes = notesFromCellar(got.text);
  // A wrapper page cached is a wrapper page read on every later run, reporting a document
  // with no citations and no misses — the corpus agreeing with itself about nothing.
  if (!notes) return { skipped: 'CELLAR answered with a wrapper page, not the document' };
  await mkdir(cache, { recursive: true });
  await writeFile(file, got.text);
  return { notes, language: got.language };
}

/** Loose hits with no detected citation covering them. */
/**
 * The part of an identifier that says which document it is.
 *
 * A case number is cited with or without the suffixes that say what kind of proceeding it
 * is — `C-97/08 P` for an appeal, `T-139/24 R` for interim measures, `C-639/23 P(R)` for
 * both — and the loose net, catching only the shape, never sees them. Comparing the full
 * strings called every appeal a miss. Court, number and year are what identify the case;
 * the suffix says what was done in it.
 */
function identifier(value) {
  const upper = value.toUpperCase().replace(/[\u2010-\u2015]/g, '-');
  const ecli = /(?:ECLI:)?EU:([CTF]):(\d{4}):(\d+)/.exec(upper);
  if (ecli) return `EU:${ecli[1]}:${ecli[2]}:${ecli[3]}`;
  const number = /([CTF])-?(\d{1,4})\/(\d{2,4})/.exec(upper);
  return number ? `${number[1]}-${Number(number[2])}/${number[3]}` : upper.replace(/\s+/g, '');
}

/**
 * Loose hits that no detected citation accounts for.
 *
 * Accounted for means the note reported a citation carrying that identifier — as its own
 * value, its ECLI, or its case number — not that a citation happens to sit at the same
 * offset. A full citation is one authority written as two identifiers, "Case T-160/16,
 * EU:T:2018:317", and the detector reports it once, under the ECLI. Measuring by offset
 * called the case number a miss every time and buried the real gaps in a list of them.
 */
function missedIn(notes, detected) {
  const missed = [];
  notes.forEach((text, index) => {
    const accounted = new Set();
    for (const citation of detected[index] ?? []) {
      for (const value of [citation.value, citation.ecli, citation.caseNumber]) {
        if (value) accounted.add(identifier(value));
      }
      for (const value of citation.caseNumbers ?? []) accounted.add(identifier(value));
    }
    for (const pattern of LOOSE) {
      for (const hit of text.matchAll(pattern)) {
        if (accounted.has(identifier(hit[0]))) continue;
        const at = hit.index ?? 0;
        missed.push({ note: index + 1, text: hit[0], around: text.slice(Math.max(0, at - 40), at + 60).trim() });
      }
    }
  });
  return missed;
}

/**
 * What CELLAR says each identifier really is, remembered between runs.
 *
 * An identifier's declared ECLI is a fact about the document, not about this run, so asking
 * twice is asking a public service to repeat itself for nothing. It also makes the check
 * cheap enough to keep in the loop rather than save for a rainy day.
 */
const declaredFile = join(cache, 'declared-eclis.json');
const declared = existsSync(declaredFile) ? JSON.parse(await readFile(declaredFile, 'utf8')) : {};
async function declaredEcli(celex) {
  if (celex in declared) return declared[celex];
  await sleep(600);
  try { declared[celex] = (await ecliOf(celex)) ?? null; } catch { declared[celex] = null; }
  await mkdir(cache, { recursive: true });
  await writeFile(declaredFile, JSON.stringify(declared, null, 1));
  return declared[celex];
}

const report = { documents: [], totals: { notes: 0, citations: 0, missed: 0, checked: 0, wrongSource: 0, unavailable: 0 } };
const manifest = JSON.parse(await readFile(join(root, 'scripts/corpus.manifest.json'), 'utf8'));

for (const entry of manifest.documents) {
  const got = await harvest(entry);
  if (got.skipped) {
    report.documents.push({ id: entry.id, skipped: got.skipped });
    console.log(`— ${entry.id}: skipped (${got.skipped})`);
    continue;
  }
  const detected = detectCitationsAcrossFootnotes(got.notes);
  const citations = detected.flat();
  const missed = missedIn(got.notes, detected);
  report.totals.notes += got.notes.length;
  report.totals.citations += citations.length;
  report.totals.missed += missed.length;
  const row = { id: entry.id, notes: got.notes.length, citations: citations.length, missed, wrongSource: [], unavailable: [] };

  if (verify) {
    // One request per distinct identifier, not per citation: a document cites the same
    // authority many times, and the answer cannot differ between them.
    const pairs = new Map();
    for (const citation of citations) {
      if (citation.celex && citation.ecli) pairs.set(citation.celex, citation);
    }
    for (const [celex, citation] of pairs) {
      const says = await declaredEcli(celex);
      report.totals.checked += 1;
      const cited = citation.ecli.toUpperCase();
      if (!says) {
        row.unavailable.push({ celex, cited });
        report.totals.unavailable += 1;
      } else if (says !== cited) {
        row.wrongSource.push({ celex, cited, declared: says, caseNumber: citation.caseNumber });
        report.totals.wrongSource += 1;
      }
    }
  }

  report.documents.push(row);
  console.log(
    `— ${entry.id}: ${got.notes.length} notes, ${citations.length} citations, ${missed.length} missed`
    + (verify ? `, ${row.wrongSource.length} wrong-source, ${row.unavailable.length} unavailable` : ''),
  );
}

console.log('\n=== corpus ===');
console.log(`notes read        ${report.totals.notes}`);
console.log(`citations found   ${report.totals.citations}`);
console.log(`candidate misses  ${report.totals.missed}`);
if (verify) {
  console.log(`identifiers checked ${report.totals.checked}`);
  console.log(`WRONG SOURCE        ${report.totals.wrongSource}   <- the only outcome that must be zero`);
  console.log(`unavailable         ${report.totals.unavailable}`);
}

// Grouped by shape rather than listed, because the point is to fix classes. Twelve misses
// of one form are one defect; twelve of twelve forms are twelve.
const shapes = new Map();
for (const document of report.documents) {
  for (const miss of document.missed ?? []) {
    const shape = miss.text.replace(/\d+/g, '#').toUpperCase();
    const seen = shapes.get(shape) ?? { count: 0, example: miss, documents: new Set() };
    seen.count += 1;
    seen.documents.add(document.id);
    shapes.set(shape, seen);
  }
}
if (shapes.size) {
  console.log('\ncandidate misses by shape, most frequent first:');
  for (const [shape, seen] of [...shapes].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
    console.log(`  ${String(seen.count).padStart(4)}  ${shape}   e.g. …${seen.example.around}…`);
  }
}
for (const document of report.documents) {
  for (const wrong of document.wrongSource ?? []) {
    console.log(`\nWRONG SOURCE in ${document.id}: cited ${wrong.cited} (${wrong.caseNumber}) -> ${wrong.celex}, which is ${wrong.declared}`);
  }
}

await writeFile(join(root, 'corpus-report.json'), JSON.stringify(report, null, 2));
console.log('\nfull report written to corpus-report.json');
