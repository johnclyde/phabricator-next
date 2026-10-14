import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AppState } from '../shared/types';
import type { SuiteDetail } from '../shared/suite';
import type { SuiteNotificationPreference } from '../shared/suite-notifications';
import type { NotificationInbox, NotificationSummary } from '../shared/notifications';
import type { MailPreference } from '../shared/mail';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';

const preferences = (page: Page) => page.getByRole('form', { name: 'Notification preferences', exact: true });
const inbox = (page: Page) => page.getByRole('region', { name: 'Notification inbox', exact: true });
async function resetRead(page: Page) {
  const current = await api<NotificationSummary>(page, '/notifications/count');
  await api(page, '/notifications/read', { action: 'read_through', horizon: current.horizon, expectedAccessEpoch: current.accessEpoch });
}

test('suite notification choices survive refresh and navigation, then recover an exact uncertain save without replay on reconnect', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  const attempts: { key: string | undefined; body: unknown }[] = [];
  try {
    const record = await api<SuiteDetail>(alice.page, '/suite/almanac', { kind: 'device', title: `notify-${randomUUID().slice(0, 8)}.test` });
    const other = await api<SuiteDetail>(alice.page, '/suite/almanac', { kind: 'network', title: `other-${randomUUID().slice(0, 8)}` });
    const path = `/suite/almanac/${record.record.id}/notifications`;
    await bob.page.goto(`./#almanac/${record.record.id}`);
    const form = preferences(bob.page);
    await expect(form.getByLabel('Follow updates', { exact: true })).toHaveValue('default');
    await expect(form.getByLabel('Allow email updates for this object', { exact: true })).not.toBeChecked();
    await form.getByLabel('Follow updates', { exact: true }).selectOption('following');
    await form.getByLabel('Mute new notifications', { exact: true }).check();
    await api(alice.page, `/suite/almanac/${record.record.id}/properties`, { expectedVersion: record.record.version, properties: { checked: true } });
    await bob.page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(form.getByLabel('Follow updates', { exact: true })).toHaveValue('following');
    await expect(form.getByLabel('Mute new notifications', { exact: true })).toBeChecked();
    await expect(form.getByRole('button', { name: 'Use Current Preference Version', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Save Notification Preferences', exact: true })).toBeDisabled();
    await bob.page.evaluate(id => { location.hash = `almanac/${id}`; }, other.record.id);
    await expect(form.getByLabel('Follow updates', { exact: true })).toHaveValue('default');
    await expect(form.getByLabel('Mute new notifications', { exact: true })).not.toBeChecked();
    await bob.page.evaluate(id => { location.hash = `almanac/${id}`; }, record.record.id);
    await expect(form.getByLabel('Follow updates', { exact: true })).toHaveValue('following');
    await expect(form.getByLabel('Mute new notifications', { exact: true })).toBeChecked();
    await form.getByRole('button', { name: 'Use Current Preference Version', exact: true }).click();
    await bob.page.route(`**/api${path}`, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      if (attempts.length === 1) { const result = await route.fetch(); expect(result.ok(), await result.text()).toBe(true); await route.abort('failed'); } else await route.continue();
    });
    await form.getByRole('button', { name: 'Save Notification Preferences', exact: true }).click();
    const recovery = bob.page.getByRole('region', { name: 'Unconfirmed automation request', exact: true });
    await expect(recovery).toBeVisible();
    await bob.context.setOffline(true); await bob.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(bob.page.getByText('You are offline. Keep drafts open or export them. Reconnecting never submits changes automatically.', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(1);
    await bob.context.setOffline(false); await bob.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(recovery.getByRole('button', { name: 'Retry Exact Request', exact: true })).toBeEnabled(); expect(attempts).toHaveLength(1);
    await recovery.getByRole('button', { name: 'Retry Exact Request', exact: true }).click();
    await expect(recovery).toHaveCount(0); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    await expect(form.getByRole('button', { name: 'Save Notification Preferences', exact: true })).toBeDisabled();
    const saved = await api<SuiteNotificationPreference>(bob.page, path); expect(saved).toMatchObject({ version: 1, following: 'following', muted: true, email: false });
    await form.getByLabel('Mute new notifications', { exact: true }).uncheck();
    await form.getByRole('button', { name: 'Save Notification Preferences', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Save Notification Preferences', exact: true })).toBeDisabled();
    expect(await api<SuiteNotificationPreference>(bob.page, path)).toMatchObject({ version: 2, following: 'following', muted: false, email: false });
    expect((await api<SuiteDetail>(alice.page, `/suite/almanac/${record.record.id}`)).record.version).toBe(2);
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await bob.page.unrouteAll({ behavior: 'wait' }); await alice.context.close(); await bob.context.close(); }
});

test('suite inbox deep links and private reads work on mobile, email starts off, and removed room membership retires notifications', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    await resetRead(bob.page);
    const aliceState = await api<AppState>(alice.page, '/state'), bobState = await api<AppState>(bob.page, '/state');
    const room = await api<SuiteDetail>(alice.page, '/suite/conpherence', { kind: 'room', title: `Notification conversation ${randomUUID().slice(0, 8)}`, participantIds: [bobState.currentPrincipalId], message: 'The initial message is private.' });
    const latest = await api<SuiteDetail>(alice.page, `/suite/conpherence/${room.record.id}/message`, { expectedVersion: room.record.version, body: 'A private message belongs only in the conversation.' });
    await bob.page.goto('./#notifications');
    const received = await api<NotificationInbox>(bob.page, '/notifications'), notification = received.items.find(item => item.object.id === room.record.id && item.event.kind === 'suite_message')!;
    expect(notification).toBeTruthy();
    const row = inbox(bob.page).locator(`[data-notification-id="${notification.id}"]`);
    await expect(row).toBeVisible(); await expect(inbox(bob.page)).not.toContainText('A private message belongs only in the conversation.');
    await row.getByRole('button', { name: 'Mark Read', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Mark Unread', exact: true })).toBeEnabled();
    await inbox(bob.page).getByText('Email settings', { exact: true }).click();
    const mail = bob.page.locator('details[aria-label="Notification email settings"]');
    await expect(mail).toContainText('Email is unavailable until an operator configures');
    await expect(mail.getByRole('button', { name: 'Enable Email', exact: true })).toBeDisabled();
    expect(await api<MailPreference>(bob.page, '/mail/preferences')).toMatchObject({ enabled: false, available: false });
    const link = row.getByRole('link', { name: `${room.record.id} ${room.record.title}`, exact: true });
    await expect(link).toHaveAttribute('href', `#conpherence/${room.record.id}`); await link.click();
    await expect(bob.page).toHaveURL(new RegExp(`#conpherence/${room.record.id}$`));
    const messages = bob.page.getByRole('region', { name: 'Conversation messages', exact: true });
    await expect(messages).toContainText('A private message belongs only in the conversation.');
    await expect(preferences(bob.page).getByLabel('Allow email updates for this object', { exact: true })).not.toBeChecked();
    expect((await api<NotificationInbox>(bob.page, '/notifications')).items.find(item => item.id === notification.id)!.read).toBe(true);
    await api(alice.page, `/suite/conpherence/${room.record.id}/participants`, { expectedVersion: latest.record.version, participantIds: [aliceState.currentPrincipalId] });
    await expect(messages).toHaveCount(0); await expect(preferences(bob.page)).toHaveCount(0);
    await bob.page.goto('./#notifications');
    await expect(inbox(bob.page)).toBeVisible(); await expect(inbox(bob.page)).not.toContainText(room.record.title);
    await expect(bob.page.getByRole('button', { name: 'Notifications, 0 unread', exact: true })).toBeVisible();
    expect((await api<NotificationInbox>(bob.page, '/notifications')).items.some(item => item.object.id === room.record.id)).toBe(false);
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await alice.context.close(); await bob.context.close(); }
});
