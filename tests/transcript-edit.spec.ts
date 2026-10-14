import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AppState, RevisionDetail } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { TranscriptEditInput } from '../shared/transcript-edit';
import { api, source, seedTranscript, choosePassage, chooseTranscript, replacement, originalTranscript, sha } from './transcript-edit-browser';

test('a reviewed transcript replaces the exact text passage and preserves original versions and unrelated source', async ({ page, request, baseURL }, info) => {
  const before = await source(request, baseURL!), id = before.revision.id; const writes: TranscriptEditInput[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/transcript-edits')) writes.push(req.postDataJSON() as TranscriptEditInput); });
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  await expect(page.getByLabel('Transcript replacement')).toHaveValue(replacement);
  await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('region', { name: 'Transcript source edit', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('transcript-preview.png') });
  await page.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`), sent = writes[0]!;
  expect(writes).toHaveLength(1); expect(sent.replacement).toBe(replacement);
  expect(JSON.stringify(sent)).not.toContain(originalTranscript); expect(Object.keys(sent.origin)).not.toContain('audio');
  expect(after.versions).toHaveLength(2); expect(after.versions[0]).toEqual(before.versions[0]);
  const target = sent.target; expect(target.kind).toBe('text'); if (target.kind !== 'text') throw new Error('text fixture');
  const original = before.versions[0]!.files[0]!.content;
  expect(after.versions[1]!.files[0]!.content).toBe(original.slice(0, target.anchor.start) + replacement + original.slice(target.anchor.end));
  expect(after.versions[1]!.files[1]).toEqual(before.versions[0]!.files[1]);
  expect(after.versions[1]!.transcriptEdit?.origin.originalTextSha256).toBe(sha(originalTranscript));
  expect(after.versions[1]!.transcriptEdit?.origin.editedTextSha256).toBe(sha(replacement));
  expect(after.reviews).toEqual([]); expect(after.comments).toEqual([]);
  await page.getByText('Transcript edit provenance', { exact: true }).click();
  await expect(page.getByText(/client-reported local transcription provenance/)).toBeVisible();
});

test('lost transcript receipts require an identical explicit retry and survive offline reload', async ({ page, context, request, baseURL }) => {
  const before = await source(request, baseURL!, 'document'), id = before.revision.id; const requests: { key: string | undefined; body: unknown }[] = []; let drop = true;
  let releaseHead!: () => void, releaseReceipt!: () => void, observedRetry!: () => void;
  const headGate = new Promise<void>(resolve => { releaseHead = resolve; }), receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; }), retryStarted = new Promise<void>(resolve => { observedRetry = resolve; });
  await context.route(`**/api/revisions/${id}/transcript-edits`, async route => { requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() }); const response = await route.fetch(); if (drop) { drop = false; return route.abort('failed'); } observedRetry(); await receiptGate; return route.fulfill({ response }); });
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click(); await page.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unconfirmed transcript edit', exact: true })).toBeVisible();
  await context.setOffline(true); await page.reload();
  const inspect = page.getByRole('button', { name: 'Inspect Version 1 Transcript Edit', exact: true }); await expect(inspect).toBeVisible(); await inspect.click();
  await expect(page.getByLabel('Transcript replacement')).toHaveValue(replacement);
  await expect(page.getByRole('button', { name: 'Retry exact transcript edit', exact: true })).toBeDisabled();
  // Reconnect discovers the already-created head while the exact replay receipt
  // is still pending. That refresh must retire fresh confirmation, not recovery.
  await context.route(`**/api/revisions/${id}`, async route => { await headGate; return route.continue(); });
  try {
    await context.setOffline(false); await expect(page.getByRole('button', { name: 'Retry exact transcript edit', exact: true })).toBeEnabled(); expect(requests).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry exact transcript edit', exact: true }).click(); await retryStarted; releaseHead();
    await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="2"]')).toContainText('current');
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled();
    releaseReceipt();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  } finally { releaseHead(); releaseReceipt(); }
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});

test('transcript recovery waits for reconnect authority before accepting an exact historical retry', async ({ page, context, request, baseURL }) => {
  const before = await source(request, baseURL!, 'document'), id = before.revision.id;
  const writes: { key: string | undefined; body: unknown }[] = []; let drop = true;
  await context.route(`**/api/revisions/${id}/transcript-edits`, async route => {
    writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    const response = await route.fetch();
    if (drop) { drop = false; return route.abort('failed'); }
    return route.fulfill({ response });
  });
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unconfirmed transcript edit', exact: true })).toBeVisible();
  await context.setOffline(true); await page.reload();
  await page.getByRole('button', { name: 'Inspect Version 1 Transcript Edit', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry exact transcript edit', exact: true });
  await expect(retry).toBeDisabled();
  let releaseAuthority!: () => void, observedState!: () => void;
  const authorityGate = new Promise<void>(resolve => { releaseAuthority = resolve; });
  const stateStarted = new Promise<void>(resolve => { observedState = resolve; });
  // Hold every epoch-bearing read so another panel cannot establish authority
  // ahead of the workspace state response. Session identity can still reconnect.
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && !path.endsWith('/api/session')) {
      if (path.endsWith('/api/state')) observedState();
      await authorityGate;
    }
    return route.fallback();
  });
  try {
    await context.setOffline(false); await stateStarted;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(retry).toBeDisabled(); expect(writes).toHaveLength(1);
    releaseAuthority();
    await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="2"]')).toContainText('current');
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(retry).toBeEnabled(); expect(writes).toHaveLength(1);
    await retry.click();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  } finally { releaseAuthority(); }
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});

test('a late transcript receipt cannot replace a later source selection or erase recovery', async ({ page, context, request, baseURL }) => {
  const before = await source(request, baseURL!), id = before.revision.id;
  let drop = true, release!: () => void, arrived!: () => void;
  const receiptGate = new Promise<void>(resolve => { release = resolve; }), retryStarted = new Promise<void>(resolve => { arrived = resolve; });
  await context.route(`**/api/revisions/${id}/transcript-edits`, async route => {
    const response = await route.fetch();
    if (drop) { drop = false; return route.abort('failed'); }
    arrived(); await receiptGate; return route.fulfill({ response });
  });
  try {
    await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
    await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click(); await page.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry exact transcript edit', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Retry exact transcript edit', exact: true }).click(); await retryStarted;
    await page.getByLabel('Source file', { exact: true }).selectOption('notes.md');
    await expect(page.getByRole('region', { name: 'Transcript source edit', exact: true })).toHaveCount(0);
    const received = page.waitForResponse(response => response.url().endsWith(`/revisions/${id}/transcript-edits`) && response.status() === 201);
    release(); await (await received).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('notes.md');
    await page.goto('./#home'); await page.goto(`./#${id}`);
    await page.getByRole('button', { name: 'Recover transcript edit request', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unconfirmed transcript edit', exact: true })).toBeVisible();
    await expect(page.getByLabel('Transcript replacement')).toHaveValue(replacement);
    expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
  } finally { release(); }
});

test('a changed replacement or canceled voice confirmation cannot save an earlier preview', async ({ page, request, baseURL }) => {
  const before = await source(request, baseURL!, 'code'), id = before.revision.id;
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  const command = async (text: string) => { await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click(); };
  await command('confirm transcript edit'); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1);
  await command('preview transcript edit'); await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled();
  await command('read transcript edit'); await expect(page.locator('.command-feedback')).toContainText(replacement);
  await page.getByLabel('Transcript replacement').fill('A later replacement.'); await command('confirm transcript edit');
  await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled(); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1);
  await command('preview transcript edit'); await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled(); await command('cancel transcript edit');
  await expect(page.getByLabel('Transcript replacement')).toHaveValue('A later replacement.'); await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled();
  await command('preview transcript edit'); await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled(); await command('confirm transcript edit');
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
});

