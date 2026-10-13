import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RevisionDetail } from '../shared/types';
import type { Build, BuildClaim, BuildDetail, BuildPlan } from '../shared/harbormaster';
import type { HeraldRule, HeraldTranscript } from '../shared/herald';

async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function createRevision(request: APIRequestContext, baseURL: string, title: string): Promise<RevisionDetail> {
  return api(request, baseURL, '/revisions', { title, kind: 'code', summary: 'Automation integration source.', testPlan: 'Run deterministic checks and inspect their immutable build.', files: [{ path: 'example.ts', content: 'export const reviewed = true;\n' }] });
}
async function open(page: Page, name: 'herald' | 'harbormaster') { await page.goto(`./#${name}`); await expect(page.getByRole('heading', { name: name === 'herald' ? 'Herald' : 'Harbormaster', exact: true })).toBeVisible(); }
async function createPlan(page: Page, name: string): Promise<BuildPlan> {
  await open(page, 'harbormaster'); await page.getByRole('button', { name: 'Create Build Plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill(name);
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/harbormaster/plans'));
  await page.getByRole('button', { name: 'Save Build Plan', exact: true }).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true); const { plan } = await result.json() as { plan: BuildPlan };
  await expect(page.getByRole('form', { name: 'Build plan editor' })).toHaveCount(0); return plan;
}

test('Herald authoring and dry runs lead to one automatic immutable Harbormaster build', async ({ page, request, baseURL }, info) => {
  const marker = `Automation ${info.project.name} ${Date.now()}`, revision = await createRevision(request, baseURL!, marker);
  const plan = await createPlan(page, `${marker} checks`);
  await open(page, 'herald'); await page.getByRole('button', { name: 'Create Rule', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill(`${marker} rule`); await page.getByLabel('Rule type', { exact: true }).selectOption('global');
  await page.getByLabel('Condition 1 field', { exact: true }).selectOption('title'); await page.getByLabel('Condition 1 value', { exact: true }).fill(marker);
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('run-build-plans'); await page.getByLabel('Action 1 selections', { exact: true }).selectOption(plan.id);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/herald/rules'));
  await page.getByRole('button', { name: 'Save Rule', exact: true }).click(); const ruleResponse = await saved; expect(ruleResponse.ok(), await ruleResponse.text()).toBe(true); const { rule } = await ruleResponse.json() as { rule: HeraldRule };
  await expect(page.getByRole('form', { name: 'Herald rule editor' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Test Rule', exact: true }).click(); await page.getByLabel('Object to test', { exact: true }).fill(revision.revision.id);
  await page.getByRole('button', { name: 'Run Dry Test', exact: true }).click(); await expect(page.getByText('Dry run: no rule actions were applied.', { exact: true })).toBeVisible();
  expect((await api<{ builds: Build[] }>(request, baseURL!, '/harbormaster/builds')).builds.filter(build => build.planId === plan.id)).toHaveLength(0);
  await api(request, baseURL!, `/revisions/${revision.revision.id}/versions`, { expectedVersion: 1, message: 'Trigger the saved rule on new immutable source.', files: [{ path: 'example.ts', content: 'export const reviewed = true;\nexport const next = 2;\n' }] });
  let build: Build | undefined;
  await expect.poll(async () => { build = (await api<{ builds: Build[] }>(request, baseURL!, '/harbormaster/builds')).builds.find(item => item.planId === plan.id); return build?.status; }).toBe('passed');
  const detail = await api<BuildDetail>(request, baseURL!, `/harbormaster/builds/${build!.id}`);
  expect(detail.buildable.versionNumber).toBe(2); expect(detail.build.planVersion).toBe(plan.version); expect(detail.targets.every(target => target.status === 'passed')).toBe(true);
  const history = await api<{ transcripts: HeraldTranscript[] }>(request, baseURL!, '/herald/transcripts');
  const automatic = history.transcripts.find(item => item.objectId === revision.revision.id && !item.dryRun && item.rules.some(result => result.ruleId === rule.id)); expect(automatic).toBeTruthy();
  await open(page, 'herald'); await page.getByRole('button', { name: 'Transcripts', exact: true }).click(); await page.getByRole('button').filter({ hasText: `${automatic!.id} · ${revision.revision.id}` }).click();
  await expect(page.getByRole('heading', { name: `${automatic!.id} Transcript`, exact: true })).toBeVisible(); await expect(page.getByText('Recorded objects:', { exact: false })).toContainText(build!.id);
  await page.goto(`./#${revision.revision.id}`); const widget = page.getByRole('region', { name: 'Harbormaster builds for selected version', exact: true });
  await expect(widget.getByRole('link').filter({ hasText: plan.name })).toBeVisible(); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(widget.getByText('No builds recorded for this exact source version.', { exact: true })).toBeVisible(); await page.getByLabel('Version to inspect', { exact: true }).selectOption('2'); await widget.getByRole('link').filter({ hasText: plan.name }).click();
  await expect(page.getByRole('heading', { name: `${build!.id} ${plan.name}`, exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Logs and Test Results', exact: true })).toBeVisible(); await expect(page.getByText(detail.buildable.contentHash, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.automation-panel .panel-heading h2').evaluateAll(headings => headings.every(heading => heading.scrollWidth <= heading.clientWidth + 1))).toBe(true);
  const restart = page.getByRole('button', { name: 'Restart Same Build', exact: true }); if (info.project.name === 'mobile') expect((await restart.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await mkdir('.data/automation-visual-qa', { recursive: true }); await page.screenshot({ path: `.data/automation-visual-qa/build-${info.project.name}.png`, fullPage: true });
});

test('plan dependency validation and retained offline drafts never start work on reconnect', async ({ page, context }, info) => {
  await open(page, 'harbormaster'); await page.getByRole('button', { name: 'Create Build Plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill(`Dependency draft ${info.project.name}`); await page.getByRole('button', { name: 'Add Build Step', exact: true }).click();
  await page.getByLabel('Step 2 name', { exact: true }).fill('Dependent external tests'); await page.getByLabel('Step 2 type', { exact: true }).selectOption('external'); await page.getByLabel('Step 2 worker label', { exact: true }).fill('test-worker');
  await page.getByLabel('Step 1 dependencies', { exact: true }).fill('step-2'); await page.getByLabel('Step 2 dependencies', { exact: true }).fill('checks');
  await expect(page.getByText('Build dependencies cannot contain a cycle.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Save Build Plan', exact: true })).toBeDisabled();
  await page.getByLabel('Step 1 dependencies', { exact: true }).fill(''); await expect(page.getByRole('button', { name: 'Save Build Plan', exact: true })).toBeEnabled();
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/harbormaster/')) writes++; });
  await context.setOffline(true); await page.getByLabel('Plan name', { exact: true }).fill(`Retained offline ${info.project.name}`); await expect(page.getByRole('button', { name: 'Save Build Plan', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = 'home'; }); await expect(page.getByRole('heading', { name: 'Your workspace', exact: true })).toBeVisible(); await page.evaluate(() => { location.hash = 'harbormaster'; });
  await expect(page.getByLabel('Plan name', { exact: true })).toHaveValue(`Retained offline ${info.project.name}`); await expect(page.getByLabel('Step 2 worker label', { exact: true })).toHaveValue('test-worker');
  await context.setOffline(false); await expect(page.getByRole('button', { name: 'Save Build Plan', exact: true })).toBeEnabled(); expect(writes).toBe(0);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Plan Draft', exact: true }).click(); const file = await download; expect(file.suggestedFilename()).toBe('build-plan-draft.json');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0)); await mkdir('.data/automation-visual-qa', { recursive: true }); await page.screenshot({ path: `.data/automation-visual-qa/plan-${info.project.name}.png`, fullPage: true });
});

test('an unknown plan creation outcome retries the same request after reload without duplicating a plan', async ({ page, request, baseURL, context }, info) => {
  const name = `Recovered plan ${info.project.name} ${Date.now()}`, requests: { id: string | undefined; body: unknown }[] = []; let drop = true;
  await page.route('**/api/harbormaster/plans', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    requests.push({ id: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    const response = await route.fetch();
    if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response });
  });
  await open(page, 'harbormaster'); await page.getByRole('button', { name: 'Create Build Plan', exact: true }).click(); await page.getByLabel('Plan name', { exact: true }).fill(name); await page.getByRole('button', { name: 'Save Build Plan', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('outcome is unknown'); await page.reload(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toBeVisible();
  await context.setOffline(true); await expect(page.getByRole('button', { name: 'Retry Exact Request', exact: true })).toBeDisabled(); await context.setOffline(false); await expect(page.getByRole('button', { name: 'Retry Exact Request', exact: true })).toBeEnabled(); expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry Exact Request', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[0]!.id).toBeTruthy(); expect(requests[1]).toEqual(requests[0]);
  const plans = await api<{ plans: BuildPlan[] }>(request, baseURL!, '/harbormaster/plans'); expect(plans.plans.filter(plan => plan.name === name)).toHaveLength(1);
});

test('a stale Herald editor preserves its original version while rule history records later edits', async ({ page, request, baseURL }, info) => {
  const name = `Rule history ${info.project.name} ${Date.now()}`;
  const input = { name, contentType: 'revision', ruleType: 'personal', objectId: null, enabled: true, match: 'all', repetition: 'first', conditions: [{ field: 'title', operator: 'contains', value: name }], actions: [{ type: 'nothing' }] };
  const { rule } = await api<{ rule: HeraldRule }>(request, baseURL!, '/herald/rules', input);
  await open(page, 'herald'); await page.getByRole('button').filter({ hasText: `${rule.id} ${name}` }).click(); await page.getByRole('button', { name: 'Edit Rule', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill(`${name} retained draft`);
  const changed = await request.put(new URL(`api/herald/rules/${rule.id}`, baseURL).href, { data: { ...input, name: `${name} changed elsewhere`, expectedVersion: 1 }, headers: { 'Idempotency-Key': randomUUID() } }); expect(changed.ok(), await changed.text()).toBe(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByText('This rule changed after the editor opened.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Save Rule', exact: true })).toBeDisabled(); await expect(page.getByLabel('Rule name', { exact: true })).toHaveValue(`${name} retained draft`);
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Rule Draft', exact: true }).click(); const stream = await (await downloaded).createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); const exported = JSON.parse(Buffer.concat(chunks).toString()) as { expectedVersion: number; input: { name: string } }; expect(exported.expectedVersion).toBe(1); expect(exported.input.name).toBe(`${name} retained draft`);
  page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Discard Rule Draft', exact: true }).click(); await expect(page.getByRole('form', { name: 'Herald rule editor' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disable Rule', exact: true }).click(); await expect(page.getByRole('button', { name: 'Enable Rule', exact: true })).toBeVisible();
  await page.getByText('Rule History', { exact: true }).click(); await expect(page.getByRole('heading', { name: /^Version 3 ·/ })).toBeVisible(); await expect(page.getByRole('heading', { name: /^Version 2 ·/ })).toBeVisible(); await expect(page.getByRole('heading', { name: /^Version 1 ·/ })).toBeVisible();
});

test('manual external builds pause, resume, abort, restart the original plan, and display reported evidence', async ({ page, request, baseURL }, info) => {
  const name = `External lifecycle ${info.project.name} ${Date.now()}`, revision = await createRevision(request, baseURL!, name);
  const input = { name, description: 'External worker protocol fixture.', enabled: true, steps: [{ key: 'external', name: 'Reported test suite', kind: 'external', dependsOn: [], worker: 'fixture' }] };
  const { plan } = await api<{ plan: BuildPlan }>(request, baseURL!, '/harbormaster/plans', input);
  await open(page, 'harbormaster'); await page.getByRole('button').filter({ hasText: `${plan.id} ${plan.name}` }).click(); await page.getByLabel('Revision to build', { exact: true }).selectOption(revision.revision.id);
  const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/harbormaster/builds'));
  await page.getByRole('button', { name: 'Run Build Plan', exact: true }).click(); const startResponse = await started; expect(startResponse.ok(), await startResponse.text()).toBe(true); const first = await startResponse.json() as BuildDetail;
  await page.getByRole('button', { name: 'Pause Build', exact: true }).click(); await page.getByRole('button', { name: 'Resume Build', exact: true }).click(); await page.getByRole('button', { name: 'Abort Build', exact: true }).click(); await expect(page.getByRole('button', { name: 'Restart Same Build', exact: true })).toBeVisible();
  const update = await request.put(new URL(`api/harbormaster/plans/${plan.id}`, baseURL).href, { data: { ...input, name: `${name} newer plan`, expectedVersion: 1 }, headers: { 'Idempotency-Key': randomUUID() } }); expect(update.ok(), await update.text()).toBe(true);
  const restarted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/api/harbormaster/builds/${first.build.id}/commands`));
  await page.getByRole('button', { name: 'Restart Same Build', exact: true }).click(); const restartResponse = await restarted; expect(restartResponse.ok(), await restartResponse.text()).toBe(true); const second = await restartResponse.json() as BuildDetail;
  expect(second.build.restartOf).toBe(first.build.id); expect(second.build.planVersion).toBe(1); expect(second.build.plan.name).toBe(name); expect(second.buildable.contentHash).toBe(revision.versions[0]!.contentHash);
  const target = second.targets[0]!, claim = await api<BuildClaim>(request, baseURL!, `/harbormaster/targets/${target.id}/claim`, { expectedVersion: target.version, worker: 'fixture' });
  await api(request, baseURL!, `/harbormaster/targets/${target.id}/report`, { leaseToken: claim.leaseToken, reportId: randomUUID(), type: 'pass', log: 'External fixture completed its checks.', unit: [{ name: 'Exact source checked', result: 'pass', duration: 0.25, details: 'Reported against the leased source.' }], lint: [{ name: 'Style note', code: 'STYLE-1', severity: 'advice', path: 'example.ts', line: 1, description: 'Fixture advisory.' }], artifacts: [{ key: 'report', name: 'External test report', uri: 'https://example.invalid/artifacts/report.html' }] });
  await expect(page.getByRole('heading', { name: `${second.build.id} ${name}`, exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByText('External fixture completed its checks.', { exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Exact source checked', exact: true })).toBeVisible(); await expect(page.getByText('Fixture advisory.', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'External test report', exact: true })).toHaveAttribute('href', 'https://example.invalid/artifacts/report.html');
  await expect(page.getByRole('button', { name: 'Restart Same Build', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
