import { DOCX_LIMITS, type DocxFileIdentity, type DocxImportInput, type DocxReimportInput, type DocxReplaceInput, type DocxReplacement, type DocxSource, type DocxTextRange } from '../shared/docx';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import type { WorkspaceClient } from './offline';
import { applicationPath } from './mount';
import { assertSession, lockSession, RequestError } from './session';
import { digestBytes } from './file-client';
import { docxBatchInputCanonical, type DocxReplaceBatchInput } from '../shared/docx-batch';
import type { DocxResolveInput } from '../shared/docx-resolution';
export interface DocxIntent { id: string; path: string; body: DocxImportInput | DocxReimportInput | DocxReplaceInput | DocxReplaceBatchInput | DocxResolveInput; sourceFile: DocxFileIdentity; draftKey: string; draft: unknown; operationSha256?: string; base?: { id: string; number: number; contentHash: string; packageHash: string } }
export async function docxBatchDigest(input: DocxReplaceBatchInput): Promise<string> { return digestBytes(new TextEncoder().encode(docxBatchInputCanonical(input))); }
export const sameDocxFile = (a: DocxFileIdentity, b: DocxFileIdentity) => a.fileId === b.fileId && a.sha256 === b.sha256 && a.bytes === b.bytes;
function boundary(text: string, index: number): boolean { return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]!) && /[\uDC00-\uDFFF]/.test(text[index]!); }
export function docxReplacement(range: DocxTextRange, start: number, end: number, replacement: string): DocxReplacement {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > range.text.length || boundary(range.text, start) || boundary(range.text, end)) throw new Error('Select a nonempty passage within this text, without splitting a character.');
  const quote = range.text.slice(start, end);
  if (quote.length > DOCX_LIMITS.replacementLength || replacement.length > DOCX_LIMITS.replacementLength) throw new Error('Choose a passage and replacement of at most 20,000 characters.');
  if (/[\u0000-\u001F\uFFFE\uFFFF]/u.test(replacement) || /[\uD800-\uDFFF]/u.test(replacement)) throw new Error('Use one line of complete text without tabs, line breaks, or control characters.');
  if (replacement === quote) throw new Error('Change the replacement text before saving.');
  return { rangeId: range.id, start, end, quote, replacement };
}
export function docxReceiptVersion(detail: RevisionDetail, intent: DocxIntent): RevisionVersion | null {
  if (!detail || !/^L[1-9]\d*$/.test(detail.revision?.id) || !Array.isArray(detail.versions)) return null;
  const id = intent.path === '/api/revisions/docx' ? detail.revision.id : intent.path.split('/')[3];
  if (detail.revision.id !== id || detail.revision.kind !== 'document') return null;
  if (intent.base && !detail.versions.some(item => item.id === intent.base!.id && item.number === intent.base!.number && item.contentHash === intent.base!.contentHash && item.docx?.sha256 === intent.base!.packageHash)) return null;
  const version = detail.versions.find(item => item.revisionId === id && item.number === (intent.base ? intent.base.number + 1 : 1));
  if (!version?.docx || !sameDocxFile(version.docx.sourceFile, intent.sourceFile) || !version.id || !version.contentHash) return null;
  if ('sourceFile' in intent.body && (version.docx.sha256 !== intent.body.sourceFile.sha256 || version.docx.bytes !== intent.body.sourceFile.bytes)) return null;
  if ('message' in intent.body && version.message !== intent.body.message) return null;
  if ('replacement' in intent.body && (!intent.base || version.docx.sha256 === intent.base.packageHash)) return null;
  if ('replacements' in intent.body && (!intent.base || version.docx.sha256 === intent.base.packageHash || !intent.operationSha256 || version.docxOperation?.kind !== 'replace-batch' || version.docxOperation.inputSha256 !== intent.operationSha256)) return null;
  if ('decisions' in intent.body && (!intent.base || version.docx.sha256 === intent.base.packageHash || !intent.operationSha256 || version.docxOperation?.kind !== 'resolve' || version.docxOperation.inputSha256 !== intent.operationSha256)) return null;
  return version;
}
/** Exact version bytes stay in session memory; no renderer or persistent store receives an API URL. */
export async function docxBytes(client: WorkspaceClient, revisionId: string, version: RevisionVersion & { docx: DocxSource }, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const session = client.session; assertSession(session); const epoch = session.accessEpoch;
  const dependencies = [revisionId, version.docx.sourceFile.fileId].map(id => ({ id, generation: session.objectGenerations.get(id) || 0 }));
  const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); session.controllers.add(controller); session.objectControllers.set(controller, revisionId);
  const verify = () => { assertSession(session); if (controller.signal.aborted || epoch !== session.accessEpoch || dependencies.some(item => client.unavailableObject(item.id) || item.generation !== (session.objectGenerations.get(item.id) || 0))) throw new RequestError('Document access changed. Reload before downloading.', 409, 'ACCESS_CHANGED'); };
  try {
    verify(); const response = await fetch(applicationPath(`/api/revisions/${revisionId}/docx/${encodeURIComponent(version.id)}/download`), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: session.state.sessionContext ? { 'X-Session-Context': session.state.sessionContext } : {} });
    if (response.status === 401) { lockSession('Your session ended. Sign in again.'); throw new RequestError('Your session ended.', 401); } verify();
    if (!response.ok) { const failure: unknown = await response.json().catch(() => null); const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : undefined; if (code === 'OBJECT_UNAVAILABLE') client.retireUnavailableObject(revisionId); if (code === 'DOCX_SOURCE_UNAVAILABLE') client.retireUnavailableObject(version.docx.sourceFile.fileId); throw new RequestError('This document version is unavailable. Reload to verify access.', response.status, code); }
    if (response.headers.get('X-Access-Epoch') !== String(epoch) || response.headers.get('X-Revision-Version-ID') !== version.id || response.headers.get('X-Content-Version') !== String(version.number) || response.headers.get('Content-Length') !== String(version.docx.bytes) || response.headers.get('X-Content-SHA256') !== version.docx.sha256 || version.docx.bytes > DOCX_LIMITS.compressedBytes) throw new Error('The download does not match the selected document version.');
    const bytes = new Uint8Array(version.docx.bytes), reader = response.body?.getReader(); let offset = 0;
    if (reader) try { while (true) { const item = await reader.read(); verify(); if (item.done) break; if (offset + item.value.length > bytes.length) { await reader.cancel(); throw new Error('The download exceeded its recorded size.'); } bytes.set(item.value, offset); offset += item.value.length; } } finally { reader.releaseLock(); }
    verify(); if (offset !== bytes.length || await digestBytes(bytes) !== version.docx.sha256) throw new Error('Document integrity verification failed.'); verify(); return bytes;
  } finally { controller.abort(); signal.removeEventListener('abort', abort); session.controllers.delete(controller); session.objectControllers.delete(controller); }
}

/** Use the same newest authorized snapshot as the visible Word capabilities. */
export function docxEditingEpoch(stateEpoch: number, detailEpoch: number | undefined, sessionEpoch: number | undefined): number | null {
  const epoch = Math.max(stateEpoch, detailEpoch ?? -1);
  return Number.isSafeInteger(epoch) && epoch > 0 && epoch === sessionEpoch ? epoch : null;
}
