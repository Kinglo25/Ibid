import React from 'react';
import ReactDOM from 'react-dom/client';
import type { Root } from 'react-dom/client';
import App from './ui/App';
import './styles.css';

/**
 * Mounts the pane, once, even across hot updates.
 *
 * Vite re-executes this module whenever anything it imports changes. Calling `createRoot`
 * again on the same container mounts a second copy of the pane on top of the first, and in
 * Word that is not merely cosmetic: each copy registers its own selection handler, so both
 * react to the cursor and the stale one keeps answering about the footnote it last saw. The
 * symptom is a pane showing a source for one footnote while the cursor sits in another,
 * with a second header stacked underneath — a bug in the harness that reads exactly like a
 * bug in the matching.
 */
const container = document.getElementById('root')!;
const store = globalThis as typeof globalThis & { __ibidRoot?: Root };
const root = (store.__ibidRoot ??= ReactDOM.createRoot(container));

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
