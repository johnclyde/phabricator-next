import { test, expect, type Download, type Page, type Request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { normalizeBasePath } from '../shared/mount';
import { audioInboxDatabaseName } from '../client/audio-inbox';
import { authAccounts } from './auth-fixture';

interface AudioFixture {
  permission: 'allow' | 'deny' | 'defer';
  requests: MediaStreamConstraints[];
  tracks: MediaStreamTrack[];
  recorders: MediaRecorder[];
  chunks: Blob[];
  urls: { url: string; blob: Blob }[];
  revoked: string[];
  databases: string[];
  quota: boolean;
  pending: { resolve: (stream: MediaStream) => void; reject: (error: Error) => void }[];
  makeStream: () => Promise<MediaStream>;
}
declare global { interface Window { audioFixture: AudioFixture } }

const inbox = (page: Page) => page.getByRole('region', { name: 'Audio inbox', exact: true });
const preview = (page: Page) => page.getByLabel('Recorded audio preview', { exact: true });
const clip = (page: Page, title: string) => inbox(page).getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/** Only the input device is synthetic: encoding, Blob events, playback and IDB are native. */
async function syntheticMicrophone(page: Page, permission: AudioFixture['permission'] = 'allow') {
  await page.addInitScript(initial => {
    const fixture: AudioFixture = { permission: initial, requests: [], tracks: [], recorders: [], chunks: [], urls: [], revoked: [], databases: [], quota: false, pending: [], makeStream: async () => { throw new Error('not initialized'); } };
    window.audioFixture = fixture;
    fixture.makeStream = async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440; gain.gain.value = 0.03; oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => { stop(); if (!stopped) { stopped = true; oscillator.stop(); void context.close(); } };
        fixture.tracks.push(track);
      }
      return destination.stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (constraints: MediaStreamConstraints) => {
      fixture.requests.push(constraints);
      if (fixture.permission === 'deny') throw new DOMException('Test microphone permission denied.', 'NotAllowedError');
      if (fixture.permission === 'defer') return new Promise<MediaStream>((resolve, reject) => fixture.pending.push({ resolve, reject }));
      return fixture.makeStream();
    } });
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); fixture.recorders.push(this); this.addEventListener('dataavailable', event => fixture.chunks.push(event.data)); }
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); if (value instanceof Blob) fixture.urls.push({ url, blob: value }); return url; };
    URL.revokeObjectURL = url => { fixture.revoked.push(url); revoke(url); };
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) => { fixture.databases.push(name); return version === undefined ? open(name) : open(name, version); };
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
      if (fixture.quota && this.name === 'clips') throw new DOMException('Test audio quota exceeded.', 'QuotaExceededError');
      return key === undefined ? add.call(this, value) : add.call(this, value, key);
    };
  }, permission);
}

