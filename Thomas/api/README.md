# api

Optional backend components for source normalization, lookup, retry policy, and caching.

`createSourceResolver()` provides a cache-backed CourtListener adapter. Expose it from your preferred HTTP host as `GET /sources?citation=<citation>`, returning:

```json
{ "documents": [{ "title": "…", "excerpt": "…", "url": "https://…", "source": "CourtListener" }] }
```

Set `VITE_THOMAS_API_BASE_URL` for the add-in build (for example, `https://localhost:4000`) to enable matched-source cards. Without it, the task pane remains usable and offers a direct CourtListener search link.
