export function createApiHealthCheck() {
  return { status: 'ok' as const };
}

export type SourceDocument = {
  title: string;
  excerpt: string;
  url: string;
  source: 'CourtListener';
};

type CourtListenerResult = {
  caseName?: string;
  case_name?: string;
  snippet?: string;
  absolute_url?: string;
  download_url?: string;
};

type CourtListenerResponse = { results?: CourtListenerResult[] };

/**
 * Small, cache-backed adapter for a server endpoint such as `/sources?citation=`.
 * Keep this on the API side so browser clients don't need to call a third-party
 * legal database directly or expose provider-specific behavior.
 */
export function createSourceResolver(fetcher: typeof fetch = fetch) {
  const cache = new Map<string, SourceDocument[]>();

  return {
    async resolve(citation: string): Promise<SourceDocument[]> {
      const query = citation.trim();
      if (!query) return [];

      const cached = cache.get(query);
      if (cached) return cached;

      const response = await fetcher(
        `https://www.courtlistener.com/api/rest/v4/search/?type=o&q=${encodeURIComponent(query)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) {
        throw new Error(`CourtListener lookup failed (${response.status}).`);
      }

      const payload = (await response.json()) as CourtListenerResponse;
      const documents = (payload.results ?? []).slice(0, 5).flatMap((result) => {
        const path = result.download_url ?? result.absolute_url;
        if (!path) return [];
        return [{
          title: result.caseName ?? result.case_name ?? query,
          excerpt: (result.snippet ?? 'Open the opinion to inspect the source text.').replace(/<[^>]*>/g, ''),
          url: path.startsWith('http') ? path : `https://www.courtlistener.com${path}`,
          source: 'CourtListener' as const,
        }];
      });
      cache.set(query, documents);
      return documents;
    },
    clearCache() {
      cache.clear();
    },
  };
}