async function record(page: Page, title: string) {
  const previousChunks = await page.evaluate(() => window.audioFixture.chunks.length);
  await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(start => window.audioFixture.chunks.slice(start).some(blob => blob.size > 0), previousChunks)).toBe(true);
  await inbox(page).getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(preview(page)).toBeVisible(); await page.getByLabel('Recording title', { exact: true }).fill(title);
  await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
}
async function blobDigest(page: Page, locator = preview(page)) {
  return locator.evaluate(async element => {
    const blob = window.audioFixture.urls.find(item => item.url === (element as HTMLMediaElement).src)!.blob;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    return { digest, bytes: blob.size, type: blob.type };
  });
}
async function downloadDigest(download: Download) {
  const stream = await download.createReadStream(); if (!stream) throw new Error('Expected an audio download stream.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
  return { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
async function play(page: Page, title: string) {
  const load = clip(page, title).getByRole('button', { name: 'Play audio', exact: true });
  if (await load.count()) await load.click();
  const audio = clip(page, title).getByLabel(`Play ${title}`, { exact: true });
  await expect(audio).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1);
  await audio.evaluate(async element => { const media = element as HTMLAudioElement; media.muted = true; await media.play(); });
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  await audio.evaluate(element => (element as HTMLAudioElement).pause());
}
async function deleteClip(page: Page, title: string) {
  await clip(page, title).getByRole('button', { name: 'Delete audio', exact: true }).click();
  await clip(page, title).getByRole('button', { name: 'Confirm delete audio', exact: true }).click();
  await expect(clip(page, title)).toHaveCount(0);
}
async function signIn(page: Page, account = 0) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[account]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[account]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[account]!.displayName);
}
function watchRequests(page: Page) {
  const writes: Request[] = [], external: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request); if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  return { writes, external };
}
async function audioDatabases(page: Page) { return page.evaluate(async () => (await indexedDB.databases()).flatMap(database => database.name?.includes('audio-inbox') ? [database.name] : [])); }
async function savedRows(page: Page, name: string) {
  return page.evaluate(name => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open(name); open.onerror = () => reject(open.error); open.onsuccess = () => {
      const database = open.result, transaction = database.transaction('clips', 'readonly'), request = transaction.objectStore('clips').getAll();
      request.onerror = () => reject(request.error); transaction.oncomplete = () => { database.close(); resolve(request.result); }; transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), name);
}

