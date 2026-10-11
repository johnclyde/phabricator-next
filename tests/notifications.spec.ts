import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AppState, RevisionDetail } from '../shared/types';
import type { NotificationInbox, NotificationInput, NotificationSummary } from '../shared/notifications';
import type { RevisionSubscriptionSnapshot } from '../shared/revision-subscriptions';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import { reviewerApi as api, reviewerBase as base, reviewerSignIn as signIn } from './revision-reviewers-browser';

const inbox = (page: Page) => page.getByRole('region', { name: 'Notification inbox', exact: true });
const row = (page: Page, id: string) => inbox(page).locator(`[data-notification-id="${id}"]`);
const create = (page: Page, title: string) => api<RevisionDetail>(page, '/revisions', { kind: 'paper', title, testPlan: 'Inspect notification boundaries and preserve exact source.', files: [{ path: 'paper.txt', content: 'Exact manuscript source.\n' }] });
async function follow(page: Page, id: string) { const s = await api<RevisionSubscriptionSnapshot>(page, `/revisions/${id}/subscriptions`); await api(page, `/revisions/${id}/subscriptions`, { action: 'subscribe', principalId: s.viewer.principalId, expectedSubscriptionVersion: s.viewer.version, expectedAuthorVersion: s.authorVersion, expectedReviewerVersion: s.reviewerVersion, expectedAccessEpoch: s.accessEpoch }); }
async function comment(page: Page, detail: RevisionDetail, text = 'Private comment text must not appear in notification rows.') { await api(page, `/revisions/${detail.revision.id}/comments`, { versionId: detail.versions.at(-1)!.id, body: text }); }
async function resetRead(page: Page) { const summary = await api<NotificationSummary>(page, '/notifications/count'); await api(page, '/notifications/read', { action: 'read_through', horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch }); }
async function show(page: Page) { await page.goto('./#notifications'); await expect(inbox(page)).toBeVisible(); await expect(inbox(page).getByRole('button', { name: 'Reload Notifications', exact: true })).toBeEnabled(); }
async function capture(page: Page, info: TestInfo, suffix: string) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if (info.project.name === 'mobile') { const bounds = (await page.getByRole('button', { name: /^Notifications,/ }).boundingBox())!; expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44); const mark = inbox(page).getByRole('button', { name: 'Mark Read', exact: true }).first(); if (await mark.count()) { const box = (await mark.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.height).toBeLessThanOrEqual(80); } } const folder = `.data/notifications-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${folder}/${info.project.name}-${suffix}.png` });
  await inbox(page).locator('.notification-row').first().evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-${suffix}-rows.png` });
  if (info.project.name === 'mobile') { await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); const last = (await inbox(page).locator('.notification-read-action').last().boundingBox())!, footer = (await page.getByRole('navigation', { name: 'Quick navigation' }).boundingBox())!; expect(last.y + last.height).toBeLessThanOrEqual(footer.y); } }


test('bell latest ten and full inbox page authorized events with explicit read state and voice filters', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    await resetRead(bob.page); const detail = await create(alice.page, 'Notification pagination manuscript'); await follow(bob.page, detail.revision.id);
    for (let index = 0; index < 27; index++) await comment(alice.page, detail, `Notification fixture comment ${index}`);
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob.page.getByRole('button', { name: 'Notifications, 27 unread', exact: true })).toBeVisible();
    await bob.page.getByRole('button', { name: 'Notifications, 27 unread', exact: true }).click(); const menu = bob.page.getByRole('region', { name: 'Notification menu', exact: true }); await expect(menu.locator('.notification-row')).toHaveCount(10); await expect(menu).not.toContainText('Notification fixture comment'); await menu.getByRole('button', { name: 'View All Notifications' }).click();
    await expect(inbox(bob.page).locator('.notification-row')).toHaveCount(25); await inbox(bob.page).getByRole('button', { name: 'Load Older Notifications' }).click(); await expect(inbox(bob.page).locator('.notification-row').filter({ hasText: detail.revision.title })).toHaveCount(27);
    const received = await api<NotificationInbox>(bob.page, '/notifications?filter=unread'); const first = received.items[0]!; await row(bob.page, first.id).getByRole('button', { name: 'Mark Read', exact: true }).click(); await expect(row(bob.page, first.id).getByRole('button', { name: 'Mark Unread' })).toBeEnabled(); await expect(bob.page.getByRole('button', { name: 'Notifications, 26 unread', exact: true })).toBeVisible(); await row(bob.page, first.id).getByRole('button', { name: 'Mark Unread' }).click(); await expect(row(bob.page, first.id).getByRole('button', { name: 'Mark Read', exact: true })).toBeEnabled();
    await capture(bob.page, info, 'inbox'); await bob.page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await bob.page.getByLabel('Workspace command').fill('show unread notifications'); await bob.page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(inbox(bob.page).getByRole('button', { name: 'Unread Notifications', exact: true })).toHaveAttribute('aria-pressed', 'true'); expect((await api<RevisionDetail>(alice.page, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('Mark All Read retains the observed boundary while later notifications stay unread', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let waiting = false; const writes: NotificationInput[] = [];
  try {
    await resetRead(bob.page); const detail = await create(alice.page, 'Boundary manuscript'); await follow(bob.page, detail.revision.id); await comment(alice.page, detail); await show(bob.page); await expect(inbox(bob.page).locator('.is-unread')).toHaveCount(1);
    await bob.page.route('**/api/notifications/read', async route => { const body = route.request().postDataJSON() as NotificationInput; writes.push(body); if (body.action === 'read_through') { waiting = true; await held; } await route.continue(); }); bob.page.once('dialog', dialog => dialog.accept()); await inbox(bob.page).getByRole('button', { name: 'Mark All Read', exact: true }).click(); await expect.poll(() => waiting).toBe(true); await comment(alice.page, detail, 'Arrived after the inspected boundary'); release(); await expect(bob.page.getByRole('button', { name: 'Notifications, 1 unread', exact: true })).toBeVisible();
    await expect(inbox(bob.page).locator('.is-unread')).toHaveCount(1); expect(writes).toHaveLength(1); expect(writes[0]?.action).toBe('read_through');
  } finally { release(); await bob.page.unrouteAll({ behavior: 'wait' }); await alice.context.close(); await bob.context.close(); }
});

test('lost read receipt keeps the original request for explicit recovery and does not replay on reconnect', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); const writes: { key: string; body: unknown }[] = [];
  try {
    await resetRead(bob.page); const detail = await create(alice.page, 'Exact read recovery'); await follow(bob.page, detail.revision.id); await comment(alice.page, detail); await show(bob.page); const item = (await api<NotificationInbox>(bob.page, '/notifications?filter=unread')).items[0]!;
    await bob.page.route('**/api/notifications/read', async route => { writes.push({ key: route.request().headers()['idempotency-key']!, body: route.request().postDataJSON() }); if (writes.length === 1) { await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await row(bob.page, item.id).getByRole('button', { name: 'Mark Read', exact: true }).click(); await expect(inbox(bob.page).getByText('Unconfirmed notification change', { exact: true })).toBeVisible(); await bob.context.setOffline(true); await bob.page.evaluate(() => window.dispatchEvent(new Event('offline'))); await bob.context.setOffline(false); await bob.page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(inbox(bob.page).getByRole('button', { name: 'Retry Exact Change' })).toBeEnabled(); expect(writes).toHaveLength(1);
    await inbox(bob.page).getByRole('button', { name: 'Retry Exact Change' }).click(); await expect(inbox(bob.page).getByText('Unconfirmed notification change', { exact: true })).toHaveCount(0); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  } finally { await bob.page.unrouteAll({ behavior: 'wait' }); await alice.context.close(); await bob.context.close(); }
});

test('opening a Word revision marks only its observed notifications and passive refresh leaves later arrivals unread', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let waiting = false, opens = 0;
  try {
    await resetRead(bob.page); const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(alice.page, '/files', { name: 'notifications.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(alice.page, '/state');
    const detail = await api<RevisionDetail>(alice.page, '/revisions/docx', { title: 'Word inbox source', testPlan: 'Inspect original Word source.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: state.accessEpoch }); await follow(bob.page, detail.revision.id); await comment(alice.page, detail); await show(bob.page); await expect(inbox(bob.page).locator('.is-unread')).toHaveCount(1);
    await bob.page.route('**/api/notifications/read', async route => { const body = route.request().postDataJSON() as NotificationInput; if (body.action === 'read_object') { opens++; waiting = true; await held; } await route.continue(); });
    await inbox(bob.page).getByRole('link', { name: `${detail.revision.id} ${detail.revision.title}`, exact: true }).click(); await expect(bob.page.getByLabel('Word document text', { exact: true })).toContainText('The original result is clear.'); await expect.poll(() => waiting).toBe(true); await comment(alice.page, detail, 'New arrival after Word opening'); release(); await expect.poll(async () => (await api<NotificationSummary>(bob.page, '/notifications/count')).unreadCount).toBe(1); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob.page.getByRole('button', { name: 'Notifications, 1 unread', exact: true })).toBeVisible(); expect(opens).toBe(1);
    await bob.page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click(); await expect(bob.page.getByRole('region', { name: 'Notification menu' }).locator('.is-unread')).toHaveCount(1); const folder = `.data/notifications-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await bob.page.screenshot({ path: `${folder}/${info.project.name}-word-menu.png` }); expect((await api<RevisionDetail>(alice.page, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
  } finally { release(); await bob.page.unrouteAll({ behavior: 'wait' }); await alice.context.close(); await bob.context.close(); }
});

