import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, Task, TaskDetail, WikiDetail, WikiDocument } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import type { RevisionMetadataSnapshot } from '../shared/revision-metadata';
import { prepareMetadataDraft } from '../client/revision-metadata';
import { reviewerApi as api, reviewerBase as base, reviewerSignIn as signIn } from './revision-reviewers-browser';

type CopyWindow = Window & { proseCopies?: string[] };
async function clipboard(page: Page) {
  const install = () => { (window as CopyWindow).proseCopies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as CopyWindow).proseCopies!.push(text); } } }); };
  await page.addInitScript(install); await page.evaluate(install);
}
async function exactSource(page: Page, content: Locator, label: string, raw: string) {
  const body = content.locator('..'), source = body.locator('.remarkup-source'); await source.locator('summary').click();
  expect(await source.getByLabel(label, { exact: true }).textContent()).toBe(raw);
  const previous = await page.evaluate(() => (window as CopyWindow).proseCopies!.length);
  await source.getByRole('button', { name: 'Copy Source', exact: true }).click(); await expect(source.getByRole('status')).toHaveText('Exact source copied.');
  expect(await page.evaluate(() => (window as CopyWindow).proseCopies!.length)).toBe(previous + 1); expect(await page.evaluate(() => (window as CopyWindow).proseCopies!.at(-1))).toBe(raw);
  await source.locator('summary').click();
}
async function capture(page: Page, info: TestInfo, name: string, target: Locator) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const folder = `.data/remarkup-prose-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await page.screenshot({ path: `${folder}/${info.project.name}-${name}.png` });
}
function watchReads(page: Page) {
  const unexpected: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) || /\/api\/(?:ai|reviews|voice|revisions\/[^/]+\/reviews)(?:\/|$)/.test(url.pathname)) unexpected.push(`${request.method()} ${url.href}`); });
  return unexpected;
}
const rich = '= Prose heading =\r\n\r\n**Strong @bob** and //emphasis// with @not__known.\r\n\r\n- First item\r\n- Second item\r\n\r\n> Exact **quotation**.\r\n\r\nWARNING: Keep source available.\r\n\r\n[[https://example.test/reference | Reference]] and [[javascript:alert(1) | Unsafe]].\r\n\r\n```\r\n' + 'long_literal<&> '.repeat(25) + '\r\n```\r\n\r\n<img src="https://example.test/pixel">\r\n';
async function assertRich(content: Locator) {
  await expect(content.getByRole('heading', { name: 'Prose heading', exact: true })).toBeVisible(); await expect(content.locator('strong').first()).toHaveText('Strong @bob');
  await expect(content.locator('em')).toHaveText('emphasis'); await expect(content.locator('ul > li')).toHaveCount(2); await expect(content.locator('blockquote')).toContainText('Exact quotation.');
  await expect(content.locator('.person-mention, img, script, iframe')).toHaveCount(0); await expect(content).toContainText('@not__known');
  await expect(content.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.test/reference'); await expect(content.locator('a[href^="javascript:"]')).toHaveCount(0);
}
async function wiki(page: Page, body: { title: string; slug: string; content: string }) { const root = await api<{ document: unknown }>(page, '/wiki?path=%2F'); if (!root.document) await api(page, '/documents', { title: 'Prose wiki root', slug: '/', content: 'Root fixture.' }); return api<WikiDocument>(page, '/documents', body); }
function wikiPins(detail: WikiDetail) { const p = detail.document.publication!; return { expectedVersion: p.headVersion, expectedHeadVersionId: p.headVersionId, expectedPublishedVersionId: p.publishedVersionId, expectedPublicationRevision: p.revision, expectedAccessEpoch: detail.accessEpoch }; }
const metadataPanel = (page: Page) => page.getByRole('region', { name: 'Revision Details', exact: true });
const metadataText = (page: Page, field: number) => metadataPanel(page).locator('.revision-metadata-text').nth(field);
const revision = (page: Page, title: string, summary = rich, testPlan = '//Inspect// the **exact source**, @bob.\r\n- Keep this plan.') => api<RevisionDetail>(page, '/revisions', { kind: 'document', title, summary, testPlan, files: [{ path: 'draft.md', content: '**Immutable source syntax** stays literal.\n' }] });

test('wiki published, draft and historical readers format selected immutable content while editors and comparison preserve source', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const requests = watchReads(page), document = await wiki(page, { title: 'Formatted wiki reader', slug: `remarkup-${randomUUID()}`, content: rich });
    const first = await api<WikiDetail>(page, `/documents/${document.id}`), draftText = rich.replace('Prose heading', 'Draft heading'); await api(page, `/documents/${document.id}/drafts`, { ...wikiPins(first), title: document.title, content: draftText });
    const before = await api<WikiDetail>(page, `/documents/${document.id}`); await page.goto(`./#${document.id}`); const content = page.locator('.wiki-content');
    await assertRich(content); await exactSource(page, content, 'Exact wiki version 1 source', rich); await capture(page, info, 'wiki', content); if (info.project.name === 'desktop') { await page.setViewportSize({ width: 768, height: 1024 }); await capture(page, info, 'tablet-wiki', content); await page.setViewportSize({ width: 1440, height: 1000 }); }
    await page.getByRole('button', { name: 'View Draft Version', exact: true }).click(); await expect(content.getByRole('heading', { name: 'Draft heading', exact: true })).toBeVisible(); await exactSource(page, content, 'Exact wiki version 2 source', draftText);
    await page.getByRole('tab', { name: 'Compare', exact: true }).click(); await expect(page.locator('.wiki-diff')).toContainText('**Strong @bob**'); await expect(page.locator('.wiki-diff strong, .wiki-diff .person-mention')).toHaveCount(0);
    await page.getByRole('tab', { name: 'History', exact: true }).click(); await page.locator('.wiki-history-entry').filter({ hasText: 'Version 1 · Formatted wiki reader' }).click(); await assertRich(content); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Edit Document', exact: true }).click(); const editor = page.getByRole('dialog'); await expect(editor.getByLabel('Content', { exact: true })).toHaveValue(draftText.replaceAll('\r\n', '\n')); await editor.getByLabel('Content', { exact: true }).fill('Unsent **wiki text**.'); await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await exactSource(page, content, 'Exact wiki version 1 source', rich);
    const after = await api<WikiDetail>(page, `/documents/${document.id}`); expect(after.document).toEqual(before.document); expect(after.history).toEqual(before.history); expect(after.lifecycle).toEqual(before.lifecycle); expect(requests).toEqual([]);
  } finally { await context.close(); }
});

