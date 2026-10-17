import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { offlineShellManifest } from '../vite.config.ts';

const source = readFileSync(new URL('../client/public/sw.js', import.meta.url), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Asset = { path: string; bytes: number; sha256: string };
type WorkerEvent = {
  waitUntil?: (promise: Promise<unknown>) => void;
  request?: { url: string; method: string; mode: string };
  respondWith?: (promise: Promise<Response>) => void;
  data?: { type: string }; ports?: { postMessage: (message: unknown) => void }[];
};

function worker(base = '/workspace/') {
  const scope = `https://example.test${base}`, prefix = `phabricator-next-shell:${encodeURIComponent(scope)}:`, name = `${prefix}v3`;
  const rows = new Map<string, Map<string, Response>>(), network = new Map<string, Response>(), requests: string[] = [];
  const handlers: Record<string, (event: WorkerEvent) => void> = {}, pending: Promise<unknown>[] = [];
  let skipped = false, offline = false;
  const fetch = async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url; requests.push(url);
    if (offline) throw new Error('Offline');
    return network.get(url)?.clone() ?? new Response('Not found', { status: 404 });
  };
  const cache = (key: string) => {
    if (!rows.has(key)) rows.set(key, new Map());
    const records = rows.get(key)!;
    return {
      match: async (input: Request | string) => records.get(typeof input === 'string' ? input : input.url)?.clone(),
      put: async (input: Request | string, response: Response) => { records.set(typeof input === 'string' ? input : input.url, response.clone()); },
      addAll: async (inputs: Request[]) => {
        const responses = await Promise.all(inputs.map(fetch));
        if (responses.some(response => response.status !== 200)) throw new Error('Asset download failed');
        inputs.forEach((input, index) => records.set(input.url, responses[index]!));
      },
    };
  };
  runInNewContext(source, {
    URL, Request, Response, TextDecoder, Uint8Array, crypto: webcrypto,
    self: { registration: { scope }, navigator: {}, addEventListener: (event: string, handler: typeof handlers[string]) => { handlers[event] = handler; },
      skipWaiting: async () => { skipped = true; }, clients: { claim: async () => {} } },
    caches: { has: async (key: string) => rows.has(key), open: async (key: string) => cache(key), keys: async () => [...rows.keys()], delete: async (key: string) => rows.delete(key) }, fetch,
  });
  const release = (id: string, alter?: (assets: Asset[]) => Asset[]) => {
    const contents = [
      [`assets/app-${id}.js`, `public app ${id}`], [`assets/app-${id}.css`, `public styles ${id}`],
      [`assets/KaTeX-Main_Regular-${id}.woff2`, `public math font ${id}`], [`assets/google-auth-${id}.js`, `public auth client ${id}`],
    ];
    const files = alter?.(contents.map(([path, content]) => ({ path: path!, bytes: content!.length, sha256: hash(content!) }))) ?? contents.map(([path, content]) => ({ path: path!, bytes: content!.length, sha256: hash(content!) }));
    const manifest = JSON.stringify({ format: 'phabricator.offline-shell.v1', files });
    const manifestURL = `${scope}assets/offline-shell-${hash(manifest)}.json`;
    const html = `<meta name="application-base" content="${base}"><meta name="application-shell" content="${manifestURL}"><script src="${base}assets/app-${id}.js"></script><link href="${base}assets/app-${id}.css">release ${id}`;
    network.set(scope, new Response(html, { headers: { 'Content-Type': 'text/html' } }));
    network.set(manifestURL, new Response(manifest));
    for (const [path, content] of contents) network.set(`${scope}${path}`, new Response(content));
    for (const path of ['icon.svg', 'manifest.webmanifest']) network.set(`${scope}${path}`, new Response('public static'));
    return { html, files, manifestURL };
  };
  const waitUntil = (promise: Promise<unknown>) => { pending.push(promise); };
  const settle = async () => { const running = pending.splice(0); await Promise.all(running); };
  const install = async () => { handlers.install!({ waitUntil }); await settle(); };
  const activate = async () => { handlers.activate!({ waitUntil }); await settle(); };
  const request = (path: string, mode = 'cors', method = 'GET') => {
    let result: Promise<Response> | undefined;
    handlers.fetch!({ request: { url: new URL(path, scope).href, mode, method }, waitUntil, respondWith: value => { result = value; } });
    return result;
  };
  const ready = async () => {
    let result: unknown;
    handlers.message!({ data: { type: 'phabricator.offline-shell.status.v1' }, ports: [{ postMessage: message => { result = message; } }], waitUntil });
    await settle(); return (result as { ready: boolean }).ready;
  };
  return { scope, prefix, name, rows, network, requests, release, install, activate, request, settle, ready, skipped: () => skipped, goOffline: () => { offline = true; } };
}

