import { expect, test, type Page } from '@playwright/test';
import type { AppState, RevisionDetail } from '../shared/types';
import type { AIProposalDetail, AIProposalList } from '../shared/ai-proposals';
import type { ObjectAccess } from '../shared/policy';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';
import { openPaperTools } from './paper-focus-browser';

test.skip(process.env.E2E_AI_PROPOSALS_FIXTURE !== '1', 'Requires the explicit synthetic proposal adapter; never calls a real model.');

const panel = (page: Page) => page.getByRole('region', { name: 'AI edit proposals', exact: true });
const inspection = (page: Page) => panel(page).getByRole('region', { name: 'AI proposal inspection', exact: true });
const hosted = (page: Page) => panel(page).getByRole('button', { name: 'Send to hosted AI and propose edits', exact: true });
async function create(page: Page, title: string, content = 'A rough argument.\nAnother rough explanation.\n', kind: 'document' | 'paper' = 'document') {
  await page.goto('./#home');
  return api<RevisionDetail>(page, '/revisions', { title, kind, summary: '', testPlan: 'Verify explicit AI proposals using an injected test adapter. No provider is called.', files: [{ path: kind === 'paper' ? 'paper.tex' : 'draft.md', content }] });
}
async function open(page: Page, id: string, paper = false) { await page.goto(`./#${id}`); if (paper) await openPaperTools(page, 'AI edit proposals'); await expect(panel(page).getByRole('heading', { name: 'AI edit proposals', exact: true })).toBeVisible(); await expect(panel(page)).toContainText('test-only-hosted-model'); }
async function generate(page: Page, instruction = 'Clarify rough phrasing while preserving every claim.') { await panel(page).getByLabel('Editing instruction', { exact: true }).fill(instruction); await expect(hosted(page)).toBeEnabled(); await hosted(page).click(); await expect(inspection(page)).toContainText('Inspect the complete proposal'); await expect(inspection(page)).toContainText('ready'); }

