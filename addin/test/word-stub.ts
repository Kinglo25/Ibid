/**
 * A Word runtime, small enough to drive a cursor with.
 *
 * The pane's real interaction is cursor-driven: a reviewer puts the caret on a citation and
 * the pane answers about that one. Every existing component test runs the browser-preview
 * path instead, where there is no Office global and no cursor, so that entire behaviour —
 * what opens by itself, what is cleared when the caret moves on, whether the footnote index
 * is collapsed — went unexercised. This is the smallest stub that lets a test act like a
 * person moving a caret between footnotes.
 *
 * It implements only the calls `readWordDocument` and `readSelectedFootnotes` actually
 * make. Anything else the pane reaches for should fail loudly here rather than be quietly
 * faked, because a stub that answers questions the real Word would not is worse than none.
 */

type FootnoteItem = { body: { text: string; load: (property: string) => void } };

export type WordStub = {
  /** Put the caret on a footnote's reference mark, or nowhere with `null`. */
  putCursorOn: (footnote: number | null) => void;
  /**
   * Put the caret inside a footnote's own text, the way clicking at the foot of the page
   * does. `parentBody` becomes that footnote's body, and `Range.footnotes` reports nothing,
   * which is the route the reference-mark case never exercises.
   */
  putCursorInFootnoteText: (footnote: number) => void;
  /**
   * The awkward case: the caret is genuinely inside a footnote, but its body reports text
   * the pane never read — a conversion artefact, or a document edited since the last
   * refresh. Nothing can identify it, and the pane has to say so rather than keep answering.
   */
  putCursorInUnknownFootnote: (selectedText?: string) => void;
  /**
   * The build this pane actually met: the caret is inside a footnote, and Word reports the
   * parent body as the document rather than the footnote — so nothing that asks the body
   * what it is can identify it, and only the caret's own paragraph still can.
   */
  putCursorInFootnoteParagraph: (footnote: number) => void;
  /**
   * A selection dragged across a whole footnote. Word names the parent body as the section,
   * not the footnote, and hands back more text than the footnote holds, with body paragraphs
   * around it. Every route that asks what the caret is *inside* fails here; the only thing
   * left is reading a footnote the pane already knows back out of the selection.
   */
  dragAcrossFootnote: (footnote: number, surrounding?: string) => void;
  /** Whether the pane registered a selection handler, i.e. whether it is following. */
  isFollowing: () => boolean;
  /**
   * How many times the pane has registered and unregistered a selection handler. One
   * registration and no removals is the whole of a healthy session: Office decides the order
   * of an unawaited removal and the registration that follows it, so a pane that churns
   * handlers is a pane racing for the one the cursor arrives on.
   */
  handlerChurn: () => { registrations: number; removals: number };
  /**
   * How many times the pane has asked Word for the text of a body that holds the document,
   * or a section of it, since the document was read. On a real decision that is 98,000 words
   * across the add-in bridge, and the cursor moves constantly, so the honest answer here is
   * none — for a section as much as for the document, since a decision converted from PDF
   * arrives as one section.
   */
  documentTextLoads: () => number;
  remove: () => void;
};

const noop = () => undefined;