test('build manifest includes lazy application chunks and every bundled font, excluding opt-in engines', async () => {
  for (const base of ['/', '/workspace/']) {
    const bundle = Object.fromEntries(['index.html', 'assets/app-test.js', 'assets/app-test.css', 'assets/KaTeX-Main-test.woff2', 'assets/KaTeX-Main-test.woff', 'assets/KaTeX-Main-test.ttf', 'assets/google-auth-test.js', 'assets/PaperPdf-test.js', 'assets/transcription-worker-test.js', 'assets/transcription-runtime-test.mjs', 'assets/transcription-runtime-test.wasm', 'assets/pdf.worker.min-test.mjs', 'assets/ort-test.wasm'].map(fileName => [fileName, { type: 'asset', fileName, source: fileName === 'index.html' ? '<head></head>' : 'public bytes' }]));
    const plugin = offlineShellManifest(base), hook = plugin.generateBundle!;
    let emitted!: { fileName: string; source: string };
    await Reflect.apply(typeof hook === 'function' ? hook : hook.handler, { emitFile: (file: typeof emitted) => { emitted = file; } }, [{}, bundle]);
    const manifest = JSON.parse(emitted.source) as { files: Asset[] };
    assert.equal(emitted.fileName, `assets/offline-shell-${hash(emitted.source)}.json`);
    assert.ok(bundle['index.html']!.source.includes(`content="${base}${emitted.fileName}"`));
    assert.deepEqual(manifest.files.map(file => file.path).sort(), ['assets/KaTeX-Main-test.ttf', 'assets/KaTeX-Main-test.woff', 'assets/KaTeX-Main-test.woff2', 'assets/PaperPdf-test.js', 'assets/app-test.css', 'assets/app-test.js', 'assets/google-auth-test.js'].sort());
    assert.ok(manifest.files.every(file => file.bytes === 12 && file.sha256 === hash('public bytes')));
  }
});

