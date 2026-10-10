import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import type { AppState, Project, Task, TaskDetail } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { authAccounts } from './auth-fixture';

const base = normalizeBasePath(process.env.APP_BASE_PATH);
async function api<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
  return page.evaluate(async ({ base, path, method, body }) => {
    const session = await (await fetch(`${base}api/session`)).json() as { sessionContext: string | null; csrfToken: string | null };
    const headers: Record<string, string> = {};
    if (session.sessionContext) headers['X-Session-Context'] = session.sessionContext;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken; }
    const response = await fetch(`${base}api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`); return data;
  }, { base, path, method, body }) as Promise<T>;
}
async function signIn(page: Page, index: number) {
  await page.goto(`http://127.0.0.1:4312${base}#home`);
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}
async function projects(page: Page, info: TestInfo) {
  const marker = `${info.project.name} ${Date.now()}`;
  const result: Project[] = [];
  for (const label of ['Research', 'Sources', 'Publication']) result.push(await api<Project>(page, '/projects', 'POST', { name: `${label} ${marker}` }));
  return result as [Project, Project, Project];
}
async function openFresh(page: Page, id: string) {
  await page.goto(`${page.url().split('#')[0]}#${id}`);
  const state = page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.reload(); await state;
  await expect(page.getByRole('heading', { level: 1 })).toContainText(id);
}
async function tagAction(page: Page, action: 'Add' | 'Remove' | 'Replace All', selected: Project[], deselected: Project[] = []) {
  const panel = page.locator('.task-project-panel');
  await panel.getByRole('button', { name: `${action} Project Tags`, exact: true }).click();
  for (const project of deselected) await panel.getByRole('checkbox', { name: project.name, exact: true }).uncheck();
  for (const project of selected) await panel.getByRole('checkbox', { name: project.name, exact: true }).check();
  await panel.getByRole('button', { name: 'Review Project Tags', exact: true }).click();
  return panel;
}
async function saveTags(page: Page) {
  const panel = page.locator('.task-project-panel');
  await panel.getByRole('button', { name: 'Save Project Tags', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add Project Tags', exact: true })).toBeVisible();
}

test('multiple project tags support creation, deltas, explicit replacement, project pages, search and voice filters', async ({ page }, info) => {
  await page.goto('./#tasks'); const [a, b, c] = await projects(page, info);
  await page.reload(); await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog'); const title = `Tagged manuscript ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('checkbox', { name: a.name, exact: true }).check();
  await dialog.getByRole('checkbox', { name: b.name, exact: true }).check();
  const creation = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  const task = await (await creation).json() as Task; expect(new Set(task.projectIds)).toEqual(new Set([a.id, b.id]));
  await page.getByRole('link', { name: `${task.id} ${title}`, exact: true }).click();
  const panel = page.locator('.task-project-panel');
  await expect(panel.locator('.card-body > .task-project-chips')).toContainText(a.name);
  await expect(panel.locator('.card-body > .task-project-chips')).toContainText(b.name);
  await tagAction(page, 'Add', [c]); await saveTags(page);
  await expect(panel.locator('.card-body > .task-project-chips')).toContainText(c.name);
  await tagAction(page, 'Remove', [a]); await saveTags(page);
  await expect(panel.locator('.card-body > .task-project-chips')).not.toContainText(a.name);
  await tagAction(page, 'Replace All', [a], [b, c]);
  await expect(panel.locator('.banner.warning')).toContainText('including tags you cannot see');
  const preview = panel.getByRole('region', { name: 'Review project tag changes', exact: true });
  await expect(preview).toContainText('task version 3');
  await expect(preview).toContainText('including tags hidden by access rules');
  await preview.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const save = panel.getByRole('button', { name: 'Save Project Tags', exact: true });
  const saveBounds = await save.boundingBox(); const headerBounds = await page.locator('.topbar').boundingBox();
  const navigationBounds = info.project.use.isMobile ? await page.locator('.mobile-tabs').boundingBox() : null;
  expect(saveBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
  expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(navigationBounds?.y ?? page.viewportSize()!.height);
  expect(await save.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  await page.screenshot({ path: `.data/${info.project.name}-task-project-replacement.png` });
  await saveTags(page);
  const detail = await api<TaskDetail>(page, `/tasks/${task.id}`); expect(detail.task.projectIds).toEqual([a.id]);
  await expect(page.locator('.transaction-project')).toHaveCount(5);
  for (const [project, action] of [[c, 'added'], [a, 'removed'], [b, 'removed'], [c, 'removed'], [a, 'added']] as const) await expect(page.locator('.transaction-project').filter({ hasText: `Project tag ${action}: ${project.name}.` })).toHaveCount(1);
  await page.goto('./#projects');
  const card = page.locator('.panel').filter({ has: page.getByRole('heading', { name: a.name, exact: true }) });
  await expect(card.locator('.card-meta')).toContainText('1 tasks');
  await card.getByRole('button', { name: 'View tagged tasks', exact: true }).click();
  await expect(page.getByLabel('Project tag filter', { exact: true })).toHaveValue(a.id);
  await expect(page.getByRole('link', { name: `${task.id} ${title}`, exact: true })).toBeVisible();
  await page.getByLabel('Project tag filter', { exact: true }).selectOption(b.id);
  await expect(page.getByRole('link', { name: `${task.id} ${title}`, exact: true })).toHaveCount(0);
  await page.getByLabel('Project tag filter', { exact: true }).selectOption('all');
  const search = page.getByLabel('Search workspace', { exact: true });
  await expect(search).toBeVisible();
  if (info.project.use.isMobile) {
    const bounds = await search.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await search.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element; })).toBe(true);
  }
  await search.fill(a.name);
  await expect(page.getByRole('link', { name: `${task.id} ${title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill(`show tasks in project ${a.name}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByLabel('Project tag filter', { exact: true })).toHaveValue(a.id);
  await expect(page.locator('.command-feedback')).toContainText(`Showing tasks tagged with ${a.name}`);
  await page.getByLabel('Workspace command', { exact: true }).fill('show tasks in project unavailable-project');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.command-feedback')).toContainText('unavailable or ambiguous');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('offline project tags replay exactly once with their original version and stale changes remain recoverable', async ({ page, context }, info) => {
  await page.goto('./#tasks'); const [a, b] = await projects(page, info);
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Offline tags ${info.project.name} ${Date.now()}`, projectIds: [a.id] });
  await openFresh(page, task.id);
  await tagAction(page, 'Add', [b]); await context.setOffline(true); await saveTags(page);
  await page.getByRole('button', { name: 'Offline outbox, 1 pending changes', exact: true }).click();
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('"expectedVersion": 1');
  await expect(page.locator('.outbox-item pre')).toContainText(b.id);
  const requests: string[] = []; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/tasks/${task.id}/projects`)) requests.push(request.headers()['idempotency-key']!); });
  await context.setOffline(false); await expect(page.getByRole('button', { name: 'Offline outbox, 0 pending changes', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  let detail = await api<TaskDetail>(page, `/tasks/${task.id}`); expect(new Set(detail.task.projectIds)).toEqual(new Set([a.id, b.id]));
  expect(detail.history.transactions.filter(item => item.project?.projectId === b.id && item.project.action === 'added')).toHaveLength(1);
  await openFresh(page, task.id); await tagAction(page, 'Remove', [a]); await context.setOffline(true); await saveTags(page);
  const changed = await page.request.patch(`http://127.0.0.1:4311${base}api/tasks/${task.id}`, { headers: { Origin: 'http://127.0.0.1:4311' }, data: { title: 'Server changed during offline tag edit', expectedVersion: 2 } }); expect(changed.ok()).toBe(true);
  await page.getByRole('button', { name: 'Offline outbox, 1 pending changes', exact: true }).click();
  await context.setOffline(false); await expect(page.locator('.outbox-item .error-text')).toContainText(/version|changed|conflict/i);
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('"expectedVersion": 2');
  detail = await api<TaskDetail>(page, `/tasks/${task.id}`); expect(new Set(detail.task.projectIds)).toEqual(new Set([a.id, b.id]));
});

test('add and remove preserve unseen project tags while an explicit replacement removes omitted hidden tags', async ({ page, browser }, info) => {
  await signIn(page, 0); const [secret, visible, extra] = await projects(page, info);
  const state = await api<AppState>(page, '/state'); const alice = state.principals.find(person => person.username === 'alice')!;
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Hidden tags ${info.project.name} ${Date.now()}`, projectIds: [secret.id, visible.id] });
  const policy = await api<ObjectAccess>(page, `/policies/${secret.id}`);
  await api(page, `/policies/${secret.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: policy.policy.spaceId, view: { kind: 'principals', principalIds: [alice.id] }, edit: policy.policy.rules.edit, interact: policy.policy.rules.interact });
  const bobContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor }); const bob = await bobContext.newPage();
  try {
    await signIn(bob, 1); await openFresh(bob, task.id);
    await expect(bob.locator('body')).not.toContainText(secret.name);
    await tagAction(bob, 'Add', [extra]); await saveTags(bob);
    expect(new Set((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.projectIds)).toEqual(new Set([secret.id, visible.id, extra.id]));
    await tagAction(bob, 'Remove', [visible]); await saveTags(bob);
    expect(new Set((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.projectIds)).toEqual(new Set([secret.id, extra.id]));
    await tagAction(bob, 'Replace All', [visible], [extra]);
    await expect(bob.locator('.task-project-panel .banner.warning')).toContainText('including tags you cannot see');
    await saveTags(bob); expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.projectIds).toEqual([visible.id]);
    await expect(bob.locator('.task-history')).not.toContainText(secret.name);
    await expect(bob.locator('.task-history')).not.toContainText(secret.id);
  } finally { await bobContext.close(); }
});

