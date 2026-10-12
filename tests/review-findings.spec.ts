import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, ReviewRun, SourceFile } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { normalizeBasePath } from '../shared/mount';
import { notificationInput } from '../shared/notifications';
import { authAccounts } from './auth-fixture';

type Call = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
const originalFiles: SourceFile[] = [
  { path: 'argument.txt', content: 'Original first line.\nTODO alpha evidence.\n' },
  { path: 'removed.txt', content: 'TODO beta evidence.\n<<<<<<< unresolved\nOriginal supporting source.\n' },
  { path: 'motion.txt', content: '[authority needed]\n' },
];
const laterFiles: SourceFile[] = [{ path: 'argument.txt', content: 'Current replacement.\n' }, { path: 'new.txt', content: 'TODO latest evidence.\n' }];
const region = (page: Page) => page.getByRole('region', { name: 'Review findings', exact: true });
const selected = (page: Page) => region(page).locator('article.finding[aria-current="true"]');
const runPicker = (page: Page) => page.getByLabel('Review run', { exact: true });

function localApi(request: APIRequestContext, baseURL: string): Call {
  return async <T,>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await request.fetch(new URL(`api${path}`, baseURL).href, { method, ...(body === undefined ? {} : { data: body }), headers: { 'Idempotency-Key': randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
  };
}
function authenticatedApi(page: Page): Call {
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
  return async <T,>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => page.evaluate(async ({ path, body, method, basePath }) => {
    const session = await (await fetch(`${basePath}api/session`)).json();
    const response = await fetch(`${basePath}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, body, method, basePath }) as Promise<T>;
}
async function create(api: Call, repositoryId?: string) {
  return api<RevisionDetail>('/revisions', { title: 'Exact recorded finding evidence', kind: 'document', testPlan: 'Inspect findings against their immutable original source.', files: originalFiles, access: { spaceId: 'S1', view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } }, ...(repositoryId ? { repositoryId } : {}) });
}
async function record(api: Call, id: string, expectedVersion: number) {
  return api<ReviewRun>(`/revisions/${id}/reviews`, { provider: 'local', expectedVersion });
}
async function fixture(api: Call) {
  const first = await create(api), id = first.revision.id;
  const oldRun = await record(api, id, 1), sameVersionRun = await record(api, id, 1);
  expect(oldRun.findings.map(item => [item.filePath, item.line, item.severity])).toEqual([
    ['argument.txt', 2, 'warning'], ['removed.txt', 1, 'warning'], ['removed.txt', 2, 'error'], ['motion.txt', 1, 'warning'],
  ]);
  expect(oldRun.findings[0]!.id).toBe(sameVersionRun.findings[0]!.id);
  await api(`/revisions/${id}/versions`, { expectedVersion: 1, message: 'Replace original files', files: laterFiles });
  const currentRun = await record(api, id, 2), detail = await api<RevisionDetail>(`/revisions/${id}`);
  return { api, id, detail, oldRun, sameVersionRun, currentRun, first: first.versions[0]!, second: detail.versions[1]! };
}
async function openFindings(page: Page) {
  await page.getByRole('button', { name: /^Review evidence/ }).click(); await expect(region(page)).toBeVisible();
}
async function chooseRun(page: Page, run: ReviewRun) { await runPicker(page).selectOption(`recorded:${run.id}`); }
async function bodyKey(page: Page, key: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.getSelection()?.removeAllRanges(); }); await page.keyboard.press(key);
}
function readOnly(writes: Request[], id: string) {
  for (const write of writes) {
    expect(write.method()).toBe('POST'); expect(write.url()).toMatch(/\/api\/notifications\/read$/);
    expect(notificationInput(write.postDataJSON())).toMatchObject({ action: 'read_object', objectId: id });
  }
}
async function mockSpeech(page: Page) {
  await page.addInitScript(() => {
    const state = { active: '', texts: [] as string[], utterances: [] as { onend?: () => void }[], recognizers: [] as { onresult?: (event: unknown) => void }[] };
    Object.assign(window, { findingSpeech: state, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } }, SpeechRecognition: class { constructor() { state.recognizers.push(this); } onresult?: (event: unknown) => void; start() {} abort() {} stop() {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {}, cancel() { state.active = ''; }, speak(utterance: { text: string; onend?: () => void }) { state.active = utterance.text; state.texts.push(utterance.text); state.utterances.push(utterance); } } });
  });
}
const speech = (page: Page) => page.evaluate(() => (window as unknown as { findingSpeech: { active: string } }).findingSpeech.active);
async function openVoice(page: Page) {
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
}
async function command(page: Page, text: string) {
  await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function signIn(page: Page, index = 0) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}
async function restrict(api: Call, id: string, principalId: string) {
  const policy = (await api<ObjectAccess>(`/policies/${id}`)).policy;
  return api(`/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [principalId] }, edit: { kind: 'principals', principalIds: [principalId] }, interact: { kind: 'principals', principalIds: [principalId] } }, 'PUT');
}

test('recorded findings select exact historical runs and source without following a new run or head', async ({ page, request, baseURL }, info) => {
  const data = await fixture(localApi(request, baseURL!));
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.goto(`./#${data.id}`); await openFindings(page);
  await expect(runPicker(page)).toHaveValue(`recorded:${data.currentRun.id}`);
  await chooseRun(page, data.oldRun); await region(page).getByRole('button', { name: 'Select finding 2', exact: true }).click();
  await expect(selected(page)).toContainText('removed.txt:1');
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect(region(page)).toContainText(/Local deterministic checks/i);
  await region(page).getByRole('button', { name: 'Open original finding source', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('removed.txt');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(originalFiles[1]!.content);
  await expect(page.locator('.passage-line-numbers > .selected-line')).toHaveText('1');
  await expect(page.getByLabel('Source passage text', { exact: true })).toBeFocused();
  const sourcePicker = page.getByLabel('Source file', { exact: true });
  await sourcePicker.selectOption('argument.txt'); await runPicker(page).focus(); await sourcePicker.selectOption('removed.txt');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(runPicker(page)).toBeFocused();
  await expect(region(page)).toBeVisible(); await expect(page.locator('.comment-target')).toHaveCount(0);
  const extra = await record(data.api, data.id, 2);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(runPicker(page).locator(`option[value="recorded:${extra.id}"]`)).toHaveCount(1);
  await expect(runPicker(page)).toHaveValue(`recorded:${data.oldRun.id}`);
  await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[1]!.id);
  await data.api(`/revisions/${data.id}/versions`, { expectedVersion: 2, message: 'A later clean source', files: [{ path: 'replacement.txt', content: 'Clean later source.\n' }] });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="3"]')).toHaveCount(1);
  await expect(runPicker(page)).toHaveValue(`recorded:${data.oldRun.id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(originalFiles[1]!.content);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') for (const name of ['Previous finding', 'Next finding', 'Open original finding source']) expect((await region(page).getByRole('button', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await region(page).screenshot({ path: info.outputPath('review-findings-historical.png') });
  const after = await data.api<RevisionDetail>(`/revisions/${data.id}`);
  expect(after.reviews.find(run => run.id === data.oldRun.id)).toEqual(data.oldRun); expect(after.comments).toEqual([]);
  expect(after.versions.slice(0, 2)).toEqual(data.detail.versions); readOnly(writes, data.id);
});

test('finding keyboard and local narration share a cursor without changing comparison, comments or review evidence', async ({ page, request, baseURL }) => {
  await mockSpeech(page); const data = await fixture(localApi(request, baseURL!));
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.goto(`./#${data.id}`); await openFindings(page); await chooseRun(page, data.oldRun);
  await bodyKey(page, 'p'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[0]!.id);
  await bodyKey(page, 'n'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[1]!.id);
  await bodyKey(page, 'n'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[2]!.id);
  await bodyKey(page, 'p'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[1]!.id);
  await region(page).getByRole('button', { name: 'Select finding 1', exact: true }).click();
  await openVoice(page); await command(page, 'read current finding');
  expect(await speech(page)).toContain('Unfinished work'); expect(await speech(page)).toContain('argument.txt'); expect(await speech(page)).toMatch(/version 1/i); expect(await speech(page)).toMatch(/deterministic|local checks/i);
  await page.getByLabel('Workspace command', { exact: true }).fill('n'); await page.getByLabel('Workspace command', { exact: true }).press('n');
  await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[0]!.id);
  await command(page, 'next finding'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[1]!.id); expect(await speech(page)).toContain('removed.txt');
  await command(page, 'next finding and accept it'); await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[1]!.id);
  await region(page).getByRole('button', { name: 'Next finding', exact: true }).click(); await expect.poll(() => speech(page)).toBe('');
  await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[2]!.id);
  await command(page, 'read findings'); expect(await speech(page)).toMatch(/4 findings|findings: 4/i);
  await command(page, 'read current finding'); expect(await speech(page)).toContain('Unresolved merge marker');
  await chooseRun(page, data.sameVersionRun); await expect.poll(() => speech(page)).toBe('');
  await page.evaluate(() => (window as unknown as { findingSpeech: { utterances: { onend?: () => void }[] } }).findingSpeech.utterances.forEach(item => item.onend?.()));
  expect(await speech(page)).toBe('');
  await command(page, 'read current finding'); expect(await speech(page)).toContain('argument.txt');
  await page.getByLabel('I understand browser speech recognition may send audio to its provider and may require internet.', { exact: true }).check();
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { findingSpeech: { utterances: { onend?: () => void }[]; recognizers: { onresult?: (event: unknown) => void }[] } }).findingSpeech;
    const recognition = state.recognizers.at(-1)!;
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next finding' } }] });
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next finding' } }] });
  });
  await expect(selected(page)).toHaveAttribute('data-finding-id', data.sameVersionRun.findings[2]!.id);
  await expect.poll(() => speech(page)).toContain('Unresolved merge marker');
  await region(page).getByRole('button', { name: 'Select finding 1', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { findingSpeech: { utterances: { onend?: () => void }[]; recognizers: { onresult?: (event: unknown) => void }[] } }).findingSpeech;
    const recognition = state.recognizers.at(-1)!;
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next file' } }] });
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next finding' } }] });
  });
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('new.txt');
  await expect(selected(page)).toHaveAttribute('data-finding-id', data.sameVersionRun.findings[1]!.id);
  await expect.poll(() => speech(page)).toContain('removed.txt');
  const mixedSpeech = await page.evaluate(() => {
    const state = (window as unknown as { findingSpeech: { texts: string[]; utterances: { onend?: () => void }[]; recognizers: { onresult?: (event: unknown) => void }[] } }).findingSpeech;
    const recognition = state.recognizers.at(-1)!, start = state.texts.length;
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'open original finding source' } }] });
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'read current change' } }] });
    return state.texts.slice(start);
  });
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(originalFiles[1]!.content);
  expect(mixedSpeech.at(-1)).toMatch(/original finding source is opening.*finish loading/i);
  expect(mixedSpeech.join(' ')).not.toContain('TODO latest evidence');
  expect(mixedSpeech.join(' ')).not.toContain('file new.txt');
  await page.getByRole('button', { name: 'Stop Listening', exact: true }).click(); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'read current change'); expect(await speech(page)).toContain('file removed.txt'); expect(await speech(page)).toContain('version 1 to version 1');
  await command(page, 'open original finding source'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(originalFiles[1]!.content);
  await expect(page.locator('.comment-target')).toHaveCount(0);
  await page.getByRole('button', { name: /^Discussion/ }).click(); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'next finding'); await expect(page.locator('.command-feedback')).toContainText(/Review evidence|findings/i);
  const after = await data.api<RevisionDetail>(`/revisions/${data.id}`); expect(after.reviews).toEqual(data.detail.reviews); expect(after.comments).toEqual([]); expect(after.versions).toEqual(data.detail.versions); readOnly(writes, data.id);
});

