# Sample documents

Manual Word checks. Sideload `addin/manifest.xml`, open a document, and use Refresh.

| File | What it is for |
| --- | --- |
| `EU_Data_Retention_Memo.docx` | All full citations, in French. Exercises detection, not resolution |
| `eu-case-law-citation-test.docx` | The 20 collected citation patterns. Its footnotes are pinned as a fixture in `shared/test/resolve-citations.test.ts` |
| `back-reference-test.docx` | `Ibid.`, `Id.`, `supra note n`, and the refusals around them |
| `EC Decision - Intel (2009).docx` | A real decision: 506 pages, 1,991 footnotes. Exercises scale, and the sources EUR-Lex does not hold in full |
| `Merger Guidelines - final for public consultation.docx` | A 2026 Commission draft, 98 pages. Converted cleanly: 433 of its 478 footnotes are still footnotes |
| `Guidelines_on_exclusionary_abuses_of_dominance_102TFEU.docx` | The same conversion gone the other way: 494 footnotes, none of them footnotes. Exercises the reader that finds them anyway |

The first three are constructed: every identity in them is fictional, every authority
public, so they can be used anywhere a client document could not. The Intel decision is not
constructed — it is the Commission's own published decision in COMP/C-3/37.990, a public
document naming real parties because the Commission published it that way. The two sets of
guidelines are Commission drafts, public and naming no private party, and are kept out of
the repository for their size rather than for what is in them.

## The two guidelines, and why both are here

They are the same conversion — Word, opening the Commission's published PDF — reaching
opposite results, and the pair is the point.

Word's converter pairs a superscript reference mark in the text with the block at the foot
of the page carrying the same number. The merger guidelines mark their footnotes with a bare
superscript `27` and label them `27` below, the two match, and 433 real Word footnotes come
back. The guidelines on exclusionary abuses write both as `(90)`, the parentheses defeat the
matcher, and **nothing** is paired: all 494 footnotes arrive as ordinary body paragraphs, and
the reference marks stay behind in the text as literal `(90)`.

What is left to tell a note from the document's own text is the numbering Word draws and the
size it is set in, and neither settles it alone — the two documents disagree about which
numbering shape means which. See `notesFromDocx` in `scripts/corpus-sources.mjs` and
`notesInBody` in `addin/src/ui/App.tsx`, which have to agree with each other.

## back-reference-test.docx

22 footnotes, each one a case the resolver has to get right or visibly refuse. Built by
`build-back-reference-test.py` — edit that, not the .docx. Its footnote texts are pinned in
`shared/test/resolve-citations.test.ts`, so CI fails if behaviour drifts from this table.

Every identifier is one already verified against the live EUR-Lex/CELLAR record for the
preview memo; nothing new is introduced here.

**The three worth checking first**, because they are the ones only Word can break:

- **Footnote 10** proves footnote numbering survives the empty footnote at 9. If it
  resolves to Google Spain instead of Digital Rights Ireland, numbering has shifted and
  nothing else on this page can be trusted.
- **Footnote 19** must resolve to the Advocate General's *opinion* (`62014CC0413`), not to
  the judgment in the same case (`62014CJ0413`).
- **Footnote 5** is a bare `Ibid.` and must show paragraph 97, inherited from footnote 4.

| # | Footnote | Expected |
| --- | --- | --- |
| 1 | GDPR cited in full, defining "GDPR" | Resolved, `32016R0679`, Article 17 |
| 2 | `GDPR, Article 17(1).` | Resolved — "the short form this document defines for it" |
| 3 | Google Spain in full | Resolved, `62012CJ0131`, paras 80–82 |
| 4 | `Ibid., para. 97.` | Resolved → footnote 3, para 97 |
| 5 | `Ibid.` | Resolved → footnote 4, **inherits para 97** |
| 6 | `Id., para. 99.` | Resolved → footnote 5, para 99 — the chain holds three deep |
| 7 | Digital Rights Ireland in full | Resolved, `62012CJ0293`, paras 57–65 |
| 8 | `Supra note 3, para. 80.` | Resolved → footnote 3 (Google Spain), para 80 |
| 9 | *(empty footnote)* | Not listed in the pane, but still counted |
| 10 | `Supra note 7, paras 62 and 65.` | Resolved → footnote 7 (**Digital Rights Ireland**), paras 62 and 65 |
| 11 | `Ibid.` | Resolved → footnote 10, inherits paras 62 and 65 |
| 12 | Schrems I **and** Schrems II, split by `;` | Two citations, each keeping its own pinpoint (94, 168) |
| 13 | `Ibid., para. 94.` | **Unconfirmed** — footnote 12 cites two authorities. Offers both, C‑311/18 first |
| 14 | Tele2 Sverige, in French | Resolved, `62015CJ0203`, point 112 |
| 15 | `Ibidem, point 119.` | Resolved → footnote 14. The French spelling is recognised |
| 16 | `See paragraph 12 above.` | **No citation at all.** A cross-reference to the document's own text |
| 17 | Intel judgment in full | Resolved, `62014CJ0413`, paras 138–139 |
| 18 | AG Wahl's opinion in Intel | Resolved as an **opinion**, `62014CC0413` |
| 19 | `Ibid., point 74.` | Resolved → footnote 18, i.e. **the opinion**, point 74 |
| 20 | `Supra note 25, para. 5.` | **Unresolved.** There is no footnote 25 |
| 21 | `Post Danmark, para. 44.` | **Unresolved.** Never cited in full in this document |
| 22 | `Ibid., para. 45.` | **Unresolved.** It must not inherit footnote 21's guess |

