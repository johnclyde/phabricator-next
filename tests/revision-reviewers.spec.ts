import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import type { RevisionReviewerSnapshot } from '../shared/revision-reviewers';
import { reviewerBase as base, reviewerApi as api, reviewerPanel as panel, reviewerEditor as draft, reviewerSignIn as signIn, reviewerAction, confirmReviewer, selectReviewerAction, reviewerExport } from './revision-reviewers-browser';

const create = (page: Page, title: string) => api<RevisionDetail>(page, '/revisions', { title, kind: 'document', files: [{ path: 'draft.md', content: 'Exact human reviewed manuscript.\n' }] });
async function people(page: Page) { const state = await api<AppState>(page, '/state'); return { state, alice: state.principals.find(person => person.username === 'alice')!, bob: state.principals.find(person => person.username === 'bob')! }; }
async function restrictEdit(page: Page, id: string) { const { alice } = await people(page), policy = (await api<ObjectAccess>(page, `/policies/${id}`)).policy; await api(page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: policy.rules.view, edit: { kind: 'principals', principalIds: [alice.id] }, interact: { kind: 'workspace' } }, 'PUT'); }
const reload = (page: Page) => panel(page).getByRole('button', { name: 'Reload Reviewers', exact: true }).click();

test('named reviewer membership and exact human decisions work without Edit and preserve historical inspection', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const detail = await create(alice.page, 'Named manuscript review'), id = detail.revision.id, users = await people(alice.page); await restrictEdit(alice.page, id);
    await alice.page.goto(`./#${id}`); await panel(alice.page).getByRole('combobox', { name: 'Add a reviewer', exact: true }).selectOption(users.bob.id); await selectReviewerAction(alice.page, 'Add Reviewer'); await expect(panel(alice.page).locator('[data-reviewer-id]')).toContainText('Bob Editor');
    await selectReviewerAction(alice.page, 'Require Review'); await expect(panel(alice.page)).toContainText('Blocking Review'); await selectReviewerAction(alice.page, 'Make Review Optional');
    await bob.page.goto(`./#${id}`); await expect(panel(bob.page).getByRole('button', { name: 'Add Reviewer', exact: true })).toHaveCount(0); await selectReviewerAction(bob.page, 'Accept Version', 'I inspected the complete version.'); await expect(panel(bob.page).getByTestId('reviewer-summary')).toContainText('Accepted');
    const accepted = await api<RevisionDetail>(alice.page, `/revisions/${id}`); expect(accepted.versions).toEqual(detail.versions); expect(accepted.reviews).toEqual([]); await reload(alice.page); await expect(alice.page.locator('.revision-title .badge')).toHaveText('Accepted');
    await api(alice.page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'A new source invalidates the earlier human acceptance.\n' }], message: 'New source' }); await reload(bob.page); await expect(bob.page.getByLabel('Version to inspect', { exact: true })).toContainText('Version 2'); await bob.page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(panel(bob.page)).toContainText('Decision from an earlier review state');
    await selectReviewerAction(bob.page, 'Request Changes', 'Please revise the current second version.'); await expect(panel(bob.page).getByTestId('reviewer-summary')).toContainText('Changes Requested'); await expect(bob.page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await expect(panel(bob.page)).toContainText('Reviewer actions apply to current source version 2');
    await panel(bob.page).getByText('Reviewer History', { exact: true }).click(); await expect(panel(bob.page).locator('.revision-reviewer-history')).toContainText('Bob Editor'); await expect(panel(bob.page).locator('.revision-reviewer-history')).toContainText('I inspected the complete version.');
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if (info.project.name === 'mobile') { const box = (await panel(bob.page).getByRole('button', { name: 'Resign Review', exact: true }).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.height).toBeLessThanOrEqual(80); }
    const folder = `.data/revision-reviewers-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await panel(bob.page).evaluate(element => element.scrollIntoView({ block: 'start' })); await bob.page.evaluate(() => scrollBy(0, -110)); await bob.page.screenshot({ path: `${folder}/${info.project.name}-reviewers.png` });
    await selectReviewerAction(bob.page, 'Resign Review'); await expect(panel(bob.page).locator('[data-reviewer-id]')).toContainText('Resigned'); await reload(alice.page); await selectReviewerAction(alice.page, 'Remove Reviewer'); await expect(panel(alice.page)).toContainText('No named reviewers.');
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('Word manuscripts receive exact package acceptance without inventing automated evidence', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(alice.page, '/files', { name: 'human-review.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), { state, bob: reviewer } = await people(alice.page);
    const before = await api<RevisionDetail>(alice.page, '/revisions/docx', { title: 'Word reviewer decision', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: state.accessEpoch }); const id = before.revision.id; await reviewerAction(alice.page, id, 'add', reviewer.id); await restrictEdit(alice.page, id);
    await bob.page.goto(`./#${id}`); await expect(bob.page.getByLabel('Word document text')).toContainText('The original result is clear.'); await selectReviewerAction(bob.page, 'Accept Version', 'Reviewed this exact Word package.'); await expect(panel(bob.page)).toContainText('Acceptance basis: named reviewer decisions.');
    const folder = `.data/revision-reviewers-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await panel(bob.page).evaluate(element => element.scrollIntoView({ block: 'start' })); await bob.page.evaluate(() => scrollBy(0, -110)); await bob.page.screenshot({ path: `${folder}/${info.project.name}-word-reviewers.png` });
    const after = await api<RevisionDetail>(alice.page, `/revisions/${id}`); expect(after.versions).toEqual(before.versions); expect(after.reviews).toEqual([]); expect(after.revision.status).toBe('accepted');
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('lost human decision receipt retries the exact request without Edit and preserves a newer message', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const before = await create(alice.page, 'Human receipt recovery'), id = before.revision.id; await restrictEdit(alice.page, id); const bodies: unknown[] = [], keys: string[] = []; let first = true;
    await bob.page.route(`**/api/revisions/${id}/reviewers`, async route => { if (route.request().method() !== 'POST') return route.continue(); bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (first) { first = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await bob.page.goto(`./#${id}`); await selectReviewerAction(bob.page, 'Accept Version', 'Original exact decision'); await expect(panel(bob.page).getByRole('heading', { name: 'Unconfirmed Reviewer Change', exact: true })).toBeVisible(); await draft(bob.page).getByLabel('Reviewer message').fill('Later explanation retained separately');
    await panel(bob.page).getByRole('button', { name: 'Retry Exact Reviewer Change', exact: true }).click(); await expect(panel(bob.page).getByRole('heading', { name: 'Unconfirmed Reviewer Change', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); const retained = await reviewerExport(bob.page, 'Export Reviewer Draft'); expect(retained.message).toBe('Later explanation retained separately'); expect(retained.expectedReviewerVersion).toBe(0); expect((await api<RevisionDetail>(alice.page, `/revisions/${id}`)).versions).toEqual(before.versions);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('offline decision drafts never autosend and new proof leaves their original pins intact', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const before = await create(alice.page, 'Offline human review'), id = before.revision.id; await restrictEdit(alice.page, id); let writes = 0; bob.page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/revisions/${id}/reviewers`)) writes++; });
    await bob.page.goto(`./#${id}`); await expect(panel(bob.page).getByRole('button', { name: 'Accept Version', exact: true })).toBeEnabled(); await bob.context.setOffline(true); await bob.page.evaluate(() => window.dispatchEvent(new Event('offline'))); await panel(bob.page).getByRole('button', { name: 'Accept Version', exact: true }).click(); await draft(bob.page).getByLabel('Reviewer message').fill('Offline exact review'); await expect(draft(bob.page).getByRole('button', { name: 'Confirm Reviewer Action', exact: true })).toBeDisabled(); const original = await reviewerExport(bob.page, 'Export Reviewer Draft');
    await api(alice.page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 1 }); await bob.context.setOffline(false); await bob.page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(draft(bob.page)).toContainText('keeps its original versions'); expect(await reviewerExport(bob.page, 'Export Reviewer Draft')).toEqual(original); expect(writes).toBe(0); await expect(draft(bob.page).getByRole('button', { name: 'Confirm Reviewer Action', exact: true })).toBeDisabled();
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('late reviewer reads cannot restore old decisions and Interact loss holds exact work while preserving source view', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let release = () => {}; let handled = Promise.resolve();
  try {
    const before = await create(alice.page, 'Reviewer access retirement'), id = before.revision.id, users = await people(alice.page); await restrictEdit(alice.page, id); await bob.page.goto(`./#${id}`); await expect(panel(bob.page)).toContainText('No named reviewers.');
    let captured!: () => void; const observed = new Promise<void>(resolve => { captured = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await bob.page.route(`**/api/revisions/${id}/reviewers`, route => { handled = (async () => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); })(); return handled; }, { times: 1 });
    await reload(bob.page); await observed; await reviewerAction(alice.page, id, 'add', users.bob.id); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(panel(bob.page).locator('[data-reviewer-id]')).toContainText('Bob Editor'); release(); await handled; await expect(panel(bob.page).locator('[data-reviewer-id]')).toContainText('Bob Editor');
    await panel(bob.page).getByRole('button', { name: 'Request Changes', exact: true }).click(); await draft(bob.page).getByLabel('Reviewer message').fill('Retain after Interact loss'); const policy = (await api<ObjectAccess>(alice.page, `/policies/${id}`)).policy; await api(alice.page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: policy.rules.view, edit: policy.rules.edit, interact: { kind: 'principals', principalIds: [users.alice.id] } }, 'PUT'); await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob.page.locator('.quarantined-drafts')).toContainText('Retain after Interact loss'); await expect(draft(bob.page)).toHaveCount(0); await expect(bob.page.getByRole('heading', { level: 1, name: new RegExp(id) })).toBeVisible(); await expect(panel(bob.page).getByRole('button', { name: 'Accept Version', exact: true })).toBeDisabled();
  } finally { release(); await handled; await alice.context.close(); await bob.context.close(); }
});

