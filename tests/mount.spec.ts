import { test, expect } from '@playwright/test';

test('assets, API calls and installed app stay under the configured mount', async ({ page, baseURL }) => {
  const base = new URL(baseURL!);
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base.origin) requested.push(url.pathname);
  });
  await page.goto('./#P2');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Versioned evidence');
  const registration = await page.evaluate(async () => {
    const worker = await navigator.serviceWorker.ready;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const manifest = await (await fetch(link.href)).json() as { start_url: string; scope: string; id: string; icons: { src: string }[] };
    return {
      scope: worker.scope, script: worker.active?.scriptURL,
      start: new URL(manifest.start_url, link.href).href,
      manifestScope: new URL(manifest.scope, link.href).href,
      id: new URL(manifest.id, link.href).href,
      icons: manifest.icons.map(icon => new URL(icon.src, link.href).pathname),
    };
  });
  expect(registration.scope).toBe(base.href);
  expect(registration.script).toBe(new URL('sw.js', base).href);
  expect(registration.start).toBe(base.href);
  expect(registration.manifestScope).toBe(base.href);
  expect(registration.id).toBe(base.href);
  expect(registration.icons.every(path => path.startsWith(base.pathname))).toBe(true);
  expect(requested).toContain(`${base.pathname}api/revisions/P2`);
  expect(requested.every(path => path.startsWith(base.pathname))).toBe(true);
});

test('offline shell leaves private API and unrelated cached responses alone', async ({ page, context, baseURL }) => {
  const base = new URL(baseURL!);
  await page.goto('./#tasks');
  await expect(page.getByRole('heading', { name: 'Maniphest', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.evaluate(async () => {
    const cache = await caches.open('unrelated-application-test');
    await cache.put('/unrelated-private.txt', new Response('unrelated private data'));
  });
  await context.setOffline(true);
  const result = await page.evaluate(async apiPath => {
    const attempt = async (path: string) => {
      try { return await (await fetch(path)).text(); } catch { return null; }
    };
    return {
      api: await attempt(apiPath), sibling: await attempt('/unrelated-private.txt'),
      preserved: await (await caches.open('unrelated-application-test')).match('/unrelated-private.txt').then(response => response?.text()),
    };
  }, `${base.pathname}api/state`);
  expect(result.api).toBeNull();
  expect(result.sibling).toBeNull();
  expect(result.preserved).toBe('unrelated private data');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Maniphest', exact: true })).toBeVisible();
});
