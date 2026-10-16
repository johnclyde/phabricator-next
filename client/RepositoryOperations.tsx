import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { isRepositoryOperations, validRepositorySyncReceipt, type RepositoryOperations as Operations } from '../shared/repository-sync';
import { useWorkspace } from './SessionGate';
import { AutomationPanel, automationError, exportAutomation, useAutomationRead } from './AutomationSupport';
import { isNetworkError } from './offline';
import { repositorySyncIntent, type RepositorySyncIntent } from './repository-operations';
import './repository-operations.css';

const modes = { observe: 'Observed externally', host: 'Hosted here', unconfigured: 'Not configured' };
const states = { idle: 'Idle', queued: 'Queued', running: 'Running', retrying: 'Waiting to retry', failed: 'Failed' };
function timestamp(value: string | null): string { return value ? new Date(value).toLocaleString() : 'Never'; }

export default function RepositoryOperations({ repositoryId, online, canEdit }: { repositoryId: string; online: boolean; canEdit: boolean }) {
  const client = useWorkspace(), session = client.session, path = `/api/repositories/${repositoryId}/operations`;
  const read = useAutomationRead<Operations>(path, online), key = `draft:repository-sync:${repositoryId}:request`;
  const [pending, setPending] = useState(() => repositorySyncIntent(client.readStored(key, null), repositoryId));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true), sending = useRef(false), current = useRef({ client, online, canEdit, pending });
  current.current = { client, online, canEdit, pending };
  const data = read.data && isRepositoryOperations(read.data, repositoryId) ? read.data : null;
  const snapshot = data?.snapshot;
  const invalid = read.data && !data ? 'The repository operation snapshot could not be verified. Reload its status.' : '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [session, repositoryId]);
  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void read.reload(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [online, read.reload]);
  const send = async (intent: RepositorySyncIntent) => {
    const captured = current.current.client;
    const active = () => mounted.current && current.current.client.session === captured.session && captured.isActive() && !captured.unavailableObject(repositoryId);
    if (!active() || sending.current || !current.current.online || !current.current.canEdit) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (current.current.pending && JSON.stringify(current.current.pending) !== JSON.stringify(intent)) throw new Error('Resolve the saved request before starting another synchronization.');
      if (await captured.retainDraft(key, intent, current.current.pending, active) === 'unavailable') throw new Error('This request could not be retained. Refresh the repository before trying again.');
      if (!active()) return;
      current.current.pending = intent; setPending(intent);
      const result = await captured.request<Operations>(`${path}/sync`, { method: 'POST', id: intent.requestId, body: intent.input });
      if (!active()) return;
      if (!validRepositorySyncReceipt(result, repositoryId, intent.requestId, intent.input) || result.accessEpoch !== captured.session?.accessEpoch) throw new Error('The synchronization receipt could not be verified. Keep this request and retry it exactly.');
      await captured.removeRetainedDraftIfEqual(key, intent, active);
      if (!active()) return;
      current.current.pending = null; setPending(null); read.setData(result);
      setNotice(result.receipt?.replayed ? 'Recovered the original synchronization request. Reload status to follow its progress.' : 'Synchronization requested. The server will process it in the background.');
      void read.reload();
    } catch (failure) {
      if (active()) setError(isNetworkError(failure) ? 'The response was lost. Retry this exact request to recover its result without scheduling a duplicate.' : automationError(failure));
    } finally { sending.current = false; if (active()) setBusy(false); }
  };
  const forget = async () => {
    const intent = current.current.pending;
    if (!intent || sending.current) return;
    if (await client.removeRetainedDraftIfEqual(key, intent) && client.isActive()) { current.current.pending = null; setPending(null); setError(''); setNotice('Local recovery request cleared. Any server operation remains recorded.'); }
  };
  const begin = () => {
    if (!data?.canSync || !snapshot?.configuration || pending) return;
    void send({ repositoryId, requestId: crypto.randomUUID(), input: { expectedConfiguration: snapshot.configuration, expectedAccessEpoch: data.accessEpoch } });
  };
  return <AutomationPanel title="Repository Operations" className="repository-operations" actions={<button type="button" className="button" disabled={!online || read.loading} onClick={() => void read.reload()}><RefreshCw size={15}/>{read.loading ? 'Loading Status…' : 'Reload Status'}</button>}>
    {!online && <p className="info-strip">Offline: repository operations are read-only. Reconnect to inspect current synchronization status. No synchronization request is sent automatically from this browser.</p>}
    {(read.error || invalid) && <p className="error-text" role="alert">{read.error || invalid}</p>}
    {!snapshot && online && !read.error && !invalid && <p className="muted">Loading repository operations…</p>}
    {snapshot && <>
      <div className="repository-operation-heading"><strong>{modes[snapshot.mode]}</strong>{snapshot.intervalSeconds && <span className="muted">Automatic synchronization every {snapshot.intervalSeconds < 60 ? `${snapshot.intervalSeconds} seconds` : `${Number((snapshot.intervalSeconds / 60).toFixed(1))} minutes`}</span>}</div>
      <p>{snapshot.mode === 'observe' ? 'The external upstream is authoritative. Refreshing imports its branches and tags; your currently selected source stays pinned to its exact commit.' : snapshot.mode === 'host' ? 'This server is authoritative. Accepted pushes and landed revisions can be published to the configured mirrors.' : 'A server operator can configure this repository for observation or hosting.'}</p>
      {data?.cloneUrl && <label className="field repository-clone-url"><span>HTTPS clone URL</span><input readOnly value={data.cloneUrl} onFocus={event => event.currentTarget.select()}/><small>Use an API token as the Git password. {snapshot.mode === 'host' ? 'Read permission is required to clone; pushes also require write scope and repository edit permission.' : 'Observed repositories support clone and fetch with read permission. Push to the authoritative upstream.'}</small></label>}
      {data && 'pendingReceives' in data && typeof data.pendingReceives === 'number' && data.pendingReceives > 0 && <p className="info-strip" role="status">{data.pendingReceives} push operation{data.pendingReceives === 1 ? ' is' : 's are'} awaiting completion or reconciliation. An operator may need to complete receive processing.</p>}
      <div className="repository-operation-targets">{snapshot.targets.map(target => <article className="repository-operation-target" key={target.key} aria-label={`${target.direction === 'fetch' ? 'Upstream' : 'Mirror'} ${target.key}`}>
        <div className="repository-operation-heading"><h3>{target.direction === 'fetch' ? <Download size={17}/> : <Upload size={17}/>} {target.direction === 'fetch' ? 'Upstream' : 'Mirror'}: {target.key}</h3><span className={`badge repository-sync-${target.state}`}>{states[target.state]}</span></div>
        <dl><div><dt>Last successful sync</dt><dd>{timestamp(target.lastSuccessAt)}</dd></div><div><dt>Last attempt</dt><dd>{timestamp(target.lastAttemptAt)}</dd></div>{target.nextAttemptAt && <div><dt>Next attempt</dt><dd>{timestamp(target.nextAttemptAt)}</dd></div>}</dl>
        {target.lastError && <p className="error-text" role="status">{target.lastError}</p>}
        {target.consecutiveFailures > 0 && <p className="muted small">{target.consecutiveFailures} consecutive failed attempt{target.consecutiveFailures === 1 ? '' : 's'}</p>}
      </article>)}</div>
      {!snapshot.targets.length && snapshot.mode === 'host' && <p className="muted">No outbound mirrors are configured.</p>}
      {data?.canSync && <button type="button" className="button primary" disabled={!online || !canEdit || busy || !!pending || !snapshot.configuration} onClick={begin}><RefreshCw size={15}/>{busy ? 'Requesting…' : snapshot.mode === 'observe' ? 'Refresh Now' : 'Sync Mirrors'}</button>}
      {!!snapshot.recentAttempts.length && <details className="repository-sync-history"><summary>Recent synchronization attempts</summary><ol>{snapshot.recentAttempts.map(attempt => <li key={attempt.id}><div><strong>{attempt.targetKey}</strong> · {attempt.status}</div><div className="muted small">Started {timestamp(attempt.startedAt)}{attempt.finishedAt ? ` · Finished ${timestamp(attempt.finishedAt)}` : ''}{attempt.changedRefs !== null ? ` · ${attempt.changedRefs} changed references` : ''}</div>{attempt.message && <p>{attempt.message}</p>}</li>)}</ol></details>}
    </>}
    {pending && <section className="repository-sync-recovery" aria-label="Unconfirmed synchronization request"><h3>Unconfirmed synchronization request</h3><p>The original configuration and request ID are retained. Retrying cannot silently switch an upstream refresh into a mirror push.</p><div className="repository-operation-actions"><button type="button" className="button" disabled={!online || !canEdit || busy} onClick={() => void send(pending)}>Retry Exact Request</button><button type="button" className="button" onClick={() => exportAutomation(pending, `${repositoryId}-synchronization-request`)}>Export Request</button><button type="button" className="button" disabled={busy} onClick={() => void forget()}>Forget Request</button></div></section>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className="info-strip" role="status">{notice}</p>}
  </AutomationPanel>;
}
