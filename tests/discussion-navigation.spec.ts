import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { RevisionDetail, ReviewComment, AppState } from '../shared/types';
import type { DiscussionPreferences } from '../shared/discussion';
import type { ObjectAccess } from '../shared/policy';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import { mkdir } from 'node:fs/promises';
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> { const url = new URL(`api${path}`, baseURL).href; const response = body === undefined ? await request.get(url) : await request.post(url, { data: body }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
async function fixture(request: APIRequestContext, baseURL: string) {
  const detail = await api<RevisionDetail>(request, baseURL, '/revisions', { title: `Personal discussion ${Date.now()}`, kind: 'document', files: [{ path: 'draft.md', content: 'One exact original paragraph.\n' }] });
  const comments: ReviewComment[] = [];
  for (const body of ['First thread with evidence.', 'Second thread with dates.', 'Third thread with citations.']) comments.push(await api(request, baseURL, `/revisions/${detail.revision.id}/comments`, { versionId: detail.versions[0]!.id, body, filePath: 'draft.md', line: 1 }));
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); return { detail, comments };
}
async function open(page: Page, id: string) { const loaded = page.waitForResponse(response => response.url().endsWith(`/api/revisions/${id}/discussion-preferences`) && response.ok()); await page.goto(`./#${id}`); await loaded; await expect(page.locator('.review-thread')).toHaveCount(3); }
const card = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
async function settled(page: Page, id: string) { await expect(card(page, id).getByText('Saving personal presentation…', { exact: true })).toHaveCount(0); await expect(card(page, id).getByText(/Local personal choice has not been confirmed/)).toHaveCount(0); }

test('touch and keyboard discussion navigation retain reply drafts, original locations and personal collapse', async ({ page, request, baseURL }, info) => {
  const { detail, comments } = await fixture(request, baseURL!); const id = detail.revision.id; await open(page, id);
  const first = card(page, comments[0]!.id), second = card(page, comments[1]!.id), third = card(page, comments[2]!.id);
  await page.getByRole('button', { name: 'Previous thread', exact: true }).click(); await expect(page.locator('.review-thread[aria-current="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next thread', exact: true }).click(); await expect(first).toHaveAttribute('aria-current', 'true');
  await first.getByRole('button', { name: 'Reply', exact: true }).click(); await first.getByRole('textbox', { name: 'Reply to this thread', exact: true }).fill('Unsaved reply stays mounted.'); await first.getByRole('textbox', { name: 'Reply to this thread', exact: true }).press('n'); await expect(first).toHaveAttribute('aria-current', 'true');
  await first.getByRole('button', { name: 'Collapse thread', exact: true }).click(); await settled(page, comments[0]!.id); await expect(first.locator('.thread-content')).toBeHidden(); await expect(first.getByRole('button', { name: /View original version 1 · draft.md:1/ })).toBeVisible();
  await first.focus(); await page.keyboard.press('n'); await expect(second).toHaveAttribute('aria-current', 'true'); await page.keyboard.press('p'); await expect(second).toHaveAttribute('aria-current', 'true'); await page.keyboard.press('Shift+P'); await expect(first).toHaveAttribute('aria-current', 'true'); await expect(first.locator('.thread-content')).toBeHidden();
  await page.keyboard.press('q'); await settled(page, comments[0]!.id); await expect(first.getByRole('textbox', { name: 'Reply to this thread', exact: true })).toHaveValue('Unsaved reply stays mounted.n');
  await first.getByRole('button', { name: 'Collapse thread', exact: true }).click(); await settled(page, comments[0]!.id);
  await page.getByLabel('Include collapsed threads').check(); await page.getByRole('button', { name: 'Next thread', exact: true }).click(); await expect(second).toHaveAttribute('aria-current', 'true'); await page.getByRole('button', { name: 'Next thread', exact: true }).click(); await expect(third).toHaveAttribute('aria-current', 'true'); await page.getByRole('button', { name: 'Next thread', exact: true }).click(); await expect(third).toHaveAttribute('aria-current', 'true'); await expect(page.getByText('At the end of this discussion.', { exact: true })).toBeVisible();
  await first.getByRole('button', { name: 'Select thread', exact: true }).click(); await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); await first.scrollIntoViewIfNeeded(); await page.evaluate(() => { const element = document.querySelector('.review-thread'); if (element) window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 125); });
  await mkdir('.data/discussion-visual-qa', { recursive: true });
  const collapseBox = await first.getByRole('button', { name: 'Expand thread', exact: true }).boundingBox(); expect(collapseBox!.height).toBeGreaterThanOrEqual(44); expect(collapseBox!.y).toBeGreaterThan(80); expect(collapseBox!.y + collapseBox!.height).toBeLessThan(info.project.name === 'mobile' ? 770 : 1000);
  await page.screenshot({ path: `.data/discussion-visual-qa/${info.project.name}.png` });
  if (info.project.name === 'desktop') { await page.setViewportSize({ width: 768, height: 1024 }); await first.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect((await first.getByRole('button', { name: 'Expand thread', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44); await page.screenshot({ path: '.data/discussion-visual-qa/tablet.png' }); await page.setViewportSize({ width: 1440, height: 1000 }); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload(); await expect(first.locator('.thread-content')).toBeHidden(); await first.getByRole('button', { name: 'Expand thread', exact: true }).click(); await settled(page, comments[0]!.id);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(after.revision.currentVersion).toBe(1); expect(after.comments).toHaveLength(3); expect(after.threadEvents).toEqual([]);
});

test('offline collapse remains local with explicit reconnect save and exact lost-response retry', async ({ page, context, request, baseURL }) => {
  const { detail, comments } = await fixture(request, baseURL!); const id = detail.revision.id, threadId = comments[0]!.id; await open(page, id); const first = card(page, threadId);
  await context.setOffline(true); await first.getByRole('button', { name: 'Collapse thread', exact: true }).click(); await expect(first.locator('.thread-content')).toBeHidden(); await expect(first.getByRole('button', { name: 'Save personal presentation' })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).some(([key, value]) => key.includes('discussion-choice:') && value.includes('"collapsed":true')))).toBe(true);
  await context.setOffline(false); await expect(first.getByRole('button', { name: 'Save personal presentation' })).toBeEnabled();
  const saved = await api<DiscussionPreferences>(request, baseURL!, `/revisions/${id}/discussion-preferences`); expect(saved.preferences.find(row => row.threadId === threadId)?.collapsed).toBe(false);
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':outbox')).every(([, value]) => !value.includes('/preference')))).toBe(true);
  const sent: { body: unknown; key: string | undefined }[] = []; let lose = true;
  await page.route(`**/api/revisions/${id}/threads/${threadId}/preference`, async route => { sent.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] }); if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await first.getByRole('button', { name: 'Save personal presentation' }).click(); await expect(first.getByRole('alert')).toContainText('outcome is unknown');
  await page.reload(); await expect(first.locator('.thread-content')).toBeHidden(); await first.getByRole('button', { name: 'Retry personal presentation' }).click(); await settled(page, threadId); expect(sent[1]).toEqual(sent[0]); expect(sent[0]!.key).toBeTruthy(); await page.unrouteAll({ behavior: 'wait' });
});

