import { useCallback, useEffect, useRef, useState } from 'react';
import { REVISION_VIEW_LIMITS, isRevisionViewsSnapshot, revisionViewFilters, revisionViewInput, validRevisionViewResult, type RevisionSavedView, type RevisionViewAction, type RevisionViewFilters, type RevisionViewsSnapshot } from '../shared/revision-views';
import type { RevisionKind } from '../shared/types';
import { useWorkspace } from './SessionGate';
import { useDraftRetention } from './draft-retention';
import { retainFileIntent } from './file-client';
import { builtinRevisionView, matchRevisionViews, revisionViewDirty, revisionViewDraft, revisionViewIntent, savedRevisionView, type RevisionBuiltinView, type RevisionViewDraft, type RevisionViewIntent } from './revision-view-model';

const requestKey = 'revision-view-request', cacheKey = 'revision-views-cache';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function useKindDraft(kind: RevisionKind) {
  const client = useWorkspace(), key = `revision-view-state:${kind}`;
  const [draft, setDraft] = useState(() => revisionViewDraft(client.readStored(key, null), kind) || builtinRevisionView(kind));
  const current = useRef(draft); current.current = draft;
  const [persisted, setPersisted] = useState(() => !client.draftHasUnsavedMemory(key));
  const retain = useDraftRetention(client, key, setPersisted);
  const update = (next: RevisionViewDraft) => { client.assertActive(); current.current = next; setDraft(next); retain(next); };
  return { draft, current, update, persisted };
}

