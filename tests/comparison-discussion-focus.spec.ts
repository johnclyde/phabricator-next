import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { RevisionDetail, ReviewComment } from '../shared/types';
import { openComparisonOptions } from './comparison-ui';
import { reviewerApi as api } from './revision-reviewers-browser';

interface HeldThreadFocus { callbacks: FrameRequestCallback[]; scrolls: number; restore: () => void }
async function fixture(page: Page) {
  await page.goto('./#home');
  const source = 'First observation.\n\nThe old argument.\n\nFinal conclusion.\n';
  const created = await api<RevisionDetail>(page, '/revisions', {
    title: `Inline discussion focus ${randomUUID()}`, kind: 'document',
    testPlan: 'Delay inline discussion focus while changing the immutable comparison; preserve source and discussion.',
    files: [{ path: 'motion.md', content: source }, { path: 'other.md', content: 'An unchanged other file.\n' }],
  });
  const original = created.versions[0]!, quote = 'old', start = source.indexOf(quote);
  const comment = await api<ReviewComment>(page, `/revisions/${created.revision.id}/comments`, {
    body: 'Keep this discussion attached to its original source.', versionId: original.id,
    filePath: 'motion.md', passage: { start, end: start + quote.length, quote },
  });
  await api(page, `/revisions/${created.revision.id}/versions`, { expectedVersion: 1, message: 'Change one argument', files: [{ path: 'motion.md', content: source.replace('old', 'new') }, { path: 'other.md', content: 'An unchanged other file.\n' }] });
  const detail = await api<RevisionDetail>(page, `/revisions/${created.revision.id}`);
  await page.goto(`./#${created.revision.id}`);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect(page.locator(`[data-comparison-thread-id="${comment.id}"]`)).toHaveCount(1);
  return { detail, comment };
}
async function holdFocus(page: Page) {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, scroll = Element.prototype.scrollIntoView;
    const held: HeldThreadFocus = { callbacks: [], scrolls: 0, restore: () => { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; Element.prototype.scrollIntoView = scroll; } };
    (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus = held;
    window.requestAnimationFrame = callback => { held.callbacks.push(callback); return held.callbacks.length; };
    window.cancelAnimationFrame = () => {}; // A cancellation can lose a race with an already queued callback.
    Element.prototype.scrollIntoView = function (...args) { if (this.matches('.review-thread')) held.scrolls++; else scroll.apply(this, args); };
  });
}
async function flushFocus(page: Page) {
  await page.evaluate(() => {
    const held = (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus;
    for (const callback of held.callbacks.splice(0)) callback(performance.now());
  });
}
async function restoreFocus(page: Page) { await page.evaluate(() => (window as unknown as { inlineThreadFocus?: HeldThreadFocus }).inlineThreadFocus?.restore()); }

test('inline discussion autofocus retires after file, base or mode changes with the same target version', async ({ page }) => {
  const { detail, comment } = await fixture(page), id = detail.revision.id;
  const thread = page.locator(`.review-thread[data-thread-id="${comment.id}"]`);
  for (const change of ['file', 'base', 'mode'] as const) {
    await page.getByLabel('Source file', { exact: true }).selectOption('motion.md');
    await page.getByLabel('Base version', { exact: true }).selectOption('1');
    await openComparisonOptions(page); await page.getByLabel('Comparison mode', { exact: true }).selectOption('words');
    await expect(page.locator(`[data-comparison-thread-id="${comment.id}"]`)).toHaveCount(1);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await holdFocus(page);
    try {
      // DOM clicks avoid holding Playwright's actionability animation frames.
      await page.locator(`[data-comparison-thread-id="${comment.id}"]`).getByRole('button', { name: 'Open discussion', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await expect.poll(() => page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.callbacks.length)).toBeGreaterThan(0);
      const control = page.getByLabel(change === 'file' ? 'Source file' : change === 'base' ? 'Base version' : 'Comparison mode', { exact: true });
      const value = change === 'file' ? 'other.md' : change === 'base' ? '2' : 'lines';
      await control.selectOption(value); await expect(control).toHaveValue(value);
      await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
      await flushFocus(page);
      expect(await page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.scrolls)).toBe(0);
      await expect(thread).not.toBeFocused();
    } finally { await restoreFocus(page); }
    // Retiring an inline request must not disable ordinary discussion keyboard focus.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('n'); await expect(thread).toBeFocused();
  }
  const after = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual(detail.comments);
  expect(after.threads).toEqual(detail.threads); expect(after.threadEvents).toEqual(detail.threadEvents);
});

test('a newer inline focus request replaces a queued request even if frame cancellation races', async ({ page }) => {
  const { comment } = await fixture(page);
  const open = page.locator(`[data-comparison-thread-id="${comment.id}"]`).getByRole('button', { name: 'Open discussion', exact: true });
  await holdFocus(page);
  try {
    await open.evaluate(element => (element as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.callbacks.length)).toBeGreaterThan(0);
    const firstCount = await page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.callbacks.length);
    await open.evaluate(element => (element as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.callbacks.length)).toBeGreaterThan(firstCount);
    await flushFocus(page);
    expect(await page.evaluate(() => (window as unknown as { inlineThreadFocus: HeldThreadFocus }).inlineThreadFocus.scrolls)).toBe(1);
    await expect(page.locator(`.review-thread[data-thread-id="${comment.id}"]`)).toBeFocused();
  } finally { await restoreFocus(page); }
});
