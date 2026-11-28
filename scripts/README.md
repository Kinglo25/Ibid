# The corpus harness

    npm run corpus                 read the corpus, check every derived identifier
    npm run corpus -- --offline    use only what is already cached
    npm run corpus -- --no-verify  recall only, and no network beyond harvest

Runs citation detection over real documents and reports what it gets wrong. It is not part
of `npm test`: it needs the network and it takes minutes.

It reads each document as the pane reads one: the notes, and then the citations written into
the running text in parentheses — which is where the Court makes every citation in a
judgment, "(see judgment of 6 September 2017, Intel v Commission, C‑413/14 P, EU:C:2017:632,
paragraph 138)". Reading notes alone, each judgment in the corpus reported "1 notes, 0
citations", and the form the Court cites in most was never checked against CELLAR.

**It exits non-zero**, so it is a check and not a readout. Three ways to fail: a wrong source
was found; it was asked to check identifiers and checked none; or every document was skipped.
Two of those are failures to have measured anything, which is the reason they are failures —
see below.

## Why it exists

Every defect of consequence this project has found came from a real document rather than
from a case someone thought to write. Hand-written tests pin a fix in place; they do not
find the next one, because they are written by the same understanding that produced the bug.

Its first proper run, over 1502 notes and 655 citations, found three:

1. An ECLI reaching back past the previous citation's ECLI for a case number, so a 1982
   judgment was derived under a 2013 case.
2. `my Opinion in …` — how an Advocate General cites their own — unrecognised, so an opinion
   derived the CELEX of the judgment it was distinguishing itself from.
3. Document type decided by a fixed order of preference rather than by the words nearest the
   citation, so in a footnote citing both a judgment and the opinion in the same case, the
   second citation's wording relabelled the first.

Each is now a test in `shared/test/detect-citations.test.ts`.

## Why two of the three failures are about measuring nothing

A run reported 561 citations, 0 wrong sources, and `"checked": 0` in the same breath, and
the zero in the column that must be zero was zero because nothing had been asked. Verifying
is now the default rather than a flag, and a run that checks nothing fails.

The same shape, twice more. A document CELLAR served in its pre-Formex rendition had no
`<p class="note">` in it, so the harness read no notes, found no missed citations in the
notes it did not read, and reported the document clean — six Commission decisions and 1447
footnotes, scoring full marks on an empty set. A document that yields no notes is now a skip
with a reason on it. And the loose net below could not see `Case 172/80`, the only way a
decision of that era writes a citation, so it reported no misses across documents that cite
almost entirely in that form.

None of the three was a wrong answer. All three were the harness agreeing with itself and
saying so in the voice it uses for a real result.

## The three outcomes

`missed` is a citation in the text that detection did not report. `unavailable` is a
citation resolved correctly whose source CELLAR does not hold. **`wrong-source` is a
citation resolved to an identifier belonging to a different document, and it is the only one
that must be zero** — a missed citation is visibly missing and an unavailable one says so,
but a wrong one is presented to a reviewer with every appearance of being right. That is the
only failure here that can put a false authority into a legal document.

There is deliberately no overall score. "Every citation resolved" is not the goal and is not
reachable: the decision this was built against cites a case number that does not exist, and
no algorithm should resolve it.

What `wrong-source` actually compares is the identifier **derived from the case number**, and
where a citation quotes an ECLI that is not what the reviewer is served: retrieval asks CELLAR
by the ECLI first, because an ECLI is the name the issuing court gave the document while a CELEX
built out of a case number is an inference. So a hit here is a disagreement, and which side of
it is wrong has to be established by hand, once, against the footnote and against the live
document. All three in the corpus today are the document's: an ECLI with two digits transposed,
a case decided twice under one number, and an appeal cited without its `RENV` suffix.

Each is written down in `corpus-known.json` with what the check found, and the column keeps
doing its job: a disagreement that is not in that list fails the run, and one in the list that
stops happening fails it too, so a fix is locked in rather than left to regress. Accepting one
without reading the document it came from would be the one move that empties this column of
meaning.

## How it checks itself without hand-labelling

Recall is measured against a deliberately looser net than detection — anything ECLI-shaped
or case-number-shaped — so its hits are candidates for review rather than defects. It has to
be looser, or it would only ever agree with the thing it is checking.

Correctness needs no labelling at all: **CELLAR declares each document's ECLI in its RDF
metadata** (`owl:sameAs`). Derive the identifier from the citation, ask CELLAR what that
identifier is, and compare. The judgment *text* does not contain its own ECLI, so this has
to go through RDF — an earlier attempt to check against the document body reported every
citation as a mismatch and told us nothing.

## Asking Word

    npm run word-check                        every sample
    npm run word-check -- path/to/file.docx   one document

