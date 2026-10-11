import { test, expect, type Page, type TestInfo } from '@playwright/test';

async function createDraft(page: Page, info: TestInfo, source: string) {
  await page.goto('./#drafts');
  await page.getByRole('button', { name: 'Create Draft', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `Threaded argument ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: /^Draft text/ }).fill(source);
  await dialog.getByLabel('Test Plan', { exact: true }).fill('Inspect the immutable source and verify the discussion and access behavior exercised here.');
  await dialog.getByRole('button', { name: 'Create Draft', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(source);
  return new URL(page.url()).hash.slice(1);
}
async function newVersion(page: Page, source: string) {
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill(source);
  await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Add context while preserving the discussed passage.');
  await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
}
async function selectPassage(page: Page, quote: string) {
  await page.getByLabel('Source passage text', { exact: true }).evaluate((element, text) => {
    const node = element.firstChild!; const start = (node.textContent || '').indexOf(text);
    if (start < 0) throw new Error('Passage not present');
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, quote);
  await expect(page.getByRole('button', { name: 'Comment on selected passage', exact: true })).toBeEnabled();
}

test('line-range threads preserve quotations through replies, resolution and new versions on desktop and mobile', async ({ page }, info) => {
  const source = 'Statement of purpose.\nThe requested extension is fourteen days.\nThe supporting evidence is attached.\n';
  await createDraft(page, info, source);
  await page.getByLabel('Passage start line', { exact: true }).fill('2');
  await page.getByLabel('Passage end line', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Comment on line range', exact: true }).click();
  await expect(page.locator('.comment-target .thread-quotation')).toHaveText('The requested extension is fourteen days.');
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Please confirm the requested duration.');
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  const thread = page.locator('.review-thread').filter({ hasText: 'Please confirm the requested duration.' });
  await expect(thread).toHaveCount(1);
  await expect(thread.locator('.thread-quotation')).toHaveText('The requested extension is fourteen days.');
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByRole('textbox', { name: 'Reply to this thread', exact: true }).fill('The schedule supports fourteen days.');
  await thread.getByRole('button', { name: 'Add Reply', exact: true }).click();
  await expect(thread.locator('.comment').getByText('The schedule supports fourteen days.', { exact: true })).toBeVisible();
  await thread.getByRole('button', { name: 'Resolve Thread', exact: true }).click();
  await expect(thread.locator('.thread-heading .badge')).toHaveText('Resolved');
  await expect(thread.getByLabel('Thread state history')).toContainText('resolved while viewing version 1');
  await thread.getByRole('textbox', { name: 'Reply to this thread', exact: true }).fill('Adding a citation does not reopen this discussion.');
  await thread.getByRole('button', { name: 'Add Reply', exact: true }).click();
  await expect(thread.locator('.comment').getByText('Adding a citation does not reopen this discussion.', { exact: true })).toBeVisible();
  await expect(thread.locator('.thread-heading .badge')).toHaveText('Resolved');
  await newVersion(page, `Additional context.\n${source}`);
  await expect(thread.locator('.anchor-projection')).toContainText('Exact quotation located in version 2');
  await expect(thread.locator('.thread-quotation')).toHaveText('The requested extension is fourteen days.');
  await thread.getByRole('button', { name: /^View original version 1/ }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText(source);
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await thread.getByRole('button', { name: 'Reopen Thread', exact: true }).click();
  await expect(thread.locator('.thread-heading .badge')).toHaveText('Open');
  await expect(thread.getByLabel('Thread state history')).toContainText('reopened while viewing version 2');
  await page.getByLabel('Thread status').getByRole('button', { name: /^Resolved/ }).click();
  await expect(thread).toHaveCount(0);
  await page.getByLabel('Thread status').getByRole('button', { name: /^Open/ }).click();
  await expect(thread).toBeVisible();
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace command', exact: true }).fill('read discussion');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.command-feedback')).toContainText('1 open and 0 resolved');
  await expect(page.locator('.command-feedback')).toContainText('The requested extension is fourteen days.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await thread.screenshot({ path: `.data/${info.project.name}-review-thread-detail.png` });
  await page.screenshot({ path: `.data/${info.project.name}-review-threads.png`, fullPage: true });
});

test('source selections retarget explicitly and a late reply save preserves a newer remounted draft', async ({ page }, info) => {
  const source = 'Alpha sentence.\nBeta requested remedy.\nGamma cited reason.\n';
  await createDraft(page, info, source);
  await selectPassage(page, 'Beta requested remedy.');
  await page.getByRole('button', { name: 'Comment on selected passage', exact: true }).click();
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Please cite the underlying evidence.');
  await selectPassage(page, 'Gamma cited reason.');
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByRole('button', { name: 'Comment on selected passage', exact: true }).click();
  await expect(page.locator('.comment-target .thread-quotation')).toHaveText('Beta requested remedy.');
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('Please cite the underlying evidence.');
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Comment on selected passage', exact: true }).click();
  await expect(page.locator('.comment-target .thread-quotation')).toHaveText('Gamma cited reason.');
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  await newVersion(page, `Preface.\n${source}`);
  const thread = page.locator('.review-thread').filter({ hasText: 'Please cite the underlying evidence.' });
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = thread.getByRole('textbox', { name: 'Reply to this thread', exact: true });
  await editor.fill('This first reply will be saved.');
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  const routePattern = '**/api/revisions/*/threads/*/replies';
  await page.route(routePattern, async route => { const response = await route.fetch(); started(); await held; await route.fulfill({ response }); });
  await thread.getByRole('button', { name: 'Add Reply', exact: true }).click();
  await intercepted;
  await expect(editor).toBeDisabled();
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await expect(editor).toHaveValue('');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await expect(editor).toHaveValue('This first reply will be saved.');
  await editor.fill('This newer unsent reply must survive.');
  release();
  await expect(thread.locator('.comment').getByText('This first reply will be saved.', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('This newer unsent reply must survive.');
  await page.unroute(routePattern);
  await page.reload();
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(editor).toHaveValue('This newer unsent reply must survive.');
  await expect(thread.locator('.comment').getByText('This first reply will be saved.', { exact: true })).toHaveCount(1);
});

test('offline replies retain their parent and viewed version and replay once while resolution stays online-only', async ({ page, context }, info) => {
  const id = await createDraft(page, info, 'A reviewable argument.\n');
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Discuss the evidence for this argument.');
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  const thread = page.locator('.review-thread').filter({ hasText: 'Discuss the evidence for this argument.' });
  await expect(thread).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await expect(thread.getByRole('button', { name: 'Resolve Thread', exact: true })).toBeDisabled();
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByRole('textbox', { name: 'Reply to this thread', exact: true }).fill('An offline reply to this exact thread.');
  await thread.getByRole('button', { name: 'Add Reply', exact: true }).click();
  await page.getByRole('button', { name: /Offline outbox, 1 pending/ }).click();
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText('viewedVersionId');
  await expect(page.locator('.outbox-item pre')).toContainText('An offline reply to this exact thread.');
  await context.setOffline(false);
  await expect(page.getByText('Everything is synchronized.', { exact: false })).toBeVisible();
  await page.goto(`./#${id}`);
  await expect(thread.locator('.comment').getByText('An offline reply to this exact thread.', { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(thread.locator('.comment').getByText('An offline reply to this exact thread.', { exact: true })).toHaveCount(1);
});
