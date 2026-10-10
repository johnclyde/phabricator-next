import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import type { AppState, Project, ProjectDetail, Task } from '../shared/types';

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
  await page.goto(`./#${project.id}`); await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(project.displayName);
  await expect(page.getByRole('button', { name: 'Edit Project', exact: true })).toBeEnabled();
}
async function hierarchy(page: Page) { await page.getByRole('button', { name: 'Subprojects & Milestones', exact: true }).click(); }
async function viewControl(page: Page, buttonName: string, path: string) {
  const button = page.getByRole('button', { name: buttonName, exact: true });
  await button.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const bounds = await button.boundingBox(); const top = await page.locator('.topbar').boundingBox();
  const bottom = await page.locator('.mobile-tabs').isVisible() ? await page.locator('.mobile-tabs').boundingBox() : null;
  expect(bounds!.y).toBeGreaterThanOrEqual((top?.y || 0) + (top?.height || 0));
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(bottom?.y ?? page.viewportSize()!.height);
  await page.screenshot({ path });
}
async function prepareChild(page: Page, kind: 'project' | 'milestone', name: string) {
  await hierarchy(page);
  await page.getByRole('button', { name: kind === 'project' ? 'Create Subproject' : /^Create (?:Next )?Milestone$/, exact: kind === 'project' }).click();
  await page.getByRole('textbox', { name: kind === 'project' ? 'Subproject name' : 'Milestone name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Child project description', exact: true }).fill('Pinned hierarchy creation draft.');
  await page.getByRole('button', { name: 'Review Child Project', exact: true }).click();
}
async function confirmChild(page: Page, kind: 'project' | 'milestone'): Promise<Project> {
  const confirmation = page.getByRole('region', { name: 'Confirm child project', exact: true });
  const conversion = confirmation.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true });
  if (await conversion.count()) await conversion.check();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await confirmation.getByRole('button', { name: `Confirm Create ${kind === 'project' ? 'Subproject' : 'Milestone'}`, exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const project = await response.json() as Project;
  await expect(page.locator('.project-child-editor')).toHaveCount(0);
  return project;
}

test('project hierarchy converts first-child members, inherits milestones and watchers, and filters descendant task tags', async ({ page }, info) => {
  await page.goto('./#projects'); const state = await api<AppState>(page, '/state');
  const parent = await api<Project>(page, '/projects', 'POST', { name: `Parent ${info.project.name} ${Date.now()}`, colorKey: 'violet', memberIds: [state.currentPrincipalId] });
  await api(page, `/projects/${parent.id}/watchers`, 'POST', { principalId: state.currentPrincipalId, action: 'watch', expectedVersion: 0 });
  await openProject(page, parent);
  await prepareChild(page, 'project', `Writing team ${info.project.name} ${Date.now()}`);
  await expect(page.getByRole('region', { name: 'Confirm child project' })).toContainText('Move all 1 direct parent members');
  await expect(page.getByRole('button', { name: 'Confirm Create Subproject', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true }).check();
  await viewControl(page, 'Confirm Create Subproject', info.outputPath('first-child-conversion.png'));
  const child = await confirmChild(page, 'project');
  const converted = await api<ProjectDetail>(page, `/projects/${parent.id}`);
  expect(converted.project.membershipMode).toBe('descendants'); expect(converted.viewer.membership.version).toBeNull();
  await page.getByRole('button', { name: 'Members & Watchers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Join Project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Members', exact: true })).toHaveCount(0);
  await expect(page.locator('.project-source-links').getByRole('link', { name: child.displayName, exact: true })).toBeVisible();
  await prepareChild(page, 'milestone', 'First submission');
  await expect(page.getByRole('region', { name: 'Confirm child project' })).toContainText('inherits access and membership');
  await expect(page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true })).toHaveCount(0);
  const milestone = await confirmChild(page, 'milestone');
  expect(milestone.primarySlug).toBeNull(); expect(milestone.icon).toBe('milestone'); expect(milestone.colorKey).toBe('violet');
  await hierarchy(page); await page.locator('.project-hierarchy').getByRole('link').filter({ hasText: milestone.displayName }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('project-hierarchy.png') });
  await openProject(page, milestone);
  await expect(page.getByRole('navigation', { name: 'Project ancestry' }).getByRole('link', { name: parent.displayName })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage access', exact: true })).toHaveCount(0);
  await expect(page.locator('.access-summary')).toContainText('These rules come from');
  await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  await expect(page.getByLabel('Project color', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Project description', exact: true }).fill('The milestone has its own description.');
  await page.getByRole('button', { name: 'Save Project', exact: true }).click();
  await expect(page.locator('.project-editor')).toContainText('Based on version 2');
  await page.getByRole('button', { name: 'Close Editor', exact: true }).click();
  await page.getByRole('button', { name: 'Members & Watchers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Watch Project', exact: true })).toHaveCount(0);
  await expect(page.locator('.project-people')).toContainText('You also watch this project through');
  await expect(page.getByRole('button', { name: 'Leave Project', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('milestone-inheritance.png'), fullPage: true });
  const task = await api<Task>(page, '/tasks', 'POST', { title: `Milestone task ${info.project.name}`, projectIds: [parent.id, milestone.id] });
  expect(task.projectIds).toEqual([milestone.id]);
  await openProject(page, parent); await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('.project-tasks').getByRole('link').filter({ hasText: task.title })).toBeVisible();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace command', exact: true }).fill(`show tasks in project ${parent.id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('link', { name: `${task.id} ${task.title}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('a stale conversion preview retains its original membership version and requires an explicit refreshed review', async ({ page, context }, info) => {
  await page.goto('./#projects'); const parent = await api<Project>(page, '/projects', 'POST', { name: `Stale parent ${info.project.name} ${Date.now()}` });
  const childName = `Keep this child name ${info.project.name} ${Date.now()}`;
  await openProject(page, parent); await prepareChild(page, 'project', childName);
  await page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true }).check();
  await api(page, `/projects/${parent.id}/membership`, 'POST', { action: 'join', expectedVersion: 0 });
  const failed = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm Create Subproject', exact: true }).click();
  const response = await failed; expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toMatchObject({ expectedParentMembersVersion: 0 });
  await expect(page.getByRole('textbox', { name: 'Subproject name', exact: true })).toHaveValue(childName);
  await page.getByRole('button', { name: 'Reload Creation Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Review Child Project', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm child project' })).toContainText('Move all 1 direct parent members');
  await expect(page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true }).check();
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Confirm Create Subproject', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reload Creation Preview', exact: true })).toBeDisabled();
  await context.setOffline(false); await expect(page.getByRole('button', { name: 'Confirm Create Subproject', exact: true })).toBeEnabled();
  const child = await confirmChild(page, 'project');
  expect(child.name).toBe(childName);
});

