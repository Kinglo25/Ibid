import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * Installs a DOM into the Node test process, before any module that touches `document` is
 * imported. Loaded with `--import`, which is what guarantees that ordering — importing it
 * from inside a test file would run after React had already been evaluated.
 *
 * The task pane renders outside Word too: with no `Office` global it falls back to the
 * browser-preview document. Tests get that path for free, so a component test needs no
 * Office.js mock — only a DOM, and a `fetch` the pane can call without leaving the machine.
 */
GlobalRegistrator.register();

// React needs to be told it is in a test environment or `act` warns on every state update.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The source lookup is the API's job and has its own suite; here it only has to not reach
 * the network. Returning no documents puts the pane in its 'empty' state, which is a real
 * state it must handle and keeps these tests about the pane rather than about retrieval.
 */
globalThis.fetch = (() => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ documents: [] }),
} as Response)) as typeof fetch;
