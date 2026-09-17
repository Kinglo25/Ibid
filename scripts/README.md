# The corpus harness

    npm run corpus                 read the corpus, check every derived identifier
    npm run corpus -- --offline    use only what is already cached
    npm run corpus -- --no-verify  recall only, and no network beyond harvest

Runs citation detection over real documents and reports what it gets wrong. It is not part
of `npm test`: it needs the network and it takes minutes.

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

# The answer keys

    npm run answer-key                     check every key whose document is present
    npm run answer-key -- --write-known    rewrite the known-gap lists from this run

`corpus` checks that an identifier names the right document. It cannot see a citation that
reaches the right document and opens it at the wrong place: a paragraph taken from the case
cited next to it, an annex's paragraph shown as the decision's recital, `Ibid.` read against
the wrong note. None of those produces a wrong identifier, and all of them were in the
Commission's 2026 draft merger guidelines while every test passed.

An answer key is a document read by hand, once, and kept. `answer-keys/` holds, per document:

- `<name>.jsonl` — every citation in every footnote: the authority meant, the pinpoint as
  written, whether it was cited in full, by a short form or by `ibid.`, and any drafting
  error the text itself proves (a date contradicting its ECLI, a case number of another
  case). Built from the published PDF **without looking at Ibid's output**, and locked by
  hash before Ibid was run; any later change is recorded in the header's `amended` list with
  its reason and the hash before it.
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

A key written by one reader is one reading. Where a figure from it is going to be quoted, have
a second marker check a sample of it blind, as `docs/ACCURACY.md` describes.
