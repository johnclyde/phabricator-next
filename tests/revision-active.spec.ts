import { test, expect, type Page } from '@playwright/test';
import type { AppState, RevisionDetail, RevisionKind } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import type { RevisionAuthorshipSnapshot } from '../shared/revision-authorship';
import type { RevisionSubscriptionSnapshot } from '../shared/revision-subscriptions';
import type { RevisionViewsSnapshot } from '../shared/revision-views';
import { prepareSubscriptionDraft } from '../client/revision-subscriptions';
import { reviewerApi as api, reviewerSignIn as signIn, reviewerAction, reviewerBase as base } from './revision-reviewers-browser';
import { lifecycleAction } from './revision-lifecycle-browser';
import { authAccounts } from './auth-fixture';

const active = (page: Page) => page.getByRole('region', { name: 'Active revisions', exact: true });
const views = (page: Page) => page.getByRole('region', { name: 'Revision views', exact: true });
const search = (page: Page) => page.getByLabel('Search workspace', { exact: true });
const group = (page: Page, key: string) => active(page).locator(`[data-active-group="${key}"]`);
const row = (page: Page, id: string) => active(page).locator(`.revision-row[href="#${id}"]`);
const nonce = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const route = (kind: RevisionKind) => kind === 'code' ? 'reviews' : kind === 'paper' ? 'papers' : 'drafts';
async function openKind(page: Page, kind: RevisionKind) { await page.goto(`./#${route(kind)}`); await expect(views(page)).toBeVisible(); }
async function openActive(page: Page, kind: RevisionKind = 'paper') { await openKind(page, kind); await views(page).getByRole('button', { name: 'Active revisions', exact: true }).click(); await expect(active(page)).toBeVisible(); await expect(active(page).getByRole('button', { name: 'Refresh Active revisions', exact: true })).toBeEnabled(); }
async function refresh(page: Page) { await active(page).getByRole('button', { name: 'Refresh Active revisions', exact: true }).click(); await expect(active(page).getByRole('button', { name: 'Refresh Active revisions', exact: true })).toBeEnabled(); }
async function fillName(page: Page, title: string) { const disclosure = views(page).locator('.revision-view-management'); if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await disclosure.locator('summary').click(); await views(page).getByLabel('Revision view name', { exact: true }).fill(title); }
async function command(page: Page, value: string) { if (!await page.getByLabel('Workspace command', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); const input = page.getByLabel('Workspace command', { exact: true }); await input.fill(value); await input.press('Enter'); }
async function create(page: Page, title: string, kind: RevisionKind = 'paper', options: { draft?: boolean; content?: string } = {}) { return api<RevisionDetail>(page, '/revisions', { title, kind, ...(options.draft ? { draft: true } : {}), summary: '', testPlan: 'Verify exact current responsibility and preserve unrelated drafts.', files: [{ path: kind === 'paper' ? 'paper.tex' : 'source.txt', content: options.content ?? 'Exact source for an Active queue fixture.\n' }] }); }
const lifecycle = (page: Page, id: string, action: Parameters<typeof lifecycleAction>[2]) => lifecycleAction((path, body) => api(page, path, body), id, action);

test('Active groups exact author and reviewer work into all eight actions, excluding followers and unrelated revisions', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const tag = nonce('Eight actions'), aliceId = (await api<AppState>(alice.page, '/state')).currentPrincipalId!;
    const ids = new Map<string, string>();
    ids.set('waiting-on-review', (await create(alice.page, `${tag} own review`)).revision.id);
    ids.set('drafts', (await create(alice.page, `${tag} own draft`, 'paper', { draft: true })).revision.id);
    const land = (await create(alice.page, `${tag} accepted`)).revision.id; await reviewerAction(bob.page, land, 'accept'); ids.set('ready-to-land', land);
    const update = (await create(alice.page, `${tag} rejected`)).revision.id; await reviewerAction(bob.page, update, 'request_changes'); ids.set('ready-to-update', update);
    const review = (await create(bob.page, `${tag} assigned`)).revision.id; await reviewerAction(bob.page, review, 'add', aliceId); ids.set('ready-to-review', review);
    const must = (await create(bob.page, `${tag} required`)).revision.id; await reviewerAction(bob.page, must, 'add', aliceId); await reviewerAction(bob.page, must, 'block', aliceId); ids.set('must-review', must);
    const authors = (await create(bob.page, `${tag} author planning`)).revision.id; await reviewerAction(bob.page, authors, 'add', aliceId); await lifecycle(bob.page, authors, 'plan_changes'); ids.set('waiting-on-authors', authors);
    // A current human acceptance remains recorded while a deterministic error
    // prevents the revision from being accepted. No hosted AI is requested.
    const others = (await create(bob.page, `${tag} current acceptance`, 'paper', { content: '<<<<<<< fixture\nExact unresolved source.\n' })).revision.id;
    await api(bob.page, `/revisions/${others}/reviews`, { provider: 'local', expectedVersion: 1 }); await reviewerAction(alice.page, others, 'accept');
    expect((await api<RevisionDetail>(bob.page, `/revisions/${others}`)).revision.status).toBe('needs_review'); ids.set('waiting-on-other-reviewers', others);
    const followed = (await create(bob.page, `${tag} follower only`)).revision.id;
    const subscription = await api<RevisionSubscriptionSnapshot>(alice.page, `/revisions/${followed}/subscriptions`); await api(alice.page, `/revisions/${followed}/subscriptions`, prepareSubscriptionDraft(subscription, 'subscribe').input);
    const unrelated = (await create(bob.page, `${tag} unrelated`)).revision.id;
    await openActive(alice.page); await search(alice.page).fill(tag);
    await expect(active(alice.page).locator('details')).toHaveCount(8); await expect(active(alice.page).locator('.revision-row')).toHaveCount(8);
    for (const [key, id] of ids) { await expect(group(alice.page, key).locator(`.revision-row[href="#${id}"]`)).toBeVisible(); await expect(group(alice.page, key).locator('summary')).toContainText('1'); }
    await expect(row(alice.page, followed)).toHaveCount(0); await expect(row(alice.page, unrelated)).toHaveCount(0);
    expect((await api<AppState>(alice.page, '/state')).followingRevisionIds).toContain(followed);
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (info.project.name === 'mobile') for (const selector of ['summary', '.revision-row']) for (const box of await active(alice.page).locator(selector).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await active(alice.page).screenshot({ path: info.outputPath('active-eight-actions.png') });
    await search(alice.page).fill(must); await expect(active(alice.page).locator('.revision-row')).toHaveCount(1); await expect(row(alice.page, must)).toBeVisible();
    await search(alice.page).fill('No matching action'); await expect(active(alice.page)).toContainText('No active revisions match'); await expect(active(alice.page).locator('details[open]')).toHaveCount(0);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('changed source, voided rejection, resignation and authorship handoff change the current personal action', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const detail = await create(bob.page, nonce('Source and role')), id = detail.revision.id, aliceId = (await api<AppState>(alice.page, '/state')).currentPrincipalId!;
    await reviewerAction(alice.page, id, 'accept'); await openActive(alice.page); await search(alice.page).fill(id); await expect(group(alice.page, 'waiting-on-authors').locator('.revision-row')).toHaveCount(1);
    await api(bob.page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'paper.tex', content: 'Changed exact source invalidates previous acceptance.\n' }], message: 'Second source' }); await refresh(alice.page); await expect(group(alice.page, 'ready-to-review').locator('.revision-row')).toHaveCount(1);
    await reviewerAction(alice.page, id, 'request_changes'); await lifecycle(bob.page, id, 'plan_changes'); await lifecycle(bob.page, id, 'request_review'); await refresh(alice.page);
    await expect(group(alice.page, 'must-review').locator('.revision-row')).toHaveCount(1); await expect(group(alice.page, 'ready-to-review').locator('.revision-row')).toHaveCount(0);
    await reviewerAction(alice.page, id, 'resign'); await refresh(alice.page); await expect(row(alice.page, id)).toHaveCount(0);
    const before = await api<RevisionAuthorshipSnapshot>(bob.page, `/revisions/${id}/authorship`);
    await api(bob.page, `/revisions/${id}/authorship`, { action: 'assign', authorId: aliceId, expectedReviewerVersion: before.reviewerVersion, expectedLifecycleVersion: before.lifecycleVersion, expectedAuthorVersion: before.authorship.version, expectedVersion: before.head.number, expectedVersionId: before.head.versionId, expectedContentHash: before.head.contentHash, expectedAccessEpoch: before.accessEpoch, message: 'Transfer current responsibility' });
    await refresh(alice.page); await expect(group(alice.page, 'waiting-on-review').locator('.revision-row')).toHaveCount(1);
    expect((await api<RevisionDetail>(alice.page, `/revisions/${id}`)).versions).toHaveLength(2);
    await lifecycle(alice.page, id, 'abandon'); await refresh(alice.page); await expect(row(alice.page, id)).toHaveCount(0);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('Active voice navigation and search preserve independent unsaved filters for code, papers and documents', async ({ page }) => {
  await page.goto('./#home'); const tag = nonce('Kinds and voice'), ids = new Map<RevisionKind, string>();
  for (const kind of ['code', 'paper', 'document'] as const) ids.set(kind, (await create(page, `${tag} ${kind}`, kind)).revision.id);
  await page.reload(); let saves = 0; page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/revision-views')) saves++; });
  for (const [kind, noun] of [['code', 'revisions'], ['paper', 'papers'], ['document', 'documents']] as const) {
    await openKind(page, kind); await search(page).fill(`Unsaved ${kind} filter`); await fillName(page, `Unsaved ${kind} name`);
    await command(page, `show active ${noun}`); await expect(active(page)).toBeVisible(); await command(page, `search ${tag}`); await expect(search(page)).toHaveValue(tag); await expect(row(page, ids.get(kind)!)).toBeVisible();
    await expect(views(page)).toContainText('Your unsaved view name and filters are preserved.'); await expect(page.getByLabel('Revision project filter')).toHaveCount(0); await expect(views(page).getByLabel('Revision view name', { exact: true })).toHaveCount(0);
    await page.goto('./#home'); await openKind(page, kind); await expect(active(page)).toBeVisible(); await expect(search(page)).toHaveValue(tag);
    await views(page).getByRole('button', { name: 'Return to saved filters', exact: true }).click(); await expect(search(page)).toHaveValue(`Unsaved ${kind} filter`); await expect(views(page).getByLabel('Revision view name', { exact: true })).toHaveValue(`Unsaved ${kind} name`);
  }
  await views(page).getByRole('button', { name: 'Active revisions', exact: true }).click(); await page.reload(); await expect(active(page)).toBeVisible(); await expect(search(page)).toHaveValue(tag); expect(saves).toBe(0);
});

test('Active retains an exact lost saved-view request while newer filters remain untouched by explicit retry', async ({ page }) => {
  await page.goto('./#home'); await openKind(page, 'paper'); const original = nonce('Pending Active view'), newer = nonce('Unsent later view');
  await search(page).fill('Original saved query'); const bodies: unknown[] = [], keys: string[] = [];
  await page.route('**/api/revision-views', async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); bodies.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!); if (bodies.length === 1) { const response = await intercepted.fetch(); expect(response.ok()).toBe(true); return intercepted.abort('failed'); } return intercepted.continue(); });
  await fillName(page, original); await views(page).getByRole('button', { name: 'Save new view', exact: true }).click(); const retry = views(page).getByRole('button', { name: 'Retry saved view request', exact: true }); await expect(retry).toBeEnabled();
  await fillName(page, newer); await search(page).fill('Newer unsaved query'); await views(page).getByRole('button', { name: 'Active revisions', exact: true }).click(); await search(page).fill('Independent Active query'); await expect(retry).toBeEnabled(); await expect(views(page).getByRole('button', { name: 'Export view draft', exact: true })).toBeVisible(); expect(bodies).toHaveLength(1);
  await page.goto('./#home'); await openKind(page, 'paper'); await expect(active(page)).toBeVisible(); await expect(retry).toBeEnabled(); await retry.click(); await expect(retry).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
  await expect(search(page)).toHaveValue('Independent Active query'); await views(page).getByRole('button', { name: 'Return to saved filters', exact: true }).click(); await expect(search(page)).toHaveValue('Newer unsaved query'); await expect(views(page).getByLabel('Revision view name', { exact: true })).toHaveValue(newer);
  const inventory = await api<RevisionViewsSnapshot>(page, '/revision-views'); expect(inventory.views.filter(view => view.name === original)).toHaveLength(1); expect(inventory.views.some(view => view.name === newer)).toBe(false);
});

