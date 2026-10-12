import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, Task, TaskDetail, TaskTransaction } from '../shared/types';
import type { PasteDetail, PasteRecord } from '../shared/pastes';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import type { NotificationInbox } from '../shared/notifications';
import { reviewerApi as api, reviewerBase as base, reviewerSignIn as signIn } from './revision-reviewers-browser';

const revision = (page: Page, title: string) => api<RevisionDetail>(page, '/revisions', { title, kind: 'document', testPlan: 'Inspect exact source and saved mention bindings.', files: [{ path: 'draft.md', content: 'Original source stays exact.\n' }] });
async function insert(form: Locator, textarea: Locator, username: string, start?: number) {
  await textarea.evaluate((element, position) => { const input = element as HTMLTextAreaElement; input.focus(); input.setSelectionRange(position ?? input.value.length, position ?? input.value.length); }, start);
  const picker = form.locator('.mention-picker');
  if (await picker.getAttribute('open') === null) await picker.locator('summary').click();
  await picker.getByLabel('Find a person', { exact: true }).fill(username);
  await picker.getByRole('combobox', { name: 'Person to mention', exact: true }).selectOption({ label: username === 'bob' ? 'Bob Editor (@bob)' : 'Alice Researcher (@alice)' });
  const button = picker.getByRole('button', { name: 'Insert Mention', exact: true });
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.focus(); await button.press('Enter');
}
async function screenshot(page: Page, info: TestInfo, name: string, target: Locator) {
  const folder = `.data/people-mentions-visual/${base === '/' ? 'root' : 'mounted'}`;
  await mkdir(folder, { recursive: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${folder}/${info.project.name}-${name}.png` });
}

test('revision comments and replies insert people by keyboard and render only saved exact bindings', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const detail = await revision(page, 'People in exact manuscript discussion'), id = detail.revision.id;
    await page.goto(`./#${id}`); await page.getByRole('button', { name: /^Discussion \d+$/ }).click();
    const form = page.locator('.comment-form'), body = form.getByLabel('Review comment', { exact: true });
    await body.fill('`literal code`'); await insert(form, body, 'bob', 3);
    await expect(form.getByRole('alert')).toContainText('outside code'); await expect(body).toHaveValue('`literal code`');
    await body.fill('Please inspect this.'); await insert(form, body, 'bob', 7);
    await expect(body).toHaveValue('Please @bob inspect this.');
    const commentBody = `${await body.inputValue()} Again @BoB; code \`@bob\`; unknown @not-a-person. <img src=x onerror="window.mentionExecuted=true">`;
    await body.fill(commentBody); await screenshot(page, info, 'picker', form.locator('.mention-picker'));
    if (info.project.name === 'desktop') {
      await page.setViewportSize({ width: 768, height: 1024 });
      await screenshot(page, info, 'tablet-picker', form.locator('.mention-picker'));
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await form.getByRole('button', { name: 'Add Comment', exact: true }).click();
    const thread = page.locator('.review-thread').filter({ hasText: 'Please @bob inspect this.' });
    await expect(thread.locator('.person-mention')).toHaveText(['@bob', '@BoB']);
    await expect(thread.locator('.comment p')).toHaveText(commentBody); await expect(thread.locator('.comment img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { mentionExecuted?: boolean }).mentionExecuted)).toBeUndefined();
    await expect(thread.locator('.person-mention').first()).toHaveAttribute('title', 'Bob Editor (@bob)');
    await expect(thread.locator('.person-mention a')).toHaveCount(0);
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    const reply = thread.locator('.thread-reply'), replyBody = reply.getByRole('textbox', { name: 'Reply to this thread', exact: true });
    await replyBody.fill('For '); await insert(reply, replyBody, 'alice');
    await reply.getByRole('button', { name: 'Add Reply', exact: true }).click();
    await expect(thread.locator('.person-mention')).toHaveText(['@bob', '@BoB', '@alice']);
    const after = await api<RevisionDetail>(page, `/revisions/${id}`);
    expect(after.versions).toEqual(detail.versions); expect(after.comments[0]!.versionId).toBe(detail.versions[0]!.id);
    expect(after.comments[0]!.mentions!.tokens.map(token => [token.spelling, token.principalId !== null])).toEqual([['bob', true], ['BoB', true], ['not-a-person', false]]);
    expect(after.comments[1]!.versionId).toBe(after.comments[0]!.versionId);
    await screenshot(page, info, 'discussion', thread);
  } finally { await context.close(); }
});

test('Word passage mentions preserve package, quotation and original version', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(page, '/files', { name: 'mentions.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') });
    const state = await api<AppState>(page, '/state'), detail = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word passage mentions', testPlan: 'Keep original package and passage.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: state.accessEpoch });
    await page.goto(`./#${detail.revision.id}`);
    await page.locator('.docx-block').filter({ hasText: 'The original result is clear.' }).getByRole('button', { name: 'Discuss passage', exact: true }).click();
    await page.getByLabel('First character', { exact: true }).fill('5'); await page.getByLabel('Last character', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Comment on Word Passage', exact: true }).click();
    const form = page.locator('.comment-form'), body = form.getByLabel('Review comment', { exact: true });
    await body.fill('Inspect the original wording, '); await insert(form, body, 'bob'); await form.getByRole('button', { name: 'Add Comment', exact: true }).click();
    const thread = page.locator('.review-thread').filter({ hasText: 'Inspect the original wording,' });
    await expect(thread.locator('.person-mention')).toHaveText('@bob'); await expect(thread.locator('.docx-thread-anchor blockquote')).toHaveText('original');
    const after = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`);
    expect(after.versions).toEqual(detail.versions); expect(after.comments[0]!.docxAnchor).toMatchObject({ versionId: detail.versions[0]!.id, contentHash: detail.versions[0]!.contentHash, quote: 'original' });
    await screenshot(page, info, 'word', thread);
  } finally { await context.close(); }
});

test('task comment mentions notify and record mention-driven following without changing task fields', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const task = await api<Task>(alice.page, '/tasks', { title: 'A task with a named reader', description: 'Original task description.' });
    await alice.page.goto(`./#${task.id}`); const form = alice.page.locator('.task-comment-form'), body = form.getByLabel('Task comment', { exact: true });
    await body.fill('Please inspect this task, '); await insert(form, body, 'bob'); await form.getByRole('button', { name: 'Add Task Comment', exact: true }).click();
    await expect(alice.page.locator('.task-comment-body .person-mention')).toHaveText('@bob');
    const after = await api<TaskDetail>(alice.page, `/tasks/${task.id}`); expect(after.task.title).toBe(task.title); expect(after.task.description).toBe(task.description); expect(after.task.status).toBe(task.status);
    await expect(alice.page.locator('.task-transaction')).toContainText(['after being mentioned']);
    const notifications = await api<NotificationInbox>(bob.page, '/notifications?filter=all');
    expect(notifications.items.filter(item => item.object.id === task.id && item.event.kind === 'task_commented')).toHaveLength(1);
    await screenshot(alice.page, info, 'task', alice.page.locator('.task-comment-body'));
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('historical Paste mention receipts retry exactly and preserve a newer unsent comment', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const paste = await api<PasteRecord>(page, '/pastes', { title: 'Mention exact Paste content', content: 'Original source.' });
    await api(page, `/pastes/${paste.id}`, { expectedVersion: paste.version, content: 'Current source.' }, 'PATCH');
    await page.goto(`./#${paste.id}`); await page.getByLabel('Paste content version', { exact: true }).selectOption('1');
    const form = page.locator('.paste-detail form').filter({ has: page.getByRole('textbox', { name: 'Paste comment', exact: true }) }), body = form.getByRole('textbox', { name: 'Paste comment', exact: true });
    await body.fill('Read historical source, '); await insert(form, body, 'bob');
    const sent: { body: string | null; key: string | undefined }[] = [];
    await page.route(`**/api/pastes/${paste.id}/comments`, async route => { sent.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] }); const response = await route.fetch(); if (sent.length === 1) await route.abort('failed'); else await route.fulfill({ response }); });
    await form.getByRole('button', { name: 'Add Paste Comment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry Exact Paste Change', exact: true })).toBeEnabled();
    await body.fill('New unsent note for @alice.'); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Retry Exact Paste Change', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unconfirmed Paste Change', exact: true })).toHaveCount(0);
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
    await expect(body).toHaveValue('New unsent note for @alice.'); await expect(page.getByLabel('Paste content version', { exact: true })).toHaveValue('1');
    await expect(page.locator('.paste-history .person-mention')).toHaveText('@bob');
    const after = await api<PasteDetail>(page, `/pastes/${paste.id}`), comments = after.history.transactions.filter(item => item.kind === 'comment');
    expect(comments).toHaveLength(1); expect(comments[0]!.contentVersion).toBe(1); expect(after.version.content).toBe('Current source.');
    await screenshot(page, info, 'paste', page.locator('.paste-history'));
  } finally { await context.close(); }
});

