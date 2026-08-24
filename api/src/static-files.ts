import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Serving the task pane from the API process.
 *
 * The documented deployment puts a reverse proxy in front: Caddy serves `addin/dist` and
 * forwards `/api` to this process, and that remains the right shape for a real host. But a
 * proxy is a thing you have to be able to configure, and on every free or
 * platform-as-a-service host there is nothing to configure it in — you get one process, one
 * port, and whatever it answers. Serving the pane from here is what makes those hosts
 * reachable at all, which is what a client trial needs before anyone pays for a VM.
 *
 * Off unless `IBID_STATIC_DIR` names a directory. A server that starts serving files
 * because it happened to be run from the wrong working directory is a worse failure than
 * one that serves nothing, so this is opt-in and stays opt-in.
 */

/**
 * What a request is allowed to reach, and how it should be sent.
 *
 * `contentType` is explicit rather than guessed: Office refuses a task pane whose HTML
 * arrives as `application/json`, which is what this server sets for everything else.
 */
export type StaticAsset = {
  absolutePath: string;
  contentType: string;
  cacheControl: string;
  size: number;
};

/**
 * Only what the pane is actually built from. An allow-list rather than a lookup table with
 * a default, so a file type nobody thought about is not served with a guessed type — the
 * build output is ours and its extensions are known.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Vite writes content-hashed filenames into `assets/`, so those bytes can never change
 * under a given name and are safe to cache for a year. Everything else — the HTML entry
 * points, the manifest icons — keeps its name across deployments, so it is revalidated on
 * every use. Same reasoning as the document cache: revalidation rather than a timer is
 * what keeps a cache honest.
 */
function cacheControlFor(relativePath: string): string {
  return relativePath.startsWith(`assets${sep}`) || relativePath.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

export function contentTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()];
}

/**
 * The path a URL is allowed to name inside the root, or nothing.
 *
 * Every arm of this returns `undefined` rather than throwing, because the caller's answer
 * to all of them is the same 404 and distinguishing them out loud only tells whoever is
 * probing which of their guesses was closer.
 *
 * Refused, in order: a URL that will not decode (a stray `%` is a malformed request, not a
 * filename); an embedded NUL, which historically truncates a path inside a C library and is
 * never legitimate; a dot-file at any level, which is where editor backups, `.env` and
 * `.git` live; and finally anything that escapes the root. That last check is what matters
 * and it is done on the *resolved* path, so `../`, `%2e%2e%2f`, an absolute path and a
 * doubled separator all collapse to the same comparison rather than to a list of patterns
 * to keep up with.
 */
export function resolveWithinRoot(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\u0000')) return undefined;

  // A directory is served by its index, which is the only rewrite here. There is
  // deliberately no catch-all fallback to `index.html`: the pane is three separate HTML
  // entry points rather than a single-page app, and answering every missing asset with a
  // page of markup turns a broken deployment into a blank task pane instead of a 404.
  const requested = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  if (requested.split('/').some((segment) => segment.startsWith('.') && segment !== '')) return undefined;

  const absoluteRoot = resolve(root);
  const candidate = resolve(join(absoluteRoot, normalize(requested)));
  if (candidate !== absoluteRoot && !candidate.startsWith(absoluteRoot + sep)) return undefined;
  return candidate;
}

/**
 * Looks a request up against a directory of built files.
 *
 * The escape check is repeated against the *real* path once the file is known to exist,
 * which is the arm `resolveWithinRoot` cannot cover on its own: a symlink inside the root
 * pointing outside it resolves cleanly by name and still hands out a file the operator did
 * not mean to publish. Ibid's own build output contains no symlinks, so this costs one
 * `realpath` per request and buys the guarantee against a directory that is not ours.
 */
export function createStaticFiles(root: string) {
  const absoluteRoot = resolve(root);

  return {
    root: absoluteRoot,

    async find(urlPath: string): Promise<StaticAsset | undefined> {
      const candidate = resolveWithinRoot(absoluteRoot, urlPath);
      if (!candidate) return undefined;

      const contentType = contentTypeFor(candidate);
      if (!contentType) return undefined;

      let real: string;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        real = await realpath(candidate);
        if (real !== absoluteRoot && !real.startsWith(absoluteRoot + sep)) return undefined;
        info = await stat(real);
      } catch {
        // Missing, unreadable, or a broken symlink. All of them are "not here" to a caller.
        return undefined;
      }
      if (!info.isFile()) return undefined;

      return {
        absolutePath: real,
        contentType,
        cacheControl: cacheControlFor(real.slice(absoluteRoot.length + 1)),
        size: info.size,
      };
    },

    /** Streamed rather than read into memory: the pane's largest asset is a bundle, not a page. */
    open(asset: StaticAsset) {
      return createReadStream(asset.absolutePath);
    },
  };
}
