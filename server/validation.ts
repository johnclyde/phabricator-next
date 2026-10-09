import type { SourceFile } from '../shared/types.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object.');
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) throw new HttpError(400, `Unknown field: ${key}.`);
  return result;
}

export function string(value: unknown, field: string, max = 240, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
    throw new HttpError(400, `${field} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  }
  return value;
}

export function optionalString(value: unknown, field: string, max = 100_000, fallback = ''): string {
  return value === undefined ? fallback : string(value, field, max, true);
}

export function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, `${field} must be a positive integer.`);
  return value;
}

export function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new HttpError(400, `Invalid ${field}.`);
  return value as T;
}

export function files(value: unknown): SourceFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new HttpError(400, 'Provide between 1 and 100 source files.');
  const paths = new Set<string>();
  let bytes = 0;
  const result = value.map((item: unknown) => {
    const entry = object(item, ['path', 'content']);
    const path = string(entry.path, 'File path', 240);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f:]/.test(path)) {
      throw new HttpError(400, 'File paths must be safe relative paths.');
    }
    if (paths.has(path)) throw new HttpError(400, `Duplicate file path: ${path}.`);
    paths.add(path);
    const content = string(entry.content, `Content of ${path}`, 500_000, true);
    bytes += Buffer.byteLength(content, 'utf8');
    return { path, content };
  });
  if (bytes > 1_500_000) throw new HttpError(400, 'Total source content exceeds 1.5 MB.');
  return result;
}

export function remoteUrl(value: unknown): string {
  const result = string(value, 'Repository URL', 2_000);
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(result)) return result;
  try {
    const url = new URL(result);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.password) throw new Error();
  } catch { throw new HttpError(400, 'Use an HTTP, HTTPS, SSH, or Git repository URL without a password.'); }
  return result;
}
