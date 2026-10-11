import type { Audience } from './policy';
import type { WikiDocument } from './types';

export type WikiStatus = 'active' | 'moved' | 'deleted' | 'stub';
export interface WikiLocation { path: string; status: WikiStatus; movedToId: string | null }
export interface WikiReference { id: string; title: string; path: string; status: WikiStatus; version: number }
export interface WikiAncestor { path: string; document: WikiReference | null }
export interface WikiChildren { documents: WikiReference[]; missingPaths?: string[]; nextAfter: string | null }
export interface WikiHierarchy { ancestors: WikiAncestor[]; children: WikiChildren; movedTo: WikiReference | null }
export interface WikiPathResult { path: string; document: WikiReference | null; hierarchy: WikiHierarchy; canCreate: boolean; creationBlockedReason: string | null; defaultAccess: { spaceId: string; view: Audience; edit: Audience; interact: Audience } | null; accessEpoch: number }
export interface WikiMoveInput { destinationPath: string; expectedVersion: number; expectedSourceVersionId: string; expectedDestinationId: string | null; expectedDestinationVersion: number; expectedAccessEpoch: number; expectedPublicationRevision?:number; expectedPublishedVersionId?:string; expectedDestinationPublicationRevision?:number; expectedDestinationPublishedVersionId?:string; message?: string }
export interface WikiMovePreview { source: WikiReference; sourceVersionId: string; destination: WikiReference | null; destinationPath: string; destinationSpaceId: string; expectedAccessEpoch: number; defaultInput: WikiMoveInput }
export interface WikiMoveReceipt { source: WikiDocument; destination: WikiDocument; sourceVersionId: string; destinationVersionId: string; operationId: string; accessEpoch?: number }
export interface WikiMoveProvenance { operationId: string; sourceId: string; destinationId: string; inputSha256: string }
/** Read paths include legacy slugs up to 160 characters plus the trailing slash. */
export const WIKI_PATH_MAX_LENGTH = 512;
export const WIKI_WRITE_PATH_MAX_LENGTH = 128;
export const WIKI_CHILD_SCAN_LIMIT = 1000;

/** Phriction path conventions: root '/', lowercase components and trailing '/'. */
export function canonicalWikiPath(value: string): string {
  if (typeof value !== 'string' || value.length > WIKI_PATH_MAX_LENGTH || /[\uD800-\uDFFF]/u.test(value)) throw new Error('Wiki paths must contain complete characters and at most 512 characters.');
  const normalized = value.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
    .replace(/[\x00-\x1f\x7f#%&+=? \\<>{}\[\]'\"]+/g, '_').replace(/_+/g, '_')
    .split('/').map(part => { const clean = part === '_' ? part : part.replace(/^_+|_+$/g, ''); return clean === '.' ? 'dot' : clean === '..' ? 'dotdot' : clean; }).join('/');
  const path = `${normalized}/`;
  if (path.length > WIKI_PATH_MAX_LENGTH) throw new Error('The canonical wiki path is too long.');
  return path;
}
export function wikiAncestors(value: string): string[] {
  const path = canonicalWikiPath(value); if (path === '/') return [];
  const parts = path.slice(0, -1).split('/'); return ['/', ...parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)];
}
export function wikiParentPath(value: string): string | null { return wikiAncestors(value).at(-1) ?? null; }
export function wikiReference(document: WikiDocument): WikiReference {
  const location = document.location ?? { path: canonicalWikiPath(document.slug), status: 'active' as const, movedToId: null };
  return { id: document.id, title: document.title, path: location.path, status: location.status, version: document.version };
}

/** Content head never moves backward; publication revision also advances for pointer-only changes. */
export interface WikiPublication { revision:number; headVersion:number; headVersionId:string; publishedVersion:number; publishedVersionId:string }
export interface WikiLifecyclePins { expectedVersion:number; expectedHeadVersionId:string; expectedPublishedVersionId:string; expectedPublicationRevision:number; expectedAccessEpoch:number }
export interface WikiDraftInput extends WikiLifecyclePins { title:string; content:string; message?:string }
export interface WikiPublishInput extends WikiLifecyclePins { targetVersionId:string; message?:string }
export interface WikiDeleteInput extends WikiLifecyclePins { message?:string }
export type WikiLifecycleKind = 'legacy'|'create'|'edit'|'draft'|'restore'|'publish'|'delete'|'move_to'|'move_away';
export interface WikiLifecycleSnapshot { publication:WikiPublication; location:WikiLocation; updatedAt:string }
export interface WikiLifecycleTransaction { id:string; documentId:string; sequence:number; kind:WikiLifecycleKind; actor:string|null; attribution?:import('./types').ActorAttribution; createdAt:string; message:string; inputSha256:string|null; before:WikiLifecycleSnapshot|null; after:WikiLifecycleSnapshot; newVersionId:string|null }
export interface WikiLifecycleHistory { transactions:WikiLifecycleTransaction[]; nextBefore:number|null; firstAvailableSequence:number|null; accessEpoch?:number }
export interface WikiLifecycleReceipt { document:WikiDocument; transaction:WikiLifecycleTransaction; accessEpoch?:number }