The corpus reads a .docx by unzipping it and parsing the XML, which is right for a harness
that has to run anywhere — and means the reader had never been checked against the program
that actually opens these files. This drives real Word through `powershell.exe` (so WSL, or
Windows) and reports every footnote the two disagree about. It found one on its first run: a
footnote written as two paragraphs was joined straight through, so `3rd` and the sentence
after it came out as `rdIntel submission` where Word reads `rd Intel submission` — detection
running on text no reviewer would ever see.

What it does not do is test the pane. Word's `Range.Text` and Office.js's `body.text` are
different strings — the reference mark that broke every back-reference in a real document
appears in one and not the other — so this settles whether the corpus reads the same
footnotes out of a file that Word does, and nothing wider.

The pane's own side of this is `addin/test/real-documents.test.tsx`, which drives the task
pane with footnotes pulled from real .docx files rather than with fixtures typed by hand.

## Adding documents

Edit `corpus.manifest.json`. Two kinds:

- `cellar` — a CELEX fetched from CELLAR and cached under `.corpus-cache/`. Advocate General
  opinions are the cheapest bulk: footnote-dense, every convention the Court uses, free.
- `docx` — a local Word file. This is where the *footnotes* stop being footnotes; nothing
  fetched from CELLAR will ever reproduce a note a PDF conversion left in the body text, so
  a corpus of CELLAR documents alone measures only half the problem. A `docx` entry naming a
  file that is not present is skipped, which is what keeps decisions that name real parties
  out of the repository without taking them out of the corpus for whoever holds them.

CELLAR serves three renditions and the harness reads all three: Formex XHTML and the
CURIA-native rendering, both of which mark notes with a class, and the pre-Formex rendition,
which does not mark them at all. In that last one the document is bare `<p>` throughout and a
footnote is written exactly like a numbered recital; what separates them is that each series
counts from one, so the footnotes are the document's last ascending run. Ten is the fewest
that run is believed at, because a judgment's operative part restarts the numbering too.

Note that only the older decisions carry their full text. Antitrust decisions from about 2006
publish a summary in the Official Journal and keep the real document on the Commission's own
site, so a recent CELEX generally fetches a few pages of recitals with no apparatus at all —
worth nothing here, and reported as a skip rather than as a clean document.

Weight it toward what breaks: PDF-converted Commission decisions, French-language documents,
and pre-2012 documents that cite by European Court Reports volume rather than by ECLI.

# Fetching the documents

    npm run samples                 fetch what is missing, convert what is not yet converted
    npm run samples -- --offline    convert only what is already downloaded
    npm run samples -- <id> …       only these documents

The documents in `samples/` were all drafted by the Commission, and a Commission drafter cites
the way the Commission cites. The people Ibid is for write submissions, and the published
replies to the Commission's consultations are the largest public body of those there is — law
firms, bar associations, in-house lawyers, academics, in English, in French, in German, and in
two languages at once. `samples.manifest.json` names each document by where it is published and
this fetches it; the conversion is Word's own, `Documents.Open` on the PDF then `SaveAs2`, which
is what a reviewer handed a PDF does, so what it damages is damage a reviewer meets. It needs
Word on Windows through `powershell.exe`; without it the PDFs are still fetched and nothing is
converted.

Everything lands in `.samples-cache/`, which is not in the repository: the documents are public
but they name their authors, and together they are the size of a small archive. Each PDF's
SHA-256 is in the manifest, and a download that does not match is reported rather than used —
an answer key describes one version of a document and not whatever is published under its URL
later. Three consultations are listed so far: the 2024 Article 102 guidelines, the 2025 merger
guidelines review, and the 2025 draft revised Technology Transfer Block Exemption Regulation,
the last for a body of law the corpus had none of.

A document converted this way goes into `corpus.manifest.json` as a `docx` entry pointing into
`.samples-cache/docx/`. Writing an answer key for one is the other half, and the more expensive:
see below.

# The answer keys

    npm run answer-key                     check every key whose document is present
    npm run answer-key -- --write-known    rewrite the known-gap lists from this run

`corpus` checks that an identifier names the right document. It cannot see a citation that
reaches the right document and opens it at the wrong place: a paragraph taken from the case
cited next to it, an annex's paragraph shown as the decision's recital, `Ibid.` read against
the wrong note. None of those produces a wrong identifier, and all of them were in the
Commission's 2026 draft merger guidelines while every test passed.

An answer key is one reading of a document, every citation in it, written once and kept.
`answer-keys/` holds, per document:

- `<name>.jsonl` — every citation in every footnote: the authority meant, the pinpoint as
  written, whether it was cited in full, by a short form or by `ibid.`, and any drafting
  error the text itself proves (a date contradicting its ECLI, a case number of another
  case). Meant to be built from the published PDF **without looking at Ibid's output**, and
  locked by hash before Ibid is run, with any later change recorded in the header's `amended`
  list with its reason and the hash before it. How far the six keys here meet that is under
  "Who wrote the keys" below.
