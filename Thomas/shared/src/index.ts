export type CitationMatch = {
  label: string;
  value: string;
  index: number;
};

export type CitationContext = CitationMatch & {
  context: string;
};

export function detectCitations(text: string): CitationMatch[] {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return [];
  }

  const patterns = [
    {
      label: 'Case citation',
      regex: /\b[A-Z][A-Za-z.'-]+(?:\s+v\.\s+[A-Z][A-Za-z.'-]+)?,\s*\d+\s+[A-Za-z0-9.]+\s+\d+\b/g,
    },
    {
      label: 'Statute citation',
      regex: /\b\d+\s+U\.S\.C\.\s*[§§]?\s*\d+[A-Za-z0-9.-]*\b/g,
    },
    {
      label: 'Case name',
      regex: /\b[A-Z][A-Za-z.'-]+\s+v\.\s+[A-Z][A-Za-z.'-]+\b/g,
    },
  ];

  const seenValues = new Set<string>();
  const matches: CitationMatch[] = [];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern.regex)) {
      const value = match[0].trim();
      if (!seenValues.has(value)) {
        seenValues.add(value);
        matches.push({
          label: pattern.label,
          value,
          index: match.index ?? 0,
        });
      }
    }
  }

  return matches;
}

export function getCitationContexts(text: string, radius = 180): CitationContext[] {
  return detectCitations(text).map((citation) => {
    const start = Math.max(0, citation.index - radius);
    const end = Math.min(text.length, citation.index + citation.value.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';

    return {
      ...citation,
      context: `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`,
    };
  });
}
