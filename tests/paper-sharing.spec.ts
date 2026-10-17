import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, SourceFile } from '../shared/types';
import { authAccounts } from './auth-fixture';

const manuscript = (claim: string) => [
  '\\documentclass{article}', '\\title{A private mathematical argument}', '\\begin{document}', '\\maketitle',
  '\\section{The claim}', claim, '\\end{document}', '',
].join('\r\n');
const sources = [
  manuscript('Private first-version argument: $a^2+b^2=c^2$. Unicode β 😀.'),
  manuscript('Private second-version argument: $a^2+b^2\\neq c^2$. Unicode β 😀.'),
  manuscript('Private later-version argument: $x+y=z$.'),
];
const appendix = '\\section{Appendix}\nA private appendix: $\\sum_{i=1}^{n}i=\\frac{n(n+1)}{2}$.\n';
const reader = (page: Page) => page.getByRole('main', { name: 'Shared paper', exact: true });
const shareDialog = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Share paper', exact: true }) });
const files = (number: number): SourceFile[] => [{ path: 'main.tex', content: sources[number - 1]! }, { path: 'chapters/appendix.tex', content: appendix }];

function protectedURL(baseURL: string) { const url = new URL(baseURL); url.port = '4312'; return url.href; }
async function context(browser: Browser, baseURL: string, info: TestInfo): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
}
async function login(page: Page, index = 0) {
  await page.goto('./#home');
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}
async function api<T>(page: Page, baseURL: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ baseURL, path, body }) => {
    const session = await (await fetch(new URL('api/session', baseURL))).json();
    const response = await fetch(new URL(`api${path}`, baseURL), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { baseURL, path, body }) as Promise<T>;
}
async function create(page: Page, baseURL: string): Promise<RevisionDetail> {
  const state = await api<AppState>(page, baseURL, '/state');
  const audience = { kind: 'principals', principalIds: [state.currentPrincipalId] };
  const detail = await api<RevisionDetail>(page, baseURL, '/revisions', {
    title: `Private student paper ${randomUUID()}`, kind: 'paper', summary: 'Private workspace metadata must not be included in a shared reading copy.',
    testPlan: 'Verify exact immutable source and revocable reading access.', files: files(1),
    access: { spaceId: state.spaces.find(space => space.isDefault)!.id, view: audience, edit: audience, interact: audience },
  });
  return api<RevisionDetail>(page, baseURL, `/revisions/${detail.revision.id}/versions`, { expectedVersion: 1, message: 'A second private draft.', files: files(2) });
}
async function openSharing(page: Page, id: string, number: number) {
  await page.goto(`./#${id}`);
  await page.getByLabel('Version to inspect', { exact: true }).selectOption(String(number));
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(shareDialog(page)).toBeVisible();
}
async function createLink(page: Page, label: string) {
  const dialog = shareDialog(page);
  await dialog.getByLabel('Link label', { exact: true }).fill(label);
  await dialog.getByRole('button', { name: 'Create link', exact: true }).click();
  const field = dialog.getByLabel('Share link', { exact: true });
  await expect(field).toHaveValue(/#paper-share\/[A-Za-z0-9_-]{43}$/);
  const url = await field.inputValue(), token = new URL(url).hash.slice('#paper-share/'.length);
  const row = dialog.locator('[data-share-id]').filter({ hasText: label });
  await expect(row).toHaveCount(1);
  return { url, token, id: (await row.getAttribute('data-share-id'))! };
}
async function unchanged(page: Page, baseURL: string, original: RevisionDetail) {
  const after = await api<RevisionDetail>(page, baseURL, `/revisions/${original.revision.id}`);
  expect(after.versions).toEqual(original.versions);
  expect(after.comments).toEqual(original.comments);
  expect(after.reviews).toEqual(original.reviews);
  return after;
}
async function noPersistentPaper(page: Page, token: string) {
  const persisted = await page.evaluate(async () => {
    const records: unknown[] = [Object.entries(localStorage), Object.entries(sessionStorage)];
    for (const metadata of await indexedDB.databases()) {
      if (!metadata.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(metadata.name!); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      try {
        for (const name of Array.from(database.objectStoreNames)) {
          records.push(await new Promise<unknown[]>((resolve, reject) => { const request = database.transaction(name, 'readonly').objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
        }
      } finally { database.close(); }
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        records.push(request.url);
        if (/\/api\//.test(new URL(request.url).pathname)) {
          const response = await cache.match(request); records.push(response ? await response.text() : '');
        }
      }
    }
    return JSON.stringify(records);
  });
  expect(persisted).not.toContain(token);
  for (const text of ['Private first-version argument', 'Private second-version argument', 'Private later-version argument', 'A private appendix']) expect(persisted).not.toContain(text);
}
async function unavailable(page: Page) {
  await expect(page.getByRole('heading', { name: 'Paper unavailable', exact: true })).toBeVisible();
  await expect(page.getByText(/Private (first|second|later)-version argument/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download source', exact: true })).toHaveCount(0);
}

test('a selected private version has an anonymous mathematical reading link without workspace access or persistence', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info), guestContext = await context(browser, site, info);
  try {
    const owner = await ownerContext.newPage(); await login(owner); const detail = await create(owner, site);
    await openSharing(owner, detail.revision.id, 1); const link = await createLink(owner, 'Student reading copy');
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await shareDialog(owner).screenshot({ path: info.outputPath('paper-sharing-dialog.png') });
    expect(new URL(link.url).pathname).toBe(new URL(site).pathname); expect(new URL(link.url).search).toBe('');
    await guestContext.addCookies([{ name: 'paper-sharing-cookie-check', value: 'must-not-accompany-a-shared-read', url: site }]);
    const guest = await guestContext.newPage(), requests: Promise<{ url: string; method: string; body: unknown; cookie: string | undefined }>[] = [];
    guest.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) requests.push(request.allHeaders().then(headers => ({ url: request.url(), method: request.method(), body: request.postData() ? request.postDataJSON() : null, cookie: headers['cookie'] }))); });
    const responseWait = guest.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/paper-shares/read'));
    await guest.goto(link.url); const response = await responseWait;
    expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
    const payload = await response.json(); expect(Object.keys(payload).sort()).toEqual(['contentHash', 'files', 'title', 'versionNumber']);
    expect(payload).toEqual({ title: detail.revision.title, versionNumber: 1, contentHash: detail.versions[0]!.contentHash, files: files(1) });
    await expect(reader(guest).getByRole('heading', { level: 1, name: detail.revision.title, exact: true })).toBeVisible();
    await expect(reader(guest)).toContainText('Version 1'); await expect(reader(guest)).toContainText('Private first-version argument');
    await expect(reader(guest).locator('.katex annotation')).toHaveText('a^2+b^2=c^2');
    await expect(guest.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Edit & add version', exact: true })).toHaveCount(0);
    await expect(guest.locator('.sidebar, .comment-form, .revision-comparison-panel')).toHaveCount(0);
    await reader(guest).getByRole('button', { name: 'Source', exact: true }).click();
    await expect(reader(guest).getByLabel('Paper source', { exact: true })).toHaveText(sources[0]!);
    expect(await reader(guest).getByLabel('Paper source', { exact: true }).textContent()).toBe(sources[0]);
    const downloadWait = guest.waitForEvent('download'); await reader(guest).getByRole('button', { name: 'Download source', exact: true }).click();
    expect(await readFile((await (await downloadWait).path())!, 'utf8')).toBe(sources[0]);
    await reader(guest).getByLabel('Paper file', { exact: true }).selectOption('chapters/appendix.tex');
    await expect(reader(guest).getByLabel('Paper source', { exact: true })).toHaveText(appendix);
    expect(await reader(guest).getByLabel('Paper source', { exact: true }).textContent()).toBe(appendix);
    await reader(guest).getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(reader(guest).locator('.katex annotation')).toHaveText('\\sum_{i=1}^{n}i=\\frac{n(n+1)}{2}');
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await guest.screenshot({ path: info.outputPath('private-shared-paper.png'), fullPage: true });
    await noPersistentPaper(guest, link.token);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of await Promise.all(requests)) { expect(new URL(request.url).pathname).toBe(new URL('api/paper-shares/read', site).pathname); expect(request.url).not.toContain(link.token); expect(request.method).toBe('POST'); expect(request.body).toEqual({ token: link.token }); expect(request.cookie).toBeUndefined(); }
    await unchanged(owner, site, detail);
    const normal = await guestContext.request.get(new URL(`api/revisions/${detail.revision.id}`, site).href); expect([401, 404]).toContain(normal.status()); expect(await normal.text()).not.toContain(sources[0]!);
    await guest.goto(new URL(`#${detail.revision.id}`, site).href);
    await expect(guest.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
    await expect(guest.getByText('Private first-version argument', { exact: false })).toHaveCount(0);
    await expect(reader(guest)).toHaveCount(0);
  } finally { await Promise.all([ownerContext.close(), guestContext.close()]); }
});

test('revoking an open link removes the reading copy, keeps the paper intact, and never revives an older link', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info), guestContext = await context(browser, site, info);
  try {
    const owner = await ownerContext.newPage(); await login(owner); const detail = await create(owner, site);
    await openSharing(owner, detail.revision.id, 2); const old = await createLink(owner, 'First shared copy');
    const guest = await guestContext.newPage(); await guest.goto(old.url); await expect(reader(guest)).toContainText('Private second-version argument');
    await shareDialog(owner).locator(`[data-share-id="${old.id}"]`).getByRole('button', { name: 'Revoke link', exact: true }).click();
    await expect(shareDialog(owner).locator(`[data-share-id="${old.id}"]`)).toContainText('Revoked');
    await guest.evaluate(() => window.dispatchEvent(new Event('focus'))); await unavailable(guest);
    const generic = await guest.getByRole('heading', { name: 'Paper unavailable', exact: true }).locator('..').textContent();
    await unchanged(owner, site, detail); await noPersistentPaper(guest, old.token);
    const fresh = await createLink(owner, 'Replacement shared copy'); expect(fresh.token).not.toBe(old.token);
    await guest.goto(fresh.url); await expect(reader(guest)).toContainText('Private second-version argument');
    for (const token of [old.token, 'A'.repeat(43), 'malformed']) {
      await guest.goto(new URL(`#paper-share/${token}`, site).href); await unavailable(guest);
      expect(await guest.getByRole('heading', { name: 'Paper unavailable', exact: true }).locator('..').textContent()).toBe(generic);
    }
    await guest.goto(fresh.url); await expect(reader(guest)).toContainText('Private second-version argument');
    await unchanged(owner, site, detail);
  } finally { await Promise.all([ownerContext.close(), guestContext.close()]); }
});

