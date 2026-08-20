#!/usr/bin/env python3
"""
Rebuilds Commission_decision_X_DSA.docx from the published PDF of the decision.

The .docx that circulated with this case is a PDF conversion that dropped every footnote
into the body text: `word/footnotes.xml` holds only the separator placeholders, and the 645
footnote texts sit inline in page-sized paragraph blobs, interleaved with body prose. Ibid
reads footnotes, so against that file the task pane is simply empty.

The PDF is the better source, because it still carries the distinction the conversion threw
away. Four font sizes separate the content mechanically, with no guessing at sentence
boundaries:

    h ~ 13.3   body text
    h ~ 11.0   footnote text          (bottom of page)
    h ~  7.2   footnote entry number  (bottom of page, one per note, 1..645 in order)
    h ~  9.0   in-body superscript reference

The footnote entry numbers recovered this way form a gapless ascending 1..645, and the 645
texts agree with an independent extraction from the broken .docx at >0.97 similarity for
every note that can be compared. That agreement is the check that this file is faithful.

    pdftotext -bbox-layout <decision>.pdf layout.xml
    python3 build-commission-decision.py layout.xml Commission_decision_X_DSA.docx

Edit this script, not the .docx.
"""
import json
import re
import sys
import zipfile
from html import unescape
from xml.sax.saxutils import escape

BODY_LO, BODY_HI = 12.5, 14.0      # body prose
NOTE_LO, NOTE_HI = 10.5, 12.4      # footnote text
MARK_LO, MARK_HI = 6.5, 8.4        # footnote entry number
REF_LO, REF_HI = 8.5, 10.4         # in-body superscript reference
PARA_GAP = 17.0                    # a gap wider than one line starts a paragraph
HEADING_H = 14.0                   # anything taller than body is a heading
MARGIN_X = 100.0                   # paragraph numbers sit left of the text column

WORD_RE = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', re.S)
PAGE_RE = re.compile(r'<page width="[\d.]+" height="[\d.]+">(.*?)</page>', re.S)
LINE_RE = re.compile(r'<line [^>]*>(.*?)</line>', re.S)


def read_pages(path):
    """PDF word boxes -> [page][line][word], each word carrying x, y and height."""
    src = open(path, encoding='utf8').read()
    pages = []
    for body in PAGE_RE.findall(src):
        lines = []
        for lm in LINE_RE.findall(body):
            words = [{'x': float(x0), 'y': float(y0), 'h': round(float(y1) - float(y0), 1),
                      't': unescape(t)}
                     for x0, y0, _x1, y1, t in WORD_RE.findall(lm)]
            if words:
                lines.append(sorted(words, key=lambda w: w['x']))
        pages.append(sorted(lines, key=lambda l: (round(l[0]['y'], 1), l[0]['x'])))
    return pages


def is_int(t):
    return re.fullmatch(r'\d{1,3}', t.strip()) is not None


def split_page(lines):
    """Body lines above the first footnote entry number, footnote lines from it down."""
    marks = [w['y'] for l in lines for w in l if MARK_LO <= w['h'] <= MARK_HI and is_int(w['t'])]
    if not marks:
        return lines, []
    top = min(marks)
    body = [l for l in lines if min(w['y'] for w in l) < top - 2]
    foot = [l for l in lines if min(w['y'] for w in l) >= top - 2]
    return body, foot


def collect_footnotes(pages):
    """n -> text. A page whose footnote area opens with prose continues the previous note."""
    notes, current = {}, None
    for lines in pages:
        for l in split_page(lines)[1]:
            for w in l:
                if MARK_LO <= w['h'] <= MARK_HI and is_int(w['t']):
                    current = int(w['t'])
                    notes.setdefault(current, [])
                elif NOTE_LO <= w['h'] <= NOTE_HI and current is not None:
                    notes[current].append(w['t'])
    return {n: join_words(ws) for n, ws in notes.items()}


