/**
 * Static-hosting tests.
 *
 * These cover the part of the server that is easiest to get subtly wrong and
 * hardest to notice: the dashboard is served by hand, so the caching rules, the
 * single-page fallback and the path-traversal guard are all ours to get right.
 * Each test below locks in a bug that was actually observed:
 *
 *   * a missing hashed bundle was answered with index.html, so the browser
 *     executed the shell as JavaScript and reported a MIME error instead of a
 *     404 — which hides the real problem;
 *   * every non-HTML file, including `sw.js`, was served `immutable` for a year,
 *     which makes it impossible to ever ship a service-worker update;
 *   * `decodeURIComponent` on a malformed path threw out of the request handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../src/db/index.ts';
import { Engine } from '../src/engine.ts';
import { defaultConfig } from '../src/config.ts';
import { createAttentioServer } from '../src/server.ts';
import { NullCollector } from '../src/collector/types.ts';

/** A stand-in for a Vite output directory. */
function fixtureWebRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'attentio-web-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="./assets/index-abc123.js"></script></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("Attentio");');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Attentio"}');
  return dir;
}

async function withServer(
  run: (base: string, webRoot: string) => Promise<void>,
  options: { webRoot?: string | null } = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'attentio-home-'));
  const webRoot = options.webRoot === null ? undefined : (options.webRoot ?? fixtureWebRoot());
  const config = defaultConfig();
  const db = new Db(join(home, 'attentio.db'));
  // The static layer never touches the engine; a null collector keeps the test
  // from sampling the machine that happens to be running it.
  const engine = new Engine({ db, config, collector: new NullCollector('test') });
  const server = await createAttentioServer({
    config,
    db,
    engine,
    ...(webRoot ? { webRoot } : {}),
    // Port 0 lets the OS pick, so tests never collide with a running daemon.
    port: 0,
    host: '127.0.0.1',
  });

  try {
    await run(`http://127.0.0.1:${server.port}`, webRoot ?? '');
  } finally {
    await server.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (webRoot) rmSync(webRoot, { recursive: true, force: true });
  }
}

/** fetch() strips `..` from a URL before sending, so traversal needs raw bytes. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the shell at / with no-store caching', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(body.includes('id="root"'));
  });
});

test('serves hashed assets as immutable JavaScript', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    assert.match(response.headers.get('cache-control') ?? '', /immutable/);
    assert.ok((await response.text()).includes('Attentio'));
  });
});

test('never lets unhashed files be cached immutably', async () => {
  // A year-long cache on the service worker means a shipped fix can never reach
  // a browser that already installed the old one.
  await withServer(async (base) => {
    for (const path of ['/sw.js', '/manifest.webmanifest']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      const cacheControl = response.headers.get('cache-control') ?? '';
      assert.ok(!cacheControl.includes('immutable'), `${path} was ${cacheControl}`);
      assert.equal(cacheControl, 'no-cache', path);
    }
  });
});

test('falls back to the shell for a navigation path', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/timeline`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('id="root"'));
  });
});

test('a missing file 404s instead of returning the shell as JavaScript', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/assets/index-stale.js`);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.ok(!body.includes('id="root"'), 'must not answer a missing asset with HTML');
    assert.match(body, /not_found/);
  });
});

test('refuses path traversal in every encoding a client can send', async () => {
  await withServer(async (base, webRoot) => {
    const port = Number(new URL(base).port);
    // A file outside webRoot that must never be reachable.
    writeFileSync(join(webRoot, '..', 'secret.txt'), 'TOP SECRET');

    for (const path of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e%2fsecret.txt',
    ]) {
      const response = await rawGet(port, path);
      assert.ok(response.status >= 400, `${path} returned ${response.status}`);
      assert.ok(!response.body.includes('TOP SECRET'), `${path} leaked the file`);
    }

    rmSync(join(webRoot, '..', 'secret.txt'), { force: true });
  });
});

test('treats malformed percent-encoding as a bad request, not a crash', async () => {
  await withServer(async (base) => {
    const port = Number(new URL(base).port);
    const response = await rawGet(port, '/%zz');
    assert.equal(response.status, 400);
    assert.match(response.body, /bad_path/);

    // The server must still be alive afterwards.
    const after = await fetch(`${base}/api/health`);
    assert.equal(after.status, 200);
  });
});

test('says so plainly when the dashboard was never built', async () => {
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /not been built|web:build/);
      // The API keeps working without a dashboard, which is what makes the CLI
      // and the phone useful on a machine where nobody ran the web build.
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    },
    { webRoot: null },
  );
});
