import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { audioInboxDatabaseName } from '../client/audio-inbox';
import { normalizeBasePath } from '../shared/mount';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model';
import type { AudioTranscriptBundle } from '../client/audio-transcripts';
import type { RevisionDetail } from '../shared/types';

export const originalTranscript = 'Static test-only stored transcript; no speech model was run for this fixture.';
export const replacement = 'A corrected argument — café 😀.\\cite{smith2026}';
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href;
  const response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
export async function source(request: APIRequestContext, baseURL: string, kind: 'paper' | 'document' | 'code' = 'paper') {
  return api<RevisionDetail>(request, baseURL, '/revisions', { kind, title: 'Exact transcript source edit', testPlan: 'Verify source and every unchanged file.', files: [{ path: 'argument.tex', content: 'First line\nOriginal argument.\nLast line\n' }, { path: 'notes.md', content: 'Unchanged side file.\r\n' }] });
}
export async function seedTranscript(page: Page, baseURL: string, text = replacement) {
  const speech = readFileSync(new URL('./fixtures/transcription/jfk.wav', import.meta.url));
  const session = await (await page.request.get(new URL('api/session', baseURL).href)).json() as { workspaceId: string };
  const database = audioInboxDatabaseName(session.workspaceId, normalizeBasePath(new URL(baseURL).pathname));
  const timestamp = '2026-10-12T12:00:00.000Z';
  const transcripts: AudioTranscriptBundle = { format: 'phabricator.audio-transcripts.v1', version: 1, runs: [{ format: 'phabricator.local-transcript.v1', runId: 'test-run', clipId: 'test-transcript-clip', audioSha256: sha(speech), audioBytes: speech.length, mimeType: 'audio/wav', createdAt: timestamp, completedAt: timestamp, decodedDurationMs: 11000, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', device: 'wasm', dtype: 'q8', language: 'en', options: { sampleRate: 16000, chunkLengthS: 30, strideLengthS: 5 }, text: originalTranscript }], draft: { runId: 'test-run', text, updatedAt: timestamp } };
  await page.evaluate(async ({ database, bytes, transcripts, timestamp }) => {
    const blob = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: 'audio/wav' });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(database, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('clips', 'readwrite'); tx.objectStore('clips').put({ format: 'phabricator.audio.v1', id: 'test-transcript-clip', title: 'Stored transcript test fixture', createdAt: timestamp, mimeType: blob.type, durationMs: 11000, bytes: blob.size, blob, transcripts }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
    });
  }, { database, bytes: speech.toString('base64'), transcripts, timestamp });
}
export async function choosePassage(page: Page) {
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Passage start line', { exact: true }).fill('2');
  await page.getByLabel('Passage end line', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Replace line range with transcript', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Transcript source edit', exact: true })).toBeVisible();
}
export async function chooseTranscript(page: Page) {
  await page.getByRole('button', { name: 'Choose local transcript', exact: true }).click();
  await page.getByLabel('Recording for transcript', { exact: true }).selectOption('test-transcript-clip');
  await page.getByRole('button', { name: 'Use transcript draft', exact: true }).click();
  await expect(page.getByLabel('Transcript replacement', { exact: true })).not.toHaveValue('');
  await page.getByLabel('Transcript edit message', { exact: true }).fill('Clarify the argument using the reviewed transcript.');
}
