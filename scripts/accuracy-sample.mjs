#!/usr/bin/env node
/**
 * Draw a stratified random sample of a document's footnotes, for someone to mark by hand.
 *
 * This exists because of a number that did not survive contact with a second look. Running
 * detection over the Intel decision and counting what came back gave 133 resolved
 * authorities and, by probing the footnotes detection had passed over, 14 apparent misses —
 * from which it is tempting to report recall of about 90%. Then one more probe was written,
 * for cases named without a number ("Michelin I, op. cit., paragraph 73"), and the misses
 * went up. The denominator moved because someone looked in a new place, which means it was
 * never a measurement: it was a series of guesses about where to look, scored against
 * itself.
 *
 * A recall figure needs a ground truth that was not derived from the thing being measured.
 * The only honest way to get one is for a person to read footnotes and say what is in them,
 * without reference to what detection reported. That is what this produces: a marking sheet
 * and, later, `accuracy-score.mjs` to weight it back up to the document.
 *
 * Stratified rather than simple random, because the interesting footnotes are rare. A
 * simple sample of 240 from this decision would land roughly 10 on a resolved citation and
 * 210 on a spreadsheet row, measuring the part nobody is unsure about. The strata below cut
 * the document by what detection did with each footnote and by whether the text carries any
 * of the vocabulary a citation is written in, then oversample the thin, decisive parts and
 * weight them back down. Every one of the twenty misses found by hand lands in `silent-cited`,
 * which is the stratification earning its keep — and is also the reason that stratum is not
 * evidence of anything on its own, since it was drawn to contain them.
 *
 * Seeded, so the sample is reproducible: a client asking which footnotes were marked, and
 * why those, gets an answer better than "the ones that came up". Re-running with the same
 * seed and the same document reproduces the sheet exactly.
 *
 * The sheet holds the text of real footnotes. On a document naming real parties that makes
 * it as confidential as the document, so it is written under `.accuracy/`, which is ignored
 * — see the note in `.gitignore` about the sample folder being an allow-list.
 *
 *   npm run accuracy:sample -- "samples/ibid-demo-docx/EC Decision - Intel (2009).docx"
 *   npm run accuracy:sample -- <file.docx> --n 400          a larger sample
 *   npm run accuracy:sample -- <file.docx> --seed 7         a different draw
 *   npm run accuracy:sample -- <file.docx> --stratum silent-plain=200
 *
 * The second mode draws a blind subsample out of a sheet that has already been marked, for
 * an independent pass:
 *
 *   npm run accuracy:sample -- --blind 60 --from .accuracy/<name>-sample.csv
 *
 * Blind because the marks and the notes are stripped out. A first pass — by an LLM, or by
 * whoever had the document open — is worth having and is not worth trusting on its own; two
 * passes that agree are, and the agreement rate is the thing that answers "how do you know".
 * What is deliberately *not* stripped is `ibid_detected`: the marker needs it for
 * `false_positives`, and the guide's instruction to decide before reading it is a rule for
 * the person, not something a column layout can enforce.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notesFromDocx } from './corpus-sources.mjs';
import { getCitationContextsForFootnotes } from '../shared/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The vocabulary a citation is written in, used only to split the footnotes detection said
 * nothing about into two strata.
 *
 * Deliberately loose. Its job is not to find citations — that is the thing being measured,
 * and a filter that were any good at it would be a detector, which would make the marking
 * sheet a test of itself. Its job is to separate "this footnote is prose about documents"
 * from "this footnote is a number in a table", so the marker's attention lands where a
 * missed citation could plausibly be hiding. Over-inclusive is the safe direction: a
 * footnote wrongly placed in `silent-cited` costs one reading, while one wrongly placed in
 * `silent-plain` is sampled at a twentieth of the rate and could hide a miss.
 */
const CITATION_VOCABULARY = /\b(?:para|paras|paragraph|paragraphs|point|points|recital|recitals)\b|\bop\.?\s*cit|\bloc\.?\s*cit|\bsupra\b|\bcited\s+above\b|\bOJ\s+[LC]\b|\b(?:regulation|directive|article)\s|\bECR\b|\bcase\b/i;