def join_words(words):
    """
    Words carry no spacing of their own, so rejoin them with single spaces.

    A word ending in a hyphen is glued to the next one with the hyphen kept. This document
    never breaks a word syllabically — every one of its line-final hyphens is already part
    of the text, and they are the ones that matter most here: `C-` `882/19` is a case
    number Ibid has to parse, and dropping that hyphen to `C882/19` makes it unresolvable.
    `Directorate-` `General` and hyphens inside broken URLs behave the same way. A lone
    dash is left as its own word.
    """
    parts = []
    for w in words:
        if parts and parts[-1].endswith('-') and parts[-1] != '-':
            parts[-1] += w
        else:
            parts.append(w)
    return re.sub(r'\s+', ' ', ' '.join(parts)).strip()


def page_notes(lines):
    """The footnote numbers whose entries appear on this page, in order."""
    return [int(w['t']) for l in split_page(lines)[1] for w in l
            if MARK_LO <= w['h'] <= MARK_HI and is_int(w['t'])]


def build_body(pages, max_note):
    """
    Body paragraphs as lists of ('text', str) and ('ref', n) pieces.

    A paragraph starts at a numbered marker in the left margin, at a heading, or after a gap
    wider than one line. Paragraphs run across page breaks, so a page never forces one.
    """
    paras, cur, prev_y, next_ref = [], None, None, 1

    def close():
        nonlocal cur
        if cur and any(p[1] for p in cur['pieces']):
            paras.append(cur)
        cur = None

    for lines in pages:
        body, _ = split_page(lines)
        anchored = set()
        for l in body:
            y = min(w['y'] for w in l)
            x = min(w['x'] for w in l)
            h = max(w['h'] for w in l)
            text = ' '.join(w['t'] for w in l).strip()

            if is_running_head(text, y):
                continue
            marker = re.fullmatch(r'\((\d+)\)', text)
            heading = h >= HEADING_H
            gap = None if prev_y is None else y - prev_y

            if marker and x < MARGIN_X:
                close()
                cur = {'style': 'Para', 'label': text, 'pieces': []}
                prev_y = y
                continue
            if heading:
                close()
                cur = {'style': 'Heading', 'label': None, 'pieces': []}
            elif cur is None or (gap is not None and gap > PARA_GAP):
                close()
                cur = {'style': 'Body', 'label': None, 'pieces': []}

            for w in l:
                if REF_LO <= w['h'] <= REF_HI and is_int(w['t']) and int(w['t']) == next_ref:
                    cur['pieces'].append(('ref', next_ref))
                    anchored.add(next_ref)
                    next_ref += 1
                else:
                    cur['pieces'].append(('text', w['t']))
            prev_y = y

        # Every footnote must be referenced or Word will not show it. Any note whose marker
        # was not matched in the prose lands at the end of the page that carries its text,
        # which keeps the reading order — and so Ibid's back-reference chains — intact.
        for n in page_notes(lines):
            if n not in anchored and n == next_ref and n <= max_note:
                if cur is None:
                    cur = {'style': 'Body', 'label': None, 'pieces': []}
                cur['pieces'].append(('ref', next_ref))
                next_ref += 1
    close()
    return paras, next_ref - 1


def is_running_head(text, y):
    return (y < 45 or y > 790) and (text in {'EN', 'EN EN'} or re.fullmatch(r'\d{1,3}', text))


def pieces_to_xml(pieces):
    """Merge adjacent words into runs and emit footnote references between them."""
    out, buf = [], []
    need_space = False

    def flush():
        nonlocal need_space
        if buf:
            text = join_words(buf)
            if need_space:
                text = ' ' + text
            out.append(f'<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r>')
            buf.clear()
            need_space = False

    for kind, val in pieces:
        if kind == 'text':
            buf.append(val)
        else:
            flush()
            out.append('<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>'
                       f'<w:footnoteReference w:id="{val}"/></w:r>')
            # The superscript swallows the space that separated it from the next word.
            need_space = True
    flush()
    return ''.join(out)


