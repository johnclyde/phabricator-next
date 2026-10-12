import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AppState, Repository, RevisionDetail, RevisionVersion } from '../shared/types';
import type { PaperBuild, PaperBuildInput, PaperBuildPage, PaperSyncTeX } from '../shared/paper-builds';
import type { ObjectAccess } from '../shared/policy';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import { openComparisonOptions } from './comparison-ui';

const toolchain = { engine: 'UI fixture engine', image: 'fixture@sha256:' + 'a'.repeat(64), bundle: 'b'.repeat(64) }, toolchainId = 'c'.repeat(64);
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> { const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
async function paper(request: APIRequestContext, baseURL: string) { return api<RevisionDetail>(request, baseURL, '/revisions', { testPlan: 'Fixture verification plan.', title: `Paper builds ${Date.now()}`, kind: 'paper', files: [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\input{chapter}\n\\end{document}\n' }, { path: 'chapter.tex', content: 'Original chapter.\n' }] }); }
function build(version: RevisionVersion, id = 'PB-fixture', status: PaperBuild['status'] = 'succeeded'): PaperBuild { return { id, revisionId: version.revisionId, versionId: version.id, versionNumber: version.number, contentHash: version.contentHash, entrypoint: 'main.tex', toolchainId, toolchain, requestedBy: 'fixture', status, attempt: 1, createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: status === 'queued' || status === 'running' ? null : '2026-01-01T00:00:02.000Z', error: null, diagnostics: [], artifacts: [], attempts: [{ number: 1, status, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: status === 'queued' || status === 'running' ? null : '2026-01-01T00:00:02.000Z', error: null }] }; }
const pageData = (builds: PaperBuild[], accessEpoch: number): PaperBuildPage => ({ builds, nextBefore: null, accessEpoch, configuration: { available: true, reason: null, toolchain, toolchainId } });
async function open(page: Page, id: string) { await page.goto(`./#${id}`); await expect(page.getByRole('region', { name: 'Paper compilation', exact: true })).toBeVisible(); }

// A real two-page PDF exercises the local renderer without pretending to test TeX.
function pdfFixture(): Buffer {
  const streams = ['BT /F1 20 Tf 70 700 Td (Original paper page one) Tj ET', 'BT /F1 20 Tf 70 700 Td (Original paper page two) Tj ET'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...streams.map(content => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(result); result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(result);
}

test('an unconfigured compiler remains visibly unavailable and never queues an offline compile', async ({ page, request, baseURL, context }) => {
  const detail = await paper(request, baseURL!); await open(page, detail.revision.id); const panel = page.locator('.paper-builds');
  await expect(panel.getByText('An isolated paper compiler is not configured by the server operator.')).toBeVisible(); await expect(panel.getByRole('button', { name: 'Compile Version 1', exact: true })).toBeDisabled();
  await context.setOffline(true); await expect(panel.getByText('Connect to compile, cancel, retry, or load artifacts. No build request is sent automatically after reconnecting.')).toBeVisible();
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':outbox')).every(([, value]) => !value.includes('paper-builds')))).toBe(true);
});

test('lost compile responses retain immutable source and compiler pins across reload and newer source versions', async ({ page, request, baseURL, context }) => {
  const detail = await paper(request, baseURL!), id = detail.revision.id; const state = await api<AppState>(request, baseURL!, '/state');
  const sent: { input: PaperBuildInput; key?: string }[] = []; const builds: PaperBuild[] = []; let lose = true;
  await page.route(`**/api/revisions/${id}/paper-builds**`, async route => {
    if (route.request().method() === 'POST') { const input = route.request().postDataJSON() as PaperBuildInput; sent.push({ input, key: route.request().headers()['idempotency-key'] }); if (!builds.length) builds.push({ ...build(detail.versions[0]!, 'PB-request', 'queued'), ...input }); if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ json: builds[0] }); }
    else if (new URL(route.request().url()).pathname.endsWith('/PB-request')) await route.fulfill({ json: { build: builds[0], accessEpoch: state.accessEpoch } });
    else await route.fulfill({ json: pageData(builds, state.accessEpoch) });
  });
  await open(page, id); const panel = page.locator('.paper-builds'); await panel.getByLabel('TeX entrypoint').selectOption('chapter.tex');
  await panel.getByRole('button', { name: 'Compile Version 1', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('outcome is unknown');
  await api(request, baseURL!, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'A later source version', files: [{ path: 'main.tex', content: 'Later source must not replace the submitted compilation.' }] });
  await page.reload(); await expect(page.getByLabel('Version to inspect').getByRole('option', { name: 'Version 2 · current', exact: true })).toHaveCount(1); await openComparisonOptions(page); await page.getByRole('button', { name: 'Show current version', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Compile Version 2', exact: true })).toBeVisible();
  await context.setOffline(true); await expect(panel.getByRole('button', { name: 'Retry Exact Compile Request' })).toBeDisabled(); await context.setOffline(false); await expect(panel.getByRole('button', { name: 'Retry Exact Compile Request' })).toBeEnabled(); expect(sent).toHaveLength(1);
  await panel.getByRole('button', { name: 'Retry Exact Compile Request' }).click(); await expect(panel.getByRole('region', { name: 'Unconfirmed paper build requests' })).toHaveCount(0);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(sent[0]!.input).toEqual({ versionId: detail.versions[0]!.id, contentHash: detail.versions[0]!.contentHash, entrypoint: 'chapter.tex', toolchainId }); expect(sent[0]!.key).toBeTruthy();
  await expect(panel.getByRole('region', { name: 'Build for version 1' })).toBeVisible(); await expect(page.getByLabel('Version to inspect')).toHaveValue('2'); expect(builds).toHaveLength(1);
});

test('a delayed compile receipt preserves a newer build selection and older running builds refresh beyond the first page', async ({ page, request, baseURL }) => {
  const detail = await paper(request, baseURL!), id = detail.revision.id, state = await api<AppState>(request, baseURL!, '/state');
  const first = build(detail.versions[0]!, 'PB-old', 'running'), next = build(detail.versions[0]!, 'PB-new'); next.createdAt = '2026-02-01T00:00:00.000Z';
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured = false, paginated = false, olderReads = 0;
  await page.route(`**/api/revisions/${id}/paper-builds**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') { captured = true; await held; await route.fulfill({ json: { ...build(detail.versions[0]!, 'PB-delayed'), ...route.request().postDataJSON() } }); }
    else if (path.endsWith('/PB-old')) { olderReads++; await route.fulfill({ json: { build: { ...first, status: 'succeeded' }, accessEpoch: state.accessEpoch } }); }
    else await route.fulfill({ json: pageData(paginated ? [next] : [next, first], state.accessEpoch) });
  });
  try { await open(page, id); const panel = page.locator('.paper-builds'); await panel.getByRole('button', { name: 'Compile Version 1', exact: true }).click(); await expect.poll(() => captured).toBe(true); await panel.locator('.paper-build-select').filter({ hasText: 'Succeeded' }).click(); release(); await expect(panel.getByRole('region', { name: 'Build for version 1' })).toContainText('PB-new');
    paginated = true; await panel.getByRole('button', { name: 'Refresh Builds' }).click(); await expect.poll(() => olderReads).toBeGreaterThan(0); await expect(panel.locator('.paper-build-select').filter({ hasText: 'Running' })).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('PDF preview renders locally on mobile, downloads verified bytes and navigates original source in both directions', async ({ page, request, baseURL }, info) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage; let hold = true; let release = () => {};
    Object.assign(window, { paperPageHeld: false, releasePaperPage: () => { hold = false; release(); } });
    Worker.prototype.postMessage = function(message, transferOrOptions) { const value = message as { action?: string; data?: { pageIndex?: number } }; if (hold && value?.action === 'GetPage' && value.data?.pageIndex === 1) { Object.assign(window, { paperPageHeld: true }); release = () => Reflect.apply(original, this, [message, transferOrOptions]); } else Reflect.apply(original, this, [message, transferOrOptions]); };
  });
  const detail = await paper(request, baseURL!), id = detail.revision.id; await api(request, baseURL!, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'A later paper', files: [{ path: 'main.tex', content: 'A newer paper source.' }] });
  const state = await api<AppState>(request, baseURL!, '/state'), bytes = pdfFixture(), record = build(detail.versions[0]!);
  record.artifacts = [{ kind: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, name: 'paper.pdf', mediaType: 'application/pdf' }, { kind: 'mapping', sha256: 'd'.repeat(64), bytes: 1, name: 'mapping.json', mediaType: 'application/json' }];
  record.diagnostics = [{ severity: 'warning', message: 'Fixture warning belongs to original chapter.', path: 'chapter.tex', line: 1 }];
  const mapping: PaperSyncTeX = { versionId: record.versionId, contentHash: record.contentHash, accessEpoch: state.accessEpoch, origin: 'top-left', units: 'pt', pages: [{ page: 1, width: 600, height: 800 }, { page: 2, width: 600, height: 800 }], points: [{ path: 'main.tex', line: 3, page: 1, x: 70, y: 80, width: 300, height: 20 }, { path: 'chapter.tex', line: 1, page: 2, x: 70, y: 80, width: 300, height: 20 }] };
  let binaries = 0; await page.route(`**/api/revisions/${id}/paper-builds**`, async route => { const path = new URL(route.request().url()).pathname; if (path.endsWith('/artifacts/pdf')) { binaries++; await route.fulfill({ body: bytes, contentType: 'application/pdf', headers: { 'X-Access-Epoch': String(state.accessEpoch), 'Content-Length': String(bytes.length) } }); } else if (path.endsWith('/synctex')) await route.fulfill({ json: mapping }); else await route.fulfill({ json: pageData([record], state.accessEpoch) }); });
  await open(page, id); const panel = page.locator('.paper-builds'); await panel.locator('.paper-build-select').click(); await panel.getByRole('button', { name: 'Open PDF Preview' }).click(); const preview = panel.getByRole('region', { name: 'PDF preview for version 1' });
  await expect(preview.getByRole('img', { name: 'Page 1 of paper version 1' })).toBeVisible(); await expect(preview.getByText('Rendering page 1…')).toHaveCount(0); await preview.getByText('Accessible page text', { exact: true }).click(); await expect(preview.locator('.paper-pdf-text')).toContainText('Original paper page one');
  await preview.getByRole('button', { name: 'Next Page', exact: true }).click(); await expect(preview.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect.poll(() => page.evaluate(() => (window as unknown as { paperPageHeld: boolean }).paperPageHeld)).toBe(true); await expect(preview.getByRole('img')).toHaveCount(0); await expect(preview.locator('.paper-pdf-text')).toHaveCount(0); await preview.locator('canvas').dispatchEvent('click', { clientX: 100, clientY: 100 }); await expect(preview.locator('.paper-pdf-source')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releasePaperPage: () => void }).releasePaperPage()); await expect(preview.locator('.paper-pdf-text')).toContainText('Original paper page two');
  await preview.getByLabel('PDF source location', { exact: true }).selectOption('1'); await preview.getByRole('button', { name: 'Open PDF Location in Original Source' }).click(); await expect(page.getByLabel('Version to inspect')).toHaveValue('1'); await expect(page.locator('.source-passages')).toContainText('Original chapter.');
  await preview.getByLabel('PDF source file', { exact: true }).selectOption('main.tex'); await preview.getByLabel('PDF source line', { exact: true }).fill('4'); await expect(preview.getByText('No mapped output for line 4. The nearest mapped source is main.tex:3.')).toBeVisible(); await preview.getByRole('button', { name: 'Find Source in PDF' }).click(); await expect(preview.getByLabel('PDF page', { exact: true })).toHaveValue('1'); await expect(preview.locator('.paper-pdf-highlight')).toBeVisible();
  const downloaded = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download PDF', exact: true }).click(); const download = await downloaded; const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(Buffer.concat(chunks)).toEqual(bytes); expect(binaries).toBe(2);
  await page.evaluate(() => { const element = document.querySelector('.paper-pdf'); if (element) window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 96); }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect((await preview.getByRole('button', { name: 'Next Page', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await mkdir('.data/paper-visual-qa', { recursive: true }); await page.screenshot({ path: `.data/paper-visual-qa/${info.project.name}.png` });
});

test('cancel retries confirm the same request and a rebuild retains the original compiler identity', async ({ page, request, baseURL }) => {
  const detail = await paper(request, baseURL!), id = detail.revision.id, state = await api<AppState>(request, baseURL!, '/state'); let original = build(detail.versions[0]!, 'PB-cancel', 'running'); original.toolchainId = 'e'.repeat(64); const builds = [original]; let lose = true;
  const sent: { path: string; body: unknown; key?: string }[] = [];
  await page.route(`**/api/revisions/${id}/paper-builds**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') { sent.push({ path, body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] }); if (path.endsWith('/cancel')) { original = { ...original, status: 'canceled' }; builds[0] = original; if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ json: original }); } else { const retry = { ...original, id: 'PB-retry', status: 'queued' as const, createdAt: '2026-02-01T00:00:00.000Z' }; builds.push(retry); await route.fulfill({ json: retry }); } }
    else if (path.endsWith('/PB-cancel')) await route.fulfill({ json: { build: original, accessEpoch: state.accessEpoch } });
    else await route.fulfill({ json: pageData(builds, state.accessEpoch) });
  });
  await open(page, id); const panel = page.locator('.paper-builds'); await panel.locator('.paper-build-select').click(); await panel.getByRole('button', { name: 'Cancel Build', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Retry Exact Cancel Request' })).toBeVisible(); await panel.getByRole('button', { name: 'Retry Exact Cancel Request' }).click(); await expect(panel.getByRole('heading', { name: 'Version 1 · Canceled', exact: true })).toBeVisible();
  expect(sent[0]).toEqual(sent[1]); expect(sent[0]!.body).toEqual({}); await panel.getByRole('button', { name: 'Rebuild Same Source' }).click(); await expect(panel.getByRole('region', { name: 'Build for version 1' })).toContainText('PB-retry'); expect(sent[2]!.body).toEqual({}); expect(sent[2]!.key).not.toEqual(sent[0]!.key); expect(builds[1]!.toolchainId).toBe('e'.repeat(64));
});

test('repository access revocation retires an open PDF and rejects artifact bytes held before revocation', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor })));
  const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const call = <T,>(page: Page, path: string, method = 'GET', body?: unknown) => page.evaluate(async ({ path, method, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json(); const response = await fetch(`${location.pathname}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, method, body }) as Promise<T>;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let hold = false, captured = false;
  try {
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); }
    const repository = await call<Repository>(alice!, '/repositories', 'POST', { name: 'Private paper source repository', remoteUrl: 'https://example.invalid/private-paper.git', description: '', defaultBranch: 'main' });
    const detail = await call<RevisionDetail>(alice!, '/revisions', 'POST', { testPlan: 'Fixture verification plan.', title: 'Private compiled source', kind: 'paper', repositoryId: repository.id, files: [{ path: 'main.tex', content: 'Private original source.' }] }), id = detail.revision.id;
    const state = await call<AppState>(alice!, '/state'), bytes = pdfFixture(), record = build(detail.versions[0]!);
    record.artifacts = [{ kind: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mediaType: 'application/pdf', name: 'private.pdf' }];
    await bob!.route(`**/api/revisions/${id}/paper-builds**`, async route => {
      if (new URL(route.request().url()).pathname.endsWith('/artifacts/pdf')) { expect(route.request().headers()['x-session-context']).toBeTruthy(); if (hold) { captured = true; await held; } await route.fulfill({ body: bytes, contentType: 'application/pdf', headers: { 'X-Access-Epoch': String(state.accessEpoch), 'Content-Length': String(bytes.length) } }); }
      else { const response = await route.fetch(); if (!response.ok()) await route.fulfill({ response }); else await route.fulfill({ json: pageData([record], state.accessEpoch) }); }
    });
    await open(bob!, id); const panel = bob!.locator('.paper-builds'); await panel.locator('.paper-build-select').click(); await panel.getByRole('button', { name: 'Open PDF Preview' }).click(); await expect(panel.getByRole('img', { name: 'Page 1 of paper version 1' })).toBeVisible();
    hold = true; await panel.getByRole('button', { name: 'Open PDF Preview' }).click(); await expect.poll(() => captured).toBe(true);
    const policy = await call<ObjectAccess>(alice!, `/policies/${repository.id}`); await call(alice!, `/policies/${repository.id}`, 'PUT', { expectedVersion: policy.policy.version, spaceId: policy.policy.spaceId, ...policy.policy.rules, view: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    await bob!.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob!.locator('.paper-builds')).toHaveCount(0); release(); await bob!.unrouteAll({ behavior: 'wait' }); await expect(bob!.locator('.paper-pdf')).toHaveCount(0); await expect(bob!.getByRole('heading', { name: /Private compiled source/ })).toHaveCount(0);
  } finally { release(); await Promise.all(contexts.map(context => context.close())); }
});
