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
  /** Whether the pane registered a selection handler, i.e. whether it is following. */
  isFollowing: () => boolean;
  remove: () => void;
};

const noop = () => undefined;

export function installWordStub(footnoteTexts: readonly string[], bodyText = 'Document body.'): WordStub {
  const items: FootnoteItem[] = footnoteTexts.map((text) => ({ body: { text, load: noop } }));
  let cursor: number | null = null;
  let handler: (() => void) | undefined;

  const context = {
    document: {
      body: { text: bodyText, load: noop, footnotes: { items, load: noop } },
      getSelection: () => ({
        footnotes: { items: cursor === null ? [] : [items[cursor]], load: noop },
        // The caret is on the reference mark in the body, so the parent body is the
        // document's, not a footnote's — the second of the two routes the pane tries.
        parentBody: { text: bodyText, load: noop },
      }),
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
        addHandlerAsync: (_event: string, next: () => void, callback?: (r: unknown) => void) => {
          handler = next;
          callback?.({ status: 'succeeded' });
        },
        removeHandlerAsync: () => { handler = undefined; },
      },
    },
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.Office = office;
  globals.Word = { run: (callback: (c: unknown) => unknown) => Promise.resolve(callback(context)) };

  return {
    putCursorOn: (footnote) => { cursor = footnote; handler?.(); },
    isFollowing: () => handler !== undefined,
    remove: () => { delete globals.Office; delete globals.Word; },
  };
}