/**
 * Which stratum a footnote belongs to.
 *
 * The order matters and is not arbitrary. A footnote holding one resolved citation and one
 * `SSO` is a footnote where detection did something right, and it is marked as such;
 * `sso-only` is reserved for the footnotes where the single repeated false positive is the
 * whole of what was reported, because that stratum exists to confirm a known-homogeneous
 * block cheaply rather than to be read 104 times.
 */
function stratumOf(text, citations) {
  if (!text.trim()) return 'blank';
  if (citations.some((citation) => citation.status === 'resolved')) return 'resolved';
  if (citations.length && citations.every((citation) => citation.value === 'SSO')) return 'sso-only';
  if (citations.length) return 'flagged';
  return CITATION_VOCABULARY.test(text) ? 'silent-cited' : 'silent-plain';
}

/**
 * How the sample is spread, as a share of the 240 the defaults draw.
 *
 * `resolved` and `flagged` are sampled heavily because they are small and because they
 * carry the two questions only a person can settle: whether what was resolved is the right
 * document, and whether what was flagged is an authority at all. `silent-plain` is the
 * opposite — 1236 footnotes that appear to be evidence and table rows — and it is sampled
 * at a twentieth of that rate, purely to check that appearance. It is also, for that
 * reason, what will dominate the confidence interval: see the note in `accuracy-score.mjs`.
 */
const ALLOCATION = {
  resolved: 45,
  flagged: 35,
  'sso-only': 15,
  'silent-cited': 75,
  'silent-plain': 70,
};

/** mulberry32 — a small seeded generator, so a named seed reproduces a named sample. */
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, drawing `count` without replacement. */
function sample(values, count, random) {
  const pool = [...values];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length)).sort((a, b) => a.footnote - b.footnote);
}

const CSV_COLUMNS = [
  'footnote', 'stratum', 'ibid_detected', 'ibid_count',
  'authorities', 'found', 'resolved_ok', 'false_positives', 'notes', 'text',
];

/** RFC 4180: quote everything, double the quotes, and let newlines survive inside a field. */
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csvRow = (cells) => cells.map(csvCell).join(',');

function parseArguments(argv) {
  const positional = [];
  const options = { n: undefined, seed: 1, stratum: {}, blind: undefined, from: undefined };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--n') options.n = Number(argv[++i]);
    else if (argument === '--blind') options.blind = Number(argv[++i]);
    else if (argument === '--from') options.from = argv[++i];
    else if (argument === '--seed') options.seed = Number(argv[++i]);
    else if (argument === '--stratum') {
      const [name, count] = String(argv[++i]).split('=');
      options.stratum[name] = Number(count);
    } else positional.push(argument);
  }
  return { document: positional[0], options };
}

