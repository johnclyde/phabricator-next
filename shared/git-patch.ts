import { GIT_LIMITS, type GitComparisonIdentity, type GitComparisonQuery, type GitPatch } from './repositories';
import { validGitComparisonIdentity } from './git-comparison';

const emptyTrees = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };
/** Structural checks only. Always verify the bytes before offering a download. */
export function validGitPatch(value: unknown, id: string, query: GitComparisonQuery, expected?: GitComparisonIdentity): value is GitPatch {
  if (!validGitComparisonIdentity(value, id, query) || !('format' in value) || value.format !== 'git-binary-patch-v1'
    || !('bytes' in value) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > GIT_LIMITS.patchBytes
    || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !('dataBase64' in value) || typeof value.dataBase64 !== 'string' || value.dataBase64.length !== 4 * Math.ceil(Number(value.bytes) / 3)) return false;
  const padding = (3 - Number(value.bytes) % 3) % 3;
  if (!value.dataBase64.endsWith('='.repeat(padding)) || /[^A-Za-z0-9+/]/.test(value.dataBase64.slice(0, value.dataBase64.length - padding))) return false;
  if (query.base === null && value.baseTreeId !== emptyTrees[value.objectFormat]) return false;
  if ((value.bytes === 0) !== (value.baseTreeId === value.targetTreeId)) return false;
  return !expected || validGitComparisonIdentity(expected, id, query) && value.objectFormat === expected.objectFormat
    && value.baseTreeId === expected.baseTreeId && value.targetTreeId === expected.targetTreeId && value.accessEpoch === expected.accessEpoch;
}

/** Works identically in the browser, CLI and offline readers; never decodes source as text. */
export async function gitPatchBytes(value: unknown, id: string, query: GitComparisonQuery, expected?: GitComparisonIdentity): Promise<Uint8Array<ArrayBuffer>> {
  if (!validGitPatch(value, id, query, expected)) throw new Error('The patch does not match this exact commit pair, access snapshot, or size limit.');
  const binary = atob(value.dataBase64);
  if (binary.length !== value.bytes || btoa(binary) !== value.dataBase64) throw new Error('The patch encoding or byte length is invalid.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== value.sha256) throw new Error('The patch SHA-256 does not match its recorded bytes.');
  return bytes;
}

export function gitPatchFilename(id: string, query: GitComparisonQuery): string {
  if (!/^R[1-9]\d{0,14}$/.test(id) || !(query.base === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(query.base)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(query.target)) throw new Error('Invalid patch filename identity.');
  return `${id}-${query.base ?? 'empty'}-to-${query.target}.patch`;
}
