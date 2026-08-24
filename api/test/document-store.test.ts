import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDocumentStore, createMemoryDocumentStore, defaultCacheDirectory } from '../src/document-store.ts';

/**
 * The document store, which is the only part of Ibid that writes anything to disk.
 *
 * What it holds is public EU legal text retrieved from CELLAR — never anything read out of
 * the user's document, which does not leave the task pane at all (see `docs/DATA-FLOW.md`).
 * These tests are about the two properties that make it safe to keep: that it is bounded,
 * and that a damaged or unreadable cache degrades to a slow lookup rather than a wrong one.
 */

const directories: string[] = [];
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ibid-store-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const document = (html: string, fetchedAt = 1_000) => ({ html, etag: `"${html}"`, fetchedAt });

describe('the in-memory document store', () => {
  test('returns what was put in it', async () => {
    const store = createMemoryDocumentStore();
    await store.set('32016R0679:en:text/html', document('<p>GDPR</p>'));
    assert.equal((await store.get('32016R0679:en:text/html'))?.html, '<p>GDPR</p>');
  });

  test('keeps the newest entries and drops the oldest', async () => {
    const store = createMemoryDocumentStore({ maxEntries: 2 });
    await store.set('a', document('<p>a</p>', 1));
    await store.set('b', document('<p>b</p>', 2));
    await store.set('c', document('<p>c</p>', 3));

    assert.equal(await store.get('a'), undefined, 'the oldest confirmation is the one to lose');
    assert.ok(await store.get('b'));
    assert.ok(await store.get('c'));
  });

  test('bounds by size as well as by count, for a corpus of large documents', async () => {
    const store = createMemoryDocumentStore({ maxBytes: 20 });
    await store.set('a', document('x'.repeat(15), 1));
    await store.set('b', document('y'.repeat(15), 2));
    assert.equal(await store.get('a'), undefined);
    assert.ok(await store.get('b'));
  });

  test('clear empties it', async () => {
    const store = createMemoryDocumentStore();
    await store.set('a', document('<p>a</p>'));
    await store.clear();
    assert.equal(await store.get('a'), undefined);
  });
});

describe('the persistent document store', () => {
  test('a second store reads what the first one wrote', async () => {
    // This is the whole reason for persisting. The API server is a plain background process
    // with no supervisor — restarting it is how it is deployed and how it is fixed — and
    // before this, every restart threw away every document it had retrieved.
    const directory = await scratch();
    await createFileDocumentStore({ directory }).set('62012CJ0293:en:text/html', document('<p>Digital Rights Ireland</p>'));

    const restarted = createFileDocumentStore({ directory });
    const held = await restarted.get('62012CJ0293:en:text/html');
    assert.equal(held?.html, '<p>Digital Rights Ireland</p>');
    assert.equal(held?.etag, '"<p>Digital Rights Ireland</p>"', 'the validator is what makes the next lookup a 304');
  });

  test('a key it was not asked for is a miss, not another document', async () => {
    const directory = await scratch();
    const store = createFileDocumentStore({ directory });
    await store.set('32016R0679:en:text/html', document('<p>GDPR</p>'));
    assert.equal(await store.get('32016R0679:fr:text/html'), undefined);
    assert.equal(await store.get('32002L0058:en:text/html'), undefined);
  });

  test('a file whose key does not match the one asked for is refused', async () => {
    // Files are named by a hash of the key, so this is a collision by construction. Serving
    // one document's text under another citation is the single failure this whole tool
    // exists to prevent, so the key is written into the file and checked rather than
    // assumed from the filename.
    const directory = await scratch();
    const name = `${createHash('sha256').update('32016R0679:en:text/html').digest('hex')}.json`;
    await writeFile(join(directory, name), JSON.stringify({ key: 'a-different-document', html: '<p>wrong</p>', fetchedAt: 1 }), 'utf8');

    assert.equal(await createFileDocumentStore({ directory }).get('32016R0679:en:text/html'), undefined);
  });

  test('an unreadable cache is a slow lookup, never a failed one', async () => {
    const directory = await scratch();
    const name = `${createHash('sha256').update('32016R0679:en:text/html').digest('hex')}.json`;
    await writeFile(join(directory, name), 'this is not JSON', 'utf8');

    assert.equal(await createFileDocumentStore({ directory }).get('32016R0679:en:text/html'), undefined);
  });

  test('a directory that cannot be created does not take the lookup down with it', async () => {
    // A cache that cannot be written to is a slow lookup. A cache that can fail a lookup is
    // a liability, and this one sits in front of the only thing the pane is for.
    const directory = await scratch();
    const blocker = join(directory, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');

    const store = createFileDocumentStore({ directory: join(blocker, 'documents') });
    await store.set('a', document('<p>a</p>'));
    // The in-memory layer still holds it; this restart simply will not be the one that benefits.
    assert.equal((await store.get('a'))?.html, '<p>a</p>');
  });

  test('deletes the oldest files once it is over its bound', async () => {
    const directory = await scratch();
    const store = createFileDocumentStore({ directory, maxEntries: 2 });
    await store.set('a', document('<p>a</p>', 1));
    await store.set('b', document('<p>b</p>', 2));
    await store.set('c', document('<p>c</p>', 3));

    const remaining = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    assert.equal(remaining.length, 2, `expected two files, saw ${remaining.join(', ')}`);
    assert.equal(await createFileDocumentStore({ directory }).get('a'), undefined);
  });

  test('clear empties the directory', async () => {
    const directory = await scratch();
    const store = createFileDocumentStore({ directory });
    await store.set('a', document('<p>a</p>'));
    await store.clear();

    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.json')), []);
    assert.equal(await createFileDocumentStore({ directory }).get('a'), undefined);
  });
});

describe('where the cache goes when nothing says', () => {
  test('an explicit directory wins', () => {
    assert.equal(defaultCacheDirectory({ IBID_CACHE_DIR: '/srv/ibid/cache' } as NodeJS.ProcessEnv), '/srv/ibid/cache');
  });

  test('otherwise it is a platform cache directory, never the working tree', () => {
    // Retrieved documents are public legal text, but they are retrieved data rather than
    // source, and a directory of hundreds of judgments appearing under a checkout is a
    // thing to be committed by accident.
    const chosen = defaultCacheDirectory({ XDG_CACHE_HOME: '/home/someone/.cache' } as NodeJS.ProcessEnv);
    assert.equal(chosen, '/home/someone/.cache/ibid/documents');
    assert.ok(!defaultCacheDirectory({} as NodeJS.ProcessEnv).includes(process.cwd()));
  });
});
