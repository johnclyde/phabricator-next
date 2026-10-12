import ObjectSubscriptions from './ObjectSubscriptions';
import { RemarkupBody, type WikiRemarkupNavigation } from './Remarkup';
import { wikiContentHref, type WikiLinkSelection } from '../shared/wiki-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, GitCompareArrows, History, Pencil, RotateCcw, WifiOff } from 'lucide-react';
import { diffLines, diffWordsWithSpace } from 'diff';
import type { AppState, WikiDetail, WikiDocument, WikiHistory, WikiVersion } from '../shared/types';
import { isNetworkError, type MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';
import { AccessSummary } from './Access';
import { mergeWikiHistory, mergeWikiLifecycle } from './wiki-history';
import { WikiMoveDialog, WikiNavigation } from './WikiNavigation';
import { wikiHref } from './wiki-client';
import { canonicalWikiPath } from '../shared/wiki';
import DraftAvailability from './DraftAvailability';
import { exportWikiDraft, useWikiAction, WikiActionDialog, WikiEditor } from './WikiLifecycle';
import type { WikiLifecycleHistory } from '../shared/wiki';

type WikiMutation = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
type WikiTab = 'document' | 'compare' | 'history';
function date(value: string): string { return new Date(value).toLocaleString(); }
function author(version: WikiVersion): string { return version.author || 'Unknown (legacy snapshot)'; }
interface WikiReadingSelection { routeKey: string; selected: number | null; section: string | null; error: string | null; tab: WikiTab; focus: number }
function initialReading(navigation: WikiLinkSelection): WikiReadingSelection { return { routeKey: navigation.key, selected: navigation.version, section: navigation.section, error: navigation.error, tab: 'document', focus: 0 }; }

/** Phriction's source history is immutable; viewing an old version never edits it. */
export default function Wiki({ onOpened, id, currentVersion, publicationRevision, navigation, online, state, manageAccess, mutate, edit, create, refreshWorkspace }: {
  onOpened: (id: string) => void;
  create: (path: string) => void;
  refreshWorkspace: () => Promise<void>;
  id: string;
  currentVersion?: number;
  publicationRevision?: number;
  navigation?: WikiLinkSelection;
  online: boolean;
  state: AppState;
  manageAccess: () => void;
  mutate: WikiMutation;
  edit: (document: WikiDocument) => void;
}) {
  const { readStored, writeStored, request, durable, assertActive, isActive, unavailableObject, onTaskSnapshotChange, session, savedDraftRecords } = useWorkspace();
  const [detail, setDetail] = useState<WikiDetail | null>(() => readStored(`wiki:${id}`, null));
  const [moving, setMoving] = useState(false);
  const [editor, setEditor] = useState<WikiDetail | null>(null);
  const [operation, setOperation] = useState<{ kind: 'publish' | 'delete' | 'restore'; detail: WikiDetail; target: WikiVersion | null } | null>(null);
  const [lifecyclePaging, setLifecyclePaging] = useState(false);
  const routeNavigation = navigation ?? { version: null, section: null, error: null, key: `path:${id}` };
  const [reading, setReading] = useState<WikiReadingSelection>(() => initialReading(routeNavigation));
  const currentReading = reading.routeKey === routeNavigation.key ? reading : initialReading(routeNavigation);
  if (reading !== currentReading) setReading(currentReading);
  const readingRef = useRef(currentReading); readingRef.current = currentReading;
  const { tab, selected, section, error: linkError } = currentReading;
  const changeReading = (patch: Partial<Pick<WikiReadingSelection, 'tab' | 'selected'>>) => {
    const next = { ...readingRef.current, ...patch, section: null, error: null, focus: readingRef.current.focus + 1 };
    const href = next.selected !== null && Number.isSafeInteger(next.selected) && next.selected > 0 ? wikiContentHref(id, next.selected) : `#${id}`;
    next.routeKey = navigation ? href.slice(1) : routeNavigation.key; readingRef.current = next; setReading(next);
    if (navigation && window.location.hash !== href) { window.history.replaceState(window.history.state, '', href); window.dispatchEvent(new Event('hashchange')); }
  };
  const setTab = (tab: WikiTab) => changeReading({ tab });
  const setSelected = (selected: number | null) => changeReading({ selected });
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [diffMode, setDiffMode] = useState<'words' | 'lines'>('words');
  const [versions, setVersions] = useState<Record<number, WikiVersion>>({});
  const loaded = useRef<Record<number, WikiVersion>>({});
  const inFlight = useRef(new Map<number, Promise<WikiVersion | null>>());
  const loadGeneration = useRef(0);
  const pageGeneration = useRef(0);
  const lifecyclePageGeneration = useRef(0);
  const mounted = useRef(true);
  const [versionErrors, setVersionErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [snapshot, setSnapshot] = useState(true);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pageGeneration.current += 1; lifecyclePageGeneration.current += 1; }; }, []);

  const saveVersion = useCallback((version: WikiVersion) => {
    if (unavailableObject(id)) return;
    loaded.current[version.number] = version;
    setVersions(current => ({ ...current, [version.number]: version }));
    if (!writeStored(`wiki:${id}:version:${version.number}`, { ...version, accessEpoch: version.accessEpoch ?? session?.accessEpoch })) setStorageWarning('Browser storage is unavailable. This version is visible now but was not saved for offline reading.');
  }, [id]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await request<WikiDetail>(`/api/documents/${id}`);
      if (generation !== loadGeneration.current) return null;
      setDetail(current => {
        const merged = { ...next, ...(next.lifecycle && next.document.publication ? { lifecycle: mergeWikiLifecycle(next.document.publication.revision, next.lifecycle, current?.document.id === id ? current.lifecycle : undefined) } : {}), history: mergeWikiHistory(next.document.version, next.history, current?.document.id === id ? current.history : undefined) };
        if (!writeStored(`wiki:${id}`, merged)) setStorageWarning('Browser storage is unavailable. This history was not saved for offline reading.');
        return merged;
      });
      setSnapshot(false); setError(''); onOpened(id);
      const published = next.document.publication?.publishedVersion ?? next.document.version;
      const current = next.history.versions.find(version => version.number === published);
      if (current) saveVersion({ ...current, content: next.document.content });
      if (next.head) saveVersion(next.head);
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
  }, [load, online]);
  // Workspace discovery often arrives after this document's authorized detail.
  // Only newer content/publication counters need another read; an equal catch-up
  // must not disable an editor action or retire an unrelated pending refresh.
  useEffect(() => {
    if (detail && ((currentVersion ?? 0) > detail.document.version || (publicationRevision ?? 0) > (detail.document.publication?.revision ?? 0))) void load();
  }, [load, currentVersion, publicationRevision, detail?.document.version, detail?.document.publication?.revision]);
  useEffect(() => { const clear = () => { loadGeneration.current++; pageGeneration.current++; lifecyclePageGeneration.current++; setPaging(false); setLifecyclePaging(false); loaded.current = {}; inFlight.current.clear(); setVersions({}); setDetail(null); queueMicrotask(() => { if (mounted.current) void load(); }); }; const off = onTaskSnapshotChange(clear); const focus = () => void load(); window.addEventListener('focus', focus); return () => { off(); window.removeEventListener('focus', focus); }; }, [load]);
  // A null selection follows the published content pointer. An explicitly chosen immutable
  // version remains selected when workspace discovery or a background edit
  // changes the head; only the reader's action should leave that version.

  const loadVersion = useCallback((number: number): Promise<WikiVersion | null> => {
    if (unavailableObject(id)) return Promise.resolve(null);
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

  const published = detail?.document.publication?.publishedVersion ?? detail?.document.version ?? 1;
  const number = selected ?? published;
  const first = detail?.history.firstAvailableVersion ?? 1;
  const last = detail?.document.version ?? 1;
  const baseline = compareWith ?? (number !== published ? published : Math.max(first, number - 1));
  const valid = (value: number) => Number.isSafeInteger(value) && value >= first && value <= last;
  const validNumber = !linkError && valid(number), validBaseline = !linkError && valid(baseline);
  useEffect(() => {
    if (!detail || tab === 'history') return;
    if (validNumber) void loadVersion(number);
    if (tab === 'compare' && validBaseline) void loadVersion(baseline);
  }, [detail?.document.version, tab, number, baseline, validNumber, validBaseline, loadVersion, online]);
  const version = versions[number];
  const contentContext = !linkError && validNumber && version ? `${id}:${version.id}` : null;
  const contentContextRef = useRef(contentContext); contentContextRef.current = contentContext;
  const before = versions[baseline];
  const changes = useMemo(() => {
    if (tab !== 'compare' || !version || !before) return null;
    const options = { timeout: 500, maxEditLength: 10_000 };
    return diffMode === 'words' ? diffWordsWithSpace(before.content, version.content, options) : diffLines(before.content, version.content, options);
  }, [tab, version, before, diffMode]);

  const older = async () => {
    if (!detail || detail.history.nextBefore === null) return;
    // Head refreshes must not cancel immutable history the reader requested.
    // This counter changes on another page request or unmount, while request()
    // independently rejects a revoked object or replaced session.
    const generation = ++pageGeneration.current;
    setPaging(true); setError('');
    try {
      const page = await request<WikiHistory>(`/api/documents/${id}/history?before=${detail.history.nextBefore}&limit=20`);
      if (generation !== pageGeneration.current) return;
      setDetail(current => {
        if (!current) return current;
        const next = { ...current, history: mergeWikiHistory(current.document.version, page, current.history) };
        if (!writeStored(`wiki:${id}`, next)) setStorageWarning('Browser storage is unavailable. Older history was not saved for offline reading.');
        return next;
      });
    } catch (failure) { if (generation === pageGeneration.current) setError(isNetworkError(failure) ? 'Older history has not been saved on this device. Reconnect to load it.' : failure instanceof Error ? failure.message : 'Could not load older history.'); }
    finally { if (generation === pageGeneration.current) setPaging(false); }
  };

  const access = detail && state.accessEpoch >= (detail.accessEpoch ?? -1) ? state.access[id] : detail?.access;
  const active = !detail?.document.location || detail.document.location.status === 'active';
  const sectionNavigation: WikiRemarkupNavigation = {
    section, key: `${currentReading.routeKey}:${currentReading.focus}`, enabled: Boolean(contentContext && !loading && access?.capabilities.view),
    href: anchor => { try { return wikiContentHref(id, number, anchor); } catch { return null; } },
    isActive: () => Boolean(mounted.current && isActive() && !unavailableObject(id) && access?.capabilities.view && contentContext && contentContextRef.current === contentContext && readingRef.current === currentReading && readingRef.current.tab === 'document'),
    navigate: anchor => {
      if (!contentContext || contentContextRef.current !== contentContext || !isActive() || unavailableObject(id)) return;
      let href: string; try { href = wikiContentHref(id, number, anchor); } catch { return; }
      const next: WikiReadingSelection = { routeKey: href.slice(1), selected: number, section: anchor, error: null, tab: 'document', focus: readingRef.current.focus + 1 };
      readingRef.current = next; setReading(next); if (window.location.hash !== href) { window.history.pushState(window.history.state, '', href); window.dispatchEvent(new Event('hashchange')); }
    },
  };
  const canEdit = Boolean(access?.capabilities.edit);
  const action = useWikiAction(id, online, async () => { await refreshWorkspace(); await load(); });
  useEffect(() => {
    const completed = action.completed;
    if (!completed || readStored(completed.intent.draftKey, null) !== null) return;
    // Access changes may retire the mounted dialog before its save promise resolves.
    // Complete it here, while leaving any newer retained draft untouched.
    if (completed.intent.kind === 'edit' || completed.intent.kind === 'draft') {
      setEditor(current => current && completed.intent.draftKey === `wiki-edit:${id}:${current.head!.id}:${current.document.publication!.revision}` ? null : current);
      setSelected(completed.document.version); setTab('document');
    } else {
      setOperation(current => current && completed.intent.draftKey === `wiki-action:${id}:${current.detail.document.publication!.revision}:${current.kind}:${current.target?.id || 'current'}` ? null : current);
      if (completed.intent.kind === 'restore') { setSelected(null); setTab('document'); }
    }
  }, [action.completed]);
  const olderLifecycle = async () => {
    if (!detail?.lifecycle?.nextBefore || lifecyclePaging) return;
    const generation = ++lifecyclePageGeneration.current; setLifecyclePaging(true);
    try { const page = await request<WikiLifecycleHistory>(`/api/documents/${id}/transactions?before=${detail.lifecycle.nextBefore}&limit=20`); if (generation !== lifecyclePageGeneration.current) return; setDetail(current => { if (!current?.lifecycle) return current; const next = { ...current, lifecycle: mergeWikiLifecycle(current.document.publication!.revision, page, current.lifecycle) }; writeStored(`wiki:${id}`, next); return next; }); }
    catch (failure) { if (generation === lifecyclePageGeneration.current) setError(failure instanceof Error ? failure.message : 'Could not load publication history.'); }
    finally { if (generation === lifecyclePageGeneration.current) setLifecyclePaging(false); }
  };

  if (!detail) return <>{action.recovery}<section className="panel wiki-page"><div className="panel-heading"><h2><BookOpen size={17}/>Document history</h2><a href="#wiki">All documents</a></div><div className="wiki-status">{error ? <p role="alert">{error}</p> : <p>Loading document…</p>}<button className="button" disabled={loading} onClick={() => void load()}>Retry</button></div></section></>;

  const unavailable = (value: number) => linkError || (!valid(value) ? `Choose a version between ${first} and ${last}.` : versionErrors[value] || `Loading version ${value}…`);
  return <div className="wiki-page">
    <a className="back-link" href="#wiki"><ArrowLeft size={14}/>All documents</a>{detail.hierarchy && <WikiNavigation refreshWorkspace={refreshWorkspace} path={detail.document.location?.path || canonicalWikiPath(detail.document.slug)} hierarchy={detail.hierarchy} online={online} create={create}/>}
    <div className="page-heading wiki-page-heading"><div><h1><span className="object-id">{id}</span> {detail.document.title}</h1><p>{detail.document.slug} · Published version {published} · Latest content {detail.document.version}</p></div><div className="file-actions"><button className="button" disabled={!online || snapshot || loading || (!(canEdit && active) && !readStored(`wiki-request:${id}`, null))} onClick={() => setMoving(true)}>Move Document</button><button className="button primary" disabled={loading || !canEdit || !detail.head || !detail.document.publication} onClick={() => setEditor(detail)}><Pencil size={15}/>{active ? 'Edit Document' : 'Recreate Here'}</button>{active && <button className="button" disabled={!online || snapshot || loading || !canEdit || !detail.document.publication || action.busy || Boolean(action.pending)} onClick={() => setOperation({ kind: 'delete', detail, target: null })}>Delete Document</button>}</div></div>
    {action.recovery}
    {published < last && canEdit && <div className="banner warning">This document has unpublished draft changes. <button className="text-button" onClick={() => { setSelected(last); setTab('document'); }}>View Draft Version</button></div>}
    {detail.document.location?.status === 'deleted' && <section className="panel card-body wiki-moved"><h2>Document Deleted</h2><p>The document identity is deleted. History and child documents remain. Recreate this page or restore nonempty earlier content to reactivate it.</p></section>}
    {editor?.head && canEdit && <DraftAvailability draftKey={`wiki-edit:${id}:${editor.head.id}:${editor.document.publication!.revision}`}><WikiEditor error={action.error} detail={editor} online={online} busy={action.busy} pending={Boolean(action.pending)} send={action.send} close={saved => { setEditor(null); if (saved) { setSelected(saved.version); setTab('document'); } }}/></DraftAvailability>}
    {operation && canEdit && <DraftAvailability draftKey={`wiki-action:${id}:${operation.detail.document.publication!.revision}:${operation.kind}:${operation.target?.id || 'current'}`}><WikiActionDialog error={action.error} {...operation} online={online} busy={action.busy} pending={Boolean(action.pending)} send={action.send} close={saved => { if (saved && operation.kind === 'restore') { setSelected(null); setTab('document'); } setOperation(null); }}/></DraftAvailability>}
    {detail.document.location?.status === 'moved' && <section className="panel card-body wiki-moved"><h2>This Document Has Moved</h2>{detail.hierarchy?.movedTo ? <p>Continue at <a href={wikiHref(detail.hierarchy.movedTo.path)}>{detail.hierarchy.movedTo.title} ({detail.hierarchy.movedTo.id})</a>.</p> : <p>The destination is unavailable.</p>}<p>The original history remains here. Child documents keep their existing paths.</p></section>}
    {savedDraftRecords(`draft:document:${id}:`).length > 0 && <section className="panel card-body"><h2>Retained Source Drafts</h2><p>Unsaved drafts remain attached to this original document. They have not moved to the destination.</p>{savedDraftRecords(`draft:document:${id}:`).map(item => <button key={item.key} className="button" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-retained-draft.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export {item.key.split(':').at(-1)} Draft</button>)}</section>}
    {moving && <DraftAvailability draftKey={`wiki-move:${id}`}><WikiMoveDialog refreshWorkspace={refreshWorkspace} detail={detail} online={online} close={() => setMoving(false)} saved={async () => { await refreshWorkspace(); await load(); }}/></DraftAvailability>}
    <AccessSummary access={access} spaces={state.spaces} manage={manageAccess}/><ObjectSubscriptions id={id} state={state} online={online} refreshWorkspace={refreshWorkspace}/>
    {linkError && <div className="banner error" role="alert"><span>{linkError}</span><button className="button" onClick={() => { setSelected(null); setTab('document'); }}>Published Version</button></div>}
    {snapshot && <div className="banner warning"><WifiOff size={16}/><span>{durable ? 'Saved document snapshot. Only versions opened on this device are available offline. Local drafts remain editable. Reconnect before saving or publishing.' : 'Connection interrupted. Loaded versions are kept only in this session. Local drafts remain editable. Reconnect before saving or publishing.'}</span></div>}
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
        {selected !== null && <button className="text-button" onClick={() => setSelected(null)}>Published Version</button>}{number !== last && <button className="text-button" onClick={() => setSelected(last)}>Latest Content</button>}
      </div>}
      {tab === 'document' && (version && validNumber ? <>
        <div className="wiki-version-heading"><div><span className={`badge ${number === published ? 'badge-accepted' : 'badge-draft'}`}>{number === published ? 'Published' : number > published ? 'Unpublished Draft' : 'Historical'} · Version {number}</span><h2>{version.title}</h2><p>{version.slug} · {author(version)} · {date(version.createdAt)}</p>{version.message && <p className="wiki-edit-summary">{version.message}</p>}{version.kind === 'legacy' && <p>This snapshot predates recorded authorship and full history.</p>}</div><div className="file-actions">{number !== published && <button className="button primary" disabled={!online || snapshot || action.busy || loading || !canEdit || !detail.document.publication || Boolean(action.pending)} onClick={() => setOperation({ kind: 'publish', detail, target: version })}>{number > published ? 'Publish Draft' : 'Publish Older Version'}</button>}{(number !== last || !active) && version.content.length > 0 && <button className="button" disabled={!online || snapshot || action.busy || loading || !canEdit || !detail.document.publication || Boolean(action.pending)} onClick={() => setOperation({ kind: 'restore', detail, target: version })}><RotateCcw size={15}/>Restore as new version</button>}</div></div>
        {version.kind === 'delete' || version.kind === 'move_away' ? <p className="info-strip">This version is a {version.kind === 'delete' ? 'deleted-page' : 'moved-page'} marker. Choose another version to inspect its source.</p> : <RemarkupBody key={`${id}:${version.id}`} contextKey={`${id}:${version.id}`} body={version.content} wikiNavigation={sectionNavigation} sourceLabel={`Exact wiki version ${number} source`} fallbackNoun="document" contentClassName="wiki-content"/>}{number > published && <p className="info-strip">This saved draft is visible to everyone who can read the document.</p>}
      </> : <p className="wiki-status" role="status">{unavailable(number)}</p>)}
      {tab === 'compare' && (version && before && validNumber && validBaseline ? <div className="wiki-comparison">
        <div className="wiki-comparison-heading"><strong>Version {baseline} → Version {number}</strong><span>{before.title === version.title ? version.title : `${before.title} → ${version.title}`}</span>{before.slug !== version.slug && <span>Slug: {before.slug} → {version.slug}</span>}</div>
        <div className="diff-legend"><span><i className="legend-add"/> Added</span><span><i className="legend-remove"/> Removed</span><small>Comparison preserves source whitespace.</small></div>
        {changes ? <div className={`wiki-diff wiki-diff-${diffMode}`} aria-label={`Changes from version ${baseline} to version ${number}`}>{changes.map((change, index) => change.added ? <ins key={index}>{change.value}</ins> : change.removed ? <del key={index}>{change.value}</del> : <span key={index}>{change.value}</span>)}</div> : <div className="wiki-status">This comparison is too large for an interactive diff. Inspect each version separately.</div>}
        {before.content === version.content && <p className="wiki-status">No content changes between these versions.</p>}
      </div> : <div className="wiki-status" role="status">{(!version || !validNumber) && <p>{unavailable(number)}</p>}{(!before || !validBaseline) && <p>{unavailable(baseline)}</p>}</div>)}
      {tab === 'history' && <div className="wiki-history">
        <p className="info-strip">Every saved edit keeps an immutable content version. Publishing selects an existing version; restoring adds a new active version at this path.</p>
        <ol>{detail.history.versions.map(item => <li key={item.id}><button className="wiki-history-entry" onClick={() => { setSelected(item.number); setTab('document'); }}><span className="version-marker" aria-hidden="true">{item.number}</span><span><strong>Version {item.number} · {item.title}</strong><small>{item.message || (item.kind === 'create' ? 'Document created' : item.kind === 'legacy' ? 'Retained legacy snapshot' : item.kind === 'draft' ? 'Saved draft' : item.kind === 'delete' ? 'Document deleted' : 'Document edited')}</small><small>{item.author || 'Unknown author'} · {date(item.createdAt)}{item.restoredFrom !== null ? ` · Restored from version ${item.restoredFrom}` : ''}</small></span></button></li>)}</ol>
        {detail.history.nextBefore !== null && <div className="wiki-status"><button className="button" disabled={paging || !online || snapshot} onClick={() => void older()}>{paging ? 'Loading history…' : 'Load older history'}</button>{(!online || snapshot) && <p>Reconnect to load history not yet saved on this device.</p>}</div>}
      </div>}
    </section>
    {detail.lifecycle && <section className="panel wiki-activity"><div className="panel-heading"><h2>Publication & Lifecycle History</h2></div><ol>{detail.lifecycle.transactions.map(item => <li key={item.id}><p><strong>{item.kind === 'publish' ? 'Published existing content' : item.kind === 'draft' ? 'Saved draft' : item.kind === 'delete' ? 'Deleted document' : item.kind === 'restore' ? 'Restored content' : item.kind.replaceAll('_', ' ')}</strong> · Published version {item.after.publication.publishedVersion} · Latest content {item.after.publication.headVersion}</p>{item.message && <p>{item.message}</p>}<small>{item.actor || 'Unknown author'} · {date(item.createdAt)}</small><button className="text-button" onClick={() => { setSelected(item.after.publication.publishedVersion); setTab('document'); }}>Inspect Published Version {item.after.publication.publishedVersion}</button></li>)}</ol>{detail.lifecycle.nextBefore !== null && <div className="card-body"><button className="button" disabled={!online || snapshot || lifecyclePaging} onClick={() => void olderLifecycle()}>Load Earlier Publication History</button></div>}</section>}
    {([...savedDraftRecords(`wiki-edit:${id}:`), ...savedDraftRecords(`wiki-action:${id}:`)]).length > 0 && <section className="panel card-body"><h2>Retained Local Wiki Drafts</h2><p>Each local draft keeps its original content and publication versions.</p>{[...savedDraftRecords(`wiki-edit:${id}:`), ...savedDraftRecords(`wiki-action:${id}:`)].map(item => <button className="button" key={item.key} onClick={() => exportWikiDraft(item)}>Export {item.key.startsWith('wiki-edit:') ? 'Local Edit' : 'Action Message'}</button>)}</section>}
    {detail.activity.length > 0 && <section className="panel wiki-activity"><div className="panel-heading"><h2>Document activity</h2></div><ol>{detail.activity.map(item => <li key={item.id}><p>{item.detail}</p><small>{item.actor} · {date(item.createdAt)}</small></li>)}</ol></section>}
  </div>;
}
