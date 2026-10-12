import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, ReviewComment } from '../shared/types';
import type { ReviewDraftSnapshot } from '../shared/review-drafts';
import type { FileRecord } from '../shared/files';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';
const tray = (page: Page) => page.getByRole('region', { name: 'Pending private review', exact: true });
const composer = (page: Page) => page.locator('.comment-form');
async function create(page: Page, title: string) { await page.goto('./#home'); return api<RevisionDetail>(page, '/revisions', { title, kind: 'document', summary: '', testPlan: 'Inspect exact private draft publication and source.', files: [{ path: 'draft.md', content: 'First statement.\nSecond exact argument.\nThird conclusion.\n' }] }); }
async function openTray(page: Page) { const details = tray(page).locator(':scope > details'); if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click(); }
async function open(page: Page, id: string) { await page.goto(`./#${id}`); await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${id} `) })).toContainText(id); await openTray(page); await expect(tray(page).getByRole('button', { name: 'Reload private drafts', exact: true })).toBeEnabled(); }
async function stage(page: Page, text: string, form: Locator = composer(page)) { await form.getByRole('textbox').first().fill(text); const button = form.getByRole('button', { name: 'Save Private Draft', exact: true }); await expect(button).toBeEnabled(); await button.click(); await expect(form.getByRole('textbox').first()).toHaveValue(''); await expect(tray(page).getByRole('status').filter({ hasText: 'Private draft saved' })).toBeVisible(); }
async function exportDraft(page: Page, scope: Locator) { const waiting = page.waitForEvent('download'); await scope.getByRole('button', { name: 'Export private draft', exact: true }).click(); const bytes: Buffer[] = []; for await (const part of (await (await waiting).createReadStream())!) bytes.push(Buffer.from(part)); return JSON.parse(Buffer.concat(bytes).toString()); }

test('private text, suggestion, reply and summary drafts stay exact across versions and publish one complete batch', async ({ page }, info) => {
  const created = await create(page, 'Complete private review'), id = created.revision.id, original = created.versions[0]!;
  const root = await api<ReviewComment>(page, `/revisions/${id}/comments`, { body: 'Existing public thread', versionId: original.id });
  await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'A later immutable source.\n' }], message: 'Second version' });
  await open(page, id); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Passage start line', { exact: true }).fill('2'); await page.getByLabel('Passage end line', { exact: true }).fill('2'); await page.getByRole('button', { name: 'Comment on line range', exact: true }).click();
  await composer(page).getByRole('checkbox', { name: 'Suggest an edit', exact: true }).check(); await composer(page).getByLabel('Suggested replacement', { exact: true }).fill('Second precise argument.'); await stage(page, '  Private exact suggestion <script>literal</script>\n');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2'); await stage(page, 'Private current-version root');
  const thread = page.locator('.review-thread').filter({ hasText: 'Existing public thread' }); await thread.getByRole('button', { name: 'Reply', exact: true }).click(); await stage(page, 'Private reply viewed on v2', thread.locator('.thread-reply'));
  await tray(page).getByRole('button', { name: 'Write review summary', exact: true }).click(); await tray(page).getByLabel('Private review summary', { exact: true }).fill('Complete review summary'); await tray(page).getByRole('button', { name: 'Save private entry', exact: true }).click();
  await expect(tray(page).locator('.private-review-entry')).toHaveCount(4); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments.map(item => item.id)).toEqual([root.id]);
  const saved = await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`); expect(new Set(saved.entries.map(item => item.id)).size).toBe(4);
  const suggested = saved.entries.find(item => item.payload.kind === 'comment' && item.payload.suggestion)!; expect(suggested.payload).toMatchObject({ versionId: original.id, contentHash: original.contentHash, filePath: 'draft.md', passage: { quote: 'Second exact argument.' }, suggestion: { replacement: 'Second precise argument.' } });
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click(); const preview = tray(page).getByRole('region', { name: 'Complete private review preview', exact: true }); await expect(preview.locator('article')).toHaveCount(4); await expect(preview).toContainText('Unsaved local edits are excluded'); expect(await preview.locator('script').count()).toBe(0); await expect(preview.locator('.suggestion-original')).toHaveText('Second exact argument.'); await expect(preview.locator('.suggestion-replacement')).toHaveText('Second precise argument.');
  await preview.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if (info.project.name === 'mobile') { const box = (await preview.getByRole('button', { name: 'Publish private review', exact: true }).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); }
  await preview.screenshot({ path: info.outputPath('private-review-preview-region.png') }); await page.screenshot({ path: info.outputPath('private-review-preview.png'), fullPage: true }); await preview.getByRole('button', { name: 'Publish private review', exact: true }).click(); await expect(tray(page).locator('.private-review-entry')).toHaveCount(0);
  const result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.comments).toHaveLength(5); expect(result.comments.find(item => item.body === 'Private reply viewed on v2')).toMatchObject({ threadId: root.id, versionId: original.id, viewedVersionId: result.versions[1]!.id }); expect(result.comments.find(item => item.body.startsWith('  Private exact'))).toMatchObject({ versionId: original.id, anchor: { quote: 'Second exact argument.' }, suggestion: { replacement: 'Second precise argument.' } }); expect(result.versions).toHaveLength(2); expect(result.reviews).toEqual([]); expect(result.suggestionApplications).toEqual([]);
});

