import { useEffect, useState } from 'react';
import type { OwnersRoutingHistory } from '../shared/owners-routing';
import type { AppState } from '../shared/types';
import { AutomationPanel, AutomationRefresh, useAutomationRead } from './AutomationSupport';

/** Displays recorded routing decisions; reading never reruns ownership automation. */
export default function OwnersRouting({ objectId, online, state }: { objectId: string; online: boolean; state: AppState }) {
  const [open, setOpen] = useState(false), [cursors, setCursors] = useState<(number | null)[]>([null]);
  useEffect(() => { setOpen(false); setCursors([null]); }, [objectId]);
  const before = cursors.at(-1), path = open ? `/api/owners-routing/${encodeURIComponent(objectId)}?limit=25${before == null ? '' : `&before=${before}`}` : null;
  const history = useAutomationRead<OwnersRoutingHistory>(path, online);
  const person = (id: string) => state.principals.find(value => value.id === id)?.displayName ?? 'Unavailable member';
  return <AutomationPanel title="Owners routing" actions={<button className="button" onClick={() => { setOpen(value => !value); setCursors([null]); }}>{open ? 'Hide routing history' : 'Show routing history'}</button>}>
    <p>Recorded package matches and automatic review or audit requests stay tied to their original source.</p>
    {open && <div className="owners-routing-history" aria-label="Owners routing history">
      <AutomationRefresh busy={history.loading} online={online} refresh={() => { setCursors([null]); void history.reload(); }}/>
      {history.error && <p role="alert" className="error-text">{history.error}</p>}
      {history.data && !history.data.records.length && <p>No routing records are visible for this page.</p>}
      {history.data?.records.map(record => <article key={record.id} className="automation-record">
        <h3>{record.source.kind === 'revision' ? 'Revision source' : 'Commit'} · {new Date(record.createdAt).toLocaleString()}</h3>
        <p style={{ overflowWrap: 'anywhere' }}><strong>Source:</strong> <code>{record.source.versionId}</code></p>
        <p>Paths inspected against {record.source.basis.replaceAll('-', ' ')}.</p>
        {record.packages.length ? record.packages.map(result => <section key={result.package.id}>
          <h4><a href={`#owners/${result.package.id}`}>{result.package.name}</a> · package version {result.package.version}</h4>
          <p>{result.mode.replaceAll('-', ' ')} · {result.status} · {result.reason.replaceAll('-', ' ')}</p>
          {result.appliedIds.length > 0 && <p>Routed to: {result.appliedIds.map(person).join(', ')}</p>}
          <details><summary>Matched paths ({result.paths.length})</summary><ul>{result.paths.map(value => <li key={value} style={{ overflowWrap: 'anywhere' }}><code>{value}</code></li>)}</ul></details>
        </section>) : <p>No package details are visible in this record.</p>}
      </article>)}
      <div className="automation-actions"><button className="button" disabled={history.loading || cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Newer routing records</button><button className="button" disabled={history.loading || history.data?.nextBefore == null} onClick={() => { if (history.data?.nextBefore != null) setCursors(value => [...value, history.data!.nextBefore]); }}>Older routing records</button></div>
    </div>}
  </AutomationPanel>;
}
