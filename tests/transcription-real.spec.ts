import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { audioInboxDatabaseName } from '../client/audio-inbox';
import { normalizeBasePath } from '../shared/mount';

const speech = readFileSync(new URL('./fixtures/transcription/jfk.wav', import.meta.url));
const speechSha256 = createHash('sha256').update(speech).digest('hex');
const title = 'Public speech transcription fixture';
const model = (page: Page) => page.getByRole('region', { name: 'Local transcription model', exact: true });
const clip = (page: Page) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function seedClip(page: Page, baseURL: string) {
  const session = await (await page.request.get(new URL('api/session', baseURL).href)).json() as { workspaceId: string };
  const database = audioInboxDatabaseName(session.workspaceId, normalizeBasePath(new URL(baseURL).pathname));
  await page.evaluate(async ({ database, encoded, title }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'audio/wav' });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(database, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('clips', 'readwrite');
        transaction.objectStore('clips').add({ format: 'phabricator.audio.v1', id: 'public-speech-fixture', title, createdAt: '2026-10-11T12:00:00.000Z', mimeType: blob.type, durationMs: 11_000, bytes: blob.size, blob });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { database, encoded: speech.toString('base64'), title });
  await page.getByRole('button', { name: 'Reload audio inbox', exact: true }).click();
  await expect(clip(page)).toBeVisible();
}

async function install(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await model(page).getByRole('button', { name: 'Install model', exact: true }).click();
  await expect(model(page).getByRole('button', { name: 'Reinstall model', exact: true })).toBeEnabled({ timeout: 120_000 });
}