/** RFC 4180, matching the writer above; the footnote text carries commas and quotes. */
function parseCsv(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (character !== '\r') cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((cells) => cells.some((value) => value !== ''));
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

/**
 * Draw a blind subsample out of an existing sheet.
 *
 * Stratified in the same proportions the source sheet has, rather than uniformly, so the
 * second pass covers the same ground as the first and the agreement rate is not dominated by
 * whichever stratum the draw happened to favour.
 */
async function drawBlind(options) {
  const sourcePath = resolve(root, options.from);
  const source = parseCsv(await readFile(sourcePath, 'utf8'));
  const random = randomFrom(options.seed + 1);

  const byStratum = new Map();
  for (const row of source) {
    if (!byStratum.has(row.stratum)) byStratum.set(row.stratum, []);
    byStratum.get(row.stratum).push({ ...row, footnote: Number(row.footnote) });
  }

  const picked = [];
  for (const [, members] of [...byStratum].sort()) {
    const share = Math.round(options.blind * (members.length / source.length));
    picked.push(...sample(members, share, random));
  }
  picked.sort((a, b) => a.footnote - b.footnote);

  const blank = { authorities: '', found: '', resolved_ok: '', false_positives: '', notes: '' };
  const outputPath = sourcePath.replace(/-sample\.csv$/, '-blind.csv');
  await writeFile(outputPath, [
    csvRow(CSV_COLUMNS),
    ...picked.map((row) => csvRow(CSV_COLUMNS.map((column) => ({ ...row, ...blank })[column] ?? ''))),
  ].join('\n') + '\n', 'utf8');

  console.log(`${picked.length} of ${source.length} drawn blind from ${basename(sourcePath)}\n`);
  for (const [stratum, members] of [...byStratum].sort()) {
    console.log(`  ${stratum.padEnd(14)} ${String(picked.filter((row) => row.stratum === stratum).length).padStart(4)} of ${String(members.length).padStart(4)} marked`);
  }
  console.log(`\n  sheet   ${outputPath}`);
  console.log('\nMark it without looking at the first pass, then:');
  console.log(`  npm run accuracy:score -- --against ${outputPath.replace(root, '')}`);
}

async function main() {
  const { document, options } = parseArguments(process.argv.slice(2));
  if (options.blind) {
    if (!options.from) { console.error('--blind needs --from <sheet.csv>'); process.exit(2); }
    return drawBlind(options);
  }
  if (!document) {
    console.error('usage: accuracy-sample.mjs <file.docx> [--n 240] [--seed 1] [--stratum name=count]\n'
      + '       accuracy-sample.mjs --blind <count> --from <sheet.csv>');
    process.exit(2);
  }

  const notes = await notesFromDocx(document);
  const texts = notes.map((note) => (typeof note === 'string' ? note : note.text));
  const detected = getCitationContextsForFootnotes(texts);

  const strata = new Map();
  texts.forEach((text, index) => {
    const citations = detected[index];
    const name = stratumOf(text, citations);
    if (name === 'blank') return;
    if (!strata.has(name)) strata.set(name, []);
    strata.get(name).push({
      footnote: index + 1,
      stratum: name,
      text: text.replace(/\s+/g, ' ').trim(),
      ibid_detected: citations.map((citation) => `${citation.value} [${citation.status}]`).join('; '),
      ibid_count: citations.length,
    });
  });

  // A requested total is spread across the strata in the same proportions the defaults use,
  // so `--n 400` scales the design rather than replacing it.
  const scale = options.n ? options.n / Object.values(ALLOCATION).reduce((a, b) => a + b, 0) : 1;
  const random = randomFrom(options.seed);

  const rows = [];
  const design = [];
  for (const [name, members] of [...strata].sort()) {
    const wanted = options.stratum[name] ?? Math.round((ALLOCATION[name] ?? 0) * scale);
    const drawn = sample(members, wanted, random);
    rows.push(...drawn);
    design.push({ stratum: name, population: members.length, sampled: drawn.length });
  }
  rows.sort((a, b) => a.footnote - b.footnote);

  const outputDirectory = join(root, '.accuracy');
  await mkdir(outputDirectory, { recursive: true });
  const stem = basename(document).replace(/\.docx$/i, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');

  const sheet = join(outputDirectory, `${stem}-sample.csv`);
  await writeFile(sheet, [
    csvRow(CSV_COLUMNS),
    ...rows.map((row) => csvRow(CSV_COLUMNS.map((column) => row[column] ?? ''))),
  ].join('\n') + '\n', 'utf8');

  // The design travels with the sheet. Weighting a marked sample back up to the document
  // needs the population of each stratum, and a sheet that has been round-tripped through
  // a spreadsheet is exactly where that gets lost.
  const manifest = join(outputDirectory, `${stem}-design.json`);
  await writeFile(manifest, JSON.stringify({
    document: basename(document), footnotes: texts.length, seed: options.seed,
    drawnAt: new Date().toISOString(), strata: design,
  }, null, 2) + '\n', 'utf8');

  console.log(`${texts.length} footnotes, ${rows.length} drawn (seed ${options.seed})\n`);
  for (const { stratum, population, sampled } of design) {
    console.log(`  ${stratum.padEnd(14)} ${String(sampled).padStart(4)} of ${String(population).padStart(5)}   weight ${(population / sampled).toFixed(2)}`);
  }
  console.log(`\n  sheet   ${sheet}`);
  console.log(`  design  ${manifest}`);
  console.log('\nMark the sheet against docs/ACCURACY.md, then: npm run accuracy:score');
}

await main();
