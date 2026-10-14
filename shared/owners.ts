/** Portable Owners package definitions and the original longest-path/dominion rules. */
export const OWNERS_AUTOREVIEW_MODES = ['none', 'subscribe', 'subscribe-always', 'review', 'review-always'] as const;
export const OWNERS_AUDITING_MODES = ['none', 'audit', 'unreviewed', 'uninvolved-unreviewed', 'all'] as const;
export type OwnersAutoreview = typeof OWNERS_AUTOREVIEW_MODES[number];
export type OwnersAuditing = typeof OWNERS_AUDITING_MODES[number];
export interface OwnerReference { kind: 'person' | 'project'; id: string }
export interface OwnersPath { repositoryId: string; path: string; excluded: boolean }
export interface OwnersDefinition {
  name: string; description: string; status: 'active' | 'archived'; visibility: 'private' | 'workspace';
  owners: OwnerReference[]; dominion: 'strong' | 'weak'; autoReview: OwnersAutoreview; auditing: OwnersAuditing; paths: OwnersPath[];
}
export interface OwnersPackage extends OwnersDefinition { id: string; creatorId: string; version: number; createdAt: string; updatedAt: string }
export interface OwnersList { packages: OwnersPackage[]; canCreate: boolean; accessEpoch: number }
export interface OwnersDetail { package: OwnersPackage; canEdit: boolean; accessEpoch: number }
export interface OwnersHistoryEntry { package: OwnersPackage; actorId: string; actorName: string }
export interface OwnersHistory { history: OwnersHistoryEntry[]; accessEpoch: number }
export interface OwnersMatch { package: OwnersPackage; paths: string[] }
export interface OwnersResolve { matches: OwnersMatch[]; accessEpoch: number }
export interface OwnersWriteInput extends OwnersDefinition { expectedAccessEpoch: number; expectedVersion?: number }
export interface OwnersOperation { id: string; version: number; action: 'create' | 'update' }
export interface OwnersReceipt { package: OwnersPackage | null; receipt: OwnersOperation & { replayed: boolean }; accessEpoch: number }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): void => { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported Owners field.'); };
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000\uD800-\uDFFF]/u.test(value) || !empty && !value.trim()) throw new Error(`${label} must contain ${empty ? 'at most ' : '1–'}${max} characters.`);
  return empty ? value : value.trim();
}
export const isOwnersId = (id: unknown): id is string => typeof id === 'string' && /^OWN-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const isOwnersRepositoryId = (id: unknown): id is string => typeof id === 'string' && /^R[1-9]\d{0,14}$/.test(id);
export function ownersVersion(value: unknown, zero = false): number { if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) throw new Error('Provide the current Owners version.'); return Number(value); }
/** Paths are literal component prefixes, never globs. Root and trailing separators are canonical. */
export function ownersPath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw new Error('Provide a repository path of at most 4,096 characters.');
  const parts = value.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Owners paths must not contain dot or parent directory components.');
  return `/${parts.join('/')}`;
}
/** Inspected Git names are data, not user-entered rules. Preserve every literal component
 * and allow tabs/newlines so a root claim still covers unusual but valid repository files. */