- `<name>.notes.json` — the text of each footnote the key was built from, so any entry can be
  checked against its note, and so the pane's notes can be lined up with the PDF's.
- `<name>.known.json` — the gaps accepted for now, each with a reason.

The check reads the .docx the way the pane does — Word's footnotes, the notes a conversion
left in the body, the parenthesised spans of the running text — runs detection and
back-reference resolution, lines the pane's notes up with the PDF's by their text, and sorts
every citation into `wrong-document`, `wrong-pinpoint`, `pinpoint-missing`, `unresolved`,
`missed` or `lost`, plus `unexpected` for what Ibid reports that the key does not hold, and
`merged`/`not-a-footnote` for notes the conversion damaged.

**It exits non-zero on:** a `wrong-document` or `wrong-pinpoint` — must be zero, except where
the Word document itself reads that way, which an accepted entry must quote in `reads` and the
check confirms against the note; any outcome not in the known list; any known entry that no
longer happens, so a fix is locked in rather than left to regress; a known entry whose reason
is still `TODO`; and a run that checked nothing.

It stops at detection. Whether retrieval then shows the passage is not checked here: that
needs the network, and is the next thing to build.

## Writing a key

Read the PDF, not the .docx: the conversion is part of what is being tested, and a key built
from it inherits its damage. Write the key before running Ibid, and record its hash. What
counts as an authority follows `docs/ACCURACY.md`. Mark a mention that is neither to be
required nor held against Ibid — an act named inside another act's title, an article inside a
quotation — `"role": "incidental"`, and decide that before seeing the output too.

An entry belongs to a numbered footnote, written `"n": 14`, or to the running text, written
`"n": "body"` with the opening of its parenthesis quoted in `at`. A document may have no
footnotes at all — Vogel & Vogel's reply is six pages of French with every citation in a
parenthesis — and a key with nothing but numbered entries would then report every one of them
lost and everything the pane read as unexpected, which is a document scoring zero while Ibid
reads it correctly. The `at` quotes are matched against the spans the pane read by their words,
and in the key's order, which is the document's: a document repeats the same parenthesis, and
the words alone cannot say which occurrence an entry meant.

A key written by one reader is one reading. Where a figure from it is going to be quoted, have
a second marker check a sample of it blind, as `docs/ACCURACY.md` describes.

## Who wrote the keys

All six keys were written by Claude, the same model that wrote most of Ibid's detection code,
and no person has checked any of them yet. None has had the blind second check above, so no
figure from them should be quoted outside the project.

That limits what they can show. A key is meant to be the independent reading, and
`docs/ACCURACY.md` says a ground truth means a person reading footnotes. A reading by the same
model can share a blind spot with the code it checks: a citation misread the same way in both
passes. That each key was written without looking at Ibid's output is Claude's own account, and
nothing in the repository proves it. Only the merger-guidelines key records a hash, in its
`amended` list; the five consultation keys record none, and the date in their headers,
2026-09-17, is two months before they first appear in the repository on 24 November 2026.

What Claude did not write is the documents. Each `<name>.notes.json` holds the footnote text as
`pdftotext` or `pdftohtml` extracted it from the Commission's published PDF. On 28 November 2026
every footnote in all six files, and every parenthesis the Vogel & Vogel key quotes from the
running text, was compared with a fresh download of the published PDF and found to be that
text, differing only by extraction artifacts (a page number run into a note, a subscript read
as a digit). So what a person needs to check is the key itself: which authority each citation
means, which earlier note an `Ibid.` points to, which case number a typo stands for, and what
counts as incidental. The footnotes are the real ones.

## What the keys say so far

Six documents, 753 citations, read by Claude and not yet checked by a person (above). Reading
the known lists is most of what they have to
say, and the largest thing in them by far is one gap seen from two sides: a notice, a set of
guidelines or a communication is cited by where it was published and not by any number of its
own, an Official Journal reference is not read, and so the instrument is never reported and
every short form the document then uses for it has nothing to resolve against. In competition
practice the Commission's own notices are among the most-cited instruments there are. Detection
reads an Official Journal reference since 28 November 2026, but the known lists below were
written before that and have not been rewritten, because that needs the Word-converted
documents: the next run will report the notices it now finds as fixed (see `docs/HANDOFF.md`,
"The parked detection line").

After that it is mostly the conversion rather than Ibid: footnotes merged into the one before
them, footnotes reduced to their pinpoint with the authority lost out of the file altogether,
body paragraphs numbered as list items and read as notes. Those are not defects to fix in
detection — they are what a reviewer's own document will look like, which is the reason for
testing against converted documents at all.
