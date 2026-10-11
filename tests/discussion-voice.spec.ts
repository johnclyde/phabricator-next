import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AppState, RevisionDetail, ReviewComment } from '../shared/types';

async function post<T>(request: APIRequestContext, baseURL: string, path: string, body: unknown): Promise<T> {
  const response = await request.post(new URL(`api${path}`, baseURL).href, { data: body });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function fixture(page: Page, request: APIRequestContext, baseURL: string) {
  const detail = await post<RevisionDetail>(request, baseURL, '/revisions', { kind: 'document', title: `Spoken discussion ${Date.now()}`, files: [{ path: 'argument.md', content: 'Original argument.\n' }] });
  const id = detail.revision.id; const versionId = detail.versions[0]!.id;
  const comments: ReviewComment[] = [];
  for (const body of ['Alpha evidence needs a citation.', 'Beta argument needs a date.', 'Gamma conclusion needs a qualification.']) {
    comments.push(await post<ReviewComment>(request, baseURL, `/revisions/${id}/comments`, { versionId, body, filePath: 'argument.md', line: 1 }));
  }
  comments.sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  await post(request, baseURL, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'Later argument', files: [{ path: 'argument.md', content: 'Revised argument.\n' }] });
  await page.goto(`./#${id}`); await expect(page.locator('.review-thread')).toHaveCount(3);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  return { id, comments };
}
async function installSpeech(page: Page) {
  await page.addInitScript(() => {
    const state = { active: '', texts: [] as string[], cancels: 0 };
    Object.assign(window, { discussionSpeech: state, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } }, SpeechRecognition: class { start() {} stop() {} abort() {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {}, cancel() { state.active = ''; state.cancels++; }, speak(utterance: { text: string }) { state.active = utterance.text; state.texts.push(utterance.text); } } });
  });
}
async function command(page: Page, text: string) {
  await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const speech = (page: Page) => page.evaluate(() => (window as unknown as { discussionSpeech: { active: string } }).discussionSpeech.active);
async function openVoice(page: Page) {
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
}

test('spoken discussion shares the visible cursor and collapse without changing inspected source or resolution', async ({ page, request, baseURL }) => {
  await installSpeech(page); const { id, comments } = await fixture(page, request, baseURL!); await openVoice(page);
  const first = page.locator(`[data-thread-id="${comments[0]!.id}"]`);
  const second = page.locator(`[data-thread-id="${comments[1]!.id}"]`);
  await command(page, 'previous thread'); await expect(page.locator('.review-thread[aria-current="true"]')).toHaveCount(0);
  await command(page, 'next thread'); await expect(first).toHaveAttribute('aria-current', 'true'); expect(await speech(page)).toContain(comments[0]!.body);
  await command(page, 'collapse current thread'); await expect(first.locator('.comment')).not.toBeVisible(); expect(await speech(page)).toMatch(/collapsed/i);
  await command(page, 'next thread'); await expect(second).toHaveAttribute('aria-current', 'true'); expect(await speech(page)).toContain(comments[1]!.body);
  await command(page, 'previous thread including collapsed'); await expect(first).toHaveAttribute('aria-current', 'true');
  expect(await speech(page)).toMatch(/collapsed/i); expect(await speech(page)).not.toContain(comments[0]!.body);
  await command(page, 'read current thread'); expect(await speech(page)).toContain(comments[0]!.body); await expect(first.locator('.comment')).not.toBeVisible();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); await expect(first.locator('.thread-heading .badge')).toHaveText('Open');
  await page.getByRole('button', { name: 'Next thread', exact: true }).click(); await expect.poll(() => speech(page)).toBe('');
  await expect(second).toHaveAttribute('aria-current', 'true');
  await command(page, 'read current thread'); expect(await speech(page)).toContain(comments[1]!.body);
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'next thread'); expect(await speech(page)).not.toBe('');
  await page.getByRole('button', { name: /^Review evidence/ }).click(); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'next thread'); await expect(page.locator('.command-feedback')).toContainText('Open the Discussion tab');
  const response = await request.get(new URL(`api/revisions/${id}`, baseURL!).href); const final = await response.json() as RevisionDetail;
  expect(final.revision.currentVersion).toBe(2); expect(final.threadEvents).toEqual([]); expect(final.threads.map(thread => thread.status)).toEqual(['open', 'open', 'open']);
});