test('a link stays pinned across new versions and clears protected content when the reader goes offline', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info), guestContext = await context(browser, site, info);
  try {
    const owner = await ownerContext.newPage(); await login(owner); const detail = await create(owner, site);
    await openSharing(owner, detail.revision.id, 1); const link = await createLink(owner, 'Pinned original');
    await api(owner, site, `/revisions/${detail.revision.id}/versions`, { expectedVersion: 2, message: 'New work does not extend an existing share.', files: files(3) });
    const guest = await guestContext.newPage(); await guest.goto(link.url); await expect(reader(guest)).toContainText('Private first-version argument');
    await expect(reader(guest)).not.toContainText('Private later-version argument'); await expect(reader(guest)).toContainText('Version 1');
    await guestContext.setOffline(true); await expect(guest.getByRole('heading', { name: 'Reconnect to open this paper', exact: true })).toBeVisible(); await expect(guest.getByRole('button', { name: 'Download source', exact: true })).toHaveCount(0); await expect(reader(guest)).not.toContainText('Private first-version argument'); await noPersistentPaper(guest, link.token);
    await guestContext.setOffline(false); await guest.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(reader(guest)).toContainText('Private first-version argument');
    await guestContext.setOffline(true); await expect(guest.getByRole('heading', { name: 'Reconnect to open this paper', exact: true })).toBeVisible(); await expect(guest.getByRole('button', { name: 'Download source', exact: true })).toHaveCount(0); await expect(reader(guest)).not.toContainText('Private first-version argument');
    await api(owner, site, `/revisions/${detail.revision.id}/share-links/${link.id}/revoke`, {});
    await guestContext.setOffline(false); await guest.evaluate(() => window.dispatchEvent(new Event('focus'))); await unavailable(guest);
    await guest.reload(); await unavailable(guest); await noPersistentPaper(guest, link.token);
    const after = await api<RevisionDetail>(owner, site, `/revisions/${detail.revision.id}`);
    expect(after.versions.slice(0, 2)).toEqual(detail.versions); expect(after.versions).toHaveLength(3); expect(after.versions[2]!.files).toEqual(files(3));
  } finally { await Promise.all([ownerContext.close(), guestContext.close()]); }
});

