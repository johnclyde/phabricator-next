import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import type { RevisionReviewerAction, RevisionReviewerSnapshot } from '../shared/revision-reviewers';
import { prepareReviewerDraft } from '../client/revision-reviewers';
import { authAccounts } from './auth-fixture';
export const reviewerBase = normalizeBasePath(process.env.APP_BASE_PATH);
export const reviewerPanel = (page: Page) => page.getByRole('region', { name: 'Reviewers', exact: true });
export const reviewerEditor = (page: Page) => reviewerPanel(page).getByRole('region', { name: 'Reviewer action draft', exact: true });
export async function reviewerApi<T>(page: Page, path: string, body?: unknown, method = 'POST'): Promise<T> {
  return page.evaluate(async ({ base, path, body, method }) => { const session = await (await fetch(`${base}api/session`)).json(); const response = await fetch(`${base}api${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { base: reviewerBase, path, body, method });
}
export async function reviewerSignIn(browser: Browser, info: TestInfo, index = 0) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:4312${reviewerBase}`, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const page = await context.newPage(); await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); return { context, page };
}
export async function reviewerAction(page: Page, id: string, action: RevisionReviewerAction, reviewerId?: string) { const snapshot = await reviewerApi<RevisionReviewerSnapshot>(page, `/revisions/${id}/reviewers`); return reviewerApi(page, `/revisions/${id}/reviewers`, prepareReviewerDraft(snapshot, action, reviewerId)); }
export async function confirmReviewer(page: Page, message = 'Exact human review decision') { await reviewerEditor(page).getByLabel('Reviewer message').fill(message); await reviewerEditor(page).getByRole('button', { name: 'Confirm Reviewer Action', exact: true }).click(); }
export async function selectReviewerAction(page: Page, label: string, message?: string) { await reviewerPanel(page).getByRole('button', { name: label, exact: true }).click(); await confirmReviewer(page, message); }
export async function reviewerExport(page: Page, label: string) { const download = page.waitForEvent('download'); await reviewerPanel(page).getByRole('button', { name: label, exact: true }).click(); const chunks: Buffer[] = []; for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
