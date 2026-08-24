import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A retrieved CELLAR document, kept so the next citation of the same authority does not
 * have to download it again.
 *
 * `etag` and `lastModified` are what make this a cache rather than a copy. CELLAR serves
 * documents with `Cache-Control: no-cache` — cache freely, but confirm before use — and
 * answers a conditional request with `304` and no body. Holding the validators is what lets
 * the resolver ask "is this still the text?" instead of "send me the text again": measured
 * live, that is 0 bytes in ~270ms against 149KB in ~1.5s for one judgment, and CELLAR
 * serves no compression, so the saving is the whole document.
 *
 * `fetchedAt` is when the document was last *confirmed* against EUR-Lex, not when it was
 * first downloaded — a `304` refreshes it. It is what the pane displays, so it has to mean
 * "this was the official text as of", which is a fact about the last revalidation.
 */
export type StoredDocument = {
  html: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
};

export type DocumentStore = {
  get(key: string): Promise<StoredDocument | undefined>;
  set(key: string, document: StoredDocument): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

export type StoreLimits = {
  /** How many documents to keep. CELLAR documents run 20KB–800KB, so this bounds the disk too. */
  maxEntries?: number;
  /** A second bound, in bytes, for a corpus of unusually large documents. */
  maxBytes?: number;
};

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * There is deliberately no TTL anywhere in this module.
 *
 * A published EU legal text does not change: a directive is amended by another instrument
 * carrying its own CELEX, and a judgment is never rewritten. Expiring an entry after an
 * arbitrary interval would therefore throw away a document that is still correct, and
 * expiring it after a long one would still be a guess. Revalidation is the freshness
 * mechanism instead — every hit is confirmed against EUR-Lex before it is shown, so the
 * cache is never older than the request that just served it.
 */

/**
 * Keeps the newest entries and drops the oldest, by the time each was last confirmed.
 *
 * Bounded because this process is meant to run for months: an unbounded map of retrieved
 * passages was a documented weakness of the previous cache (see `docs/DATA-FLOW.md`), and a
 * persistent one would be the same weakness written to disk.
 */
function evictionOrder(entries: Array<{ key: string; fetchedAt: number; bytes: number }>, limits: Required<StoreLimits>): string[] {
  const newestFirst = [...entries].sort((a, b) => b.fetchedAt - a.fetchedAt);
  const doomed: string[] = [];
  let kept = 0;
  let bytes = 0;
  for (const entry of newestFirst) {
    kept += 1;
    bytes += entry.bytes;
    if (kept > limits.maxEntries || bytes > limits.maxBytes) doomed.push(entry.key);
  }
  return doomed;
}

/**
 * The store the resolver uses when nothing else is supplied: bounded, in-process, and gone
 * when the process is. This is what a test or a library caller gets, so importing the
 * resolver never writes to a disk the caller did not ask it to write to.
 */
export function createMemoryDocumentStore(limits: StoreLimits = {}): DocumentStore {
  const bounds = { maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES, maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES };
  const entries = new Map<string, StoredDocument>();

  function evict() {
    const doomed = evictionOrder(
      [...entries].map(([key, document]) => ({ key, fetchedAt: document.fetchedAt, bytes: document.html.length })),
      bounds,
    );
    doomed.forEach((key) => entries.delete(key));
  }

  return {
    async get(key) { return entries.get(key); },
    async set(key, document) { entries.set(key, document); evict(); },
    async delete(key) { entries.delete(key); },
    async clear() { entries.clear(); },
  };
}

/** One file per document, named by a hash so a CELEX cannot escape the directory. */
function fileFor(directory: string, key: string): string {
  return join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/**
 * Where a deployment keeps retrieved documents when it has not said.
 *
 * Deliberately outside the repository — the cache holds public EU legal text, but it is
 * retrieved data rather than source, and a directory of hundreds of judgments appearing
 * under a working tree is a thing to be committed by accident. The platform cache
 * directories below are all outside any checkout and are already understood to hold
 * disposable data.
 */
export function defaultCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IBID_CACHE_DIR) return env.IBID_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'ibid', 'documents');
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'Ibid', 'Cache', 'documents');
  const home = homedir();
  return home ? join(home, '.cache', 'ibid', 'documents') : join(tmpdir(), 'ibid-documents');
}

