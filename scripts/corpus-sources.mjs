/**
 * Where a corpus document comes from, and how its notes are got out of it.
 *
 * Two kinds, because the two halves of the problem live in different places. CELLAR serves
 * the Court's own drafting — every convention the Court uses, in bulk, free — and that is
 * where citation *parsing* is exercised. Real client documents are Word files converted from
 * PDF, and that is where the *footnotes* stop being footnotes; nothing fetched from CELLAR
 * will ever reproduce a note the conversion left in the body text.
 */

import { inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const CELLAR = 'https://publications.europa.eu/resource/celex/';
const FORMATS = ['application/xhtml+xml', 'text/html'];
const USER_AGENT = 'Ibid/0.1 (EU legal citation review; corpus harness)';

/**
 * CELLAR refuses a request with no `Accept-Language`, and holds different eras in different
 * formats — recent documents only as `application/xhtml+xml`, older ones only as
 * `text/html`. Both fallbacks are the resolver's, kept in step with it deliberately: a
 * corpus that could reach documents the pane cannot would measure the wrong program.
 */
export async function fetchCellar(celex, { accept = 'application/xhtml+xml', languages = ['en', 'fr'] } = {}) {
  for (const language of languages) {
    for (const format of accept === 'application/rdf+xml' ? [accept] : FORMATS) {
      const response = await fetch(CELLAR + celex, {
        headers: { Accept: format, 'Accept-Language': language, 'User-Agent': USER_AGENT },
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`${celex}: CELLAR answered ${response.status}`);
      return { text: await response.text(), language, format };
    }
  }
  return undefined;
}

/** The ECLI a CELEX declares for itself. The only oracle here that needs no hand-labelling. */
export async function ecliOf(celex) {
  const got = await fetchCellar(celex, { accept: 'application/rdf+xml', languages: ['en'] });
  if (!got) return undefined;
  const match = /resource\/ecli\/(ECLI(?:%3A|:)[^"'.]+)/i.exec(got.text);
  return match ? decodeURIComponent(match[1]).toUpperCase() : undefined;
}

/**
 * Whether what came back is the document or the wrapper around it.
 *
 * The resolver already learned this the hard way — anonymous access has been observed
 * serving a bot-verification page under an ordinary `200`. Here it showed up as an Advocate
 * General opinion with no footnotes at all, which is a far quieter way to be wrong: a corpus
 * that silently reads nothing reports perfect recall.
 */
function isDocument(html) {
  if (/<!--\s*(?:CONVEX|fmx2xhtml)\b/i.test(html)) return true;
  if (/class="(?:coj-|note)/i.test(html)) return true;
  return /<meta\s+name="DC\.title"\s+content="EUR-Lex\b/i.test(html);
}

/**
 * The Court's own footnotes, in the two renditions CELLAR serves them in:
 * `<p class="note">(<span class="note"><a …>4</a></span>)\tSee …</p>` for the classic
 * rendering, and `<p class="coj-note">` for the CURIA-native one. Opinions of the same era
 * come in either, so reading only the first quietly returned nothing for a whole slice of
 * the corpus. The marker is dropped so a note reads as its text, which is what the pane holds.
 */
export function notesFromCellar(html) {
  if (!isDocument(html)) return undefined;
  const notes = [];
  for (const match of html.matchAll(/<p class="(?:coj-)?note"[^>]*>([\s\S]*?)<\/p>/gi)) {
    const withoutMarker = match[1]
      .replace(/^\s*\(\s*<span class="(?:coj-)?note"[^>]*>[\s\S]*?<\/span>\s*\)/i, '')
      .replace(/^\s*<a[^>]*>[\s\S]*?<\/a>\s*[).\u2013-]*/i, '');
    const text = decodeEntities(withoutMarker.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) notes.push(text);
  }
  return notes;
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()]);
}

/**
 * Enough of a zip reader to open a .docx, so this script needs no dependency and no
 * `unzip` on the path. Only the stored and deflated methods exist in practice in an
 * Office file, and only three entries are ever wanted out of it.
 */
function readZip(buffer, wanted) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const found = new Map();
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const offset = buffer.readUInt32LE(at + 42);
    if (wanted.includes(name)) {
      const localExtra = buffer.readUInt16LE(offset + 28);
      const localName = buffer.readUInt16LE(offset + 26);
      const start = offset + 30 + localName + localExtra;
      const method = buffer.readUInt16LE(offset + 8);
      const compressed = buffer.readUInt32LE(at + 20);
      const raw = buffer.subarray(start, start + compressed);
      found.set(name, (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'));
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

const textOf = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1])).join('');

/**
 * Every note a .docx holds, in all three shapes a PDF-converted decision arrives in: Word's own
 * footnotes, body paragraphs opening with a typed superscript number, and body paragraphs
 * whose number Word draws from a list definition. The pane reads exactly these three, so
 * the corpus must too — measuring only the first would report a document as clean while
 * the reviewer cannot resolve a citation in it.
 */
export async function notesFromDocx(path) {
  const parts = readZip(await readFile(path), ['word/document.xml', 'word/footnotes.xml', 'word/numbering.xml']);
  const document = parts.get('word/document.xml') ?? '';
  const footnotes = parts.get('word/footnotes.xml') ?? '';
  const numbering = parts.get('word/numbering.xml') ?? '';

  const stored = new Map();
  for (const chunk of footnotes.split(/(?=<w:footnote )/)) {
    const id = /<w:footnote [^>]*w:id="(-?\d+)"/.exec(chunk);
    if (id) stored.set(Number(id[1]), textOf(chunk));
  }
  const notes = [...document.matchAll(/<w:footnoteReference[^>]*w:id="(\d+)"/g)]
    .map((match) => stored.get(Number(match[1])) ?? '');

  const abstracts = new Map([...numbering.matchAll(/<w:abstractNum w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)].map((m) => [m[1], m[0]]));
  const links = new Map([...numbering.matchAll(/<w:num w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)].map((m) => [m[1], m[2]]));
  const bareNumbered = (numId) => {
    const level = /<w:lvl w:ilvl="0"[\s\S]*?<\/w:lvl>/.exec(abstracts.get(links.get(numId) ?? '') ?? '');
    return level ? /<w:lvlText w:val="%1"/.test(level[0]) : false;
  };

  for (const paragraph of document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const text = textOf(paragraph[0]).trim();
    const numId = /<w:numId w:val="(\d+)"/.exec(paragraph[0]);
    if (numId && bareNumbered(numId[1])) {
      if (text.length >= 30) notes.push(text);
    } else if (/^\d{1,3}[ \t ]+[A-Z“‘"']/.test(text) && text.length >= 34) {
      notes.push(text.replace(/^\d{1,3}[ \t ]+/, ''));
    }
  }
  return notes;
}
