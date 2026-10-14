import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { SuiteDetail } from '../shared/suite';
import type { AppState } from '../shared/types';
import type { LegalpadData } from '../shared/legalpad';

async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function begin(page: Page, app: 'Almanac' | 'Legalpad', label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const editor = page.getByRole('form', { name: `${app} editor`, exact: true }); await expect(editor).toBeVisible(); return editor;
}
async function save(page: Page, app: 'Almanac' | 'Legalpad', label: string): Promise<SuiteDetail> {
  const result = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.includes(`/api/suite/${app.toLowerCase()}`));
  await page.getByRole('form', { name: `${app} editor`, exact: true }).getByRole('button', { name: label, exact: true }).click();
  const response = await result; expect(response.ok(), await response.text()).toBe(true);
  await expect(page.getByRole('form', { name: `${app} editor`, exact: true })).toHaveCount(0); return response.json() as Promise<SuiteDetail>;
}
async function visual(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })); await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0); await mkdir('.data/suite-visual-qa', { recursive: true }); await page.screenshot({ path: `.data/suite-visual-qa/${name}.png`, fullPage: true });
}

test('Almanac registers devices, networks, interfaces, services, bindings and dependency-safe lifecycle through the UI', async ({ page, request, baseURL }, info) => {
  page.on('dialog', dialog => dialog.accept()); const suffix = randomUUID().slice(0, 8);
  await page.goto('./#almanac');
  let editor = await begin(page, 'Almanac', 'Register Network'); await editor.getByLabel('Name', { exact: true }).fill(`network-${suffix}`); const network = (await save(page, 'Almanac', 'Register Network')).record;
  editor = await begin(page, 'Almanac', 'Register Device'); await editor.getByLabel('Name', { exact: true }).fill(`worker-${suffix}.test`); await editor.getByLabel('Description', { exact: true }).fill('Worker in the service directory.'); const device = (await save(page, 'Almanac', 'Register Device')).record;
  editor = await begin(page, 'Almanac', 'Register Service'); await editor.getByLabel('Name', { exact: true }).fill(`review-${suffix}`); const service = (await save(page, 'Almanac', 'Register Service')).record;
  editor = await begin(page, 'Almanac', 'Add Interface'); await editor.getByLabel('Device', { exact: true }).fill(device.id); await editor.getByLabel('Network', { exact: true }).fill(network.id); await editor.getByLabel('IP address or hostname', { exact: true }).fill('2001:db8::1'); await editor.getByLabel('Port', { exact: true }).fill('443'); const iface = (await save(page, 'Almanac', 'Add Interface')).record;
  editor = await begin(page, 'Almanac', 'Bind Service'); await editor.getByLabel('Service', { exact: true }).fill(service.id); await editor.getByLabel('Interface', { exact: true }).fill(iface.id); const binding = (await save(page, 'Almanac', 'Bind Service')).record;
  await expect(page.locator('.automation-detail')).toContainText('Binding');
  editor = await begin(page, 'Almanac', 'Edit Properties'); await editor.getByLabel('Custom properties (JSON object)', { exact: true }).fill('{"weight":2,"operating_system":"linux"}'); await save(page, 'Almanac', 'Edit Properties'); await expect(page.locator('.automation-detail')).toContainText('"weight": 2');
  await visual(page, `almanac-${info.project.name}`);
  await page.goto(`./#almanac/${service.id}`); await begin(page, 'Almanac', 'Disable Record');
  const blocked = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/disable'));
  await page.getByRole('form', { name: 'Almanac editor' }).getByRole('button', { name: 'Disable Record', exact: true }).click(); expect((await blocked).status()).toBe(409); await expect(page.getByRole('alert')).toContainText('Disable dependent');
  await page.getByRole('button', { name: 'Forget Request', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard Draft', exact: true }).click();
  await page.goto(`./#almanac/${binding.id}`); await begin(page, 'Almanac', 'Disable Record'); await save(page, 'Almanac', 'Disable Record');
  await page.goto(`./#almanac/${service.id}`); await begin(page, 'Almanac', 'Disable Record'); await save(page, 'Almanac', 'Disable Record');
  const detail = await api<SuiteDetail>(request, baseURL!, `/suite/almanac/${service.id}`); expect(detail.record.data.status).toBe('disabled'); expect(detail.events.some(event => event.action === 'disable')).toBe(true);
});

test('Legalpad records exact-version signatures, receipts, revision invalidation, exemptions and discussion through the UI', async ({ page, request, baseURL }, info) => {
  page.on('dialog', dialog => dialog.accept()); const state = await api<AppState>(request, baseURL!, '/state'), me = state.principals.find(person => person.id === state.currentPrincipalId)!;
  await page.goto('./#legalpad');
  let editor = await begin(page, 'Legalpad', 'Create Agreement'); await editor.getByLabel('Agreement title', { exact: true }).fill(`Contributor terms ${randomUUID().slice(0, 8)}`); await editor.getByLabel('Preamble', { exact: true }).fill('Read these contribution terms.'); await editor.getByLabel('Agreement text', { exact: true }).fill('I agree to contribute the included work under Apache 2.0.'); await editor.getByRole('group', { name: 'Request signatures from', exact: true }).getByLabel(me.displayName, { exact: true }).check();
  const created = await save(page, 'Legalpad', 'Create Agreement'); await expect(page.locator('.automation-detail')).toContainText('Awaiting this version');
  editor = await begin(page, 'Legalpad', 'Sign Version 1'); await editor.getByLabel('Your full name', { exact: true }).fill('Test Contributor'); await editor.getByLabel('I have read and agree to version 1 of this agreement', { exact: true }).check(); await save(page, 'Legalpad', 'Sign Version 1'); await expect(page.getByText('You signed this exact version.', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Receipt', exact: true }).click(); expect((await download).suggestedFilename()).toContain('receipt');
  editor = await begin(page, 'Legalpad', 'Publish New Version'); await editor.getByLabel('Agreement text', { exact: true }).fill('I agree to the revised contribution and attribution terms.'); await save(page, 'Legalpad', 'Publish New Version'); await expect(page.getByText('You signed this exact version.', { exact: true })).toHaveCount(0); await expect(page.locator('.automation-detail')).toContainText('Awaiting this version'); await expect(page.getByRole('button', { name: 'Sign Version 2', exact: true })).toBeVisible();
  await page.getByText(/^Version 1 · Contributor terms/).click(); await expect(page.getByText('I agree to contribute the included work under Apache 2.0.', { exact: true })).toBeVisible();
  editor = await begin(page, 'Legalpad', 'Record Exemption'); await editor.getByLabel('Person to exempt', { exact: true }).selectOption(state.currentPrincipalId); await editor.getByLabel('Exemption reason', { exact: true }).fill('Equivalent agreement recorded separately.'); await save(page, 'Legalpad', 'Record Exemption'); await expect(page.getByText('You have a recorded exemption for this version.', { exact: true })).toBeVisible();
  editor = await begin(page, 'Legalpad', 'Comment'); await editor.getByLabel('Comment', { exact: true }).fill('The original signed text remains available.'); await save(page, 'Legalpad', 'Comment'); await expect(page.getByText('The original signed text remains available.', { exact: true })).toBeVisible();
  const detail = await api<SuiteDetail>(request, baseURL!, `/suite/legalpad/${created.record.id}`), data = detail.record.data as LegalpadData; expect(data.versions).toHaveLength(2); expect(data.signatures).toHaveLength(2); expect(data.signatures[0]!.documentVersion).toBe(1); expect(data.requirements![0]!.status).toBe('exempt'); expect(detail.events.map(event => event.action)).toContain('revise');
  await visual(page, `legalpad-${info.project.name}`);
});

test('Legalpad refuses a retained signature draft when the agreement text changes', async ({ page, request, baseURL }) => {
  page.on('dialog', dialog => dialog.accept());
  const original = await api<SuiteDetail>(request, baseURL!, '/suite/legalpad', { kind: 'document', title: `Version race ${randomUUID().slice(0, 8)}`, text: 'Original terms.', signatureType: 'individual' });
  await page.goto(`./#legalpad/${original.record.id}`); const editor = await begin(page, 'Legalpad', 'Sign Version 1'); await editor.getByLabel('Your full name', { exact: true }).fill('Test Contributor'); await editor.getByLabel('I have read and agree to version 1 of this agreement', { exact: true }).check();
  await api(request, baseURL!, `/suite/legalpad/${original.record.id}/revise`, { expectedVersion: original.record.version, title: original.record.title, text: 'Changed terms require renewed consent.', signatureType: 'individual' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(editor).toContainText('This object changed'); await editor.getByRole('button', { name: 'Use Current Version', exact: true }).click();
  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/sign')); await editor.getByRole('button', { name: 'Sign Version 1', exact: true }).click(); expect((await response).status()).toBe(409); await expect(page.getByRole('alert')).toContainText('agreement changed');
  const after = await api<SuiteDetail>(request, baseURL!, `/suite/legalpad/${original.record.id}`); expect((after.record.data as LegalpadData).signatures).toHaveLength(0);
});

test('Legalpad requires returning to the exact agreement before submitting its retained signing draft', async ({ page, request, baseURL }) => {
  page.on('dialog', dialog => dialog.accept());
  const first = await api<SuiteDetail>(request, baseURL!, '/suite/legalpad', { kind: 'document', title: `Consent source ${randomUUID().slice(0, 8)}`, text: 'These are the exact first agreement terms.', signatureType: 'individual' });
  const second = await api<SuiteDetail>(request, baseURL!, '/suite/legalpad', { kind: 'document', title: `Other agreement ${randomUUID().slice(0, 8)}`, text: 'This is an unrelated agreement with different terms.', signatureType: 'individual' });
  await page.goto(`./#legalpad/${first.record.id}`); const editor = await begin(page, 'Legalpad', 'Sign Version 1'); await editor.getByLabel('Your full name', { exact: true }).fill('Pinned Contributor'); await editor.getByLabel('I have read and agree to version 1 of this agreement', { exact: true }).check();
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/suite/legalpad/')) writes++; });
  await page.evaluate(id => { location.hash = `legalpad/${id}`; }, second.record.id);
  await expect(page.getByText('This is an unrelated agreement with different terms.', { exact: true })).toBeVisible(); await expect(editor.getByRole('button', { name: 'Sign Version 1', exact: true })).toBeDisabled(); await expect(editor).toContainText('Return to this object'); expect(writes).toBe(0);
  await editor.getByRole('link', { name: first.record.id, exact: true }).click(); await expect(page.getByText('These are the exact first agreement terms.', { exact: true })).toBeVisible(); await expect(editor.getByRole('button', { name: 'Sign Version 1', exact: true })).toBeEnabled(); await save(page, 'Legalpad', 'Sign Version 1');
  const signed = await api<SuiteDetail>(request, baseURL!, `/suite/legalpad/${first.record.id}`), untouched = await api<SuiteDetail>(request, baseURL!, `/suite/legalpad/${second.record.id}`); expect((signed.record.data as LegalpadData).signatures).toHaveLength(1); expect((untouched.record.data as LegalpadData).signatures).toHaveLength(0); expect(writes).toBe(1);
});

test('Legalpad exact signature recovery preserves edits made after an uncertain result', async ({ page, request, baseURL }) => {
  page.on('dialog', dialog => dialog.accept());
  const created = await api<SuiteDetail>(request, baseURL!, '/suite/legalpad', { kind: 'document', title: `Receipt retry ${randomUUID().slice(0, 8)}`, text: 'Exact consent survives a dropped response.', signatureType: 'individual' });
  await page.goto(`./#legalpad/${created.record.id}`); const editor = await begin(page, 'Legalpad', 'Sign Version 1'); await editor.getByLabel('Your full name', { exact: true }).fill('Original Signature Name'); await editor.getByLabel('I have read and agree to version 1 of this agreement', { exact: true }).check();
  let dropped = false; const attempts: { body: unknown; key: string | undefined }[] = [];
  await page.route(`**/api/suite/legalpad/${created.record.id}/sign`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (!dropped) { dropped = true; const result = await route.fetch(); expect(result.ok(), await result.text()).toBe(true); await route.abort('failed'); } else await route.continue();
  });
  await editor.getByRole('button', { name: 'Sign Version 1', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toBeVisible();
  await editor.getByLabel('Your full name', { exact: true }).fill('Draft name edited after uncertain result');
  await page.getByRole('button', { name: 'Retry Exact Request', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toHaveCount(0);
  await expect(editor.getByLabel('Your full name', { exact: true })).toHaveValue('Draft name edited after uncertain result');
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  const result = await api<SuiteDetail>(request, baseURL!, `/suite/legalpad/${created.record.id}`), data = result.record.data as LegalpadData; expect(data.signatures).toHaveLength(1); expect(data.signatures[0]!.signerName).toBe('Original Signature Name'); expect(data.signatures[0]!.documentVersion).toBe(1);
});