test('visited local reviewer snapshots reopen offline without inventing decisions or replaying writes', async ({ page, context }) => {
  await page.goto('./#home'); const detail = await create(page, 'Offline visited reviewer list'), id = detail.revision.id; await page.goto(`./#${id}`); await expect(panel(page)).toContainText('No named reviewers.');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/revisions/${id}/reviewers`)) writes++; });
  await context.setOffline(true); await page.reload(); await expect(panel(page)).toContainText('No named reviewers.'); await expect(panel(page)).toContainText('Saved reviewer snapshot.'); await expect(panel(page).getByRole('button', { name: 'Accept Version', exact: true })).toBeDisabled();
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(panel(page)).not.toContainText('Saved reviewer snapshot.'); expect(writes).toBe(0); expect((await api<RevisionReviewerSnapshot>(page, `/revisions/${id}/reviewers`)).reviewers.members).toEqual([]);
});

test('a same-epoch metadata advance during history decoding cannot publish an older reviewer snapshot', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1); let release = () => {}; let handled = Promise.resolve();
  try {
    const detail = await create(alice.page, 'Concurrent reviewer metadata'), id = detail.revision.id; await alice.page.goto(`./#${id}`); await expect(panel(alice.page)).toContainText('No named reviewers.');
    let captured!: () => void; const observed = new Promise<void>(resolve => { captured = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await alice.page.route(`**/api/revisions/${id}/reviewers/history?*`, route => { handled = (async () => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); })(); return handled; }, { times: 1 });
    await reload(alice.page); await observed; const prior = await api<RevisionReviewerSnapshot>(alice.page, `/revisions/${id}/reviewers`); await reviewerAction(bob.page, id, 'accept');
    const current = await api<RevisionReviewerSnapshot>(alice.page, `/revisions/${id}/reviewers`); expect(current.accessEpoch).toBe(prior.accessEpoch); expect(current.reviewers.version).toBeGreaterThan(prior.reviewers.version);
    await alice.page.getByRole('region', { name: 'Revision Lifecycle', exact: true }).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await expect(alice.page.locator('.revision-title .badge')).toHaveText('Accepted');
    release(); await handled; await expect(panel(alice.page).locator('[data-reviewer-id]')).toContainText('Bob Editor'); await expect(panel(alice.page).getByTestId('reviewer-summary')).toContainText('Accepted');
  } finally { release(); await handled; await alice.context.close(); await bob.context.close(); }
});