test('a late child-creation response preserves a newer remounted draft instead of closing or rebasing it', async ({ page }, info) => {
  await page.goto('./#projects'); const parent = await api<Project>(page, '/projects', 'POST', { name: `Draft parent ${info.project.name} ${Date.now()}` });
  const committedName = `The committed child ${info.project.name} ${Date.now()}`;
  await openProject(page, parent); await prepareChild(page, 'project', committedName);
  await page.getByRole('checkbox', { name: 'I understand that parent membership will be converted.', exact: true }).check();
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/projects', async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(201); started(); await held; await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Confirm Create Subproject', exact: true }).click(); await pending;
    await page.getByRole('button', { name: 'Close Creation Draft', exact: true }).click();
    await page.getByRole('button', { name: 'Create Subproject', exact: true }).click();
    await page.getByRole('textbox', { name: 'Subproject name', exact: true }).fill('A newer unsent child');
    release();
    await expect(page.locator('.project-hierarchy')).toContainText(committedName);
    await expect(page.getByRole('textbox', { name: 'Subproject name', exact: true })).toHaveValue('A newer unsent child');
    await expect(page.locator('.project-child-editor')).toContainText('The parent changed after this preview');
    await page.reload(); await hierarchy(page); await page.getByRole('button', { name: 'Create Subproject', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Subproject name', exact: true })).toHaveValue('A newer unsent child');
    await expect(page.getByRole('button', { name: 'Review Child Project', exact: true })).toBeDisabled();
  } finally { release(); await page.unroute('**/api/projects'); }
});
