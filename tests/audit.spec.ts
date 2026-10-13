import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { inspectReceive } from '../server/git-receive-inspection';
import type { AuditDetail } from '../shared/audit';
import type { GitReceiveFacts, GitReceiveReceipt } from '../shared/git-automation';
import type { BuildDetail, BuildPlan } from '../shared/harbormaster';
import { lifecycleRequest } from './revision-lifecycle-browser';
import type { AppState, RevisionDetail } from '../shared/types';
import type { HeraldRule, HeraldTranscript } from '../shared/herald';

test.skip(process.env.E2E_AUTOMATION_FIXTURE !== '1', 'Requires the disposable configured Git receiver fixture.');
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function fixtureFacts(request: APIRequestContext, baseURL: string, name: string, phase: 'pre' | 'post' = 'post') {
  const source = JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as { barePath: string; audit: { name: string; base: string; target: string; refName: string }[] };
  const item = source.audit.find(item => item.name === name)!;
  const state = await api<AppState>(request, baseURL, '/state');
  const inspection = await inspectReceive(source.barePath, `${item.base} ${item.target} ${item.refName}\n`, phase, {});
  const facts: GitReceiveFacts = { repositoryId: 'R1', objectFormat: inspection.objectFormat, phase, requestId: randomUUID(), pusherId: state.currentPrincipalId, inspectionComplete: true, updates: inspection.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => { const { branches: _branches, ...commit } = inspection.commits.find(item => item.commit.id === id)!; return commit; }) })) };
  return { facts, item, state };
}
async function register(request: APIRequestContext, baseURL: string, name: string) {
  const fixture = await fixtureFacts(request, baseURL, name);
  const { receive } = await api<{ receive: GitReceiveReceipt }>(request, baseURL, '/herald/receive', fixture.facts);
  expect(receive.allowed).toBe(true); expect(receive.commitIds).toHaveLength(1);
  return { ...fixture, id: receive.commitIds[0]! };
}
async function command(page: Page, name: string, comment = '') {
  await page.getByRole('button', { name, exact: true }).click();
  const editor = page.getByRole('form', { name: 'Audit editor' });
  if (comment) await editor.getByLabel('Audit comment', { exact: true }).fill(comment);
  await editor.getByRole('button', { name, exact: true }).click();
  await expect(editor).toHaveCount(0);
}
async function visual(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.automation-panel .panel-heading h2').evaluateAll(items => items.every(item => item.scrollWidth <= item.clientWidth + 1))).toBe(true);
  await mkdir('.data/audit-visual-qa', { recursive: true });
  await page.screenshot({ path: `.data/audit-visual-qa/${name}.png`, fullPage: true });
}

