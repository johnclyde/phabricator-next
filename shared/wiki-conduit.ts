import type { ActorAttribution } from './types';
import type { WikiLifecycleSnapshot } from './wiki';

export type WikiConduitMethod = 'phriction.create' | 'phriction.edit';
export interface WikiConduitCreateInput { slug: string; title: string; content: string; description?: string | null }
export interface WikiConduitEditInput { slug: string; title?: string | null; content?: string | null; description?: string | null }
/** Internal immutable execution evidence, never supplied by a Conduit caller. */
export interface WikiConduitReceipt {
  id: string;
  method: WikiConduitMethod;
  inputSha256: string;
  retryKeySha256: string | null;
  attribution: ActorAttribution;
  documentId: string;
  selectedVersionId: string;
  snapshot: WikiLifecycleSnapshot;
  transactionId: string | null;
  createdAt: string;
}