test('offline Active reopens its complete saved snapshot and editing its search never writes on reconnect', async ({ page, context }) => {
  await page.goto('./#home'); const tag = nonce('Offline Active'), id = (await create(page, tag)).revision.id; await page.reload(); await openKind(page, 'paper'); await search(page).fill('Protected saved filter'); await fillName(page, 'Protected unsaved name'); await views(page).getByRole('button', { name: 'Active revisions', exact: true }).click(); await search(page).fill(tag); await expect(row(page, id)).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); let writes = 0; page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/revision-views')) writes++; });
  await context.setOffline(true);
  try { await page.reload(); await expect(active(page)).toContainText('Saved Active queue'); await expect(row(page, id)).toBeVisible(); await search(page).fill('Offline queue query'); await expect(active(page)).toContainText('No active revisions match'); await expect(active(page).getByRole('button', { name: 'Refresh Active revisions', exact: true })).toBeDisabled(); await views(page).getByRole('button', { name: 'Return to saved filters', exact: true }).click(); await expect(search(page)).toHaveValue('Protected saved filter'); await expect(views(page).getByLabel('Revision view name', { exact: true })).toHaveValue('Protected unsaved name'); await views(page).getByRole('button', { name: 'Active revisions', exact: true }).click(); await expect(search(page)).toHaveValue('Offline queue query'); }
  finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  await expect(active(page).getByRole('button', { name: 'Refresh Active revisions', exact: true })).toBeEnabled(); await expect(search(page)).toHaveValue('Offline queue query'); expect(writes).toBe(0); await search(page).fill(tag); await expect(row(page, id)).toBeVisible();
});