test('imported papers default to private access and workspace visibility requires an explicit choice', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info), memberContext = await context(browser, site, info);
  try {
    const owner = await ownerContext.newPage(), member = await memberContext.newPage(); await login(owner); await login(member, 1);
    const state = await api<AppState>(owner, site, '/state');
    const imported = async (visibility: 'private' | 'workspace') => {
      await owner.goto('./#papers'); await owner.getByRole('button', { name: 'Create Paper', exact: true }).click();
      const dialog = owner.getByRole('dialog'); await expect(dialog.getByLabel(/^Paper visibility/)).toHaveValue('private');
      if (visibility === 'workspace') await dialog.getByLabel(/^Paper visibility/).selectOption('workspace');
      await dialog.getByLabel('Title', { exact: true }).fill(`Imported ${visibility} paper ${randomUUID()}`);
      await dialog.getByLabel('Test Plan', { exact: true }).fill('Read the converted mathematics against the original PDF.');
      await dialog.getByLabel('Import source', { exact: true }).setInputFiles({ name: 'converted-paper.tex', mimeType: 'application/x-tex', buffer: Buffer.from(sources[0]!) });
      await expect(dialog.getByLabel(/^LaTeX source/)).toHaveValue(sources[0]!.replace(/\r\n/g, '\n'));
      const saved = owner.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/revisions') && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Create Paper', exact: true }).click(); const response = await saved;
      expect(response.ok(), await response.text()).toBe(true); const detail = await response.json() as RevisionDetail;
      await expect(dialog).toHaveCount(0);
      expect(detail.versions[0]!.files).toEqual([{ path: 'converted-paper.tex', content: sources[0] }]);
      const expected = visibility === 'private' ? { kind: 'principals', principalIds: [state.currentPrincipalId] } : { kind: 'workspace' };
      for (const capability of ['view', 'edit', 'interact'] as const) expect(detail.access?.policy.rules[capability]).toEqual(expected);
      return detail;
    };
    const privatePaper = await imported('private');
    const denied = await member.evaluate(async ({ site, id }) => {
      const session = await (await fetch(new URL('api/session', site))).json();
      const response = await fetch(new URL(`api/revisions/${id}`, site), { headers: { 'X-Session-Context': session.sessionContext } });
      return { status: response.status, body: await response.text() };
    }, { site, id: privatePaper.revision.id });
    expect(denied.status).toBe(404); expect(denied.body).not.toContain(privatePaper.revision.title); expect(denied.body).not.toContain(sources[0]!);
    const memberState = await api<AppState>(member, site, '/state'); expect(memberState.revisions.some(item => item.id === privatePaper.revision.id)).toBe(false);
    const workspacePaper = await imported('workspace');
    const visible = await api<RevisionDetail>(member, site, `/revisions/${workspacePaper.revision.id}`); expect(visible.versions).toEqual(workspacePaper.versions);
    await unchanged(owner, site, privatePaper);
  } finally { await Promise.all([ownerContext.close(), memberContext.close()]); }
});

