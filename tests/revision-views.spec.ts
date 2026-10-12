import { test, expect, type Dialog, type Page } from '@playwright/test';
import type { AppState, Project, RevisionDetail, RevisionKind } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import type { RevisionViewsSnapshot, RevisionViewSnapshot } from '../shared/revision-views';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';
import { authAccounts } from './auth-fixture';

const panel = (page: Page) => page.getByRole('region', { name: 'Revision views', exact: true });
const selection = (page: Page) => panel(page).getByRole('combobox', { name: 'Saved revision view', exact: true });
const name = (page: Page) => panel(page).getByLabel('Revision view name', { exact: true });
const search = (page: Page) => page.getByLabel('Search workspace', { exact: true });
const rows = (page: Page) => page.locator('.revision-list .revision-row');
const nonce = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const route = (kind: RevisionKind) => kind === 'code' ? 'reviews' : kind === 'paper' ? 'papers' : 'drafts';
async function openKind(page: Page, kind: RevisionKind) { await page.goto(`./#${route(kind)}`); await expect(panel(page)).toBeVisible(); }
async function manage(page: Page) { const disclosure = panel(page).locator('.revision-view-management'); if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await disclosure.locator('summary').click(); }
async function fillName(page: Page, value: string) { await manage(page); await name(page).fill(value); }
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const option = (page: Page, title: string) => selection(page).locator('option').filter({ hasText: new RegExp(`^${escaped(title)} · RV[1-9]\\d*$`) });
async function create(page: Page, title: string, kind: RevisionKind = 'paper', projectIds: string[] = []) {
  return api<RevisionDetail>(page, '/revisions', { title, kind, projectIds, summary: '', testPlan: 'Check exact saved-view filters and current access.', files: [{ path: kind === 'paper' ? 'paper.tex' : 'source.txt', content: 'Exact source for a saved-view fixture.\n' }] });
}
async function saveNew(page: Page, title: string) {
  await fillName(page, title); await panel(page).getByRole('button', { name: 'Save new view', exact: true }).click();
  await expect(option(page, title)).toHaveCount(1);
  const id = await option(page, title).getAttribute('value'); expect(id).toMatch(/^RV[1-9]\d*$/); return id!;
}
async function openSaved(page: Page, title: string) {
  const value = await option(page, title).getAttribute('value'); expect(value).toBeTruthy(); await selection(page).selectOption(value!);
  const accept = (dialog: Dialog) => void dialog.accept(); page.on('dialog', accept);
  try { await panel(page).getByRole('button', { name: 'Open saved view', exact: true }).click(); await expect(name(page)).toHaveValue(title); }
  finally { page.off('dialog', accept); }
}
async function command(page: Page, value: string) {
  if (!await page.getByLabel('Workspace command', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  const input = page.getByLabel('Workspace command', { exact: true }); await input.fill(value); await input.press('Enter');
}
async function exportDraft(page: Page) {
  const waiting = page.waitForEvent('download'); await panel(page).getByRole('button', { name: 'Export view draft', exact: true }).click();
  const parts: Buffer[] = []; for await (const part of (await (await waiting).createReadStream())!) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString()) as unknown;
}
test('named views preserve exact filters separately for code, papers and documents across navigation and reload', async ({ page }, info) => {
  await page.goto('./#home'); const tag = nonce('Per kind'), title = nonce('Same named view');
  const project = await api<Project>(page, '/projects', { name: tag });
  const created = new Map<RevisionKind, RevisionDetail>();
  for (const kind of ['code', 'paper', 'document'] as const) { created.set(kind, await create(page, `${tag} ${kind}`, kind, [project.id])); await create(page, `Excluded ${kind} ${tag}`, kind); }
  await page.reload();
  for (const kind of ['code', 'paper', 'document'] as const) {
    await openKind(page, kind); await search(page).fill(tag); await page.getByLabel('Revision project filter').selectOption(project.id);
    await page.getByLabel('Revision following').selectOption('following');
    await page.getByRole('button', { name: /^Needs review$/i, exact: true }).click();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText(created.get(kind)!.revision.id); await saveNew(page, title);
  }
  const snapshot = await api<RevisionViewsSnapshot>(page, '/revision-views');
  expect(snapshot.views.filter(view => view.name === title).map(view => view.filters.kind).sort()).toEqual(['code', 'document', 'paper']);
  await page.goto('./#home'); await openKind(page, 'paper'); await expect(search(page)).toHaveValue(tag); await expect(name(page)).toHaveValue(title);
  await page.reload(); await expect(name(page)).toHaveValue(title); await expect(page.getByLabel('Revision project filter')).toHaveValue(project.id); await expect(page.getByLabel('Revision following')).toHaveValue('following'); await expect(rows(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await manage(page);
  if (info.project.name === 'mobile') expect((await panel(page).getByRole('button', { name: 'Save new view', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await panel(page).screenshot({ path: info.outputPath('saved-revision-views.png') });
});

test('the same account reopens views on another device and exact voice selection does not choose a prefix match', async ({ browser }, info) => {
  const first = await signIn(browser, info), second = await signIn(browser, info);
  try {
    const tag = nonce('Cross device source'), savedName = nonce('Exact view'); await create(first.page, tag); await first.page.reload(); await openKind(first.page, 'paper'); await search(first.page).fill(tag); const id = await saveNew(first.page, savedName);
    await fillName(first.page, `${savedName} expanded`); await panel(first.page).getByRole('button', { name: 'Save new view', exact: true }).click(); await expect(option(first.page, `${savedName} expanded`)).toHaveCount(1);
    await second.page.reload(); await openKind(second.page, 'paper'); await openSaved(second.page, savedName); await expect(search(second.page)).toHaveValue(tag); await expect(rows(second.page)).toHaveCount(1);
    await second.page.reload(); await openSaved(second.page, `${savedName} expanded`);
    let writes = 0; second.page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/revision-views')) writes++; });
    await command(second.page, `open paper view ${savedName.toUpperCase()}`); await expect(panel(second.page).locator('.revision-view-state')).toContainText(id); await expect(name(second.page)).toHaveValue(savedName);
    await search(second.page).fill('A newer unsaved filter'); await command(second.page, `open paper view ${id}`); await expect(search(second.page)).toHaveValue('A newer unsaved filter'); await expect(second.page.locator('.command-feedback').filter({ hasText: 'unsaved changes' })).toBeVisible(); expect(writes).toBe(0);
  } finally { await first.context.close(); await second.context.close(); }
});

test('a lost saved-view receipt retries exact input and retains newer local edits', async ({ page }) => {
  await page.goto('./#home'); const original = nonce('Lost receipt'), newer = nonce('Newer unsent name'); await openKind(page, 'paper'); await search(page).fill('Exact original filter');
  const bodies: unknown[] = [], keys: string[] = []; let first = true;
  await page.route('**/api/revision-views', async intercepted => {
    if (intercepted.request().method() !== 'POST') return intercepted.continue();
    bodies.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!);
    if (first) { first = false; const response = await intercepted.fetch(); expect(response.ok()).toBe(true); return intercepted.abort('failed'); }
    return intercepted.continue();
  });
  await fillName(page, original); await panel(page).getByRole('button', { name: 'Save new view', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Retry saved view request', exact: true })).toBeVisible();
  await fillName(page, newer); await search(page).fill('Newer unsent filter'); await page.goto('./#home'); await openKind(page, 'paper'); await expect(name(page)).toHaveValue(newer);
  await panel(page).getByRole('button', { name: 'Retry saved view request', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Retry saved view request', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); await expect(name(page)).toHaveValue(newer); await expect(search(page)).toHaveValue('Newer unsent filter');
  const snapshot = await api<RevisionViewsSnapshot>(page, '/revision-views'); expect(snapshot.views.filter(view => view.name === original)).toHaveLength(1); expect(snapshot.views.some(view => view.name === newer)).toBe(false);
});

test('a concurrent saved-view update keeps the newer server view and the conflicting local draft', async ({ browser }, info) => {
  const first = await signIn(browser, info), second = await signIn(browser, info);
  try {
    const original = nonce('Concurrent view'), serverName = nonce('New server name'), draftName = nonce('Competing local name'); await openKind(first.page, 'paper'); const id = await saveNew(first.page, original);
    await second.page.reload(); await openKind(second.page, 'paper'); await openSaved(second.page, original); await fillName(second.page, draftName); await search(second.page).fill('Competing unsent filter');
    await fillName(first.page, serverName); await panel(first.page).getByRole('button', { name: 'Update saved view', exact: true }).click(); await expect(option(first.page, serverName)).toHaveCount(1);
    await panel(second.page).getByRole('button', { name: 'Update saved view', exact: true }).click(); await expect(panel(second.page)).toContainText(/changed|version|conflict/i); await expect(name(second.page)).toHaveValue(draftName); await expect(search(second.page)).toHaveValue('Competing unsent filter');
    const saved = await api<RevisionViewSnapshot>(first.page, `/revision-views/${id}`); expect(saved.view.name).toBe(serverName); expect(saved.view.version).toBe(2);
    await panel(second.page).getByRole('button', { name: 'Reload saved views', exact: true }).click(); await expect(option(second.page, serverName)).toHaveCount(1); await expect(name(second.page)).toHaveValue(draftName); await expect(search(second.page)).toHaveValue('Competing unsent filter'); expect(JSON.stringify(await exportDraft(second.page))).toContain('Competing unsent filter');
  } finally { await first.context.close(); await second.context.close(); }
});

test('offline named-view selection and filter edits use saved snapshots and never save on reconnect', async ({ page, context }) => {
  await page.goto('./#home'); const tag = nonce('Offline result'), savedName = nonce('Offline named view'); await create(page, tag); await page.reload(); await openKind(page, 'paper'); await search(page).fill(tag); const id = await saveNew(page, savedName);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); let writes = 0; page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/revision-views')) writes++; });
  await context.setOffline(true);
  try {
    await page.reload(); await openSaved(page, savedName); await expect(rows(page)).toHaveCount(1); await search(page).fill('Offline unsaved text'); await fillName(page, 'Offline unsaved view name'); await expect(rows(page)).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Update saved view', exact: true })).toBeDisabled(); await expect(panel(page).getByRole('button', { name: 'Save new view', exact: true })).toBeDisabled();
    await page.goto('./#home'); await openKind(page, 'paper'); await expect(search(page)).toHaveValue('Offline unsaved text'); await expect(name(page)).toHaveValue('Offline unsaved view name');
  } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  await manage(page); await expect(panel(page).getByRole('button', { name: 'Update saved view', exact: true })).toBeEnabled(); expect(writes).toBe(0); const saved = await api<RevisionViewSnapshot>(page, `/revision-views/${id}`); expect(saved.view.name).toBe(savedName); expect(saved.view.filters.query).toBe(tag);
});

test('a permission-lost project remains an unavailable constraint with zero results', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const project = await api<Project>(alice.page, '/projects', { name: nonce('Private project label') }); const created = await create(alice.page, nonce('Still visible revision'), 'paper', [project.id]);
    await bob.page.reload(); await openKind(bob.page, 'paper'); await bob.page.getByLabel('Revision project filter').selectOption(project.id); const savedName = nonce('Project bound view'), id = await saveNew(bob.page, savedName); await expect(rows(bob.page)).toContainText(created.revision.id);
    const state = await api<AppState>(alice.page, '/state'), policy = (await api<ObjectAccess>(alice.page, `/policies/${project.id}`)).policy;
    await api(alice.page, `/policies/${project.id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [state.currentPrincipalId] } }, 'PUT');
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob.page.getByLabel('Revision project filter')).toHaveValue(project.id); await expect(bob.page.getByLabel('Revision project filter')).toContainText('Unavailable'); await expect(rows(bob.page)).toHaveCount(0); await expect(panel(bob.page)).not.toContainText(project.name);
    const saved = await api<RevisionViewSnapshot>(bob.page, `/revision-views/${id}`); expect(saved.view.filters.projectId).toBe(project.id); expect((await api<RevisionDetail>(bob.page, `/revisions/${created.revision.id}`)).revision.id).toBe(created.revision.id);
    await bob.page.reload(); await openSaved(bob.page, savedName); await expect(rows(bob.page)).toHaveCount(0); await expect(bob.page.getByLabel('Revision project filter')).toHaveValue(project.id);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('owner-only views and authored filters survive sign-in while private browser drafts do not', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const tag = nonce('Authored scope'), savedName = nonce('Alice private view'), unsaved = nonce('Alice unsaved draft'); const own = await create(alice.page, `${tag} Alice`), other = await create(bob.page, `${tag} Bob`);
    await alice.page.reload(); await bob.page.reload(); await openKind(alice.page, 'paper'); await search(alice.page).fill(tag); await alice.page.getByRole('combobox', { name: 'Revision author', exact: true }).selectOption({ label: 'Authored by me' }); await expect(rows(alice.page)).toContainText(own.revision.id); await expect(rows(alice.page)).not.toContainText(other.revision.id); const id = await saveNew(alice.page, savedName);
    await openKind(bob.page, 'paper'); await expect(option(bob.page, savedName)).toHaveCount(0); expect((await api<RevisionViewsSnapshot>(bob.page, '/revision-views')).views.some(view => view.id === id)).toBe(false);
    await command(bob.page, 'show papers I authored'); await expect(bob.page.getByRole('combobox', { name: 'Revision author', exact: true })).toHaveValue('mine'); await search(bob.page).fill(tag); await expect(rows(bob.page)).toContainText(other.revision.id); await expect(rows(bob.page)).not.toContainText(own.revision.id);
    await fillName(alice.page, unsaved); expect(await alice.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(savedName); expect(await alice.page.evaluate(() => Object.values(localStorage).join(''))).not.toContain(unsaved);
    await alice.page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await alice.page.getByRole('button', { name: 'Sign out and clear drafts', exact: true }).click(); await expect(alice.page.getByRole('button', { name: 'Sign In', exact: true })).toBeEnabled();
    await alice.page.getByLabel('Username', { exact: true }).fill(authAccounts[1].username); await alice.page.getByLabel('Password', { exact: true }).fill(authAccounts[1].password); await alice.page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(alice.page.locator('.signed-in-user')).toHaveText(authAccounts[1].displayName); await openKind(alice.page, 'paper'); await expect(name(alice.page)).not.toHaveValue(unsaved); await expect(option(alice.page, savedName)).toHaveCount(0);
    expect((await api<RevisionViewsSnapshot>(bob.page, '/revision-views')).views.some(view => view.id === id)).toBe(false);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('lost deletion receipts retry without recreating a view or erasing newer filters', async ({ page }) => {
  await page.goto('./#home'); const tag = nonce('Delete view source'), title = nonce('View to delete'); const source = await create(page, tag, 'document');
  await page.reload(); await openKind(page, 'document'); await search(page).fill(tag); const id = await saveNew(page, title); const bodies: unknown[] = [], keys: string[] = [];
  await page.route(`**/api/revision-views/${id}/delete`, async intercepted => {
    bodies.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!);
    if (bodies.length === 1) { const response = await intercepted.fetch(); expect(response.ok()).toBe(true); return intercepted.abort('failed'); }
    return intercepted.continue();
  });
  page.once('dialog', dialog => void dialog.accept()); await panel(page).getByRole('button', { name: 'Delete saved view', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Retry saved view request', exact: true })).toBeVisible();
  await search(page).fill('Newer filters after deletion'); await fillName(page, 'Newer unsaved view after deletion');
  expect((await api<RevisionViewsSnapshot>(page, '/revision-views')).views.some(view => view.id === id)).toBe(false);
  await panel(page).getByRole('button', { name: 'Retry saved view request', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Retry saved view request', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); await expect(search(page)).toHaveValue('Newer filters after deletion'); await expect(name(page)).toHaveValue('Newer unsaved view after deletion'); await expect(option(page, title)).toHaveCount(0);
  const after = await api<RevisionDetail>(page, `/revisions/${source.revision.id}`); expect(after).toEqual(source);
});

test('cancelling sign-out during a held save preserves an enabled exact retry and newer filters', async ({ browser }, info) => {
  const signedIn = await signIn(browser, info), page = signedIn.page;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let committed!: () => void;
  const saved = new Promise<void>(resolve => { committed = resolve; });
  const bodies: unknown[] = [], keys: string[] = [];
  try {
    await openKind(page, 'paper'); const original = nonce('Sign-out held view'), newer = nonce('After cancelled sign-out');
    await search(page).fill('Exact held filter');
    await page.route('**/api/revision-views', async intercepted => {
      if (intercepted.request().method() !== 'POST') return intercepted.continue();
      bodies.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!);
      if (bodies.length === 1) {
        const response = await intercepted.fetch(); expect(response.ok()).toBe(true); committed(); await held;
        return intercepted.fulfill({ response });
      }
      return intercepted.continue();
    });
    await fillName(page, original); await panel(page).getByRole('button', { name: 'Save new view', exact: true }).click(); await saved;
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0].displayName);
    const retry = panel(page).getByRole('button', { name: 'Retry saved view request', exact: true });
    await expect(retry).toBeEnabled();
    await expect(panel(page).getByRole('button', { name: 'Forget saved view request', exact: true })).toBeEnabled();
    await fillName(page, newer); await search(page).fill('Newer filter after cancelled sign-out');
    const oldResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/revision-views'));
    release(); await oldResponse;
    await expect(retry).toBeEnabled(); expect(bodies).toHaveLength(1);
    await expect(name(page)).toHaveValue(newer); await expect(search(page)).toHaveValue('Newer filter after cancelled sign-out');
    await retry.click(); await expect(retry).toHaveCount(0);
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
    await expect(name(page)).toHaveValue(newer); await expect(search(page)).toHaveValue('Newer filter after cancelled sign-out');
    const snapshot = await api<RevisionViewsSnapshot>(page, '/revision-views');
    expect(snapshot.views.filter(view => view.name === original)).toHaveLength(1); expect(snapshot.views.some(view => view.name === newer)).toBe(false);
  } finally { release(); await signedIn.context.close(); }
});
