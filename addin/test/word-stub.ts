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
  /** Whether the pane registered a selection handler, i.e. whether it is following. */
  isFollowing: () => boolean;
  /**
   * How many times the pane has registered and unregistered a selection handler. One
   * registration and no removals is the whole of a healthy session: Office decides the order
   * of an unawaited removal and the registration that follows it, so a pane that churns
   * handlers is a pane racing for the one the cursor arrives on.
   */
  handlerChurn: () => { registrations: number; removals: number };
  remove: () => void;
};

const noop = () => undefined;

export function installWordStub(footnoteTexts: readonly string[], bodyText = 'Document body.'): WordStub {
  const items: FootnoteItem[] = footnoteTexts.map((text) => ({ body: { text, load: noop } }));
  let cursor: number | null = null;
  let handler: (() => void) | undefined;
  let registrations = 0;
  let removals = 0;

  // Where the caret is, and therefore what Word would report for it.
  let mode: 'reference' | 'footnoteText' | 'unknownFootnote' = 'reference';
  let selectedText = '';

  const context = {
    document: {
      body: { text: bodyText, load: noop, footnotes: { items, load: noop } },
      getSelection: () => {
        if (mode === 'footnoteText' && cursor !== null) {
          return {
            text: '', load: noop,
            footnotes: { items: [], load: noop },
            parentBody: { text: items[cursor].body.text, type: 'Footnote', load: noop },
          };
        }
        if (mode === 'unknownFootnote') {
          return {
            text: selectedText, load: noop,
            footnotes: { items: [], load: noop },
            parentBody: { text: 'text this pane never read', type: 'Footnote', load: noop },
          };
        }
        return {
          text: '', load: noop,
          footnotes: { items: cursor === null ? [] : [items[cursor]], load: noop },
          // The caret is on the reference mark in the body, so the parent body is the
          // document's, not a footnote's.
          parentBody: { text: bodyText, type: 'MainDoc', load: noop },
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
    isFollowing: () => handler !== undefined,
    handlerChurn: () => ({ registrations, removals }),
    remove: () => { delete globals.Office; delete globals.Word; },
  };
}