test('legacy, incomplete, foreign and stale Active snapshots are unavailable rather than empty queues', async ({ browser }, info) => {
  const signedIn = await signIn(browser, info), page = signedIn.page;
  try {
    const detail = await create(page, nonce('Unavailable projection')), original = await api<AppState>(page, '/state');
    const variants: ((value: AppState) => void)[] = [value => { delete value.revisionActive; }, value => { value.revisionActive!.items = []; }, value => { value.revisionActive!.principalId = 'foreign-principal'; }, value => { value.revisionActive!.accessEpoch++; }, value => { value.revisionActive!.items.find(item => item.revisionId === detail.revision.id)!.head.number++; }, value => { value.revisionActive!.items.find(item => item.revisionId === detail.revision.id)!.reviewerVersion++; }];
    for (const corrupt of variants) {
      const response = structuredClone(original); corrupt(response); await page.route('**/api/state', intercepted => intercepted.fulfill({ json: response }));
      await page.reload(); await openActive(page); await expect(active(page)).toContainText('unavailable until a complete current workspace snapshot'); await expect(active(page).locator('.revision-row')).toHaveCount(0); await expect(active(page)).not.toContainText('No active revisions match');
      await views(page).getByRole('button', { name: 'Return to saved filters', exact: true }).click(); await search(page).fill(detail.revision.id); await expect(page.locator(`.revision-row[href="#${detail.revision.id}"]`)).toBeVisible(); await page.unroute('**/api/state');
    }
    await page.reload(); await openActive(page); await search(page).fill(detail.revision.id); await expect(row(page, detail.revision.id)).toBeVisible();
  } finally { await signedIn.context.close(); }
});