test('recorded finding pins survive offline reopening and corrupt pins require explicit recovery', async ({ page, request, baseURL, context }) => {
  const data = await fixture(localApi(request, baseURL!)); await page.goto(`./#${data.id}`); await openFindings(page); await chooseRun(page, data.oldRun);
  await region(page).getByRole('button', { name: 'Select finding 3', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try {
    await page.reload(); await openFindings(page); await expect(runPicker(page)).toHaveValue(`recorded:${data.oldRun.id}`);
    await expect(selected(page)).toHaveAttribute('data-finding-id', data.oldRun.findings[2]!.id);
    await region(page).getByRole('button', { name: 'Open original finding source', exact: true }).click();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(originalFiles[1]!.content);
  } finally { await context.setOffline(false); }
  await page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:review-findings:${id}`)); if (!key) throw new Error('Expected recorded finding pin.');
    const selection = JSON.parse(localStorage.getItem(key)!); selection.review.contentHash = '0'.repeat(64); localStorage.setItem(key, JSON.stringify(selection));
  }, data.id);
  await page.reload(); await openFindings(page); await expect(region(page)).toContainText(/unavailable|does not match|invalid|mismatch/i);
  await expect(region(page).locator('article.finding')).toHaveCount(0);
  await region(page).getByRole('button', { name: 'Choose review for inspected version', exact: true }).click();
  await expect(runPicker(page)).toHaveValue(`recorded:${data.sameVersionRun.id}`);
  await expect(region(page)).toContainText('Unresolved merge marker');
});

test('on-device checks remain unrecorded and transient while empty recorded runs remain selectable', async ({ page, request, baseURL, context }, info) => {
  const data = await fixture(localApi(request, baseURL!)); await page.goto(`./#${data.id}`); await openFindings(page); await chooseRun(page, data.oldRun);
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try {
    await page.getByRole('button', { name: 'Run Local Checks', exact: true }).click();
    await expect(runPicker(page)).toHaveValue(`recorded:${data.oldRun.id}`);
    const transient = runPicker(page).locator('option[value^="on-device:"]'); await expect(transient).toHaveCount(1);
    await region(page).getByRole('button', { name: 'View new on-device checks', exact: true }).click();
    await expect(runPicker(page)).toHaveValue((await transient.getAttribute('value'))!);
    await expect(region(page)).toContainText(/not recorded|on.device/i); await expect(region(page)).toContainText('new.txt');
    await region(page).screenshot({ path: info.outputPath('review-findings-on-device.png') });
    const pin = await page.evaluate(id => { const key = Object.keys(localStorage).find(key => key.endsWith(`:review-findings:${id}`)); return key ? localStorage.getItem(key)! : ''; }, data.id);
    expect(pin).toContain('on-device'); expect(pin).not.toContain('TODO latest evidence'); expect(pin).not.toContain('Unfinished work');
    await page.reload(); await openFindings(page); await expect(region(page)).toContainText(/unavailable|not available|no longer/i); await expect(region(page).locator('article.finding')).toHaveCount(0);
  } finally { await context.setOffline(false); }
  expect((await data.api<RevisionDetail>(`/revisions/${data.id}`)).reviews).toEqual(data.detail.reviews); readOnly(writes, data.id);
  await data.api(`/revisions/${data.id}/versions`, { expectedVersion: 2, message: 'A clean recorded result', files: [{ path: 'clean.txt', content: 'A complete plain statement.\n' }] });
  const clean = await record(data.api, data.id, 3); expect(clean.findings).toEqual([]);
  let releaseState!: () => void, releaseDetail!: () => void, captured!: () => void, reads = 0;
  const stateHeld = new Promise<void>(resolve => { releaseState = resolve; }), detailHeld = new Promise<void>(resolve => { releaseDetail = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/state', async route => { await stateHeld; await route.continue(); });
  await page.route(`**/api/revisions/${data.id}`, async route => {
    reads++;
    if (reads > 1) { await route.continue(); return; }
    const response = await route.fetch(); captured(); await detailHeld; await route.fulfill({ response });
  });
  try {
    await page.reload(); await reached; await openFindings(page); releaseState();
    await expect(runPicker(page).locator(`option[value="recorded:${clean.id}"]`)).toHaveCount(1);
    // A fresh authorized read must recover; independent head synchronization can also read.
    expect(reads).toBeGreaterThanOrEqual(2);
    await expect(runPicker(page)).toHaveValue(/on-device:/);
    await expect(region(page)).toContainText(/on-device result is unavailable/i);
  } finally { releaseState(); releaseDetail(); await page.unrouteAll({ behavior: 'wait' }); }
  await chooseRun(page, clean);
  await expect(region(page)).toContainText('No findings were recorded in this review.');
  await region(page).getByRole('button', { name: 'Next finding', exact: true }).click(); await expect(selected(page)).toHaveCount(0);
  await expect(region(page).getByRole('button', { name: 'Open original finding source', exact: true })).toBeDisabled();
});

test('stored AI provenance is displayed without running either model provider', async ({ page }) => {
  test.skip(process.env.E2E_FINDING_FIXTURE !== '1', 'Requires an explicit disposable stored-provenance fixture, never a live provider.');
  const fixture = JSON.parse(await readFile('.data/e2e-finding-fixture.json', 'utf8')) as { revisionId: string; hostedReviewId: string; localReviewId: string };
  const writes: Request[] = [], external: string[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); if (/^https?:/.test(row.url()) && new URL(row.url()).hostname !== '127.0.0.1') external.push(row.url()); });
  await mockSpeech(page); await page.goto(`./#${fixture.revisionId}`); await openFindings(page); await openVoice(page);
  await runPicker(page).selectOption(`recorded:${fixture.hostedReviewId}`);
  await expect(region(page)).toContainText('Hosted AI review'); await expect(region(page)).toContainText('test-only-hosted-model'); await expect(region(page)).toContainText('No hosted model was called.');
  await command(page, 'read current finding'); expect(await speech(page)).toContain('test-only-hosted-model'); expect(await speech(page)).toMatch(/hosted AI/i);
  await runPicker(page).selectOption(`recorded:${fixture.localReviewId}`); await expect.poll(() => speech(page)).toBe('');
  await expect(region(page)).toContainText('Local AI review'); await expect(region(page)).toContainText('test-only-local-model');
  await command(page, 'read current finding'); expect(await speech(page)).toContain('test-only-local-model'); expect(await speech(page)).toMatch(/local AI/i); expect(await speech(page)).not.toContain('hosted provenance');
  await expect(page.getByRole('button', { name: 'Request Hosted AI Review', exact: true })).toBeDisabled(); expect(external).toEqual([]); readOnly(writes, fixture.revisionId);
});

test('a stored finding with an unavailable source location never jumps to another file or line', async ({ page, request, baseURL }) => {
  const data = await fixture(localApi(request, baseURL!));
  // Deliberately corrupt returned legacy evidence, not the immutable server data.
  await page.route(`**/api/revisions/${data.id}`, async route => {
    const response = await route.fetch(), detail = await response.json() as RevisionDetail;
    detail.reviews.find(run => run.id === data.oldRun.id)!.findings[0]!.filePath = 'missing-original.txt';
    detail.reviews.find(run => run.id === data.sameVersionRun.id)!.findings[0]!.line = 0;
    await route.fulfill({ response, json: detail });
  });
  await page.goto(`./#${data.id}`); await openFindings(page);
  for (const run of [data.oldRun, data.sameVersionRun]) {
    await chooseRun(page, run); await expect(selected(page)).toContainText('Unfinished work');
    await expect(region(page)).toContainText(/unavailable|missing|outside|invalid|absent|no valid/i);
    await expect(region(page).getByRole('button', { name: 'Open original finding source', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('argument.txt');
  }
  expect((await data.api<RevisionDetail>(`/revisions/${data.id}`)).reviews).toEqual(data.detail.reviews);
});

test('bounded finding pages retain every recorded result and cursor at the page boundary', async ({ page, request, baseURL }) => {
  const api = localApi(request, baseURL!);
  const content = Array.from({ length: 31 }, (_, index) => `TODO exact finding ${index + 1}.`).join('\n');
  const detail = await api<RevisionDetail>('/revisions', { title: 'Many exact deterministic findings', kind: 'document', testPlan: 'Verify bounded navigation without dropping results.', files: [{ path: 'many.txt', content }] });
  const id = detail.revision.id, run = await record(api, id, 1); expect(run.findings).toHaveLength(31);
  await page.goto(`./#${id}`); await openFindings(page);
  await expect(region(page).locator('article.finding')).toHaveCount(25);
  await region(page).getByRole('button', { name: 'Select finding 25', exact: true }).click();
  await region(page).getByRole('button', { name: 'Next finding', exact: true }).click();
  await expect(selected(page)).toHaveAttribute('data-finding-id', run.findings[25]!.id);
  await expect(selected(page)).toContainText('many.txt:26'); await expect(region(page).locator('article.finding')).toHaveCount(6);
  await region(page).getByRole('button', { name: 'Select finding 31', exact: true }).click();
  await region(page).getByRole('button', { name: 'Next finding', exact: true }).click(); await expect(region(page)).toContainText('At the end of this review.');
  await bodyKey(page, 'n'); await expect(selected(page)).toHaveAttribute('data-finding-id', run.findings[30]!.id);
  await page.reload(); await openFindings(page); await expect(selected(page)).toHaveAttribute('data-finding-id', run.findings[30]!.id);
  await region(page).getByRole('button', { name: 'Open original finding source', exact: true }).click();
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(content);
  expect((await api<RevisionDetail>(`/revisions/${id}`)).reviews[0]).toEqual(run);
});

test('current object and repository source revocation retire finding text, location and queued speech', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch })));
  try {
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage())); await mockSpeech(bob!);
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await signIn(page, index); }
    const api = authenticatedApi(alice!), actor = (await api<AppState>('/state')).currentPrincipalId;
    const repository = await api<{ id: string }>('/repositories', { name: 'Finding source policy fixture', remoteUrl: 'https://example.invalid/finding-fixture.git', defaultBranch: 'main', description: 'Disposable source access ceiling.' });
    for (const source of [false, true]) {
      const detail = await create(api, source ? repository.id : undefined), id = detail.revision.id, run = await record(api, id, 1);
      await bob!.goto(`./#${id}`); await openFindings(bob!); await chooseRun(bob!, run); await openVoice(bob!); await command(bob!, 'read current finding');
      expect(await speech(bob!)).toContain('Unfinished work');
      await restrict(api, source ? repository.id : id, actor);
      await bob!.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(bob!.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
      await expect(region(bob!)).toHaveCount(0); await expect(bob!.getByLabel('Source passage text', { exact: true })).toHaveCount(0); await expect.poll(() => speech(bob!)).toBe('');
      await bob!.evaluate(() => (window as unknown as { findingSpeech: { utterances: { onend?: () => void }[] } }).findingSpeech.utterances.forEach(item => item.onend?.()));
      expect(await speech(bob!)).toBe('');
      const stored = await bob!.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); expect(stored).not.toContain(run.id); expect(stored).not.toContain('Original supporting source.');
    }
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('password finding selection stays in memory and cannot cross offline reload or account switching', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const context = await browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  try {
    const page = await context.newPage(); await mockSpeech(page); await page.goto('./#home'); await signIn(page);
    const api = authenticatedApi(page), detail = await create(api), id = detail.revision.id, run = await record(api, id, 1), actor = (await api<AppState>('/state')).currentPrincipalId;
    await restrict(api, id, actor); await page.goto(`./#${id}`); await openFindings(page); await chooseRun(page, run); await openVoice(page); await command(page, 'read current finding');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); expect(stored).not.toContain(run.id); expect(stored).not.toContain('Original supporting source.');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true); await page.reload();
    await expect(page.getByRole('heading', { name: 'Workspace locked', exact: true })).toBeVisible(); await expect(region(page)).toHaveCount(0); expect(await speech(page)).toBe('');
    await context.setOffline(false); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0].displayName);
    await page.goto(`./#${id}`); await openFindings(page); await chooseRun(page, run);
    const other = await context.newPage(); await other.goto('./#home'); await other.getByRole('button', { name: 'Sign Out', exact: true }).click(); await other.getByRole('button', { name: /sign out and clear drafts/i }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible(); await expect(region(page)).toHaveCount(0);
    await signIn(other, 1); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[1].displayName);
    await page.goto(`./#${id}`); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(region(page)).toHaveCount(0); await expect(page.getByLabel('Source passage text', { exact: true })).toHaveCount(0);
  } finally { await context.setOffline(false); await context.close(); }
});
