import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, Task, TaskDetail } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { PasteDetail, PasteRecord } from '../shared/pastes';
import { reviewerApi as api, reviewerBase as base, reviewerSignIn as signIn } from './revision-reviewers-browser';

type CopyWindow = Window & { copiedRemarkup?: string[]; remarkupExecuted?: boolean };
async function clipboard(page: Page) {
  const install = () => { (window as CopyWindow).copiedRemarkup = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as CopyWindow).copiedRemarkup!.push(text); } } }); };
  await page.addInitScript(install); await page.evaluate(install);
}
async function exactSource(page: Page, body: Locator, text: string) {
  const source = body.locator('.remarkup-source'); await source.locator('summary').click();
  expect(await source.getByLabel('Exact comment source', { exact: true }).textContent()).toBe(text);
  const before = await page.evaluate(() => (window as CopyWindow).copiedRemarkup!.length);
  await source.getByRole('button', { name: 'Copy Source', exact: true }).click();
  await expect(source.getByRole('status')).toHaveText('Exact source copied.');
  expect(await page.evaluate(() => (window as CopyWindow).copiedRemarkup)).toHaveLength(before + 1);
  expect(await page.evaluate(() => (window as CopyWindow).copiedRemarkup!.at(-1))).toBe(text);
  await source.locator('summary').click();
}
async function screenshot(page: Page, info: TestInfo, name: string, target: Locator) {
  const folder = `.data/remarkup-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await target.evaluate(element => element.scrollIntoView({ block: 'center' })); await page.screenshot({ path: `${folder}/${info.project.name}-${name}.png` });
}
const rich = '= Review notes =\r\n\r\n**Strong @BoB** and //emphasis//; ~~removed~~, __underlined__, !!highlighted!!. Unknown @not__known.\r\n\r\n- First item\r\n  continued prose\r\n- Second item\r\n\r\n> Quoted **evidence** for @bob.\r\n\r\nWARNING: Inspect the original source.\r\n\r\n[[https://example.test/reference | Reference link]] and [[javascript:alert(1) | Unsafe link]].\r\n\r\nUse `@bob` literally. <img src="https://example.test/pixel" onerror="window.remarkupExecuted=true">\r\n';

test('revision discussion formats safely, preserves captured mentions and copies exact source only on request', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const remote: string[] = []; page.on('request', request => { if (new URL(request.url()).hostname === 'example.test') remote.push(request.url()); });
    const detail = await api<RevisionDetail>(page, '/revisions', { title: 'Remarkup reading', kind: 'document', testPlan: 'Inspect formatted and exact source discussion.', files: [{ path: 'draft.md', content: 'Original manuscript.\n' }] });
    const comment = await api<{ id: string }>(page, `/revisions/${detail.revision.id}/comments`, { versionId: detail.versions[0]!.id, body: rich });
    await page.goto(`./#${detail.revision.id}`);
    const body = page.locator(`[data-comment-id="${comment.id}"] .discussion-body`), formatted = body.locator('.remarkup-content');
    await expect(formatted.getByRole('heading', { name: 'Review notes', exact: true })).toBeVisible();
    await expect(formatted.locator('strong').first()).toHaveText('Strong @BoB'); await expect(formatted.locator('em')).toHaveText('emphasis'); await expect(formatted.locator('del')).toHaveText('removed');
    await expect(formatted.locator('u')).toHaveText('underlined'); await expect(formatted.locator('mark')).toHaveText('highlighted');
    await expect(formatted.locator('.person-mention')).toHaveText(['@BoB', '@bob']); await expect(formatted).toContainText('@not__known');
    await expect(formatted.locator('ul > li')).toHaveCount(2); await expect(formatted.locator('ul > li').first()).toHaveText('First item continued prose'); await expect(formatted.locator('ul > li').first().locator('br')).toHaveCount(0); await expect(formatted.locator('blockquote')).toContainText('Quoted evidence for @bob.');
    const link = formatted.getByRole('link', { name: 'Reference link', exact: true }); await expect(link).toHaveAttribute('href', 'https://example.test/reference'); await expect(link).toHaveAttribute('rel', 'nofollow noopener noreferrer'); await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(formatted.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0); await expect(formatted.getByRole('link', { name: 'Unsafe link', exact: true })).toHaveCount(0); await expect(formatted.locator('img,iframe,script,video,audio')).toHaveCount(0); await expect(formatted.locator('code')).toHaveText('@bob');
    expect(remote).toEqual([]); expect(await page.evaluate(() => (window as CopyWindow).remarkupExecuted)).toBeUndefined(); expect(await page.evaluate(() => (window as CopyWindow).copiedRemarkup)).toEqual([]);
    await exactSource(page, body, rich);
    const sourceView = body.locator('.remarkup-source'); await sourceView.locator('summary').click();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard permission was denied.'); } } }); });
    await sourceView.getByRole('button', { name: 'Copy Source', exact: true }).click(); await expect(sourceView.getByRole('status')).toHaveText('Clipboard permission was denied.');
    expect(await sourceView.getByLabel('Exact comment source').textContent()).toBe(rich); await sourceView.getByLabel('Exact comment source').focus(); await expect(sourceView.getByLabel('Exact comment source')).toBeFocused();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
    await sourceView.getByRole('button', { name: 'Copy Source', exact: true }).click(); await expect(sourceView.getByRole('status')).toHaveText('Clipboard is unavailable. Select the source text to copy it.');
    expect(await sourceView.getByLabel('Exact comment source').textContent()).toBe(rich); expect(await page.evaluate(() => (window as CopyWindow).copiedRemarkup)).toEqual([rich]);
    await sourceView.locator('summary').click(); await screenshot(page, info, 'revision', body);
    if (info.project.name === 'desktop') { await page.setViewportSize({ width: 768, height: 1024 }); await screenshot(page, info, 'tablet-revision', body); }
    const after = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`); expect(after.versions).toEqual(detail.versions); expect(after.comments[0]!.body).toBe(rich); expect(after.reviews).toEqual(detail.reviews);
  } finally { await context.close(); }
});

test('Word passage discussion and replies format without changing the package or original quotation', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const bytes = await readFile('tests/fixtures/docx/roundtrip.docx');
    const file = await api<FileRecord>(page, '/files', { name: 'remarkup.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') });
    const state = await api<AppState>(page, '/state'), detail = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word with formatted discussion', testPlan: 'Keep exact Word evidence and discussion.', sourceFile: { fileId: file.id, bytes: file.bytes, sha256: file.sha256 }, shareSource: true, expectedAccessEpoch: state.accessEpoch });
    const version = detail.versions[0]!, range = version.docx!.projection.editableRanges.find(item => item.text === 'The original result is clear.')!;
    await api(page, `/revisions/${detail.revision.id}/comments`, { versionId: version.id, body: '**Inspect** this exact quote, @bob.\r\n> Original wording.', docxPassage: { rangeId: range.id, start: 4, end: 12, quote: 'original' } });
    const withThread = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`), thread = withThread.threads![0]!;
    await api(page, `/revisions/${detail.revision.id}/threads/${thread.id}/replies`, { viewedVersionId: version.id, body: '//Reply// keeps `original` unchanged.' });
    await page.goto(`./#${detail.revision.id}`); const discussion = page.locator('.review-thread');
    await expect(discussion.locator('.docx-thread-anchor blockquote')).toHaveText('original'); await expect(discussion.locator('.remarkup-content strong')).toHaveText('Inspect'); await expect(discussion.locator('.remarkup-content em')).toHaveText('Reply'); await expect(discussion.locator('.person-mention')).toHaveText('@bob');
    await exactSource(page, discussion.locator('.discussion-body').last(), '//Reply// keeps `original` unchanged.'); await screenshot(page, info, 'word', discussion);
    const after = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`); expect(after.versions).toEqual(detail.versions); expect(after.comments.map(item => item.versionId)).toEqual([version.id, version.id]); expect(after.comments[0]!.docxAnchor!.quote).toBe('original');
  } finally { await context.close(); }
});

test('task and historical Paste reading contain wide code and leave unsent drafts and source versions unchanged', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const content = '```\n' + 'literal<&>@bob '.repeat(35) + '\n```\n\n**Read** @bob.';
    const task = await api<Task>(page, '/tasks', { title: 'Read task code safely' }); await api(page, `/tasks/${task.id}/comments`, { body: content }); await page.goto(`./#${task.id}`);
    const taskBody = page.locator('.task-comment-body').locator('..'); await expect(taskBody.locator('pre[aria-label="Code block"]')).toContainText('literal<&>@bob'); await expect(taskBody.locator('.person-mention')).toHaveText('@bob');
    const draft = page.getByRole('textbox', { name: 'Task comment', exact: true }); await draft.fill('Unsent **task draft**.'); await exactSource(page, taskBody, content); await expect(draft).toHaveValue('Unsent **task draft**.'); await screenshot(page, info, 'task-code', taskBody);
    expect(await taskBody.locator('pre[aria-label="Code block"]').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const paste = await api<PasteRecord>(page, '/pastes', { title: 'Historical formatted Paste comment', content: 'Original Paste.' }); await api(page, `/pastes/${paste.id}`, { expectedVersion: paste.version, content: 'New Paste.' }, 'PATCH'); await api(page, `/pastes/${paste.id}/comments`, { contentVersion: 1, body: content }); await page.goto(`./#${paste.id}`); await page.getByLabel('Paste content version').selectOption('1');
    const pasteBody = page.locator('.paste-history .discussion-body'); await expect(pasteBody.locator('.remarkup-content strong')).toHaveText('Read'); await expect(pasteBody.locator('.person-mention')).toHaveText('@bob');
    await exactSource(page, pasteBody, content); await expect(page.getByLabel('Paste content version')).toHaveValue('1'); await screenshot(page, info, 'paste-code', pasteBody);
    const after = await api<PasteDetail>(page, `/pastes/${paste.id}`); expect(after.version.content).toBe('New Paste.'); expect(after.history.transactions.find(item => item.comment)?.contentVersion).toBe(1);
  } finally { await context.close(); }
});

