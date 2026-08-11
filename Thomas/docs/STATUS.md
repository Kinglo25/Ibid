# Thomas add-in status

## Product direction
Thomas helps a user inspect original case-law source text so they can independently judge whether a citation supports a proposition. It does not issue correctness or improvement verdicts.

## Current state
- The TypeScript monorepo contains the Word add-in, optional API components, and shared citation utilities.
- The task pane reads the active document and its individual footnotes through Office.js (WordApi 1.5).
- Footnotes are presented as navigable review items, with detected citations grouped under their containing footnote.
- Selecting a citation shows nearby footnote context and a direct CourtListener opinion search.
- An optional cache-backed CourtListener resolver is available in `api/`; configuring `VITE_THOMAS_API_BASE_URL` enables source-result cards in the task pane.

## Next deployment steps
1. Host `createSourceResolver()` behind `GET /sources?citation=` and configure `VITE_THOMAS_API_BASE_URL` at add-in build time.
2. Sideload the manifest in supported Word clients and test representative documents, especially footnote-heavy briefs.
3. Extend citation recognition only for formats encountered in those tests.

## Notes
- The direct CourtListener link keeps the manual-review workflow usable even when the optional API is not deployed.
- The repository build completes with `npm run build`.
