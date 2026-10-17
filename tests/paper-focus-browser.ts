import { expect, type Page } from '@playwright/test';

type PaperToolGroup = 'Paper details' | 'Review and publishing' | 'AI edit proposals';

/** Open only the paper tools exercised by a test, as an explicit user action. */
export async function openPaperTools(page: Page, title: PaperToolGroup) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${title}$`) });
  await expect(summary).toBeVisible();
  const disclosure = summary.locator('..');
  if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);
}