export function installWordStub(footnoteTexts: readonly string[], bodyText = 'Document body.'): WordStub {
  const items: FootnoteItem[] = footnoteTexts.map((text) => ({ body: { text, load: noop } }));
  let cursor: number | null = null;
  let handler: (() => void) | undefined;
  let registrations = 0;
  let removals = 0;
  let documentTextLoads = 0;

  // Where the caret is, and therefore what Word would report for it.
  let mode: 'reference' | 'footnoteText' | 'unknownFootnote' | 'footnoteParagraph' | 'dragAcross' = 'reference';
  let selectedText = '';
  let surroundingText = '';

  const context = {
    document: {
      body: { text: bodyText, load: noop, footnotes: { items, load: noop } },
      getSelection: () => {
        if (mode === 'footnoteText' && cursor !== null) {
          return {
            text: '', load: noop,
            footnotes: { items: [], load: noop },
            parentBody: { text: items[cursor].body.text, type: 'Footnote', load: noop },
            paragraphs: { items: [], load: noop },
          };
        }
        if (mode === 'footnoteParagraph' && cursor !== null) {
          // Inside the footnote, but nothing that asks what the body is can tell: the
          // reference-mark route reports nothing because the caret is not on the mark, and
          // the parent body claims to be the document. Only the paragraph still knows.
          return {
            text: '', load: noop,
            footnotes: { items: [], load: noop },
            parentBody: {
              text: bodyText,
              type: 'MainDoc',
              load: (property: string) => { if (property.includes('text')) documentTextLoads += 1; },
            },
            paragraphs: { items: [{ text: items[cursor].body.text, load: noop }], load: noop },
          };
        }
        if (mode === 'dragAcross' && cursor !== null) {
          // More text than the footnote holds, in a body Word calls a section, with only
          // body paragraphs to show for it. Asking that body for its text would drag the
          // whole section across the bridge, so it is counted here the same as the
          // document's.
          const swallowed = `${surroundingText} ${items[cursor].body.text} ${surroundingText}`.trim();
          return {
            text: swallowed, load: noop,
            footnotes: { items: [], load: noop },
            parentBody: {
              text: bodyText,
              type: 'Section',
              load: (property: string) => { if (property.includes('text')) documentTextLoads += 1; },
            },
            paragraphs: { items: [{ text: surroundingText, load: noop }], load: noop },
          };
        }
        if (mode === 'unknownFootnote') {
          return {
            text: selectedText, load: noop,
            footnotes: { items: [], load: noop },
            parentBody: { text: 'text this pane never read', type: 'Footnote', load: noop },
            paragraphs: { items: [], load: noop },
          };
        }
        return {
          text: '', load: noop,
          footnotes: { items: cursor === null ? [] : [items[cursor]], load: noop },
          // The caret is on the reference mark in the body, so the parent body is the
          // document's, not a footnote's.
          parentBody: {
            text: bodyText,
            type: 'MainDoc',
            // Asking for this is asking for the entire document. Counted rather than
            // refused, so a test can say what it costs instead of merely failing.
            load: (property: string) => { if (property.includes('text')) documentTextLoads += 1; },
          },
          // The caret is on the reference mark, so its paragraph is the body's and
          // identifies nothing.
          paragraphs: { items: [], load: noop },
        };
      },
    },
    sync: () => Promise.resolve(),
  };

  const office = {
    HostType: { Word: 'Word' },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    AsyncResultStatus: { Succeeded: 'succeeded' },
    onReady: () => Promise.resolve({ host: 'Word' }),
    context: {
      document: {
        // Both are asynchronous in Office, and the pane awaits neither. Modelling them as
        // immediate hides the ordering the real thing leaves open, which is where a pane
        // that re-registers loses the handler it just installed.
        addHandlerAsync: (_event: string, next: () => void, callback?: (r: unknown) => void) => {
          registrations += 1;
          queueMicrotask(() => {
            handler = next;
            callback?.({ status: 'succeeded' });
          });
        },
        removeHandlerAsync: (_event: string, options?: { handler?: () => void }) => {
          removals += 1;
          // Office removes the handler it was named, or all of them when named none.
          queueMicrotask(() => {
            if (!options?.handler || options.handler === handler) handler = undefined;
          });
        },
      },
    },
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.Office = office;
  globals.Word = { run: (callback: (c: unknown) => unknown) => Promise.resolve(callback(context)) };

  return {
    putCursorOn: (footnote) => { mode = 'reference'; cursor = footnote; handler?.(); },
    putCursorInFootnoteText: (footnote) => { mode = 'footnoteText'; cursor = footnote; handler?.(); },
    putCursorInUnknownFootnote: (text = '') => { mode = 'unknownFootnote'; selectedText = text; handler?.(); },
    putCursorInFootnoteParagraph: (footnote) => { mode = 'footnoteParagraph'; cursor = footnote; handler?.(); },
    dragAcrossFootnote: (footnote, surrounding = 'Text of the decision either side of it.') => {
      mode = 'dragAcross'; cursor = footnote; surroundingText = surrounding; handler?.();
    },
    isFollowing: () => handler !== undefined,
    handlerChurn: () => ({ registrations, removals }),
    documentTextLoads: () => documentTextLoads,
    remove: () => { delete globals.Office; delete globals.Word; },
  };
}
