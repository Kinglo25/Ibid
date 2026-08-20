# Sample documents

Manual Word checks. Sideload `addin/manifest.xml`, open a document, and use Refresh.

| File | What it is for |
| --- | --- |
| `EU_Data_Retention_Memo.docx` | All full citations, in French. Exercises detection, not resolution |
| `eu-case-law-citation-test.docx` | The 20 collected citation patterns. Its footnotes are pinned as a fixture in `shared/test/resolve-citations.test.ts` |
| `back-reference-test.docx` | `Ibid.`, `Id.`, `supra note n`, and the refusals around them |
| `Commission_decision_X_DSA.docx` | Real published material at full length: 645 footnotes, 266 citations |

The first three are constructed: every identity in them is fictional, every authority
public, so they can be used anywhere a client document could not. The fourth is different
in kind — a real Commission decision, named parties and all, reproduced from the published
text. It is public, but it is not anonymous, so it is the one to leave out of a screen
share with an unrelated client.

## Commission_decision_X_DSA.docx

The Commission's DSA decision in cases DSA.100101–3, X (formerly Twitter), C(2025) 8630
final of 5 December 2025. 181 pages, 645 footnotes. It exists here because the constructed
samples are all short and tidy, and this is neither: it is what the add-in actually meets.

**Built by `build-commission-decision.py` from `Commission_decision_X_DSA.pdf` — edit the
script, not the .docx.**

The Commission publishes this decision as a PDF, and that is how a client sends it. Getting
it into Word is therefore the reviewer's own problem, and it is where the footnotes die.
A general-purpose PDF-to-Word conversion dropped all 645 of them into the body text,
leaving `word/footnotes.xml` holding nothing but its two separator placeholders; against
that file the task pane is simply empty, which looks exactly like a detection failure and
is not one. Word's own PDF import does better but not well: it produced 549 footnotes
rather than 645, merged the last note on many pages into the first note of the next, and
renumbered from there, so the numbers on screen stop matching the decision's own.

This matters beyond one sample. **A PDF is the normal starting point for this kind of
document**, so the quality of whatever made the .docx decides whether Ibid sees anything at
all — and a reviewer has no way to tell a bad conversion from a document with no citations
in it. The PDF keeps the distinction those conversions lose, in four font sizes, and the
script rebuilds real footnotes from it.

Two independent extractions agree on the footnote texts — one from the PDF by font size,
one from the broken .docx by run order — at better than 0.97 similarity on every footnote
that can be compared. That agreement is the check that this file is faithful to the source.

What it currently produces:

| | |
| --- | --- |
| Footnotes | 645, all referenced from the body |
| Footnotes carrying a citation | 241 |
| Citations detected | 266 — 223 CURIA, 34 EUR-Lex, 9 Commission |
| Resolved to CELEX | 93 |
| Unresolved | 173, all one false positive (below) |

### The known false positive

All 173 unresolved citations come from a single pattern, and 171 of them from a single
phrase. A capitalised document name followed by a pinpoint — `Reply to the Preliminary
Findings, paragraph 47.` — is read as a short-form case name and reported as an unconfirmed
short-form citation. In isolation `detectCitations` correctly finds nothing there; it is
the cross-footnote short-form pass that claims it, since the shape is the same one that
makes `Google Spain, paragraph 80` resolvable.

Ibid refuses to resolve these rather than inventing an authority, which is the important
half. But a Commission decision refers to its own case file constantly, so the effect on a
document like this one is around 150 non-citations offered to the reviewer. The three
constructed samples cannot surface this: none of them cites a document by name.

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
