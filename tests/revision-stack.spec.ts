import { closeReviewedRevision } from './revision-lifecycle-browser';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, RevisionKind } from '../shared/types';
import type { RevisionStack } from '../shared/revision-stack';
import type { RevisionDependencyPage } from '../shared/revision-dependencies';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const stack = (page: Page) => page.getByRole('region', { name: 'Revision Stack', exact: true });
const selected = (page: Page) => stack(page).getByRole('region', { name: 'Selected Stack Revision' });
const row = (page: Page, id: string) => stack(page).getByRole('button', { name: new RegExp(`^${id}:`) });
async function open(page: Page) { const disclosure = page.locator('.revision-stack-disclosure'); if (!await disclosure.getAttribute('open').then(value => value !== null)) await disclosure.locator(':scope > summary').click(); await expect(stack(page).locator('.revision-stack-node').first()).toBeVisible(); }
async function api<T>(request: APIRequestContext, base: string, path: string, body?: unknown, method = 'POST'): Promise<T> { const response = await request.fetch(new URL(`api${path}`, base).href, { method: body === undefined ? 'GET' : method, ...(body === undefined ? {} : { data: body, headers: { 'Idempotency-Key': randomUUID() } }) }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
const input = (title: string, kind: RevisionKind = 'document') => ({ testPlan: 'Fixture verification plan.', title, kind, files: [{ path: 'draft.md', content: 'Exact source stays here.\n' }] });
const create = (request: APIRequestContext, base: string, title: string, kind?: RevisionKind) => api<RevisionDetail>(request, base, '/revisions', input(title, kind));
async function edge(request: APIRequestContext, base: string, id: string, add: string[], remove: string[] = []) { const current = await api<RevisionDependencyPage>(request, base, `/revisions/${id}/dependencies?direction=parents`); return api(request, base, `/revisions/${id}/dependencies`, { direction: 'parents', add, remove, expectedRelationshipVersion: current.relationshipVersion, expectedAccessEpoch: current.accessEpoch }); }
async function branch(request: APIRequestContext, base: string) {
  const seed = await create(request, base, 'Seed manuscript'), parent = await create(request, base, 'Open parent paper', 'paper'), closed = await create(request, base, 'Closed branch', 'code'), ancestor = await create(request, base, 'Shared transitive parent'), sibling = await create(request, base, 'Sibling <script>literal</script>');
  await edge(request, base, seed.revision.id, [parent.revision.id, closed.revision.id]); await edge(request, base, parent.revision.id, [ancestor.revision.id]); await edge(request, base, closed.revision.id, [ancestor.revision.id]); await edge(request, base, sibling.revision.id, [parent.revision.id]); await closeReviewedRevision(request, base, closed.revision.id);
  return { seed, parent, closed, ancestor, sibling };
}

test('whole visible stack preserves branch merges, original authors, closed nodes and historical source navigation', async ({ page, request, baseURL }, info) => {
  const f = await branch(request, baseURL!), id = f.seed.revision.id;
  await api(request, baseURL!, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Later exact source.\n' }], message: 'Second version' });
  const before = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`), graph = await api<RevisionStack>(request, baseURL!, `/revisions/${id}/dependencies/graph`);
  await page.goto(`./#${id}`); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await open(page);
  await expect(stack(page).locator('.revision-stack-node')).toHaveCount(5); await expect(stack(page).locator('.revision-stack-count')).toContainText('2 open transitive parent revisions'); await expect(row(page, f.closed.revision.id)).toContainText('Closed'); await expect(row(page, f.sibling.revision.id)).toContainText('<script>literal</script>');
  await expect(stack(page).locator('.revision-stack-seed')).toContainText(id); expect(await stack(page).locator('svg path').count()).toBe(5); await expect(selected(page)).toContainText(`Original author: ${graph.nodes.find(node => node.id === id)!.originalAuthor?.displayName ?? 'Not recorded'}`);
  await expect(selected(page)).toContainText(`Current author: ${graph.nodes.find(node => node.id === id)!.author?.displayName ?? 'Unassigned'}`);
  await row(page, f.parent.revision.id).focus(); await page.keyboard.press('Enter'); await expect(selected(page)).toContainText(f.sibling.revision.id); await expect(selected(page)).toContainText(f.ancestor.revision.id);
  await selected(page).getByRole('link', { name: `${f.parent.revision.id} ${f.parent.revision.title}`, exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${f.parent.revision.id} `) })).toBeVisible(); await open(page); await row(page, id).click(); await selected(page).getByRole('link', { name: `${id} ${f.seed.revision.title}`, exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${id} `) })).toBeVisible(); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await open(page);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toEqual(before.versions); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') { const bounds = (await stack(page).getByRole('button', { name: 'Reload Stack', exact: true }).boundingBox())!; expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeLessThanOrEqual(80); }
  const folder = `.data/revision-stack-visual/${normalizeBasePath(process.env.APP_BASE_PATH) === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await stack(page).locator('.revision-stack-board').evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -120)); await page.screenshot({ path: `${folder}/${info.project.name}-stack.png` });
});

test('Word manuscripts expose the same stack without changing their exact package', async ({ page, request, baseURL }) => {
  const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(request, baseURL!, '/files', { name: 'stack.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') });
  const state = await api<AppState>(request, baseURL!, '/state'), word = await api<RevisionDetail>(request, baseURL!, '/revisions/docx', { testPlan: 'Fixture verification plan.', title: 'Word stack manuscript', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch }), peer = await create(request, baseURL!, 'Word stack parent');
  await edge(request, baseURL!, word.revision.id, [peer.revision.id]); await page.goto(`./#${word.revision.id}`); await open(page); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(2); await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.'); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${word.revision.id}`)).versions).toEqual(word.versions);
});

test('visited stack reopens offline and reconnect refreshes without submitting relationship edits', async ({ page, context, request, baseURL }) => {
  const f = await branch(request, baseURL!); let writes = 0; page.on('request', event => { if (event.method() === 'POST' && new URL(event.url()).pathname.endsWith('/dependencies')) writes++; });
  await page.goto(`./#${f.seed.revision.id}`); await open(page); await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try { await page.reload(); await open(page); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(5); await expect(stack(page)).toContainText('Saved stack snapshot'); await expect(stack(page).getByRole('button', { name: 'Reload Stack', exact: true })).toBeDisabled(); }
  finally { await context.setOffline(false); }
  await expect(stack(page).getByRole('button', { name: 'Reload Stack', exact: true })).toBeEnabled(); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(5); expect(writes).toBe(0);
});

test.describe('stack snapshot verification and local navigation', () => {
  test.use({ serviceWorkers: 'block' });
  test('same-epoch status and distant relationship changes replace the stack and reject altered snapshots', async ({ page, request, baseURL }) => {
    const f = await branch(request, baseURL!), extra = await create(request, baseURL!, 'Distant new parent'), id = f.seed.revision.id;
    await page.goto(`./#${id}`); await open(page); await expect(stack(page).locator('.revision-stack-count')).toContainText('2 open');
    await closeReviewedRevision(request, baseURL!, f.ancestor.revision.id); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(stack(page).locator('.revision-stack-count')).toContainText('1 open');
    await edge(request, baseURL!, f.sibling.revision.id, [extra.revision.id]); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(row(page, extra.revision.id)).toBeVisible(); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(6);
    const relationships = page.getByRole('region', { name: 'Related Revisions', exact: true }); await relationships.getByRole('button', { name: 'Edit Parent Revisions', exact: true }).click(); const editing = relationships.getByRole('region', { name: 'Edit Parent Revisions', exact: true }); await editing.getByRole('checkbox', { name: new RegExp(`^Add ${extra.revision.id}:`) }).check(); await editing.getByRole('button', { name: 'Save Parent Revisions', exact: true }).click(); await expect(stack(page).locator('svg path')).toHaveCount(7); await expect(stack(page).locator('.revision-stack-count')).toContainText('2 open');
    await page.route(`**/api/revisions/${id}/dependencies/graph`, async route => { const response = await route.fetch(), graph = await response.json(); graph.snapshotId = '0'.repeat(64); await route.fulfill({ response, json: graph }); }); await stack(page).getByRole('button', { name: 'Reload Stack', exact: true }).click(); await expect(stack(page).getByRole('alert')).toContainText('does not match its snapshot'); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(0); await page.unrouteAll({ behavior: 'wait' });
  });
  test('voice and touch share a stack cursor and retirement stops old narration', async ({ page, request, baseURL }) => {
    await page.addInitScript(() => { const state = { active: '' }; Object.assign(window, { stackSpeech: state, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } } }); Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {}, cancel() { state.active = ''; }, speak(utterance: { text: string }) { state.active = utterance.text; } } }); });
    const f = await branch(request, baseURL!); await page.goto(`./#${f.seed.revision.id}`); await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
    const command = async (text: string) => { await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    const speech = () => page.evaluate(() => (window as unknown as { stackSpeech: { active: string } }).stackSpeech.active);
    await command('read stack'); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(5); await command('read stack'); expect(await speech()).toContain('5 visible revisions'); expect(await speech()).toContain('2 open transitive parents');
    await command('next stack revision'); const current = await stack(page).locator('.revision-stack-node[aria-pressed="true"]').innerText(); expect(await speech()).toContain(current.split(/\s/)[0]!);
    await row(page, f.closed.revision.id).click(); await expect.poll(speech).toBe(''); await command('read current stack revision'); expect(await speech()).toContain('Closed branch');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(speech).toBe(''); await expect(page.locator('.command-feedback')).toHaveCount(0); await expect(stack(page).locator('.revision-stack-node')).toHaveCount(5); await command('read current stack revision'); expect(await speech()).toContain('Closed branch');
    await page.goto('./#tasks'); await expect.poll(speech).toBe(''); await expect(page.locator('.command-feedback')).toHaveCount(0);
  });
});

