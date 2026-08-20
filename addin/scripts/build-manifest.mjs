#!/usr/bin/env node
/**
 * Produces a hosted manifest from the development one.
 *
 * The manifest is the only artefact that carries an absolute origin, and it carries it in
 * eight places — SourceLocation, AppDomains, three ribbon icons, two IconUrls, the support
 * URL and the command file. Maintaining a second copy for the hosted build guarantees the
 * two drift, and a manifest that disagrees with itself fails inside Word with no useful
 * message. So there is one manifest, and this rewrites its origin.
 *
 *   node scripts/build-manifest.mjs https://ibid.example.com [--id <guid>] [--out <path>]
 *
 * `--id` matters when one person needs both the dev and hosted add-ins installed at once:
 * Office keys an add-in by its <Id>, so two manifests sharing an Id are one add-in as far
 * as Word is concerned, and the second silently replaces the first.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_ORIGIN = 'https://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));

const [, , originArg, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};

if (!originArg || originArg.startsWith('-')) {
  console.error('Usage: node scripts/build-manifest.mjs <https://origin> [--id <guid>] [--out <path>]');
  process.exit(1);
}

let origin;
try {
  const parsed = new URL(originArg);
  if (parsed.protocol !== 'https:') throw new Error('must be https');
  origin = parsed.origin;
} catch {
  // Office refuses to load a task pane over plain HTTP, and an origin with a stray path or
  // trailing slash produces URLs like `https://host//taskpane.html` that 404 in the pane
  // rather than at build time. Both are worth catching here rather than in Word.
  console.error(`Not a usable add-in origin: ${originArg}\nIt must be an https:// origin, e.g. https://ibid.example.com`);
  process.exit(1);
}

const source = resolve(here, '..', 'manifest.xml');
const target = resolve(process.cwd(), flag('--out') ?? 'dist/manifest.xml');

let xml = await readFile(source, 'utf8');
if (!xml.includes(DEV_ORIGIN)) {
  console.error(`${source} no longer contains ${DEV_ORIGIN}; this script has gone stale.`);
  process.exit(1);
}
xml = xml.replaceAll(DEV_ORIGIN, origin);

const id = flag('--id');
if (id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    console.error(`--id must be a GUID, got: ${id}`);
    process.exit(1);
  }
  xml = xml.replace(/<Id>[^<]+<\/Id>/, `<Id>${id}</Id>`);
}

await writeFile(target, xml, 'utf8');
console.log(`Wrote ${target}\n  origin: ${origin}${id ? `\n  id:     ${id}` : ''}`);
console.log('\nValidate it before sending:\n  npx office-addin-manifest validate ' + target);
