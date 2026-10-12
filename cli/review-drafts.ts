import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isRevisionId } from '../shared/revision-dependencies';
import { REVIEW_DRAFT_LIMITS, isReviewDraftId, isReviewDraftSnapshot, isReviewDraftPreview, reviewDraftSaveInput, reviewDraftDiscardInput, reviewDraftPublishInput, reviewDraftPayload, reviewDraftRequestCanonical, validReviewDraftResult, type ReviewDraftDiscovery, type ReviewDraftInput, type ReviewDraftOperationKind, type ReviewDraftPayload, type ReviewDraftPreview, type ReviewDraftSnapshot } from '../shared/review-drafts';
import type { ReviewComment } from '../shared/types';

const commands = new Set(['review-drafts', 'preview-review-drafts', 'save-review-draft', 'discard-review-draft', 'publish-review-drafts']);
const maximumBytes = 2 * 1024 * 1024;
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(key => expected.includes(key));
const natural = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown, max = 240): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);

async function readIntent(path: string): Promise<Record<string, unknown>> {
  if (path !== '-') return readRequestIntent(path, 'Private review request', maximumBytes);
  if (process.stdin.isTTY) throw new Error('Pipe one exact UTF-8 JSON request to --intent -, or provide a regular request file.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.length; if (size > maximumBytes) throw new Error(`Private review stdin exceeds ${maximumBytes} bytes.`); chunks.push(bytes); }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  if (!object(value)) throw new Error('Private review stdin must contain one JSON object.');
  return value;
}
function verifiedSnapshot(value: unknown, id: string, preview = false): value is ReviewDraftSnapshot | ReviewDraftPreview {
  if (!(preview ? isReviewDraftPreview(value, id) : isReviewDraftSnapshot(value, id))) return false;
  const snapshot = value as ReviewDraftSnapshot;
  if (snapshot.entries.some(entry => entry.payloadSha256 !== hash(JSON.stringify(reviewDraftPayload(entry.payload))))) return false;
  if (preview) {
    const manifest = (value as ReviewDraftPreview).manifest, replies = new Set<string>();
    for (const entry of snapshot.entries) {
      const p = entry.payload, versionId = p.kind === 'reply' ? p.viewedVersionId : p.versionId, contentHash = p.kind === 'reply' ? p.viewedContentHash : p.contentHash;
      if (!manifest.sources.some(pin => pin.versionId === versionId && pin.contentHash === contentHash)) return false;
      if (p.kind === 'reply') replies.add(p.threadId);
    }
    if (manifest.threads.length !== replies.size || manifest.threads.some(pin => !replies.has(pin.threadId))) return false;
  }
  return true;
}
function discovery(value: unknown, count: number, after?: string): value is ReviewDraftDiscovery {
  if (!object(value) || !keys(value, ['principalId', 'items', 'nextAfter', 'accessEpoch']) || !text(value.principalId) || !natural(value.accessEpoch) || !Array.isArray(value.items) || value.items.length > count || !(value.nextAfter === null || isRevisionId(value.nextAfter))) return false;
  let last = after ?? '';
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['revisionId', 'title', 'setVersion', 'entryCount', 'updatedAt']) || !isRevisionId(item.revisionId) || item.revisionId <= last || !text(item.title, 1000) || !natural(item.setVersion, 1) || !natural(item.entryCount, 1) || item.entryCount > REVIEW_DRAFT_LIMITS.entries || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) return false;
    last = item.revisionId;
  }
  return value.nextAfter === null || value.items.length === count && value.nextAfter === last;
}
/** A full preview file lets terminal recovery verify the literal reviewed prose
 * as well as the request digest. Root anchors are checked against supplied pins;
 * the server additionally verifies original reply targets and immutable source. */