test('policy revocation retires notification labels, unread count and a late decoded page', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    await resetRead(bob.page); const detail = await create(alice.page, 'Retire this confidential notification title'); await follow(bob.page, detail.revision.id); await comment(alice.page, detail); await show(bob.page); await expect(inbox(bob.page)).toContainText(detail.revision.title);
    await bob.page.evaluate(() => { const original = Response.prototype.json; const gate = window as Window & { notificationDecoded?: boolean; releaseNotificationDecode?: () => void }; Response.prototype.json = async function () { const value = await original.call(this); if (new URL(this.url).pathname.endsWith('/api/notifications')) { Response.prototype.json = original; gate.notificationDecoded = true; await new Promise<void>(resolve => { gate.releaseNotificationDecode = resolve; }); } return value; }; });
    await inbox(bob.page).getByRole('button', { name: 'Reload Notifications', exact: true }).click(); await expect.poll(() => bob.page.evaluate(() => Boolean((window as Window & { notificationDecoded?: boolean }).notificationDecoded))).toBe(true);
    const state = await api<AppState>(alice.page, '/state'), policy = (await api<ObjectAccess>(alice.page, `/policies/${detail.revision.id}`)).policy; await api(alice.page, `/policies/${detail.revision.id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [state.currentPrincipalId] }, edit: policy.rules.edit, interact: policy.rules.interact }, 'PUT'); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(inbox(bob.page)).not.toContainText(detail.revision.title); await bob.page.evaluate(() => (window as Window & { releaseNotificationDecode?: () => void }).releaseNotificationDecode?.()); await expect(inbox(bob.page)).not.toContainText(detail.revision.title); await expect(bob.page.getByRole('button', { name: 'Notifications, 0 unread', exact: true })).toBeVisible(); expect(await bob.page.evaluate(() => Object.values(localStorage).join(''))).not.toContain(detail.revision.title);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('offline protected inbox retains authorized tab reads without automatic read changes or cross-account persistence', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let writes = 0;
  try {
    await resetRead(bob.page); const detail = await create(alice.page, 'Offline tab inbox'); await follow(bob.page, detail.revision.id); await comment(alice.page, detail); await show(bob.page); await expect(inbox(bob.page)).toContainText(detail.revision.title); bob.page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/notifications/read')) writes++; });
    await bob.context.setOffline(true); await bob.page.evaluate(() => window.dispatchEvent(new Event('offline'))); await expect(inbox(bob.page).getByRole('button', { name: 'Mark Read', exact: true }).first()).toBeDisabled(); await expect(inbox(bob.page)).toContainText(detail.revision.title); await bob.page.getByRole('button', { name: /^Notifications,/ }).click(); await expect(bob.page.getByRole('region', { name: 'Notification menu' })).toContainText(detail.revision.title); await bob.page.getByRole('button', { name: 'Close notifications' }).click(); await bob.context.setOffline(false); await bob.page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(inbox(bob.page).getByRole('button', { name: 'Reload Notifications', exact: true })).toBeEnabled(); expect(writes).toBe(0); expect(await bob.page.evaluate(() => Object.values(localStorage).join(''))).not.toContain(detail.revision.title);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('local inbox survives a complete offline reload and never replays read actions', async ({ page, context }) => {
  test.skip(process.env.E2E_NOTIFICATION_FIXTURE !== '1', 'Requires the disposable local contributor fixture.');
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/notifications/read')) writes++; });
  await show(page); await expect(inbox(page)).toContainText('Local durable notification fixture');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true); await page.reload(); await expect(inbox(page)).toContainText('Local durable notification fixture'); await expect(inbox(page).getByRole('button', { name: 'Mark Read', exact: true }).first()).toBeDisabled();
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(inbox(page).getByRole('button', { name: 'Reload Notifications', exact: true })).toBeEnabled(); expect(writes).toBe(0);
});
