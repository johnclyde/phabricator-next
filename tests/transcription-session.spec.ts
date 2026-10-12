import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const speech = readFileSync(new URL('./fixtures/transcription/jfk.wav', import.meta.url));
const speechSha256 = createHash('sha256').update(speech).digest('hex');
const title = 'Private session speech fixture';
const privateDraft = 'Private-session-only edited transcript 478d7b96';
const inbox = (page: Page) => page.getByRole('region', { name: 'Audio inbox', exact: true });
const model = (page: Page) => page.getByRole('region', { name: 'Local transcription model', exact: true });
const clip = (page: Page) => inbox(page).getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/** Delivers public fixture bytes through recorder UI. This is a fixture codec, not a claim to test physical recording. */
async function fixtureRecorder(page: Page) {
  await page.addInitScript(encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const state = { workers: [] as { worker: Worker; runId: string; callback: ((event: MessageEvent) => void) | null; terminated: boolean }[] };
    Object.assign(window, { transcriptionSessionFixture: state });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const context = new AudioContext(), destination = context.createMediaStreamDestination();
      for (const track of destination.stream.getTracks()) { const stop = track.stop.bind(track); let stopped = false; track.stop = () => { stop(); if (!stopped) { stopped = true; void context.close().catch(() => {}); } }; }
      return destination.stream;
    } });
    class FixtureRecorder {
      static isTypeSupported() { return false; }
      mimeType = 'audio/wav'; state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.(new BlobEvent('dataavailable', { data: new Blob([bytes], { type: this.mimeType }) })); this.onstop?.(new Event('stop')); }, 0); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FixtureRecorder });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private observed: (typeof state.workers)[number];
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.observed = { worker: this, runId: '', callback: null, terminated: false }; state.workers.push(this.observed); }
      postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        if (message && typeof message === 'object' && 'runId' in message) { this.observed.runId = String(message.runId); this.observed.callback = this.onmessage; }
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
      terminate() { this.observed.terminated = true; super.terminate(); }
    };
  }, speech.toString('base64'));
}
async function signIn(page: Page, account = 0) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[account]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[account]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[account]!.displayName);
}
async function record(page: Page) {
  await inbox(page).getByRole('button', { name: 'Record audio', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await inbox(page).getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByLabel('Recorded audio preview', { exact: true })).toBeVisible();
  await page.getByLabel('Recording title', { exact: true }).fill(title);
  await inbox(page).getByRole('button', { name: 'Keep for this session', exact: true }).click(); await expect(clip(page)).toBeVisible();
  await clip(page).getByText('Transcription', { exact: true }).click();
}
async function privateStorageAbsent(page: Page) {
  const data = await page.evaluate(async ({ title, privateDraft, speechSha256 }) => {
    const names = (await indexedDB.databases()).map(value => value.name || '');
    const serialized = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    const leaks: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request); if (!response) continue;
        const bytes = await response.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest === speechSha256 || request.url.includes('audio-inbox') || request.url.includes('local-transcript')) leaks.push(request.url);
        if (/text|json|javascript/.test(response.headers.get('content-type') || '')) { const text = new TextDecoder().decode(bytes); if ([title, privateDraft, speechSha256].some(value => text.includes(value))) leaks.push(request.url); }
      }
    }
    return { names, serialized, leaks };
  }, { title, privateDraft, speechSha256 });
  expect(data.names.filter(name => name.includes('audio-inbox'))).toEqual([]);
  for (const value of [title, privateDraft, speechSha256]) expect(data.serialized).not.toContain(value);
  expect(data.leaks).toEqual([]);
}
async function staleCompletion(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as { transcriptionSessionFixture: { workers: { runId: string; callback: ((event: MessageEvent) => void) | null }[] } }).transcriptionSessionFixture;
    for (const worker of state.workers) worker.callback?.({ data: { kind: 'complete', runId: worker.runId, text: 'Late private transcript must never appear' } } as MessageEvent);
  });
}
async function liveWorker(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { transcriptionSessionFixture: { workers: { terminated: boolean }[] } }).transcriptionSessionFixture.workers.some(worker => !worker.terminated))).toBe(true);
}
async function allWorkersRetired(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { transcriptionSessionFixture: { workers: { terminated: boolean }[] } }).transcriptionSessionFixture.workers.every(worker => worker.terminated))).toBe(true);
}