test.describe('real local transcription', () => {
  test.skip(process.env.E2E_REAL_TRANSCRIPTION !== '1', 'Set E2E_REAL_TRANSCRIPTION=1 and stage the pinned public model to run actual CPU ASR.');
  test.setTimeout(180_000);

  test('explicit installation supports genuine offline ASR after reload and immutable saved provenance', async ({ page, context, baseURL }, info) => {
    const external: string[] = [], writes: string[] = [], assets: string[] = [];
    context.on('request', request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url());
      if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
      if (/transcription-(?:worker|runtime)|transcription-model/.test(request.url())) assets.push(request.url());
    });
    await page.goto('./#audio'); await expect(model(page)).toBeVisible();
    expect(assets).toEqual([]);
    await seedClip(page, baseURL!); await install(page);
    await context.setOffline(true);
    try {
      await page.reload(); await expect(clip(page)).toBeVisible();
      await clip(page).getByText('Transcription', { exact: true }).click();
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
      const original = clip(page).getByLabel('Original model transcript', { exact: true });
      await expect(original).toHaveValue(/fellow Americans/i, { timeout: 120_000 });
      const output = await original.inputValue();
      expect(output).toMatch(/ask not/i); expect(output).toMatch(/country/i);
      await expect(clip(page)).toContainText(speechSha256);
      await page.evaluate(() => { location.hash = '#home'; });
      expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
      await page.evaluate(() => { location.hash = '#audio'; });
      await clip(page).getByText('Transcription', { exact: true }).click();
      await expect(original).toHaveValue(output);
      const draft = clip(page).getByLabel('Transcript draft', { exact: true });
      await draft.fill('Edited research note. Verify every generated word against the audio.');
      await clip(page).getByRole('button', { name: 'Save transcript', exact: true }).click();
      await expect(clip(page)).toContainText(/transcript saved|saved transcript/i);
      await page.reload(); await clip(page).getByText('Transcription', { exact: true }).click();
      await expect(original).toHaveValue(output);
      await expect(draft).toHaveValue('Edited research note. Verify every generated word against the audio.');
      await expect(clip(page)).toContainText(speechSha256);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      for (const region of [model(page), clip(page).getByRole('region', { name: `Transcription for ${title}`, exact: true })]) {
        const buttons = await region.locator('.audio-actions > button').evaluateAll(elements => elements.map(element => ({ label: element.textContent, height: element.getBoundingClientRect().height })));
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
          expect(button.height, `${button.label} remains a usable touch target`).toBeGreaterThanOrEqual(44);
          expect(button.height, `${button.label} must not inherit a horizontal flex basis as height`).toBeLessThanOrEqual(60);
        }
      }
      await clip(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('offline-transcript.png') });
      await model(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('installed-model.png') });
      await model(page).getByRole('button', { name: 'Remove model', exact: true }).click();
      await model(page).getByRole('button', { name: 'Confirm remove model', exact: true }).click();
      await expect(model(page).getByRole('button', { name: 'Install model', exact: true })).toBeEnabled();
      // Saved text remains usable without model weights, and transcription cannot silently reinstall.
      await expect(original).toHaveValue(output);
      await expect(draft).toHaveValue('Edited research note. Verify every generated word against the audio.');
      expect(external).toEqual([]); expect(writes).toEqual([]);
    } finally { await context.setOffline(false); }
  });

  test('missing cached weights fail locally and cancellation retires the real worker', async ({ page, context, baseURL }) => {
    await page.goto('./#audio'); await seedClip(page, baseURL!); await install(page);
    await clip(page).getByText('Transcription', { exact: true }).click();
    await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
    await expect(clip(page)).toContainText('Transcribing on this device…', { timeout: 120_000 });
    await expect(clip(page).getByRole('button', { name: 'Cancel transcription', exact: true })).toBeVisible();
    await clip(page).getByRole('button', { name: 'Cancel transcription', exact: true }).click();
    await expect(clip(page).getByLabel('Original model transcript', { exact: true })).toHaveCount(0);
    await page.evaluate(async () => {
      for (const key of await caches.keys()) {
        if (!key.includes('transcription')) continue;
        const cache = await caches.open(key);
        for (const request of await cache.keys()) if (request.url.endsWith('encoder_model_quantized.onnx')) await cache.delete(request);
      }
    });
    await context.setOffline(true);
    try {
      await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
      await expect(clip(page)).toContainText(/missing|incomplete|reinstall|not installed/i);
      await expect(clip(page).getByLabel('Original model transcript', { exact: true })).toHaveCount(0);
    } finally { await context.setOffline(false); }
  });

  test('clearing a saved run in another tab preserves an orphaned edited draft for offline recovery', async ({ page, context, baseURL }) => {
    await page.goto('./#audio'); await seedClip(page, baseURL!); await install(page);
    await clip(page).getByText('Transcription', { exact: true }).click();
    await clip(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
    await expect(clip(page).getByLabel('Original model transcript', { exact: true })).toHaveValue(/fellow Americans/i, { timeout: 120_000 });
    await clip(page).getByRole('button', { name: 'Save transcript', exact: true }).click();
    await expect(clip(page)).toContainText('Transcript saved on this device.');
    const edited = 'Keep this unsaved legal argument — café 😀\nIts original model run may be deleted.';
    await clip(page).getByLabel('Transcript draft', { exact: true }).fill(edited);
    const other = await context.newPage();
    try {
      await other.goto('./#audio'); await clip(other).getByText('Transcription', { exact: true }).click();
      await expect(clip(other).getByLabel('Original model transcript', { exact: true })).toHaveValue(/fellow Americans/i);
      await clip(other).getByRole('button', { name: 'Clear saved transcripts', exact: true }).click();
      await clip(other).getByRole('button', { name: 'Confirm clear transcripts', exact: true }).click();
      await expect(clip(other)).toContainText('Saved transcripts cleared.');
      await model(other).getByRole('button', { name: 'Remove model', exact: true }).click();
      await model(other).getByRole('button', { name: 'Confirm remove model', exact: true }).click();
      await expect(model(other).getByRole('button', { name: 'Install model', exact: true })).toBeEnabled();
      await page.bringToFront();
      await clip(page).getByRole('button', { name: 'Reload saved transcripts', exact: true }).click();
      const draft = clip(page).getByLabel('Transcript draft', { exact: true });
      await expect(draft).toHaveValue(edited); await expect(draft).toBeEditable();
      await expect(clip(page)).toContainText('This draft’s original model result is unavailable.');
      await expect(clip(page).getByRole('button', { name: 'Save transcript', exact: true })).toBeDisabled();
      await expect(clip(page).getByLabel('Original model transcript', { exact: true })).toHaveCount(0);
      await context.setOffline(true);
      const retained = `${edited}\nStill editable without the model.`; await draft.fill(retained);
      await page.evaluate(() => { location.hash = '#home'; }); await expect(clip(page)).toHaveCount(0);
      await page.evaluate(() => { location.hash = '#audio'; }); await clip(page).getByText('Transcription', { exact: true }).click();
      await expect(draft).toHaveValue(retained); await expect(clip(page).getByRole('button', { name: 'Save transcript', exact: true })).toBeDisabled();
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
      await clip(page).getByRole('button', { name: 'Copy transcript draft', exact: true }).click();
      await expect(clip(page)).toContainText('Transcript draft copied.'); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(retained);
      const downloading = page.waitForEvent('download'); await clip(page).getByRole('button', { name: 'Download transcript draft', exact: true }).click();
      const download = await downloading, stream = await download.createReadStream(); expect(stream).not.toBeNull();
      const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString('utf8')).toBe(retained);
    } finally { await context.setOffline(false); await other.close(); }
  });
});
