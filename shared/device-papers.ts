import type { SourceFile } from './types';
import { validateSourceSnapshot } from './source-snapshot';

export const DEVICE_PAPER_FORMAT = 'phabricator.device-paper.v1';
export const DEVICE_PAPER_LIMITS = Object.freeze({ title: 200, files: 200, fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, importBytes: 64 * 1024 * 1024 });
/** Device papers have no workspace, account, publication, or review identity. */
export interface DevicePaper { id: string; title: string; files: SourceFile[]; revision: number; createdAt: string; updatedAt: string }
export interface DevicePaperSource { title: string; files: SourceFile[] }
export class DevicePaperValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'DevicePaperValidationError'; }
}
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function fail(message: string): never { throw new DevicePaperValidationError(message); }
export const validDevicePaperId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** A detached, bounded copy; text and line endings are never normalized. */
export function validateDevicePaperSource(value: unknown): DevicePaperSource {
  if (!plain(value)) fail('The paper must contain a title and text files.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > DEVICE_PAPER_LIMITS.title || /[\x00-\x1f\x7f]/.test(value.title) || /[\uD800-\uDFFF]/u.test(value.title)) fail('Give the paper a title of 1–200 characters without control characters.');
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > DEVICE_PAPER_LIMITS.files) fail('The paper must contain between 1 and 200 text files.');
  const files: SourceFile[] = []; let total = 0;
  for (const valueFile of value.files) {
    if (!plain(valueFile) || typeof valueFile.path !== 'string' || typeof valueFile.content !== 'string') fail('Each paper file must contain a path and text content.');
    if (valueFile.content.length > DEVICE_PAPER_LIMITS.fileBytes || valueFile.content.includes('\0') || /[\uD800-\uDFFF]/u.test(valueFile.content)) fail('Paper files must contain valid Unicode text without null bytes, up to 2 MiB each.');
    const bytes = new TextEncoder().encode(valueFile.content).byteLength;
    if (bytes > DEVICE_PAPER_LIMITS.fileBytes) fail('Each paper text file must be at most 2 MiB.');
    total += bytes;
    if (total > DEVICE_PAPER_LIMITS.totalBytes) fail('The paper text files must total at most 10 MiB.');
    files.push({ path: valueFile.path, content: valueFile.content });
  }
  try { validateSourceSnapshot(files); } catch (error) { fail(error instanceof Error ? error.message : 'The paper has invalid file paths.'); }
  return { title: value.title, files };
}

export function validateDevicePaper(value: unknown, allowUnsaved = false): DevicePaper {
  if (!plain(value) || !validDevicePaperId(value.id)) fail('The paper has an invalid device identity.');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < (allowUnsaved ? 0 : 1)) fail('The paper has an invalid saved revision.');
  if (!validTime(value.createdAt) || !validTime(value.updatedAt) || value.updatedAt < value.createdAt) fail('The paper has invalid saved times.');
  const source = validateDevicePaperSource(value);
  return { id: value.id, ...source, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

/** Import is always source for a new copy, even if a file includes foreign identity fields. */
export function parseDevicePaperImport(value: unknown): DevicePaperSource {
  if (!plain(value) || value.format !== DEVICE_PAPER_FORMAT) fail('Choose a supported Phabricator device paper export.');
  return validateDevicePaperSource(value);
}

/** Portable backups intentionally exclude local identities and all authentication context. */
export function serializeDevicePaper(paper: DevicePaperSource): string {
  const source = validateDevicePaperSource(paper);
  return JSON.stringify({ format: DEVICE_PAPER_FORMAT, ...source }, null, 2) + '\n';
}
