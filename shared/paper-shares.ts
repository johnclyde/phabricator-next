import type { SourceFile } from './types';

/** Management metadata contains no bearer credential. */
export interface PaperShareLink {
  id: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PaperShareList {
  links: PaperShareLink[];
  accessEpoch: number;
  nextCursor: string | null;
}

/** An explicit, immutable paper projection, separate from workspace revisions. */
export interface SharedPaper {
  title: string;
  versionNumber: number;
  contentHash: string;
  files: SourceFile[];
}

export interface CreatePaperShareInput {
  token: string;
  versionId: string;
  contentHash: string;
  label: string;
}
