import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import type { SuiteDetail } from '../shared/suite';
import type { ConpherenceData } from '../shared/conpherence';
import type { CalendarData } from '../shared/calendar';

const base = normalizeBasePath(process.env.APP_BASE_PATH), authenticatedBase = `http://127.0.0.1:4312${base}`;
test.use({ baseURL: authenticatedBase });
async function signIn(page: Page, index: number) {
  await page.goto(`${authenticatedBase}#home`);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}
async function read(page: Page, path: string): Promise<{ status: number; body: SuiteDetail }> {
  return page.evaluate(async ({ base, path }) => {
    const session = await (await fetch(`${base}api/session`)).json();
    const response = await fetch(`${base}api/suite/${path}`, { headers: { 'X-Session-Context': session.sessionContext } });
    return { status: response.status, body: await response.json() };
  }, { base, path });
}
async function action(page: Page, app: string, label: string, fill?: (form: Locator) => Promise<void>, confirm = false) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const form = page.getByRole('form', { name: `${app} editor`, exact: true });
  if (fill) await fill(form);
  if (confirm) page.once('dialog', dialog => void dialog.accept());
  await form.getByRole('button', { name: label, exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })); await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0); await mkdir('.data/suite-social-visual', { recursive: true });
  await page.screenshot({ path: `.data/suite-social-visual/${name}.png`, fullPage: true });
}

