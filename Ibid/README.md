# Ibid.

Ibid is a TypeScript Word add-in for reviewing EU-law citations in footnotes. It identifies CJEU/CURIA, EUR-Lex, and Commission references and presents the relevant official record in the task pane. It assists source inspection and does not assess legal correctness.

The name is styled **Ibid.** with the terminal period on branded surfaces — the add-in display name, the task-pane header, and page titles. Running prose and identifiers use bare `Ibid`, `@ibid/*`, and `IBID_*`.

## Workspace packages

- `addin/` Office.js task pane app
- `api/` optional backend for source normalization and retries
- `shared/` common types and utilities
- `docs/` product notes and implementation decisions

## Current state

The add-in reads Word footnotes, recognises common EU citations, normalises reliable references to CELEX, and retrieves a bounded EUR-Lex passage when available. CURIA and Commission citations use direct official-record adapters. See [docs/STATUS.md](docs/STATUS.md) for current coverage and deployment constraints.

## Development

Run `npm run dev` and sideload `addin/manifest.xml` in Word. The sample document in `samples/ibid-demo-docx/` provides citations for a quick manual check.

The API defaults to port 4000. If it is already in use, start both the API and Vite proxy on another port with `IBID_API_PORT=4001 npm run dev`.

For implementation state, known blockers, and a concrete continuation checklist, see [docs/HANDOFF.md](docs/HANDOFF.md).