test('View loss removes responsibility and account retirement clears the private Active presentation', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const title = nonce('Private Active responsibility'), id = (await create(alice.page, title)).revision.id, bobId = (await api<AppState>(bob.page, '/state')).currentPrincipalId!;
    await reviewerAction(alice.page, id, 'add', bobId); await openActive(bob.page); await search(bob.page).fill(title); await expect(row(bob.page, id)).toBeVisible();
    const own = (await api<AppState>(alice.page, '/state')).currentPrincipalId!, policy = (await api<ObjectAccess>(alice.page, `/policies/${id}`)).policy;
    await api(alice.page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [own] } }, 'PUT'); await refresh(bob.page); await expect(row(bob.page, id)).toHaveCount(0); await expect(active(bob.page)).not.toContainText(title);
    const privateQuery = nonce('Bob private queue query'); await search(bob.page).fill(privateQuery); expect(await bob.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(privateQuery);
    await bob.page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await bob.page.getByRole('button', { name: 'Sign out and clear drafts', exact: true }).click(); await expect(bob.page.getByRole('button', { name: 'Sign In', exact: true })).toBeEnabled();
    await bob.page.getByLabel('Username', { exact: true }).fill(authAccounts[0].username); await bob.page.getByLabel('Password', { exact: true }).fill(authAccounts[0].password); await bob.page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(bob.page.locator('.signed-in-user')).toHaveText(authAccounts[0].displayName); await openKind(bob.page, 'paper'); await expect(active(bob.page)).toHaveCount(0); await expect(search(bob.page)).not.toHaveValue(privateQuery); await openActive(bob.page); await search(bob.page).fill(title); await expect(group(bob.page, 'waiting-on-review').locator(`.revision-row[href="#${id}"]`)).toBeVisible();
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('a delayed older same-epoch state cannot restore a resigned review responsibility', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let release = () => {};
  try {
    const id = (await create(alice.page, nonce('Late personal state'))).revision.id, bobId = (await api<AppState>(bob.page, '/state')).currentPrincipalId!; await reviewerAction(alice.page, id, 'add', bobId); await openActive(bob.page); await search(bob.page).fill(id); await expect(row(bob.page, id)).toBeVisible();
    let reached!: () => void, once = false; const captured = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await bob.page.route('**/api/state', async intercepted => { if (once) return intercepted.continue(); once = true; const response = await intercepted.fetch(); reached(); await held; return intercepted.fulfill({ response }); });
    await active(bob.page).getByRole('button', { name: 'Refresh Active revisions', exact: true }).click(); await captured; await reviewerAction(bob.page, id, 'resign'); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(row(bob.page, id)).toHaveCount(0);
    release(); await bob.page.unrouteAll({ behavior: 'wait' }); await expect(row(bob.page, id)).toHaveCount(0); await expect(active(bob.page)).toContainText('No active revisions match');
    expect((await api<AppState>(bob.page, '/state')).revisionActive!.items.find(item => item.revisionId === id)!.reviewerStatus).toBe('resigned');
  } finally { release(); await alice.context.close(); await bob.context.close(); }
});
