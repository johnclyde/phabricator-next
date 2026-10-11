import { canonicalWikiPath, type WikiMoveInput, type WikiMovePreview, type WikiMoveReceipt, type WikiPathResult } from '../shared/wiki';
import type { WikiDetail, WikiDocument, WikiVersion } from '../shared/types';
import type { WikiLifecyclePins, WikiLifecycleReceipt } from '../shared/wiki';
export interface WikiAuthority { path: string; accessEpoch: number; ancestorIds: string[]; parentId: string | null }
export interface WikiMoveDraft { destinationPath: string; message: string; authorityIds?: string[]; editIds?: string[] }
export interface WikiMoveIntent { id: string; sourceId: string; input: WikiMoveInput; preview: WikiMovePreview; draft: WikiMoveDraft; authorityIds: string[]; editIds: string[] }
export function wikiHref(path: string): string { const canonical = canonicalWikiPath(path); return `#wiki/${canonical === '/' ? '' : canonical.split('/').map(encodeURIComponent).join('/')}`; }
export function wikiAuthority(result: WikiPathResult): WikiAuthority { const ancestorIds = result.hierarchy.ancestors.flatMap(item => item.document ? [item.document.id] : []); return { path: result.path, accessEpoch: result.accessEpoch, ancestorIds, parentId: result.hierarchy.ancestors.at(-1)?.document?.id || null }; }
export function wikiMoveReceiptMatches(receipt: WikiMoveReceipt, intent: WikiMoveIntent): boolean {
  return Boolean(receipt?.source?.id === intent.sourceId && receipt.source.version === intent.input.expectedVersion + 1 && receipt.source.location?.status === 'moved' && receipt.source.location.path === intent.preview.source.path && receipt.source.location.movedToId === receipt.destination?.id && receipt.destination.location?.status === 'active' && receipt.destination.location.path === intent.input.destinationPath && receipt.destination.version === intent.input.expectedDestinationVersion + 1 && (!intent.input.expectedDestinationId || receipt.destination.id === intent.input.expectedDestinationId) && receipt.sourceVersionId && receipt.destinationVersionId && receipt.operationId);
}
export interface WikiEditDraft { title: string; content: string; message: string; pins: WikiLifecyclePins; authorityIds: string[] }
export interface WikiActionIntent { id: string; documentId: string; kind: 'edit' | 'draft' | 'publish' | 'delete' | 'restore'; path: string; method: 'PUT' | 'POST'; body: WikiLifecyclePins & { title?: string; content?: string; slug?: string; message?: string; targetVersionId?: string; version?: number }; target?: Pick<WikiVersion, 'id' | 'number' | 'title' | 'content'>; draftKey: string; draft: unknown; authorityIds: string[] }
export function wikiPins(detail: WikiDetail): WikiLifecyclePins {
  const publication = detail.document.publication;
  if (!publication || detail.accessEpoch === undefined) throw new Error('Reload this document before preparing a change.');
  return { expectedVersion: publication.headVersion, expectedHeadVersionId: publication.headVersionId, expectedPublishedVersionId: publication.publishedVersionId, expectedPublicationRevision: publication.revision, expectedAccessEpoch: detail.accessEpoch };
}
export function wikiActionReceipt(receipt: WikiLifecycleReceipt | WikiDocument, intent: WikiActionIntent): WikiDocument | null {
  const document = 'document' in receipt ? receipt.document : receipt, publication = document.publication;
  if (document.id !== intent.documentId || !publication || publication.revision !== intent.body.expectedPublicationRevision + 1) return null;
  if ('transaction' in receipt) {
    const transaction = receipt.transaction, before = transaction.before?.publication;
    if (transaction.documentId !== intent.documentId || transaction.kind !== intent.kind || before?.revision !== intent.body.expectedPublicationRevision || before.headVersionId !== intent.body.expectedHeadVersionId || before.publishedVersionId !== intent.body.expectedPublishedVersionId || (['revision', 'headVersion', 'headVersionId', 'publishedVersion', 'publishedVersionId'] as const).some(key => transaction.after.publication[key] !== publication[key])) return null;
  }
  if (intent.kind === 'publish') return publication.headVersionId === intent.body.expectedHeadVersionId && publication.publishedVersionId === intent.body.targetVersionId && publication.headVersion === intent.body.expectedVersion ? document : null;
  if (publication.headVersion !== intent.body.expectedVersion + 1 || document.version !== publication.headVersion || publication.headVersionId === intent.body.expectedHeadVersionId) return null;
  if (intent.kind === 'draft') return publication.publishedVersionId === intent.body.expectedPublishedVersionId ? document : null;
  if (publication.publishedVersionId !== publication.headVersionId) return null;
  if (intent.kind === 'delete') return document.location?.status === 'deleted' && document.content === '' ? document : null;
  const target = intent.kind === 'restore' ? intent.target : intent.body;
  return document.location?.status === 'active' && document.title === target?.title && document.content === target?.content ? document : null;
}
