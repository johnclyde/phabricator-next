import { expect, type Page } from '@playwright/test';

/** Explicit user action; fixtures never open advanced controls by default. */
export async function openComparisonOptions(page: Page, word = false) {
  const disclosure = page.locator(word ? '.docx-comparison-options' : '.comparison-options');
  await expect(disclosure).toHaveCount(1);
  if (!await disclosure.evaluate(node => (node as HTMLDetailsElement).open)) await disclosure.locator(':scope > summary').click();
  await expect(disclosure).toHaveJSProperty('open', true);
}