test('consecutive spoken navigation stays current, while filters, route changes and access loss retire private speech', async ({ page, request, baseURL }) => {
  await installSpeech(page); const { id, comments } = await fixture(page, request, baseURL!); await openVoice(page);
  await page.getByLabel('Workspace command', { exact: true }).fill('next thread');
  await page.evaluate(() => { const form = document.querySelector('.voice-body form') as HTMLFormElement; form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator(`[data-thread-id="${comments[1]!.id}"]`)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => speech(page)).toContain(comments[1]!.body);
  await page.getByLabel('Thread status', { exact: true }).getByRole('button', { name: /^Resolved/ }).click(); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'read current thread'); expect(await speech(page)).not.toContain(comments[1]!.body);
  await page.getByLabel('Thread status', { exact: true }).getByRole('button', { name: /^All/ }).click(); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'next thread'); expect(await speech(page)).toContain(comments[0]!.body);
  await page.goto('./#tasks'); await expect.poll(() => speech(page)).toBe('');
  await page.goto(`./#${id}`); await expect(page.locator('.review-thread')).toHaveCount(3); await command(page, 'next thread');
  await page.route('**/api/state', async route => { const response = await route.fetch(); const state = await response.json() as AppState; delete state.access[id]; state.revisions = state.revisions.filter(item => item.id !== id); state.accessEpoch++; await route.fulfill({ response, json: state }); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.review-thread')).toHaveCount(0); await expect(page.locator('.voice-panel')).toHaveCount(0); await expect.poll(() => speech(page)).toBe('');
  await page.unrouteAll({ behavior: 'wait' });
});

test('typed discussion can speak on-device even when speech recognition is unavailable', async ({ page, request, baseURL }) => {
  await installSpeech(page);
  await page.addInitScript(() => { Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined }); });
  const { comments } = await fixture(page, request, baseURL!); await openVoice(page);
  await expect(page.getByRole('button', { name: 'Start Hands-free Listening', exact: true })).toHaveCount(0);
  await expect(page.locator('.voice-body')).toContainText('This browser does not expose speech recognition');
  await command(page, 'next thread'); expect(await speech(page)).toContain(comments[0]!.body);
  await page.getByRole('button', { name: 'Stop Speaking', exact: true }).click(); await expect.poll(() => speech(page)).toBe('');
});

test('switching directly between revisions retains the new discussion controller', async ({ page, request, baseURL }) => {
  await installSpeech(page); const first = await fixture(page, request, baseURL!); await openVoice(page);
  await command(page, 'next thread'); expect(await speech(page)).toContain(first.comments[0]!.body);
  const second = await fixture(page, request, baseURL!); await expect.poll(() => speech(page)).toBe('');
  await command(page, 'next thread');
  await expect(page.locator(`[data-thread-id="${second.comments[0]!.id}"]`)).toHaveAttribute('aria-current', 'true');
  expect(await speech(page)).toContain(second.comments[0]!.body);
  await page.goto(`./#${first.id}`); await expect(page.locator(`[data-thread-id="${first.comments[0]!.id}"]`)).toBeVisible();
  await command(page, 'next thread'); expect(await speech(page)).toContain(first.comments[0]!.body);
});

test('mixed discussion and comparison commands in one callback batch keep the latest spoken context', async ({ page, request, baseURL }) => {
  await page.addInitScript(() => {
    const state = { active: '', texts: [] as string[], cancels: 0, utterances: [] as { text: string; onend?: () => void }[], recognizers: [] as { onresult?: (event: unknown) => void }[] };
    Object.assign(window, {
      discussionSpeech: state,
      SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } },
      SpeechRecognition: class { onresult?: (event: unknown) => void; constructor() { state.recognizers.push(this); } start() {} stop() {} abort() {} },
    });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {},
      cancel() { state.active = ''; state.cancels++; },
      speak(utterance: { text: string; onend?: () => void }) { state.active = utterance.text; state.texts.push(utterance.text); state.utterances.push(utterance); },
    } });
  });
  const { comments } = await fixture(page, request, baseURL!); await openVoice(page);
  await page.getByLabel('I understand browser speech recognition may send audio to its provider and may require internet.', { exact: true }).check();
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { discussionSpeech: { utterances: { onend?: () => void }[]; recognizers: { onresult?: (event: unknown) => void }[] } }).discussionSpeech;
    const recognition = state.recognizers.at(-1)!;
    const result = (transcript: string) => ({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
    recognition.onresult?.(result('next thread'));
    // Finish the local utterance before delivering the next recognized command,
    // while keeping both handlers ahead of React's next render.
    state.utterances.at(-1)?.onend?.();
    recognition.onresult?.(result('read changes'));
  });
  await expect(page.locator(`[data-thread-id="${comments[0]!.id}"]`)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.command-feedback')).toContainText('file argument.md');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await speech(page)).toContain('file argument.md');
  expect(await speech(page)).toContain('version 1 to version 2');
  const narrated = await page.evaluate(() => (window as unknown as { discussionSpeech: { texts: string[] } }).discussionSpeech.texts);
  expect(narrated.at(-2)).toContain(comments[0]!.body);
  expect(narrated.at(-1)).toBe(await speech(page));
  await page.getByRole('button', { name: 'Stop Listening', exact: true }).click(); await expect.poll(() => speech(page)).toBe('');
});
