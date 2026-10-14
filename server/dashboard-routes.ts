import { createHash } from 'node:crypto';
import type { AuthContext } from '../shared/auth.ts';
import { parseDashboardDelete, parseDashboardHome, parseDashboardWrite, type DashboardDetail, type DashboardHomeDetail, type DashboardList, type DashboardReceipt } from '../shared/dashboards.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { MutationResponse, Store } from './store.ts';
import { DashboardStore, type DashboardOperation } from './dashboards.ts';
import { HttpError } from './validation.ts';

export class DashboardService {
  readonly dashboards: DashboardStore;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore) { this.dashboards = new DashboardStore(store.database); }
  private route(path: string): { id: string | null; action: 'create' | 'update' | 'delete' | 'home' } {
    if (path === '/api/dashboard-home') return { id: null, action: 'home' };
    if (path === '/api/dashboards') return { id: null, action: 'create' };
    const match = /^\/api\/dashboards\/([^/]+)(\/delete)?$/.exec(path);
    if (!match) throw new HttpError(404, 'Dashboard route was not found.');
    return { id: match[1]!, action: match[2] ? 'delete' : 'update' };
  }
  read(path: string, query: URLSearchParams, actor: AuthContext): DashboardList | DashboardDetail | DashboardHomeDetail {
    return this.store.read(() => {
      this.auth.revalidate(actor, 'read');
      const route = this.route(path);
      if (route.id) this.dashboards.get(route.id, actor.principalId);
      if (query.size) throw new HttpError(400, 'Dashboard reads do not accept query parameters.');
      const accessEpoch = this.policies.epoch();
      if (route.action === 'home') {
        const home = this.dashboards.home(actor.principalId);
        return { home, dashboard: home.dashboardId ? this.dashboards.get(home.dashboardId, actor.principalId) : null, accessEpoch };
      }
      if (route.action === 'delete') throw new HttpError(404, 'Dashboard route was not found.');
      if (route.id) { const dashboard = this.dashboards.get(route.id, actor.principalId); return { dashboard, canEdit: dashboard.ownerId === actor.principalId, accessEpoch }; }
      return { dashboards: this.dashboards.list(actor.principalId), home: this.dashboards.home(actor.principalId), accessEpoch };
    });
  }
  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, actor: AuthContext): MutationResponse {
    const route = this.route(path);
    const authorize = () => { this.auth.revalidate(actor, 'write'); if (route.id) this.dashboards.requireOwner(route.id, actor.principalId, true); };
    this.store.read(authorize);
    if (method !== (route.action === 'update' ? 'PUT' : 'POST')) throw new HttpError(405, 'Use the supported dashboard change method.');
    if (!rawKey || rawKey.length > 200 || /[\u0000-\u001f\u007f]/.test(rawKey)) throw new HttpError(400, 'Dashboard changes require an Idempotency-Key of at most 200 characters.');
    let data;
    try { data = route.action === 'home' ? parseDashboardHome(input) : route.action === 'delete' ? parseDashboardDelete(input) : parseDashboardWrite(input, route.action === 'update'); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid dashboard input.'); }
    const requestHash = createHash('sha256').update(JSON.stringify([actor.workspaceId, actor.principalId, rawKey])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([method, path, data])).digest('hex');
    return this.store.mutate(undefined, fingerprint, () => {
      const previous = this.dashboards.operation(actor.principalId, requestHash, fingerprint);
      let operation: DashboardOperation;
      if (previous) operation = previous;
      else {
        if (data.expectedAccessEpoch !== this.policies.epoch()) throw new HttpError(409, 'Workspace access changed. Refresh before changing this dashboard.');
        if (route.action === 'home') {
          const homeInput = parseDashboardHome(data), home = this.dashboards.setHome(actor.principalId, homeInput.dashboardId, homeInput.version);
          operation = { id: homeInput.dashboardId, version: home.version, action: 'home' };
        } else if (route.action === 'delete') {
          const deleted = this.dashboards.update(actor.principalId, route.id!, null, parseDashboardDelete(data).expectedVersion);
          operation = { id: deleted.id, version: deleted.version, action: 'delete' };
        } else {
          const selected = parseDashboardWrite(data, route.action === 'update'), { expectedAccessEpoch: _epoch, expectedVersion: _version, ...definition } = selected;
          const dashboard = route.id ? this.dashboards.update(actor.principalId, route.id, definition, selected.expectedVersion!) : this.dashboards.create(actor.principalId, definition);
          operation = { id: dashboard.id, version: dashboard.version, action: route.action };
        }
        this.dashboards.recordOperation(actor.principalId, requestHash, fingerprint, operation);
      }
      let dashboard = null;
      if (operation.id) {
        try { dashboard = this.dashboards.get(operation.id, actor.principalId); }
        catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
      }
      const result: DashboardReceipt = { dashboard, home: this.dashboards.home(actor.principalId), receipt: { ...operation, replayed: !!previous }, accessEpoch: this.policies.epoch() };
      return { status: 200, body: result };
    }, authorize);
  }
}
