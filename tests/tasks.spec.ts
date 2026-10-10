import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import type { AppState, Project, Task, TaskDetail, TaskSubscriptionStatus } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { authAccounts } from './auth-fixture';

const base = normalizeBasePath(process.env.APP_BASE_PATH);
async function createTask(page: Page, info: TestInfo, label: string, description = 'Original description.', ownerId?: string) {
  await page.goto('./#tasks');
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `${label} ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Description', { exact: true }).fill(description);
  if (ownerId) await dialog.getByLabel('Owner', { exact: true }).selectOption(ownerId);
  const created = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  const task = await (await created).json() as Task;
  await expect(dialog).not.toBeVisible();
  await page.getByRole('link', { name: `${task.id} ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  return task;
}
async function api<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
  return page.evaluate(async ({ base, path, method, body }) => {
    const session = await (await fetch(`${base}api/session`)).json() as { sessionContext: string | null; csrfToken: string | null };
    const headers: Record<string, string> = {};
    if (session.sessionContext) headers['X-Session-Context'] = session.sessionContext;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken; }
    const response = await fetch(`${base}api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  }, { base, path, method, body }) as Promise<T>;
}
async function signIn(page: Page, index: number) {
  await page.goto(`http://127.0.0.1:4312${base}#home`);
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}

test('a cached task status waits for initial access verification and preserves its successful save', async ({ page }, info) => {
  const task = await createTask(page, info, 'Startup status');
  await page.goto('./#tasks');
  let releaseState!: () => void; let releaseOldest!: () => void; let holding = true; let heldReads = 0; let readIndex = 0;
  const stateGate = new Promise<void>(resolve => { releaseState = resolve; });
  const oldestGate = new Promise<void>(resolve => { releaseOldest = resolve; });
  const writes: unknown[] = [];
  await page.route('**/api/state', async route => {
    const oldest = readIndex++ === 0;
    const response = await route.fetch();
    if (holding) { heldReads++; await stateGate; }
    if (oldest) await oldestGate;
    await route.fulfill({ response, ...(oldest ? { headers: { ...response.headers(), 'X-Test-Delayed-State': 'oldest' } } : {}) });
  });
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/tasks/${task.id}`)) writes.push(request.postDataJSON()); });
  try {
    await page.reload();
    const status = page.getByRole('combobox', { name: `Status of ${task.id}: ${task.title}`, exact: true });
    await expect(status).toHaveValue('open');
    await expect.poll(() => heldReads).toBeGreaterThanOrEqual(2);
    await status.selectOption('resolved');
    await expect.poll(() => heldReads).toBeGreaterThanOrEqual(3);
    expect(writes).toEqual([]);
    holding = false; releaseState();
    await expect(status).toHaveValue('resolved');
    expect(writes).toEqual([{ status: 'resolved', expectedVersion: task.version }]);
    await expect(page.getByRole('status')).toContainText(`${task.id} updated`);
    const delayed = page.waitForResponse(response => response.headers()['x-test-delayed-state'] === 'oldest');
    releaseOldest(); await (await delayed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(status).toHaveValue('resolved');
    expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.endsWith(':state')).flatMap(key => (JSON.parse(localStorage.getItem(key)!) as AppState).tasks).find(item => item.id === id)?.status, task.id)).toBe('resolved');
    await page.reload(); await expect(status).toHaveValue('resolved');
  } finally { holding = false; releaseState(); releaseOldest(); }
});

test('task pages preserve exact field history, comments and manual dependencies with voice navigation', async ({ page }, info) => {
  const dependency = await createTask(page, info, 'Collect citations');
  const task = await createTask(page, info, 'Prepare manuscript', 'open');
  await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await page.getByLabel('Task description', { exact: true }).fill('resolved');
  await page.getByLabel('Task priority', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Save Task', exact: true }).click();
  await expect(page.locator('.task-detail-description')).toHaveText('resolved');
  const description = page.locator('.task-field-change').filter({ has: page.getByRole('heading', { name: 'Description', exact: true }) });
  await expect(description.locator('.task-change-values pre').first()).toHaveText('open');
  await expect(description.locator('.task-change-values pre').last()).toHaveText('resolved');
  await description.getByText('Show description diff', { exact: true }).click();
  await expect(description.locator('.task-description-diff del')).toHaveText('open');
  await expect(description.locator('.task-description-diff ins')).toHaveText('resolved');
  await page.getByLabel('Task comment', { exact: true }).fill('The bibliography needs another source.');
  await page.getByRole('button', { name: 'Add Task Comment', exact: true }).click();
  await expect(page.locator('.task-comment-body')).toHaveText('The bibliography needs another source.');
  await page.getByRole('combobox', { name: 'Task to depend on', exact: true }).selectOption(dependency.id);
  await page.getByRole('button', { name: 'Add Dependency', exact: true }).click();
  await expect(page.locator('.task-dependencies')).toContainText(dependency.title);
  await expect(page.locator('.transaction-dependency')).toContainText('Dependency added');
  await page.locator('.task-dependencies').getByRole('link', { name: `${dependency.id} ${dependency.title}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(dependency.title);
  await expect(page.locator('.task-dependencies')).toContainText(task.title);
  await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await page.getByLabel('Task status', { exact: true }).selectOption('resolved');
  await page.getByRole('button', { name: 'Save Task', exact: true }).click();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill(`open task${task.id.slice(1)}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(task.title);
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Open');
  await expect(page.locator('.task-dependencies .badge')).toHaveText('Resolved');
  await expect(page.locator('.transaction-dependency_status')).toContainText(`${dependency.id} changed from Open to Resolved`);
  await page.getByRole('button', { name: 'Close voice panel', exact: true }).click();
  const dependencyPanel = await page.locator('.task-dependency-panel').boundingBox();
  const dependencyColumn = await page.locator('.task-detail-layout > .right-column').boundingBox();
  expect(dependencyPanel!.width).toBeGreaterThanOrEqual(dependencyColumn!.width - 1);
  await page.locator('.task-dependency-panel').screenshot({ path: `.data/${info.project.name}-task-dependencies.png` });
  await page.locator('.task-history').screenshot({ path: `.data/${info.project.name}-task-history.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.reload();
  await expect(page.locator('.task-comment-body')).toHaveText('The bibliography needs another source.');
  await page.getByRole('button', { name: `Remove dependency ${dependency.id}`, exact: true }).click();
  await expect(page.locator('.task-dependencies')).toHaveCount(0);
  await expect(page.locator('.transaction-dependency').first()).toContainText('Dependency removed');
});

test('offline task updates keep their source version, conflict without overwriting, and older unversioned changes require recovery', async ({ page, context }, info) => {
  const task = await createTask(page, info, 'Offline task');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await context.setOffline(true);
  await page.getByLabel('Task description', { exact: true }).fill('My offline field edit.');
  await page.getByRole('button', { name: 'Save Task', exact: true }).click();
  await page.getByRole('button', { name: /Offline outbox, 1 pending/ }).click();
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('"expectedVersion": 1');
  await expect(page.locator('.outbox-item pre')).toContainText('My offline field edit.');
  const changed = await page.request.patch(`http://127.0.0.1:4311${base}api/tasks/${task.id}`, { headers: { Origin: 'http://127.0.0.1:4311' }, data: { expectedVersion: 1, description: 'A newer server edit.' } });
  expect(changed.ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.locator('.outbox-item .error-text')).toContainText(/changed|version|conflict/i);
  await expect(page.locator('.outbox-item pre')).toContainText('My offline field edit.');
  const current = await api<TaskDetail>(page, `/tasks/${task.id}`);
  expect(current.task.description).toBe('A newer server edit.');
  await page.evaluate(({ id, base }) => {
    const prefix = base === '/' ? 'phabricator-next:' : `phabricator-next:mount:${encodeURIComponent(base)}:`;
    const key = Object.keys(localStorage).find(key => key.endsWith(':outbox')) || `${prefix}outbox`;
    const entries = JSON.parse(localStorage.getItem(key) || '[]') as unknown[];
    localStorage.setItem(key, JSON.stringify([...entries, { id: 'old-unversioned-task-edit', path: `/api/tasks/${id}`, method: 'PATCH', body: { status: 'resolved' }, label: 'Old saved task change', createdAt: new Date().toISOString() }]));
  }, { id: task.id, base });
  await page.reload();
  await expect(page.locator('.quarantined-draft')).toContainText('no source version');
  await expect(page.locator('.quarantined-draft')).toContainText('Old saved task change');
  expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.status).toBe('open');
});

test('task relationship revocation clears loaded history while preserving unrelated drafts and a hidden project through field edits', async ({ page, browser }, info) => {
  await signIn(page, 0);
  const state = await api<AppState>(page, '/state');
  const alice = state.principals.find(principal => principal.username === authAccounts[0]!.username)!;
  const marker = `${info.project.name}-${Date.now()}`;
  const project = await api<Project>(page, '/projects', 'POST', { name: `Private project ${marker}`, description: 'Private project metadata' });
  const related = await api<Task>(page, '/tasks', 'POST', { title: `Secret related task ${marker}` });
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Visible parent ${marker}`, description: 'Shared task body', projectId: project.id });
  await api(page, `/tasks/${task.id}/dependencies`, 'POST', { taskId: related.id, action: 'add', expectedVersion: task.version });
  await api(page, `/tasks/${related.id}/merge`, 'POST', { taskId: task.id, expectedVersion: related.version + 1, expectedTargetVersion: task.version + 1 });
  const restrict = async (id: string) => { const access = await api<ObjectAccess>(page, `/policies/${id}`); await api(page, `/policies/${id}`, 'PUT', { expectedVersion: access.policy.version, spaceId: access.policy.spaceId, view: { kind: 'principals', principalIds: [alice.id] }, edit: access.policy.rules.edit, interact: access.policy.rules.interact }); };
  await restrict(project.id);
  const bobContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  const bob = await bobContext.newPage();
  try {
    await signIn(bob, 1);
    await bob.goto(`http://127.0.0.1:4312${base}#${task.id}`);
    await expect(bob.getByRole('heading', { level: 1 })).toContainText(task.title);
    await expect(bob.locator('.task-dependencies')).toContainText(related.title);
    await expect(bob.locator('.task-duplicate-links')).toContainText(related.title);
    await bob.getByRole('button', { name: 'Edit Task', exact: true }).click();
    await bob.getByLabel('Task title', { exact: true }).fill(`Edited visible parent ${marker}`);
    await bob.getByLabel('Task comment', { exact: true }).fill('Independent unsent comment survives a policy refresh.');
    await restrict(related.id);
    await bob.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob.locator('body')).not.toContainText(related.title);
    await expect(bob.locator('.task-history')).not.toContainText(related.id);
    await expect(bob.getByLabel('Task title', { exact: true })).toHaveValue(`Edited visible parent ${marker}`);
    await expect(bob.getByLabel('Task comment', { exact: true })).toHaveValue('Independent unsent comment survives a policy refresh.');
    await bob.getByRole('button', { name: 'Save Task', exact: true }).click();
    await expect(bob.getByRole('heading', { level: 1 })).toContainText(`Edited visible parent ${marker}`);
    const actual = await api<TaskDetail>(page, `/tasks/${task.id}`);
    expect(actual.task.projectIds).toContain(project.id);
    expect(actual.task.description).toBe('Shared task body');
    await bob.reload();
    await expect(bob.locator('body')).not.toContainText(related.title);
    await expect(bob.locator('.task-history')).not.toContainText(related.id);
  } finally { await bobContext.close(); }
});

