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
  return notes.length ? notes : notesFromLegacy(html);
}

/**
 * The least number of notes a trailing run has to hold before it is believed.
 *
 * A judgment numbers its operative part from one as well, so every Court document restarts
 * its counting somewhere and the rule below would hand back three rulings as though they
 * were footnotes. Nothing with an apparatus worth measuring has fewer than ten.
 */
const LEGACY_MINIMUM = 10;

/**
 * Footnotes in the rendition CELLAR serves for the years before Formex.
 *
 * There is no markup to find them by. The document is 1200 bare `<p>` elements, and a
 * footnote is written exactly like a numbered recital — `(383) See Judgement of the Court of
 * 18 October 1989 in Case Orkem v Commission [1989] ECR 3283` sits beside `(383) The
 * undertakings concerned dispute this`, and neither carries a class, an anchor, or an
 * attribute the other does not. What separates them is that each series is numbered from
 * one, so the document counts up, drops back to `(1)`, and counts up again. The footnotes
 * are the last of those runs.
 *
 * This matters more than a rendition quirk should. Reading only `<p class="note">` reported
 * every pre-2006 Commission decision as holding no notes whatever, and a document with no
 * notes has no missed citations either — so the harness scored perfect recall over 542
 * footnotes it never read, and said so in the same voice it uses for a document it did.
 */
export function notesFromLegacy(html) {
  const numbered = [];
  for (const paragraph of html.matchAll(/<p[ >][\s\S]*?<\/p>/gi)) {
    const text = decodeEntities(paragraph[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const match = /^\((\d{1,4})\)\s+(.+)$/.exec(text);
    if (match) numbered.push({ number: Number(match[1]), text: match[2] });
  }
  let start = -1;
  let previous = 0;
  numbered.forEach((entry, index) => {
    if (entry.number <= previous) start = index;
    previous = entry.number;
  });
  if (start < 0) return [];
  const notes = numbered.slice(start).map((entry) => entry.text);
  return notes.length >= LEGACY_MINIMUM ? notes : [];
}

/**
 * Below this a numbered paragraph is a heading or a table cell rather than a note. The pane
 * holds the same floor as `INLINE_NOTE_FLOOR`; the two are one number and must stay so, or
 * the corpus measures a document listing notes the reviewer's pane does not.
 */
const NOTE_FLOOR = 30;

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()]);
}

/**
 * Enough of a zip reader to open a .docx, so this script needs no dependency and no
 * `unzip` on the path. Only the stored and deflated methods exist in practice in an
 * Office file, and only four entries are ever wanted out of it.
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

/**
 * The text of a run of Word XML, with the things that are whitespace on the page but not
 * characters in the file put back.
 *
 * A footnote is routinely more than one paragraph — a decision's citation and the comment on
 * it are written as two — and joining the `<w:t>` runs straight through closes the gap that
 * Word draws, so `3rd` followed by a new paragraph came out as `rdIntel submission` where
 * Word reads `rd Intel submission`. Detection then ran on text nobody would ever see, which
 * is the corpus measuring a document that does not exist. Tabs and line breaks are the same
 * case; `scripts/word-check.mjs` is what found it, by asking Word.
 */
const textOf = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>|<w:tab\/>|<w:br\/>/g)]
  .map((match) => (match[1] === undefined ? ' ' : decodeEntities(match[1])))
  .join('');

/**
 * What a .docx holds besides its notes: how many of them are Word's own footnotes, and the text
 * of every body paragraph.
 *
 * `notesFromDocx` lists Word's footnotes first and the notes it finds in the body after them,
 * as the pane does, so the count says where one ends and the other begins. The paragraphs are
 * where the pane reads a citation written into the running text.
 */