test('lost private-save receipt retries identical intent and preserves a newer remounted composer', async ({ page }) => {
  const created = await create(page, 'Private save recovery'), id = created.revision.id, bodies: unknown[] = [], keys: string[] = []; let failed = false;
  await open(page, id); await page.route(`**/api/revisions/${id}/review-drafts/*`, async route => { if (route.request().method() !== 'PUT') return route.continue(); bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!failed) { failed = true; const response = await route.fetch(); expect(response.ok()).toBe(true); return route.abort('failed'); } return route.continue(); });
  await composer(page).getByLabel('Review comment', { exact: true }).fill('The exact staged comment'); await composer(page).getByRole('button', { name: 'Save Private Draft', exact: true }).click(); await expect(tray(page).getByRole('region', { name: 'Unconfirmed private review request', exact: true })).toBeVisible();
  await composer(page).getByLabel('Review comment', { exact: true }).fill('A newer unsent comment'); await page.goto('./#home'); await open(page, id); await expect(composer(page).getByLabel('Review comment', { exact: true })).toHaveValue('A newer unsent comment');
  await tray(page).getByRole('button', { name: 'Retry exact private review request', exact: true }).click(); await expect(tray(page).getByRole('region', { name: 'Unconfirmed private review request', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); await expect(composer(page).getByLabel('Review comment', { exact: true })).toHaveValue('A newer unsent comment'); expect((await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`)).entries).toHaveLength(1); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
});

test('lost publication receipt preserves unsynced edits after server entries disappear and never publishes on reconnect', async ({ page, context }) => {
  const created = await create(page, 'Private publication recovery'), id = created.revision.id; await open(page, id); await stage(page, 'Saved exact publication');
  const card = tray(page).locator('.private-review-entry'); await card.getByRole('button', { name: 'Edit private draft', exact: true }).click(); await card.getByLabel('Private draft text', { exact: true }).fill('Newer unsaved local private edit');
  const bodies: unknown[] = [], keys: string[] = []; let failed = false;
  await page.route(`**/api/revisions/${id}/review-drafts/publish`, async route => { bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!failed) { failed = true; const response = await route.fetch(); expect(response.ok()).toBe(true); return route.abort('failed'); } return route.continue(); });
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click(); const preview = tray(page).getByRole('region', { name: 'Complete private review preview', exact: true }); await expect(preview).toContainText('Saved exact publication'); await expect(preview).not.toContainText('Newer unsaved local private edit'); await preview.getByRole('button', { name: 'Publish private review', exact: true }).click(); await expect(tray(page).getByRole('region', { name: 'Unconfirmed private review request', exact: true })).toBeVisible();
  await tray(page).getByRole('button', { name: 'Reload private drafts', exact: true }).click(); const local = tray(page).locator('.private-review-orphan'); await expect(local.getByLabel('Private draft text', { exact: true })).toHaveValue('Newer unsaved local private edit'); expect((await exportDraft(page, local)).payload.body).toBe('Newer unsaved local private edit');
  await context.setOffline(true); await expect(tray(page).getByRole('button', { name: 'Retry exact private review request', exact: true })).toBeDisabled(); await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); expect(bodies).toHaveLength(1);
  await tray(page).getByRole('button', { name: 'Retry exact private review request', exact: true }).click(); await expect(tray(page).getByRole('region', { name: 'Unconfirmed private review request', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments.map(item => item.body)).toEqual(['Saved exact publication']); await expect(local.getByLabel('Private draft text', { exact: true })).toHaveValue('Newer unsaved local private edit');
});

test('preview retires on inspected source changes and offline local edits preserve exact saved entry baselines', async ({ page, context }) => {
  const created = await create(page, 'Private offline drafts'), id = created.revision.id; await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Later text.\n' }], message: 'New source' }); await open(page, id); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await stage(page, 'Saved historical private comment');
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click(); await expect(tray(page).getByRole('button', { name: 'Publish private review', exact: true })).toBeEnabled(); await page.getByLabel('Version to inspect', { exact: true }).selectOption('2'); await expect(tray(page).getByRole('region', { name: 'Complete private review preview', exact: true })).toHaveCount(0);
  const card = tray(page).locator('.private-review-entry'); await card.getByRole('button', { name: 'Edit private draft', exact: true }).click(); await card.getByLabel('Private draft text', { exact: true }).fill('Offline unfinished edit'); const original = await exportDraft(page, card); await expect.poll(() => page.evaluate(({ id }) => Object.entries(localStorage).some(([key, value]) => key.includes(`review-draft-edit:${id}:`) && JSON.parse(value).payload.body === 'Offline unfinished edit'), { id })).toBe(true);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); let writes = 0; page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/review-drafts')) writes++; }); await context.setOffline(true);
  try { await page.reload(); await openTray(page); await expect(tray(page).getByLabel('Private draft text', { exact: true })).toHaveValue('Offline unfinished edit'); await expect(tray(page).getByRole('button', { name: 'Save private entry', exact: true })).toBeDisabled(); expect(await exportDraft(page, tray(page))).toEqual(original); } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  expect(writes).toBe(0); expect((await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`)).entries[0]!.payload).toMatchObject({ versionId: created.versions[0]!.id, body: 'Saved historical private comment' });
});

