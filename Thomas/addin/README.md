# addin

Word Office.js task pane add-in.

## Suggested layout

- `src/ui/` task pane components and preview panel
- `src/office/` Word document access and footnote extraction
- `src/citations/` detection, normalization, and confidence scoring
- `src/resolvers/` source-specific lookup logic
- `src/cache/` session cache and changed-footnote tracking
- `src/types/` shared TypeScript types