def document_xml(paras):
    body = []
    for p in paras:
        style = {'Heading': 'Heading2', 'Para': 'BodyNum'}.get(p['style'], 'Normal')
        lead = ''
        if p['label']:
            lead = (f'<w:r><w:t xml:space="preserve">{escape(p["label"])} </w:t></w:r>')
        body.append(f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>'
                    f'{lead}{pieces_to_xml(p["pieces"])}</w:p>')
    return (XML_HEAD + '<w:document ' + NS + '><w:body>' + ''.join(body) +
            '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>'
            '</w:sectPr></w:body></w:document>')


def footnotes_xml(notes):
    parts = [
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r>'
        '<w:continuationSeparator/></w:r></w:p></w:footnote>',
    ]
    for n in sorted(notes):
        parts.append(
            f'<w:footnote w:id="{n}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'
            '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
            f'<w:r><w:t xml:space="preserve"> {escape(notes[n])}</w:t></w:r></w:p></w:footnote>')
    return XML_HEAD + '<w:footnotes ' + NS + '>' + ''.join(parts) + '</w:footnotes>'


XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')

STYLES = XML_HEAD + '<w:styles ' + NS + '>'
STYLES += ('<w:docDefaults><w:rPrDefault><w:rPr>'
           '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>'
           '<w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>')
STYLES += '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
STYLES += ('<w:style w:type="paragraph" w:styleId="BodyNum"><w:name w:val="Body Numbered"/>'
           '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="120"/>'
           '<w:jc w:val="both"/></w:pPr></w:style>')
STYLES += ('<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
           '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/>'
           '<w:spacing w:before="240" w:after="120"/></w:pPr>'
           '<w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>')
STYLES += ('<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/>'
           '<w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>')
STYLES += ('<w:style w:type="character" w:styleId="FootnoteReference">'
           '<w:name w:val="footnote reference"/>'
           '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>')
STYLES += '</w:styles>'

SETTINGS = (XML_HEAD + '<w:settings ' + NS + '><w:footnotePr>'
            '<w:footnote w:id="-1"/><w:footnote w:id="0"/>'
            '</w:footnotePr></w:settings>')

CONTENT_TYPES = (XML_HEAD +
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
                 'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.'
                 'openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.'
                 'openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
                 '<Override PartName="/word/styles.xml" ContentType="application/vnd.'
                 'openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                 '<Override PartName="/word/settings.xml" ContentType="application/vnd.'
                 'openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>')

ROOT_RELS = (XML_HEAD +
             '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
             'relationships/officeDocument" Target="word/document.xml"/></Relationships>')

DOC_RELS = (XML_HEAD +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/footnotes" Target="footnotes.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/styles" Target="styles.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/settings" Target="settings.xml"/></Relationships>')


def main():
    layout, out = sys.argv[1], sys.argv[2]
    pages = read_pages(layout)
    notes = collect_footnotes(pages)
    if not notes:
        sys.exit('No footnotes found; the size bands at the top of this script have gone stale.')

    expected = list(range(1, max(notes) + 1))
    if sorted(notes) != expected:
        sys.exit(f'Footnote numbers are not a gapless 1..{max(notes)}; refusing to write.')
    empty = [n for n in notes if not notes[n].strip()]
    if empty:
        sys.exit(f'Footnotes with no text: {empty[:20]}')

    paras, anchored = build_body(pages, max(notes))

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', ROOT_RELS)
        z.writestr('word/document.xml', document_xml(paras))
        z.writestr('word/_rels/document.xml.rels', DOC_RELS)
        z.writestr('word/footnotes.xml', footnotes_xml(notes))
        z.writestr('word/styles.xml', STYLES)
        z.writestr('word/settings.xml', SETTINGS)

    print(f'Wrote {out}')
    print(f'  pages      : {len(pages)}')
    print(f'  paragraphs : {len(paras)}')
    print(f'  footnotes  : {len(notes)} (1..{max(notes)})')
    print(f'  referenced : {anchored}')
    if anchored != max(notes):
        print(f'  WARNING: {max(notes) - anchored} footnotes carry no in-body reference')


if __name__ == '__main__':
    main()
