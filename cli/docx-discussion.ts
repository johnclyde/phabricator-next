import { createHash, randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PaperCLI } from './paper-builds';
import { readDocxIntent } from './docx';
import { sourceSnapshotCanonical } from '../shared/source-snapshot';
import { createDocxPassageAnchor, docxDiscussionBytes, validDocxDiscussionExport, validDocxPassageAnchor, DOCX_DISCUSSION_LIMITS, type DocxDiscussionExportInput, type DocxPassageInput } from '../shared/docx-discussion';
import type { RevisionDetail, ReviewComment } from '../shared/types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function docxDiscussionCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'comment-docx' && command !== 'export-docx-discussion') return false;
  const exporting = command === 'export-docx-discussion';
  if (optionNames.some(name => !['server', 'help', 'json', 'intent', ...(exporting ? ['output'] : ['request-id'])].includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique options for an explicit Word discussion request.');
  const id = args[0], intentPath = options.intent, output = options.output;
  if (args.length !== 1 || !id || !/^L[1-9]\d{0,14}$/.test(id) || typeof intentPath !== 'string' || !intentPath) throw new Error('Provide one Word revision such as L1 and --intent REQUEST.json.');
  if (exporting && (typeof output !== 'string' || !output || output === '-' || output.includes('\0'))) throw new Error('--output must name a new local file.');
  const input = await readDocxIntent(intentPath);
  const keys = exporting ? ['versionId', 'contentHash', 'expectedAccessEpoch', 'threads'] : ['versionId', 'body', 'docxPassage'];
  if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.versionId !== 'string' || !input.versionId || input.versionId.length > 100) throw new Error('The Word discussion request must identify one exact source version and supported fields.');
  if (exporting) {
    if (typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash) || !Number.isSafeInteger(input.expectedAccessEpoch) || Number(input.expectedAccessEpoch) < 0 || !Array.isArray(input.threads) || !input.threads.length || input.threads.length > DOCX_DISCUSSION_LIMITS.threads) throw new Error('Export requires exact content/access pins and 1–64 selected threads.');
    for (const pin of input.threads as unknown[]) if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).some(key => !['threadId', 'expectedThreadVersion'].includes(key)) || !('threadId' in pin) || typeof pin.threadId !== 'string' || !pin.threadId || pin.threadId.length > 100 || !('expectedThreadVersion' in pin) || !Number.isSafeInteger(pin.expectedThreadVersion) || Number(pin.expectedThreadVersion) < 1) throw new Error('Every selected thread requires its exact version.');
    if (new Set((input.threads as { threadId: string }[]).map(pin => pin.threadId)).size !== input.threads.length) throw new Error('Select each thread only once.');
  } else {
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 20_000 || !input.docxPassage || typeof input.docxPassage !== 'object' || Array.isArray(input.docxPassage) || Object.keys(input.docxPassage).some(key => !['rangeId', 'start', 'end', 'quote'].includes(key))) throw new Error('A Word comment needs a body and exact docxPassage.');
  }
  const requestId = exporting ? undefined : options['request-id'] ?? randomUUID();
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId))) throw new Error('Invalid --request-id.');
  const detail = await request<RevisionDetail>(`/api/revisions/${id}`);
  const version = detail.versions?.find(value => value.id === input.versionId);
  if (detail.revision?.id !== id || !version?.docx || version.revisionId !== id || version.contentHash !== hash(sourceSnapshotCanonical(version.files, version.assets, version.docx))) throw new Error('The original Word snapshot could not be verified.');
  if (!exporting) {
    const anchor = createDocxPassageAnchor(version, input.docxPassage as DocxPassageInput);
    const path = `/api/revisions/${id}/comments`;
    console.error(safeJson({ path, requestId, intentPath, intentSha256: hash(JSON.stringify(input)), recovery: 'Retain the exact request file and ID for an uncertain-result retry.' }));
    const result = await request<ReviewComment>(path, 'POST', input, requestId as string);
    if (result.revisionId !== id || result.versionId !== version.id || !result.id || result.threadId !== result.id || result.body !== input.body || !result.docxAnchor || !validDocxPassageAnchor(result.docxAnchor, version) || result.docxAnchor.rangeId !== anchor.rangeId || result.docxAnchor.start !== anchor.start || result.docxAnchor.end !== anchor.end) throw new Error('The comment receipt did not match the retained request. Retry the same request to confirm its outcome.');
    console.log(safeJson({ revisionId: id, versionId: version.id, commentId: result.id, threadId: result.threadId, requestId }));
    return true;
  }
  if (version.contentHash !== input.contentHash) throw new Error('The selected Word content hash does not match.');
  const intent = input as unknown as DocxDiscussionExportInput;
  const response = await request<unknown>(`/api/revisions/${id}/docx/export-discussion`, 'POST', intent);
  const bytes = await docxDiscussionBytes(response, id, intent, version);
  if (!validDocxDiscussionExport(response, id, intent, version)) throw new Error('Invalid Word discussion export metadata.');
  const temporary = join(dirname(output as string), `.phabricator-word-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await link(temporary, output as string);
  } finally { await unlink(temporary); }
  console.log(safeJson({ revisionId: id, versionId: version.id, contentHash: version.contentHash, threads: response.threads, bytes: response.bytes, sha256: response.sha256, output }));
  return true;
}
