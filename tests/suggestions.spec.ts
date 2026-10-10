import { test, expect, type Page, type TestInfo } from '@playwright/test';

async function createDraft(page: Page, info: TestInfo, source: string) {
  await page.goto('./#drafts');
  await page.getByRole('button', { name: 'Create Draft', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `Suggested edits ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: /^Draft text/ }).fill(source);
  await dialog.getByRole('button', { name: 'Create Draft', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  return new URL(page.url()).hash.slice(1);
}
async function selectLine(page: Page, line: number) {
  await page.getByLabel('Passage start line', { exact: true }).fill(String(line));
  await page.getByLabel('Passage end line', { exact: true }).fill(String(line));
  await page.getByRole('button', { name: 'Comment on line range', exact: true }).click();
}
async function suggest(page: Page, line: number, replacement: string, explanation: string) {
  await selectLine(page, line);
  await page.getByRole('checkbox', { name: 'Suggest an edit', exact: true }).check();
  await page.getByLabel('Suggested replacement', { exact: true }).fill(replacement);
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill(explanation);
  await page.getByRole('button', { name: 'Add Suggested Edit', exact: true }).click();
  const thread = page.locator('.review-thread').filter({ hasText: explanation });
  await expect(thread).toBeVisible();
  return thread;
}
async function newVersion(page: Page, source: string) {
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill(source);
  await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Revise the context.');
  await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
}

test('an exact suggested replacement creates a new version and resets acceptance after explicit preview', async ({ page }, info) => {
  const source = 'Statement of purpose.\nThe requested extension is fourteen days.\nThe supporting evidence is attached.\n';
  const replacement = 'The requested extension is twenty-one days.';
  await createDraft(page, info, source);
  await page.getByRole('button', { name: 'Run Local Checks', exact: true }).click();
  await expect(page.getByText(/Local text checks completed for 1 file/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Revision status', exact: true }).selectOption('accepted');
  await expect(page.locator('.revision-title .badge')).toHaveText('Accepted');
  await page.getByRole('button', { name: /^Discussion/ }).click();
  const thread = await suggest(page, 2, replacement, 'The schedule requires three weeks.');
  await expect(thread.locator('.suggestion-original')).toHaveText('The requested extension is fourteen days.');
  await expect(thread.locator('.suggestion-replacement')).toHaveText(replacement);
  await thread.getByText('Show exact text diff', { exact: true }).click();
  await expect(thread.locator('.suggestion-diff del')).toContainText('fourteen');
  await expect(thread.locator('.suggestion-diff ins')).toContainText('twenty-one');
  await thread.getByRole('button', { name: 'Review Suggested Edit', exact: true }).click();
  const confirmation = thread.getByRole('region', { name: 'Confirm suggested edit', exact: true });
  await expect(confirmation).toContainText('Replace 1 passage');
  await expect(confirmation).toContainText('from version 1');
  await expect(confirmation).toContainText('new source will need review again');
  await thread.screenshot({ path: `.data/${info.project.name}-suggestion-preview.png` });
  await confirmation.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: 'Revision status', exact: true })).toHaveValue('needs_review');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', source.replace('The requested extension is fourteen days.', replacement));
  await expect(thread.locator('.thread-heading .badge')).toHaveText('Open');
  await expect(thread.locator('.suggestion-application')).toContainText('applied this edit as version 2');
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toHaveCount(0);
  await expect(page.getByText('Previous review evidence (1)', { exact: true })).toBeVisible();
  await page.reload();
  await expect(thread.locator('.suggestion-application')).toContainText('applied this edit as version 2');
  await thread.getByRole('button', { name: 'View applied version 2', exact: true }).click();
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', source.replace('The requested extension is fourteen days.', replacement));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('old suggestions stay readable but cannot apply offline or after their source version changes', async ({ page, context }, info) => {
  const source = 'Opening argument.\nOne original passage.\nClosing statement.\n';
  await createDraft(page, info, source);
  const thread = await suggest(page, 2, 'One proposed passage.', 'Make the argument more precise.');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
  await expect(thread.getByText('Reconnect to apply a suggested edit. Applying source changes is never queued offline.')).toBeVisible();
  await context.setOffline(false);
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeEnabled();
  await newVersion(page, `New context.\n${source}`);
  await expect(thread.locator('.anchor-projection')).toContainText('Exact quotation located in version 2');
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
  await expect(thread.getByText(/Create a new suggestion on the current version/)).toBeVisible();
  await expect(thread.locator('.suggestion-replacement')).toHaveText('One proposed passage.');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
});

test('empty replacement explicitly deletes only the selected passage', async ({ page }, info) => {
  const source = 'Retain the beginning.\nDelete this redundant sentence.\nRetain the ending.\n';
  await createDraft(page, info, source);
  const thread = await suggest(page, 2, '', 'This sentence repeats the preceding argument.');
  await expect(thread.locator('.suggestion-deletion')).toHaveText('Delete the selected passage. No replacement text.');
  await thread.getByRole('button', { name: 'Review Suggested Edit', exact: true }).click();
  const confirmation = thread.getByRole('region', { name: 'Confirm suggested edit' });
  await expect(confirmation).toContainText('will be deleted');
  await confirmation.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveJSProperty('textContent', 'Retain the beginning.\n\nRetain the ending.\n');
  await expect(thread.locator('.thread-quotation')).toHaveText('Delete this redundant sentence.');
});

test('replacement drafts survive reload, require retarget confirmation and preserve newer text after a late save', async ({ page }, info) => {
  await createDraft(page, info, 'Alpha original.\nBeta original.\n');
  await selectLine(page, 1);
  const toggle = page.getByRole('checkbox', { name: 'Suggest an edit', exact: true });
  await toggle.check();
  await page.getByLabel('Suggested replacement', { exact: true }).fill('');
  await expect(page.getByRole('button', { name: 'Add Suggested Edit', exact: true })).toBeDisabled();
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('Suggested replacement', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  page.once('dialog', dialog => void dialog.dismiss());
  await selectLine(page, 2);
  await expect(page.locator('.comment-target .thread-quotation')).toHaveText('Alpha original.');
  await expect(toggle).toBeChecked();
  page.once('dialog', dialog => void dialog.accept());
  await selectLine(page, 2);
  await expect(page.locator('.comment-target .thread-quotation')).toHaveText('Beta original.');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByLabel('Suggested replacement', { exact: true }).fill('Beta proposed.');
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByRole('button', { name: 'Remove passage anchor', exact: true }).click();
  await expect(page.getByLabel('Suggested replacement', { exact: true })).toHaveValue('Beta proposed.');
  const explanation = 'Improve the second sentence.';
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill(explanation);
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  const pattern = '**/api/revisions/*/comments';
  await page.route(pattern, async route => { const response = await route.fetch(); started(); await held; await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Add Suggested Edit', exact: true }).click();
    await intercepted;
    await expect(page.getByLabel('Suggested replacement', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /^Review evidence/ }).click();
    await page.getByRole('button', { name: /^Discussion/ }).click();
    await page.getByLabel('Suggested replacement', { exact: true }).fill('Beta newer unsaved proposal.');
    release();
    const thread = page.locator('.review-thread').filter({ hasText: explanation });
    await expect(thread.locator('.suggestion-replacement')).toHaveText('Beta proposed.');
    await expect(page.getByLabel('Suggested replacement', { exact: true })).toHaveValue('Beta newer unsaved proposal.');
    await page.unroute(pattern);
    await page.reload();
    await expect(page.getByLabel('Suggested replacement', { exact: true })).toHaveValue('Beta newer unsaved proposal.');
    await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue(explanation);
    await expect(thread).toHaveCount(1);
  } finally { release(); }
});
