import { test, expect } from '@playwright/test';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';
import { emptySearchQuery } from '../shared/search';
import type { DashboardList, DashboardReceipt, DashboardHomeDetail } from '../shared/dashboards';
import type { AppState, Task } from '../shared/types';

const nonce = (name: string) => `${name} ${crypto.randomUUID().slice(0, 8)}`;
test('dashboards create text and query panels, reorder accessibly, persist layouts and install a personal home', async ({ page }, info) => {
  await page.goto('./#home');
  const title = nonce('Research dashboard'), taskTitle = nonce('Dashboard index evidence');
  await api<Task>(page, '/tasks', { title: taskTitle, description: 'Visible dashboard task evidence.', priority: 'normal' });
  await page.goto('./#dashboards');
  await page.getByRole('button', { name: 'New dashboard', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Dashboard editor', exact: true });
  await editor.getByLabel('Dashboard name', { exact: true }).fill(title);
  await editor.getByRole('combobox', { name: 'Dashboard layout', exact: true }).selectOption('wide-left');
  await editor.getByRole('button', { name: 'Add text panel', exact: true }).click();
  await editor.getByLabel('Panel 1 title', { exact: true }).fill('Research notes');
  await editor.getByLabel('Panel 1 text', { exact: true }).fill('**Read the evidence** before revising the paper.');
  await editor.getByRole('button', { name: 'Add query panel', exact: true }).click();
  await editor.getByLabel('Panel 2 title', { exact: true }).fill('My matching tasks');
  await editor.getByLabel('Panel 2 search', { exact: true }).fill(`"${taskTitle}"`);
  await editor.getByRole('combobox', { name: 'Panel 2 application', exact: true }).selectOption('task');
  await editor.getByRole('combobox', { name: 'Panel 2 column', exact: true }).selectOption('1');
  await editor.getByRole('button', { name: 'Move panel 2 up', exact: true }).click();
  await expect(editor.getByLabel('Panel 1 title', { exact: true })).toHaveValue('My matching tasks');
  await editor.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'My matching tasks', exact: true }).getByRole('link', { name: new RegExp(taskTitle) })).toBeVisible();
  await expect(page.locator('.dashboard-layout-wide-left')).toBeVisible();
  const snapshot = await api<DashboardList>(page, '/dashboards'), dashboard = snapshot.dashboards.find(item => item.name === title)!;
  expect(dashboard.panels.map(panel => panel.title)).toEqual(['My matching tasks', 'Research notes']);
  await page.getByRole('button', { name: 'Use as my home', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Your home dashboard', exact: true })).toBeVisible();
  await page.goto('./#home'); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Edit dashboard', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.locator('.dashboards').screenshot({ path: info.outputPath('custom-dashboard.png') });
  await page.getByRole('button', { name: 'Use built-in home', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
});

test.describe('dashboard response recovery', () => {
  // A controlled worker can bypass page.route even for a request it does not
  // cache. The loss injection must run before asserting recovery behavior.
  test.use({ serviceWorkers: 'block' });
test('lost dashboard receipts recover the same request and preserve the created dashboard exactly once', async ({ page }) => {
  await page.goto('./#dashboards');
  const name = nonce('Recovered dashboard');
  let first = true; const bodies: unknown[] = [], keys: string[] = [];
  await page.route('**/api/dashboards', async intercepted => {
    if (intercepted.request().method() !== 'POST') return intercepted.continue();
    bodies.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!);
    if (first) { first = false; const response = await intercepted.fetch(); expect(response.ok()).toBe(true); return intercepted.abort('failed'); }
    return intercepted.continue();
  });
  await page.getByRole('button', { name: 'New dashboard', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Dashboard editor', exact: true });
  await editor.getByLabel('Dashboard name', { exact: true }).fill(name);
  await editor.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Retry exact dashboard request', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Retry exact dashboard request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry exact dashboard request', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
  expect((await api<DashboardList>(page, '/dashboards')).dashboards.filter(item => item.name === name)).toHaveLength(1);
});
});

test('shared dashboard panels search as their viewer and private dashboard withdrawal removes a selected home', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const title = nonce('Shared research'), secret = nonce('Owner only evidence');
    const initial = await api<AppState>(alice.page, '/state');
    const task = await api<Task>(alice.page, '/tasks', { title: secret, description: 'The dashboard must not expose this task to Bob.' });
    const taskPolicy = (await api<AppState>(alice.page, '/state')).access[task.id]!.policy;
    await api(alice.page, `/policies/${task.id}`, { expectedVersion: taskPolicy.version, spaceId: taskPolicy.spaceId, view: { kind: 'principals', principalIds: [initial.currentPrincipalId] }, edit: { kind: 'principals', principalIds: [initial.currentPrincipalId] }, interact: { kind: 'principals', principalIds: [initial.currentPrincipalId] } }, 'PUT');
    const state = await api<AppState>(alice.page, '/state');
    const definition = { name: title, description: '', visibility: 'workspace', layout: 'single', panels: [{ id: 'tasks', title: 'Task results', kind: 'query', column: 0, query: { ...emptySearchQuery(), kinds: ['task'], text: secret }, limit: 10 }], expectedAccessEpoch: state.accessEpoch };
    const created = await api<DashboardReceipt>(alice.page, '/dashboards', definition), id = created.dashboard!.id;
    await alice.page.goto(`./#dashboards/${id}`); await bob.page.goto(`./#dashboards/${id}`);
    await expect(alice.page.getByRole('region', { name: 'Task results', exact: true }).getByRole('link', { name: new RegExp(task.id) })).toBeVisible();
    await expect(bob.page.getByRole('region', { name: 'Task results', exact: true })).toContainText('No matching results visible to you.');
    await expect(bob.page.getByRole('button', { name: 'Edit dashboard', exact: true })).toHaveCount(0);
    await bob.page.getByRole('button', { name: 'Use as my home', exact: true }).click();
    const latest = await api<AppState>(alice.page, '/state');
    await api(alice.page, `/dashboards/${id}`, { ...definition, visibility: 'private', expectedVersion: 1, expectedAccessEpoch: latest.accessEpoch }, 'PUT');
    await bob.page.goto('./#home');
    await expect(bob.page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    expect((await api<DashboardHomeDetail>(bob.page, '/dashboard-home')).dashboard).toBeNull();
  } finally { await alice.context.close(); await bob.context.close(); }
});
