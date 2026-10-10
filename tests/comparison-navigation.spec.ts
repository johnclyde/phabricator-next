import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AppState, RevisionDetail } from '../shared/types';
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href; const response = body === undefined ? await request.get(url) : await request.post(url, { data: body });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function fixture(page: Page, request: APIRequestContext, baseURL: string) {
  const detail = await api<RevisionDetail>(request, baseURL, '/revisions', { kind: 'document', title: `Navigation ${Date.now()}`, files: [{ path: 'first.md', content: 'a b\nkeep\nold\nkeep\nc\td\n' }, { path: 'second.md', content: 'Before second.' }, { path: 'spaces.md', content: 'a b' }, { path: 'removed.md', content: ' \t' }] });
  await api(request, baseURL, `/revisions/${detail.revision.id}/versions`, { expectedVersion: 1, message: 'Literal edits', files: [{ path: 'first.md', content: 'a  b\nkeep\nnew\nkeep\nc d\n' }, { path: 'second.md', content: 'After second.' }, { path: 'spaces.md', content: 'a\tb' }, { path: 'empty.md', content: '' }] });
  await page.goto(`./#${detail.revision.id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); return detail.revision.id;
}
async function bodyKey(page: Page, key: string) { await page.locator('body').click({ position: { x: 1, y: 200 } }); await page.keyboard.press(key); }
async function command(page: Page, value: string) { await page.getByLabel('Workspace command', { exact: true }).fill(value); await page.getByRole('button', { name: 'Run', exact: true }).click(); }

test('file controls and keyboard traverse the exact union, filter navigation only and preserve same-target drafts', async ({ page, request, baseURL }, info) => {
  await fixture(page, request, baseURL!); await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  const progress = page.locator('.passage-navigation'); const file = page.getByLabel('Source file', { exact: true });
  await expect(page.locator('.comparison-file-navigation')).toContainText('File 1 of 5');
  await expect(page.getByRole('button', { name: 'Previous file', exact: true })).toBeDisabled();
  await expect(progress).toContainText('Change 1 of 3');
  const literal = await page.locator('.literal-line-diff').textContent();
  await page.getByLabel('Skip space/tab-only changes', { exact: true }).check();
  await expect(progress).toContainText('Change 1 of 1 · 2 space/tab-only changes skipped');
  expect(await page.locator('.literal-line-diff').textContent()).toBe(literal);
  await expect(page.locator('.literal-line-diff .active-change').first()).toHaveAttribute('data-change-passage', '1');
  await bodyKey(page, 'j'); await expect(progress).toContainText('Change 1 of 1');
  await page.getByLabel('Skip space/tab-only changes', { exact: true }).uncheck();
  await bodyKey(page, 'j'); await expect(progress).toContainText('Change 2 of 3');
  await bodyKey(page, 'k'); await expect(progress).toContainText('Change 1 of 3');
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Keep this version-bound comment.');
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Keep this unsaved editor text.');
  await bodyKey(page, 'Shift+J'); await expect(file).toHaveValue('second.md');
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Keep this unsaved editor text.');
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('Keep this version-bound comment.');
  await page.getByRole('button', { name: 'Source', exact: true }).click(); await page.getByLabel('Skip space/tab-only changes', { exact: true }).check();
  await page.getByRole('button', { name: 'Next file', exact: true }).click(); await expect(file).toHaveValue('spaces.md');
  await expect(progress).toContainText('No navigable changes · 1 space/tab-only change skipped');
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(page.locator('.literal-line-diff')).toContainText('a b');
  await page.getByRole('button', { name: 'Next file', exact: true }).click(); await expect(file).toHaveValue('empty.md'); await expect(progress).toContainText('File added');
  await page.getByRole('button', { name: 'Next file', exact: true }).click(); await expect(file).toHaveValue('removed.md'); await expect(progress).toContainText('Change 1 of 1 · File removed');
  await expect(page.getByRole('button', { name: 'Next file', exact: true })).toBeDisabled(); await bodyKey(page, 'Shift+J'); await expect(file).toHaveValue('removed.md');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await page.reload(); await expect(file).toHaveValue('removed.md'); await expect(page.getByLabel('Skip space/tab-only changes', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Comparison mode', { exact: true })).toHaveValue('lines');
  await page.getByRole('button', { name: 'Previous file', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Previous file', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('comparison-file-navigation.png') });
});

test('comparison keyboard ignores typing, controls, dialogs, composition and modified or repeated keys', async ({ page, request, baseURL }) => {
  await fixture(page, request, baseURL!); const file = page.getByLabel('Source file', { exact: true });
  const comment = page.getByRole('textbox', { name: 'Review comment', exact: true }); await comment.fill('j'); await comment.press('Shift+J'); await expect(file).toHaveValue('first.md');
  await page.evaluate(() => {
    const editable = document.createElement('div'); editable.contentEditable = 'true'; document.body.append(editable); editable.focus(); editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true })); editable.remove();
    const events: KeyboardEventInit[] = [{ key: 'J', shiftKey: true, repeat: true }, { key: 'J', shiftKey: true, isComposing: true }, { key: 'J', shiftKey: true, altKey: true }, { key: 'J', shiftKey: true, ctrlKey: true }, { key: 'J', shiftKey: true, metaKey: true }];
    for (const options of events) document.body.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true }));
    const prevented = new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true, cancelable: true }); prevented.preventDefault(); document.body.dispatchEvent(prevented);
    const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.showModal(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true })); dialog.close(); dialog.remove();
  });
  await expect(file).toHaveValue('first.md'); await bodyKey(page, 'Shift+J'); await expect(file).toHaveValue('second.md'); await bodyKey(page, 'Shift+K'); await expect(file).toHaveValue('first.md');
});

test('voice file navigation keeps its new utterance while manual changes and access loss cancel old speech', async ({ page, request, baseURL }) => {
  await page.addInitScript(() => {
    const recorded = { active: '', texts: [] as string[], cancels: 0, utterances: [] as { onend?: () => void }[], recognizers: [] as { onresult?: (event: unknown) => void }[] };
    Object.assign(window, { navigationSpeech: recorded, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } }, SpeechRecognition: class { constructor() { recorded.recognizers.push(this); } onresult?: (event: unknown) => void; start() {} abort() {} stop() {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {}, cancel() { recorded.active = ''; recorded.cancels++; }, speak(utterance: { text: string; onend?: () => void }) { recorded.utterances.push(utterance); recorded.active = utterance.text; recorded.texts.push(utterance.text); } } });
  });
  const id = await fixture(page, request, baseURL!); await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await page.getByLabel('I understand browser speech recognition may send audio to its provider and may require internet.', { exact: true }).check();
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.getByRole('button', { name: 'Stop Listening', exact: true }).click();
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  const active = () => page.evaluate(() => (window as unknown as { navigationSpeech: { active: string } }).navigationSpeech.active);
  await command(page, 'next file'); await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('second.md');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await active()).toContain('file second.md');
  await page.evaluate(() => { const recorded = (window as unknown as { navigationSpeech: { recognizers: { onresult?: (event: unknown) => void }[] } }).navigationSpeech; for (const rec of recorded.recognizers) rec.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next file' } }] }); });
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('second.md');
  await expect(page.locator('.command-feedback')).toContainText('file second.md');
  await command(page, 'previous file'); await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('first.md'); expect(await active()).toContain('file first.md');
  await page.getByRole('button', { name: 'Stop Listening', exact: true }).click(); await expect.poll(active).toBe('');
  await page.evaluate(() => (window as unknown as { navigationSpeech: { utterances: { onend?: () => void }[] } }).navigationSpeech.utterances.at(-1)?.onend?.());
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.evaluate(() => (window as unknown as { navigationSpeech: { recognizers: { onresult?: (event: unknown) => void }[] } }).navigationSpeech.recognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'next file' } }] }));
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('second.md'); expect(await active()).toContain('file second.md');
  await page.getByLabel('Speak responses (on-device only)', { exact: true }).uncheck(); await expect.poll(active).toBe('');
  await command(page, 'read current change');
  await page.evaluate(() => { const recorded = (window as unknown as { navigationSpeech: { utterances: { onend?: () => void }[]; recognizers: { onresult?: (event: unknown) => void }[] } }).navigationSpeech; recorded.utterances.at(-1)?.onend?.(); recorded.recognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'previous file' } }] }); });
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('first.md'); expect(await active()).toBe('');
  await page.evaluate(() => (window as unknown as { navigationSpeech: { recognizers: { onresult?: (event: unknown) => void }[] } }).navigationSpeech.recognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'stop listening' } }, { isFinal: true, 0: { transcript: 'next file' } }] }));
  await expect(page.getByRole('button', { name: 'Start Hands-free Listening', exact: true })).toBeVisible(); await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('first.md');
  await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await page.getByLabel('Skip space/tab-only changes', { exact: true }).check(); await expect.poll(active).toBe('');
  await command(page, 'read changes'); await expect(page.locator('.command-feedback')).toContainText('space/tab-only passage');
  await page.getByRole('button', { name: 'Next file', exact: true }).click(); await expect.poll(active).toBe('');
  await command(page, 'previous file');
  await page.getByLabel('Workspace command', { exact: true }).fill('next file');
  await page.evaluate(() => { const form = document.querySelector('.voice-body form') as HTMLFormElement; form.requestSubmit(); form.requestSubmit(); });
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('second.md');
  await expect(page.locator('.command-feedback')).toContainText('Wait for it to finish loading');
  await command(page, 'next file'); await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('spaces.md');
  await expect(page.locator('.command-feedback')).toContainText('No changed passages remain under this filter');
  expect(await active()).toContain('file spaces.md');
  await page.goto('./#tasks'); await expect.poll(active).toBe(''); await page.goto(`./#${id}`); await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('spaces.md');
  await command(page, 'read changes'); expect(await active()).toContain('file spaces.md');
  await page.route('**/api/state', async route => { const response = await route.fetch(); const state = await response.json() as AppState; delete state.access[id]; state.revisions = state.revisions.filter(item => item.id !== id); state.accessEpoch++; await route.fulfill({ response, json: state }); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.locator('.exact-comparison')).toHaveCount(0); await expect(page.locator('.voice-panel')).toHaveCount(0); await expect.poll(active).toBe('');
  await page.unrouteAll({ behavior: 'wait' });
});