test('offline mention drafts remain plain exact text and never submit on reconnect', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const detail = await revision(page, 'Offline people mention draft'), id = detail.revision.id, original = detail.versions[0]!;
    await page.goto(`./#${id}`); await page.getByRole('button', { name: /^Discussion \d+$/ }).click();
    const form = page.locator('.comment-form'), body = form.getByLabel('Review comment', { exact: true });
    await body.fill('Unsent exact text for '); await insert(form, body, 'bob'); const text = await body.inputValue();
    let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/revisions/${id}/comments`)) writes++; });
    await context.setOffline(true); await page.evaluate(() => { location.hash = 'home'; }); await expect(form).toHaveCount(0); await page.evaluate(value => { location.hash = value; }, id); await page.getByRole('button', { name: /^Discussion \d+$/ }).click();
    await expect(body).toHaveValue(text); await expect(page.locator('.person-mention')).toHaveCount(0);
    await context.setOffline(false); await expect(form.getByRole('button', { name: 'Add Comment', exact: true })).toBeEnabled(); expect(writes).toBe(0);
    await form.getByRole('button', { name: 'Add Comment', exact: true }).click(); await expect(page.locator('.review-thread .person-mention')).toHaveText('@bob');
    const after = await api<RevisionDetail>(page, `/revisions/${id}`); expect(after.comments[0]!.body).toBe(text); expect(after.comments[0]!.versionId).toBe(original.id); expect(writes).toBe(1);
  } finally { await context.setOffline(false); await context.close(); }
});

test('unresolved mentions never gain a stored person binding after the recipient later gains access', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const task = await api<Task>(page, '/tasks', { title: 'Mention stays unresolved' }), state = await api<AppState>(page, '/state');
    let policy = (await api<ObjectAccess>(page, `/policies/${task.id}`)).policy;
    await api(page, `/policies/${task.id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [state.currentPrincipalId] }, edit: policy.rules.edit, interact: policy.rules.interact }, 'PUT');
    const old = await api<TaskTransaction>(page, `/tasks/${task.id}/comments`, { body: 'Before access: @bob.' }); expect(old.mentions!.tokens[0]!.principalId).toBeNull();
    policy = (await api<ObjectAccess>(page, `/policies/${task.id}`)).policy;
    await api(page, `/policies/${task.id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: policy.rules.edit, interact: policy.rules.interact }, 'PUT');
    await api(page, `/tasks/${task.id}/comments`, { body: 'After access: @bob.' }); await page.goto(`./#${task.id}`);
    await expect(page.locator('.task-comment-body').filter({ hasText: 'Before access:' })).toHaveText('Before access: @bob.');
    await expect(page.locator('.task-comment-body').filter({ hasText: 'Before access:' }).locator('.person-mention')).toHaveCount(0);
    await expect(page.locator('.task-comment-body').filter({ hasText: 'After access:' }).locator('.person-mention')).toHaveText('@bob');
  } finally { await context.close(); }
});