test('saved private drafts are account-private and interact revocation keeps local edits exportable without publication', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const created = await create(alice.page, 'Owner-only review drafts'), id = created.revision.id; await open(bob.page, id); await stage(bob.page, 'Bob private server draft'); await open(alice.page, id); await expect(tray(alice.page)).toContainText('No saved private drafts'); expect((await api<ReviewDraftSnapshot>(alice.page, `/revisions/${id}/review-drafts`)).entries).toEqual([]); expect((await api<RevisionDetail>(alice.page, `/revisions/${id}`)).comments).toEqual([]);
    const card = tray(bob.page).locator('.private-review-entry'); await card.getByRole('button', { name: 'Edit private draft', exact: true }).click(); await card.getByLabel('Private draft text', { exact: true }).fill('Bob newer local private edit'); expect(await bob.page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('Bob');
    const state = await api<AppState>(alice.page, '/state'), policy = (await api<import('../shared/policy').ObjectAccess>(alice.page, `/policies/${id}`)).policy;
    await api(alice.page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: policy.rules.view, edit: policy.rules.edit, interact: { kind: 'principals', principalIds: [state.currentPrincipalId] } }, 'PUT'); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob.page.locator('.quarantined-drafts')).toContainText('Bob newer local private edit'); await expect(tray(bob.page).getByRole('button', { name: 'Preview complete review', exact: true })).toBeDisabled(); expect((await api<RevisionDetail>(alice.page, `/revisions/${id}`)).comments).toEqual([]);
    await expect(tray(bob.page).getByRole('button', { name: 'Discard private draft', exact: true })).toBeEnabled(); bob.page.once('dialog', dialog => void dialog.accept()); await tray(bob.page).getByRole('button', { name: 'Discard private draft', exact: true }).click(); await expect(tray(bob.page).locator('.private-review-entry')).toHaveCount(0);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('private Word passage retains its exact package version and publishes without changing the imported package', async ({ page }) => {
  await page.goto('./#home'); const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(page, '/files', { name: 'private-review.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(page, '/state');
  const created = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Private Word review', testPlan: 'Verify exact original Word quotation and package.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch }), id = created.revision.id;
  await open(page, id); await page.locator('.docx-block').filter({ hasText: 'The original result is clear.' }).getByRole('button', { name: 'Discuss passage', exact: true }).click(); await page.getByLabel('First character', { exact: true }).fill('5'); await page.getByLabel('Last character', { exact: true }).fill('12'); await page.getByRole('button', { name: 'Comment on Word Passage', exact: true }).click(); await expect(composer(page).locator('blockquote')).toHaveText('original'); await stage(page, 'Inspect original Word wording'); await expect(tray(page).locator('.private-review-entry blockquote')).toHaveText('original'); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click(); await tray(page).getByRole('button', { name: 'Publish private review', exact: true }).click(); await expect(page.locator('.review-thread .docx-thread-anchor blockquote')).toHaveText('original'); const after = await api<RevisionDetail>(page, `/revisions/${id}`); expect(after.versions).toEqual(created.versions); expect(after.comments[0]!.docxAnchor).toMatchObject({ quote: 'original', versionId: created.versions[0]!.id, contentHash: created.versions[0]!.contentHash });
});

test('pagehide retires a held private save and resume can retry it before saving new work', async ({ page }) => {
  const created = await create(page, 'Private save page lifecycle'), id = created.revision.id;
  await open(page, id);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), committed = new Promise<void>(resolve => { arrived = resolve; });
  const bodies: unknown[] = [], keys: string[] = [];
  await page.route(`**/api/revisions/${id}/review-drafts/*`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!);
    if (bodies.length === 1) { const response = await route.fetch(); expect(response.ok()).toBe(true); arrived(); await held; return route.fulfill({ response }); }
    return route.continue();
  });
  await composer(page).getByLabel('Review comment', { exact: true }).fill('Private save across pagehide');
  await composer(page).getByRole('button', { name: 'Save Private Draft', exact: true }).click(); await committed;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  release();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(tray(page).locator('.private-review-entry')).toHaveCount(1);
  await expect(tray(page).getByRole('button', { name: 'Retry exact private review request', exact: true })).toBeEnabled();
  await tray(page).getByRole('button', { name: 'Retry exact private review request', exact: true }).click();
  await expect(tray(page).getByRole('region', { name: 'Unconfirmed private review request', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
  await stage(page, 'A separate later private comment');
  const saved = await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`);
  expect(saved.entries.map(entry => entry.payload.body).sort()).toEqual(['A separate later private comment', 'Private save across pagehide']);
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
});
