# Measuring accuracy on a real document

How to turn "it seems to work" into a number that survives being questioned.

## Why this exists

Counting what detection reports tells you nothing about what it missed. Running the Intel
decision through detection gave 133 resolved authorities; probing the footnotes it had
passed over suggested 14 misses, which reads as recall of about 90%. Writing one more probe
— for cases named without a number, `Michelin I, op. cit., paragraph 73` — found more. The
denominator moved because someone looked somewhere new, so it was never a measurement.

A recall figure needs a ground truth built without reference to what the tool reported. That
means a person reading footnotes. This is the procedure for doing that on a sample small
enough to be affordable and structured enough to be projected back to the document.

## The procedure

```
npm run accuracy:sample -- "samples/ibid-demo-docx/Some Decision.docx"
# ... mark .accuracy/Some-Decision-sample.csv by hand ...
npm run accuracy:score
```

The sample is seeded, so it is reproducible: re-running with the same seed and document
reproduces the same sheet. Record the seed alongside any figure you publish.

Output lands in `.accuracy/`, which is ignored by git. **The sheet contains the text of real
footnotes and is exactly as confidential as the document it came from.** Do not commit it,
and do not paste it into anything hosted.

## What counts as an authority

This is the only judgment call in the exercise, and consistency matters more than where the
line falls. Mark the same way for the whole sheet.

**An authority is a published source of law that exists outside this proceeding** and that a
reader could go and read:

- judgments, orders and Advocate General opinions of the CJEU and General Court
- Regulations, Directives, Decisions of general application, Treaty articles
- Commission notices, guidelines and communications published in the *Official Journal*
- national and third-country court decisions
- decisions of the Commission in *other* cases

**Not an authority**, however formally it is cited:

- anything in this proceeding's own file — submissions, replies, statements of objections,
  responses to requests for information, inspection documents, emails, hearing transcripts
- evidence — SEC filings, market research, internal presentations, press articles, expert
  reports commissioned by a party
- cross-references to this decision's own recitals, paragraphs, annexes or tables
- an authority named only in passing, without a pinpoint or a claim resting on it
  (`the Michelin line of cases` is prose; `Michelin I, paragraph 73` is a citation)

The distinction is whether there is an official source to retrieve. `Intel submission of
5 February 2009 related to the 17 July 2008 SSO, paragraph 294` is a real citation to a real
document, and it is not an authority: nobody outside the case can open it, and Ibid has
nothing to check it against. Silence on those is correct behaviour, not a miss.

Where a footnote cites the same authority twice, count it once. Where it cites two, count
two. Where you cannot tell, mark `notes` and move on — leave the numeric columns blank and
the scorer will exclude the row rather than guess.

## The columns

Four to fill in, per footnote. The sheet also carries `ibid_detected`, which is what
detection reported — read it *after* you have decided what the footnote contains, not
before, or the ground truth stops being independent.

| column | what to enter |
| --- | --- |
| `authorities` | how many distinct authorities this footnote cites, by the rule above |
| `found` | how many of those Ibid reported at all, resolved or not |
| `resolved_ok` | how many of those Ibid resolved to the **right** document |
| `false_positives` | how many of Ibid's reports are not authorities |
| `notes` | free text — anything you were unsure about, and why |

`found` counts detection; `resolved_ok` counts detection *and* correct identification. A
citation Ibid flagged as needing review counts in `found` but not in `resolved_ok` — it
found the citation and declined to say what it was, which is the intended behaviour when the
document does not establish an answer.

`resolved_ok` requires checking the identifier, not just that something appeared. A CELEX
naming a different document is the worst failure this tool has, and it is invisible unless
someone looks.

### Worked examples from the Intel decision

| footnote | marks | why |
| --- | --- | --- |
| `OJ L 1, 4.1.2003, p. 1.` | authorities 1, found 0 | Regulation 1/2003, cited by OJ location only. A miss. |
| `Intel submission of 5 February 2009 related to the 17 July 2008 SSO, paragraphs 294-296.` | authorities 0, false_positives 1 | Case file. Ibid reported `SSO`, which is not an authority. |
| `Case C-62/86 AKZO v Commission, op. cit., paragraph 70.` | authorities 1, found 1, resolved_ok 1 | Resolved off the case number. |
| `Michelin I, op. cit., paragraph 73.` | authorities 1, found 0 | `op. cit.` with no number is unhandled. |
| `Gartner data, Top 10 OEMs' Market Shares. Extracted on 27 May 2008.` | authorities 0 | Evidence. Correct silence. |
| `Idem.` (pointing at a footnote citing an Intel submission) | authorities 0 | The target is not an authority, so neither is the back-reference. |

## Two passes, and why

A single pass by one marker is one person's opinion, and a first pass produced by an LLM is
worse than that for the purpose it is usually wanted for: it is the vendor marking the
vendor's homework, and a client is right not to accept it. The procedure that does work:

```
npm run accuracy:sample -- <document>                                  # 240-row sheet
# first pass — fill in all 240
npm run accuracy:sample -- --blind 60 --from .accuracy/<name>-sample.csv
# second pass — a different marker fills in the 60, without seeing the first
npm run accuracy:score -- --against .accuracy/<name>-blind.csv
```

The blind sheet is drawn in the same stratum proportions as the full sheet and has the marks
and notes stripped out. `--against` reports per-column agreement, whole-row agreement, and
Cohen's kappa on "does this footnote cite an authority at all" — kappa rather than raw
agreement, because most footnotes here cite nothing and two markers who both say "no" to
everything agree about 90% of the time while having shown nothing.

It also prints every disagreement with its footnote text. Those are the rows worth arguing
about; settle them before quoting any figure.

What to report depends on how that comes out. High agreement means you publish the 240-row
result and cite the kappa as its provenance. Low agreement means the definition above was not
being applied the same way by both markers — fix that first, because the figure is measuring
the disagreement, not the tool. If it cannot be fixed, fall back to the second pass alone:
fewer rows, wider intervals, one marker, no asterisk.

## Reading the result

Three figures, and they answer different questions. Never average them into a score.

- **recall** — of the authorities in the text, what share Ibid reported
- **precision** — of what Ibid reported, what share are authorities at all
- **resolution accuracy** — of the authorities it reported, what share it tied to the right
  document

Each comes with a 95% interval. Quote the interval, not the point estimate. If the interval
is too wide to support the sentence you want to write, the scorer names the stratum paying
for the width and prints the command to mark more of it.

## What a figure from this does and does not say

It is one document. A Commission decision's footnotes are overwhelmingly its own case file;
a brief's are authorities; a judgment's are a third thing again. A recall figure measured
here describes this document and does not generalise on its own — say which document any
published number came from.

The `silent-cited` stratum is drawn to contain the hard cases, which is what makes the
sample efficient and also means that stratum is not evidence of anything on its own. Only
the weighted, document-wide figures the scorer prints are.