test('complete AI proposals page every edit and explicitly apply them as one new text version', async ({ page }, info) => {
  const source = Array.from({ length: 12 }, (_, index) => `Sentence ${index + 1} has rough phrasing.`).join('\n');
  const created = await create(page, 'Complete AI proposal', source), id = created.revision.id;
  await open(page, id); await expect(panel(page)).toContainText('complete text of these 1 files'); await generate(page);
  await expect(inspection(page)).toContainText('Complete proposal: 12 edits.'); await expect(inspection(page).getByRole('article')).toHaveCount(10);
  await inspection(page).getByRole('button', { name: 'Last passages', exact: true }).click(); await expect(inspection(page).getByRole('article', { name: 'AI edit 12', exact: true })).toBeVisible();
  await expect(inspection(page).locator('.suggestion-original')).toHaveText(['rough', 'rough']); await expect(inspection(page).locator('.suggestion-replacement')).toHaveText(['clear', 'clear']);
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
  await inspection(page).locator('details').first().locator('summary').click(); await expect(inspection(page)).toContainText('Submitted source SHA-256');
  const apply = inspection(page).getByRole('button', { name: 'Apply all 12 edits as one version', exact: true }); await expect(apply).toBeEnabled();
  await apply.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await inspection(page).screenshot({ path: info.outputPath('ai-proposal-complete-preview.png') });
  await apply.click(); await expect.poll(async () => (await api<RevisionDetail>(page, `/revisions/${id}`)).versions.length).toBe(2);
  const after = await api<RevisionDetail>(page, `/revisions/${id}`); expect(after.versions[1]!.files[0]!.content).toBe(source.replaceAll('rough', 'clear')); expect(after.revision.currentVersion).toBe(2); expect(after.reviews).toEqual([]);
  const result = await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`); expect(result.items).toHaveLength(1); expect(result.items[0]!.applied?.toVersion).toBe(2);
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('fixture-call-');
});

test('lost generation receipt recovers the original request without changing newer instructions or replaying on reconnect', async ({ page, context }) => {
  const created = await create(page, 'AI generation recovery'), id = created.revision.id;
  await open(page, id); const bodies: unknown[] = [], keys: string[] = []; let failed = false;
  await page.route(`**/api/revisions/${id}/ai-proposals`, async route => { if (route.request().method() !== 'POST') return route.continue(); bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!failed) { failed = true; const response = await route.fetch(); expect(response.ok()).toBe(true); return route.abort('failed'); } return route.continue(); });
  await panel(page).getByLabel('Editing instruction', { exact: true }).fill('Original exact generation instruction'); await hosted(page).click(); await expect(panel(page).getByRole('button', { name: 'Recover generation', exact: true })).toBeEnabled();
  const listed = await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`), first = await api<AIProposalDetail>(page, `/revisions/${id}/ai-proposals/${listed.items[0]!.id}`);
  await panel(page).getByLabel('Editing instruction', { exact: true }).fill('Newer unsent instruction'); await page.goto('./#home'); await open(page, id); await expect(panel(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Newer unsent instruction');
  await context.setOffline(true); await expect(panel(page).getByRole('button', { name: 'Recover generation', exact: true })).toBeDisabled(); await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(panel(page).getByRole('button', { name: 'Recover generation', exact: true })).toBeEnabled(); expect(bodies).toHaveLength(1);
  await panel(page).getByRole('button', { name: 'Recover generation', exact: true }).click(); await expect(panel(page).getByRole('region', { name: 'Unconfirmed AI proposal request', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
  const after = await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`), recovered = await api<AIProposalDetail>(page, `/revisions/${id}/ai-proposals/${after.items[0]!.id}`); expect(after.items).toHaveLength(1); expect(recovered.proposal.provenance).toEqual(first.proposal.provenance);
  await expect(panel(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Newer unsent instruction'); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
});

test('same-session verification during an exact generation retry preserves the in-flight receipt and newer instruction', async ({ page }) => {
  const created = await create(page, 'AI same-session recovery'), id = created.revision.id;
  await open(page, id);
  const bodies: unknown[] = [], keys: string[] = []; let drop = true;
  let releaseReceipt!: () => void, observedRetry!: () => void;
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const retryStarted = new Promise<void>(resolve => { observedRetry = resolve; });
  await page.route(`**/api/revisions/${id}/ai-proposals`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!);
    const response = await route.fetch();
    if (drop) { drop = false; return route.abort('failed'); }
    observedRetry(); await receiptGate; return route.fulfill({ response });
  });
  try {
    await panel(page).getByLabel('Editing instruction', { exact: true }).fill('Original exact request'); await hosted(page).click();
    const recover = panel(page).getByRole('button', { name: 'Recover generation', exact: true }); await expect(recover).toBeEnabled();
    await panel(page).getByLabel('Editing instruction', { exact: true }).fill('Newer unsent instructions');
    await recover.click(); await retryStarted;
    // SessionGate verifies the same login on focus and replaces its context
    // wrapper. That is not a source, account or permission change.
    const verified = page.waitForResponse(response => response.url().endsWith('/api/session') && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await (await verified).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(recover).toBeDisabled(); releaseReceipt();
    await expect(panel(page).getByRole('region', { name: 'Unconfirmed AI proposal request', exact: true })).toHaveCount(0);
    await expect(panel(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Newer unsent instructions');
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
    expect((await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`)).items).toHaveLength(1);
    expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
  } finally { releaseReceipt(); }
});