test('real audio is downloaded exactly and saved explicitly for offline playback and deletion', async ({ page, context }, info) => {
  await syntheticMicrophone(page); const traffic = watchRequests(page), title = 'Local recorded research note';
  await page.goto('./#audio'); await expect(inbox(page)).toBeVisible(); expect(await page.evaluate(() => window.audioFixture.requests)).toEqual([]);
  await page.screenshot({ path: info.outputPath('audio-inbox-initial-viewport.png') });
  await record(page, title); const original = await blobDigest(page); expect(original.bytes).toBeGreaterThan(0); expect(original.type).toMatch(/^audio\//);
  const names = await audioDatabases(page); expect(names).toHaveLength(1); expect(await savedRows(page, names[0]!)).toEqual([]);
  const downloaded = page.waitForEvent('download'); await inbox(page).getByRole('button', { name: 'Download recording', exact: true }).click();
  expect(await downloadDigest(await downloaded)).toEqual({ digest: original.digest, bytes: original.bytes }); expect(await savedRows(page, names[0]!)).toEqual([]);
  await inbox(page).getByRole('button', { name: 'Save on this device', exact: true }).click(); await expect(clip(page, title)).toBeVisible(); await expect(preview(page)).toHaveCount(0);
  expect(await savedRows(page, names[0]!)).toHaveLength(1); await play(page, title);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try {
    await page.reload(); await expect(clip(page, title)).toBeVisible(); await play(page, title);
    expect(await blobDigest(page, clip(page, title).getByLabel(`Play ${title}`, { exact: true }))).toEqual(original);
    const retiredUrl = await clip(page, title).getByLabel(`Play ${title}`, { exact: true }).getAttribute('src');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(clip(page, title)).toHaveCount(0);
    expect(await page.evaluate(url => window.audioFixture.revoked.includes(url!), retiredUrl)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await expect(clip(page, title)).toBeVisible(); await play(page, title);
    expect(await clip(page, title).getByLabel(`Play ${title}`, { exact: true }).getAttribute('src')).not.toBe(retiredUrl);
    expect(await blobDigest(page, clip(page, title).getByLabel(`Play ${title}`, { exact: true }))).toEqual(original);
    expect(await page.evaluate(() => window.audioFixture.requests)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (info.project.name === 'mobile') for (const name of ['Download audio', 'Delete audio']) expect((await clip(page, title).getByRole('button', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await clip(page, title).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('audio-inbox-offline.png') });
    await deleteClip(page, title);
    expect(await savedRows(page, names[0]!)).toEqual([]); await page.reload(); await expect(clip(page, title)).toHaveCount(0);
  } finally { await context.setOffline(false); }
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('discard and navigation stop native microphone tracks and retire temporary playback URLs', async ({ page }) => {
  await syntheticMicrophone(page); const traffic = watchRequests(page); await page.goto('./#audio');
  await record(page, 'Discard this local recording'); const url = await preview(page).getAttribute('src');
  await inbox(page).getByRole('button', { name: 'Discard recording', exact: true }).click(); await expect(preview(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(url => window.audioFixture.revoked.includes(url!), url)).toBe(true);
  await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = '#home'; }); await expect(inbox(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => { location.hash = '#audio'; }); await expect(inbox(page)).toBeVisible(); await expect(preview(page)).toHaveCount(0);
  await record(page, 'Temporary note survives hash navigation'); const kept = await blobDigest(page), keptUrl = await preview(page).getAttribute('src');
  await preview(page).evaluate(async element => { const audio = element as HTMLAudioElement; Object.assign(window, { retiredAudioElement: audio }); audio.muted = true; audio.loop = true; await audio.play(); });
  await page.evaluate(() => { location.hash = '#home'; }); await expect(inbox(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { retiredAudioElement: HTMLAudioElement }).retiredAudioElement.paused)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { retiredAudioElement: HTMLAudioElement }).retiredAudioElement.getAttribute('src'))).toBeNull();
  await expect.poll(() => page.evaluate(url => window.audioFixture.revoked.includes(url!), keptUrl)).toBe(true);
  await page.evaluate(() => { location.hash = '#audio'; }); await expect(preview(page)).toBeVisible(); expect(await blobDigest(page)).toEqual(kept);
  const revivedUrl = await preview(page).getAttribute('src');
  await preview(page).evaluate(async element => { const audio = element as HTMLAudioElement; audio.muted = true; await audio.play(); });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(preview(page)).toHaveCount(0); await expect.poll(() => page.evaluate(url => window.audioFixture.revoked.includes(url!), revivedUrl)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(preview(page)).toHaveCount(0); expect(await savedRows(page, (await audioDatabases(page))[0]!)).toEqual([]);
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('denied, cancelled and late microphone permissions never resurrect a retired capture', async ({ page }) => {
  await syntheticMicrophone(page, 'deny'); const traffic = watchRequests(page); await page.goto('./#audio');
  await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page)).toContainText(/permission|denied|allow.*microphone/i); await expect(preview(page)).toHaveCount(0);
  await page.evaluate(() => { window.audioFixture.permission = 'defer'; });
  for (const retire of ['cancel', 'navigate', 'pagehide']) {
    await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Cancel microphone request', exact: true })).toBeVisible();
    if (retire === 'cancel') await inbox(page).getByRole('button', { name: 'Cancel microphone request', exact: true }).click();
    else if (retire === 'navigate') { await page.evaluate(() => { location.hash = '#home'; }); await expect(inbox(page)).toHaveCount(0); }
    else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.evaluate(async () => { const fixture = window.audioFixture; fixture.pending.shift()!.resolve(await fixture.makeStream()); });
    await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    expect(await page.evaluate(() => window.audioFixture.recorders.length)).toBe(0);
    if (retire === 'navigate') await page.evaluate(() => { location.hash = '#audio'; });
    if (retire === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(inbox(page)).toBeVisible(); await expect(preview(page)).toHaveCount(0);
  }
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('recorder errors and oversized delivered chunks stop tracks without presenting a completed clip', async ({ page }) => {
  await syntheticMicrophone(page); const traffic = watchRequests(page); await page.goto('./#audio');
  for (const failure of ['error', 'oversized']) {
    await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
    await page.evaluate(failure => {
      const recorder = window.audioFixture.recorders.at(-1)!;
      if (failure === 'error') { const event = new Event('error'); Object.defineProperty(event, 'error', { value: new DOMException('Test recorder failure.', 'UnknownError') }); recorder.dispatchEvent(event); }
      else recorder.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([new Uint8Array(26 * 1024 * 1024)], { type: recorder.mimeType }) }));
    }, failure);
    await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    await expect(inbox(page)).toContainText(failure === 'error' ? /failed|error|discard/i : /25 MiB|limit|discard/i);
    await expect(preview(page)).toHaveCount(0);
    await expect(inbox(page).getByRole('button', { name: 'Record audio', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const recorder = window.audioFixture.recorders.at(-1)!;
      recorder.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob(['late failed audio'], { type: recorder.mimeType }) })); recorder.dispatchEvent(new Event('stop'));
    });
    await expect(preview(page)).toHaveCount(0);
  }
  expect(await savedRows(page, (await audioDatabases(page))[0]!)).toEqual([]); expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('quota failures retain downloadable audio and malformed stored rows never erase valid recordings', async ({ page }) => {
  await syntheticMicrophone(page); const traffic = watchRequests(page), title = 'Keep this audio when storage fails'; await page.goto('./#audio');
  await record(page, title); const exact = await blobDigest(page), name = (await audioDatabases(page))[0]!;
  await page.evaluate(() => { window.audioFixture.quota = true; }); await inbox(page).getByRole('button', { name: 'Save on this device', exact: true }).click();
  await expect(inbox(page)).toContainText(/quota|storage is full/i); await expect(preview(page)).toBeVisible(); expect(await blobDigest(page)).toEqual(exact); expect(await savedRows(page, name)).toEqual([]);
  const failedDownload = page.waitForEvent('download'); await inbox(page).getByRole('button', { name: 'Download recording', exact: true }).click(); expect(await downloadDigest(await failedDownload)).toEqual({ digest: exact.digest, bytes: exact.bytes });
  await page.evaluate(() => { window.audioFixture.quota = false; }); await inbox(page).getByRole('button', { name: 'Save on this device', exact: true }).click(); await expect(clip(page, title)).toBeVisible();
  await page.evaluate(name => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name); open.onerror = () => reject(open.error); open.onsuccess = () => { const database = open.result, transaction = database.transaction('clips', 'readwrite'); transaction.objectStore('clips').add({ id: 'unknown-format', format: 'future.audio.v999', title: 'Do not render this malformed payload', blob: new Blob(['private unknown bytes']) }); transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onerror = () => { database.close(); reject(transaction.error); }; };
  }), name);
  await page.reload(); await expect(clip(page, title)).toBeVisible(); await expect(inbox(page)).toContainText(/malformed|unsupported/i); await expect(inbox(page)).not.toContainText('Do not render this malformed payload'); expect(await savedRows(page, name)).toHaveLength(2);
  await play(page, title); expect(await blobDigest(page, clip(page, title).getByLabel(`Play ${title}`, { exact: true }))).toEqual(exact);
  await record(page, 'Recover without replacing unknown data');
  await inbox(page).getByRole('button', { name: 'Save on this device', exact: true }).click(); await expect(preview(page)).toBeVisible(); await expect(inbox(page)).toContainText(/malformed|unsupported/i); expect(await savedRows(page, name)).toHaveLength(2);
  await inbox(page).getByRole('button', { name: 'Discard recording', exact: true }).click(); await deleteClip(page, title); expect(await savedRows(page, name)).toHaveLength(1);
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('saved audio belongs to its exact workspace and mount namespace', async ({ page }) => {
  await syntheticMicrophone(page); const traffic = watchRequests(page), title = 'Current workspace recording'; await page.goto('./#audio');
  await record(page, title); await inbox(page).getByRole('button', { name: 'Save on this device', exact: true }).click(); await expect(clip(page, title)).toBeVisible();
  const base = normalizeBasePath(process.env.APP_BASE_PATH);
  const workspace = await page.evaluate(async base => (await (await fetch(`${base}api/session`)).json()).workspaceId as string, base);
  const own = audioInboxDatabaseName(workspace, base), foreignWorkspace = audioInboxDatabaseName(`${workspace}-other`, base), foreignMount = audioInboxDatabaseName(workspace, '/other-audio-mount/');
  expect(await audioDatabases(page)).toEqual([own]);
  await page.evaluate(async ({ own, foreignWorkspace, foreignMount }) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => request.result.createObjectStore('clips', { keyPath: 'id' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const source = await open(own);
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => { const transaction = source.transaction('clips'), request = transaction.objectStore('clips').getAll(); transaction.oncomplete = () => resolve(request.result[0]); transaction.onerror = () => reject(transaction.error); }); source.close();
    for (const [name, title] of [[foreignWorkspace, 'Another workspace private audio'], [foreignMount, 'Another mount private audio']]) {
      const database = await open(name!); await new Promise<void>((resolve, reject) => { const transaction = database.transaction('clips', 'readwrite'); transaction.objectStore('clips').add({ ...record, id: crypto.randomUUID(), title }); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); database.close();
    }
  }, { own, foreignWorkspace, foreignMount });
  await page.reload(); await expect(clip(page, title)).toBeVisible(); await expect(inbox(page)).not.toContainText('Another workspace private audio'); await expect(inbox(page)).not.toContainText('Another mount private audio');
  await deleteClip(page, title); expect(await savedRows(page, own)).toEqual([]); expect(await savedRows(page, foreignWorkspace)).toHaveLength(1); expect(await savedRows(page, foreignMount)).toHaveLength(1);
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});

test('password audio stays in session memory and retires on reload, logout and account switching', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const page = await context.newPage(); await syntheticMicrophone(page);
  const signOut = async (other: Page) => { await other.getByRole('button', { name: 'Sign Out', exact: true }).click(); await other.getByRole('button', { name: /sign out and clear drafts/i }).click(); await expect(other.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible(); };
  try {
    await page.goto('./#audio'); await signIn(page); const traffic = watchRequests(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
    const title = 'Private offline voice note'; await record(page, title); await inbox(page).getByRole('button', { name: 'Keep for this session', exact: true }).click(); await expect(clip(page, title)).toBeVisible(); await play(page, title);
    expect(await audioDatabases(page)).toEqual([]); expect(await page.evaluate(() => window.audioFixture.databases.filter(name => name.includes('audio-inbox')))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(title);
    await page.evaluate(() => { location.hash = '#home'; }); await expect(inbox(page)).toHaveCount(0); await page.evaluate(() => { location.hash = '#audio'; }); await expect(clip(page, title)).toBeVisible();
    const warned = page.waitForEvent('dialog'); const reloading = page.reload(); const warning = await warned; expect(warning.type()).toBe('beforeunload'); await warning.accept(); await reloading;
    await expect(page.getByRole('heading', { name: 'Workspace locked', exact: true })).toBeVisible(); await expect(inbox(page)).toHaveCount(0);
    await context.setOffline(false); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0]!.displayName); await expect(inbox(page)).toBeVisible(); await expect(clip(page, title)).toHaveCount(0);
    await record(page, 'Only Alice session audio'); await inbox(page).getByRole('button', { name: 'Keep for this session', exact: true }).click(); await expect(clip(page, 'Only Alice session audio')).toBeVisible(); await play(page, 'Only Alice session audio');
    const privateUrl = await clip(page, 'Only Alice session audio').getByLabel('Play Only Alice session audio', { exact: true }).getAttribute('src');
    await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
    const other = await context.newPage(); await other.goto('./#home'); await expect(other.locator('.signed-in-user')).toHaveText(authAccounts[0]!.displayName); await signOut(other);
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible(); await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    expect(await page.evaluate(url => window.audioFixture.revoked.includes(url!), privateUrl)).toBe(true);
    await signIn(other, 1); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[1]!.displayName); await expect(inbox(page)).toBeVisible(); await expect(inbox(page)).not.toContainText('Only Alice session audio');
    await page.evaluate(() => { window.audioFixture.permission = 'defer'; }); const recorderCount = await page.evaluate(() => window.audioFixture.recorders.length);
    await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Cancel microphone request', exact: true })).toBeVisible();
    await signOut(other); await signIn(other); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0]!.displayName);
    await page.evaluate(async () => { const fixture = window.audioFixture; fixture.pending.shift()!.resolve(await fixture.makeStream()); });
    await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true); expect(await page.evaluate(() => window.audioFixture.recorders.length)).toBe(recorderCount);
    await expect(preview(page)).toHaveCount(0); await expect(inbox(page).getByRole('article')).toHaveCount(0); expect(await audioDatabases(page)).toEqual([]); expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
  } finally { await context.setOffline(false); await context.close(); }
});

