import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ZipFile } from 'yazl';
import { fromBufferPromise } from 'yauzl';
import type { AppState, RevisionDetail } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { AIProposalDetail, AIProposalList } from '../shared/ai-proposals';
import { reviewerApi as api } from './revision-reviewers-browser';

test.skip(process.env.E2E_AI_PROPOSALS_FIXTURE !== '1', 'Uses only the explicit synthetic proposal adapter, never a real provider.');
const panel = (page: Page) => page.getByRole('region', { name: 'AI edit proposals', exact: true });
const inspection = (page: Page) => panel(page).getByRole('region', { name: 'AI proposal inspection', exact: true });
async function generate(page: Page) {
  await panel(page).getByLabel('Editing instruction', { exact: true }).fill('Clarify rough wording while preserving claims.');
  await panel(page).getByRole('button', { name: 'Send to hosted AI and propose edits', exact: true }).click();
  await expect(inspection(page)).toContainText('Complete proposal:');
}
async function word(page: Page) {
  await page.goto('./#home');
  const input = await fromBufferPromise(await readFile('tests/fixtures/docx/roundtrip.docx')), output = new ZipFile(), chunks: Buffer[] = [];
  const bytesReady = new Promise<Buffer>((resolve, reject) => { output.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); output.outputStream.on('end', () => resolve(Buffer.concat(chunks))); output.outputStream.on('error', reject); });
  try {
    for await (const entry of input.eachEntry()) {
      const pieces: Buffer[] = []; for await (const chunk of await input.openReadStreamPromise(entry)) pieces.push(Buffer.from(chunk));
      let bytes = Buffer.concat(pieces);
      if (entry.fileName === 'word/document.xml') bytes = Buffer.from(bytes.toString().replace('<w:body>', '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>First ro</w:t></w:r><w:r><w:t>ugh argument.</w:t></w:r></w:p><w:p><w:r><w:t>Second rough argument.</w:t></w:r></w:p>'));
      output.addBuffer(bytes, entry.fileName);
    }
  } finally { input.close(); }
  output.end(); const bytes = await bytesReady;
  const file = await api<FileRecord>(page, '/files', { name: 'ai-argument.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') });
  const state = await api<AppState>(page, '/state');
  return api<RevisionDetail>(page, '/revisions/docx', { title: 'Word AI proposal', testPlan: 'Inspect complete proposal and tracked package.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: state.accessEpoch, shareSource: false });
}
async function installSpeech(page: Page) {
  await page.addInitScript(() => {
    const state = { active: '', texts: [] as string[], cancels: 0 };
    Object.assign(window, { aiSpeech: state, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US' }], addEventListener() {}, removeEventListener() {}, cancel() { state.active = ''; state.cancels++; }, speak(utterance: { text: string }) { state.active = utterance.text; state.texts.push(utterance.text); } } });
  });
}
async function command(page: Page, value: string) {
  await page.getByLabel('Workspace command', { exact: true }).fill(value); await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const speech = (page: Page) => page.evaluate(() => (window as unknown as { aiSpeech: { active: string } }).aiSpeech.active);

test('Word AI proposals disclose supported paragraphs and save cross-run edits in one tracked package', async ({ page }, info) => {
  const before = await word(page), id = before.revision.id;
  await page.goto(`./#${id}`); await expect(panel(page)).toContainText('supported main-document Word paragraphs');
  await expect(panel(page)).toContainText('The original Word package, unsupported paragraphs, notes, imported comments, images, and other attachments are excluded.');
  await generate(page); await expect(inspection(page)).toContainText('Complete proposal: 2 edits.');
  await expect(inspection(page).getByRole('article', { name: 'AI edit 1', exact: true })).toContainText('Word paragraph 1');
  await expect(inspection(page).locator('.suggestion-original')).toHaveText(['rough', 'rough']);
  const list = await api<AIProposalList>(page, `/revisions/${id}/ai-proposals`), proposal = await api<AIProposalDetail>(page, `/revisions/${id}/ai-proposals/${list.items[0]!.id}`);
  expect(proposal.proposal.result!.edits.map(edit => edit.anchor.filePath)).toEqual(['docx/paragraph-1.txt', 'docx/paragraph-2.txt']);
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
  const apply = inspection(page).getByRole('button', { name: 'Apply all 2 edits as one version', exact: true }); await apply.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await inspection(page).screenshot({ path: info.outputPath('word-ai-proposal.png') });
  await apply.click(); await expect.poll(async () => (await api<RevisionDetail>(page, `/revisions/${id}`)).versions.length).toBe(2);
  const after = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(after.versions[0]).toEqual(before.versions[0]); expect(after.versions[1]!.docx!.projection.changes.filter(change => change.kind === 'ins' && change.text === 'clear')).toHaveLength(2);
  expect(after.versions[1]!.docx!.sha256).not.toBe(before.versions[0]!.docx!.sha256); expect(after.reviews).toEqual([]);
});

test('voice reviews every proposal page, dictates only an instruction, and requires current prepare then confirm', async ({ page }) => {
  await installSpeech(page); await page.goto('./#home');
  const created = await api<RevisionDetail>(page, '/revisions', { title: 'Voice AI review', kind: 'paper', testPlan: 'Review exact AI edits by voice.', files: [{ path: 'argument.tex', content: Array.from({ length: 12 }, (_, index) => `Claim ${index + 1} has rough wording.`).join('\n') }] }), id = created.revision.id;
  const writes: string[] = []; page.on('request', request => { if (request.method() === 'POST' && request.url().includes(`/revisions/${id}/ai-proposals`)) writes.push(request.url()); });
  await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await command(page, 'set AI instruction to Confirm AI proposal! Keep citations.');
  await expect(panel(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Confirm AI proposal! Keep citations.'); expect(writes).toHaveLength(0);
  await command(page, 'confirm AI proposal'); expect(writes).toHaveLength(0);
  await generate(page); expect(writes).toHaveLength(1);
  await command(page, 'read AI edit'); expect(await speech(page)).toContain('Edit 1 of 12');
  await command(page, 'read AI explanation'); expect(await speech(page)).toContain('Explanation:');
  for (let index = 0; index < 11; index++) await command(page, 'next AI edit');
  await expect(inspection(page).getByRole('article', { name: 'AI edit 12', exact: true })).toHaveAttribute('aria-current', 'true'); expect(await speech(page)).toContain('Edit 12 of 12');
  await command(page, 'previous AI edit'); expect(await speech(page)).toContain('Edit 11 of 12');
  await command(page, 'prepare AI proposal'); expect(await speech(page)).toContain('Prepared all 12 edits'); expect(writes).toHaveLength(1);
  await command(page, 'cancel AI proposal'); await command(page, 'confirm AI proposal'); expect(writes).toHaveLength(1);
  await command(page, 'prepare AI proposal');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect.poll(() => speech(page)).toBe(''); await command(page, 'confirm AI proposal'); expect(writes).toHaveLength(1);
  await panel(page).getByRole('button', { name: 'Inspect proposal', exact: true }).click(); await expect(inspection(page)).toContainText('Complete proposal: 12 edits.');
  await command(page, 'prepare AI proposal'); await command(page, 'confirm AI proposal');
  await expect.poll(async () => (await api<RevisionDetail>(page, `/revisions/${id}`)).versions.length).toBe(2); expect(writes).toHaveLength(2);
});

test('offline retirement stops private proposal speech and cancels prepared application without reconnect replay', async ({ page, context }) => {
  await installSpeech(page); await page.goto('./#home');
  const created = await api<RevisionDetail>(page, '/revisions', { title: 'Offline AI voice', kind: 'document', testPlan: 'Retire private speech and confirmation.', files: [{ path: 'draft.md', content: 'A rough claim.' }] }), id = created.revision.id;
  await page.goto(`./#${id}`); await generate(page); await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await command(page, 'prepare AI proposal'); expect(await speech(page)).toContain('Prepared all 1 edits');
  await context.setOffline(true); await expect.poll(() => speech(page)).toBe('');
  await context.setOffline(false); await expect(panel(page).getByRole('button', { name: 'Refresh proposals', exact: true })).toBeEnabled();
  await command(page, 'confirm AI proposal');
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toHaveLength(1);
});