export function ownersChangedPath(value: string): string {
  if (typeof value !== 'string' || !value.length || /[\u0000\uD800-\uDFFF]/u.test(value)) throw new Error('Invalid inspected repository path.');
  return value.startsWith('/') ? value : `/${value}`;
}
export function parseOwnersDefinition(value: unknown): OwnersDefinition {
  if (!record(value)) throw new Error('Provide an Owners package definition.');
  keys(value, ['name', 'description', 'status', 'visibility', 'owners', 'dominion', 'autoReview', 'auditing', 'paths']);
  const name = text(value.name, 'Package name', 160), description = text(value.description, 'Description', 100_000, true);
  if (value.status !== 'active' && value.status !== 'archived') throw new Error('Select an active or archived package.');
  if (value.visibility !== 'private' && value.visibility !== 'workspace') throw new Error('Choose private or workspace package access.');
  if (value.dominion !== 'strong' && value.dominion !== 'weak') throw new Error('Choose strong or weak dominion.');
  if (value.autoReview === 'block' || value.autoReview === 'block-always') throw new Error('Blocking package review requires collective reviewer support and is not available yet. Choose review or subscribe.');
  if (!OWNERS_AUTOREVIEW_MODES.includes(value.autoReview as OwnersAutoreview)) throw new Error('Choose a supported automatic review mode.');
  if (!OWNERS_AUDITING_MODES.includes(value.auditing as OwnersAuditing)) throw new Error('Choose a supported auditing mode.');
  if (!Array.isArray(value.owners) || value.owners.length > 1000) throw new Error('Provide up to 1,000 people or projects as owners.');
  const ownerKeys = new Set<string>();
  const owners = value.owners.map((entry): OwnerReference => {
    if (!record(entry)) throw new Error('Provide an owner.'); keys(entry, ['kind', 'id']);
    if (entry.kind !== 'person' && entry.kind !== 'project') throw new Error('Owners must be people or projects.');
    const id = text(entry.id, 'Owner identifier', 128), key = `${entry.kind}:${id}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(id) || entry.kind === 'project' && !/^PROJ[1-9]\d{0,14}$/.test(id) || ownerKeys.has(key)) throw new Error('Choose distinct valid owner identifiers.');
    ownerKeys.add(key); return { kind: entry.kind, id };
  });
  if (!Array.isArray(value.paths) || value.paths.length > 10_000) throw new Error('Provide up to 10,000 ownership paths.');
  const pathKeys = new Set<string>();
  const paths = value.paths.map((entry): OwnersPath => {
    if (!record(entry)) throw new Error('Provide an ownership path.'); keys(entry, ['repositoryId', 'path', 'excluded']);
    if (!isOwnersRepositoryId(entry.repositoryId) || typeof entry.excluded !== 'boolean') throw new Error('Choose a repository and include or exclude each path.');
    const path = ownersPath(entry.path), key = `${entry.repositoryId}:${path}`;
    if (pathKeys.has(key)) throw new Error('A package may define each repository path only once.'); pathKeys.add(key);
    return { repositoryId: entry.repositoryId, path, excluded: entry.excluded };
  });
  return { name, description, status: value.status, visibility: value.visibility, owners, dominion: value.dominion, autoReview: value.autoReview as OwnersAutoreview, auditing: value.auditing as OwnersAuditing, paths };
}
export function ownersDefinition(value: OwnersPackage): OwnersDefinition {
  return parseOwnersDefinition({ name: value.name, description: value.description, status: value.status, visibility: value.visibility, owners: value.owners, dominion: value.dominion, autoReview: value.autoReview, auditing: value.auditing, paths: value.paths });
}
export function parseOwnersWrite(value: unknown, updating: boolean): OwnersWriteInput {
  if (!record(value)) throw new Error('Provide an Owners package definition.');
  keys(value, ['name', 'description', 'status', 'visibility', 'owners', 'dominion', 'autoReview', 'auditing', 'paths', 'expectedAccessEpoch', ...(updating ? ['expectedVersion'] : [])]);
  const { expectedAccessEpoch, expectedVersion, ...definition } = value;
  return { ...parseOwnersDefinition(definition), expectedAccessEpoch: ownersVersion(expectedAccessEpoch, true), ...(updating ? { expectedVersion: ownersVersion(expectedVersion) } : {}) };
}
/** Apply exclusions within each package first. At equal specificity strong claims beat weak;
 * less-specific weak claims yield to any more-specific surviving claim. Strong ancestors remain. */
export function matchOwners(packages: readonly OwnersPackage[], repositoryId: string, inputPaths: readonly string[]): OwnersMatch[] {
  const result = new Map<string, OwnersMatch>();
  for (const path of [...new Set(inputPaths.map(ownersChangedPath))]) {
    const candidates: { package: OwnersPackage; strength: number }[] = [];
    for (const pkg of packages) {
      if (pkg.status !== 'active') continue;
      let best: OwnersPath | null = null, strength = 0;
      for (const rule of pkg.paths) {
        if (rule.repositoryId !== repositoryId || !(rule.path === '/' || path === rule.path || path.startsWith(`${rule.path}/`))) continue;
        const depth = rule.path === '/' ? 1 : rule.path.split('/').length;
        if (depth > strength) { best = rule; strength = depth; }
      }
      if (best && !best.excluded) candidates.push({ package: pkg, strength });
    }
    const strongDepths = new Set(candidates.filter(candidate => candidate.package.dominion === 'strong').map(candidate => candidate.strength));
    const competing = candidates.filter(candidate => candidate.package.dominion === 'strong' || !strongDepths.has(candidate.strength));
    const strongest = Math.max(0, ...competing.map(candidate => candidate.strength));
    for (const candidate of competing.filter(candidate => candidate.package.dominion === 'strong' || candidate.strength === strongest)) {
      const previous = result.get(candidate.package.id);
      if (previous) previous.paths.push(path); else result.set(candidate.package.id, { package: candidate.package, paths: [path] });
    }
  }
  return [...result.values()].sort((a, b) => a.package.name.localeCompare(b.package.name) || a.package.id.localeCompare(b.package.id));
}
export function validOwnersReceipt(value: unknown, path: string, method: string, input: unknown): value is OwnersReceipt {
  try {
    if (!record(value) || !record(value.receipt)) return false;
    const receipt = value.receipt, updating = path !== '/api/owners', id = /^\/api\/owners\/(OWN-[a-f0-9-]{36})$/.exec(path)?.[1];
    if (updating && !id || method !== (updating ? 'PUT' : 'POST')) return false;
    const requested = parseOwnersWrite(input, updating);
    ownersVersion(value.accessEpoch, true);
    if (!isOwnersId(receipt.id) || receipt.action !== (updating ? 'update' : 'create') || typeof receipt.replayed !== 'boolean' || updating && receipt.id !== id || receipt.version !== (requested.expectedVersion ?? 0) + 1) return false;
    if (value.package !== null) {
      if (!record(value.package)) return false;
      const pkg = value.package as unknown as OwnersPackage; ownersDefinition(pkg); ownersVersion(pkg.version);
      if (pkg.id !== receipt.id || pkg.version < Number(receipt.version) || typeof pkg.creatorId !== 'string' || !pkg.creatorId || !Number.isFinite(Date.parse(pkg.createdAt)) || !Number.isFinite(Date.parse(pkg.updatedAt))) return false;
      if (pkg.version === receipt.version) { const { expectedAccessEpoch: _epoch, expectedVersion: _version, ...definition } = requested; if (JSON.stringify(ownersDefinition(pkg)) !== JSON.stringify(definition)) return false; }
      if (!receipt.replayed && pkg.version !== receipt.version) return false;
    }
    return true;
  } catch { return false; }
}