test('task description readers mount only on list expansion and leave editor, field history and following unchanged', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const requests = watchReads(page), task = await api<Task>(page, '/tasks', { title: 'Formatted task reader', description: rich });
    await page.goto('./#tasks'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); const row = page.locator('.task-row').filter({ has: page.getByRole('link', { name: `${task.id} ${task.title}`, exact: true }) }), disclosure = row.locator('.task-description');
    await expect(disclosure).toBeVisible(); await expect(row.locator('.remarkup-content')).toHaveCount(0); await disclosure.locator(':scope > summary').click(); const listContent = row.locator('.remarkup-content'); await assertRich(listContent); await exactSource(page, listContent, 'Exact task description source', rich); await capture(page, info, 'task-list', disclosure);
    await disclosure.locator(':scope > summary').click(); await expect(row.locator('.remarkup-content')).toHaveCount(0); await disclosure.locator(':scope > summary').click(); await expect(listContent.locator('strong').first()).toHaveText('Strong @bob');
    const changed = rich.replace('Prose heading', 'Updated task heading'); await api(page, `/tasks/${task.id}`, { expectedVersion: task.version, description: changed }, 'PATCH'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(disclosure).not.toHaveAttribute('open'); await expect(row.locator('.remarkup-content')).toHaveCount(0);
    await page.goto(`./#${task.id}`); const content = page.locator('.task-detail-description'); await expect(content.getByRole('heading', { name: 'Updated task heading', exact: true })).toBeVisible(); await exactSource(page, content, 'Exact task description source', changed); await capture(page, info, 'task', content);
    const before = await api<TaskDetail>(page, `/tasks/${task.id}`); await page.getByRole('button', { name: 'Edit Task', exact: true }).click(); await expect(page.getByLabel('Task description', { exact: true })).toHaveValue(changed.replaceAll('\r\n', '\n')); await page.getByLabel('Task description', { exact: true }).fill('Retained **local draft**.'); await exactSource(page, content, 'Exact task description source', changed); await expect(page.getByLabel('Task description', { exact: true })).toHaveValue('Retained **local draft**.');
    const field = page.locator('.task-field-change').filter({ has: page.getByRole('heading', { name: 'Description', exact: true }) }); expect(await field.locator('.task-change-values pre').first().textContent()).toBe(rich); expect(await field.locator('.task-change-values pre').last().textContent()).toBe(changed); await field.getByText('Show description diff', { exact: true }).click(); await expect(field.locator('.task-description-diff')).toContainText('**Strong @bob**');
    expect(await api<TaskDetail>(page, `/tasks/${task.id}`)).toEqual(before); expect(requests).toEqual([]);
  } finally { await context.close(); }
});

