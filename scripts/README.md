# The corpus harness

    npm run corpus                 read the corpus, report recall
    npm run corpus -- --verify     also ask CELLAR what each derived identifier really is
    npm run corpus -- --offline    use only what is already cached

Runs citation detection over real documents and reports what it gets wrong. It is not part
of `npm test`: it needs the network and it takes minutes.

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

## Adding documents

Edit `corpus.manifest.json`. Two kinds:

- `cellar` — a CELEX fetched from CELLAR and cached under `.corpus-cache/`. Advocate General
  opinions are the cheapest bulk: footnote-dense, every convention the Court uses, free.
- `docx` — a local Word file. This is where the *footnotes* stop being footnotes; nothing
  fetched from CELLAR will ever reproduce a note a PDF conversion left in the body text, so
  a corpus of CELLAR documents alone measures only half the problem.

Weight it toward what breaks: PDF-converted Commission decisions, French-language documents,
and pre-2012 documents that cite by European Court Reports volume rather than by ECLI.
