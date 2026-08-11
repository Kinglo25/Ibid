# Thomas

TypeScript monorepo scaffold for a Word add-in that detects and previews legal citations in footnotes.

## Workspace packages

- `addin/` Office.js task pane app
- `api/` optional backend for source normalization and retries
- `shared/` common types and utilities
- `docs/` product notes and implementation decisions

## Current state

The project now contains the workspace structure and base TypeScript configuration. The next step is to install dependencies and flesh out the add-in UI, citation scanner, and source resolvers.