test('a delayed successful read cannot restore source after a newer revocation response', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info), guestContext = await context(browser, site, info);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let delivered!: () => void; const completed = new Promise<void>(resolve => { delivered = resolve; });
  try {
    const owner = await ownerContext.newPage(); await login(owner); const detail = await create(owner, site);
    await openSharing(owner, detail.revision.id, 1); const link = await createLink(owner, 'Race-safe sharing');
    const guest = await guestContext.newPage(); await guest.goto(link.url); await expect(reader(guest)).toContainText('Private first-version argument');
    let intercepted = false, waiting = false;
    await guest.route('**/api/paper-shares/read', async route => {
      if (intercepted) { await route.continue(); return; }
      intercepted = true;
      try {
        const response = await route.fetch(); expect(response.ok()).toBe(true); waiting = true;
        await held;
        // A later verification aborts this transport; delivery may then reject.
        await route.fulfill({ response }).catch(() => {});
      } finally { delivered(); }
    });
    await guest.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => waiting).toBe(true);
    await api(owner, site, `/revisions/${detail.revision.id}/share-links/${link.id}/revoke`, {});
    await guest.evaluate(() => window.dispatchEvent(new Event('focus'))); await unavailable(guest);
    release(); await completed; await unavailable(guest); await noPersistentPaper(guest, link.token);
    await unchanged(owner, site, detail);
  } finally { release(); await Promise.all([ownerContext.close(), guestContext.close()]); }
});