test('lost apply receipt retries every edit exactly once and keeps a newer authored instruction', async ({ page }) => {
  const created = await create(page, 'AI apply recovery'), id = created.revision.id; await open(page, id); await generate(page);
  const bodies: unknown[] = [], keys: string[] = []; let failed = false;
  await page.route(`**/api/revisions/${id}/ai-proposals/*/apply`, async route => { bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!failed) { failed = true; const response = await route.fetch(); expect(response.ok()).toBe(true); return route.abort('failed'); } return route.continue(); });
  await inspection(page).getByRole('button', { name: 'Apply all 2 edits as one version', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Retry exact apply', exact: true })).toBeEnabled();
  await panel(page).getByLabel('Editing instruction', { exact: true }).fill('A newer private instruction after applying'); await panel(page).getByRole('button', { name: 'Retry exact apply', exact: true }).click();
  await expect(panel(page).getByRole('region', { name: 'Unconfirmed AI proposal request', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(2);
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(panel(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('A newer private instruction after applying');
});

test('selected LaTeX passage uploads only its scope and stale proposals remain bound to their original version', async ({ page }) => {
  const source = '\\section{Argument}\nFirst rough claim.\nSecond rough claim.\n', created = await create(page, 'Scoped paper AI proposal', source, 'paper'), id = created.revision.id;
  await open(page, id, true); await page.getByRole('button', { name: 'Source', exact: true }).click(); await page.getByLabel('Passage start line', { exact: true }).fill('2'); await page.getByLabel('Passage end line', { exact: true }).fill('2'); await page.getByRole('button', { name: 'Use line range for AI', exact: true }).click(); await expect(page.locator('.comment-form blockquote')).toHaveCount(0); await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('');
  await panel(page).getByRole('button', { name: 'Use selected passage only', exact: true }).click(); await expect(panel(page)).toContainText('Adjacent text, other files, comments, and binary attachments are excluded.'); await generate(page);
  const list = await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`), result = await api<AIProposalDetail>(page, `/revisions/${id}/ai-proposals/${list.items[0]!.id}`); expect(result.proposal.request.scope?.quote).toBe('First rough claim.'); expect(result.proposal.result?.edits).toHaveLength(1);
  await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'paper.tex', content: `${source}Independent newer source.\n` }], message: 'Concurrent source change' });
  await page.reload(); await openPaperTools(page, 'AI edit proposals'); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await panel(page).getByRole('button', { name: 'Inspect proposal', exact: true }).click(); await expect(inspection(page)).toContainText('This proposal is stale.'); await expect(inspection(page).getByRole('button', { name: 'Apply all 1 edits as one version', exact: true })).toBeDisabled();
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2'); await expect(inspection(page)).toHaveCount(0); await expect(panel(page).getByRole('button', { name: 'Use selected passage only', exact: true })).toBeDisabled(); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(2);
});

test('no-change and unavailable-model states never invent edits or perform provider calls', async ({ page }) => {
  const created = await create(page, 'No-change AI proposal'), id = created.revision.id; await open(page, id); await panel(page).getByLabel('Editing instruction', { exact: true }).fill('No changes'); await hosted(page).click(); await expect(inspection(page)).toContainText('The provider proposed no changes.'); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
  await page.route(`**/api/revisions/${id}/ai-proposals`, async route => { if (route.request().method() !== 'GET') throw new Error('An unconfigured provider must not receive generation requests.'); const response = await route.fetch(), body = await response.json(); await route.fulfill({ response, json: { ...body, configuration: { configured: false, model: null, localConfigured: false, localModel: null } } }); });
  await panel(page).getByRole('button', { name: 'Refresh proposals', exact: true }).click(); await expect(panel(page)).toContainText('No AI model is configured by the server operator.'); await expect(hosted(page)).toBeDisabled(); await expect(panel(page).getByRole('button', { name: 'Request local AI edit proposal', exact: true })).toBeDisabled();
});

test('private results are account-specific and access loss immediately removes generated text', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const created = await create(alice.page, 'Account-private AI proposals'), id = created.revision.id; await open(bob.page, id); await generate(bob.page, 'Bob private generation instruction');
    await expect(inspection(bob.page).locator('.suggestion-replacement').first()).toHaveText('clear'); await open(alice.page, id); await expect(panel(alice.page)).toContainText('No private proposals on this page.');
    const policy = (await api<ObjectAccess>(alice.page, `/policies/${id}`)).policy, state = await api<AppState>(alice.page, '/state');
    await api(alice.page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [state.currentPrincipalId] }, edit: policy.rules.edit, interact: policy.rules.interact }, 'PUT');
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(panel(bob.page)).toHaveCount(0); await expect(bob.page.locator('.suggestion-replacement')).toHaveCount(0);
    expect(await bob.page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('Bob private generation instruction');
  } finally { await alice.context.close(); await bob.context.close(); }
});