test('legacy and unresolved names remain literal in cached offline formatted reading without writes', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const task = await api<Task>(page, '/tasks', { title: 'Legacy offline formatting' }), source = '**Legacy @bob** with @not__known.\r\nSecond line.';
    await api(page, `/tasks/${task.id}/comments`, { body: source });
    await page.route(`**/api/tasks/${task.id}`, async route => { const response = await route.fetch(), detail = await response.json() as TaskDetail; for (const transaction of detail.history.transactions) delete transaction.mentions; await route.fulfill({ response, json: detail }); });
    await page.goto(`./#${task.id}`); await expect(page.locator('.task-comment-body strong')).toHaveText('Legacy @bob'); await expect(page.locator('.task-comment-body .person-mention')).toHaveCount(0);
    let comments = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/tasks/${task.id}/comments`)) comments++; });
    await context.setOffline(true); await page.evaluate(() => { location.hash = 'home'; }); await expect(page.locator('.task-comment-body')).toHaveCount(0); await page.evaluate(id => { location.hash = id; }, task.id);
    await expect(page.locator('.task-comment-body strong')).toHaveText('Legacy @bob'); await expect(page.locator('.task-comment-body')).toContainText('@not__known'); await expect(page.locator('.task-comment-body .person-mention')).toHaveCount(0); await exactSource(page, page.locator('.task-comment-body').locator('..'), source);
    await context.setOffline(false); await expect(page.getByRole('button', { name: 'Reload Task', exact: true })).toBeEnabled(); expect(comments).toBe(0);
  } finally { await context.setOffline(false); await context.close(); }
});

test('oversized retained bodies fall back to exact literal text and cannot retain earlier mention chips', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const task = await api<Task>(page, '/tasks', { title: 'Bounded legacy reading' }); await api(page, `/tasks/${task.id}/comments`, { body: '**Bound @bob**.' }); await page.goto(`./#${task.id}`); await expect(page.locator('.task-comment-body .person-mention')).toHaveText('@bob');
    let source = '**@bob** <script>window.remarkupExecuted=true</script>\r\n' + 'x'.repeat(20001), bind = false;
    await page.route(`**/api/tasks/${task.id}`, async route => { const response = await route.fetch(), detail = await response.json() as TaskDetail; for (const transaction of detail.history.transactions) if (transaction.comment !== undefined) { transaction.comment = source; if (bind) transaction.mentions = { format: 'phabricator.mentions.v1', bodySha256: createHash('sha256').update(source).digest('hex'), tokens: [{ start: source.indexOf('@bob'), end: source.length, username: 'bob', spelling: 'bob', principalId: 'captured-bob', displayName: 'Captured Bob' }] }; else delete transaction.mentions; } await route.fulfill({ response, json: detail }); });
    await page.getByRole('button', { name: 'Reload Task', exact: true }).click(); const body = page.locator('.task-comment-body').locator('..'); await expect(body.locator('.remarkup-fallback')).toContainText('plain text'); await expect(body.locator('.person-mention,strong,script')).toHaveCount(0); await expect.poll(() => body.locator('.remarkup-content').textContent()).toBe(source); await exactSource(page, body, source); expect(await page.evaluate(() => (window as CopyWindow).remarkupExecuted)).toBeUndefined();
    source = '['.repeat(19000) + ' @bob'; bind = true;
    await page.getByRole('button', { name: 'Reload Task', exact: true }).click(); await expect(body.locator('.remarkup-fallback')).toContainText('plain text'); await expect(body.locator('.person-mention')).toHaveCount(0); await expect.poll(() => body.locator('.remarkup-content').textContent()).toBe(source); await exactSource(page, body, source);
  } finally { await context.close(); }
});
