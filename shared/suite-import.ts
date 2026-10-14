import type { SuiteAccess, SuiteApp } from './suite.ts';

/** Actual MySQL XML exports; this envelope describes the destination, not an upstream format. */
export interface SuiteImportRequest {
  sourceKey: string;
  files: { name: string; xml: string }[];
  destination: SuiteAccess;
  /** Explicit current grants. Upstream policies and participant rows never grant access. */
  roles?: Record<string, { participantIds?: string[]; inviteeIds?: string[]; authorIds?: string[]; editorIds?: string[] }>;
}
export interface SuiteImportSourceRow { table: string; fields: Record<string, string | null> }
export interface SuiteImportSourceHistory {
  sourceCreatedAt: string | null; sourceModifiedAt: string | null; sourceAuthorPHID: string | null;
  rows: SuiteImportSourceRow[];
}
export interface SuiteImportItemPreview {
  sourcePHID: string; app: SuiteApp; kind: string; title: string;
  disposition: 'create' | 'skip' | 'conflict'; recordId: string | null;
  sourceDigest: string; historyRows: number; warnings: string[];
}
export interface SuiteImportPreview {
  sourceKey: string; digest: string; items: SuiteImportItemPreview[];
  warnings: string[]; errors: string[]; canApply: boolean;
  destination: SuiteAccess;
}
export interface SuiteImportProvenance extends SuiteImportSourceHistory {
  sourceKey: string; sourcePHID: string; sourceDigest: string;
  recordId: string; importedAt: string; importedBy: string;
  warnings: string[];
  assertionStatus: 'historical-unverified';
}
export interface SuiteImportReceipt {
  sourceKey: string; digest: string; replayed: boolean;
  records: { sourcePHID: string; recordId: string; created: boolean }[];
}