test('current revision summary and Test Plan format across historical source selection without changing review evidence', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const requests = watchReads(page), created = await revision(page, 'Formatted revision metadata'), id = created.revision.id;
    await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Later immutable source.\n' }], message: 'Later source' });
    const current = await api<RevisionMetadataSnapshot>(page, `/revisions/${id}/metadata`), summary = rich.replace('Prose heading', 'Current summary heading'), plan = 'NOTE: **Current plan** for @bob.\r\n\r\n- Inspect both versions.';
    await api(page, `/revisions/${id}/metadata`, { ...prepareMetadataDraft(current), summary, testPlan: plan, message: '**Raw history explanation**.' }); const before = await api<RevisionDetail>(page, `/revisions/${id}`);
    await page.goto(`./#${id}`); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(metadataPanel(page)).toContainText('You are inspecting an earlier source version.');
    await expect(metadataText(page, 0).getByRole('heading', { name: 'Current summary heading', exact: true })).toBeVisible(); await expect(metadataText(page, 1).locator('strong').last()).toHaveText('Current plan'); await expect(metadataPanel(page).locator('.person-mention')).toHaveCount(0);
    await exactSource(page, metadataText(page, 0), 'Exact revision summary source', summary); await exactSource(page, metadataText(page, 1), 'Exact Test Plan source', plan); await capture(page, info, 'metadata', metadataPanel(page));
    await page.getByRole('button', { name: 'Source', exact: true }).click(); await expect(page.getByLabel('Source passage text', { exact: true })).toContainText('**Immutable source syntax**'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await metadataPanel(page).getByRole('button', { name: 'Edit Revision', exact: true }).click(); await expect(page.getByLabel('Revision summary', { exact: true })).toHaveValue(summary.replaceAll('\r\n', '\n')); await expect(page.getByLabel('Test Plan', { exact: true })).toHaveValue(plan.replaceAll('\r\n', '\n'));
    await metadataPanel(page).getByText('Revision Details History', { exact: true }).click(); await metadataPanel(page).getByText('Inspect Changed Fields', { exact: true }).click(); expect(await metadataPanel(page).locator('.revision-metadata-history pre').nth(1).textContent()).toBe(summary); await expect(metadataPanel(page).locator('.revision-metadata-history')).toContainText('**Raw history explanation**.');
    expect(await api<RevisionDetail>(page, `/revisions/${id}`)).toEqual(before); await page.goto('./#drafts'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); const row = page.locator(`.revision-row[href="#${id}"]`); await expect(row.locator('.row-summary')).toHaveText(summary); await expect(row.locator('.remarkup-content, .person-mention')).toHaveCount(0); expect(requests).toEqual([]);
  } finally { await context.close(); }
});

