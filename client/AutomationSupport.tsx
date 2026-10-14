import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useWorkspace } from './SessionGate';
import { isNetworkError, type MutationMethod } from './offline';
import { onSessionLocked } from './session';
import './automation.css';

export function automationError(error: unknown): string { return error instanceof Error ? error.message : 'The operation could not be confirmed.'; }
export function AutomationPanel({ title, children, actions, className = '' }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={`panel automation-panel ${className}`}><div className="panel-heading"><h2>{title}</h2>{actions}</div><div className="card-body">{children}</div></section>;
}
export function AutomationStatus({ value }: { value: string }) { return <span className={`badge automation-status automation-status-${value}`}>{value.replaceAll('_', ' ')}</span>; }
export function AutomationRefresh({ busy, online, refresh }: { busy: boolean; online: boolean; refresh: () => void }) { return <button type="button" className="button" disabled={busy || !online} onClick={refresh}><RefreshCw size={15}/>{busy ? 'Refreshing…' : 'Refresh'}</button>; }
export function exportAutomation(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${name}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Automation reads stay in this session and retire together when access changes. */
export function useAutomationRead<T extends { accessEpoch: number }>(path: string | null, online: boolean) {
  const client = useWorkspace(), [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const session = client.session, source = useRef({ path, session });
  const mounted = useRef(true), generation = useRef(0), requestRef = useRef({ path, client, online }); requestRef.current = { path, client, online };
  const load = useCallback(async () => {
    const captured = requestRef.current;
    const current = () => captured.path === requestRef.current.path && session === requestRef.current.client.session && captured.online === requestRef.current.online;
    if (!captured.path || !current() || !captured.online || !captured.client.isActive()) return;
    const ticket = ++generation.current; setLoading(true); setError('');
    try {
      const result = await captured.client.request<T>(captured.path);
      if (!mounted.current || !current() || ticket !== generation.current || !captured.client.isActive()) return;
      if (result.accessEpoch !== session?.accessEpoch) throw new Error('Access changed while loading. Refresh to inspect the current authorized result.');
      source.current = { path: captured.path, session };
      setData(result);
    } catch (failure) { if (mounted.current && current() && ticket === generation.current && captured.client.isActive()) { setData(null); setError(isNetworkError(failure) ? 'Reconnect and refresh to load this information.' : automationError(failure)); } }
    finally { if (mounted.current && current() && ticket === generation.current) setLoading(false); }
  }, [session]);
  const latestLoad = useRef(load); latestLoad.current = load;
  useEffect(() => {
    mounted.current = true;
    let refreshQueued = false;
    const clear = () => { generation.current++; setData(null); setLoading(false); };
    const retire = () => {
      clear();
      if (refreshQueued) return;
      refreshQueued = true;
      // Epoch invalidation happens inside request(), before its promise returns.
      // Reject that in-flight generation, then read again at current authority.
      queueMicrotask(() => { refreshQueued = false; if (mounted.current && requestRef.current.client.session === session) void latestLoad.current(); });
    };
    const access = client.onAccessChange(retire), snapshots = client.onTaskSnapshotChange(retire), locked = onSessionLocked(clear);
    return () => { mounted.current = false; generation.current++; access(); snapshots(); locked(); };
  }, [session]);
  useEffect(() => { setData(null); setLoading(false); setError(''); void load(); return () => { generation.current++; }; }, [load, path, online]);
  const install = (value: T | null) => { source.current = { path: requestRef.current.path, session: requestRef.current.client.session }; setData(value); };
  return { data: source.current.path === path && source.current.session === session && data?.accessEpoch === session?.accessEpoch ? data : null, error, loading, reload: load, setData: install };
}

export interface AutomationIntent { id: string; path: string; method: MutationMethod; body: unknown; label: string }
function readIntent(value: unknown): AutomationIntent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  return typeof input.id === 'string' && typeof input.path === 'string' && (/^(?:\/api\/(?:maniphest|suite|audit|herald|harbormaster|drydock|landings)\/|\/api\/revisions\/[DPL][1-9]\d*\/landings$|\/api\/mail\/preferences$)/.test(input.path)) && ['POST', 'PUT', 'PATCH'].includes(String(input.method)) && typeof input.label === 'string' && 'body' in input ? input as unknown as AutomationIntent : null;
}

/** Retain one immutable request before sending it; recovery is always explicit. */
export function useAutomationMutation(scope: 'maniphest' | `maniphest:${string}` | 'mail' | 'audit' | 'herald' | 'harbormaster' | 'drydock' | `suite:${string}` | `revision-builds:${string}` | `landing:${string}`, online: boolean) {
  const client = useWorkspace(), key = `draft:automation:${scope}:request`;
  const [pending, setPending] = useState(() => readIntent(client.readStored(key, null))), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const send = async <T,>(intent: AutomationIntent): Promise<T | null> => {
    if (sending.current || !online || !client.isActive()) return null;
    sending.current = true; setBusy(true); setError('');
    try {
      if (pending && JSON.stringify(pending) !== JSON.stringify(intent)) throw new Error('Resolve or export the existing unconfirmed request before starting another operation.');
      const result = await client.retainDraft(key, intent, pending);
      if (result === 'unavailable') throw new Error('This request could not be retained safely. Export the draft and refresh before submitting.');
      if (!mounted.current || !client.isActive()) return null;
      setPending(intent);
      const receipt = await client.request<T>(intent.path, { method: intent.method, id: intent.id, body: intent.body });
      if (!mounted.current || !client.isActive()) return null;
      await client.removeRetainedDraftIfEqual(key, intent);
      if (!mounted.current || !client.isActive()) return null;
      setPending(null); return receipt;
    } catch (failure) { if (mounted.current && client.isActive()) setError(isNetworkError(failure) ? 'The outcome is unknown. Retry the exact request to recover its result without duplicating it.' : automationError(failure)); return null; }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const forget = async () => { if (!pending || busy) return; if (await client.removeRetainedDraftIfEqual(key, pending)) { setPending(null); setError(''); } };
  return { pending, busy, error, send, forget, clearError: () => setError('') };
}

export function AutomationRecovery({ pending, busy, online, retry, forget }: { pending: AutomationIntent | null; busy: boolean; online: boolean; retry: () => void; forget: () => void }) {
  if (!pending) return null;
  return <section className="automation-recovery" aria-label="Unconfirmed automation request"><h3>Unconfirmed request: {pending.label}</h3><p>Its original inputs and request ID are retained. Reconnecting never sends it automatically.</p><div className="automation-actions"><button type="button" className="button" disabled={busy || !online} onClick={retry}>Retry Exact Request</button><button type="button" className="button" onClick={() => exportAutomation(pending, 'automation-request')}>Export Request</button><button type="button" className="button" disabled={busy} onClick={() => { if (window.confirm('Forget this request? Any completed server operation remains recorded.')) forget(); }}>Forget Request</button></div></section>;
}