/**
 * A document store that survives a restart.
 *
 * The point of persisting is not to save the disk read — it is that a restarted server
 * starts from "confirm this is still the text" (~270ms, no body) rather than from "send me
 * every judgment this document cites again". The API server is a plain background process
 * with no supervisor; restarting it is how it is deployed and how it is fixed, and before
 * this every restart threw away every document.
 *
 * Every disk operation degrades to the in-memory layer rather than failing a lookup. A
 * cache that cannot be read is a slow lookup; a cache that can take a lookup down with it
 * is a liability, and this one sits in front of the only thing the pane is for.
 */
export function createFileDocumentStore(options: { directory?: string } & StoreLimits = {}): DocumentStore {
  const directory = options.directory ?? defaultCacheDirectory();
  const bounds = { maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES };
  const memory = new Map<string, StoredDocument>();
  // Writes are serialised so two lookups finishing together cannot interleave an eviction
  // sweep with a write, and so nothing here ever opens a second handle on the same file.
  let writes: Promise<unknown> = Promise.resolve();

  function queue<T>(work: () => Promise<T>): Promise<T> {
    const run = writes.then(work);
    writes = run.then(() => undefined, () => undefined);
    return run;
  }

  async function evict() {
    const names = await readdir(directory).catch(() => [] as string[]);
    const described = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const path = join(directory, name);
      const info = await stat(path).catch(() => undefined);
      return info ? { key: path, fetchedAt: info.mtimeMs, bytes: info.size } : undefined;
    }));
    const present = described.filter((entry): entry is { key: string; fetchedAt: number; bytes: number } => Boolean(entry));
    await Promise.all(evictionOrder(present, bounds).map((path) => unlink(path).catch(() => undefined)));
  }

  return {
    async get(key) {
      const held = memory.get(key);
      if (held) return held;
      try {
        const raw = await readFile(fileFor(directory, key), 'utf8');
        const parsed = JSON.parse(raw) as StoredDocument & { key?: string };
        // A hash collision would serve one document's text under another's citation, which
        // is the single failure this whole tool exists to prevent. The key is written into
        // the file so it can be checked rather than assumed.
        if (parsed.key !== undefined && parsed.key !== key) return undefined;
        if (typeof parsed.html !== 'string' || typeof parsed.fetchedAt !== 'number') return undefined;
        const document: StoredDocument = {
          html: parsed.html, etag: parsed.etag, lastModified: parsed.lastModified, fetchedAt: parsed.fetchedAt,
        };
        memory.set(key, document);
        return document;
      } catch {
        return undefined;
      }
    },

    async set(key, document) {
      memory.set(key, document);
      const doomed = evictionOrder(
        [...memory].map(([held, value]) => ({ key: held, fetchedAt: value.fetchedAt, bytes: value.html.length })),
        bounds,
      );
      doomed.forEach((held) => memory.delete(held));

      await queue(async () => {
        try {
          await mkdir(directory, { recursive: true });
          const path = fileFor(directory, key);
          // Written beside the target and renamed into place: a process killed mid-write
          // leaves a stray temporary file rather than a truncated document that would be
          // read back as the official text.
          const temporary = `${path}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify({ key, ...document }), 'utf8');
          await rename(temporary, path);
          await evict();
        } catch {
          // The in-memory layer above still holds it; this restart simply will not be the
          // one that benefits.
        }
      }).catch(() => undefined);
    },

    async delete(key) {
      memory.delete(key);
      await queue(() => unlink(fileFor(directory, key)).catch(() => undefined)).catch(() => undefined);
    },

    async clear() {
      memory.clear();
      await queue(async () => {
        const names = await readdir(directory).catch(() => [] as string[]);
        await Promise.all(names.filter((name) => name.endsWith('.json'))
          .map((name) => unlink(join(directory, name)).catch(() => undefined)));
      }).catch(() => undefined);
    },
  };
}