test('real Vite builds pin the final bytes after lazy-import preload rewriting', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'phabricator-offline-shell-')));
  try {
    await mkdir(join(directory, 'fonts'));
    await Promise.all([
      writeFile(join(directory, 'index.html'), '<html><head><meta name="application-base" content="%BASE_URL%"/></head><body><script type="module" src="/main.js"></script></body></html>'),
      writeFile(join(directory, 'main.js'), "import './style.css'; document.body.addEventListener('click', async () => { document.body.dataset.loaded = (await import('./lazy.js')).message; });"),
      writeFile(join(directory, 'lazy.js'), "import './lazy.css'; export const message = 'loaded';"),
      writeFile(join(directory, 'style.css'), "@font-face {font-family: KaTeX; src: url('./fonts/KaTeX-Test.woff2')} body {font-family: KaTeX}"),
      writeFile(join(directory, 'lazy.css'), '.preview {color: blue}'),
      writeFile(join(directory, 'fonts/KaTeX-Test.woff2'), 'public font bytes'),
    ]);
    for (const base of ['/', '/workspace/']) {
      const output = join(directory, 'dist');
      await build({ configFile: false, root: directory, base, plugins: [offlineShellManifest(base)], logLevel: 'silent', build: { outDir: output, emptyOutDir: true, assetsInlineLimit: 0 } });
      const html = await readFile(join(output, 'index.html'), 'utf8');
      const manifestPath = html.match(/name="application-shell" content="([^"]+)"/)?.[1];
      assert.ok(manifestPath?.startsWith(`${base}assets/offline-shell-`));
      const manifestBytes = await readFile(join(output, manifestPath!.slice(base.length)), 'utf8');
      assert.equal(manifestPath, `${base}assets/offline-shell-${hash(manifestBytes)}.json`);
      const manifest = JSON.parse(manifestBytes) as { files: Asset[] };
      assert.ok(manifest.files.some(file => file.path.includes('/lazy-') && file.path.endsWith('.js')));
      assert.ok(manifest.files.some(file => file.path.endsWith('.woff2')));
      for (const file of manifest.files) {
        const bytes = await readFile(join(output, file.path));
        assert.equal(bytes.byteLength, file.bytes, `${base}${file.path} byte count`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${base}${file.path} final hash`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh offline reload includes first-use math fonts at root and subpath mounts', async () => {
  for (const base of ['/', '/workspace/']) {
    const w = worker(base), release = w.release('first');
    assert.equal(await w.ready(), false); await w.install();
    assert.equal(w.skipped(), true); assert.equal(await w.ready(), true);
    assert.ok(w.requests.includes(`${w.scope}assets/KaTeX-Main_Regular-first.woff2`));
    w.goOffline();
    assert.equal(await (await w.request(w.scope, 'navigate'))?.text(), release.html);
    assert.equal(await (await w.request('assets/KaTeX-Main_Regular-first.woff2'))?.text(), 'public math font first');
    assert.equal(await (await w.request('assets/google-auth-first.js'))?.text(), 'public auth client first');
    w.rows.get(w.name)!.delete(`${w.scope}assets/KaTeX-Main_Regular-first.woff2`);
    assert.equal(await w.ready(), false);
  }
});

test('failed or corrupt asset download retains the prior complete offline shell', async () => {
  for (const failure of ['missing-font', 'wrong-font', 'wrong-manifest', 'missing-entry', 'api-path', 'transcription', 'duplicate']) {
    const w = worker(), original = w.release('old'); await w.install();
    const next = w.release('new', files => {
      if (failure === 'missing-entry') return files.filter(file => !file.path.endsWith('.css'));
      if (failure === 'api-path') return [...files, { ...files[0]!, path: 'api/source.js' }];
      if (failure === 'transcription') return [...files, { ...files[0]!, path: 'assets/transcription-worker-secret.js' }];
      if (failure === 'duplicate') return [...files, files[0]!];
      return files;
    });
    if (failure === 'missing-font') w.network.delete(`${w.scope}assets/KaTeX-Main_Regular-new.woff2`);
    if (failure === 'wrong-font') w.network.set(`${w.scope}assets/KaTeX-Main_Regular-new.woff2`, new Response('corrupt'));
    if (failure === 'wrong-manifest') w.network.set(next.manifestURL, new Response('{}'));
    assert.equal(await (await w.request(w.scope, 'navigate'))?.text(), next.html);
    await w.settle();
    assert.equal(await w.rows.get(w.name)!.get(w.scope)!.clone().text(), original.html, failure);
    assert.equal(await w.ready(), true, failure);
    w.goOffline(); assert.equal(await (await w.request(w.scope, 'navigate'))?.text(), original.html, failure);
    assert.ok(!w.requests.includes(`${w.scope}api/source.js`));
  }
});

test('installation failure does not retire old caches; successful activation touches only this installation', async () => {
  const w = worker(), sibling = `phabricator-next-shell:${encodeURIComponent('https://example.test/other/')}:v2`;
  for (const name of [`${w.prefix}v1`, `${w.prefix}v2`, sibling, 'phabricator-next-shell-v1', 'unrelated']) w.rows.set(name, new Map());
  w.release('first'); w.network.delete(`${w.scope}assets/KaTeX-Main_Regular-first.woff2`);
  await assert.rejects(w.install()); assert.equal(w.skipped(), false); assert.ok(w.rows.has(`${w.prefix}v2`)); assert.equal(await w.ready(), false);
  w.release('first'); await w.install(); await w.activate();
  assert.deepEqual([...w.rows.keys()].sort(), [sibling, 'phabricator-next-shell-v1', 'unrelated', w.name].sort());
});

test('private API, auth, sibling sites, query strings and arbitrary responses never populate shell caches', async () => {
  const w = worker(); w.release('first'); await w.install();
  for (const path of ['/api/state', '/workspace/api/state', '/workspace/auth/login', '/workspace/assets/private.json', '/other/', '/other/assets/a.js', '/', '/workspace/?auth=code', 'https://another.test/workspace/assets/app.js']) assert.equal(w.request(path, 'navigate'), undefined, path);
  assert.equal(w.request('assets/app-first.js', 'cors', 'POST'), undefined);
  assert.equal((await w.request('assets/unlisted-font.woff2'))?.status, 404);
  assert.equal(w.rows.get(w.name)!.has(`${w.scope}assets/unlisted-font.woff2`), false);
  assert.ok([...w.rows.get(w.name)!.keys()].every(url => url.startsWith(w.scope)));
});
