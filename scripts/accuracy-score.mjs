#!/usr/bin/env node
/**
 * Score a marked sample back up to the whole document, with the uncertainty attached.
 *
 * The point of the interval is not decoration. A stratified sample answers "how many
 * authorities does this document cite" with a range, and the width of that range is the
 * honest part — it is what says whether 240 footnotes were enough to support the sentence
 * someone is about to put in front of a client. A point estimate printed alone would repeat
 * the mistake this whole exercise exists to correct.
 *
 * Three numbers come out, and they answer different questions:
 *
 *   recall       of the authorities a person found in the text, what share did Ibid report
 *   precision    of what Ibid reported, what share are authorities at all
 *   resolution   of the authorities Ibid reported, what share it tied to the right document
 *
 * Only the third is about retrieval. The first two are about detection, and they move in
 * opposite directions under most changes, which is why they are never averaged into a score.
 *
 * Estimates are ratio estimators over strata, with the finite-population correction applied:
 * `resolved` is sampled at better than half, and treating that as a draw from an infinite
 * population would overstate the uncertainty by about a third. Variance comes from the
 * standard linearisation — see Cochran, Sampling Techniques, §6.11 — rather than a
 * bootstrap, because the correction is explicit in it and can be checked by hand.
 *
 *   npm run accuracy:score
 *   npm run accuracy:score -- --sheet .accuracy/other-sample.csv
 *   npm run accuracy:score -- --against .accuracy/<name>-blind.csv
 *
 * `--against` compares two independent passes over the same footnotes instead of scoring
 * one. That comparison is what a first pass by an LLM is worth: on its own it is the vendor
 * marking the vendor's homework, and no client has to accept it. Two passes that agree, with
 * the rate stated, is a different claim — and where they disagree, the disagreements are the
 * footnotes worth arguing about, so they are printed rather than summarised away.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const accuracyDirectory = join(root, '.accuracy');

/** RFC 4180, including the quoted newlines the footnote text will certainly contain. */
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
 * A stratified ratio estimate of `numerator / denominator`, and its 95% interval.
 *
 * Returns `undefined` for the interval where a stratum holds fewer than two marked rows:
 * a variance needs two observations, and inventing one by treating a single row as certain
 * would produce exactly the falsely narrow interval this is here to avoid.
 */
function ratioEstimate(strata, numerator, denominator) {
  let total = 0;
  let base = 0;
  for (const { population, rows } of strata) {
    if (!rows.length) continue;
    total += population * mean(rows.map(numerator));
    base += population * mean(rows.map(denominator));
  }
  if (base === 0) return { estimate: undefined, low: undefined, high: undefined, base };

  const ratio = total / base;
  let variance = 0;
  let estimable = true;
  for (const { population, rows } of strata) {
    if (rows.length < 2) { if (rows.length) estimable = false; continue; }
    const residuals = rows.map((row) => numerator(row) - ratio * denominator(row));
    const correction = 1 - rows.length / population;
    variance += population ** 2 * correction * sampleVariance(residuals) / rows.length;
  }
  variance /= base ** 2;
  const margin = 1.96 * Math.sqrt(Math.max(variance, 0));
  return estimable
    ? { estimate: ratio, low: Math.max(0, ratio - margin), high: Math.min(1, ratio + margin), base }
    : { estimate: ratio, low: undefined, high: undefined, base };
}

