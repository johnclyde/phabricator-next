import { createHash } from 'node:crypto';
import type { AuthContext } from '../shared/auth.ts';
import { isOwnersId, isOwnersRepositoryId, ownersPath, parseOwnersWrite, type OwnersDetail, type OwnersHistory, type OwnersList, type OwnersOperation, type OwnersReceipt, type OwnersResolve } from '../shared/owners.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { MutationResponse, Store } from './store.ts';
import { createOwnersStore, type OwnersStore } from './owners.ts';
import { HttpError } from './validation.ts';

export class OwnersService {
  readonly packages: OwnersStore;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore) { this.packages = createOwnersStore(store, auth, policies); }
  read(path: string, query: URLSearchParams, actor: AuthContext): OwnersList | OwnersDetail | OwnersHistory | OwnersResolve {
    return this.store.read(() => {
      this.auth.revalidate(actor, 'read');
      const accessEpoch = this.policies.epoch();
      if (path === '/api/owners/resolve') {
        if ([...query.keys()].some(key => !['repositoryId', 'paths'].includes(key)) || query.getAll('repositoryId').length !== 1 || query.getAll('paths').length !== 1) throw new HttpError(400, 'Provide one repository and a JSON array of paths.');
        const repositoryId = query.get('repositoryId'); if (!isOwnersRepositoryId(repositoryId)) throw new HttpError(400, 'Choose a repository.');
        if (!this.packages.authority.canViewRepository(repositoryId, actor.principalId)) throw new HttpError(404, 'Repository is unavailable.');
        let paths: string[];
        try { const parsed: unknown = JSON.parse(query.get('paths')!); if (!Array.isArray(parsed) || !parsed.length || parsed.length > 10_000) throw new Error('Provide 1–10,000 repository paths.'); paths = parsed.map(ownersPath); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid ownership paths.'); }
        return { matches: this.packages.match(repositoryId, paths).filter(match => this.packages.canView(match.package, actor.principalId)), accessEpoch };
      }
      if (query.size) throw new HttpError(400, 'Owners package reads do not accept query parameters.');
      if (path === '/api/owners') return { packages: this.packages.list(actor.principalId), canCreate: actor.scopes.includes('write'), accessEpoch };
      const route = /^\/api\/owners\/([^/]+)(\/history)?$/.exec(path);
      if (!route || !isOwnersId(route[1])) throw new HttpError(404, 'Owners route is unavailable.');
      if (route[2]) return { history: this.packages.history(route[1], actor.principalId), accessEpoch };
      const pkg = this.packages.get(route[1], actor.principalId);
      return { package: pkg, canEdit: actor.scopes.includes('write') && this.packages.canEdit(pkg, actor.principalId), accessEpoch };
    });
  }
  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, actor: AuthContext): MutationResponse {
    const authorize = () => this.auth.revalidate(actor, 'write'); this.store.read(authorize);
    const updating = path !== '/api/owners', match = /^\/api\/owners\/(OWN-[a-f0-9-]{36})$/.exec(path);
    if (updating && (!match || !isOwnersId(match[1]))) throw new HttpError(404, 'Owners route is unavailable.');
    if (method !== (updating ? 'PUT' : 'POST')) throw new HttpError(405, 'Use the supported Owners change method.');
    if (!rawKey || rawKey.length > 200 || /[\u0000-\u001f\u007f]/.test(rawKey)) throw new HttpError(400, 'Owners changes require an Idempotency-Key of at most 200 characters.');
    let data;
    try { data = parseOwnersWrite(input, updating); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid Owners input.'); }
    const requestHash = createHash('sha256').update(JSON.stringify([actor.workspaceId, actor.principalId, rawKey])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([method, path, data])).digest('hex');
    return this.store.mutate(undefined, fingerprint, () => {
      const previous = this.packages.operation(actor.principalId, requestHash, fingerprint);
      let operation: OwnersOperation;
      if (previous) operation = previous;
      else {
        if (data.expectedAccessEpoch !== this.policies.epoch()) throw new HttpError(409, 'Workspace access changed. Refresh before changing this Owners package.');
        const { expectedAccessEpoch: _epoch, expectedVersion, ...definition } = data;
        const pkg = updating ? this.packages.update(actor.principalId, actor.displayName, match![1]!, definition, expectedVersion!) : this.packages.create(actor.principalId, actor.displayName, definition);
        operation = { id: pkg.id, version: pkg.version, action: updating ? 'update' : 'create' };
        this.packages.recordOperation(actor.principalId, requestHash, fingerprint, operation);
      }
      let pkg = null;
      try { pkg = this.packages.get(operation.id, actor.principalId); } catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
      const result: OwnersReceipt = { package: pkg, receipt: { ...operation, replayed: !!previous }, accessEpoch: this.policies.epoch() };
      return { status: 200, body: result };
    }, authorize);
  }
}