test('discarding cross-tab recovery copies clears still-mounted task fields and comments instead of reviving them', async ({ page, context }, info) => {
  const task = await createTask(page, info, 'Recovery task');
  await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Discard this old field draft');
  await page.getByLabel('Task comment', { exact: true }).fill('Discard this old comment');
  const other = await context.newPage();
  await other.goto('./#home');
  await other.evaluate(id => {
    for (const draftKey of [`task-draft:${id}`, `task-comment:${id}`]) {
      const source = Object.keys(localStorage).find(key => key.endsWith(`:${draftKey}`));
      if (!source) throw new Error('Expected durable draft');
      const prefix = source.slice(0, -draftKey.length);
      localStorage.setItem(`${prefix}quarantined-drafts:${encodeURIComponent(draftKey)}`, JSON.stringify({ key: draftKey, objectId: id, value: JSON.parse(localStorage.getItem(source)!), reason: 'Cross-tab recovery hold' }));
    }
  }, task.id);
  await expect(page.locator('.quarantined-draft')).toHaveCount(2);
  await expect(page.getByLabel('Task title', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Task comment', { exact: true })).toBeDisabled();
  for (let index = 0; index < 2; index++) {
    page.once('dialog', dialog => void dialog.accept());
    await page.locator('.quarantined-draft').first().getByRole('button', { name: 'Discard Draft', exact: true }).click();
  }
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(task.title);
  await expect(page.getByLabel('Task comment', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save Task', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Task Comment', exact: true })).toBeDisabled();
  await other.close();
});

test('task ownership and following preserve automatic owner behavior, opt-out, offline boundaries and voice filters', async ({ page, context }, info) => {
  await page.goto('./#tasks');
  const state = await api<AppState>(page, '/state');
  const task = await createTask(page, info, 'Owned follow-up', 'Owner and following lifecycle.', state.currentPrincipalId);
  expect(task.ownerId).toBe(state.currentPrincipalId);
  await expect(page.locator('.task-assignment-panel')).toContainText('automatically has view, edit, and interact');
  await expect(page.locator('.task-following-status')).toHaveText('You follow automatically as the owner.');
  await expect(page.getByRole('button', { name: 'Unfollow Task', exact: true })).toBeDisabled();
  await page.locator('.task-assignment-panel').screenshot({ path: `.data/${info.project.name}-task-owner.png` });
  await page.locator('.task-subscribers').screenshot({ path: `.data/${info.project.name}-task-following.png` });
  await page.getByLabel('Task owner', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Change Owner', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm assignment' })).toContainText('Unassigned');
  await page.getByRole('button', { name: 'Confirm Assignment', exact: true }).click();
  await expect(page.locator('.task-owner')).toHaveText('Unassigned');
  await expect(page.locator('.task-following-status')).toHaveText('You are following this task.');
  await page.getByRole('button', { name: 'Unfollow Task', exact: true }).click();
  await expect(page.locator('.task-following-status')).toHaveText('You are not following this task.');
  await page.getByLabel('Task comment', { exact: true }).fill('Comment after an explicit opt-out.');
  await page.getByRole('button', { name: 'Add Task Comment', exact: true }).click();
  await expect(page.locator('.task-comment-body')).toHaveText('Comment after an explicit opt-out.');
  await expect(page.locator('.task-following-status')).toHaveText('You are not following this task.');
  await context.setOffline(true);
  await expect(page.getByLabel('Task owner', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Follow Task', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Follow Task', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Follow Task', exact: true }).click();
  await expect(page.locator('.task-following-status')).toHaveText('You are following this task.');
  await page.getByRole('button', { name: 'Assign to Me', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Assignment', exact: true }).click();
  await expect(page.locator('.task-following-status')).toHaveText('You follow automatically as the owner.');
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('show my tasks');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByLabel('Task assignment and following', { exact: true })).toHaveValue('mine');
  await expect(page.getByRole('link', { name: `${task.id} ${task.title}`, exact: true })).toBeVisible();
  await page.getByLabel('Task assignment and following', { exact: true }).selectOption('unassigned');
  await expect(page.getByRole('link', { name: `${task.id} ${task.title}`, exact: true })).toHaveCount(0);
  await page.getByLabel('Task assignment and following', { exact: true }).selectOption('following');
  await expect(page.getByRole('link', { name: `${task.id} ${task.title}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('an owner handoff that removes access keeps a delayed successful receipt and recovers other unsaved work', async ({ page, browser }, info) => {
  await signIn(page, 0);
  const state = await api<AppState>(page, '/state');
  const alice = state.principals.find(person => person.username === 'alice')!;
  const bobIdentity = state.principals.find(person => person.username === 'bob')!;
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Owner handoff ${info.project.name} ${Date.now()}`, ownerId: bobIdentity.id });
  const policy = await api<ObjectAccess>(page, `/policies/${task.id}`);
  const restricted = { kind: 'principals', principalIds: [alice.id] };
  await api(page, `/policies/${task.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: policy.policy.spaceId, view: restricted, edit: restricted, interact: restricted });
  const bobContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  const bob = await bobContext.newPage();
  let release!: () => void;
  try {
    await signIn(bob, 1); await bob.goto(`http://127.0.0.1:4312${base}#${task.id}`);
    await expect(bob.locator('.access-summary')).toContainText('Object rules cannot remove the owner');
    await bob.getByRole('button', { name: 'Edit Task', exact: true }).click();
    await bob.getByLabel('Task title', { exact: true }).fill('Retain this separate field draft');
    await bob.getByLabel('Task comment', { exact: true }).fill('Retain this unsent handoff comment');
    let committed!: () => void; const saved = new Promise<void>(resolve => { committed = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    await bob.route(`**/api/tasks/${task.id}`, async route => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const response = await route.fetch(); committed(); await held; await route.fulfill({ response });
    });
    await bob.getByLabel('Task owner', { exact: true }).selectOption(alice.id);
    await bob.getByRole('button', { name: 'Change Owner', exact: true }).click();
    await bob.getByRole('button', { name: 'Confirm Assignment', exact: true }).click();
    await saved;
    await bob.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await expect(bob.locator('.quarantined-draft')).toHaveCount(2);
    release();
    await expect(bob.locator('.banner.success')).toContainText('Assignment saved. You no longer have access');
    await expect(bob.locator('.quarantined-drafts')).toContainText('Retain this separate field draft');
    await expect(bob.locator('.quarantined-drafts')).toContainText('Retain this unsent handoff comment');
    expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.ownerId).toBe(alice.id);
    await bob.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => bob.evaluate(() => window.scrollY)).toBe(0);
    const receipt = await bob.locator('.banner.success').boundingBox();
    const topbar = await bob.locator('.topbar').boundingBox();
    expect(receipt!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height);
    await bob.screenshot({ path: `.data/${info.project.name}-task-handoff-receipt.png` });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { release?.(); await bobContext.close(); }
});

test('read-only members can follow themselves and stale membership changes require a refresh', async ({ page, browser }, info) => {
  await signIn(page, 0);
  const state = await api<AppState>(page, '/state');
  const alice = state.principals.find(person => person.username === 'alice')!;
  const bobIdentity = state.principals.find(person => person.username === 'bob')!;
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Following controls ${info.project.name} ${Date.now()}` });
  await page.goto(`http://127.0.0.1:4312${base}#${task.id}`);
  await page.getByLabel('Member to follow task', { exact: true }).selectOption(bobIdentity.id);
  await page.getByRole('button', { name: 'Add Follower', exact: true }).click();
  await expect(page.locator('.task-followers')).toContainText(bobIdentity.displayName);
  const policy = await api<ObjectAccess>(page, `/policies/${task.id}`);
  const restricted = { kind: 'principals', principalIds: [alice.id] };
  await api(page, `/policies/${task.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: policy.policy.spaceId, view: { kind: 'workspace' }, edit: restricted, interact: restricted });
  const bobContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  const bob = await bobContext.newPage();
  try {
    await signIn(bob, 1); await bob.goto(`http://127.0.0.1:4312${base}#${task.id}`);
    await expect(bob.getByRole('button', { name: 'Edit Task', exact: true })).toHaveCount(0);
    await expect(bob.getByLabel('Member to follow task', { exact: true })).toHaveCount(0);
    await bob.getByRole('button', { name: 'Unfollow Task', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Follow Task', exact: true })).toBeEnabled();
    const membership = await api<TaskSubscriptionStatus>(page, `/tasks/${task.id}/subscriptions/${encodeURIComponent(bobIdentity.id)}`);
    await api(page, `/tasks/${task.id}/subscriptions`, 'POST', { principalId: bobIdentity.id, action: 'subscribe', expectedMembershipVersion: membership.version });
    await bob.getByRole('button', { name: 'Follow Task', exact: true }).click();
    await expect(bob.locator('.task-subscribers [role="alert"]')).toContainText(/changed|version|conflict/i);
    await bob.getByRole('button', { name: 'Refresh Following', exact: true }).click();
    await expect(bob.locator('.task-following-status')).toHaveText('You are following this task.');
    expect((await api<TaskDetail>(page, `/tasks/${task.id}`)).task.version).toBe(task.version);
  } finally { await bobContext.close(); }
});

test('single and batch duplicate merges retain original tasks, text and relationships with explicit confirmations', async ({ page }, info) => {
  const destination = await createTask(page, info, 'Canonical issue');
  const first = await createTask(page, info, 'First duplicate', 'Retain the first original description.');
  const second = await createTask(page, info, 'Closed duplicate', 'Retain the second original description.');
  const dependency = await createTask(page, info, 'Dependency retained');
  await api(page, `/tasks/${first.id}/dependencies`, 'POST', { taskId: dependency.id, action: 'add', expectedVersion: first.version });
  await api(page, `/tasks/${first.id}/comments`, 'POST', { body: 'Original source discussion remains here.' });
  await api(page, `/tasks/${second.id}`, 'PATCH', { expectedVersion: second.version, status: 'resolved' });
  await page.goto(`./#${destination.id}`);
  const refreshedState = page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.reload(); await refreshedState;
  await page.getByRole('button', { name: 'Merge Duplicates In', exact: true }).click();
  const panel = page.locator('.task-duplicates');
  await panel.getByRole('checkbox', { name: `${first.id} ${first.title}`, exact: false }).check();
  await expect(panel.getByRole('checkbox', { name: `${second.id} ${second.title}`, exact: false })).toHaveCount(0);
  await panel.getByLabel('Include closed tasks', { exact: true }).check();
  await panel.getByRole('checkbox', { name: `${second.id} ${second.title}`, exact: false }).check();
  await panel.getByRole('button', { name: 'Review Merge', exact: true }).click();
  const confirmation = panel.getByRole('region', { name: 'Confirm duplicate merge', exact: true });
  await expect(confirmation).toContainText(`${first.id} ${first.title} · Version 2`);
  await expect(confirmation).toContainText(`${second.id} ${second.title} · Version 2`);
  await expect(confirmation).toContainText('including members who previously opted out');
  await confirmation.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const confirmBounds = await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).boundingBox();
  const topbarBounds = await page.locator('.topbar').boundingBox();
  const tabBounds = await page.locator('.mobile-tabs').boundingBox();
  expect(confirmBounds!.y).toBeGreaterThanOrEqual(topbarBounds!.y + topbarBounds!.height);
  expect(confirmBounds!.y + confirmBounds!.height).toBeLessThanOrEqual(tabBounds?.y ?? page.viewportSize()!.height);
  await page.screenshot({ path: `.data/${info.project.name}-task-merge-confirmation.png` });
  const merged = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${destination.id}/merge-in`) && response.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).click();
  expect((await merged).ok()).toBe(true);
  await expect(panel.locator('.task-duplicate-links')).toContainText(first.title);
  await expect(panel.locator('.task-duplicate-links')).toContainText(second.title);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(destination.title);
  await expect(page.locator('.transaction-merge')).toHaveCount(2);
  await panel.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const mergedPanelBounds = await panel.boundingBox();
  expect(mergedPanelBounds!.y).toBeGreaterThanOrEqual(topbarBounds!.y + topbarBounds!.height);
  expect(mergedPanelBounds!.y + mergedPanelBounds!.height).toBeLessThanOrEqual(tabBounds?.y ?? page.viewportSize()!.height);
  await page.screenshot({ path: `.data/${info.project.name}-task-merged-duplicates.png` });
  const retained = await api<TaskDetail>(page, `/tasks/${first.id}`);
  expect(retained.task.description).toBe(first.description);
  expect(retained.task.ownerId).toBe(first.ownerId);
  expect(retained.task.status).toBe('duplicate');
  expect(retained.dependsOn.map(task => task.id)).toEqual([dependency.id]);
  expect(retained.history.transactions.some(transaction => transaction.comment === 'Original source discussion remains here.')).toBe(true);
  await panel.locator('.task-duplicate-links').getByRole('link', { name: `${first.id} ${first.title}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(first.title);
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Duplicate');
  await expect(page.locator('.task-duplicate-links')).toContainText(destination.title);
  await page.getByRole('button', { name: 'Edit Task', exact: true }).click();
  await page.getByLabel('Task status', { exact: true }).selectOption('open');
  await page.getByLabel('Task status', { exact: true }).selectOption('duplicate');
  await expect(page.getByLabel('Task status', { exact: true })).toHaveValue('duplicate');
  await page.getByLabel('Task status', { exact: true }).selectOption('open');
  await page.getByRole('button', { name: 'Save Task', exact: true }).click();
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Open');
  await expect(page.locator('.task-duplicate-links')).toContainText(destination.title);
  await panel.getByRole('button', { name: 'Close As Duplicate', exact: true }).click();
  await panel.getByRole('radio', { name: `${destination.id} ${destination.title}`, exact: false }).check();
  await panel.getByRole('button', { name: 'Review Merge', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).click();
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Duplicate');
  await expect(panel.locator('.task-duplicate-links a')).toHaveCount(1);
  expect((await api<TaskDetail>(page, `/tasks/${destination.id}`)).duplicates.filter(task => task.id === first.id)).toHaveLength(1);
  const third = await createTask(page, info, 'Single duplicate');
  await page.getByRole('button', { name: 'Close As Duplicate', exact: true }).click();
  await panel.getByRole('radio', { name: `${destination.id} ${destination.title}`, exact: false }).check();
  await panel.getByRole('button', { name: 'Review Merge', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(third.title);
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Duplicate');
  await expect(panel.locator('.task-duplicate-links')).toContainText(destination.title);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('open tasks');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('show duplicate');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('link', { name: `${second.id} ${second.title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `${third.id} ${third.title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `${first.id} ${first.title}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('duplicate merge previews keep selected versions, reject stale writes and never submit offline', async ({ page, context }, info) => {
  const destination = await createTask(page, info, 'Merge target version');
  const source = await createTask(page, info, 'Merge source version');
  const panel = page.locator('.task-duplicates');
  await panel.getByRole('button', { name: 'Close As Duplicate', exact: true }).click();
  await panel.getByRole('radio', { name: `${destination.id} ${destination.title}`, exact: false }).check();
  await panel.getByRole('button', { name: 'Review Merge', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Confirm duplicate merge', exact: true })).toContainText(`${destination.id} ${destination.title} · Version 1`);
  await api(page, `/tasks/${destination.id}`, 'PATCH', { expectedVersion: 1, description: 'Changed after selection.' });
  const attempted = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${source.id}/merge`) && response.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).click();
  const conflict = await attempted; expect(conflict.status()).toBe(409);
  expect(conflict.request().postDataJSON()).toMatchObject({ expectedVersion: 1, expectedTargetVersion: 1 });
  await expect(panel.getByRole('alert')).toContainText(/changed|version|conflict/i);
  expect((await api<TaskDetail>(page, `/tasks/${source.id}`)).task.status).toBe('open');
  await panel.getByRole('button', { name: 'Cancel and Reload Tasks', exact: true }).click();
  await panel.getByRole('button', { name: 'Close As Duplicate', exact: true }).click();
  await panel.getByRole('radio', { name: `${destination.id} ${destination.title}`, exact: false }).check();
  await panel.getByRole('button', { name: 'Review Merge', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Confirm duplicate merge', exact: true })).toContainText(`${destination.id} ${destination.title} · Version 2`);
  await context.setOffline(true);
  await expect(panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Offline outbox, 0 pending changes', exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Confirm Duplicate Merge', exact: true }).click();
  await expect(page.locator('.task-page .page-heading .badge')).toHaveText('Duplicate');
});
