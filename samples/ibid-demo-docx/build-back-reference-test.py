#!/usr/bin/env python3
"""Builds `back-reference-test.docx`, the manual Word check for back-references.

A .docx is a zip of OOXML parts, and real footnotes are the point of this fixture — the
add-in reads `body.footnotes` through Office.js, so a document whose "footnotes" are
ordinary paragraphs would exercise nothing. python-docx cannot write footnotes, hence the
parts below are assembled by hand.

Not part of any build. Run it only to regenerate or extend the document:

    python3 samples/ibid-demo-docx/build-back-reference-test.py

Every case number, ECLI and CELEX here is one already verified against the live
EUR-Lex/CELLAR record for the preview memo in `shared/src/index.ts`; nothing new is
introduced, so the verification rule recorded in `real-citations.test.ts` still holds.
Expected results for each footnote are in README.md next to this script — keep the two in
step when changing anything.
"""

import pathlib
import zipfile
from xml.sax.saxutils import escape

# (footnote text, the body sentence its marker is attached to)
FOOTNOTES = [
    ("Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 (the “GDPR”), Article 17.",
     "The right to erasure is established by the General Data Protection Regulation."),
    ("GDPR, Article 17(1).", "Its first paragraph sets out the grounds on which erasure may be sought."),
    ("Judgment of 13 May 2014, Google Spain SL and Google Inc. v AEPD and Costeja González, Case C-131/12, ECLI:EU:C:2014:317, paras 80–82.",
     "The Court first recognised the right in the search-engine context."),
    ("Ibid., para. 97.", "It held that the operator is responsible for the processing it carries out."),
    ("Ibid.", "That responsibility does not depend on the publisher's own obligations."),
    ("Id., para. 99.", "The data subject may therefore address the operator directly."),
    ("Judgment of 8 April 2014, Digital Rights Ireland and Seitlinger and Others, Joined Cases C-293/12 and C-594/12, ECLI:EU:C:2014:238, paras 57–65.",
     "General retention of traffic data was held disproportionate."),
    ("Supra note 3, para. 80.", "The search-engine reasoning is consistent with that approach."),
    ("", "This proposition is uncontroversial."),
    ("Supra note 7, paras 62 and 65.", "The retention analysis turned on the absence of any limitation."),
    ("Ibid.", "No distinction was drawn by reference to the seriousness of the offence."),
    ("Judgment of 6 October 2015, Schrems v Data Protection Commissioner, Case C-362/14, ECLI:EU:C:2015:650, para. 94; and Judgment of 16 July 2020, Data Protection Commissioner v Facebook Ireland and Schrems, Case C-311/18, ECLI:EU:C:2020:559, para. 168.",
     "Transfers to third countries have twice been before the Court."),
    ("Ibid., para. 94.", "The essence of the right to private life was the governing consideration."),
    ("CJUE, 21 décembre 2016, Tele2 Sverige AB et Watson e.a., affaires jointes C-203/15 et C-698/15, ECLI:EU:C:2016:970, point 112.",
     "La Cour a précisé la portée de cette jurisprudence."),
    ("Ibidem, point 119.", "L'accès aux données doit être soumis à un contrôle préalable."),
    ("See paragraph 12 above.", "The same reasoning applies to the present facts."),
    ("Judgment of 6 September 2017, Intel Corp. v Commission, Case C-413/14 P, ECLI:EU:C:2017:632, paras 138–139.",
     "In competition law the Court revisited the as-efficient-competitor test."),
    ("Opinion of Advocate General Wahl of 20 October 2016 in Intel, ECLI:EU:C:2016:788, §§ 73-75.",
     "The Advocate General had proposed a fuller effects analysis."),
    ("Ibid., point 74.", "He treated the loyalty-rebate presumption as rebuttable."),
    ("Supra note 25, para. 5.", "A reference of this kind points nowhere in this document."),
    ("Post Danmark, para. 44.", "A case this memo never cites in full is named here in short form."),
    ("Ibid., para. 45.", "And a reference back to it inherits nothing."),
]

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def paragraph(text, footnote_id=None, style=None):
    parts = [f'<w:p>']
    if style:
        parts.append(f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>')
    if text:
        parts.append(f'<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r>')
    if footnote_id is not None:
        parts.append(
            '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>'
            f'<w:footnoteReference w:id="{footnote_id}"/></w:r>')
    parts.append('</w:p>')
    return ''.join(parts)


def build():
    body = [paragraph('Ibid. — back-reference test document', style='Heading1'),
            paragraph('Each sentence below carries one footnote. The footnotes are the test; '
                      'the sentences exist only to hang them on. Expected results per footnote '
                      'are in README.md beside this file.')]
    for index, (_, sentence) in enumerate(FOOTNOTES, start=1):
        body.append(paragraph(sentence, footnote_id=index))
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<w:document {W}><w:body>{"".join(body)}'
                f'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')

    # Word expects the separator pair before any real footnote; ids 1..n are ours.
    notes = ['<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
             '<w:footnote w:type="continuationSeparator" w:id="0">'
             '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>']
    for index, (text, _) in enumerate(FOOTNOTES, start=1):
        inner = (f'<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>'
                 f'<w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> {escape(text)}</w:t></w:r>'
                 if text else '')
        notes.append(f'<w:footnote w:id="{index}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'
                     f'{inner}</w:p></w:footnote>')
    footnotes = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                 f'<w:footnotes {W}>{"".join(notes)}</w:footnotes>')

    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles {W}>'
              '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
              '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
              '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/>'
              '<w:rPr><w:sz w:val="18"/></w:rPr></w:style>'
              '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>'
              '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>')

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.footnotes+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.styles+xml"/></Types>')

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        '/officeDocument" Target="word/document.xml"/></Relationships>')

    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        '/footnotes" Target="footnotes.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        '/styles" Target="styles.xml"/></Relationships>')

    target = pathlib.Path(__file__).with_name('back-reference-test.docx')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('_rels/.rels', root_rels)
        archive.writestr('word/document.xml', document)
        archive.writestr('word/_rels/document.xml.rels', doc_rels)
        archive.writestr('word/footnotes.xml', footnotes)
        archive.writestr('word/styles.xml', styles)
    print(f'wrote {target} ({target.stat().st_size} bytes, {len(FOOTNOTES)} footnotes)')


if __name__ == '__main__':
    build()