test('a started workspace preserves an unsent review across shared reading and still locks on cross-tab sign-out', async ({ browser, baseURL }, info) => {
  const site = protectedURL(baseURL!), ownerContext = await context(browser, site, info);
  try {
    const owner = await ownerContext.newPage(); await login(owner); const detail = await create(owner, site);
    await openSharing(owner, detail.revision.id, 2); const link = await createLink(owner, 'Same-tab reading');
    await shareDialog(owner).getByRole('button', { name: 'Close', exact: true }).click();
    const draft = 'Unpublished review of the private proof: verify the β term.';
    await owner.getByLabel('Review comment', { exact: true }).fill(draft);
    const warn = () => owner.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    await expect.poll(warn).toBe(true);
    await owner.evaluate(hash => { location.hash = hash; }, new URL(link.url).hash);
    await expect(reader(owner)).toContainText('Private second-version argument');
    await expect(owner.getByLabel('Review comment', { exact: true })).toHaveCount(0); await expect.poll(warn).toBe(true);
    await owner.evaluate(id => { location.hash = id; }, detail.revision.id);
    await expect(owner.getByLabel('Review comment', { exact: true })).toHaveValue(draft);
    await unchanged(owner, site, detail);
    await owner.evaluate(hash => { location.hash = hash; }, new URL(link.url).hash);
    await expect(reader(owner)).toContainText('Private second-version argument'); await expect.poll(warn).toBe(true);
    const other = await ownerContext.newPage(); await other.goto('./#home');
    await expect(other.locator('.signed-in-user')).toHaveText(authAccounts[0].displayName);
    await other.getByRole('button', { name: 'Sign Out', exact: true }).click();
    await other.getByRole('button', { name: /sign out and clear drafts/i }).click();
    await expect(other.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
    await expect.poll(warn).toBe(false);
    await expect(reader(owner)).toBeVisible();
    await owner.evaluate(id => { location.hash = id; }, detail.revision.id);
    await expect(owner.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
    await expect(owner.getByLabel('Review comment', { exact: true })).toHaveCount(0); await expect(reader(owner)).toHaveCount(0);
    expect(await owner.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain(draft);
  } finally { await ownerContext.close(); }
});
