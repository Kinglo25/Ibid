import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStaticFiles, contentTypeFor, resolveWithinRoot } from '../src/static-files.ts';

/**
 * Serving the pane from the API process.
 *
 * This exists so a free host — one process, one port, no proxy to configure — can run Ibid
 * at all. What it introduces is a file server, and a file server's whole risk is answering
 * for a path the operator did not mean to publish. So most of what follows is about what
 * must *not* be reachable, and it is written against a real directory on disk rather than a
 * mocked filesystem, because the interesting cases are the ones where the path layer and
 * the filesystem disagree.
 */

let root: string;
let outside: string;

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'ibid-outside-'));
  await writeFile(join(outside, 'secrets.txt'), 'IBID_EURLEX_BEARER_TOKEN=hunter2');

  root = await mkdtemp(join(tmpdir(), 'ibid-static-'));
  await writeFile(join(root, 'index.html'), '<title>Ibid</title>');
  await writeFile(join(root, 'taskpane.html'), '<title>Ibid pane</title>');
  await writeFile(join(root, 'icon-32.png'), 'not really a png');
  await writeFile(join(root, '.env'), 'IBID_EURLEX_API_KEY=secret');
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'main-DDXvLKho.js'), 'console.log(1)');
  await writeFile(join(root, 'assets', 'main-DDXvLKho.css'), 'body{}');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('what a URL is allowed to name', () => {
  test('a directory is served by its index, and a file by itself', async () => {
    const files = createStaticFiles(root);
    assert.equal((await files.find('/'))?.absolutePath, resolve(root, 'index.html'));
    assert.equal((await files.find('/taskpane.html'))?.absolutePath, resolve(root, 'taskpane.html'));
  });

  test('the type is stated, never guessed', async () => {
    const files = createStaticFiles(root);
    // Office refuses a task pane whose HTML arrives as `application/json`, which is what
    // this server sets for every other response it makes.
    assert.equal((await files.find('/taskpane.html'))?.contentType, 'text/html; charset=utf-8');
    assert.equal((await files.find('/assets/main-DDXvLKho.js'))?.contentType, 'text/javascript; charset=utf-8');
    assert.equal((await files.find('/icon-32.png'))?.contentType, 'image/png');
    // An extension nobody put on the allow-list is not served at all, rather than served
    // as something plausible.
    assert.equal(contentTypeFor('/backup.bak'), undefined);
  });

  test('hashed assets are immutable, named files are revalidated', async () => {
    const files = createStaticFiles(root);
    assert.match((await files.find('/assets/main-DDXvLKho.js'))!.cacheControl, /immutable/);
    // `taskpane.html` keeps its name across every deployment, so a year-long cache would
    // pin a reviewer to the build they first opened.
    assert.equal((await files.find('/taskpane.html'))!.cacheControl, 'no-cache');
  });
});

describe('what must never be reachable', () => {
  test('a traversal out of the root, however it is spelled', async () => {
    const files = createStaticFiles(root);
    for (const attempt of [
      '/../secrets.txt',
      '/../../etc/passwd',
      '/assets/../../secrets.txt',
      '/%2e%2e%2fsecrets.txt',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/..%2f..%2fsecrets.txt',
      '//../secrets.txt',
      '/./../../secrets.txt',
    ]) {
      assert.equal(await files.find(attempt), undefined, `must refuse ${attempt}`);
    }
  });

  test('an absolute path naming a real file elsewhere', async () => {
    // Refused because the check is made on the resolved path rather than on the shape of
    // the request, so joining an absolute path to the root simply lands inside the root.
    const files = createStaticFiles(root);
    assert.equal(await files.find(join(outside, 'secrets.txt')), undefined);
  });

  test('a symlink that points out of the root', async () => {
    // The one case the path layer cannot see: this resolves cleanly by name and still hands
    // out a file the operator did not publish. Caught by re-checking the real path.
    const files = createStaticFiles(root);
    await symlink(join(outside, 'secrets.txt'), join(root, 'escape.txt'));
    try {
      assert.equal(await files.find('/escape.txt'), undefined);
    } finally {
      await rm(join(root, 'escape.txt'), { force: true });
    }
  });

  test('a dot-file, at any depth', async () => {
    // `.env` is the one that matters — the server's own credentials live in the
    // environment, and a deployment that copies one into the served directory should not
    // publish it.
    const files = createStaticFiles(root);
    assert.equal(await files.find('/.env'), undefined);
    assert.equal(await files.find('/assets/../.env'), undefined);
    assert.equal(resolveWithinRoot(root, '/.git/config'), undefined);
  });

  test('a malformed escape, and an embedded NUL', async () => {
    const files = createStaticFiles(root);
    assert.equal(await files.find('/%'), undefined, 'a stray % is a malformed request');
    assert.equal(await files.find('/index.html%00.png'), undefined);
  });

  test('a directory, and a file that is not there', async () => {
    const files = createStaticFiles(root);
    assert.equal(await files.find('/assets'), undefined, 'a directory is not a response');
    assert.equal(await files.find('/does-not-exist.html'), undefined);
  });
});