/** A stratified estimate of a document-wide total, and its 95% interval. */
function totalEstimate(strata, value) {
  let total = 0;
  let variance = 0;
  let estimable = true;
  for (const { population, rows } of strata) {
    if (!rows.length) continue;
    total += population * mean(rows.map(value));
    if (rows.length < 2) { estimable = false; continue; }
    variance += population ** 2 * (1 - rows.length / population) * sampleVariance(rows.map(value)) / rows.length;
  }
  const margin = 1.96 * Math.sqrt(Math.max(variance, 0));
  return estimable
    ? { estimate: total, low: Math.max(0, total - margin), high: total + margin }
    : { estimate: total, low: undefined, high: undefined };
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const sampleVariance = (values) => {
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
};

const number = (value) => {
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : NaN;
};

const asPercent = ({ estimate, low, high }) => estimate === undefined
  ? 'not estimable'
  : `${(estimate * 100).toFixed(1)}%${low === undefined ? '  (interval not estimable)' : `  [${(low * 100).toFixed(1)} – ${(high * 100).toFixed(1)}]`}`;

const asCount = ({ estimate, low, high }) => estimate === undefined
  ? 'not estimable'
  : `${Math.round(estimate)}${low === undefined ? '  (interval not estimable)' : `  [${Math.round(low)} – ${Math.round(high)}]`}`;

async function findSheet(given) {
  if (given) return resolve(root, given);
  const entries = await readdir(accuracyDirectory).catch(() => []);
  const sheets = entries.filter((name) => name.endsWith('-sample.csv'));
  if (sheets.length !== 1) {
    throw new Error(sheets.length
      ? `several sheets in .accuracy/ — name one with --sheet: ${sheets.join(', ')}`
      : 'no sheet in .accuracy/ — run npm run accuracy:sample first');
  }
  return join(accuracyDirectory, sheets[0]);
}

/**
 * Cohen's kappa on "does this footnote cite an authority at all".
 *
 * Raw agreement flatters any pair of markers on this document: most footnotes cite nothing,
 * so two people who both say "no" to everything agree 90% of the time and have demonstrated
 * nothing. Kappa discounts the agreement chance alone would produce, which is the only
 * version of the number worth quoting.
 */
function kappa(pairs) {
  const n = pairs.length;
  if (!n) return undefined;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const firstYes = pairs.filter(([a]) => a).length / n;
  const secondYes = pairs.filter(([, b]) => b).length / n;
  const expected = firstYes * secondYes + (1 - firstYes) * (1 - secondYes);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

const MARK_COLUMNS = ['authorities', 'found', 'resolved_ok', 'false_positives'];

async function compare(firstPath, secondPath) {
  const first = parseCsv(await readFile(firstPath, 'utf8'));
  const second = parseCsv(await readFile(secondPath, 'utf8'));
  const byFootnote = new Map(first.map((row) => [row.footnote, row]));

  const both = second
    .filter((row) => String(row.authorities).trim() !== '' && byFootnote.has(row.footnote))
    .map((row) => ({ second: row, first: byFootnote.get(row.footnote) }))
    .filter(({ first: original }) => String(original.authorities).trim() !== '');

  if (!both.length) {
    throw new Error(`nothing marked yet in ${secondPath} — the second pass has to be filled in first`);
  }

  console.log(`Two passes compared on ${both.length} footnote(s)\n`);
  for (const column of MARK_COLUMNS) {
    const agreed = both.filter(({ first: a, second: b }) => number(a[column] || 0) === number(b[column] || 0));
    console.log(`  ${column.padEnd(16)} ${((agreed.length / both.length) * 100).toFixed(1)}% agreed  (${agreed.length}/${both.length})`);
  }

  const rows = both.filter(({ first: a, second: b }) =>
    MARK_COLUMNS.every((column) => number(a[column] || 0) === number(b[column] || 0)));
  console.log(`\n  every column      ${((rows.length / both.length) * 100).toFixed(1)}% agreed  (${rows.length}/${both.length})`);

  const binary = both.map(({ first: a, second: b }) =>
    [number(a.authorities || 0) > 0, number(b.authorities || 0) > 0]);
  const k = kappa(binary);
  console.log(`  "cites an authority"  kappa ${k === undefined ? 'n/a' : k.toFixed(3)}`
    + `  (raw ${((binary.filter(([a, b]) => a === b).length / binary.length) * 100).toFixed(1)}%)`);

  const disagreements = both.filter(({ first: a, second: b }) =>
    MARK_COLUMNS.some((column) => number(a[column] || 0) !== number(b[column] || 0)));
  if (!disagreements.length) { console.log('\n  No disagreements.'); return; }

  console.log(`\n  ${disagreements.length} disagreement(s) — resolve these before quoting a figure:\n`);
  for (const { first: a, second: b } of disagreements) {
    const diff = MARK_COLUMNS
      .filter((column) => number(a[column] || 0) !== number(b[column] || 0))
      .map((column) => `${column} ${a[column] || 0}→${b[column] || 0}`)
      .join(', ');
    console.log(`  [${a.footnote}] ${diff}`);
    console.log(`        ${a.text.slice(0, 120)}`);
    if (a.notes) console.log(`        first pass: ${a.notes.slice(0, 160)}`);
  }
}

async function main() {
  const against = process.argv.indexOf('--against');
  const index = process.argv.indexOf('--sheet');
  const sheetPath = await findSheet(index === -1 ? undefined : process.argv[index + 1]);
  if (against !== -1) return compare(sheetPath, resolve(root, process.argv[against + 1]));
  const designPath = sheetPath.replace(/-sample\.csv$/, '-design.json');

  const design = JSON.parse(await readFile(designPath, 'utf8'));
  const marked = parseCsv(await readFile(sheetPath, 'utf8'));

  // A row with no `authorities` entry has not been marked. Scoring the sheet as though a
  // blank meant zero would quietly count every unread footnote as citing nothing, which
  // inflates precision and recall together and would not look wrong on the way past.
  const done = marked.filter((row) => String(row.authorities).trim() !== '');
  const missing = marked.length - done.length;
  if (!done.length) throw new Error(`nothing marked yet in ${sheetPath}`);

  const malformed = done.filter((row) => ['authorities', 'found', 'resolved_ok', 'false_positives']
    .some((column) => Number.isNaN(number(row[column] || 0))));
  if (malformed.length) {
    throw new Error(`non-numeric marks in footnote(s) ${malformed.map((row) => row.footnote).join(', ')}`);
  }

  const strata = design.strata.map(({ stratum, population }) => ({
    stratum,
    population,
    rows: done.filter((row) => row.stratum === stratum).map((row) => ({
      authorities: number(row.authorities || 0),
      found: number(row.found || 0),
      resolvedOk: number(row.resolved_ok || 0),
      falsePositives: number(row.false_positives || 0),
      detected: number(row.ibid_count || 0),
    })),
  }));

  const authorities = totalEstimate(strata, (row) => row.authorities);
  const recall = ratioEstimate(strata, (row) => row.found, (row) => row.authorities);
  const precision = ratioEstimate(strata,
    (row) => Math.max(0, row.detected - row.falsePositives), (row) => row.detected);
  const resolution = ratioEstimate(strata, (row) => row.resolvedOk, (row) => row.found);

  console.log(`${design.document} — ${design.footnotes} footnotes, ${done.length} marked (seed ${design.seed})\n`);
  for (const { stratum, population, rows } of strata) {
    const short = rows.length < 2 ? '  ← too few marked to estimate variance' : '';
    console.log(`  ${stratum.padEnd(14)} ${String(rows.length).padStart(4)} of ${String(population).padStart(5)}${short}`);
  }
  if (missing) console.log(`\n  ${missing} row(s) not yet marked — excluded, not counted as zero.`);

  console.log('\n  authorities in the document   ' + asCount(authorities));
  console.log('  recall                        ' + asPercent(recall));
  console.log('  precision                     ' + asPercent(precision));
  console.log('  resolution accuracy           ' + asPercent(resolution));

  // Which stratum is paying for the width. On this design it is almost always the large
  // silent one, and saying so turns "the interval is wide" into "mark forty more of these".
  const widest = strata
    .filter(({ rows }) => rows.length >= 2)
    .map((stratum) => ({
      stratum: stratum.stratum,
      share: stratum.population ** 2 * (1 - stratum.rows.length / stratum.population)
        * sampleVariance(stratum.rows.map((row) => row.authorities)) / stratum.rows.length,
    }))
    .sort((a, b) => b.share - a.share)[0];
  if (widest?.share > 0) {
    console.log(`\n  Most of the uncertainty is in "${widest.stratum}". Mark more of that stratum to narrow it:`);
    console.log(`    npm run accuracy:sample -- <document> --stratum ${widest.stratum}=<more> --seed ${design.seed}`);
  }
}

await main();