export async function docxBody(path) {
  const parts = readZip(await readFile(path), ['word/document.xml']);
  const document = parts.get('word/document.xml') ?? '';
  return {
    footnoteReferences: [...document.matchAll(/<w:footnoteReference[^>]*w:id="\d+"/g)].length,
    paragraphs: [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((paragraph) => textOf(paragraph[0]).trim()).filter(Boolean),
  };
}

/**
 * Every note a .docx holds, in all three shapes a PDF-converted decision arrives in: Word's own
 * footnotes, body paragraphs opening with a typed superscript number, and body paragraphs
 * whose number Word draws from a list definition. The pane reads exactly these three, so
 * the corpus must too — measuring only the first would report a document as clean while
 * the reviewer cannot resolve a citation in it.
 */
export async function notesFromDocx(path) {
  const parts = readZip(await readFile(path), ['word/document.xml', 'word/footnotes.xml', 'word/numbering.xml', 'word/styles.xml']);
  const document = parts.get('word/document.xml') ?? '';
  const footnotes = parts.get('word/footnotes.xml') ?? '';
  const numbering = parts.get('word/numbering.xml') ?? '';
  const styles = parts.get('word/styles.xml') ?? '';

  const stored = new Map();
  for (const chunk of footnotes.split(/(?=<w:footnote )/)) {
    const id = /<w:footnote [^>]*w:id="(-?\d+)"/.exec(chunk);
    if (id) stored.set(Number(id[1]), textOf(chunk));
  }
  const notes = [...document.matchAll(/<w:footnoteReference[^>]*w:id="(\d+)"/g)]
    .map((match) => stored.get(Number(match[1])) ?? '');

  const abstracts = new Map([...numbering.matchAll(/<w:abstractNum w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)].map((m) => [m[1], m[0]]));
  const links = new Map([...numbering.matchAll(/<w:num w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)].map((m) => [m[1], m[2]]));
  /** How a list draws its number - `%1` bare, `(%1)`, `%1.`, `%1)` - or nothing, for a bullet. */
  const numberShape = (numId) => {
    const level = /<w:lvl w:ilvl="0"[\s\S]*?<\/w:lvl>/.exec(abstracts.get(links.get(numId) ?? '') ?? '');
    const shape = level ? /<w:lvlText w:val="([^"]*)"/.exec(level[0])?.[1] : undefined;
    return shape && /^\(?%1[).]?$/.test(shape) ? shape : undefined;
  };

  const styleSizes = new Map();
  for (const style of styles.matchAll(/<w:style [^>]*w:styleId="([^"]+)"[\s\S]*?<\/w:style>/g)) {
    const size = /<w:sz w:val="(\d+)"/.exec(style[0]);
    if (size) styleSizes.set(style[1], Number(size[1]) / 2);
  }
  const defaultSize = Number(/<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:sz w:val="(\d+)"/.exec(styles)?.[1] ?? 22) / 2;

  const shaped = [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((paragraph) => {
    const properties = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph[0])?.[0] ?? '';
    const inherited = styleSizes.get(/<w:pStyle w:val="([^"]+)"/.exec(properties)?.[1] ?? '') ?? defaultSize;
    const sizes = new Set();
    for (const run of paragraph[0].matchAll(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g)) {
      if (!textOf(run[0]).trim()) continue;
      const own = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run[0])?.[0] ?? '';
      sizes.add(Number(/<w:sz w:val="(\d+)"/.exec(own)?.[1] ?? inherited * 2) / 2);
    }
    const numId = /<w:numId w:val="(\d+)"/.exec(properties)?.[1];
    return {
      text: textOf(paragraph[0]).trim(),
      shape: numId ? numberShape(numId) : undefined,
      // One size, or `undefined` where the runs disagree - which is what Office.js reports to
      // the pane as a null `font.size`, so both readers give up on the same paragraphs.
      size: sizes.size === 1 ? [...sizes][0] : undefined,
    };
  });

  // The size this document's prose is set in, counted over the paragraphs carrying no number
  // of their own. Deliberately not the commonest size in the document: in the
  // exclusionary-abuses guidelines the 483 flattened footnotes outweigh the 255 paragraphs of
  // text, so the commonest size *is* the footnote size and every test against it inverts.
  // Where this still lands too low nothing is smaller than it, no paragraph is admitted by
  // size, and the reader falls back on what it found before - the safe direction to be wrong in.
  const proseSizes = new Map();
  for (const paragraph of shaped) {
    if (paragraph.shape || paragraph.size === undefined || paragraph.text.length < NOTE_FLOOR) continue;
    proseSizes.set(paragraph.size, (proseSizes.get(paragraph.size) ?? 0) + 1);
  }
  const proseSize = [...proseSizes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const belowProse = (size) => proseSize !== undefined && size !== undefined && size < proseSize;

  const written = shaped.filter((paragraph) => paragraph.text);
  /** Whether a paragraph is one of the numbered notes of a block set at `size`. */
  const startsNote = (paragraph, size) =>
    paragraph?.shape !== undefined && paragraph.text.length >= NOTE_FLOOR
    && paragraph.size === size && belowProse(paragraph.size);

  /**
   * Whether the unnumbered paragraph at `at` is inside a block of notes rather than merely
   * next to one — that is, whether another numbered note of the same size closes the run of
   * unnumbered paragraphs it belongs to.
   *
   * Being closed is what makes this safe. Asking only whether a note stands nearby lets a
   * tail chain into the next paragraph, and that one into the one after it: the Intel
   * decision sets long stretches of quoted submissions two points down from its prose, and a
   * single note falling next to one of them swallowed 14,000 characters of it. A run that
   * ends in a note is a page's footnotes; a run that ends anywhere else is the document.
   */
  const insideNoteBlock = (at, size) => {
    for (let next = at + 1; next < written.length; next += 1) {
      if (written[next].size !== size) return false;
      if (written[next].shape !== undefined) return startsNote(written[next], size);
    }
    return false;
  };

  // The note a stray paragraph would belong to, while one is open - only ever a note set
  // smaller than the prose, which is the case where a block at the foot of a page was
  // flattened into the body and its tail left behind. See the join below.
  let open;
  for (const [at, { text, shape, size }] of written.entries()) {
    if (shape) {
      // A numbered paragraph that is not itself a note leaves any open note open. It is
      // ordinarily a paragraph of the document's own prose, and the page of it standing
      // between a note and its remainder is exactly what has to be crossed here.
      if (text.length < NOTE_FLOOR) continue;
      // A bare `275` is a note whatever size it is set in: the Intel decision's flattened
      // footnotes are numbered that way and set in the same 12pt as its recitals, so the
      // numbering is the only thing telling the two apart. A number Word wraps - `(89)`,
      // `39.` - is a note only where it is *also* set smaller than the prose, because a
      // wrapped number is what that same decision numbers its recitals with. The two
      // documents disagree about which shape means which; only the size agrees with both.
      if (shape === '%1' || belowProse(size)) {
        notes.push(text);
        // Only a note set smaller than the prose can take a tail. A bare number at prose size
        // is the Intel shape, where nothing was broken across a page and there is no tail to
        // take — and in the exclusionary-abuses guidelines the same shape is a sub-list of the
        // document's own text, which must not swallow the remainder of a real note either.
        if (belowProse(size)) open = { at: notes.length - 1, size };
      }
      continue;
    }
    // A note broken over a page break, whose tail the conversion left as its own paragraph.
    // Joined rather than listed: all 84 citations in the 52 such paragraphs of the
    // exclusionary-abuses guidelines are already inside the note above them, so listing them
    // separately would double-count every one and leave half a note in the reviewer's list.
    //
    // A tail is not always next to the note it belongs to. Where a note runs past the foot of
    // its page, the conversion prints the remainder at the head of the *next* page's block,
    // so a page of the document's own prose stands between the two. What still holds is that
    // the tail sits inside a block of notes, which is what is asked here — adjacency to the
    // note itself would strand it, and mere distance would let any small paragraph in the
    // document join any note.
    // The last note of a block runs on with nothing of its size after it to close the run, so
    // a paragraph following its note directly is taken as well. That one cannot chain: the
    // paragraph after it is preceded by no note, and has to be closed by one to be read as a
    // tail at all.
    if (open && size !== undefined && size === open.size
        && (insideNoteBlock(at, size) || startsNote(written[at - 1], size))) {
      notes[open.at] += ` ${text}`;
      continue;
    }
    // Nothing closes an open note but the next note. A heading or a paragraph of prose between
    // a note and its remainder is the ordinary case, not a reason to give up on the join —
    // what keeps this from reaching across the whole document is the block test above.
    if (/^\d{1,3}[ \t\u00a0]+[A-Z“‘"']/.test(text) && text.length >= 34) {
      notes.push(text.replace(/^\d{1,3}[ \t\u00a0]+/, ''));
    }
  }
  return notes;
}