test('explicit audio capture preempts voice recognition and rejects its late callbacks', async ({ page }) => {
  await syntheticMicrophone(page);
  await page.addInitScript(() => {
    const state = { starts: 0, aborts: 0, recognizers: [] as { onresult?: (event: unknown) => void; onend?: () => void }[], staleResult: undefined as ((event: unknown) => void) | undefined, staleEnd: undefined as (() => void) | undefined };
    Object.assign(window, { audioVoice: state, SpeechRecognition: class { onresult?: (event: unknown) => void; onend?: () => void; constructor() { state.recognizers.push(this); } start() { state.starts++; } stop() {} abort() { state.aborts++; } } });
  });
  const traffic = watchRequests(page); await page.goto('./#home'); await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('open audio'); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(inbox(page)).toBeVisible();
  await page.getByLabel('I understand browser speech recognition may send audio to its provider and may require internet.', { exact: true }).check(); await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.evaluate(() => { const state = (window as unknown as { audioVoice: { recognizers: { onresult?: (event: unknown) => void; onend?: () => void }[]; staleResult?: (event: unknown) => void; staleEnd?: () => void } }).audioVoice; const current = state.recognizers.at(-1)!; state.staleResult = current.onresult; state.staleEnd = current.onend; });
  await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect(page.locator('.voice-panel')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Voice and commands', exact: true })).toBeDisabled();
  await page.evaluate(() => { const state = (window as unknown as { audioVoice: { staleEnd?: () => void; staleResult?: (event: unknown) => void } }).audioVoice; state.staleEnd?.(); state.staleResult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'open tasks' } }] }); });
  await expect(inbox(page)).toBeVisible(); expect(await page.evaluate(() => ({ starts: (window as unknown as { audioVoice: { starts: number; aborts: number } }).audioVoice.starts, aborts: (window as unknown as { audioVoice: { starts: number; aborts: number } }).audioVoice.aborts }))).toEqual({ starts: 1, aborts: 1 });
  await expect.poll(() => page.evaluate(() => window.audioFixture.chunks.some(blob => blob.size > 0))).toBe(true);
  await inbox(page).getByRole('button', { name: 'Stop recording', exact: true }).click(); await expect(preview(page)).toBeVisible(); await expect(page.getByRole('button', { name: 'Voice and commands', exact: true })).toBeEnabled(); await inbox(page).getByRole('button', { name: 'Discard recording', exact: true }).click();
  await page.evaluate(() => { window.audioFixture.permission = 'defer'; }); await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click(); await expect(page.getByRole('button', { name: 'Voice and commands', exact: true })).toBeDisabled(); await inbox(page).getByRole('button', { name: 'Cancel microphone request', exact: true }).click(); await expect(page.getByRole('button', { name: 'Voice and commands', exact: true })).toBeEnabled();
  await page.evaluate(async () => { const fixture = window.audioFixture; fixture.pending.shift()!.resolve(await fixture.makeStream()); }); await expect.poll(() => page.evaluate(() => window.audioFixture.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(traffic.writes).toEqual([]); expect(traffic.external).toEqual([]);
});