test('a newer verified stack survives storage quota failure when going offline in the same tab', async ({ page, context, request, baseURL }) => {
  const f = await branch(request, baseURL!); await page.goto(`./#${f.seed.revision.id}`); await open(page);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Object.assign(window, { restoreStackStorage: () => { Storage.prototype.setItem = original; } }); Storage.prototype.setItem = function(key: string, value: string) { if (key.includes('revision-stack:')) throw new DOMException('Quota', 'QuotaExceededError'); return original.call(this, key, value); }; });
  try {
    await closeReviewedRevision(request, baseURL!, f.ancestor.revision.id); await stack(page).getByRole('button', { name: 'Reload Stack', exact: true }).click(); await expect(stack(page).locator('.revision-stack-count')).toContainText('1 open'); await expect(stack(page)).toContainText('only retained in this tab');
    await context.setOffline(true); await expect(stack(page)).toContainText('Saved stack snapshot'); await expect(stack(page).locator('.revision-stack-count')).toContainText('1 open'); await expect(stack(page)).toContainText('only retained in this tab');
  } finally { await page.evaluate(() => (window as unknown as { restoreStackStorage: () => void }).restoreStackStorage()); await context.setOffline(false); }
});

test('hidden bridges are omitted and access loss during hash verification cannot restore private stack labels', async ({ browser }, info) => {
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH), contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL: `http://127.0.0.1:4312${basePath}`, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch }))), [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const call = async <T,>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> => page.evaluate(async ({ path, method, body, basePath }) => { const session = await (await fetch(`${basePath}api/session`)).json(), response = await fetch(`${basePath}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, method, body, basePath });
  try {
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); }
    const source = await call<RevisionDetail>(alice!, '/revisions', 'POST', input('Visible stack source')), bridge = await call<RevisionDetail>(alice!, '/revisions', 'POST', input('PRIVATE BRIDGE TITLE')), beyond = await call<RevisionDetail>(alice!, '/revisions', 'POST', input('Visible beyond hidden bridge')), state = await call<AppState>(alice!, '/state');
    for (const [child, parent] of [[source, bridge], [bridge, beyond]]) { const current = await call<RevisionDependencyPage>(alice!, `/revisions/${child!.revision.id}/dependencies?direction=parents`); await call(alice!, `/revisions/${child!.revision.id}/dependencies`, 'POST', { direction: 'parents', add: [parent!.revision.id], remove: [], expectedRelationshipVersion: current.relationshipVersion, expectedAccessEpoch: current.accessEpoch }); }
    const policy = (await call<ObjectAccess>(alice!, `/policies/${bridge.revision.id}`)).policy;
    const visibility = async (hidden: boolean) => { const current = (await call<ObjectAccess>(alice!, `/policies/${bridge.revision.id}`)).policy; await call(alice!, `/policies/${bridge.revision.id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...policy.rules, view: hidden ? { kind: 'principals', principalIds: [state.currentPrincipalId] } : policy.rules.view }); };
    await visibility(true); await bob!.goto(`./#${source.revision.id}`); await open(bob!); await expect(stack(bob!).locator('.revision-stack-node')).toHaveCount(1); await expect(stack(bob!)).not.toContainText(bridge.revision.id); await expect(stack(bob!)).not.toContainText(beyond.revision.id);
    await visibility(false); await bob!.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(stack(bob!).locator('.revision-stack-node')).toHaveCount(3);
    await bob!.evaluate(id => { const original = crypto.subtle.digest.bind(crypto.subtle); const state = { reached: false, release: () => {} }, wait = new Promise<void>(resolve => { state.release = resolve; }); Object.assign(window, { stackDigest: state }); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => { const answer = await original(algorithm, data); if (!state.reached && new TextDecoder().decode(data).includes(`"revisionId":"${id}"`)) { state.reached = true; await wait; } return answer; } }); }, source.revision.id);
    await stack(bob!).getByRole('button', { name: 'Reload Stack', exact: true }).click(); await expect.poll(() => bob!.evaluate(() => (window as unknown as { stackDigest: { reached: boolean } }).stackDigest.reached)).toBe(true);
    await visibility(true); await bob!.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(stack(bob!).locator('.revision-stack-node')).toHaveCount(1); await bob!.evaluate(() => (window as unknown as { stackDigest: { release: () => void } }).stackDigest.release()); await expect(stack(bob!)).not.toContainText(bridge.revision.title); await expect(stack(bob!)).not.toContainText(beyond.revision.id); await expect(bob!.getByRole('heading', { level: 1, name: new RegExp(source.revision.title) })).toBeVisible(); expect(await bob!.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('revision-stack:');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
