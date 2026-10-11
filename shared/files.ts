import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';

export const FILE_MAX_BYTES = 16 * 1024 * 1024;
export const REVISION_ASSET_MAX_BYTES = 64 * 1024 * 1024;
export const REVISION_ASSET_MAX_COUNT = 100;
export const FILE_IMAGE_MAX_DIMENSION = 16_384;
export const FILE_IMAGE_MAX_PIXELS = 64 * 1024 * 1024;
export type FileMediaType = 'image/png' | 'image/jpeg' | 'application/pdf' | 'application/octet-stream';
export type RevisionAssetMediaType = Exclude<FileMediaType, 'application/octet-stream'>;
export interface RevisionAsset { path: string; fileId: string; sha256: string; bytes: number; mediaType: RevisionAssetMediaType }
export interface FileImageDimensions { width: number; height: number }
export interface FileRecord {
  id: string; sha256: string; bytes: number; mediaType: FileMediaType; originalName: string;
  authorId: string; createdAt: string; dimensions: FileImageDimensions | null;
  name: string; altText: string; status: 'active' | 'archived'; version: number; updatedAt: string;
}
export interface UploadFileInput { name: string; altText?: string; dataBase64: string; sha256: string; bytes: number }
export interface UpdateFileInput { expectedVersion: number; name?: string; altText?: string; status?: FileRecord['status'] }
export interface FileListQuery { before?: number; limit?: number; name?: string; authorId?: string; status?: FileRecord['status'] | 'all' }
export interface FilePage { files: FileRecord[]; nextBefore: number | null; accessEpoch?: number }
export type FileAttachmentMode = 'attach' | 'reference' | 'detach';
export interface FileAttachment {
  fileId: string; objectId: string; mode: FileAttachmentMode; version: number;
  attacherId: string; createdAt: string; updatedAt: string;
}
export interface SetFileAttachmentInput { objectId: string; mode: FileAttachmentMode; expectedVersion: number; expectedAccessEpoch?: number }
export interface FileAttachmentPage { attachments: FileAttachment[]; nextBefore: number | null; accessEpoch?: number }
export interface FileFieldChange { field: 'name' | 'altText' | 'status'; oldValue: string; newValue: string }
export interface FileTransaction {
  id: string; fileId: string; sequence: number; fileVersion: number; kind: 'upload' | 'edit' | 'attachment';
  createdAt: string; attribution: ActorAttribution; snapshot?: FileRecord; changes?: FileFieldChange[];
  attachment?: FileAttachment & { oldMode: FileAttachmentMode | null };
}
export interface FileHistory { transactions: FileTransaction[]; nextBefore: number | null; accessEpoch?: number }
export interface FileDetail { file: FileRecord; history: FileHistory; attachments: FileAttachmentPage; access?: ObjectAccess; accessEpoch?: number }
