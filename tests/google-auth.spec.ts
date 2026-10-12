import { test, expect, type Page, type Route } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
const base = normalizeBasePath(process.env.APP_BASE_PATH);
test.use({ baseURL: `http://127.0.0.1:4312${base}`, serviceWorkers: 'block' });
const config = { projectId: 'workspace-signin', apiKey: 'public-fixture-api-key-1234567890', authDomain: 'workspace-signin.firebaseapp.com', appId: '1:123456789:web:abcdef123456' };
type Mock = { preparations: number; attempts: number; disposals: number; aborted: number; gestures: boolean[]; error: string | null; finish?: (token: string) => void };
const mockModule = `
export async function prepareGoogleAuth(config, signal) {
  const state = window.__googleAuthFixture; state.preparations++;
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; state.disposals++; } };
  signal.addEventListener('abort', dispose, {once:true});
  return { dispose, signIn(attempt) {
    state.attempts++; state.gestures.push(navigator.userActivation.isActive);
    attempt.addEventListener('abort', () => { state.aborted++; dispose(); }, {once:true});
    if (state.error) return Promise.reject({code:state.error});
    // Deliberately resolve even after cancellation to prove the real SessionGate's late-result fence.
    return new Promise(resolve => { state.finish = resolve; });
  }};
}`;
async function fixture(page: Page, providers: (route: Route) => Promise<void> = route => route.fulfill({ json: { google: config } })) {
  await page.addInitScript(() => { (window as unknown as { __googleAuthFixture: Mock }).__googleAuthFixture = { preparations: 0, attempts: 0, disposals: 0, aborted: 0, gestures: [], error: null }; });
  await page.route('**/api/auth/providers', providers);
  await page.route('**/assets/google-auth-*.js', route => route.fulfill({ contentType: 'text/javascript', body: mockModule }));
}
async function state(page: Page) { return page.evaluate(() => { const value = (window as unknown as { __googleAuthFixture: Mock }).__googleAuthFixture; return { ...value, finish: undefined }; }); }
async function finish(page: Page, token = 'fixture-google-token-never-persist') { await page.evaluate(token => (window as unknown as { __googleAuthFixture: Mock }).__googleAuthFixture.finish?.(token), token); }
async function password(page: Page, index = 0) { await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName); }
async function exchange(page: Page, requests: { body: unknown; csrf: string | undefined }[]) {
  await page.route('**/api/login/google', async route => {
    requests.push({ body: route.request().postDataJSON(), csrf: route.request().headers()['x-csrf-token'] });
    // Browser-only transport mock: real fixture password endpoint issues the ordinary protected cookie.
    // Backend Google/JWKS verification has independent server tests; no runtime bypass exists.
    const url = new URL(route.request().url()); url.pathname = `${base}api/login`;
    const response = await route.fetch({ url: url.href, postData: { username: authAccounts[0]!.username, password: authAccounts[0]!.password } });
    await route.fulfill({ response });
  });
}

test('Google is absent when disabled and password sign-in remains available', async ({ page }) => {
  let sdkLoads = 0; page.on('request', request => { if (/google-auth-.*\.js/.test(request.url())) sdkLoads++; });
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { google: null } }));
  await page.goto('./#home'); await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toHaveCount(0); expect(sdkLoads).toBe(0);
  await password(page);
});

