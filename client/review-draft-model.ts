import { REVIEW_DRAFT_LIMITS, isReviewDraftId, isReviewDraftEntry, reviewDraftPayload, reviewDraftSaveInput, reviewDraftDiscardInput, reviewDraftPublishInput, type ReviewDraftEntry, type ReviewDraftInput, type ReviewDraftOperationKind, type ReviewDraftPayload } from '../shared/review-drafts';
import { validateSuggestionDraft } from '../shared/suggestions';
export interface EditDraft { id: string; expectedEntryVersion: number; payload: ReviewDraftPayload }
export interface Intent { id: string; revisionId: string; principalId: string; kind: ReviewDraftOperationKind; entryId: string | null; input: ReviewDraftInput; entries: ReviewDraftEntry[]; cleanup?: { key: string; value: unknown } }
export function intentValue(value: unknown, id: string, principalId: string): Intent | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Intent;
  if (!isReviewDraftId(row.id) || row.revisionId !== id || row.principalId !== principalId || !Array.isArray(row.entries) || row.entries.length > REVIEW_DRAFT_LIMITS.entries || !row.entries.every(entry => isReviewDraftEntry(entry, id, principalId)) || row.cleanup && (!row.cleanup || typeof row.cleanup !== 'object' || typeof row.cleanup.key !== 'string' || !row.cleanup.key.startsWith(`comment-source:${id}:`) && !row.cleanup.key.startsWith(`review-draft-edit:${id}:`) && row.cleanup.key !== `review-draft-summary:${id}`)) return null;
  try { if (row.kind === 'publish') { if (row.entryId !== null) return null; reviewDraftPublishInput(row.input); } else { if (!isReviewDraftId(row.entryId)) return null; if (row.kind === 'save') reviewDraftSaveInput(row.input); else if (row.kind === 'discard') reviewDraftDiscardInput(row.input); else return null; } return row; } catch { return null; }
}
export function editValue(value: unknown): EditDraft | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as EditDraft;
  if (!isReviewDraftId(row.id) || !Number.isSafeInteger(row.expectedEntryVersion) || row.expectedEntryVersion < 0 || !row.payload || typeof row.payload.body !== 'string' || row.payload.body.length > REVIEW_DRAFT_LIMITS.body) return null;
  try {
    const candidate = { ...row.payload, body: row.payload.body.trim() ? row.payload.body : 'Unfinished private draft' };
    if (candidate.kind === 'comment' && candidate.suggestion !== undefined) {
      const { suggestion, ...withoutSuggestion } = candidate;
      const parsed = reviewDraftPayload(withoutSuggestion);
      if (parsed.kind !== 'comment' || !parsed.passage || parsed.docxPassage) return null;
      // An editor can temporarily clear explanations or restore original text.
      // Retain those exact drafts without relaxing publication validation.
      validateSuggestionDraft(parsed.passage, suggestion, row.payload.body);
      if (suggestion.additionalEdits?.some(edit => edit.anchor.versionId !== parsed.versionId || edit.anchor.contentHash !== parsed.contentHash)) return null;
    } else reviewDraftPayload(candidate);
    return row;
  } catch { return null; }
}