test('legacy mixed project field drafts are recovered whole while a title-only delta keeps its multiple tags', async ({ page }, info) => {
  await page.goto('./#tasks'); const [a, b] = await projects(page, info);
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Old tag draft ${info.project.name} ${Date.now()}`, projectIds: [a.id, b.id] });
  const other = await api<Task>(page, '/tasks', 'POST', { title: `Title-only legacy draft ${info.project.name} ${Date.now()}`, projectIds: [a.id, b.id] });
  await openFresh(page, task.id);
  await page.evaluate(({ task, other, projectId }) => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:task:${task.id}`)); if (!key) throw new Error('Expected cached task'); const prefix = key.slice(0, -`task:${task.id}`.length);
    localStorage.setItem(`${prefix}task-draft:${task.id}`, JSON.stringify({ ...task, projectIds: undefined, projectId, title: 'Keep all these old mixed changes', expectedVersion: task.version, changed: ['title', 'projectId'] }));
    localStorage.setItem(`${prefix}task-draft:${other.id}`, JSON.stringify({ ...other, projectIds: undefined, projectId, title: 'Title-only recovery remains editable', expectedVersion: other.version, changed: ['title'] }));
  }, { task, other, projectId: a.id });
  await page.reload(); await expect(page.locator('.quarantined-draft')).toContainText('older project replacement');
  await expect(page.locator('.quarantined-draft')).toContainText('Keep all these old mixed changes');
  await page.goto(`./#${other.id}`); await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Title-only recovery remains editable');
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${other.id}`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save Task', exact: true }).click();
  expect((await saved).request().postDataJSON()).toEqual({ title: 'Title-only recovery remains editable', expectedVersion: 1 });
  expect(new Set((await api<TaskDetail>(page, `/tasks/${other.id}`)).task.projectIds)).toEqual(new Set([a.id, b.id]));
  expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.title).toBe(task.title);
});

test('a delayed task creation never clears or closes a newer remounted draft with different project tags', async ({ page }, info) => {
  await page.goto('./#tasks'); const [a, b, c] = await projects(page, info);
  await page.reload(); await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const original = `Pending tagged task ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(original);
  await dialog.getByRole('checkbox', { name: a.name, exact: true }).check();
  await dialog.getByRole('checkbox', { name: b.name, exact: true }).check();
  let release!: () => void; let committed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const saved = new Promise<void>(resolve => { committed = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch(); committed(); await held; await route.fulfill({ response });
  });
  try {
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click(); await saved;
    await expect(dialog.getByRole('checkbox', { name: a.name, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Title', { exact: true }).fill('New draft after pending save');
    await dialog.getByRole('checkbox', { name: a.name, exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: c.name, exact: true }).check();
    release();
    await expect(page.locator('.banner.success')).toContainText('Task created');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('New draft after pending save');
    await expect(dialog.getByRole('checkbox', { name: a.name, exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: b.name, exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: c.name, exact: true })).toBeChecked();
    const preserved = await page.evaluate(() => { const key = Object.keys(localStorage).find(key => key.endsWith(':draft:task:new')); return JSON.parse(key ? localStorage.getItem(key)! : 'null') as { title: string; projectIds: string }; });
    expect(preserved.title).toBe('New draft after pending save'); expect(new Set(JSON.parse(preserved.projectIds))).toEqual(new Set([b.id, c.id]));
    const state = await api<AppState>(page, '/state'); const created = state.tasks.filter(task => task.title === original); expect(created).toHaveLength(1); expect(new Set(created[0]!.projectIds)).toEqual(new Set([a.id, b.id]));
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('New draft after pending save');
    await expect(dialog.getByRole('checkbox', { name: c.name, exact: true })).toBeChecked();
  } finally { release?.(); }
});
