import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import type { AppState, Project, ProjectChildPreview, Task, TaskDetail, WorkboardDetail, WorkboardReceipt } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { authAccounts } from './auth-fixture';
const base = normalizeBasePath(process.env.APP_BASE_PATH);
async function api<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
  return page.evaluate(async ({ base, path, method, body }) => {
    const session = await (await fetch(`${base}api/session`)).json() as { sessionContext: string | null; csrfToken: string | null };
    const headers: Record<string, string> = {}; if (session.sessionContext) headers['X-Session-Context'] = session.sessionContext;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken; }
    const response = await fetch(`${base}api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`); return result;
  }, { base, path, method, body }) as Promise<T>;
}
async function create<T>(request: APIRequestContext, baseURL: string, path: string, body: unknown): Promise<T> { const response = await request.post(new URL(`api${path}`, baseURL).href, { data: body }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
async function openBoard(page: Page, project: Project) { await page.goto(`./#${project.id}/workboard`); await expect(page.getByRole('heading', { level: 1 })).toContainText(`${project.name} · Workboard`); await expect(page.getByRole('button', { name: 'Reload Board', exact: true })).toBeEnabled(); }
async function confirmBoard(page: Page) { const region = page.getByRole('region', { name: 'Confirm board change', exact: true }); await region.getByRole('button', { name: 'Confirm Board Change', exact: true }).click(); await expect(region).toHaveCount(0); }
async function enable(page: Page) { await page.getByRole('button', { name: 'Create Workboard', exact: true }).click(); await confirmBoard(page); await expect(page.getByRole('region', { name: 'Column Backlog', exact: true })).toBeVisible(); }
async function addColumn(page: Page, name: string, limit = '') { await page.getByRole('button', { name: 'Add Column', exact: true }).click(); await page.getByLabel('Column name', { exact: true }).fill(name); await page.getByLabel('Advisory card limit', { exact: true }).fill(limit); await page.getByRole('button', { name: 'Review Column', exact: true }).click(); await confirmBoard(page); }
async function selectColumn(page: Page, name: string) { const chooser = page.getByLabel('Board column', { exact: true }); if ((page.viewportSize()?.width || 1000) <= 700) { await expect(chooser).toBeVisible(); await chooser.selectOption({ label: await chooser.locator('option').filter({ hasText: name }).first().textContent() as string }); } }
async function move(page: Page, task: Task, column: string, position = 'bottom') { await page.getByRole('article', { name: `${task.id} ${task.title}`, exact: true }).getByRole('button', { name: 'Move Card', exact: true }).click(); await page.getByLabel('Destination column', { exact: true }).selectOption({ label: column }); await page.getByLabel('Card position', { exact: true }).selectOption(position); await page.getByRole('button', { name: 'Review Move', exact: true }).click(); }

test('workboards create columns, move cards without status changes, retain hidden cards and support voice navigation', async ({ page, request, baseURL }, info) => {
  const project = await create<Project>(request, baseURL!, '/projects', { name: `Board lifecycle ${info.project.name} ${Date.now()}` });
  const first = await create<Task>(request, baseURL!, '/tasks', { title: 'Review the manuscript', projectIds: [project.id] });
  const second = await create<Task>(request, baseURL!, '/tasks', { title: 'Check citations', projectIds: [project.id] });
  await openBoard(page, project); await enable(page); await addColumn(page, 'Draft Review', '1');
  await selectColumn(page, 'Draft Review'); const renamed = page.getByRole('region', { name: 'Column Draft Review', exact: true }); await renamed.getByText('Column actions', { exact: true }).click(); await renamed.getByRole('button', { name: 'Edit Column', exact: true }).click(); await page.getByLabel('Column name', { exact: true }).fill('In Review'); await page.getByRole('button', { name: 'Review Column', exact: true }).click(); await confirmBoard(page);
  const reordered = page.getByRole('region', { name: 'Column In Review', exact: true }); await reordered.getByText('Column actions', { exact: true }).click(); await reordered.getByRole('button', { name: 'Move Column First', exact: true }).click(); await confirmBoard(page); await expect(page.locator('.workboard-column').first()).toHaveAttribute('aria-label', 'Column In Review');
  await selectColumn(page, 'Backlog'); await move(page, first, 'In Review');
  const confirmation = page.getByRole('region', { name: 'Confirm card move', exact: true }); const button = confirmation.getByRole('button', { name: 'Confirm Move Card', exact: true });
  await button.evaluate(element => element.scrollIntoView({ block: 'center' }));
  if (info.project.name === 'mobile') { const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.y).toBeGreaterThanOrEqual(55); expect(box!.y + box!.height).toBeLessThan(790); }
  await page.screenshot({ path: info.outputPath('workboard-move-confirmation.png') }); await button.click(); await expect(page.locator('.workboard-move-editor')).toHaveCount(0); await expect(confirmation).toHaveCount(0);
  await selectColumn(page, 'In Review'); await expect(page.getByRole('region', { name: 'Column In Review', exact: true }).getByRole('link', { name: `${first.id} ${first.title}`, exact: true })).toBeVisible();
  expect((await api<TaskDetail>(page, `/tasks/${first.id}`)).task.status).toBe('open');
  await selectColumn(page, 'Backlog'); await move(page, second, 'In Review', 'before'); await page.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toHaveCount(0);
  await selectColumn(page, 'In Review'); const column = page.getByRole('region', { name: 'Column In Review', exact: true });
  await expect(column.locator('.workboard-task-link')).toHaveText([`${second.id} ${second.title}`, `${first.id} ${first.title}`]); await expect(column).toContainText('Advisory card limit exceeded.');
  await column.getByText('Column actions', { exact: true }).click(); await column.getByRole('button', { name: 'Hide Column', exact: true }).click(); await confirmBoard(page); await expect(column).toHaveCount(0);
  await page.getByLabel('Show hidden columns', { exact: true }).check(); await selectColumn(page, 'In Review'); await expect(column.locator('.workboard-card')).toHaveCount(2);
  await column.getByText('Column actions', { exact: true }).click(); await column.getByRole('button', { name: 'Show Column', exact: true }).click(); await confirmBoard(page);
  await page.getByRole('button', { name: 'Disable Workboard', exact: true }).click(); await confirmBoard(page); await expect(page.getByRole('heading', { name: 'Workboard disabled', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable Workboard', exact: true }).click(); await confirmBoard(page); await selectColumn(page, 'In Review'); await expect(column.locator('.workboard-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show Board History', exact: true }).click(); await expect(page.locator('.workboard-history')).toContainText('Card move');
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Workspace command', { exact: true }).fill(`open workboard ${project.id}`); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.locator('.command-feedback')).toContainText('Opened the workboard'); await page.getByRole('button', { name: 'Close voice panel', exact: true }).click();
  await column.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -100)); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath('workboard-cards.png') });
});

