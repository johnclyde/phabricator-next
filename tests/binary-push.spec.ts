import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { inspectReceive } from '../server/git-receive-inspection';
import type { GitReceiveFacts, GitReceiveReceipt } from '../shared/git-automation';
import type { HeraldRule, HeraldTranscript } from '../shared/herald';
import type { AppState } from '../shared/types';

test.skip(process.env.E2E_AUTOMATION_FIXTURE !== '1', 'Requires the disposable configured Git receiver fixture.');
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function visual(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.herald-file-evidence > summary').evaluateAll(items => items.every(item => item.getBoundingClientRect().height >= 44 && item.scrollWidth <= item.clientWidth + 1))).toBe(true);
  await mkdir('.data/binary-push-visual-qa', { recursive: true });
  await page.getByRole('region', { name: 'Changed file inspection', exact: true }).screenshot({ path: `.data/binary-push-visual-qa/${name}.png` });
}

test('Herald records binary and large push metadata, pages exact file evidence, and replays it', async ({ page, request, baseURL }, info) => {
  const source = JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as { barePath: string; binaryPush: { base: string; target: string; refName: string } };
  const state = await api<AppState>(request, baseURL!, '/state');
  // Read only the disposable receiving repository; the browser never invents source facts.
  const inspection = await inspectReceive(source.barePath, `${source.binaryPush.base} ${source.binaryPush.target} ${source.binaryPush.refName}\n`, 'pre', {});
  expect(inspection.commits).toHaveLength(1);
  const changed = inspection.commits[0]!.files;
  expect(new Set(changed.map(file => file.inspection?.kind))).toEqual(new Set(['text', 'binary', 'non-utf8', 'too-large', 'gitlink']));
  expect(changed.length).toBeGreaterThan(25);
  const facts: GitReceiveFacts = { repositoryId: 'R1', objectFormat: inspection.objectFormat, phase: 'pre', requestId: randomUUID(), pusherId: state.currentPrincipalId, inspectionComplete: true, updates: inspection.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => { const { branches: _branches, ...commit } = inspection.commits.find(item => item.commit.id === id)!; return commit; }) })) };

  await page.goto('./#herald'); await page.getByRole('button', { name: 'Create Rule', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill(`Inspect binary content ${info.project.name}`);
  await page.getByLabel('Applies to', { exact: true }).selectOption('push-content');
  await page.getByLabel('Rule type', { exact: true }).selectOption('object'); await page.getByLabel('Trigger repository', { exact: true }).selectOption('R1');
  const fields = page.getByLabel('Condition 1 field', { exact: true });
  for (const field of ['binaryFiles', 'uninspectableFiles', 'diffEnormous', 'textInspectionComplete']) await expect(fields.locator(`option[value="${field}"]`)).toHaveCount(1);
  await fields.selectOption('fileContent'); await expect(page.getByText('Unavailable text is not an empty diff.', { exact: false })).toBeVisible();
  await fields.selectOption('binaryFiles'); await page.getByLabel('Condition 1 comparison', { exact: true }).selectOption('contains'); await page.getByLabel('Condition 1 value', { exact: true }).fill('image.png');
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('block-push'); await page.getByLabel('Action 1 rejection message', { exact: true }).fill('Binary artwork needs an explicit review.');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/herald/rules'));
  await page.getByRole('button', { name: 'Save Rule', exact: true }).click(); const save = await saved; expect(save.ok(), await save.text()).toBe(true); const { rule } = await save.json() as { rule: HeraldRule };
  const { receive } = await api<{ receive: GitReceiveReceipt }>(request, baseURL!, '/herald/receive', facts); expect(receive.allowed).toBe(false);
  const { transcripts } = await api<{ transcripts: HeraldTranscript[] }>(request, baseURL!, '/herald/transcripts');
  const transcript = transcripts.find(item => receive.transcriptIds.includes(item.id) && item.contentType === 'push-content' && item.rules.some(result => result.ruleId === rule.id))!;
  expect(transcript.snapshot.git?.fileInspection).toEqual(changed.map(file => ({ path: file.path, ...file.inspection! })));
  await page.getByRole('button', { name: 'Push Receipts', exact: true }).click(); await page.getByRole('button').filter({ hasText: `${receive.id} · R1` }).click(); await page.getByRole('button', { name: transcript.id, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${transcript.id} Transcript`, exact: true })).toBeVisible();
  const files = page.getByRole('region', { name: 'Changed file inspection', exact: true }), rows = files.locator('details');
  await expect(files).toContainText(`${changed.length} changed paths`); await expect(files).toContainText('5 with unavailable text');
  await expect(rows).toHaveCount(25); await expect(files.getByRole('button', { name: 'Previous Files', exact: true })).toBeDisabled();
  await expect(rows.filter({ hasText: 'mode.sh' }).locator('summary')).toContainText('Mode changed · Text inspected');
  await files.getByRole('button', { name: 'Next Files', exact: true }).click(); await expect(rows).toHaveCount(changed.length - 25);
  await expect(files.getByRole('button', { name: 'Next Files', exact: true })).toBeDisabled();
  await expect(rows.filter({ hasText: '研究-paper-with-a-long-filename' })).toBeVisible(); await visual(page, `page-two-${info.project.name}`);
  await files.getByLabel('Show changed files', { exact: true }).selectOption('unavailable'); await expect(rows).toHaveCount(5);
  await expect(files.getByRole('button', { name: 'Next Files', exact: true })).toHaveCount(0);
  for (const label of ['Binary', 'Non-UTF-8', 'Text inspection limit', 'Submodule']) await expect(rows.locator('summary').filter({ hasText: label }).first()).toBeVisible();
  const image = rows.filter({ has: page.locator('summary code', { hasText: /^image\.png$/ }) }); await image.locator('summary').click();
  await expect(image).toContainText('Metadata captured; text unavailable.');
  const metadata = changed.find(file => file.path === 'image.png')!.inspection!;
  await expect(image.getByRole('region', { name: 'Before file evidence', exact: true })).toContainText(metadata.old!.id);
  await expect(image.getByRole('region', { name: 'After file evidence', exact: true })).toContainText(metadata.new!.id);
  await expect(image).toContainText('100644'); await expect(image).toContainText('3 bytes'); await expect(image).toContainText('4 bytes');
  const module = rows.filter({ has: page.locator('summary code', { hasText: /^module$/ }) }); await module.locator('summary').click(); await expect(module).toContainText('Not a blob (submodule commit)'); await expect(module).toContainText('160000');
  const deleted = rows.filter({ hasText: 'deleted.png' }); await deleted.locator('summary').click(); await expect(deleted).toContainText('Removed · Binary'); await expect(deleted.getByRole('region', { name: 'After file evidence', exact: true })).toContainText('Not present');
  const oversized = rows.filter({ hasText: 'oversized.txt' }); await oversized.locator('summary').click(); await expect(oversized).toContainText('8,388,609 bytes'); await expect(oversized).toContainText('text exceeded an inspection size, diff complexity or time limit');
  for (const row of [image, module, deleted, oversized]) await row.locator('summary').click();
  await visual(page, `unavailable-${info.project.name}`);
  if (info.project.name === 'desktop') { await page.setViewportSize({ width: 768, height: 1024 }); await visual(page, 'unavailable-tablet'); }

  const original = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Original event snapshot$/ }) }); await original.locator('summary').click();
  expect(JSON.parse(await original.locator('pre').innerText())).toEqual(transcript.snapshot); await original.locator('summary').click();
  await page.getByRole('button', { name: 'Replay Recorded Event', exact: true }).click(); await page.getByRole('button', { name: 'Run Dry Test', exact: true }).click();
  await expect(page.getByText('Dry run: no rule actions were applied.', { exact: true })).toBeVisible(); await expect(files).toContainText('5 with unavailable text'); await expect(rows).toHaveCount(25);
  expect((await api<{ receives: GitReceiveReceipt[] }>(request, baseURL!, '/herald/receives')).receives.filter(item => item.requestId === facts.requestId)).toHaveLength(1);
});
