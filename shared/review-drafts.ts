import type { ActorAttribution, ReviewComment, SuggestedReplacement } from './types';
import { validateSuggestion } from './suggestions';
import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthorHead, type RevisionAuthorHead } from './revision-authorship';
import { isRevisionMetadataAttribution } from './revision-metadata';

export const REVIEW_DRAFT_LIMITS = { entries: 50, body: 20_000, totalCharacters: 250_000, discovery: 100 } as const;
export interface ReviewDraftPassage { start: number; end: number; quote: string }
export interface ReviewDraftDocxPassage extends ReviewDraftPassage { rangeId: string }
export type ReviewDraftPayload =
  | { kind: 'comment'; body: string; versionId: string; contentHash: string; filePath: string | null; line: number | null; passage?: ReviewDraftPassage; docxPassage?: ReviewDraftDocxPassage; suggestion?: SuggestedReplacement }
  | { kind: 'summary'; body: string; versionId: string; contentHash: string }
  | { kind: 'reply'; body: string; threadId: string; viewedVersionId: string; viewedContentHash: string };
export interface ReviewDraftEntry { id: string; revisionId: string; principalId: string; version: number; state: 'active' | 'discarded' | 'published'; payload: ReviewDraftPayload; payloadSha256: string; createdAt: string; updatedAt: string }
export interface ReviewDraftSnapshot { revisionId: string; principalId: string; setVersion: number; entries: ReviewDraftEntry[]; head: RevisionAuthorHead; accessEpoch: number }
export interface ReviewDraftManifest { expectedSetVersion: number; expectedHead: RevisionAuthorHead; expectedAccessEpoch: number; entries: { id: string; version: number; payloadSha256: string }[]; sources: { versionId: string; contentHash: string }[]; threads: { threadId: string; version: number }[] }
export interface ReviewDraftPreview extends ReviewDraftSnapshot { manifest: ReviewDraftManifest }
export interface ReviewDraftSaveInput { expectedEntryVersion: number; expectedAccessEpoch: number; payload: ReviewDraftPayload }
export interface ReviewDraftDiscardInput { expectedEntryVersion: number; expectedAccessEpoch: number }
export interface ReviewDraftPublishInput { manifest: ReviewDraftManifest }
export type ReviewDraftInput = ReviewDraftSaveInput | ReviewDraftDiscardInput | ReviewDraftPublishInput;
export type ReviewDraftOperationKind = 'save' | 'discard' | 'publish';
export interface ReviewDraftChangeReceipt { kind: 'save' | 'discard'; revisionId: string; principalId: string; operationId: string; inputSha256: string; entry: ReviewDraftEntry; setVersion: number; accessEpoch: number }
export interface ReviewDraftPublicationItem { draftId: string; draftVersion: number; payloadSha256: string; comment: ReviewComment }
export interface ReviewDraftPublicationReceipt { kind: 'publish'; revisionId: string; principalId: string; operationId: string; inputSha256: string; published: ReviewDraftPublicationItem[]; setVersion: number; createdAt: string; accessEpoch: number }
export type ReviewDraftReceipt = ReviewDraftChangeReceipt | ReviewDraftPublicationReceipt;
export interface ReviewDraftDiscoveryItem { revisionId: string; title: string; setVersion: number; entryCount: number; updatedAt: string }
export interface ReviewDraftDiscovery { principalId: string; items: ReviewDraftDiscoveryItem[]; nextAfter: string | null; accessEpoch: number }
export interface ReviewDraftOperation { id: string; revisionId: string; principalId: string; kind: ReviewDraftOperationKind; entryId: string | null; input: ReviewDraftInput; inputSha256: string; retryKeySha256: string; attribution: ActorAttribution; receipt: ReviewDraftReceipt }

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const identifier = (v: unknown): v is string => text(v, 100) && v.length > 0;
const principal = (v: unknown): v is string => text(v, 240) && v.length > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const isReviewDraftId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function fail(): never { throw new Error('Provide a complete private review draft with exact versions, source hashes and access pins.'); }
function passage(v: unknown, docx = false): ReviewDraftPassage | ReviewDraftDocxPassage {
  if (!object(v) || !keys(v, ['start', 'end', 'quote', ...(docx ? ['rangeId'] : [])]) || !integer(v.start) || !integer(v.end) || v.end <= v.start || !text(v.quote, REVIEW_DRAFT_LIMITS.body) || !v.quote.length || v.quote.length !== v.end - v.start || docx && !identifier(v.rangeId)) return fail();
  return { ...(docx ? { rangeId: v.rangeId as string } : {}), start: v.start, end: v.end, quote: v.quote };
}
/** Canonical key order; submitted prose and whitespace are never normalized. */
export function reviewDraftPayload(v: unknown): ReviewDraftPayload {
  if (!object(v) || !text(v.body, REVIEW_DRAFT_LIMITS.body) || !v.body.trim()) return fail();
  if (v.kind === 'reply') {
    if (!keys(v, ['kind', 'body', 'threadId', 'viewedVersionId', 'viewedContentHash']) || !identifier(v.threadId) || !identifier(v.viewedVersionId) || !hash(v.viewedContentHash)) return fail();
    return { kind: 'reply', body: v.body, threadId: v.threadId, viewedVersionId: v.viewedVersionId, viewedContentHash: v.viewedContentHash };
  }
  if (!identifier(v.versionId) || !hash(v.contentHash)) return fail();
  if (v.kind === 'summary') {
    if (!keys(v, ['kind', 'body', 'versionId', 'contentHash'])) return fail();
    return { kind: 'summary', body: v.body, versionId: v.versionId, contentHash: v.contentHash };
  }
  if (v.kind !== 'comment' || !keys(v, ['kind', 'body', 'versionId', 'contentHash', 'filePath', 'line'], ['passage', 'docxPassage', 'suggestion']) || !(v.filePath === null || text(v.filePath, 240) && v.filePath.length > 0) || !(v.line === null || integer(v.line, 1))) return fail();
  const p = v.passage === undefined ? undefined : passage(v.passage) as ReviewDraftPassage;
  const d = v.docxPassage === undefined ? undefined : passage(v.docxPassage, true) as ReviewDraftDocxPassage;
  if (d && (v.filePath !== null || v.line !== null || p || v.suggestion !== undefined) || p && !v.filePath || v.line !== null && !v.filePath) return fail();
  let suggestion: SuggestedReplacement | undefined;
  if (v.suggestion !== undefined) {
    if (!p) return fail();
    try { suggestion = validateSuggestion(p, v.suggestion as SuggestedReplacement, v.body); } catch { return fail(); }
    const edits = [{ filePath: v.filePath, ...p }, ...(suggestion.additionalEdits ?? []).map(edit => edit.anchor)];
    if (suggestion.additionalEdits?.some(edit => edit.anchor.versionId !== v.versionId || edit.anchor.contentHash !== v.contentHash)) return fail();
    const byFile = new Map<string | null, typeof edits>();
    for (const edit of edits) {
      const ranges = byFile.get(edit.filePath) ?? [];
      ranges.push(edit);
      byFile.set(edit.filePath, ranges);
    }
    for (const ranges of byFile.values()) {
      ranges.sort((left, right) => left.start - right.start);
      for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) return fail();
    }
  }
  return { kind: 'comment', body: v.body, versionId: v.versionId, contentHash: v.contentHash, filePath: v.filePath, line: v.line, ...(p ? { passage: p } : {}), ...(d ? { docxPassage: d } : {}), ...(suggestion ? { suggestion } : {}) };
}
export function reviewDraftSaveInput(v: unknown): ReviewDraftSaveInput {
  if (!object(v) || !keys(v, ['expectedEntryVersion', 'expectedAccessEpoch', 'payload']) || !integer(v.expectedEntryVersion) || !integer(v.expectedAccessEpoch)) return fail();
  return { expectedEntryVersion: v.expectedEntryVersion, expectedAccessEpoch: v.expectedAccessEpoch, payload: reviewDraftPayload(v.payload) };
}
export function reviewDraftDiscardInput(v: unknown): ReviewDraftDiscardInput {
  if (!object(v) || !keys(v, ['expectedEntryVersion', 'expectedAccessEpoch']) || !integer(v.expectedEntryVersion, 1) || !integer(v.expectedAccessEpoch)) return fail();
  return { expectedEntryVersion: v.expectedEntryVersion, expectedAccessEpoch: v.expectedAccessEpoch };
}
export function reviewDraftManifest(v: unknown): ReviewDraftManifest {
  if (!object(v) || !keys(v, ['expectedSetVersion', 'expectedHead', 'expectedAccessEpoch', 'entries', 'sources', 'threads']) || !integer(v.expectedSetVersion) || !isRevisionAuthorHead(v.expectedHead) || !integer(v.expectedAccessEpoch) || !Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > REVIEW_DRAFT_LIMITS.entries || !Array.isArray(v.sources) || v.sources.length < 1 || v.sources.length > REVIEW_DRAFT_LIMITS.entries * 2 || !Array.isArray(v.threads) || v.threads.length > REVIEW_DRAFT_LIMITS.entries) return fail();
  const entries = v.entries.map(e => { if (!object(e) || !keys(e, ['id', 'version', 'payloadSha256']) || !isReviewDraftId(e.id) || !integer(e.version, 1) || !hash(e.payloadSha256)) return fail(); return { id: e.id, version: e.version, payloadSha256: e.payloadSha256 }; });
  const sources = v.sources.map(e => { if (!object(e) || !keys(e, ['versionId', 'contentHash']) || !identifier(e.versionId) || !hash(e.contentHash)) return fail(); return { versionId: e.versionId, contentHash: e.contentHash }; });
  const threads = v.threads.map(e => { if (!object(e) || !keys(e, ['threadId', 'version']) || !identifier(e.threadId) || !integer(e.version, 1)) return fail(); return { threadId: e.threadId, version: e.version }; });
  if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(sources.map(e => e.versionId)).size !== sources.length || new Set(threads.map(e => e.threadId)).size !== threads.length) return fail();
  return { expectedSetVersion: v.expectedSetVersion, expectedHead: { versionId: v.expectedHead.versionId, number: v.expectedHead.number, contentHash: v.expectedHead.contentHash }, expectedAccessEpoch: v.expectedAccessEpoch, entries, sources, threads };
}
export function reviewDraftPublishInput(v: unknown): ReviewDraftPublishInput { if (!object(v) || !keys(v, ['manifest'])) return fail(); return { manifest: reviewDraftManifest(v.manifest) }; }
export function reviewDraftRequestCanonical(kind: ReviewDraftOperationKind, entryId: string | null, input: unknown): string {
  if (kind === 'publish' ? entryId !== null : !isReviewDraftId(entryId)) return fail();
  const parsed = kind === 'save' ? reviewDraftSaveInput(input) : kind === 'discard' ? reviewDraftDiscardInput(input) : kind === 'publish' ? reviewDraftPublishInput(input) : fail();
  return JSON.stringify({ kind, entryId, input: parsed });
}
export function isReviewDraftEntry(v: unknown, revisionId?: string, principalId?: string): v is ReviewDraftEntry {
  if (!object(v) || !keys(v, ['id', 'revisionId', 'principalId', 'version', 'state', 'payload', 'payloadSha256', 'createdAt', 'updatedAt']) || !isReviewDraftId(v.id) || !isRevisionId(v.revisionId) || revisionId !== undefined && revisionId !== v.revisionId || !principal(v.principalId) || principalId !== undefined && principalId !== v.principalId || !integer(v.version, 1) || !['active', 'discarded', 'published'].includes(String(v.state)) || !hash(v.payloadSha256) || !date(v.createdAt) || !date(v.updatedAt)) return false;
  try { reviewDraftPayload(v.payload); return true; } catch { return false; }
}
export function isReviewDraftSnapshot(v: unknown, revisionId: string, principalId?: string): v is ReviewDraftSnapshot {
  if (!object(v) || !keys(v, ['revisionId', 'principalId', 'setVersion', 'entries', 'head', 'accessEpoch'], ['manifest']) || v.revisionId !== revisionId || !principal(v.principalId) || principalId !== undefined && v.principalId !== principalId || !integer(v.setVersion) || !integer(v.accessEpoch) || !isRevisionAuthorHead(v.head) || !Array.isArray(v.entries) || v.entries.length > REVIEW_DRAFT_LIMITS.entries) return false;
  return v.entries.every(e => isReviewDraftEntry(e, revisionId, v.principalId as string) && e.state === 'active') && new Set(v.entries.map(e => (e as ReviewDraftEntry).id)).size === v.entries.length;
}
export function isReviewDraftPreview(v: unknown, revisionId: string, principalId?: string): v is ReviewDraftPreview {
  if (!isReviewDraftSnapshot(v, revisionId, principalId)) return false;
  try { const m = reviewDraftManifest((v as ReviewDraftPreview).manifest); return m.expectedSetVersion === v.setVersion && m.expectedAccessEpoch === v.accessEpoch && JSON.stringify(m.expectedHead) === JSON.stringify(v.head) && JSON.stringify(m.entries) === JSON.stringify(v.entries.map(e => ({ id: e.id, version: e.version, payloadSha256: e.payloadSha256 }))); } catch { return false; }
}
export function isReviewDraftReceipt(v: unknown, revisionId?: string, principalId?: string): v is ReviewDraftReceipt {
  if (!object(v) || !isRevisionId(v.revisionId) || revisionId !== undefined && revisionId !== v.revisionId || !principal(v.principalId) || principalId !== undefined && principalId !== v.principalId || !isReviewDraftId(v.operationId) || !hash(v.inputSha256) || !integer(v.setVersion, 1) || !integer(v.accessEpoch)) return false;
  const common = ['kind', 'revisionId', 'principalId', 'operationId', 'inputSha256', 'setVersion', 'accessEpoch'];
  if (v.kind === 'save' || v.kind === 'discard') return keys(v, [...common, 'entry']) && isReviewDraftEntry(v.entry, v.revisionId, v.principalId) && v.entry.state === (v.kind === 'save' ? 'active' : 'discarded');
  if (v.kind !== 'publish' || !keys(v, [...common, 'published', 'createdAt']) || !date(v.createdAt) || !Array.isArray(v.published) || !v.published.length || v.published.length > REVIEW_DRAFT_LIMITS.entries) return false;
  return v.published.every(e => object(e) && keys(e, ['draftId', 'draftVersion', 'payloadSha256', 'comment']) && isReviewDraftId(e.draftId) && integer(e.draftVersion, 1) && hash(e.payloadSha256) && object(e.comment) && identifier(e.comment.id) && e.comment.revisionId === v.revisionId && text(e.comment.body, REVIEW_DRAFT_LIMITS.body) && isRevisionMetadataAttribution(e.comment.attribution) && e.comment.attribution.principalId === v.principalId) && new Set(v.published.map(e => (e as ReviewDraftPublicationItem).draftId)).size === v.published.length && new Set(v.published.map(e => (e as ReviewDraftPublicationItem).comment.id)).size === v.published.length;
}
export function validReviewDraftResult(v: unknown, revisionId: string, kind: ReviewDraftOperationKind, input: ReviewDraftInput, entryId: string | null, principalId?: string): v is ReviewDraftReceipt {
  if (!isReviewDraftReceipt(v, revisionId, principalId) || v.kind !== kind) return false;
  if (v.kind === 'publish') { const request = input as ReviewDraftPublishInput; return v.setVersion === request.manifest.expectedSetVersion + 1 && JSON.stringify(v.published.map(e => ({ id: e.draftId, version: e.draftVersion, payloadSha256: e.payloadSha256 }))) === JSON.stringify(request.manifest.entries); }
  const request = input as ReviewDraftSaveInput | ReviewDraftDiscardInput;
  return v.entry.id === entryId && v.entry.version === request.expectedEntryVersion + 1 && (v.kind !== 'save' || JSON.stringify(v.entry.payload) === JSON.stringify((request as ReviewDraftSaveInput).payload));
}
