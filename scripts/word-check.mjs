#!/usr/bin/env node
/**
 * Ask real Word what a document's footnotes are, and report where the corpus reader disagrees.
 *
 * Everything else in this repository reads a .docx by unzipping it and parsing the XML. That
 * is the right thing for a harness — no Office, no Windows, runs anywhere — but it means the
 * reader has never been compared against the one authority that settles the question. The
 * bug that cost the most here was exactly of that kind: Word hands a footnote back with the
 * reference mark still on the front of it, and no fixture in this repository knew, because
 * every fixture was typed by hand.
 *
 * This does not test the pane. Word's `Range.Text` and Office.js's `body.text` are not the
 * same string — the reference mark shows up in one and not the other — so what this settles
 * is narrower, and worth stating plainly: whether the corpus is reading the same footnotes
 * out of a file that Word reads out of it. Where they disagree, the corpus is measuring a
 * document nobody will ever open.
 *
 *   npm run word-check                        every sample in samples/ibid-demo-docx
 *   npm run word-check -- path/to/file.docx   one document
 *
 * Requires Word on Windows, reachable through `powershell.exe` — so WSL, or Windows itself.
 * Exits non-zero where Word and the reader disagree about a footnote.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { notesFromDocx } from './corpus-sources.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const samples = join(root, 'samples/ibid-demo-docx');

/** A Windows path for a file that lives on this side of the divide. */
async function windowsPath(path) {
  const { stdout } = await run('wslpath', ['-w', path]);
  return stdout.trim();
}

/**
 * What Word says the footnotes are.
 *
 * Written to a file rather than read off stdout, and in UTF-8 explicitly, because a decision
 * is full of the characters that do not survive the default encoding between PowerShell and
 * this side — the ligatures, the non-breaking hyphens, and every accented party name.
 */
const SCRIPT = `
param([string]$Document, [string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Open($Document, $false, $true)
  try {
    $notes = @()
    for ($i = 1; $i -le $doc.Footnotes.Count; $i++) { $notes += $doc.Footnotes.Item($i).Range.Text }
    for ($i = 1; $i -le $doc.Endnotes.Count; $i++) { $notes += $doc.Endnotes.Item($i).Range.Text }
    $json = ConvertTo-Json -InputObject @{ notes = $notes } -Depth 3
    [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
  } finally { $doc.Close($false) }
} finally { $word.Quit() }
`;

/**
 * The same footnote as Word and as the file, reduced to what both can be expected to agree
 * on. Word puts the reference mark on the front and a carriage return on the end, neither of
 * which is the note; a non-breaking space is a space wherever it came from. Beyond that, a
 * difference is a real one.
 */
const comparable = (text) => String(text ?? '')
  // The reference mark Word puts on the front of a footnote is U+0002, so matching a
  // control character here is the whole job rather than an oversight.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0002\r\n\t]/g, ' ')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function askWord(path, scriptPath) {
  const workspace = await mkdtemp(join(tmpdir(), 'ibid-word-'));
  const out = join(workspace, 'notes.json');
  try {
    await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', await windowsPath(scriptPath),
      '-Document', await windowsPath(path), '-Out', await windowsPath(out),
    ], { timeout: 300_000 });
    const parsed = JSON.parse(await readFile(out, 'utf8'));
    // One footnote comes back as a bare string rather than an array of one, and an empty
    // footnote — Word keeps the slot when the text is deleted — comes back as null.
    const notes = Array.isArray(parsed.notes) ? parsed.notes : [parsed.notes].filter((note) => note !== undefined);
    return notes.map((note) => String(note ?? ''));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const given = process.argv.slice(2);
const targets = given.length
  ? given
  : (existsSync(samples)
    ? (await readdir(samples)).filter((name) => name.endsWith('.docx')).sort().map((name) => join(samples, name))
    : []);

if (targets.length === 0) {
  console.error('nothing to check: no .docx given, and none in samples/ibid-demo-docx');
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), 'ibid-ps-'));
const scriptPath = join(workspace, 'footnotes.ps1');
await writeFile(scriptPath, SCRIPT, 'utf8');

let disagreements = 0;
try {
  for (const path of targets) {
    const name = path.split('/').pop();
    if (!existsSync(path)) { console.log(`— ${name}: not present`); continue; }

    let fromWord;
    try {
      fromWord = await askWord(path, scriptPath);
    } catch (error) {
      console.error(`— ${name}: Word could not open it — ${String(error.message).split('\n')[0]}`);
      disagreements += 1;
      continue;
    }
    const fromFile = await notesFromDocx(path);

    // The reader deliberately finds more than Word does: a PDF conversion leaves notes in
    // body text, and Word does not call those footnotes at all. Those are the point of it,
    // so only the leading run — the notes that really are footnotes in the file — is
    // compared, and the remainder is reported as what it is rather than as a disagreement.
    const compared = Math.min(fromWord.length, fromFile.length);
    const differing = [];
    for (let i = 0; i < compared; i += 1) {
      if (comparable(fromWord[i]) !== comparable(fromFile[i])) differing.push(i);
    }

    const inBody = fromFile.length - fromWord.length;
    console.log(
      `— ${name}: Word ${fromWord.length}, reader ${fromFile.length}`
      + (inBody > 0 ? ` (${inBody} from body text, which Word does not count)` : '')
      + `, ${differing.length} disagreeing`,
    );
    for (const index of differing.slice(0, 3)) {
      console.log(`    note ${index + 1}`);
      console.log(`      Word:   ${JSON.stringify(comparable(fromWord[index]).slice(0, 100))}`);
      console.log(`      reader: ${JSON.stringify(comparable(fromFile[index]).slice(0, 100))}`);
    }
    const missing = fromWord.length - fromFile.length;
    if (missing > 0) console.log(`    ${missing} footnote(s) Word holds that the reader never found`);
    disagreements += differing.length + Math.max(0, missing);
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}

if (disagreements > 0) {
  console.error(`\nFAILED — ${disagreements} place(s) where the reader and Word do not agree`);
  process.exit(1);
}
console.log('\nOK — the reader and Word agree on every footnote they both hold');
