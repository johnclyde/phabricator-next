import { test, expect, type Page } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import { normalizeProjectSlug } from '../shared/projects';
import type { AppState, Project, ProjectDetail, Task } from '../shared/types';
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
    const result: unknown = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`); return result;
  }, { base, path, method, body }) as Promise<T>;
}
async function openProject(page: Page, project: Project) {
  await page.goto(`${page.url().split('#')[0]}#${project.id}`);
  const loaded = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`) && response.request().method() === 'GET');
  await page.reload(); await loaded;
  await expect(page.getByRole('heading', { level: 1 })).toContainText(project.name);
  await expect(page.getByRole('button', { name: 'Edit Project', exact: true })).toBeEnabled();
}
async function signIn(page: Page, index: number) {
  await page.goto(`http://127.0.0.1:4312${base}#projects`);
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}

test('project profiles support creation, appearance, aliases, archiving, history and direct voice navigation', async ({ page }, info) => {
  const marker = `${info.project.name} ${Date.now()}`; const name = `Research ${marker}`;
  await page.goto('./#projects'); await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Description', { exact: true }).fill('Paper drafts and source evidence.');
  await dialog.getByLabel('Project icon', { exact: true }).selectOption('experimental');
  await dialog.getByLabel('Project color', { exact: true }).selectOption('violet');
  await dialog.getByLabel('Project aliases').fill(`Paper notes ${marker}`);
  const created = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create Project', exact: true }).click();
  const project = await (await created).json() as Project;
  await expect(dialog).not.toBeVisible();
  expect(project.icon).toBe('experimental'); expect(project.colorKey).toBe('violet');
  expect((await api<ProjectDetail>(page, `/projects/${project.id}`)).viewer.membership.active).toBe(false);
  await page.locator('.card-grid > .panel').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('link', { name: 'Open Project', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
  await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  const renamed = `Published ${marker}`;
  await page.getByLabel('Project name', { exact: true }).fill(renamed);
  await page.getByLabel('Project status', { exact: true }).selectOption('archived');
  await page.getByLabel('Project aliases', { exact: true }).fill(`Final notes ${marker}`);
  await page.getByRole('button', { name: 'Save Project', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(renamed);
  const detail = await api<ProjectDetail>(page, `/projects/${project.id}`);
  expect(detail.project.version).toBe(2); expect(detail.project.status).toBe('archived');
  expect(detail.project.aliases).toContain(project.primarySlug);
  expect(detail.project.aliases).toContain(normalizeProjectSlug(`Final notes ${marker}`));
  await page.getByLabel('Project description', { exact: true }).fill('A second consecutive profile update.');
  const secondSave = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save Project', exact: true }).click();
  const secondResult = await secondSave; expect(secondResult.status()).toBe(200);
  expect(secondResult.request().postDataJSON()).toMatchObject({ expectedVersion: 2 });
  await expect(page.locator('.project-editor')).toContainText('Based on version 3');
  await page.getByRole('button', { name: 'Close Editor', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.project-history')).toContainText('Edited project');
  await expect(page.locator('.project-history')).toContainText(name);
  await expect(page.locator('.project-history')).toContainText(renamed);
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await page.locator('.project-list-filters').getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toHaveCount(0);
  await page.locator('.project-list-filters').getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill(`open project ${project.id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(renamed);
  await page.getByRole('button', { name: 'Close voice panel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('project-profile.png'), fullPage: true });
});

test('project membership, independent watching and private silence survive reload and reject offline actions', async ({ page, context }, info) => {
  await page.goto('./#projects'); const project = await api<Project>(page, '/projects', 'POST', { name: `People ${info.project.name} ${Date.now()}` });
  await openProject(page, project); await page.getByRole('button', { name: 'Members & Watchers', exact: true }).click();
  page.on('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Join Project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Watch Project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop Watching Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Silence Project Notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable Project Notifications', exact: true })).toBeEnabled();
  let detail = await api<ProjectDetail>(page, `/projects/${project.id}`);
  expect(detail.viewer.membership.active).toBe(true); expect(detail.viewer.watching.active).toBe(true); expect(detail.viewer.silence.active).toBe(true);
  expect(detail.project.version).toBe(1); expect(detail.history.transactions.some(row => /silenc/i.test(JSON.stringify(row)))).toBe(false);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop Watching Project', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enable Project Notifications', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Leave Project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Join Project', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop Watching Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Members', exact: true }).click();
  await page.getByRole('group', { name: 'Selected project members', exact: true }).getByRole('checkbox', { name: 'You (@local)', exact: true }).check();
  await page.getByRole('button', { name: 'Review Members', exact: true }).click();
  const confirm = page.getByRole('region', { name: 'Confirm project membership', exact: true });
  await expect(confirm).toContainText('membership version 2');
  await confirm.getByRole('button', { name: 'Confirm Members', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toBeEnabled();
  await openProject(page, project); await page.getByRole('button', { name: 'Members & Watchers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Enable Project Notifications', exact: true })).toBeEnabled();
  detail = await api<ProjectDetail>(page, `/projects/${project.id}`); expect(detail.membersVersion).toBe(3); expect(detail.project.version).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('project-people.png'), fullPage: true });
});

test('offline project metadata preserves its original version, replays once and holds stale drafts', async ({ page, context }, info) => {
  await page.goto('./#projects'); const project = await api<Project>(page, '/projects', 'POST', { name: `Offline profile ${info.project.name} ${Date.now()}` });
  await openProject(page, project); await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  await page.getByLabel('Project description', { exact: true }).fill('An offline research description.');
  await context.setOffline(true); await page.getByRole('button', { name: 'Save Project', exact: true }).click();
  await page.getByRole('button', { name: 'Offline outbox, 1 pending changes', exact: true }).click();
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('"expectedVersion": 1');
  const writes: string[] = []; page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/projects/${project.id}`)) writes.push(request.headers()['idempotency-key']!); });
  await context.setOffline(false); await expect(page.getByRole('button', { name: 'Offline outbox, 0 pending changes', exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  let detail = await api<ProjectDetail>(page, `/projects/${project.id}`); expect(detail.project.description).toBe('An offline research description.'); expect(detail.project.version).toBe(2);
  await openProject(page, project); await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  await page.getByLabel('Project description', { exact: true }).fill('A conflicting offline manuscript plan.');
  await context.setOffline(true); await page.getByRole('button', { name: 'Save Project', exact: true }).click();
  const serverChange = await page.request.patch(`http://127.0.0.1:4311${base}api/projects/${project.id}`, { headers: { Origin: 'http://127.0.0.1:4311' }, data: { description: 'Newer server description.', expectedVersion: 2 } }); expect(serverChange.ok()).toBe(true);
  await page.getByRole('button', { name: 'Offline outbox, 1 pending changes', exact: true }).click();
  await context.setOffline(false); await expect(page.locator('.outbox-item .error-text')).toContainText(/version|changed|conflict/i);
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('"expectedVersion": 2');
  await expect(page.locator('.outbox-item pre')).toContainText('A conflicting offline manuscript plan.');
  detail = await api<ProjectDetail>(page, `/projects/${project.id}`); expect(detail.project.description).toBe('Newer server description.'); expect(detail.project.version).toBe(3);
});

// Membership must not make a related private task readable, or permit editing a
// project which explicitly restricts editors. Leaving may surrender member view.
test('member-only project access does not reveal tagged tasks and self-leave removes cached content', async ({ page, browser }, info) => {
  await signIn(page, 0); const state = await api<AppState>(page, '/state');
  const alice = state.principals.find(person => person.username === 'alice')!; const bob = state.principals.find(person => person.username === 'bob')!;
  const project = await api<Project>(page, '/projects', 'POST', { name: `Private membership ${info.project.name} ${Date.now()}`, description: 'Protected project marker.', memberIds: [bob.id], access: { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] }, edit: { kind: 'principals', principalIds: [alice.id] }, interact: { kind: 'principals', principalIds: [alice.id] }, join: { kind: 'principals', principalIds: [] } } });
  const task = await api<Task>(page, '/tasks', 'POST', { title: 'Protected tagged task marker.', projectIds: [project.id], access: { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } } });
  const bobContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor }); const other = await bobContext.newPage();
  try {
    await signIn(other, 1); await other.goto(`http://127.0.0.1:4312${base}#${project.id}`);
    await expect(other.getByRole('heading', { level: 1 })).toContainText(project.name);
    await expect(other.getByRole('button', { name: 'Edit Project', exact: true })).toHaveCount(0);
    await other.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(other.locator('.project-tasks')).not.toContainText(task.title);
    await other.getByRole('button', { name: 'Members & Watchers', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Add Members', exact: true })).toHaveCount(0);
    other.on('dialog', dialog => void dialog.accept());
    await other.getByRole('button', { name: 'Leave Project', exact: true }).click();
    await expect(other.locator('body')).not.toContainText(project.name);
    await expect(other.locator('body')).not.toContainText('Protected project marker.');
    await expect(other.locator('body')).toContainText(/access|saved/i);
    expect((await api<ProjectDetail>(page, `/projects/${project.id}`)).membersVersion).toBe(2);
    const policy = await api<ObjectAccess>(page, `/policies/${project.id}`); expect(policy.policy.kind).toBe('project');
    expect(await other.evaluate(() => JSON.stringify(localStorage).includes('Protected project marker.'))).toBe(false);
  } finally { await bobContext.close(); }
});