test('explicit Google click keeps its user gesture, survives popup focus and exchanges only its token', async ({ page }, info) => {
  await fixture(page); const requests: { body: unknown; csrf: string | undefined }[] = []; await exchange(page, requests);
  let sessionReads = 0, sourceReads = 0; const remote: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/api/session')) sessionReads++; if (url.pathname.endsWith('/api/state')) sourceReads++; if (url.hostname !== '127.0.0.1') remote.push(url.href); });
  await page.goto('./#home'); const button = page.getByRole('button', { name: 'Continue with Google', exact: true }); await expect(button).toBeEnabled();
  expect((await state(page)).attempts).toBe(0); expect(sourceReads).toBe(0); expect(requests).toEqual([]);
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath('google-sign-in.png'), fullPage: true });
  await button.click(); const beforeFocus = sessionReads;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(sessionReads).toBe(beforeFocus); expect((await state(page)).aborted).toBe(0); expect((await state(page)).gestures).toEqual([true]);
  await finish(page); await expect(page.locator('.signed-in-user')).toHaveText('Alice Researcher');
  expect(requests).toHaveLength(1); expect(requests[0]!.body).toEqual({ idToken: 'fixture-google-token-never-persist' }); expect(requests[0]!.csrf).toBeTruthy(); expect(sessionReads).toBeGreaterThan(beforeFocus);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('fixture-google-token'); expect(remote).toEqual([]);
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await page.getByRole('button', { name: 'Sign out and clear drafts', exact: true }).click(); await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled(); expect((await state(page)).disposals).toBeGreaterThan(0);
});

test('cancelled and blocked Google popups preserve password fallback and ignore late identity', async ({ page }) => {
  await fixture(page); let writes = 0; await page.route('**/api/login/google', route => { writes++; return route.fulfill({ status: 500, json: { error: 'Unexpected Google request' } }); });
  await page.goto('./#home'); await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); await page.getByRole('button', { name: 'Cancel Google sign-in', exact: true }).click(); await finish(page);
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled(); expect(writes).toBe(0); expect((await state(page)).aborted).toBe(1);
  await page.evaluate(() => { (window as unknown as { __googleAuthFixture: Mock }).__googleAuthFixture.error = 'auth/popup-blocked'; });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('blocked the Google window'); expect(writes).toBe(0); await password(page);
});

test('another tab and pagehide retire pending Google identity before workspace login', async ({ page, context }) => {
  await fixture(page); let writes = 0; await page.route('**/api/login/google', route => { writes++; return route.fulfill({ status: 500, json: { error: 'Unexpected Google request' } }); });
  await page.goto('./#home'); await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await finish(page); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled(); expect(writes).toBe(0); expect((await state(page)).aborted).toBe(1);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); const other = await context.newPage(); await other.goto('./#home'); await password(other, 1);
  await expect(page.locator('.signed-in-user')).toHaveText('Bob Editor'); await finish(page); expect(writes).toBe(0); expect((await state(page)).aborted).toBe(2); await expect(page.locator('.signed-in-user')).toHaveText('Bob Editor');
});

test('failed provider setup retries explicitly and denied Google accounts stay locked without resubmission', async ({ page }) => {
  let configReads = 0; await fixture(page, route => { configReads++; return configReads === 1 ? route.fulfill({ status: 503, json: { error: 'Temporary setup failure' } }) : route.fulfill({ json: { google: config } }); });
  let writes = 0; await page.route('**/api/login/google', route => { writes++; return route.fulfill({ status: 403, json: { error: 'This Google identity is not linked to an enabled workspace account.' } }); });
  await page.goto('./#home'); await page.getByRole('button', { name: 'Retry Google setup', exact: true }).click(); await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); await finish(page);
  await expect(page.getByRole('alert')).toContainText('not linked'); await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled(); expect(writes).toBe(1); await expect(page.locator('.signed-in-user')).toHaveCount(0);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); }); await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeEnabled(); expect(writes).toBe(1);
});

test('a dispatched Google workspace login cannot be presented as cancelled while its receipt is pending', async ({ page }) => {
  await fixture(page); let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), posted = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/login/google', async route => {
    const url = new URL(route.request().url()); url.pathname = `${base}api/login`;
    const response = await route.fetch({ url: url.href, postData: { username: authAccounts[0]!.username, password: authAccounts[0]!.password } });
    arrived(); await held; await route.fulfill({ response });
  });
  await page.goto('./#home'); await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); await finish(page); await posted;
  await expect(page.getByRole('button', { name: 'Cancel Google sign-in', exact: true })).toBeDisabled(); await expect(page.getByRole('status')).toContainText('Finishing workspace sign-in');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await state(page)).aborted).toBe(0);
  release(); await expect(page.locator('.signed-in-user')).toHaveText('Alice Researcher');
});