/** Personal filters survive route changes; network refreshes never replace an editor. */
export function useRevisionViews(online: boolean, accessEpoch: number) {
  const client = useWorkspace();
  const principalId = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`;
  const code = useKindDraft('code'), paper = useKindDraft('paper'), documentDraft = useKindDraft('document');
  const editors = { code, paper, document: documentDraft }, latestEditors = useRef(editors); latestEditors.current = editors;
  const [snapshot, setSnapshot] = useState<RevisionViewsSnapshot | null>(() => {
    const saved = client.readStored<{ principalId?: string; snapshot?: unknown } | null>(cacheKey, null);
    return saved?.principalId === principalId && isRevisionViewsSnapshot(saved.snapshot) ? saved.snapshot : null;
  });
  const latestSnapshot = useRef(snapshot); latestSnapshot.current = snapshot;
  const [pendingRaw, setPendingRaw] = useState<unknown>(() => client.readStored(requestKey, null));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [notice, setNotice] = useState('');
  const present = useRef(true), readGeneration = useRef(0), writeGeneration = useRef(0), operation = useRef(false), connection = useRef(online); connection.current = online;
  const pending = revisionViewIntent(pendingRaw, principalId);
  const active = () => { try { client.assertActive(); return present.current; } catch { return false; } };
  const install = (next: RevisionViewsSnapshot) => { latestSnapshot.current = next; setSnapshot(next); client.writeStored(cacheKey, { principalId, snapshot: next }); };
  const syncRequest = () => setPendingRaw(client.readStored(requestKey, null));
  const load = useCallback(async () => {
    if (!present.current || !client.isActive() || !connection.current) return;
    const ticket = ++readGeneration.current; setLoading(true);
    try {
      const result = await client.request<unknown>('/api/revision-views');
      if (!active() || ticket !== readGeneration.current) return;
      if (!isRevisionViewsSnapshot(result) || result.accessEpoch !== client.session?.accessEpoch) throw new Error('Saved views could not be verified. Reload saved views.');
      install(result);
    } catch (failure) { if (active() && ticket === readGeneration.current) setNotice(`${failure instanceof Error ? failure.message : 'Saved views are unavailable.'} Your current filters are unchanged.`); }
    finally { if (active() && ticket === readGeneration.current) setLoading(false); }
  }, [client, principalId]);
  useEffect(() => {
    // The provider may replace its client wrapper within the same session (for
    // example when opening the sign-out dialog). Retire the old UI operation,
    // then recover its immutable request instead of leaving the new controls busy.
    present.current = true; operation.current = false; setBusy(false); setLoading(false); syncRequest();
    const retire = () => { present.current = false; readGeneration.current++; writeGeneration.current++; operation.current = false; setBusy(false); setLoading(false); };
    const resume = () => { present.current = true; syncRequest(); void load(); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === client.storageKey(requestKey)) syncRequest(); if (event.key === null || event.key === client.storageKey(cacheKey)) void load(); };
    const access = client.onAccessChange(() => { readGeneration.current++; void load(); });
    window.addEventListener('pagehide', retire); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('storage', storage);
    return () => { present.current = false; readGeneration.current++; writeGeneration.current++; operation.current = false; access(); window.removeEventListener('pagehide', retire); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('storage', storage); };
  }, [client, load]);
  useEffect(() => { if (online) void load(); }, [online, accessEpoch, load]);
  const change = (kind: RevisionKind, patch: Partial<RevisionViewFilters>) => {
    if (!active()) return;
    const editor = latestEditors.current[kind];
    try { editor.update({ ...editor.current.current, filters: revisionViewFilters({ ...editor.current.current.filters, ...patch, kind }) }); }
    catch { setNotice('Keep search text within 512 characters and use the supported revision filters. Your previous filters are unchanged.'); }
  };
  const open = (kind: RevisionKind, view: RevisionSavedView | RevisionBuiltinView, voice = false): boolean => {
    if (!active()) return false;
    const editor = latestEditors.current[kind];
    if (revisionViewDirty(editor.current.current) && (voice || !window.confirm('Replace your unsaved view name and filters with this view?'))) return false;
    editor.update(typeof view === 'string' ? builtinRevisionView(kind, view) : savedRevisionView(view)); setNotice(''); return true;
  };
  const voiceOpen = (kind: RevisionKind, name: string): string | null => {
    const matches = matchRevisionViews(latestSnapshot.current?.views || [], kind, name);
    if (matches.length !== 1) return matches.length ? 'That saved view name is ambiguous. Use its exact view ID.' : 'That saved view is unavailable. Reload saved views or use an exact name or ID.';
    if (!open(kind, matches[0], true)) return 'Your filters have unsaved changes. Open the view on screen to replace them explicitly.';
    return null;
  };
  const send = async (intent: RevisionViewIntent) => {
    if (!active() || operation.current || !connection.current) return;
    operation.current = true; const ticket = ++writeGeneration.current; readGeneration.current++; setLoading(false); setBusy(true); setNotice('');
    const current = () => active() && ticket === writeGeneration.current;
    try {
      const retained = await retainFileIntent(client, requestKey, intent);
      if (!current()) return;
      syncRequest();
      if (!retained.accepted) throw new Error('Another saved view request is already retained. Resolve that exact request first.');
      const path = `/api/revision-views${intent.viewId ? `/${intent.viewId}` : ''}${intent.action === 'delete' ? '/delete' : ''}`;
      const result = await client.request<unknown>(path, { method: intent.action === 'edit' ? 'PUT' : 'POST', body: intent.input, id: intent.id });
      if (!current()) return;
      if (!validRevisionViewResult(result, intent.action, intent.input, intent.viewId || undefined) || result.accessEpoch !== client.session?.accessEpoch || result.view.filters.kind !== intent.draft.filters.kind || intent.action === 'delete' && (!same(result.view.filters, intent.draft.base?.filters) || result.view.name !== intent.draft.base?.name)) throw new Error('The saved view receipt did not match this exact request. Keep the request and retry.');
      readGeneration.current++; setLoading(false);
      const epoch = client.session.accessEpoch, authorized = () => current() && epoch === client.session?.accessEpoch;
      await client.removeRetainedDraftIfEqual(requestKey, intent, authorized);
      if (!authorized()) return;
      syncRequest();
      const editor = latestEditors.current[intent.draft.filters.kind];
      if (same(editor.current.current, intent.draft)) {
        // The acknowledgement can only change the exact submitted editor.
        editor.update(result.deleted ? { ...intent.draft, base: null, builtin: 'all' } : savedRevisionView(result.view));
      }
      setNotice(result.deleted ? 'Saved view deleted. Your current filters remain available.' : 'Saved view confirmed. Newer unsaved filters, if any, are unchanged.');
      // An exact retry returns a historical receipt. Only a fresh inventory read
      // can establish whether that view still exists or has since changed.
      readGeneration.current++;
      void load();
    } catch (failure) { if (current()) { const retained = client.readStored(requestKey, null); setPendingRaw(retained); setNotice(`${failure instanceof Error ? failure.message : 'The request was not confirmed.'} ${retained !== null ? 'The exact request is retained; retry explicitly or forget it before a different save.' : 'Your filters are unchanged. The request could not be retained for retry.'}`); } }
    finally {
      // Retention may finish after a same-session wrapper refresh. Re-read the
      // current slot without letting that stale operation replace the editor.
      if (active()) syncRequest();
      if (current()) { operation.current = false; setBusy(false); }
    }
  };
  const save = (kind: RevisionKind, action: RevisionViewAction) => {
    if (!active() || busy || !online || pendingRaw !== null) return;
    const draft = latestEditors.current[kind].current.current;
    if (action !== 'create' && !draft.base) return;
    if (action === 'delete' && !window.confirm(`Delete saved view “${draft.base!.name}”? This keeps your current filters.`)) return;
    try {
      const input = revisionViewInput(action, action === 'delete' ? { expectedVersion: draft.base!.version, expectedAccessEpoch: client.session!.accessEpoch } : { name: draft.name, filters: draft.filters, expectedAccessEpoch: client.session!.accessEpoch, ...(action === 'edit' ? { expectedVersion: draft.base!.version } : {}) });
      void send({ id: crypto.randomUUID(), principalId, action, viewId: action === 'create' ? null : draft.base!.id, input, draft: JSON.parse(JSON.stringify(draft)) as RevisionViewDraft });
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : 'Check the saved view filters.'); }
  };
  const forget = async () => {
    if (!active() || operation.current || pendingRaw === null || !window.confirm('Forget this retained request? It may already have completed on the server. Reload saved views before creating a different request.')) return;
    const raw = pendingRaw, epoch = client.session!.accessEpoch, ticket = ++writeGeneration.current; operation.current = true; setBusy(true);
    const current = () => active() && ticket === writeGeneration.current && epoch === client.session?.accessEpoch;
    try { await client.removeRetainedDraftIfEqual(requestKey, raw, current); if (current()) { syncRequest(); setNotice('Retained request forgotten. Reload saved views to check the server result.'); void load(); } }
    finally { if (active() && ticket === writeGeneration.current) { operation.current = false; setBusy(false); } }
  };
  const exportDraft = (kind: RevisionKind) => {
    if (!active()) return;
    const blob = new Blob([JSON.stringify({ draft: latestEditors.current[kind].current.current, request: client.readStored(requestKey, null) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${kind}-view-draft.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { editors, snapshot, pending, pendingRaw, busy, loading, notice, change, open, voiceOpen, save, reload: load, retry: () => { if (pending) void send(pending); }, forget, exportDraft, online, durable: client.durable };
}
export type RevisionViewsController = ReturnType<typeof useRevisionViews>;

export default function RevisionViews({ controller, kind, active, showActive, showFilters }: { controller: RevisionViewsController; kind: RevisionKind; active: boolean; showActive: () => void; showFilters: () => void }) {
  const { editors, snapshot, pending, pendingRaw, busy, loading, notice, online } = controller, editor = editors[kind], draft = editor.draft;
  const views = (snapshot?.views || []).filter(view => view.filters.kind === kind);
  const [choice, setChoice] = useState(draft.base?.id || '');
  useEffect(() => { setChoice(draft.base?.id || ''); }, [draft.base?.id]);
  const selected = draft.base, current = selected && views.find(view => view.id === selected.id), dirty = revisionViewDirty(draft);
  const candidate = views.find(view => view.id === choice);
  const unavailable = selected && snapshot && !current;
  return <section className="revision-views" aria-label="Revision views">
    <div className="revision-view-builtins" aria-label="Built-in revision views"><button className={`button ${active ? 'selected' : ''}`} aria-pressed={active} onClick={showActive}>Active revisions</button>{(['all', 'authored', 'following'] as const).map(value => <button className={`button ${!active && !selected && draft.builtin === value && !dirty ? 'selected' : ''}`} key={value} aria-pressed={!active && !selected && draft.builtin === value && !dirty} onClick={() => { if (controller.open(kind, value)) showFilters(); }}>{value === 'all' ? 'All revisions' : value === 'authored' ? 'Authored' : 'Following'}</button>)}</div>
    {active && <div className="revision-active-return"><button className="button" onClick={showFilters}>Return to saved filters</button>{dirty && <span>Your unsaved view name and filters are preserved.</span>}</div>}
    {!active && <><div className="revision-view-picker"><label className="field"><span>Saved revision view</span><select value={choice} onChange={event => setChoice(event.target.value)}><option value="">Choose a personal view</option>{choice && !views.some(view => view.id === choice) && <option value={choice}>Unavailable selected view · {choice}</option>}{views.map(view => <option key={view.id} value={view.id}>{view.name} · {view.id}</option>)}</select></label><button className="button" disabled={!candidate} onClick={() => { if (candidate && controller.open(kind, candidate)) showFilters(); }}>Open saved view</button><button className="button" disabled={!online || loading} onClick={() => void controller.reload()}>{loading ? 'Loading saved views…' : 'Reload saved views'}</button></div>
    <p className="revision-view-state" role="status">{selected ? `${selected.name} · ${selected.id} · version ${selected.version}` : draft.builtin === 'authored' ? 'Authored view' : draft.builtin === 'following' ? 'Following view' : 'All revisions'}{dirty ? ' · Unsaved changes' : ''}</p>
    {unavailable && <p className="info-strip">The selected saved view is unavailable or was deleted. Its filters remain selected.</p>}
    {selected && current && current.version !== selected.version && <p className="info-strip">This saved view changed on the server. Your filters and original version remain selected. Reload the selected view explicitly before using its newer version.</p>}
    <details className="revision-view-management"><summary>Save or manage this view</summary><label className="field"><span>Revision view name</span><input value={draft.name} maxLength={REVISION_VIEW_LIMITS.name} onChange={event => editor.update({ ...editor.current.current, name: event.target.value })}/></label><div className="revision-view-actions"><button className="button primary" disabled={!online || busy || pendingRaw !== null || !draft.name.trim()} onClick={() => controller.save(kind, 'create')}>Save new view</button><button className="button" disabled={!online || busy || pendingRaw !== null || !selected || !draft.name.trim()} onClick={() => controller.save(kind, 'edit')}>Update saved view</button><button className="button" disabled={!current} onClick={() => current && controller.open(kind, current)}>Reload selected view</button><button className="button danger" disabled={!online || busy || pendingRaw !== null || !selected} onClick={() => controller.save(kind, 'delete')}>Delete saved view</button></div><p className="muted">Saved views are private to you. Saving stores these filters across your devices; it does not change any revision.</p></details></>}
    {!editor.persisted && <p className="info-strip">These filters are retained in this tab while storage is pending, unavailable, or changed in another tab. Export your draft before closing the page.</p>}
    {(dirty || !editor.persisted || pendingRaw !== null) && <button className="button" onClick={() => controller.exportDraft(kind)}>Export view draft</button>}
    {!online && <p className="info-strip">Offline: use saved snapshots and edit filters. Saving views requires a connection; requests never send automatically.</p>}
    {pendingRaw !== null && <div className="revision-view-recovery" role="status"><p>{pending ? `An exact ${pending.action} request for ${pending.viewId || 'a new view'} is retained. Your newer filters will not replace it.` : 'An unrecognized saved view request is retained. It will not be sent.'}</p><details><summary>Retained saved view request</summary><pre>{JSON.stringify(pendingRaw, null, 2)}</pre></details><div className="revision-view-actions"><button className="button" disabled={!online || busy || !pending} onClick={controller.retry}>Retry saved view request</button><button className="button" disabled={busy} onClick={() => void controller.forget()}>Forget saved view request</button></div></div>}
    {notice && <p className="info-strip" role="status">{notice}</p>}
  </section>;
}
