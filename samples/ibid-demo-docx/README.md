# Sample documents

Manual Word checks. Sideload `addin/manifest.xml`, open a document, and use Refresh.

| File | What it is for |
| --- | --- |
| `EU_Data_Retention_Memo.docx` | All full citations, in French. Exercises detection, not resolution |
| `eu-case-law-citation-test.docx` | The 20 collected citation patterns. Its footnotes are pinned as a fixture in `shared/test/resolve-citations.test.ts` |
| `back-reference-test.docx` | `Ibid.`, `Id.`, `supra note n`, and the refusals around them |

All three are constructed: every identity in them is fictional, every authority public, so
they can be used anywhere a client document could not.

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
