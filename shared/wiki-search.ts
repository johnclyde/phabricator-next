import type { WikiVersion } from './types';
import type { WikiReference, WikiStatus } from './wiki';

export type WikiSearchOrder = 'newest' | 'oldest';
export interface WikiSearchPaging { order?:WikiSearchOrder; after?:string; before?:string; limit?:number; includeContent?:boolean; query?:string }
export interface WikiDocumentSearchQuery extends WikiSearchPaging { queryKey?:'active'|'all'; statuses?:WikiStatus[]; paths?:string[]; parentPaths?:string[]; ancestorPaths?:string[]; ids?:number[]; phids?:string[] }
export interface WikiContentSearchQuery extends WikiSearchPaging { documentPHIDs?:string[]; versions?:number[]; ids?:number[]; phids?:string[] }
export interface WikiDocumentIdentity { id:number; phid:string; documentId:string }
export interface WikiContentIdentity { id:number; phid:string; documentId:string; versionId:string }
export interface WikiContentSearchItem extends WikiContentIdentity { documentPHID:string; version:number; path:string; title:string; authorId:string|null; author:string|null; createdAt:string; message:string; kind:WikiVersion['kind']; snippet:string; content?:string }
export interface WikiDocumentSearchItem extends WikiReference { conduitId:number; phid:string; published:WikiContentSearchItem }
export interface WikiDocumentSearchPage { documents:WikiDocumentSearchItem[]; nextAfter:string|null; nextBefore:string|null; accessEpoch?:number }
export interface WikiContentSearchPage { contents:WikiContentSearchItem[]; nextAfter:string|null; nextBefore:string|null; accessEpoch?:number }
export const WIKI_SEARCH_MAX_SCAN=1000;
export const WIKI_SEARCH_MAX_SOURCE_BYTES=16*1024*1024;
export const WIKI_SEARCH_SNIPPET_LENGTH=240;
export const WIKI_SEARCH_MAX_FILTER_VALUES=100;