test('Conpherence persists private conversation messages, read state, membership and personal archives', async ({ page, browser }, info) => {
  await signIn(page, 0);
  await page.goto(`${authenticatedBase}#conpherence`);
  const title = `Private discussion ${info.project.name} ${Date.now()}`;
  await action(page, 'Conpherence', 'Create Conversation', async form => {
    await form.getByLabel('Conversation title', { exact: true }).fill(title);
    await form.getByLabel('Topic', { exact: true }).fill('Exact findings and next paper revision');
    await form.getByRole('group', { name: 'Participants', exact: true }).getByRole('checkbox', { name: 'Bob Editor', exact: true }).check();
    await form.getByLabel('First message', { exact: true }).fill('Please check the argument in section three.');
  });
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toContainText('Please check the argument in section three.');
  const id = new URL(page.url()).hash.split('/')[1]!;
  expect(id).toMatch(/^Z-/);
  const second = await browser.newContext({ baseURL: authenticatedBase, viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  try {
    const bob = await second.newPage(); await signIn(bob, 1); await bob.goto(`${authenticatedBase}#conpherence/${id}`);
    const messages = bob.getByRole('region', { name: 'Conversation messages', exact: true });
    await expect(messages).toContainText('1 unread');
    await action(bob, 'Conpherence', 'Send Message', async form => { await form.getByLabel('Message', { exact: true }).fill('I checked the claim and retained the evidence.'); });
    await expect(messages).toContainText('I checked the claim and retained the evidence.');
    await expect(messages).toContainText('1 unread');
    await action(bob, 'Conpherence', 'Mark Read'); await expect(messages).toContainText('0 unread');
    await action(bob, 'Conpherence', 'Archive for Me'); await expect(messages).toContainText('Archived for you');
    await action(bob, 'Conpherence', 'Restore Conversation'); await expect(messages).not.toContainText('Archived for you');
    const detail = (await read(bob, `conpherence/${id}`)).body;
    const data = detail.record.data as ConpherenceData;
    expect(data.messages.map(message => message.authorName)).toEqual(['Alice Researcher', 'Bob Editor']);
    expect(data.messages.map(message => message.body)).toHaveLength(2);
    expect(data.unreadCount).toBe(0);
    expect(detail.record.access.visibility).toBe('members');
    await bob.reload(); await expect(messages).toContainText('I checked the claim and retained the evidence.');
    await screenshot(bob, `conpherence-${info.project.name}`);
    await page.reload();
    await action(page, 'Conpherence', 'Edit Conversation', async form => { await form.getByLabel('Topic', { exact: true }).fill('Evidence reviewed by both participants'); });
    await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toContainText('Evidence reviewed by both participants');
    await action(page, 'Conpherence', 'Leave Conversation', undefined, true);
    await expect(page.getByRole('status')).toContainText('Your access to this object has ended');
    expect((await read(page, `conpherence/${id}`)).status).toBe(404);
    await bob.reload();
    await expect(messages).toContainText('I checked the claim and retained the evidence.');
    await expect(bob.getByRole('button', { name: 'Leave Conversation', exact: true })).toHaveCount(0);
    expect(((await read(bob, `conpherence/${id}`)).body.record.data as ConpherenceData).participants.map(person => person.displayName)).toEqual(['Bob Editor']);
  } finally { await second.close(); }
});

test('Calendar persists timezone schedules, invitations, personal RSVP, discussion and cancellation', async ({ page, browser }, info) => {
  await signIn(page, 0); await page.goto(`${authenticatedBase}#calendar`);
  const title = `Paper workshop ${info.project.name} ${Date.now()}`;
  await action(page, 'Calendar', 'Create Event', async form => {
    await form.getByLabel('Event title', { exact: true }).fill(title);
    await form.getByLabel('Description', { exact: true }).fill('Review the latest paper revision together.');
    await form.getByLabel('Location', { exact: true }).fill('Reading room');
    await form.getByLabel('IANA timezone', { exact: true }).fill('America/Los_Angeles');
    await form.getByLabel('Starts (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill('2026-10-15T09:00');
    await form.getByLabel('Ends (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill('2026-10-15T10:00');
  });
  const event = page.getByRole('region', { name: 'Calendar event', exact: true });
  await expect(event).toContainText('2026-10-15 09:00');
  const id = new URL(page.url()).hash.split('/')[1]!;
  await action(page, 'Calendar', 'Invite People', async form => { await form.getByRole('group', { name: 'People to invite', exact: true }).getByRole('checkbox', { name: 'Bob Editor', exact: true }).check(); });
  await expect(event.locator('.audit-auditors')).toContainText('Bob Editor');
  await action(page, 'Calendar', 'Edit Event', async form => {
    await expect(form.getByLabel('Starts (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true })).toHaveValue('2026-10-15T09:00');
    await expect(form.getByLabel('Ends (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true })).toHaveValue('2026-10-15T10:00');
    await form.getByLabel('Starts (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill('2026-10-15T11:00');
    await form.getByLabel('Ends (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill('2026-10-15T12:00');
  });
  await expect(event).toContainText('2026-10-15 11:00');
  const second = await browser.newContext({ baseURL: authenticatedBase, viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  try {
    const bob = await second.newPage(); await signIn(bob, 1); await bob.goto(`${authenticatedBase}#calendar/${id}`);
    await expect(bob.getByRole('button', { name: 'Edit Event', exact: true })).toHaveCount(0);
    await action(bob, 'Calendar', 'Respond to Event', async form => { await form.getByLabel('Attendance', { exact: true }).selectOption('attending'); });
    await expect(bob.locator('.audit-auditors article').filter({ hasText: 'Bob Editor' })).toContainText('Attending');
    await action(bob, 'Calendar', 'Comment', async form => { await form.getByLabel('Event comment', { exact: true }).fill('I will bring the marked-up draft.'); });
    await expect(bob.getByRole('region', { name: 'Calendar event', exact: true })).toContainText('I will bring the marked-up draft.');
    await page.reload(); await expect(event).toContainText('I will bring the marked-up draft.');
    await action(page, 'Calendar', 'Cancel Event', undefined, true); await expect(event).toContainText('Cancelled');
    await bob.reload(); await expect(bob.getByRole('button', { name: 'Respond to Event', exact: true })).toHaveCount(0);
    await action(page, 'Calendar', 'Reinstate Event', undefined, true); await expect(event).toContainText('Scheduled');
    const data = (await read(page, `calendar/${id}`)).body.record.data as CalendarData;
    expect(data.start).toBe('2026-10-15T18:00:00.000Z');
    expect(data.end).toBe('2026-10-15T19:00:00.000Z');
    expect(data.invitees.find(person => person.displayName === 'Bob Editor')!.status).toBe('attending');
    expect(data.comments[0]!.authorName).toBe('Bob Editor');
    await screenshot(page, `calendar-${info.project.name}`);
  } finally { await second.close(); }
});

test('Calendar month agenda exposes saved recurrence and independent occurrence exceptions', async ({ page, browser }, info) => {
  await signIn(page, 0); await page.goto(`${authenticatedBase}#calendar`);
  const current = await page.evaluate(() => { const now = new Date(); return { day: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }; });
  const title = `Recurring paper group ${info.project.name} ${Date.now()}`;
  await action(page, 'Calendar', 'Create Event', async form => {
    await form.getByLabel('Event title', { exact: true }).fill(title);
    await form.getByLabel('IANA timezone', { exact: true }).fill(current.timezone);
    await form.getByLabel('Starts (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill(`${current.day}T09:00`);
    await form.getByLabel('Ends (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill(`${current.day}T10:00`);
    await form.getByLabel('Repeat', { exact: true }).selectOption('daily');
    await form.getByLabel(/^Occurrence count/).fill('3');
  });
  const event = page.getByRole('region', { name: 'Calendar event', exact: true });
  await expect(event).toContainText('3 daily occurrences');
  const id = new URL(page.url()).hash.split('/')[1]!;
  await page.getByRole('button', { name: 'Refresh Calendar', exact: true }).click();
  await expect(page.getByText('Loading all visible calendar events…', { exact: true })).toHaveCount(0);
  await page.getByRole('group', { name: 'Calendar month', exact: true }).getByRole('button', { name: new RegExp(`^${current.day},`) }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  const initial = (await read(page, `calendar/${id}`)).body.record.data as CalendarData;
  const date = initial.occurrences[1]!.start.slice(0, 10);
  await action(page, 'Calendar', 'Reschedule One Occurrence', async form => {
    await form.getByLabel('Occurrence', { exact: true }).selectOption('2');
    await form.getByLabel('Starts (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill(`${date}T11:00`);
    await form.getByLabel('Ends (YYYY-MM-DDTHH:mm, or date for all-day)', { exact: true }).fill(`${date}T12:00`);
  });
  await expect(event).toContainText('Rescheduled from');
  await action(page, 'Calendar', 'Cancel One Occurrence', async form => { await form.getByLabel('Occurrence', { exact: true }).selectOption('3'); }, true);
  await expect(event.getByRole('heading', { name: 'Occurrence 3 · Cancelled', exact: true })).toBeVisible();
  await action(page, 'Calendar', 'Respond to Event', async form => { await form.getByLabel('Occurrence', { exact: true }).selectOption('2'); await form.getByLabel('Attendance', { exact: true }).selectOption('declined'); });
  await expect(event.locator('article').filter({ hasText: 'Occurrence 2' })).toContainText('Alice Researcher: declined');
  const result = (await read(page, `calendar/${id}`)).body.record.data as CalendarData;
  expect(result.occurrences[0]).toEqual(initial.occurrences[0]);
  expect(result.occurrences[1]!.originalStart).toBe(initial.occurrences[1]!.start);
  expect(result.occurrences[1]!.overridden).toBe(true);
  expect(result.occurrences[2]!.status).toBe('cancelled');
  const second = await browser.newContext({ baseURL: authenticatedBase, viewport: page.viewportSize(), isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  try {
    const bob = await second.newPage(); await signIn(bob, 1); await bob.goto(`${authenticatedBase}#calendar/${id}`);
    await action(bob, 'Calendar', 'Respond to Event', async form => { await form.getByLabel('Occurrence', { exact: true }).selectOption('1'); await form.getByLabel('Attendance', { exact: true }).selectOption('attending'); });
    await expect(bob.getByRole('region', { name: 'Calendar event', exact: true })).toContainText('Bob Editor: attending');
    await page.reload(); await expect(event).toContainText('Bob Editor: attending');
    await action(page, 'Calendar', 'Remove Invitations', async form => { await form.getByRole('group', { name: 'Invitations to remove', exact: true }).getByRole('checkbox', { name: 'Bob Editor', exact: true }).check(); });
    await expect(event).not.toContainText('Bob Editor');
    const removed = (await read(page, `calendar/${id}`)).body.record.data as CalendarData;
    expect(removed.occurrences.every(item => item.invitees.every(person => person.displayName !== 'Bob Editor'))).toBe(true);
  } finally { await second.close(); }
  await screenshot(page, `calendar-series-${info.project.name}`);
});
