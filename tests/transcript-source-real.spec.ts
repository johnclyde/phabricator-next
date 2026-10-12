import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { audioInboxDatabaseName } from '../client/audio-inbox';
import { normalizeBasePath } from '../shared/mount';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model';
import { parseTranscriptEditInput, transcriptSourceEdit } from '../shared/transcript-edit';
import type { RevisionDetail } from '../shared/types';

const speech = readFileSync(new URL('./fixtures/transcription/jfk.wav', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const title = 'Public speech to source fixture', clipId = 'source-speech-fixture';
const model = (page: Page) => page.getByRole('region', { name: 'Local transcription model', exact: true });
const recording = (page: Page) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/** Seed only original public audio bytes. ASR and the edited draft below use the real application. */
async function seedAudio(page: Page, baseURL: string): Promise<string> {
  const response = await page.request.get(new URL('api/session', baseURL).href);
  expect(response.ok()).toBe(true);
  const session = await response.json() as { workspaceId: string };
  const database = audioInboxDatabaseName(session.workspaceId, normalizeBasePath(new URL(baseURL).pathname));
  await page.evaluate(async ({ database, encoded, title, clipId }) => {
    const blob = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'audio/wav' });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(database, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('clips', 'readwrite');
        transaction.objectStore('clips').add({ format: 'phabricator.audio.v1', id: clipId, title, createdAt: '2026-10-12T12:00:00.000Z', mimeType: blob.type, durationMs: 11_000, bytes: blob.size, blob });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { database, encoded: speech.toString('base64'), title, clipId });
  await page.getByRole('button', { name: 'Reload audio inbox', exact: true }).click();
  await expect(recording(page)).toBeVisible();
  return database;
}

test.describe('real local transcription to immutable source', () => {
  test.skip(process.env.E2E_REAL_TRANSCRIPTION !== '1', 'Requires explicit pinned public model staging and genuine offline CPU ASR.');
  test.setTimeout(180_000);

  test('an unsaved edited ASR draft becomes one explicit exact paper replacement with local audio provenance', async ({ page, context, request, baseURL }, info) => {
    const quotation = 'Original research statement.';
    const source = `\\documentclass{article}\r\n\\begin{document}\r\n${quotation}\r\n\\end{document}\r\n`;
    const other = '@article{source,title={An unchanged reference},year={2026}}\n';
    const createdResponse = await request.post(new URL('api/revisions', baseURL!).href, { headers: { 'Idempotency-Key': randomUUID() }, data: { title: `Real spoken source edit ${info.project.name} ${Date.now()}`, kind: 'paper', testPlan: 'Verify exact original source, literal replacement, local audio provenance and explicit online confirmation.', files: [{ path: 'main.tex', content: source }, { path: 'references.bib', content: other }] } });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const originalDetail = await createdResponse.json() as RevisionDetail, id = originalDetail.revision.id, originalVersion = originalDetail.versions[0]!;
    const external: string[] = [], sourceWrites: { path: string; body: unknown; id: string | undefined }[] = [], otherWrites: string[] = [];
    context.on('request', req => {
      if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== new URL(baseURL!).origin) external.push(req.url());
      if (req.method() !== 'GET') {
        const path = new URL(req.url()).pathname;
        if (path.endsWith(`/api/revisions/${id}/transcript-edits`) || path.endsWith(`/api/revisions/${id}/versions`)) sourceWrites.push({ path, body: req.postDataJSON(), id: req.headers()['idempotency-key'] });
        else otherWrites.push(`${req.method()} ${path}`);
      }
    });
    await page.goto(`./#${id}`); await expect(page.getByRole('heading', { level: 1 })).toContainText(originalDetail.revision.title);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', source);
    await page.evaluate(() => { location.hash = '#audio'; }); await expect(model(page)).toBeVisible();
    const database = await seedAudio(page, baseURL!);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await model(page).getByRole('button', { name: 'Install model', exact: true }).click();
    await expect(model(page).getByRole('button', { name: 'Reinstall model', exact: true })).toBeEnabled({ timeout: 120_000 });
    await context.setOffline(true);
    try {
      await recording(page).getByText('Transcription', { exact: true }).click();
      await recording(page).getByRole('button', { name: 'Transcribe on this device', exact: true }).click();
      const original = recording(page).getByLabel('Original model transcript', { exact: true });
      await expect(original).toHaveValue(/fellow Americans/i, { timeout: 120_000 });
      const originalText = await original.inputValue(), runId = await recording(page).getByLabel('Transcription run', { exact: true }).inputValue();
      expect(originalText).toMatch(/ask not/i);
      const replacement = '  A corrected research claim — café 😀.\nThe literal source keeps \\cite{source} and this spacing.  ';
      await recording(page).getByLabel('Transcript draft', { exact: true }).fill(replacement);
      await expect(recording(page).getByLabel('Transcript draft', { exact: true })).toHaveValue(replacement);
      // No Save transcript: the source picker must resolve the in-tab draft's original run.
      await page.evaluate(revisionId => { location.hash = `#${revisionId}`; }, id);
      await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', source);
      await page.getByLabel('Passage start line', { exact: true }).fill('3');
      await page.getByLabel('Passage end line', { exact: true }).fill('3');
      await page.getByRole('button', { name: 'Replace line range with transcript', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Transcript source edit', exact: true });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Choose local transcript', exact: true }).click();
      await panel.getByLabel('Recording for transcript', { exact: true }).selectOption(clipId);
      await panel.getByRole('button', { name: 'Use transcript draft', exact: true }).click();
      await expect(panel.getByLabel('Transcript replacement', { exact: true })).toHaveValue(replacement);
      await panel.getByLabel('Transcript edit message', { exact: true }).fill('Apply the checked local transcript literally.');
      await expect(panel.getByRole('button', { name: 'Preview transcript edit', exact: true })).toBeDisabled();
      await expect(panel.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled();
      expect(sourceWrites).toEqual([]);
      await context.setOffline(false);
      await expect(panel.getByRole('button', { name: 'Preview transcript edit', exact: true })).toBeEnabled();
      // The fixture API context has been idle through model setup and offline
      // ASR; its keep-alive socket may have closed. Retry only ECONNRESET once
      // for this read-only probe, never source writes or HTTP/assertion failures.
      const beforeSave = await request.get(new URL(`api/revisions/${id}`, baseURL!).href, { maxRetries: 1 });
      expect(beforeSave.ok()).toBe(true);
      expect((await beforeSave.json() as RevisionDetail).revision.currentVersion).toBe(1);
      expect(sourceWrites).toEqual([]);
      expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':outbox')).some(([, value]) => value.includes('/transcript-edits')))).toBe(false);
      await panel.getByRole('button', { name: 'Preview transcript edit', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled();
      await expect(panel.locator('.suggestion-original')).toHaveJSProperty('textContent', quotation);
      await expect(panel.locator('.suggestion-replacement')).toHaveJSProperty('textContent', replacement);
      expect(sourceWrites).toEqual([]);
      await panel.screenshot({ path: info.outputPath('real-transcript-source-preview.png') });
      await panel.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
      await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
      await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', source.replace(quotation, replacement));
      expect(sourceWrites).toHaveLength(1);
      const sent = parseTranscriptEditInput(sourceWrites[0]!.body);
      expect(sourceWrites[0]!.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(sent.origin).toEqual({ kind: 'client-local-transcript', clipId, runId, audioSha256: hash(speech), audioBytes: speech.length, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', originalTextSha256: hash(originalText), editedTextSha256: hash(replacement) });
      expect(sent.replacement).toBe(replacement); expect(sent.expectedVersionId).toBe(originalVersion.id); expect(sent.expectedContentHash).toBe(originalVersion.contentHash);
      expect(sent.target.kind).toBe('text');
      if (sent.target.kind !== 'text') throw new Error('Expected text replacement');
      expect(sent.target.anchor).toMatchObject({ filePath: 'main.tex', start: source.indexOf(quotation), end: source.indexOf(quotation) + quotation.length, quote: quotation });
      const payload = JSON.stringify(sourceWrites[0]!.body);
      expect(payload).not.toContain(speech.toString('base64')); expect(payload).not.toContain(originalText);
      expect(Object.keys(sent).sort()).toEqual(['expectedAccessEpoch', 'expectedContentHash', 'expectedVersion', 'expectedVersionId', 'format', 'message', 'origin', 'replacement', 'revisionId', 'target']);
      const finalResponse = await request.get(new URL(`api/revisions/${id}`, baseURL!).href);
      expect(finalResponse.ok()).toBe(true); const final = await finalResponse.json() as RevisionDetail;
      expect(final.versions).toHaveLength(2); expect(final.versions.find(item => item.id === originalVersion.id)).toEqual(originalVersion);
      const version = final.versions.find(item => item.number === 2)!;
      expect(version.files).toEqual([{ path: 'main.tex', content: source.replace(quotation, replacement) }, { path: 'references.bib', content: other }]);
      expect(version.transcriptEdit).toEqual(transcriptSourceEdit(sent, hash(JSON.stringify(sent))));
      // Preparing/applying a source edit does not implicitly save its local transcript bundle.
      expect(await page.evaluate(async ({ database, clipId }) => new Promise<boolean>((resolve, reject) => {
        const open = indexedDB.open(database, 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('clips'), row = tx.objectStore('clips').get(clipId); row.onsuccess = () => resolve(row.result?.transcripts === undefined); row.onerror = () => reject(row.error); tx.oncomplete = () => db.close(); };
      }), { database, clipId })).toBe(true);
      expect(external).toEqual([]);
      // Opening the successfully saved revision can acknowledge its existing inbox notification.
      expect(otherWrites.every(path => path.endsWith('/api/notifications/read') && path.startsWith('POST '))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context.setOffline(false); }
  });
});
