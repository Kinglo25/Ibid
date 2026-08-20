# Ibid.

Ibid is a TypeScript Word add-in for reviewing EU-law citations in footnotes. It identifies CJEU/CURIA, EUR-Lex, and Commission references and presents the relevant official record in the task pane. It assists source inspection and does not assess legal correctness.

**Reviewing this for information security?** Start with [docs/DATA-FLOW.md](docs/DATA-FLOW.md). It states what leaves the workstation and what does not, records the weaknesses we would raise ourselves, and gives the command that checks each claim against this repository.

The name is styled **Ibid.** with the terminal period on branded surfaces — the add-in display name, the task-pane header, and page titles. Running prose and identifiers use bare `Ibid`, `@ibid/*`, and `IBID_*`.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/DATA-FLOW.md](docs/DATA-FLOW.md) | What crosses the wire and what stays on the machine, the points a reviewer should weigh, and a command to verify each claim. Written for an IT or information-security review. |
| [docs/HOSTING.md](docs/HOSTING.md) | Deploying the pane and API to a real HTTPS origin, generating the hosted manifest, and sideloading it into Word. |
| [docs/STATUS.md](docs/STATUS.md) | Current recognition and retrieval coverage, and the production hardening still outstanding. |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Implementation detail, the log of what has been verified live, and a continuation checklist. |

## Workspace packages

- `addin/` Office.js task pane app
- `api/` optional backend for source normalization and retries
- `shared/` common types and utilities
- `docs/` security, hosting, and implementation documentation
- `samples/` fictional Word documents for manual checks

## Current state

The add-in reads Word footnotes, recognises common EU citations, normalises reliable references to CELEX, and retrieves a bounded EUR-Lex passage when available. CURIA and Commission citations use direct official-record adapters. See [docs/STATUS.md](docs/STATUS.md) for current coverage and deployment constraints.

## Requirements

- **Node 22 or later** to build and run.
- **Word 2302+, Office 2024, Word on the web, or Word for Mac 16.70+.** Footnote enumeration requires WordApi 1.5, which the manifest declares — so Word refuses to activate rather than loading a pane that would find nothing. Volume-licensed Office 2019 and 2021 cannot run Ibid at all; confirm the target build before evaluating.

## Development

Run `npm run dev` and sideload `addin/manifest.xml` in Word.

Run `npm run verify` to lint, type-check the tests, run the full test suite, and build. It is the single command that establishes the tree is sound.

The three sample documents in [samples/ibid-demo-docx/](samples/ibid-demo-docx/) cover detection, the collected citation patterns, and back-references respectively; their own README says what each is for. Every identity in them is fictional and every authority is public, so they can be used anywhere a client document could not.

The API defaults to port 4000. If it is already in use, start both the API and Vite proxy on another port with `IBID_API_PORT=4001 npm run dev`.

For implementation state, known blockers, and a concrete continuation checklist, see [docs/HANDOFF.md](docs/HANDOFF.md).
