import type { CitationCandidate, CitationContext } from '../../../shared/src';

/**
 * The presentation decisions the task pane makes about a citation, kept apart from the
 * component that renders them.
 *
 * These are the pane's judgement calls — how far a confirmation reaches, what a reviewer is
 * told about where a citation came from, how an unresolved one is explained — and each is a
 * plain function of one citation. Separating them from the JSX is what lets them be tested
 * by the repository's ordinary Node test runner, with no DOM and no React, rather than only
 * through a rendered component.
 */

export function citationKey(citation: CitationContext, footnoteId: string): string {
  return `${footnoteId}-${citation.index}-${citation.value}`;
}

/**
 * How far a confirmation reaches.
 *
 * A short form is a name, and a name means one thing throughout a document, so settling
 * "Akzo Nobel" once settles every later use of it — that is the whole point of confirming
 * it. A back-reference is positional: `Ibid.` means whatever precedes it, so two of them in
 * the same document are two different citations that merely happen to be spelled the same.
 * Keying those by their text would take one reviewer's decision about footnote 13 and apply
 * it, unasked and invisibly, to every other `Ibid.` in the document.
 */
export function confirmationKey(citation: CitationContext, footnoteId: string): string {
  return citation.backReference ? citationKey(citation, footnoteId) : citation.value.toLowerCase();
}

export function curiaSearchUrl(query: string): string {
  return `https://curia.europa.eu/juris/liste.jsf?language=en&num=${encodeURIComponent(query)}`;
}

export function officialSourceUrl(citation: CitationContext): string {
  // The CELEX names the document that was cited whatever kind it is — its sector is
  // derived from the document type — so an opinion links to the opinion, not to the
  // judgment in the same case.
  if (citation.celex) return `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${citation.celex}`;
  if (citation.source === 'commission') return `https://competition-cases.ec.europa.eu/search?query=${encodeURIComponent(citation.value)}`;
  // caseNumber, then ecli, then the literal matched text, in that preference order: a
  // shorthand reference resolved via a defined term (e.g. "Akzo Nobel, para. 45.") carries
  // its originating citation's caseNumber/ecli but its own `value` is just the short form,
  // which is not a usable CURIA search query on its own.
  return curiaSearchUrl(citation.caseNumber ?? citation.ecli ?? citation.value);
}

export function candidateKey(candidate: CitationCandidate): string {
  return candidate.ecli ?? candidate.caseNumber ?? candidate.celex ?? candidate.caseName ?? 'unknown';
}

/**
 * The judgment, the Advocate General's opinion, and the order in one case all share the
 * case name exactly, so a pick-list built on the name alone offers three identical-looking
 * options — the reviewer cannot tell which is which at the moment they are being asked to
 * choose. The document type is what separates them.
 */
export function candidateLabel(candidate: CitationCandidate): string {
  const name = candidate.caseName ?? candidate.caseNumber ?? candidate.label;
  return candidate.caseName && candidate.documentType ? `${name} (${candidate.documentType})` : name;
}

/**
 * Why this citation is showing what it is showing. A lawyer deciding how hard to check
 * something needs to know whether Ibid read it out of the document or inferred it, and
 * that distinction was previously only in the data, never on screen. Saying it plainly is
 * the alternative to making every citation a confirmation prompt: full transparency, no
 * forced click on the ones that are not in doubt.
 */
export function resolutionNote(citation: CitationContext): string {
  const footnote = citation.backReference?.footnote;
  switch (citation.resolutionMethod) {
    case 'user_confirmed': return citation.backReference
      ? 'Confirmed by you for this reference.'
      : 'Confirmed by you for this document.';
    case 'preceding_citation': return footnote
      ? `Read as the authority cited immediately before it, in footnote ${footnote}.`
      : 'Read as the authority cited immediately before it.';
    case 'numbered_footnote': return `Read from footnote ${footnote}, which this reference names.`;
    // Distinct from the two above on purpose: this one rests on a choice the reviewer made
    // about another footnote, not on anything the document states, and saying so is what
    // lets them see how far their own decision has carried.
    case 'confirmed_back_reference': return `Read from footnote ${footnote}, which you confirmed.`;
    case 'explicit_alias': return 'Resolved from the short form this document defines for it.';
    case 'generated_variant': return 'Inferred from a case name this document cites in full earlier.';
    // Currently unreachable: a frequent-case suggestion is never `resolved` until a
    // reviewer confirms it, at which point the method becomes 'user_confirmed'. Kept
    // because the alternative if that ever changes is the default below, which would tell
    // a lawyer the citation was stated in the footnote when it was not.
    case 'fallback_table': return "Suggested from Ibid's list of frequently cited cases — not from this document.";
    default: return 'Stated in this footnote.';
  }
}

/**
 * What an unresolved citation tells the reviewer. A back-reference needs its own wording:
 * nothing "defines" an `Ibid.`, and the useful thing to say is which footnote it points at,
 * so the reviewer knows where to look rather than being told the document is silent.
 */
export function unresolvedMessage(citation: CitationContext): string {
  const suggested = citation.candidates ?? [];
  const footnote = citation.backReference?.footnote;

  if (citation.status === 'unconfirmed_suggestion') {
    return `This document does not define "${citation.value}". Ibid recognises the name from its list of frequently cited cases — confirm before relying on it.`;
  }
  if (citation.backReference) {
    if (suggested.length) return `Footnote ${footnote} cites more than one authority, so "${citation.value}" does not say which of them is meant.`;
    return footnote
      ? `"${citation.value}" points back to footnote ${footnote}, which does not establish an authority to point at.`
      : `"${citation.value}" points back to an authority cited before it, but nothing before it establishes one.`;
  }
  return suggested.length
    ? `"${citation.value}" could refer to more than one authority, and this document does not say which.`
    : `"${citation.value}" reads like a reference to an authority, but nothing in this document defines it.`;
}