test('workboard moves preserve conflict pins and offline drafts without replaying them', async ({ page, request, baseURL, context }, info) => {
  const project = await create<Project>(request, baseURL!, '/projects', { name: `Conflict board ${info.project.name} ${Date.now()}` });
  const task = await create<Task>(request, baseURL!, '/tasks', { title: 'Keep the reviewed move', projectIds: [project.id] });
  await openBoard(page, project); await enable(page); await addColumn(page, 'Ready'); await selectColumn(page, 'Backlog'); await move(page, task, 'Ready');
  const before = await api<WorkboardDetail>(page, `/projects/${project.id}/workboard`);
  await api(page, `/projects/${project.id}/workboard/columns`, 'POST', { name: 'Changed elsewhere', expectedBoardVersion: before.board.version });
  await page.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(page.locator('.workboard-move-editor [role=alert]')).toBeVisible();
  await expect(page.locator('.workboard-move-editor')).toContainText(`board version ${before.board.version}`);
  await page.getByRole('button', { name: 'Reload Board', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toContainText('original versions are preserved');
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Move Draft', exact: true }).click(); expect((await exported).suggestedFilename()).toBe(`${task.id}-workboard-move.json`);
  await expect.poll(() => page.evaluate(id => Object.keys(localStorage).some(key => key.includes(`:workboard:${id}:`) && localStorage.getItem(key)?.includes('Changed elsewhere')), project.id)).toBe(true);
  await context.setOffline(true); await page.reload(); await expect(page.getByRole('heading', { level: 1 })).toContainText(project.name); await expect(page.getByRole('button', { name: `Resume move for ${task.id}`, exact: true })).toBeVisible(); await page.getByRole('button', { name: `Resume move for ${task.id}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry Submitted Move', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith(':outbox')).flatMap(key => JSON.parse(localStorage.getItem(key) || '[]')).length)).toBe(0);
  await context.setOffline(false); await page.getByRole('button', { name: 'Reload Board', exact: true }).click(); await expect(page.getByRole('button', { name: 'Start New Move Preview', exact: true })).toBeEnabled(); page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Start New Move Preview', exact: true }).click();
  await page.getByLabel('Destination column', { exact: true }).selectOption({ label: 'Ready' }); await page.getByRole('button', { name: 'Review Move', exact: true }).click(); await page.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toHaveCount(0);
  const after = await api<WorkboardDetail>(page, `/projects/${project.id}/workboard`); expect(after.columns.find(column => column.name === 'Ready')?.cards.cards.map(card => card.id)).toEqual([task.id]);
});

test('workboard card pages append once and preserve query filters', async ({ page, request, baseURL }, info) => {
  const project = await create<Project>(request, baseURL!, '/projects', { name: `Paged board ${info.project.name} ${Date.now()}` });
  for (let index = 0; index < 53; index++) await create<Task>(request, baseURL!, '/tasks', { title: `Board task ${index}`, projectIds: [project.id], status: index === 52 ? 'resolved' : 'open' });
  await openBoard(page, project); await enable(page); const column = page.getByRole('region', { name: 'Column Backlog', exact: true });
  await expect(column.locator('.workboard-card')).toHaveCount(50); await expect(column).toContainText('52 visible'); await column.getByRole('button', { name: 'Load More Cards', exact: true }).click(); await expect(column.locator('.workboard-card')).toHaveCount(52);
  await page.getByLabel('Board tasks', { exact: true }).selectOption('all'); await expect(column.locator('.workboard-card')).toHaveCount(50); await expect(column).toContainText('53 visible'); await column.getByRole('button', { name: 'Load More Cards', exact: true }).click(); await expect(column.locator('.workboard-card')).toHaveCount(53);
  await page.getByLabel('Board assignment', { exact: true }).selectOption('mine'); await expect(column.locator('.workboard-card')).toHaveCount(0); await expect(column).toContainText('0 visible');
});

test('milestone workboard columns inherit identity and ordinary child boards remain separate', async ({ page, request, baseURL }, info) => {
  const project = await create<Project>(request, baseURL!, '/projects', { name: `Hierarchy board ${info.project.name} ${Date.now()}` });
  await page.goto('./#projects');
  const milestonePreview = await api<ProjectChildPreview>(page, `/projects/${project.id}/children/preview?kind=milestone`);
  const milestone = await api<Project>(page, '/projects', 'POST', { parentId: project.id, kind: 'milestone', name: 'Publication', expectedParentVersion: milestonePreview.expectedParentVersion, expectedHierarchyVersion: milestonePreview.expectedHierarchyVersion, expectedParentMembersVersion: milestonePreview.expectedParentMembersVersion });
  const childPreview = await api<ProjectChildPreview>(page, `/projects/${project.id}/children/preview?kind=project`);
  const child = await api<Project>(page, '/projects', 'POST', { parentId: project.id, kind: 'project', name: `Independent research ${info.project.name} ${Date.now()}`, expectedParentVersion: childPreview.expectedParentVersion, expectedHierarchyVersion: childPreview.expectedHierarchyVersion, expectedParentMembersVersion: childPreview.expectedParentMembersVersion, confirmMembershipConversion: true });
  const task = await create<Task>(request, baseURL!, '/tasks', { title: 'Move into the milestone', projectIds: [project.id] });
  const childTask = await create<Task>(request, baseURL!, '/tasks', { title: 'Child board only', projectIds: [child.id] });
  await openBoard(page, project); await enable(page); await expect(page.getByRole('article', { name: `${childTask.id} ${childTask.title}`, exact: true })).toHaveCount(0);
  await move(page, task, milestone.displayName); await page.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toHaveCount(0); await selectColumn(page, milestone.displayName);
  const proxy = page.getByRole('region', { name: `Column ${milestone.displayName}`, exact: true }); await expect(proxy.getByRole('link', { name: 'Milestone Profile', exact: true })).toHaveAttribute('href', `#${milestone.id}`);
  await proxy.getByRole('button', { name: 'Edit Card Limit', exact: true }).click(); await expect(page.getByLabel('Column name', { exact: true })).toBeDisabled(); await page.getByLabel('Advisory card limit', { exact: true }).fill('0'); await page.getByRole('button', { name: 'Review Column', exact: true }).click(); await confirmBoard(page); await expect(proxy).toContainText('Advisory card limit exceeded');
  await expect(page.getByRole('link', { name: child.name, exact: true })).toHaveAttribute('href', `#${child.id}/workboard`); expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.projectIds).toEqual([milestone.id]);
  await proxy.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -100)); await page.screenshot({ path: info.outputPath('workboard-milestone.png') });
});

async function signIn(page: Page, index: number) { await page.goto(`http://127.0.0.1:4312${base}#projects`); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName); }
test('board viewers move only editable tasks and lose cached cards immediately after access revocation', async ({ page, browser }, info) => {
  await signIn(page, 0); const state = await api<AppState>(page, '/state'); const alice = state.currentPrincipalId; const bob = state.principals.find(person => person.username === 'bob')!.id;
  const project = await api<Project>(page, '/projects', 'POST', { name: `Board access ${info.project.name} ${Date.now()}`, access: { spaceId: 'S1', edit: { kind: 'principals', principalIds: [alice] } } });
  const movable = await api<Task>(page, '/tasks', 'POST', { title: 'Bob can move this', projectIds: [project.id] }); const readonly = await api<Task>(page, '/tasks', 'POST', { title: 'Bob cannot move this', projectIds: [project.id], access: { spaceId: 'S1', edit: { kind: 'principals', principalIds: [alice] } } });
  await api<WorkboardReceipt>(page, `/projects/${project.id}/workboard`, 'PUT', { enabled: true, expectedBoardVersion: 0 }); const before = await api<WorkboardDetail>(page, `/projects/${project.id}/workboard`); await api(page, `/projects/${project.id}/workboard/columns`, 'POST', { name: 'Moved', expectedBoardVersion: before.board.version });
  const context = await browser.newContext({ viewport: page.viewportSize()! }); const viewer = await context.newPage();
  try { await signIn(viewer, 1); await viewer.goto(`http://127.0.0.1:4312${base}#${project.id}/workboard`); await expect(viewer.getByRole('article', { name: `${movable.id} ${movable.title}`, exact: true })).toBeVisible(); await expect(viewer.getByRole('button', { name: 'Add Column', exact: true })).toHaveCount(0); await expect(viewer.getByRole('article', { name: `${readonly.id} ${readonly.title}`, exact: true }).getByRole('button', { name: 'Move Card', exact: true })).toHaveCount(0);
    await move(viewer, movable, 'Moved'); await viewer.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(viewer.locator('.workboard-move-editor')).toHaveCount(0); await selectColumn(viewer, 'Moved'); await expect(viewer.getByRole('article', { name: `${movable.id} ${movable.title}`, exact: true })).toBeVisible();
    const policy = await api<ObjectAccess>(page, `/policies/${movable.id}`); await api(page, `/policies/${movable.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: 'S1', ...policy.policy.rules, view: { kind: 'principals', principalIds: [alice] } });
    await viewer.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(viewer.getByRole('article', { name: `${movable.id} ${movable.title}`, exact: true })).toHaveCount(0); await expect(viewer.locator('.workboard-columns')).not.toContainText(movable.title);
    expect(await viewer.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':workboard:')))).toEqual([]); expect(bob).not.toBe(alice);
  } finally { await context.close(); }
});

test('a lost move response retries the exact submitted request after the board advances', async ({ page, request, baseURL }, info) => {
  const project = await create<Project>(request, baseURL!, '/projects', { name: `Move receipt ${info.project.name} ${Date.now()}` });
  const task = await create<Task>(request, baseURL!, '/tasks', { title: 'One committed move', projectIds: [project.id] });
  await openBoard(page, project); await enable(page); await addColumn(page, 'Saved'); await selectColumn(page, 'Backlog'); await move(page, task, 'Saved');
  const requests: { body: unknown; key: string | undefined }[] = []; let first = true;
  await page.route(new URL(`api/projects/${project.id}/workboard/moves`, baseURL!).href, async route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (first) { first = false; const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort('failed'); }
    else await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Confirm Move Card', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry Submitted Move', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Reload Board', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toContainText('original versions are preserved');
    await page.getByRole('button', { name: 'Retry Submitted Move', exact: true }).click(); await expect(page.locator('.workboard-move-editor')).toHaveCount(0);
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]!.key).toBeTruthy();
    const detail = await api<TaskDetail>(page, `/tasks/${task.id}`); expect(detail.history.transactions.filter(row => row.kind === 'column')).toHaveLength(1);
    // Explicit reload also verifies the authorities of newly created cards.
    const added = await create<Task>(request, baseURL!, '/tasks', { title: 'Created in another tab', projectIds: [project.id] });
    await page.getByRole('button', { name: 'Reload Board', exact: true }).click(); await selectColumn(page, 'Backlog');
    const card = page.getByRole('article', { name: `${added.id} ${added.title}`, exact: true }); await expect(card.getByRole('button', { name: 'Move Card', exact: true })).toBeEnabled();
    await card.getByRole('button', { name: 'Move Card', exact: true }).click(); await expect(page.getByRole('button', { name: 'Review Move', exact: true })).toBeEnabled(); await expect(page.locator('.workboard-move-editor')).not.toContainText('set aside');
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

async function prepareImportSource(page: Page, name: string) {
  const project = await api<Project>(page, '/projects', 'POST', { name });
  await api(page, `/projects/${project.id}/workboard`, 'PUT', { enabled: true, expectedBoardVersion: 0 });
  let board = await api<WorkboardDetail>(page, `/projects/${project.id}/workboard`);
  await api(page, `/projects/${project.id}/workboard/columns`, 'POST', { name: 'Peer Review', pointLimit: 2, expectedBoardVersion: board.board.version });
  board = await api<WorkboardDetail>(page, `/projects/${project.id}/workboard`);
  return { project, board };
}
async function previewImport(page: Page, source: Project) {
  await page.getByRole('button', { name: 'Import Columns', exact: true }).click(); await page.getByLabel('Source project', { exact: true }).selectOption(source.id); await page.getByRole('button', { name: 'Preview Columns', exact: true }).click(); await expect(page.getByRole('region', { name: 'Column import preview', exact: true })).toBeVisible();
}

test('column import previews a disabled archived source and copies only its configuration into an untouched target', async ({ page }, info) => {
  await page.goto('./#projects'); const marker = `${info.project.name} ${Date.now()}`;
  const { project: source } = await prepareImportSource(page, `Import source ${marker}`);
  const sourceTask = await api<Task>(page, '/tasks', 'POST', { title: `Source-only task ${marker}`, projectIds: [source.id] });
  let board = await api<WorkboardDetail>(page, `/projects/${source.id}/workboard`);
  await api(page, `/projects/${source.id}/workboard/columns/${board.columns.find(column => column.isDefault)!.id}`, 'PATCH', { pointLimit: 0, expectedBoardVersion: board.board.version });
  board = await api<WorkboardDetail>(page, `/projects/${source.id}/workboard`);
  await api(page, `/projects/${source.id}/workboard/columns`, 'POST', { name: 'Hidden source column', expectedBoardVersion: board.board.version });
  board = await api<WorkboardDetail>(page, `/projects/${source.id}/workboard`);
  await api(page, `/projects/${source.id}/workboard/columns/${board.columns.find(column => column.name === 'Hidden source column')!.id}`, 'PATCH', { hidden: true, expectedBoardVersion: board.board.version });
  board = await api<WorkboardDetail>(page, `/projects/${source.id}/workboard`);
  await api(page, `/projects/${source.id}/workboard/columns/${board.columns.find(column => column.name === 'Peer Review')!.id}/reorder`, 'POST', { position: { edge: 'start' }, expectedBoardVersion: board.board.version });
  board = await api<WorkboardDetail>(page, `/projects/${source.id}/workboard`);
  await api(page, `/projects/${source.id}/workboard`, 'PUT', { enabled: false, expectedBoardVersion: board.board.version });
  await api(page, `/projects/${source.id}`, 'PATCH', { status: 'archived', expectedVersion: source.version });
  const target = await api<Project>(page, '/projects', 'POST', { name: `Import target ${marker}` }); const targetTask = await api<Task>(page, '/tasks', 'POST', { title: `Existing target task ${marker}`, projectIds: [target.id] });
  await openBoard(page, target); let writes = 0; page.on('request', request => { if (request.url().endsWith(`/projects/${target.id}/workboard/import`) && request.method() === 'POST') writes++; });
  await previewImport(page, source); const preview = page.getByRole('region', { name: 'Column import preview', exact: true });
  await expect(preview.locator('li strong')).toHaveText(['Peer Review', 'Backlog']); await expect(preview).toContainText('Advisory card limit: 2'); await expect(preview).toContainText('Default column · Advisory card limit: 0'); await expect(preview).not.toContainText('Hidden source column'); expect(writes).toBe(0);
  const confirm = page.getByRole('button', { name: 'Confirm Import Columns', exact: true }); await confirm.evaluate(element => element.scrollIntoView({ block: 'center' })); if (info.project.name === 'mobile') { const box = await confirm.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.y).toBeGreaterThan(100); expect(box!.y + box!.height).toBeLessThan(785); } await page.screenshot({ path: info.outputPath('column-import-preview.png') });
  await confirm.click(); await expect(page.getByRole('region', { name: 'Import workboard columns', exact: true })).toHaveCount(0); expect(writes).toBe(1); await selectColumn(page, 'Backlog');
  await expect(page.getByRole('article', { name: `${targetTask.id} ${targetTask.title}`, exact: true })).toBeVisible(); await expect(page.getByRole('article', { name: `${sourceTask.id} ${sourceTask.title}`, exact: true })).toHaveCount(0);
  const imported = await api<WorkboardDetail>(page, `/projects/${target.id}/workboard`); expect(imported.columns.map(column => [column.name, column.isDefault, column.pointLimit])).toEqual([['Peer Review', false, 2], ['Backlog', true, 0]]);
  await page.getByRole('button', { name: 'Show Board History', exact: true }).click(); await expect(page.locator('.workboard-history')).toContainText(`Imported 2 columns from ${source.id}`); await expect(page.locator('.workboard-history')).toContainText('Initial advisory card limit: 0');
  await expect(page.getByRole('button', { name: 'Import Columns', exact: true })).toHaveCount(0);
});

test('column imports keep stale source pins and retry a lost response with exactly the submitted request', async ({ page }, info) => {
  await page.goto('./#projects'); const marker = `${info.project.name} ${Date.now()}`; const { project: source, board } = await prepareImportSource(page, `Pinned source ${marker}`); const target = await api<Project>(page, '/projects', 'POST', { name: `Pinned target ${marker}` });
  await openBoard(page, target); await previewImport(page, source); const preview = page.getByRole('region', { name: 'Column import preview', exact: true });
  await api(page, `/projects/${source.id}/workboard/columns/${board.columns.find(column => column.name === 'Peer Review')!.id}`, 'PATCH', { name: 'Updated Review', expectedBoardVersion: board.board.version });
  const staleResponse = page.waitForResponse(response => response.url().endsWith(`/projects/${target.id}/workboard/import`) && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Confirm Import Columns', exact: true }).click(); const conflict = await staleResponse; expect(conflict.status()).toBe(409); expect(conflict.request().postDataJSON()).toMatchObject({ expectedSourceBoardVersion: board.board.version, expectedBoardVersion: 0 });
  await expect(preview).toContainText('Peer Review'); await expect(preview).not.toContainText('Updated Review'); await expect(page.getByRole('region', { name: 'Import workboard columns', exact: true }).getByRole('alert')).toBeVisible();
  page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Load New Import Preview', exact: true }).click(); await expect(preview).toContainText('Updated Review');
  const requests: { body: unknown; key: string | undefined }[] = []; let loseResponse = true;
  await page.route(`**/api/projects/${target.id}/workboard/import`, async route => { requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] }); if (loseResponse) { loseResponse = false; const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed'); } else await route.continue(); });
  try {
    await page.getByRole('button', { name: 'Confirm Import Columns', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry Submitted Import', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Reload Board', exact: true }).click(); await expect(page.getByRole('region', { name: 'Import workboard columns', exact: true })).toContainText('The target board changed');
    await page.getByRole('button', { name: 'Retry Submitted Import', exact: true }).click(); await expect(page.getByRole('region', { name: 'Import workboard columns', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]!.key).toBeTruthy();
    const imported = await api<WorkboardDetail>(page, `/projects/${target.id}/workboard`); expect(imported.columns.map(column => column.name)).toEqual(['Backlog', 'Updated Review']);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('source revocation clears import previews and rejects a late preview without hiding its target', async ({ page, browser }, info) => {
  await signIn(page, 0); const state = await api<AppState>(page, '/state'); const alice = state.currentPrincipalId; const marker = `${info.project.name} ${Date.now()}`;
  const { project: source } = await prepareImportSource(page, `Private import source ${marker}`); const target = await api<Project>(page, '/projects', 'POST', { name: `Visible import target ${marker}` });
  const context = await browser.newContext({ viewport: page.viewportSize()! });
  await context.addInitScript(() => {
    const held = { enabled: false, ready: false, released: false, release: () => {} }; const gate = new Promise<void>(resolve => { held.release = resolve; }); (window as unknown as { heldImport: typeof held }).heldImport = held;
    const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args); const input = args[0]; const url = new URL(input instanceof Request ? input.url : String(input), location.href); if (held.enabled && url.pathname.endsWith('/workboard/import-preview')) { const json = response.json.bind(response); response.json = async () => { const body: unknown = await json(); held.ready = true; await gate; held.released = true; return body; }; } return response; };
  });
  const viewer = await context.newPage();
  try {
    await signIn(viewer, 1); await viewer.goto(`http://127.0.0.1:4312${base}#${target.id}/workboard`); await previewImport(viewer, source);
    await viewer.evaluate(() => { (window as unknown as { heldImport: { enabled: boolean } }).heldImport.enabled = true; }); await viewer.getByRole('button', { name: 'Load New Import Preview', exact: true }).click(); await expect.poll(() => viewer.evaluate(() => (window as unknown as { heldImport: { ready: boolean } }).heldImport.ready)).toBe(true);
    const policy = await api<ObjectAccess>(page, `/policies/${source.id}`); await api(page, `/policies/${source.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: 'S1', ...policy.policy.rules, view: { kind: 'principals', principalIds: [alice] } });
    await viewer.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(viewer.getByRole('region', { name: 'Column import preview', exact: true })).toHaveCount(0);
    await viewer.evaluate(() => (window as unknown as { heldImport: { release: () => void } }).heldImport.release()); await expect.poll(() => viewer.evaluate(() => (window as unknown as { heldImport: { released: boolean } }).heldImport.released)).toBe(true);
    await expect(viewer.getByRole('region', { name: 'Column import preview', exact: true })).toHaveCount(0); await expect(viewer.getByRole('region', { name: 'Import workboard columns', exact: true })).not.toContainText(source.name);
    await expect(viewer.getByRole('heading', { level: 1 })).toContainText(target.name); await expect(viewer.getByRole('button', { name: 'Preview Columns', exact: true })).toHaveCount(0); await expect(viewer.getByRole('button', { name: 'Load New Import Preview', exact: true })).toBeDisabled(); expect((await api<WorkboardDetail>(page, `/projects/${target.id}/workboard`)).board.version).toBe(0);
  } finally { await context.close(); }
});