### Correct behaviour that looks like a bug

- **13, 20, 21 and 22 are meant to be unresolved.** Refusing to guess is the behaviour under
  test, not a failure. 13 offers candidates; 21 and 22 offer the authorities the document
  establishes elsewhere.
- **Confirming footnote 13 also settles nothing else** — each `Ibid.` is confirmed where it
  stands, because the next one means whatever precedes *it*.
- **An `Ibid.` immediately after an empty footnote would be reported unresolved**, since the
  empty footnote establishes nothing. Not exercised here; footnote 10 uses `supra note n`
  across the gap instead, which is the case that matters for numbering.

## EC Decision - Intel (2009).docx

The published Commission decision of 13 May 2009 in COMP/C-3/37.990 — Intel, as .docx.
Nothing about it is constructed, which is the point: it is the length, footnote density and
citation habits of the documents this tool is actually for.

### The three conventions this document found

EUR-Lex does not hold case law in one markup convention, it holds it in several, and which
one a judgment arrives in follows the era it was decided in rather than anything a citation
can state. The Intel decision cites 28 documents by paragraph, 102 pinpoints in all,
spanning 1976 to 2008 — enough that three conventions the resolver had never met turned up
in one document. Each one showed the reviewer the judgment's headnote under a heading naming
the paragraph they had asked for:

| Rendition | Markup | Found in |
| --- | --- | --- |
| ECR era | `<P class="C01PointnumeroteAltN">66&nbsp;&nbsp;It is also clear…` | Groupe Danone (T-38/02), TACA (T-191/98), Michelin II (T-203/01), British Airways (C-95/04 P) |
| Parties/Grounds | `<p>104. In that context…` | France Télécom (C-202/07 P) |
| Oldest, all capitals | `<p>38ARTICLE 86 IS AN APPLICATION…` | Hoffmann-La Roche (C-85/76), United Brands (C-27/76) |

Of the 102 pinpoints, 46 resolved before those three were added and 98 do now. **Footnotes 49
and 50** — TACA at paragraphs 349-359 and Groupe Danone at paragraph 66 — are the ones to
check for the first of them; **footnote 1148** (Hoffmann-La Roche paragraph 89) for the last.

Of the four that still do not, three are footnote 91 below, and the fourth is not a defect:
**footnote 1109** reads "Case 86/76 Hoffmann-La Roche, paragraph 71", and Hoffmann-La Roche
is Case 85/76. Case 86/76 is Gervais-Danone v Hauptzollamt München-Mitte, a customs-tariff
reference whose grounds run to paragraph 11. The pane shows
both what the number names and what the name names, which is the right answer to a citation
whose two halves disagree.

**Footnote 91 is the one to check.** It cites `Case T-457/08 R Intel v Commission,
paragraph 87` — an order of the President in interim measures. Paragraph 87 exists; the
2014 judgment in T-286/09 restates it at its own paragraph 332. But the Reports carried only
a *summary* of that order — catchwords, subject-matter and operative part — and the summary
is the whole of what EUR-Lex holds under CELEX 62008TO0457, in every language, at about
3 KB. The full text is on CURIA and nowhere in CELLAR.

So the pane must not say the paragraph "could not be located": that sends the reviewer
looking for a fault in the tool, and the first reviewer who read it went to a chatbot
instead, which told them EUR-Lex was malfunctioning and then invented the paragraph's
wording twice. What it says instead is that only the summary was published, and it links to
CURIA. See `a document EUR-Lex holds only in summary` in `api/test/resolver.test.ts`.
