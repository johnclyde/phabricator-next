import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { WikiDetail, WikiDocument, WikiPathResult } from '../shared/types';
import type { ObjectSubscriptionSnapshot } from '../shared/object-subscriptions';
import type { NotificationInbox, NotificationInput, NotificationSummary } from '../shared/notifications';
import { wikiContentHref } from '../shared/wiki-navigation';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';

const original = '= First section =\n\nOriginal first argument.\n\n= Second section =\n\nOriginal second argument.';
const contents = (page: Page) => page.getByRole('navigation', { name: 'Document contents', exact: true });
async function update(page: Page, id: string, content: string) {
  const detail = await api<WikiDetail>(page, `/documents/${id}`), publication = detail.document.publication!;
  await api(page, `/documents/${id}`, {
    expectedVersion: publication.headVersion, expectedHeadVersionId: publication.headVersionId,
    expectedPublishedVersionId: publication.publishedVersionId, expectedPublicationRevision: publication.revision,
    expectedAccessEpoch: detail.accessEpoch, title: detail.document.title, slug: detail.document.slug, content,
  }, 'PUT');
}
async function unread(page: Page, id: string) {
  return (await api<NotificationInbox>(page, '/notifications?filter=unread')).items.filter(item => item.object.id === id);
}

test('path and canonical section navigation preserve the opening notification boundary through Back and Forward', async ({ browser }, info) => {
  const owner = await signIn(browser, info), reader = await signIn(browser, info, 1), { page } = reader;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const openings: Extract<NotificationInput, { action: 'read_object' }>[] = [];
  const writes: string[] = [];
  try {
    const root = await api<WikiPathResult>(owner.page, '/wiki?path=%2F');
    if (!root.document) await api(owner.page, '/documents', { title: 'Wiki Root', slug: '/', content: 'Root fixture.' });
    const document = await api<WikiDocument>(owner.page, '/documents', { title: 'Section navigation read boundary', slug: `section-notifications-${randomUUID()}`, content: original });
    const subscription = await api<ObjectSubscriptionSnapshot>(page, `/objects/${document.id}/subscriptions`);
    await api(page, `/objects/${document.id}/subscriptions`, { action: 'subscribe', principalId: subscription.viewer.principalId, expectedSubscriptionVersion: subscription.viewer.version, expectedAccessEpoch: subscription.accessEpoch });
    const summary = await api<NotificationSummary>(page, '/notifications/count');
    await api(page, '/notifications/read', { action: 'read_through', horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch });
    await update(owner.page, document.id, original.replaceAll('Original', 'Published'));
    // Direct fixture API writes advance authority outside the mounted client.
    // Read the authorized inbox before observing this foreground opening.
    await page.goto('./#notifications');
    await expect(page.getByRole('region', { name: 'Notification inbox', exact: true })).toContainText(document.title);

    page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    await page.route('**/api/notifications/read', async route => {
      const body = route.request().postDataJSON() as NotificationInput;
      if (body.action === 'read_object') { openings.push(body); if (openings.length === 1) await held; }
      await route.continue();
    });
    const pathHash = `#wiki/${document.location!.path}`;
    await page.goto(`./${pathHash}`);
    await expect(contents(page).getByRole('link')).toHaveText(['First section', 'Second section']);
    await expect.poll(() => openings.length).toBe(1);
    expect(openings[0]).toMatchObject({ action: 'read_object', objectId: document.id });
    const firstOpening = structuredClone(openings[0]!);

    // A version choice is local to this path opening. An event arriving after
    // its observed inbox boundary must survive later section-route remounts.
    await page.getByLabel('Version to inspect', { exact: true }).fill('1');
    await expect(page.locator('.wiki-content')).toContainText('Original second argument.');
    await update(owner.page, document.id, original.replaceAll('Original', 'Later unread'));
    release();
    await expect.poll(async () => (await unread(page, document.id)).length).toBe(1);
    const later = (await unread(page, document.id))[0]!;

    const sectionHref = wikiContentHref(document.id, 1, 'second-section');
    await contents(page).getByRole('link', { name: 'Second section', exact: true }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(sectionHref);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.locator('.wiki-content')).toContainText('Original second argument.');
    await expect.poll(() => page.locator('.wiki-content [data-section="second-section"]').evaluate(element => element === window.document.activeElement)).toBe(true);

    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(pathHash);
    await expect(contents(page).getByRole('link')).toHaveCount(2);
    await page.goForward();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(sectionHref);
    await expect(page.locator('.wiki-content')).toContainText('Original second argument.');
    expect(openings).toEqual([firstOpening]);
    expect((await unread(page, document.id)).map(item => item.id)).toEqual([later.id]);

    // Leaving the object ends the opening. A deliberate reopen can observe
    // and mark the later event instead of retaining that old boundary forever.
    await page.evaluate(() => { location.hash = 'home'; });
    await expect(page.locator('.wiki-content')).toHaveCount(0);
    await page.evaluate(hash => { location.hash = hash; }, pathHash);
    await expect(contents(page).getByRole('link')).toHaveCount(2);
    await expect.poll(() => openings.length).toBe(2);
    expect(openings[1]).toMatchObject({ action: 'read_object', objectId: document.id });
    expect(openings[1]!.horizon).not.toBe(firstOpening.horizon);
    await expect.poll(async () => (await unread(page, document.id)).length).toBe(0);
    expect(writes).toHaveLength(2);
    expect(writes.every(write => /^POST .*\/api\/notifications\/read$/.test(write))).toBe(true);
  } finally {
    release(); await page.unrouteAll({ behavior: 'wait' });
    await owner.context.close(); await reader.context.close();
  }
});