test('Audit reviews exact recorded patches and preserves requests, concerns, acceptance and resignation history', async ({ page, request, baseURL }, info) => {
  const { id, item, state } = await register(request, baseURL!, 'workflow');
  await page.goto(`./#audit/${id}`);
  await expect(page.getByRole('heading', { name: `${item.target.slice(0, 12)} Commit Audit`, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorded commit patch', exact: true })).toContainText('+Exact committed change.');
  await expect(page.getByText(item.target, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Request Auditors', exact: true }).click();
  let editor = page.getByRole('form', { name: 'Audit editor' });
  await editor.getByLabel('Auditor to request', { exact: true }).selectOption(state.currentPrincipalId);
  await editor.getByLabel('Audit comment', { exact: true }).fill('Please inspect the committed source.');
  await editor.getByRole('button', { name: 'Request Auditors', exact: true }).click(); await expect(editor).toHaveCount(0);
  await expect(page.locator('.audit-auditors')).toContainText('Audit requested');
  await command(page, 'Raise Concern', 'This committed wording needs another look.\nThe exact source remains visible.');
  await expect(page.locator('.audit-auditors')).toContainText('Concern raised');
  await command(page, 'Accept Commit', 'Concern resolved after reviewing this commit.');
  await expect(page.locator('.audit-auditors')).toContainText('Accepted');
  await command(page, 'Comment', 'Additional immutable review history.');
  await command(page, 'Resign Audit', 'Another auditor will continue.');
  await expect(page.locator('.audit-auditors')).toContainText('Resigned');
  await expect(page.getByRole('button', { name: 'Resign Audit', exact: true })).toBeDisabled();
  const detail = await api<AuditDetail>(request, baseURL!, `/audit/commits/${id}`);
  expect(detail.audit.source.commit.id).toBe(item.target);
  expect(detail.history.events.map(event => event.action)).toEqual(['resign', 'comment', 'accept', 'concern', 'request', 'observed']);
  expect(detail.history.events.find(event => event.action === 'concern')?.comment).toContain('\nThe exact source remains visible.');
  await page.getByLabel('Audit status', { exact: true }).selectOption('concern-raised');
  await expect(page.locator('.automation-list button').filter({ hasText: 'Audit workflow fixture' })).toHaveCount(0);
  await page.getByLabel('Audit status', { exact: true }).selectOption('none');
  await expect(page.locator('.automation-list button').filter({ hasText: 'Audit workflow fixture' })).toBeVisible();
  await visual(page, `workflow-${info.project.name}`);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Accept Commit', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (info.project.name === 'desktop') { await page.setViewportSize({ width: 768, height: 1024 }); await visual(page, 'workflow-tablet'); }
});

test('Audit drafts survive offline navigation and an uncertain result retries exactly once', async ({ page, context, request, baseURL }) => {
  const { id } = await register(request, baseURL!, 'recovery');
  await page.goto(`./#audit/${id}`); await page.getByRole('button', { name: 'Comment', exact: true }).click();
  let editor = page.getByRole('form', { name: 'Audit editor' }); await editor.getByLabel('Audit comment', { exact: true }).fill('Retained audit comment.');
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().includes(`/api/audit/commits/${id}/command`)) writes++; });
  await context.setOffline(true); await editor.getByLabel('Audit comment', { exact: true }).fill('Retained audit comment edited offline.');
  await expect(editor.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = 'home'; }); await expect(page.getByRole('heading', { name: 'Your workspace', exact: true })).toBeVisible();
  await page.evaluate(id => { location.hash = `audit/${id}`; }, id);
  editor = page.getByRole('form', { name: 'Audit editor' }); await expect(editor.getByLabel('Audit comment', { exact: true })).toHaveValue('Retained audit comment edited offline.');
  const original = await api<AuditDetail>(request, baseURL!, `/audit/commits/${id}`);
  await api(request, baseURL!, `/audit/commits/${id}/command`, { expectedVersion: original.audit.version, command: 'comment', comment: 'A concurrent audit comment.' });
  await context.setOffline(false); await expect(editor.getByText('This audit changed after the editor opened.', { exact: false })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Use Latest Audit Version', exact: true }).click(); await expect(editor.getByRole('button', { name: 'Comment', exact: true })).toBeEnabled(); expect(writes).toBe(0);
  let dropped = false;
  await page.route(`**/api/audit/commits/${id}/command`, async route => { if (!dropped && route.request().method() === 'POST') { dropped = true; const result = await route.fetch(); expect(result.ok(), await result.text()).toBe(true); await route.abort('failed'); } else await route.continue(); });
  await editor.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('outcome is unknown');
  const after = await api<AuditDetail>(request, baseURL!, `/audit/commits/${id}`); expect(after.history.events.filter(event => event.action === 'comment' && event.comment === 'Retained audit comment edited offline.')).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry Exact Request', exact: true }).click(); await expect(editor).toHaveCount(0);
  const recovered = await api<AuditDetail>(request, baseURL!, `/audit/commits/${id}`); expect(recovered.history.events.filter(event => event.action === 'comment' && event.comment === 'Retained audit comment edited offline.')).toHaveLength(1); expect(recovered.audit.version).toBe(after.audit.version);
  expect(writes).toBe(2);
});

test('Herald requests post-commit auditors and links the recorded audit', async ({ page, request, baseURL }, info) => {
  const { facts, item, state } = await fixtureFacts(request, baseURL!, 'herald');
  await page.goto('./#herald'); await page.getByRole('button', { name: 'Create Rule', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill(`Audit committed source ${info.project.name}`);
  await page.getByLabel('Applies to', { exact: true }).selectOption('commit'); await page.getByLabel('Rule type', { exact: true }).selectOption('object'); await page.getByLabel('Trigger repository', { exact: true }).selectOption('R1');
  await page.getByLabel('Condition 1 field', { exact: true }).selectOption('commitId'); await page.getByLabel('Condition 1 comparison', { exact: true }).selectOption('is'); await page.getByLabel('Condition 1 value', { exact: true }).fill(item.target);
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('add-auditors'); await page.getByLabel('Action 1 selections', { exact: true }).selectOption(state.currentPrincipalId);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/herald/rules'));
  await page.getByRole('button', { name: 'Save Rule', exact: true }).click(); const response = await saved; expect(response.ok(), await response.text()).toBe(true); const { rule } = await response.json() as { rule: HeraldRule };
  const { receive } = await api<{ receive: GitReceiveReceipt }>(request, baseURL!, '/herald/receive', facts); const id = receive.commitIds[0]!;
  const detail = await api<AuditDetail>(request, baseURL!, `/audit/commits/${id}`); expect(detail.audit.auditors.some(auditor => auditor.principalId === state.currentPrincipalId && auditor.status === 'requested')).toBe(true); expect(detail.history.events.some(event => event.action === 'request' && event.origin === 'herald')).toBe(true);
  const { transcripts } = await api<{ transcripts: HeraldTranscript[] }>(request, baseURL!, '/herald/transcripts'); const transcript = transcripts.find(item => receive.transcriptIds.includes(item.id) && item.rules.some(result => result.ruleId === rule.id))!;
  await page.getByRole('button', { name: 'Transcripts', exact: true }).click(); await page.getByRole('button').filter({ hasText: `${transcript.id} · ${id}` }).click();
  await page.getByRole('link', { name: id, exact: true }).click(); await expect(page.getByRole('heading', { name: `${item.target.slice(0, 12)} Commit Audit`, exact: true })).toBeVisible(); await expect(page.locator('.audit-history')).toContainText('Herald rule');
});

test('Herald records accepted source and exact required build evidence for blocked and allowed pushes', async ({ page, request, baseURL }, info) => {
  const { facts, item } = await fixtureFacts(request, baseURL!, 'gates', 'pre');
  const revision = await api<RevisionDetail>(request, baseURL!, '/repositories/R1/import-revision', { commitId: item.target, kind: 'code', title: `Gate evidence ${info.project.name}`, testPlan: 'Verify the exact incoming tree and recorded build outcome.' });
  const version = revision.versions[0]!;
  await api(request, baseURL!, `/revisions/${revision.revision.id}/reviews`, { provider: 'local', expectedVersion: revision.revision.currentVersion });
  await lifecycleRequest(request, baseURL!, revision.revision.id, 'accept_reviewed');
  const { plan } = await api<{ plan: BuildPlan }>(request, baseURL!, '/harbormaster/plans', { name: `Required audit fixture checks ${info.project.name}`, description: 'Verify the exact reviewed source.', enabled: true, steps: [{ key: 'checks', name: 'Local checks', kind: 'local-checks', dependsOn: [], worker: null }] });
  await page.goto('./#herald'); await page.getByRole('button', { name: 'Create Rule', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill(`Enforce reviewed source ${info.project.name}`);
  await page.getByLabel('Applies to', { exact: true }).selectOption('push-content'); await page.getByLabel('Rule type', { exact: true }).selectOption('object'); await page.getByLabel('Trigger repository', { exact: true }).selectOption('R1');
  const field = page.getByLabel('Condition 1 field', { exact: true }); for (const value of ['acceptedRevision', 'revisionBuildWarning', 'passingBuildPlans']) await expect(field.locator(`option[value="${value}"]`)).toHaveCount(1);
  await field.selectOption('commitId'); await page.getByLabel('Condition 1 comparison', { exact: true }).selectOption('is'); await page.getByLabel('Condition 1 value', { exact: true }).fill(item.target);
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('require-build-plans'); await page.getByLabel('Action 1 selections', { exact: true }).selectOption(plan.id);
  await page.getByRole('button', { name: 'Save Rule', exact: true }).click(); await expect(page.getByRole('form', { name: 'Herald rule editor' })).toHaveCount(0);
  const blocked = (await api<{ receive: GitReceiveReceipt }>(request, baseURL!, '/herald/receive', facts)).receive;
  expect(blocked.allowed).toBe(false); expect(blocked.reasons.join(' ')).toContain('missing');
  const firstTranscripts = await api<{ transcripts: HeraldTranscript[] }>(request, baseURL!, '/herald/transcripts');
  const missing = firstTranscripts.transcripts.find(transcript => blocked.transcriptIds.includes(transcript.id) && transcript.contentType === 'push-content')!;
  expect(missing.snapshot.git?.review?.revision?.revisionId).toBe(revision.revision.id); expect(missing.snapshot.git?.review?.revision?.accepted).toBe(true);
  const build = await api<BuildDetail>(request, baseURL!, '/harbormaster/builds', { revisionId: revision.revision.id, versionId: version.id, contentHash: version.contentHash, planId: plan.id, planVersion: plan.version });
  await expect.poll(async () => (await api<BuildDetail>(request, baseURL!, `/harbormaster/builds/${build.build.id}`)).build.status).toBe('passed');
  const allowed = (await api<{ receive: GitReceiveReceipt }>(request, baseURL!, '/herald/receive', { ...facts, requestId: randomUUID() })).receive;
  expect(allowed.allowed).toBe(true);
  const finalTranscripts = await api<{ transcripts: HeraldTranscript[] }>(request, baseURL!, '/herald/transcripts');
  const passed = finalTranscripts.transcripts.find(transcript => allowed.transcriptIds.includes(transcript.id) && transcript.contentType === 'push-content')!;
  await page.getByRole('button', { name: 'Transcripts', exact: true }).click(); await page.getByRole('button').filter({ hasText: `${passed.id} · ${passed.objectId}` }).click();
  const evidence = page.getByRole('region', { name: 'Reviewed source and build evidence', exact: true });
  await expect(evidence).toContainText('Exact reviewed source verified'); await expect(evidence.getByRole('link', { name: revision.revision.id, exact: true })).toBeVisible(); await expect(evidence.getByRole('link', { name: build.build.id, exact: true })).toBeVisible(); await expect(evidence).toContainText('passed'); await expect(evidence).toContainText(version.contentHash);
  await visual(page, `gates-${info.project.name}`);
  await page.getByRole('button').filter({ hasText: `${missing.id} · ${missing.objectId}` }).click(); await expect(evidence).toContainText('missing'); await expect(evidence.getByRole('link', { name: build.build.id, exact: true })).toHaveCount(0);
});