test('Word revision metadata uses the same reader and preserves exact package and text projection', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(page, '/files', { name: 'prose.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(page, '/state');
    const created = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word prose metadata', summary: '**Word summary** @bob.', testPlan: '//Read// the package.', sourceFile: { fileId: file.id, bytes: file.bytes, sha256: file.sha256 }, shareSource: true, expectedAccessEpoch: state.accessEpoch });
    await page.goto(`./#${created.revision.id}`); await expect(metadataText(page, 0).locator('strong')).toHaveText('Word summary'); await expect(metadataText(page, 1).locator('em')).toHaveText('Read'); await expect(metadataPanel(page).locator('.person-mention')).toHaveCount(0); await exactSource(page, metadataText(page, 0), 'Exact revision summary source', '**Word summary** @bob.'); await exactSource(page, metadataText(page, 1), 'Exact Test Plan source', '//Read// the package.'); await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.'); await capture(page, info, 'word', metadataPanel(page));
    const after = await api<RevisionDetail>(page, `/revisions/${created.revision.id}`); expect(after.versions).toEqual(created.versions); expect(after.reviews).toEqual(created.reviews); expect(after.comments).toEqual(created.comments);
  } finally { await context.close(); }
});

test('authorized offline prose snapshots stay readable and View revocation retires every saved reader', async ({ browser }, info) => {
  const owner = await signIn(browser, info), reader = await signIn(browser, info, 1), { page, context } = reader;
  try {
    await clipboard(page); const task = await api<Task>(owner.page, '/tasks', { title: 'Offline task prose', description: '**Offline task** @bob.' }), document = await wiki(owner.page, { title: 'Offline wiki prose', slug: `offline-${randomUUID()}`, content: '**Offline wiki** @bob.' }), created = await revision(owner.page, 'Offline revision prose', '**Offline summary** @bob.', '**Offline plan** @bob.');
    const readers = [{ id: task.id, selector: '.task-detail-description', text: 'Offline task' }, { id: document.id, selector: '.wiki-content', text: 'Offline wiki' }, { id: created.revision.id, selector: '.revision-metadata-text', text: 'Offline summary' }];
    for (const item of readers) { await page.goto(`./#${item.id}`); await expect(page.locator(item.selector).first().locator('strong')).toHaveText(item.text); }
    let proseWrites = 0; page.on('request', request => { if (request.method() !== 'GET' && /\/api\/(?:tasks|documents|revisions)\//.test(request.url())) proseWrites++; }); await context.setOffline(true);
    for (const item of readers) { await page.evaluate(id => { location.hash = id; }, item.id); await expect(page.locator(item.selector).first().locator('strong')).toHaveText(item.text); await expect(page.locator(item.selector).first().locator('.person-mention')).toHaveCount(0); }
    const state = await api<AppState>(owner.page, '/state'), alice = state.principals.find(person => person.username === 'alice')!;
    for (const item of readers) { const policy = (await api<ObjectAccess>(owner.page, `/policies/${item.id}`)).policy; await api(owner.page, `/policies/${item.id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [alice.id] }, edit: policy.rules.edit, interact: policy.rules.interact }, 'PUT'); }
    await context.setOffline(false); await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
    for (const item of readers) { await page.evaluate(id => { location.hash = id; }, item.id); await expect(page.locator(item.selector)).toHaveCount(0); }
    expect(proseWrites).toBe(0); expect(await page.evaluate(ids => Object.entries(localStorage).filter(([key]) => ids.some(id => key.includes(`:task:${id}`) || key.includes(`:wiki:${id}`) || key.includes(`:revision-metadata:${id}`))).map(([key]) => key), readers.map(item => item.id))).toEqual([]);
  } finally { await context.setOffline(false); await owner.context.close(); await reader.context.close(); }
});

test('valid large wiki, task and revision prose falls back completely without truncation or hidden source changes', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const text = '**Large @bob**\r\n' + 'α'.repeat(20_050) + '\r\nLAST CHARACTER Ω', task = await api<Task>(page, '/tasks', { title: 'Large task prose', description: text }), document = await wiki(page, { title: 'Large wiki prose', slug: `large-${randomUUID()}`, content: text }), created = await revision(page, 'Large revision prose', text, text);
    for (const item of [{ id: task.id, selector: '.task-detail-description', label: 'Exact task description source' }, { id: document.id, selector: '.wiki-content', label: 'Exact wiki version 1 source' }, { id: created.revision.id, selector: '.revision-metadata-text', label: 'Exact revision summary source' }]) {
      await page.goto(`./#${item.id}`); const content = page.locator(item.selector).first(); await expect(content.locator('strong,.person-mention')).toHaveCount(0); await expect(content.locator('..').locator('.remarkup-fallback')).toContainText('plain text'); expect(await content.textContent()).toBe(text); await exactSource(page, content, item.label, text);
    }
    const plan = metadataText(page, 1); expect(await plan.textContent()).toBe(text); await exactSource(page, plan, 'Exact Test Plan source', text); await capture(page, info, 'large', plan);
    expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.description).toBe(text); expect((await api<WikiDetail>(page, `/documents/${document.id}`)).document.content).toBe(text); expect((await api<RevisionDetail>(page, `/revisions/${created.revision.id}`)).versions).toEqual(created.versions);
  } finally { await context.close(); }
});

test('empty prose and wiki deletion markers keep provenance separate from exact source', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    await clipboard(page); const task = await api<Task>(page, '/tasks', { title: 'Empty description prose' }); await page.goto(`./#${task.id}`); await expect(page.getByText('No description yet.', { exact: true })).toBeVisible(); await exactSource(page, page.locator('.task-detail-description'), 'Exact task description source', '');
    const created = await revision(page, 'Empty summary prose', '', 'Recorded plan.'); await page.route(`**/api/revisions/${created.revision.id}/metadata`, async route => { const response = await route.fetch(), value = await response.json() as RevisionMetadataSnapshot; value.metadata.testPlan = null; await route.fulfill({ response, json: value }); }); await page.goto(`./#${created.revision.id}`); await expect(metadataPanel(page).getByText('No summary provided.', { exact: true })).toBeVisible(); await exactSource(page, metadataText(page, 0), 'Exact revision summary source', ''); await expect(metadataPanel(page).getByText('No Test Plan was recorded for this older revision.', { exact: true })).toBeVisible(); await expect(metadataPanel(page).getByLabel('Exact Test Plan source', { exact: true })).toHaveCount(0);
    const document = await wiki(page, { title: 'Deleted prose marker', slug: `deleted-${randomUUID()}`, content: '**Historical content**.' }), detail = await api<WikiDetail>(page, `/documents/${document.id}`); await api(page, `/documents/${document.id}/delete`, { ...wikiPins(detail), message: 'Keep history.' }); await page.goto(`./#${document.id}`); await expect(page.getByText('This version is a deleted-page marker. Choose another version to inspect its source.', { exact: true })).toBeVisible(); await expect(page.locator('.wiki-content, .wiki-page .remarkup-source')).toHaveCount(0); await page.getByLabel('Version to inspect', { exact: true }).fill('1'); await expect(page.locator('.wiki-content strong')).toHaveText('Historical content'); await exactSource(page, page.locator('.wiki-content'), 'Exact wiki version 1 source', '**Historical content**.');
  } finally { await context.close(); }
});

test('equal-text wiki versions retire an outstanding clipboard completion and keep the new source disclosure closed', async ({ browser }, info) => {
  const { page, context } = await signIn(browser, info);
  try {
    const content = '**Same source** across distinct versions.', document = await wiki(page, { title: 'Clipboard context retirement', slug: `clipboard-${randomUUID()}`, content }), initial = await api<WikiDetail>(page, `/documents/${document.id}`);
    await api(page, `/documents/${document.id}/drafts`, { ...wikiPins(initial), title: `${document.title} changed`, content }); await page.goto(`./#${document.id}`); await expect(page.locator('.wiki-content strong')).toHaveText('Same source');
    await page.evaluate(() => { let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); (window as unknown as { releaseProseCopy: () => void }).releaseProseCopy = release; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { await waiting; } } }); });
    let source = page.locator('.wiki-content').locator('..').locator('.remarkup-source'); await source.locator('summary').click(); await source.getByRole('button', { name: 'Copy Source', exact: true }).click();
    await page.getByRole('button', { name: 'View Draft Version', exact: true }).click(); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); await expect(page.locator('.wiki-content strong')).toHaveText('Same source'); source = page.locator('.wiki-content').locator('..').locator('.remarkup-source'); await expect(source).not.toHaveAttribute('open');
    await page.evaluate(() => (window as unknown as { releaseProseCopy: () => void }).releaseProseCopy()); await source.locator('summary').click(); expect(await source.getByLabel('Exact wiki version 2 source', { exact: true }).textContent()).toBe(content); await expect(source.getByRole('status')).toHaveCount(0);
  } finally { await context.close(); }
});
