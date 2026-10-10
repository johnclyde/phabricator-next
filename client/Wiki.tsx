import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, GitCompareArrows, History, Pencil, RotateCcw, WifiOff } from 'lucide-react';
import { diffLines, diffWordsWithSpace } from 'diff';
import type { WikiDetail, WikiDocument, WikiHistory, WikiVersion } from '../shared/types';
import { isNetworkError, type MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';

type WikiMutation = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
type WikiTab = 'document' | 'compare' | 'history';
function date(value: string): string { return new Date(value).toLocaleString(); }
function author(version: WikiVersion): string { return version.author || 'Unknown (legacy snapshot)'; }

/** Phriction's source history is immutable; viewing an old version never edits it. */
export default function Wiki({ id, currentVersion, online, mutate, edit }: {
  id: string;
  currentVersion?: number;
  online: boolean;
  mutate: WikiMutation;
  edit: (document: WikiDocument) => void;
}) {
  const { readStored, writeStored, request, durable, assertActive } = useWorkspace();
  const [detail, setDetail] = useState<WikiDetail | null>(() => readStored(`wiki:${id}`, null));
  const [tab, setTab] = useState<WikiTab>('document');
  const [selected, setSelected] = useState<number | null>(null);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [diffMode, setDiffMode] = useState<'words' | 'lines'>('words');
  const [versions, setVersions] = useState<Record<number, WikiVersion>>({});
  const loaded = useRef<Record<number, WikiVersion>>({});
  const inFlight = useRef(new Map<number, Promise<WikiVersion | null>>());
  const loadGeneration = useRef(0);
  const [versionErrors, setVersionErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [snapshot, setSnapshot] = useState(true);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const saveVersion = useCallback((version: WikiVersion) => {
    loaded.current[version.number] = version;
    setVersions(current => ({ ...current, [version.number]: version }));
    if (!writeStored(`wiki:${id}:version:${version.number}`, version)) setStorageWarning('Browser storage is unavailable. This version is visible now but was not saved for offline reading.');
  }, [id]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await request<WikiDetail>(`/api/documents/${id}`);
      if (generation !== loadGeneration.current) return null;
      setDetail(next); setSnapshot(false); setError('');
      if (!writeStored(`wiki:${id}`, next)) setStorageWarning('Browser storage is unavailable. This history was not saved for offline reading.');
      const current = next.history.versions.find(version => version.number === next.document.version);
      if (current) saveVersion({ ...current, content: next.document.content });
      return next;
    } catch (failure) {
      if (generation !== loadGeneration.current) return null;
      if (isNetworkError(failure)) {
        setSnapshot(true);
        if (!readStored(`wiki:${id}`, null)) setError(durable ? 'This document has not been saved on this device. Reconnect to open its history.' : 'This document has not been loaded in this session. Reconnect to open its history.');
      } else setError(failure instanceof Error ? failure.message : 'Could not load this document.');
      return null;
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [id, saveVersion]);
  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load, currentVersion, online]);
  useEffect(() => { setSelected(null); }, [currentVersion]);

  const loadVersion = useCallback((number: number): Promise<WikiVersion | null> => {
    if (loaded.current[number]) return Promise.resolve(loaded.current[number]);
    const cached = readStored<WikiVersion | null>(`wiki:${id}:version:${number}`, null);
    if (cached) { loaded.current[number] = cached; setVersions(current => ({ ...current, [number]: cached })); return Promise.resolve(cached); }
    const pending = inFlight.current.get(number);
    if (pending) return pending;
    const result = (async () => {
      setVersionErrors(current => ({ ...current, [number]: '' }));
      try {
        const version = await request<WikiVersion>(`/api/documents/${id}/versions/${number}`);
        saveVersion(version); return version;
      } catch (failure) {
        setVersionErrors(current => ({ ...current, [number]: isNetworkError(failure)
          ? durable ? `Version ${number} has not been saved on this device. Reconnect to read it.` : `Version ${number} has not been loaded in this session. Reconnect to read it.`
          : failure instanceof Error ? failure.message : `Could not load version ${number}.` }));
        return null;
      } finally { inFlight.current.delete(number); }
    })();
    inFlight.current.set(number, result);
    return result;
  }, [id, saveVersion]);

  const number = selected ?? detail?.document.version ?? 1;
  const first = detail?.history.firstAvailableVersion ?? 1;
  const last = detail?.document.version ?? 1;
  const baseline = compareWith ?? Math.max(first, last - 1);
  const valid = (value: number) => Number.isSafeInteger(value) && value >= first && value <= last;
  const validNumber = valid(number), validBaseline = valid(baseline);
  useEffect(() => {
    if (!detail || tab === 'history') return;
    if (validNumber) void loadVersion(number);
    if (tab === 'compare' && validBaseline) void loadVersion(baseline);
  }, [detail?.document.version, tab, number, baseline, validNumber, validBaseline, loadVersion, online]);
  const version = versions[number];
  const before = versions[baseline];
  const changes = useMemo(() => {
    if (tab !== 'compare' || !version || !before) return null;
    const options = { timeout: 500, maxEditLength: 10_000 };
    return diffMode === 'words' ? diffWordsWithSpace(before.content, version.content, options) : diffLines(before.content, version.content, options);
  }, [tab, version, before, diffMode]);

  const older = async () => {
    if (!detail || detail.history.nextBefore === null) return;
    const generation = loadGeneration.current;
    setPaging(true); setError('');
    try {
      const page = await request<WikiHistory>(`/api/documents/${id}/history?before=${detail.history.nextBefore}&limit=20`);
      if (generation !== loadGeneration.current) return;
      setDetail(current => {
        if (!current) return current;
        const rows = new Map([...current.history.versions, ...page.versions].map(item => [item.number, item]));
        const next = { ...current, history: { ...page, versions: [...rows.values()].sort((a, b) => b.number - a.number) } };
        if (!writeStored(`wiki:${id}`, next)) setStorageWarning('Browser storage is unavailable. Older history was not saved for offline reading.');
        return next;
      });
    } catch (failure) { if (generation === loadGeneration.current) setError(isNetworkError(failure) ? 'Older history has not been saved on this device. Reconnect to load it.' : failure instanceof Error ? failure.message : 'Could not load older history.'); }
    finally { setPaging(false); }
  };

  const restore = async () => {
    if (!detail || !version || !online || snapshot || version.number === detail.document.version) return;
    if (!window.confirm(`Restore version ${version.number} of “${version.title}” as a new version? The current title and content will be replaced. The current slug and every historical version will be kept.`)) return;
    setRestoring(true); setError('');
    try {
      await mutate<WikiDocument>(`/api/documents/${id}/restore`, 'POST', { version: version.number, expectedVersion: detail.document.version }, `Version ${version.number} restored as a new document version`, false);
      assertActive(); setSelected(null); setTab('document'); await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not restore this version.'); }
    finally { setRestoring(false); }
  };

  if (!detail) return <section className="panel wiki-page"><div className="panel-heading"><h2><BookOpen size={17}/>Document history</h2><a href="#wiki">All documents</a></div><div className="wiki-status">{error ? <p role="alert">{error}</p> : <p>Loading document…</p>}<button className="button" disabled={loading} onClick={() => void load()}>Retry</button></div></section>;

  const unavailable = (value: number) => !valid(value) ? `Choose a version between ${first} and ${last}.` : versionErrors[value] || `Loading version ${value}…`;
  return <div className="wiki-page">
    <a className="back-link" href="#wiki"><ArrowLeft size={14}/>All documents</a>
    <div className="page-heading wiki-page-heading"><div><h1><span className="object-id">{id}</span> {detail.document.title}</h1><p>{detail.document.slug} · Current version {detail.document.version}</p></div><button className="button primary" disabled={!online || snapshot || loading} onClick={() => edit(detail.document)}><Pencil size={15}/>Edit Document</button></div>
    {snapshot && <div className="banner warning"><WifiOff size={16}/><span>{durable ? 'Saved document snapshot. Only versions opened on this device are available offline. Reconnect before editing or restoring.' : 'Connection interrupted. Loaded versions are kept only in this session. Reconnect before editing or restoring.'}</span></div>}
    {storageWarning && <div className="banner warning" role="status">{storageWarning}</div>}
    {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={() => void load()} disabled={loading}>Reload document</button></div>}
    {first > 1 && <div className="info-strip wiki-history-gap">Retained history starts at version {first}. Earlier versions were not stored by the previous application and cannot be recovered here.</div>}
    <section className="panel">
      <div className="review-tabs wiki-tabs" role="tablist" aria-label="Document views" onKeyDown={event => {
        const tabs: WikiTab[] = ['document', 'compare', 'history'];
        const next = event.key === 'ArrowRight' ? tabs[(tabs.indexOf(tab) + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(tabs.indexOf(tab) + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : null;
        if (next) { event.preventDefault(); setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus(); }
      }}>
        {([{ id: 'document', label: 'Document', icon: BookOpen }, { id: 'compare', label: 'Compare', icon: GitCompareArrows }, { id: 'history', label: 'History', icon: History }] as const).map(item => <button key={item.id} data-tab={item.id} role="tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}><item.icon size={15}/>{item.label}</button>)}
      </div>
      {tab !== 'history' && <div className="wiki-controls">
        <label>Version to inspect<input type="number" min={first} max={last} step="1" value={number} onChange={event => setSelected(Number(event.target.value))}/></label>
        {tab === 'compare' && <><label>Compare with version<input type="number" min={first} max={last} step="1" value={baseline} onChange={event => setCompareWith(Number(event.target.value))}/></label><div className="segmented" aria-label="Comparison style"><button aria-pressed={diffMode === 'words'} className={diffMode === 'words' ? 'selected' : ''} onClick={() => setDiffMode('words')}>Words</button><button aria-pressed={diffMode === 'lines'} className={diffMode === 'lines' ? 'selected' : ''} onClick={() => setDiffMode('lines')}>Lines</button></div></>}
        {number !== last && <button className="text-button" onClick={() => setSelected(null)}>Current version</button>}
      </div>}
      {tab === 'document' && (version && validNumber ? <>
        <div className="wiki-version-heading"><div><span className={`badge ${number === last ? 'badge-accepted' : 'badge-draft'}`}>{number === last ? 'Current' : 'Historical'} · Version {number}</span><h2>{version.title}</h2><p>{version.slug} · {author(version)} · {date(version.createdAt)}</p>{version.message && <p className="wiki-edit-summary">{version.message}</p>}{version.kind === 'legacy' && <p>This snapshot predates recorded authorship and full history.</p>}</div>{number !== last && <button className="button" disabled={!online || snapshot || restoring || loading} onClick={() => void restore()}><RotateCcw size={15}/>{restoring ? 'Restoring…' : 'Restore as new version'}</button>}</div>
        <pre className="wiki-content">{version.content}</pre>
      </> : <p className="wiki-status" role="status">{unavailable(number)}</p>)}
      {tab === 'compare' && (version && before && validNumber && validBaseline ? <div className="wiki-comparison">
        <div className="wiki-comparison-heading"><strong>Version {baseline} → Version {number}</strong><span>{before.title === version.title ? version.title : `${before.title} → ${version.title}`}</span>{before.slug !== version.slug && <span>Slug: {before.slug} → {version.slug}</span>}</div>
        <div className="diff-legend"><span><i className="legend-add"/> Added</span><span><i className="legend-remove"/> Removed</span><small>Comparison preserves source whitespace.</small></div>
        {changes ? <div className={`wiki-diff wiki-diff-${diffMode}`} aria-label={`Changes from version ${baseline} to version ${number}`}>{changes.map((change, index) => change.added ? <ins key={index}>{change.value}</ins> : change.removed ? <del key={index}>{change.value}</del> : <span key={index}>{change.value}</span>)}</div> : <div className="wiki-status">This comparison is too large for an interactive diff. Inspect each version separately.</div>}
        {before.content === version.content && <p className="wiki-status">No content changes between these versions.</p>}
      </div> : <div className="wiki-status" role="status">{(!version || !validNumber) && <p>{unavailable(number)}</p>}{(!before || !validBaseline) && <p>{unavailable(baseline)}</p>}</div>)}
      {tab === 'history' && <div className="wiki-history">
        <p className="info-strip">Every saved edit keeps an immutable version. Restoring adds a new version and preserves the current slug.</p>
        <ol>{detail.history.versions.map(item => <li key={item.id}><button className="wiki-history-entry" onClick={() => { setSelected(item.number); setTab('document'); }}><span className="version-marker" aria-hidden="true">{item.number}</span><span><strong>Version {item.number} · {item.title}</strong><small>{item.message || (item.kind === 'create' ? 'Document created' : item.kind === 'legacy' ? 'Retained legacy snapshot' : 'Document edited')}</small><small>{item.author || 'Unknown author'} · {date(item.createdAt)}{item.restoredFrom !== null ? ` · Restored from version ${item.restoredFrom}` : ''}</small></span></button></li>)}</ol>
        {detail.history.nextBefore !== null && <div className="wiki-status"><button className="button" disabled={paging || !online || snapshot} onClick={() => void older()}>{paging ? 'Loading history…' : 'Load older history'}</button>{(!online || snapshot) && <p>Reconnect to load history not yet saved on this device.</p>}</div>}
      </div>}
    </section>
    {detail.activity.length > 0 && <section className="panel wiki-activity"><div className="panel-heading"><h2>Document activity</h2></div><ol>{detail.activity.map(item => <li key={item.id}><p>{item.detail}</p><small>{item.actor} · {date(item.createdAt)}</small></li>)}</ol></section>}
  </div>;
}
