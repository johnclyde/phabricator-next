import { useEffect, useRef, useState } from 'react';
import type { SuiteImportProvenance } from '../shared/suite-import';
import { useWorkspace } from './SessionGate';
import { AutomationPanel, automationError, exportAutomation, useAutomationRead } from './AutomationSupport';

type History = SuiteImportProvenance & { accessEpoch: number };
/** Historical source stays in this tab; every export rechecks current authority. */
export function SuiteImportHistory({ recordId, online }: { recordId: string; online: boolean }) {
  const client = useWorkspace(), [openedFor, setOpenedFor] = useState<typeof client | null>(null), [page, setPage] = useState(0), [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
  const opened = openedFor === client, path = `/api/suite-import/provenance/${recordId}`;
  const read = useAutomationRead<History>(opened ? path : null, online), live = useRef(true), generation = useRef(0), current = useRef({ client, recordId, opened, online }); current.current = { client, recordId, opened, online };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { generation.current++; setExporting(false); }, [client, recordId, opened, online]);
  const data = online && client.isActive() && read.data?.accessEpoch === client.session?.accessEpoch ? read.data : null;
  const exportCurrent = async () => {
    if (exporting || !online || !opened || !client.isActive()) return;
    setExporting(true); setExportError('');
    const ticket = ++generation.current;
    const valid = () => ticket === generation.current && live.current && current.current.client === client && current.current.recordId === recordId && current.current.opened && current.current.online && client.isActive();
    try {
      const result = await client.request<History>(path);
      if (!valid()) return;
      if (result.accessEpoch !== client.session?.accessEpoch) throw new Error('Access changed. Refresh before exporting imported history.');
      exportAutomation(result, `${recordId}-imported-history`);
    } catch (error) { if (valid()) { read.setData(null); setExportError(automationError(error)); } }
    finally { if (valid()) setExporting(false); }
  };
  if (!opened) return <AutomationPanel title="Imported History"><p className="small muted">Original source evidence is available to current editors when this object came from an import.</p><button className="button" disabled={!online} onClick={() => { setOpenedFor(client); setPage(0); }}>Inspect Imported History</button></AutomationPanel>;
  const rows = data?.rows.slice(page * 25, (page + 1) * 25) ?? [], missing = /not found/i.test(read.error);
  return <AutomationPanel title="Imported History" actions={<button className="button" onClick={() => { generation.current++; setOpenedFor(null); read.setData(null); setExportError(''); setExporting(false); }}>Close</button>}>
    {!online && <p className="info-strip">Reconnect to inspect current authorized history.</p>}
    {read.loading && <p role="status">Loading imported history…</p>}
    {missing && <p className="muted">No imported history is available for this object.</p>}
    {read.error && !missing && <p className="banner error" role="alert">{read.error}</p>}
    {exportError && <p className="banner error" role="alert">{exportError}</p>}
    {data && <>
      <p className="info-strip">Historical, unverified source evidence. Imported author, vote, attendance, and signature claims do not establish current decisions or permissions.</p>
      <dl className="automation-properties"><dt>Source</dt><dd>{data.sourceKey} · {data.sourcePHID}</dd><dt>Imported</dt><dd>{new Date(data.importedAt).toLocaleString()} · {data.importedBy}</dd><dt>Original dates</dt><dd>{data.sourceCreatedAt ?? 'Unknown'} → {data.sourceModifiedAt ?? 'Unknown'}</dd><dt>Original author</dt><dd>{data.sourceAuthorPHID ?? 'Not recorded'}</dd></dl>
      {data.warnings.length > 0 && <details><summary>Import notes ({data.warnings.length})</summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="automation-actions"><button className="button" disabled={!online || exporting || read.loading} onClick={() => void exportCurrent()}>{exporting ? 'Authorizing Export…' : 'Export Imported History'}</button><button className="button" disabled={!online || read.loading} onClick={() => void read.reload()}>Refresh History</button></div>
      <p className="small muted">Source rows {data.rows.length ? page * 25 + 1 : 0}–{Math.min((page + 1) * 25, data.rows.length)} of {data.rows.length}. Original storage fields are shown as text.</p>
      {rows.map((row, index) => <details key={`${page}-${index}`}><summary>{row.table} · {row.fields.phid ?? row.fields.id}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(row.fields, null, 2)}</pre></details>)}
      <div className="automation-actions"><button className="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous Source Rows</button><button className="button" disabled={(page + 1) * 25 >= data.rows.length} onClick={() => setPage(value => value + 1)}>Next Source Rows</button></div>
    </>}
  </AutomationPanel>;
}