test('Word transcript replacement produces a new tracked package with exact old bytes available', async ({ page, request, baseURL }, info) => {
  const bytes = readFileSync('tests/fixtures/docx/roundtrip.docx');
  const file = await api<FileRecord>(request, baseURL!, '/files', { name: 'roundtrip.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: sha(bytes) });
  const state = await api<AppState>(request, baseURL!, '/state');
  const before = await api<RevisionDetail>(request, baseURL!, '/revisions/docx', { title: 'Transcript Word argument', testPlan: 'Compare tracked package and original.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: state.accessEpoch, shareSource: false });
  const id = before.revision.id; await page.goto(`./#${id}`); await seedTranscript(page, baseURL!, 'The revised result is precise.');
  await page.getByRole('button', { name: 'Open Tracked Editor', exact: true }).click();
  const select = page.getByLabel('Editable text', { exact: true }); const option = await select.locator('option').filter({ hasText: 'The original result is clear.' }).getAttribute('value'); await select.selectOption(option!);
  await page.getByLabel('Replacement text', { exact: true }).fill('A separately retained manual draft.');
  await page.getByRole('button', { name: 'Replace with transcript', exact: true }).click(); await chooseTranscript(page);
  await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click(); await page.getByRole('button', { name: 'Save transcript edit', exact: true }).click();
  await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2');
  await expect(page.locator('.docx-reading ins').filter({ hasText: 'The revised result is precise.' })).toHaveCount(1);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(after.versions).toHaveLength(2); expect(after.versions[0]).toEqual(before.versions[0]);
  expect(after.versions[1]!.transcriptEdit?.target.kind).toBe('docx'); expect(after.versions[1]!.docx!.sha256).not.toBe(before.versions[0]!.docx!.sha256);
  const original = await request.get(new URL(`api/revisions/${id}/docx/${before.versions[0]!.id}/download`, baseURL!).href); expect(await original.body()).toEqual(bytes);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.getByLabel('Word document text').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('word-transcript-edit.png') });
  await page.getByRole('button', { name: 'Inspect Version 1 Draft', exact: true }).click(); await expect(page.getByLabel('Replacement text', { exact: true })).toHaveValue('A separately retained manual draft.');
});

test('selecting another passage in the same source retires the old confirmation without discarding its draft', async ({ page, request, baseURL }) => {
  const before = await source(request, baseURL!), id = before.revision.id; let sent = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/transcript-edits')) sent++; });
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  await page.getByRole('button', { name: 'Preview transcript edit', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeEnabled();
  await page.getByLabel('Passage start line', { exact: true }).fill('3'); await page.getByLabel('Passage end line', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Replace line range with transcript', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save transcript edit', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Transcript replacement')).toHaveValue(replacement);
  await expect(page.getByText('This retained draft targets another passage in this version. It has not been overwritten.')).toBeVisible();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Workspace command', { exact: true }).fill('confirm transcript edit'); await page.getByRole('button', { name: 'Run', exact: true }).click();
  expect(sent).toBe(0); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1);
});

test('competing tabs retain their separate transcript drafts across navigation', async ({ page, context, request, baseURL }) => {
  const before = await source(request, baseURL!), id = before.revision.id;
  await page.goto(`./#${id}`); await seedTranscript(page, baseURL!); await choosePassage(page); await chooseTranscript(page);
  const other = await context.newPage();
  try {
    await other.goto(`./#${id}`); await other.getByRole('button', { name: 'Inspect Version 1 Transcript Edit', exact: true }).click();
    await expect(other.getByLabel('Transcript replacement')).toHaveValue(replacement);
    await page.getByLabel('Transcript replacement').fill('Tab A exact retained words 😀.');
    await other.getByLabel('Transcript replacement').fill('Tab B independently retained words.');
    for (const [editor, expected] of [[page, 'Tab A exact retained words 😀.'], [other, 'Tab B independently retained words.']] as const) {
      await editor.goto('./#home'); await editor.goto(`./#${id}`); await editor.getByRole('button', { name: 'Inspect Version 1 Transcript Edit', exact: true }).click();
      await expect(editor.getByLabel('Transcript replacement')).toHaveValue(expected);
      const downloaded = editor.waitForEvent('download'); await editor.getByRole('button', { name: 'Export transcript edit draft', exact: true }).click();
      const stream = await (await downloaded).createReadStream(); let data = ''; for await (const chunk of stream!) data += String(chunk);
      expect(JSON.parse(data).replacement).toBe(expected);
    }
    expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1);
  } finally { await other.close(); }
});
