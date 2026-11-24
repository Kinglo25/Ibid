#!/usr/bin/env node
/**
 * Fetch the public documents Ibid is checked against, and turn each into the Word document a
 * reviewer would open.
 *
 * Every round of samples so far has found defects the one before could not, which says the
 * samples are the bottleneck and not the fixes. Until now each one arrived by hand, as a file
 * someone dropped into `samples/`, so the set grew one document at a time and nobody else could
 * rebuild it. This makes the set a list: `samples.manifest.json` names each document by where it
 * is published, and this script downloads it and converts it.
 *
 * What is listed is what lawyers write. The documents in `samples/` were all drafted by the
 * Commission, and a Commission drafter cites the way the Commission cites; the people Ibid is
 * for write submissions, and the published replies to the Commission's consultations are the
 * largest public body of those there is — law firms, bar associations, in-house lawyers,
 * academics, in English, in French, and in both at once.
 *
 * The conversion is Word's own: `Documents.Open` on the PDF, then `SaveAs2` as .docx, which is
 * how the samples already in `samples/` were made and what a reviewer handed a PDF does. So
 * what it damages — footnotes merged, split over a page, flattened into the body — is damage a
 * reviewer meets. It needs Word on Windows through `powershell.exe`; without it the PDFs are
 * still fetched and nothing is converted.
 *
 *   npm run samples                  fetch what is missing, convert what is not yet converted
 *   npm run samples -- --offline     convert only what is already downloaded
 *   npm run samples -- <id> …        only these documents
 *
 * Everything lands in `.samples-cache/`, which is not in the repository: the documents are
 * public but name their authors, and they are the size of a small archive. Each PDF's SHA-256
 * is in the manifest, and a download that does not match is reported rather than used, since an
 * answer key describes one version of a document and not whatever is published under its URL.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { docxBody, notesFromDocx, zipEntries } from './corpus-sources.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(root, '.samples-cache');
const manifestPath = join(root, 'scripts', 'samples.manifest.json');
const USER_AGENT = 'Ibid/0.1 (EU legal citation review; sample documents)';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const only = new Set(args.filter((arg) => !arg.startsWith('--')));

export const pdfPath = (id) => join(cache, 'pdf', `${id}.pdf`);
export const docxPath = (id) => join(cache, 'docx', `${id}.docx`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The PDF for one entry, from its own URL or out of the archive it was published in. */
async function fetchPdf(entry, manifest) {
  if (entry.url) return download(entry.url);
  const archive = manifest.archives[entry.archive];
  const path = join(cache, 'archives', `${entry.archive}.zip`);
  if (!existsSync(path)) {
    await mkdir(join(cache, 'archives'), { recursive: true });
    await writeFile(path, await download(archive.url));
  }
  const found = zipEntries(await readFile(path), [entry.member]).get(entry.member);
  if (!found) throw new Error(`${entry.member} is not in ${archive.url}`);
  return found;
}

/**
 * Word, opening each PDF and saving it as .docx, in one session so Word starts once.
 *
 * `DisplayAlerts = 0` is what stops Word asking whether to convert, which it otherwise does in
 * a dialog no one is there to answer. Each document is written as soon as it is saved, so a
 * run that dies part way keeps what it finished and the next run converts the rest.
 */
const CONVERT = `
param([string]$List)
$ErrorActionPreference = 'Stop'
$pairs = Get-Content -Raw -Encoding UTF8 $List | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  foreach ($pair in $pairs) {
    try {
      $doc = $word.Documents.Open($pair.pdf, $false, $false, $false)
      try { $doc.SaveAs2($pair.docx, 16) } finally { $doc.Close($false) }
      Write-Output ("converted " + $pair.id)
    } catch { Write-Output ("failed " + $pair.id + ": " + $_.Exception.Message) }
  }
} finally { $word.Quit() }
`;

async function windowsPath(path) {
  const { stdout } = await run('wslpath', ['-w', path]);
  return stdout.trim();
}

async function convert(entries) {
  if (entries.length === 0) return;
  try {
    await run('powershell.exe', ['-NoProfile', '-Command', 'exit 0']);
  } catch {
    console.log(`Word is not reachable through powershell.exe: ${entries.length} documents left unconverted.`);
    return;
  }
  await mkdir(join(cache, 'docx'), { recursive: true });
  const script = join(cache, 'convert.ps1');
  const list = join(cache, 'convert.json');
  await writeFile(script, CONVERT);
  const pairs = [];
  for (const entry of entries) pairs.push({ id: entry.id, pdf: await windowsPath(pdfPath(entry.id)), docx: await windowsPath(docxPath(entry.id)) });
  await writeFile(list, JSON.stringify(pairs));
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', await windowsPath(script), '-List', await windowsPath(list)],
    { timeout: 120_000 * entries.length, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(stdout);
  await rm(script);
  await rm(list);
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = manifest.documents.filter((entry) => only.size === 0 || only.has(entry.id));
  if (entries.length === 0) throw new Error(`no document in the manifest is called ${[...only].join(', ')}`);

  let failed = 0;
  const toConvert = [];
  for (const entry of entries) {
    const path = pdfPath(entry.id);
    if (!existsSync(path)) {
      if (offline) continue;
      try {
        const bytes = await fetchPdf(entry, manifest);
        await mkdir(join(cache, 'pdf'), { recursive: true });
        await writeFile(path, bytes);
        // Spaced out: these are public services, and a run fetches dozens of documents.
        if (entry.url) await sleep(1_000);
      } catch (error) {
        console.log(`${entry.id}: not fetched — ${error.message}`);
        failed += 1;
        continue;
      }
    }
    const hash = sha256(await readFile(path));
    if (entry.sha256 && entry.sha256 !== hash) {
      console.log(`${entry.id}: the PDF is not the one the manifest lists (sha256 ${hash}); not used`);
      failed += 1;
      continue;
    }
    if (!existsSync(docxPath(entry.id))) toConvert.push(entry);
  }
  await convert(toConvert);

  console.log('\nid · Word footnotes · notes read · body paragraphs');
  for (const entry of entries) {
    if (!existsSync(docxPath(entry.id))) {
      console.log(`${entry.id} · not converted`);
      continue;
    }
    const [notes, body] = await Promise.all([notesFromDocx(docxPath(entry.id)), docxBody(docxPath(entry.id))]);
    console.log(`${entry.id} · ${body.footnoteReferences} · ${notes.length} · ${body.paragraphs.length}`);
  }
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