test('another tab’s newer saved presentation retires an older read and stale local pins conflict without rebasing', async ({ page, context, request, baseURL }) => {
  const { detail, comments } = await fixture(request, baseURL!); const id = detail.revision.id, threadId = comments[0]!.id; await open(page, id);
  const other = await context.newPage(); await open(other, id); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured = false; let hold = true;
  await page.route(`**/api/revisions/${id}/discussion-preferences`, async route => { const response = await route.fetch(); if (hold) { captured = true; await held; } await route.fulfill({ response }); });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => captured).toBe(true);
    await card(other, threadId).getByRole('button', { name: 'Collapse thread', exact: true }).click(); await settled(other, threadId);
    await expect(card(page, threadId).locator('.thread-content')).toBeHidden();
    hold = false; release(); await page.unrouteAll({ behavior: 'wait' }); await expect(card(page, threadId).locator('.thread-content')).toBeHidden();
    // A separate device changes the saved version without sending a storage event.
    const pref = (await api<DiscussionPreferences>(request, baseURL!, `/revisions/${id}/discussion-preferences`)).preferences.find(row => row.threadId === threadId)!;
    const external = await request.patch(new URL(`api/revisions/${id}/threads/${threadId}/preference`, baseURL!).href, { data: { collapsed: false, expectedVersion: pref.version } }); expect(external.ok()).toBe(true);
    await card(page, threadId).getByRole('button', { name: 'Expand thread', exact: true }).click(); await expect(card(page, threadId).getByRole('alert')).toBeVisible(); await expect(card(page, threadId).getByRole('button', { name: 'Retry personal presentation' })).toBeVisible();
    page.once('dialog', dialog => dialog.accept()); await card(page, threadId).getByRole('button', { name: 'Reload saved presentation' }).click(); await settled(page, threadId); await expect(card(page, threadId).locator('.thread-content')).toBeVisible();
  } finally { hold = false; release(); await page.unrouteAll({ behavior: 'wait' }); await other.close(); }
});

test('view-only members save their own presentation without changing another viewer', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor })));
  const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const call = async <T,>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> => page.evaluate(async ({ path, method, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json(); const response = await fetch(`${location.pathname}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, method, body });
  try {
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); }
    const detail = await call<RevisionDetail>(alice!, '/revisions', 'POST', { title: 'Read-only personal presentation', kind: 'document', files: [{ path: 'read.md', content: 'Visible original.' }] }); const id = detail.revision.id;
    const root = await call<ReviewComment>(alice!, `/revisions/${id}/comments`, 'POST', { versionId: detail.versions[0]!.id, body: 'Visible review thread.' }); const policy = await call<ObjectAccess>(alice!, `/policies/${id}`); const state = await call<AppState>(alice!, '/state');
    await call(alice!, `/policies/${id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: policy.policy.spaceId, ...policy.policy.rules, edit: { kind: 'principals', principalIds: [state.currentPrincipalId] }, interact: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    const loaded = bob!.waitForResponse(response => response.url().endsWith(`/api/revisions/${id}/discussion-preferences`) && response.ok()); await bob!.goto(`./#${id}`); await loaded; const thread = card(bob!, root.id); await expect(thread.getByRole('button', { name: 'Resolve Thread' })).toHaveCount(0);
    await thread.getByRole('button', { name: 'Collapse thread', exact: true }).click(); await settled(bob!, root.id); await bob!.reload(); await expect(thread.locator('.thread-content')).toBeHidden();
    expect((await call<DiscussionPreferences>(alice!, `/revisions/${id}/discussion-preferences`)).preferences.find(row => row.threadId === root.id)?.collapsed).toBe(false);
    expect(await bob!.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Visible review thread');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