test('missing or mismatched saved proof renders literal text without retaining an earlier chip', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const task = await api<Task>(page, '/tasks', { title: 'Saved proof display' });
    await api(page, `/tasks/${task.id}/comments`, { body: 'Bound @bob.' }); await page.goto(`./#${task.id}`);
    await expect(page.locator('.task-comment-body .person-mention')).toHaveText('@bob');
    let mode: 'bad' | 'legacy' = 'bad';
    await page.route(`**/api/tasks/${task.id}`, async route => { const response = await route.fetch(), result = await response.json() as TaskDetail; for (const entry of result.history.transactions) if (entry.mentions) { if (mode === 'legacy') delete entry.mentions; else entry.mentions.bodySha256 = '0'.repeat(64); } await route.fulfill({ response, json: result }); });
    await page.getByRole('button', { name: 'Reload Task', exact: true }).click(); await expect(page.locator('.task-comment-body .person-mention')).toHaveCount(0); await expect(page.locator('.task-comment-body')).toHaveText('Bound @bob.');
    mode = 'legacy'; await page.getByRole('button', { name: 'Reload Task', exact: true }).click(); await expect(page.locator('.task-comment-body .person-mention')).toHaveCount(0); await expect(page.locator('.task-comment-body')).toHaveText('Bound @bob.');
  } finally { await context.close(); }
});
