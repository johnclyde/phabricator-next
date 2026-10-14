import { parseSearchQuery, type SearchQuery } from './search';

export const DASHBOARD_LAYOUTS = ['single', 'equal', 'wide-left', 'wide-right'] as const;
export type DashboardLayout = typeof DASHBOARD_LAYOUTS[number];
export const DASHBOARD_LAYOUT_NAMES: Record<DashboardLayout, string> = { single: 'One column', equal: 'Two equal columns', 'wide-left': 'Wide left column', 'wide-right': 'Wide right column' };
export interface DashboardPanelBase { id: string; title: string; column: 0 | 1 }
export interface DashboardTextPanel extends DashboardPanelBase { kind: 'text'; text: string }
export interface DashboardQueryPanel extends DashboardPanelBase { kind: 'query'; query: SearchQuery; limit: number }
export type DashboardPanel = DashboardTextPanel | DashboardQueryPanel;
export interface DashboardDefinition { name: string; description: string; visibility: 'private' | 'workspace'; layout: DashboardLayout; panels: DashboardPanel[] }
export interface Dashboard extends DashboardDefinition { id: string; ownerId: string; version: number; createdAt: string; updatedAt: string; deleted: boolean }
export interface DashboardHome { dashboardId: string | null; version: number }
export interface DashboardList { dashboards: Dashboard[]; home: DashboardHome; accessEpoch: number }
export interface DashboardDetail { dashboard: Dashboard; canEdit: boolean; accessEpoch: number }
export interface DashboardHomeDetail { dashboard: Dashboard | null; home: DashboardHome; accessEpoch: number }
export interface DashboardWriteInput extends DashboardDefinition { expectedAccessEpoch: number; expectedVersion?: number }
export interface DashboardDeleteInput { expectedAccessEpoch: number; expectedVersion: number }
export interface DashboardHomeInput extends DashboardHome { expectedAccessEpoch: number }
export interface DashboardReceipt { dashboard: Dashboard | null; home: DashboardHome; receipt: { id: string | null; version: number; action: 'create' | 'update' | 'delete' | 'home'; replayed: boolean }; accessEpoch: number }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: readonly string[]): void { if (Object.keys(value).some(key => !expected.includes(key))) throw new Error('Unsupported dashboard field.'); }
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || !empty && !value.trim()) throw new Error(`${label} must contain ${empty ? 'at most' : '1–'}${max} characters.`);
  return empty ? value : value.trim();
}
export const isDashboardId = (id: unknown): id is string => typeof id === 'string' && /^DASH-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export function dashboardVersion(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new Error('Provide the current dashboard version.'); return Number(value);
}
export function parseDashboardDefinition(value: unknown): DashboardDefinition {
  if (!record(value)) throw new Error('Provide a dashboard definition.');
  keys(value, ['name', 'description', 'visibility', 'layout', 'panels']);
  const name = text(value.name, 'Dashboard name', 120), description = text(value.description, 'Description', 10_000, true);
  if (value.visibility !== 'private' && value.visibility !== 'workspace') throw new Error('Choose private or workspace dashboard access.');
  if (!DASHBOARD_LAYOUTS.includes(value.layout as DashboardLayout)) throw new Error('Choose a supported dashboard layout.');
  if (!Array.isArray(value.panels) || value.panels.length > 100) throw new Error('A dashboard supports up to 100 panels.');
  const ids = new Set<string>();
  const panels = value.panels.map((entry): DashboardPanel => {
    if (!record(entry)) throw new Error('Provide a panel definition.');
    keys(entry, entry.kind === 'text' ? ['id', 'title', 'column', 'kind', 'text'] : ['id', 'title', 'column', 'kind', 'query', 'limit']);
    const id = text(entry.id, 'Panel identifier', 100), title = text(entry.title, 'Panel title', 120);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('Use a distinct identifier for each dashboard panel.'); ids.add(id);
    if (entry.column !== 0 && entry.column !== 1 || value.layout === 'single' && entry.column !== 0) throw new Error('Select a column in the dashboard layout.');
    const base: DashboardPanelBase = { id, title, column: entry.column };
    if (entry.kind === 'text') return { ...base, kind: 'text', text: text(entry.text, 'Panel text', 100_000, true) };
    if (entry.kind !== 'query' || !Number.isSafeInteger(entry.limit) || Number(entry.limit) < 1 || Number(entry.limit) > 100) throw new Error('Query panels must show between 1 and 100 results.');
    return { ...base, kind: 'query', query: parseSearchQuery(entry.query), limit: Number(entry.limit) };
  });
  const result: DashboardDefinition = { name, description, visibility: value.visibility, layout: value.layout as DashboardLayout, panels };
  if (JSON.stringify(result).length > 500_000) throw new Error('This dashboard exceeds the 500,000 character definition limit.');
  return result;
}
export function parseDashboardWrite(value: unknown, updating: boolean): DashboardWriteInput {
  if (!record(value)) throw new Error('Provide a dashboard definition.');
  keys(value, ['name', 'description', 'visibility', 'layout', 'panels', 'expectedAccessEpoch', ...(updating ? ['expectedVersion'] : [])]);
  const { expectedAccessEpoch, expectedVersion, ...definition } = value;
  return { ...parseDashboardDefinition(definition), expectedAccessEpoch: dashboardVersion(expectedAccessEpoch, true), ...(updating ? { expectedVersion: dashboardVersion(expectedVersion) } : {}) };
}
export function parseDashboardDelete(value: unknown): DashboardDeleteInput {
  if (!record(value)) throw new Error('Provide dashboard and access versions.'); keys(value, ['expectedVersion', 'expectedAccessEpoch']);
  return { expectedVersion: dashboardVersion(value.expectedVersion), expectedAccessEpoch: dashboardVersion(value.expectedAccessEpoch, true) };
}
export function parseDashboardHome(value: unknown): DashboardHomeInput {
  if (!record(value)) throw new Error('Provide a home dashboard and preference version.'); keys(value, ['dashboardId', 'version', 'expectedAccessEpoch']);
  if (value.dashboardId !== null && !isDashboardId(value.dashboardId)) throw new Error('Select a dashboard or the built-in home.');
  return { dashboardId: value.dashboardId, version: dashboardVersion(value.version, true), expectedAccessEpoch: dashboardVersion(value.expectedAccessEpoch, true) };
}
/** Definition text is deliberately copied when selected; no owner's private saved query is referenced. */
export function dashboardDefinition(dashboard: Dashboard): DashboardDefinition {
  return parseDashboardDefinition({ name: dashboard.name, description: dashboard.description, visibility: dashboard.visibility, layout: dashboard.layout, panels: dashboard.panels });
}
export function validDashboardReceipt(value: unknown, path: string, method: string, input: unknown): value is DashboardReceipt {
  try {
    if (!record(value) || !record(value.receipt) || !record(value.home)) return false;
    const receipt = value.receipt, home = value.home;
    dashboardVersion(value.accessEpoch, true); dashboardVersion(home.version, true); dashboardVersion(receipt.version);
    if (typeof receipt.replayed !== 'boolean' || home.dashboardId !== null && !isDashboardId(home.dashboardId)) return false;
    const id = /^\/api\/dashboards\/([^/]+)(\/delete)?$/.exec(path);
    const action = path === '/api/dashboard-home' ? 'home' : path === '/api/dashboards' ? 'create' : id?.[2] ? 'delete' : 'update';
    if (receipt.action !== action || method !== (action === 'update' ? 'PUT' : 'POST')) return false;
    if (action === 'home') { const requested = parseDashboardHome(input); if (receipt.id !== requested.dashboardId || receipt.version !== requested.version + 1) return false; }
    else if (action === 'delete') { if (receipt.id !== id?.[1] || receipt.version !== parseDashboardDelete(input).expectedVersion + 1) return false; }
    else { const requested = parseDashboardWrite(input, action === 'update'); if (!isDashboardId(receipt.id) || action === 'update' && receipt.id !== id?.[1] || receipt.version !== (requested.expectedVersion ?? 0) + 1) return false; }
    if (value.dashboard !== null) {
      if (!record(value.dashboard)) return false;
      const dashboard = value.dashboard as unknown as Dashboard; dashboardDefinition(dashboard);
      if (dashboard.id !== receipt.id || !isDashboardId(dashboard.id) || typeof dashboard.ownerId !== 'string' || !dashboard.ownerId || dashboard.deleted !== false || !Number.isFinite(Date.parse(dashboard.createdAt)) || !Number.isFinite(Date.parse(dashboard.updatedAt))) return false;
      dashboardVersion(dashboard.version);
      if (action !== 'home' && dashboard.version < Number(receipt.version)) return false;
    }
    return true;
  } catch { return false; }
}