test.describe('password local transcription boundary', () => {
  test.skip(process.env.E2E_REAL_TRANSCRIPTION !== '1', 'Requires explicit public model staging and genuine CPU inference.');
  test.setTimeout(240_000);
  test('actual ASR and edited text remain in the active session; cancellation, pagehide and lock retire pending results', async ({ browser }, info) => {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
    const page = await context.newPage(); await fixtureRecorder(page);
    const external: string[] = [], privateWrites: string[] = [];
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== 'http://127.0.0.1:4312') external.push(request.url()); if (request.method() !== 'GET' && !/\/api\/(?:login|logout)$/.test(new URL(request.url()).pathname)) privateWrites.push(request.url()); });
    try {
      await page.goto('./#audio'); await signIn(page); await record(page);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      await model(page).getByRole('button', { name: 'Install model', exact: true }).click(); await expect(clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true })).toBeEnabled({ timeout: 120_000 });
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
      const original = clip(page).getByLabel('Original model transcript', { exact: true });
      await expect(original).toHaveValue(/fellow Americans/i, { timeout: 120_000 }); await expect(clip(page)).toContainText(speechSha256);
      const generated = await original.inputValue();
      await clip(page).getByLabel('Transcript draft', { exact: true }).fill(privateDraft);
      await clip(page).getByRole('button', { name: 'Save transcript', exact: true }).click();
      await expect(clip(page)).toContainText(/transcript kept in this session/i); await privateStorageAbsent(page);
      await page.evaluate(() => { location.hash = '#home'; }); await expect(inbox(page)).toHaveCount(0); await page.evaluate(() => { location.hash = '#audio'; });
      await clip(page).getByText('Transcription', { exact: true }).click(); await expect(original).toHaveValue(generated); await expect(clip(page).getByLabel('Transcript draft', { exact: true })).toHaveValue(privateDraft);
      // SessionGate deliberately locks password workspaces on pagehide, including BFCache transitions.
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click(); await expect(clip(page).getByRole('button', { name: 'Cancel transcription', exact: true })).toBeVisible();
      await liveWorker(page); await clip(page).getByRole('button', { name: 'Cancel transcription', exact: true }).click(); await allWorkersRetired(page); await staleCompletion(page); await expect(original).toHaveValue(generated);
      await clip(page).getByLabel('Transcript draft', { exact: true }).fill(`${privateDraft} UNSAVED`);
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
      await liveWorker(page);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await allWorkersRetired(page); await staleCompletion(page); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0]!.displayName); await expect(inbox(page).getByRole('article')).toHaveCount(0);
      await expect(page.getByText('Late private transcript must never appear', { exact: false })).toHaveCount(0);
      await privateStorageAbsent(page);
      await record(page); await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click(); await expect(original).toHaveValue(/fellow Americans/i, { timeout: 120_000 });
      await clip(page).getByLabel('Transcript draft', { exact: true }).fill(privateDraft); await clip(page).getByRole('button', { name: 'Save transcript', exact: true }).click(); await expect(clip(page)).toContainText(/transcript kept in this session/i);
      // A real reload creates a new workspace session: even explicitly retained originals are gone.
      page.once('dialog', dialog => { void dialog.accept(); }); await page.reload();
      await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0]!.displayName); await expect(inbox(page).getByRole('article')).toHaveCount(0);
      await privateStorageAbsent(page); await record(page);
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click(); await expect(clip(page).getByRole('button', { name: 'Cancel transcription', exact: true })).toBeVisible();
      await liveWorker(page);
      await page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await page.getByRole('button', { name: /sign out and clear drafts/i }).click();
      await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible(); await allWorkersRetired(page); await staleCompletion(page); await signIn(page, 1);
      await expect(inbox(page).getByRole('article')).toHaveCount(0); await expect(page.getByText('Late private transcript must never appear', { exact: false })).toHaveCount(0); await privateStorageAbsent(page);
      expect(external).toEqual([]); expect(privateWrites).toEqual([]);
    } finally { await context.close(); }
  });
});