function publishedMatches(payload: ReviewDraftPayload, comment: ReviewComment): boolean {
  if (comment.body !== payload.body) return false;
  if (payload.kind === 'reply') return comment.threadId === payload.threadId && comment.viewedVersionId === payload.viewedVersionId && comment.suggestion === undefined;
  if (comment.versionId !== payload.versionId || comment.threadId !== comment.id || comment.viewedVersionId !== undefined) return false;
  if (payload.kind === 'summary') return comment.filePath === null && comment.line === null && !comment.anchor && !comment.docxAnchor && !comment.suggestion;
  if (comment.filePath !== payload.filePath || payload.line !== null && comment.line !== payload.line || JSON.stringify(comment.suggestion) !== JSON.stringify(payload.suggestion)) return false;
  if (payload.passage) {
    const a = comment.anchor; if (!a || a.versionId !== payload.versionId || a.contentHash !== payload.contentHash || a.filePath !== payload.filePath || a.start !== payload.passage.start || a.end !== payload.passage.end || a.quote !== payload.passage.quote) return false;
  } else if (comment.anchor) return false;
  if (payload.docxPassage) {
    const a = comment.docxAnchor; if (!a || a.versionId !== payload.versionId || a.contentHash !== payload.contentHash || a.rangeId !== payload.docxPassage.rangeId || a.start !== payload.docxPassage.start || a.end !== payload.docxPassage.end || a.quote !== payload.docxPassage.quote) return false;
  } else if (comment.docxAnchor) return false;
  return Boolean(payload.passage) || comment.line === payload.line;
}
export async function reviewDraftsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const list = command === 'review-drafts' && args.length === 0;
  const kind: ReviewDraftOperationKind | null = command === 'save-review-draft' ? 'save' : command === 'discard-review-draft' ? 'discard' : command === 'publish-review-drafts' ? 'publish' : null;
  const allowed = ['server', 'json', 'help', ...(kind ? ['intent', 'request-id'] : list ? ['after', 'limit'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported private review draft options.');
  if (list) {
    const after = options.after, limit = options.limit;
    if (after !== undefined && !isRevisionId(after) || limit !== undefined && (typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit) || !natural(Number(limit), 1) || Number(limit) > REVIEW_DRAFT_LIMITS.discovery)) throw new Error('Use a revision ID for --after and --limit from 1 to 100.');
    const query = new URLSearchParams(); if (after !== undefined) query.set('after', after as string); if (limit !== undefined) query.set('limit', limit as string);
    const result = await request<unknown>(`/api/review-drafts${query.size ? `?${query}` : ''}`);
    if (!discovery(result, Number(limit ?? REVIEW_DRAFT_LIMITS.discovery), after as string | undefined)) throw new Error('The private draft discovery response does not match the requested page.');
    console.log(safeJson(result)); return true;
  }
  const id = args[0], entryId = kind === 'save' || kind === 'discard' ? args[1] : null;
  if (!isRevisionId(id) || args.length !== (entryId !== null ? 2 : 1) || entryId !== null && !isReviewDraftId(entryId)) throw new Error('Provide one revision ID, plus a stable UUID entry ID for save or discard.');
  const base = `/api/revisions/${id}/review-drafts`;
  if (!kind) {
    const preview = command === 'preview-review-drafts', result = await request<unknown>(`${base}${preview ? '/preview' : ''}`);
    if (!verifiedSnapshot(result, id, preview)) throw new Error('The private review response does not match its exact entries, source hashes or preview.');
    console.log(safeJson(result)); return true;
  }
  if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json or --intent - for one exact JSON request. Publication requires the complete saved preview JSON.');
  const requestId = options['request-id'] ?? randomUUID(); if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
  const supplied = await readIntent(options.intent); let preview: ReviewDraftPreview | undefined, input: ReviewDraftInput;
  if (kind === 'publish') {
    if (!verifiedSnapshot(supplied, id, true)) throw new Error('Publication requires the complete unchanged JSON from preview-review-drafts, including entries and manifest.');
    preview = supplied as unknown as ReviewDraftPreview; input = reviewDraftPublishInput({ manifest: preview.manifest });
  } else input = kind === 'save' ? reviewDraftSaveInput(supplied) : reviewDraftDiscardInput(supplied);
  const inputSha256 = hash(reviewDraftRequestCanonical(kind, entryId!, input)), path = kind === 'publish' ? `${base}/publish` : `${base}/${entryId}${kind === 'discard' ? '/discard' : ''}`;
  console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact JSON and request ID to retry an uncertain result explicitly. The command never refreshes pins or retries automatically.' }));
  const result = await request<unknown>(path, kind === 'save' ? 'PUT' : 'POST', input, requestId);
  if (!validReviewDraftResult(result, id, kind, input, entryId!, preview?.principalId) || result.inputSha256 !== inputSha256
    || result.kind !== 'publish' && result.entry.payloadSha256 !== hash(JSON.stringify(reviewDraftPayload(result.entry.payload)))) throw new Error('The private review receipt does not match the exact request. Retain its JSON and request ID for explicit recovery.');
  if (result.kind === 'publish' && (!preview || result.published.some((item, index) => { const entry = preview!.entries[index]; return !entry || !publishedMatches(entry.payload, item.comment); }))) throw new Error('The publication receipt does not match the complete reviewed text and anchors. Retain the preview and request ID for explicit recovery.');
  console.log(safeJson(result)); return true;
}
