import { useEffect, useRef, useState } from 'react';
import type { GitComparisonIdentity, GitPatch } from '../shared/repositories';
import { gitPatchBytes, gitPatchFilename } from '../shared/git-patch';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { onSessionLocked } from './session';
import { repositoryCache, type RepositorySelection } from './repository-cache';
import { patchAccessMatches, patchCacheKey, patchPair, patchQuery } from './repository-patch';

type Props = { id: string; selection: RepositorySelection; expected: GitComparisonIdentity | null; online: boolean; generation: number; cached: <T>(key: string) => T | null; saveCache: (key: string, value: unknown) => boolean; dropCache: (key: string) => void };
type Prepared = { key: string; patch: GitPatch; bytes: Uint8Array<ArrayBuffer>; retained: boolean; persisted: boolean; restored: boolean; savedEpoch?: number };
export default function RepositoryPatch({ id, selection, expected, online, generation, cached, saveCache, dropCache }: Props) {
  const client = useWorkspace(), query = patchPair(selection), key = patchCacheKey(query);
  const [ready, setReady] = useState<Prepared | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true), sequence = useRef(0), current = useRef(key), urls = useRef(new Set<string>());
  const actions = useRef({ cached, saveCache, dropCache }); actions.current = { cached, saveCache, dropCache }; current.current = key;
  const active = () => { if (!mounted.current || !client.isActive() || client.unavailableObject(id)) return false; try { client.assertActive(); return true; } catch { return false; } };
  const revoke = () => { for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); };
  const retire = () => { sequence.current++; revoke(); setReady(null); setBusy(false); setError(''); };
  const context = (ticket: number, selected: string, epoch: number, snapshot: number) => active() && ticket === sequence.current && selected === current.current && epoch === client.session?.accessEpoch && snapshot === client.repositorySnapshotGeneration();
  const awaitingAccess = client.session?.accessEpoch === -1 && online;
  useEffect(() => {
    mounted.current = true;
    const offSnapshot = client.onRepositorySnapshotChange(retire), offAccess = client.onAccessChange(ids => { if (ids.includes(id)) retire(); }), offSession = onSessionLocked(retire);
    return () => { mounted.current = false; sequence.current++; revoke(); offSnapshot(); offAccess(); offSession(); };
  }, [id]);
  useEffect(() => {
    retire(); const ticket = sequence.current, epoch = client.session?.accessEpoch ?? -1, snapshot = client.repositorySnapshotGeneration();
    if (awaitingAccess) return;
    const retained = actions.current.cached<unknown>(key);
    if (!retained) return;
    setBusy(true);
    void (async () => {
      try {
        const bytes = await gitPatchBytes(retained, id, query, expected ?? undefined);
        if (!context(ticket, key, epoch, snapshot)) return;
        const patch = retained as GitPatch;
        const storedCache = repositoryCache(client.readStored(`repository:${id}:cache`, null));
        const stored = storedCache.entries.find(item => item.key === key)?.value;
        const persisted = client.durable && !client.draftHasUnsavedMemory(`repository:${id}:cache`) && JSON.stringify(stored) === JSON.stringify(patch), savedEpoch = persisted ? storedCache.accessEpoch : undefined;
        if (!patchAccessMatches(patch.accessEpoch, epoch, client.durable && !online, savedEpoch)) throw new Error('Saved patch access has changed. Prepare this exact pair again while online.');
        setReady({ key, patch, bytes, retained: true, persisted, restored: true, savedEpoch });
      } catch (failure) { if (context(ticket, key, epoch, snapshot)) { actions.current.dropCache(key); setError(failure instanceof Error ? failure.message : 'The saved patch could not be verified.'); } }
      finally { if (context(ticket, key, epoch, snapshot)) setBusy(false); }
    })();
    return () => { sequence.current++; revoke(); };
  }, [id, key, generation, awaitingAccess]);
  const prepare = async () => {
    if (!active() || !online || busy) return;
    const ticket = ++sequence.current, epoch = client.session?.accessEpoch ?? -1, snapshot = client.repositorySnapshotGeneration();
    setBusy(true); setError(''); revoke();
    try {
      const patch = await client.request<GitPatch>(`/api/repositories/${id}/compare/patch?${patchQuery(query)}`);
      if (!context(ticket, key, epoch, snapshot)) return;
      const bytes = await gitPatchBytes(patch, id, query, expected ?? undefined);
      if (!context(ticket, key, epoch, snapshot)) return;
      if (patch.accessEpoch !== epoch) throw new Error('Repository access changed. Reload this exact comparison before preparing a patch.');
      const persisted = actions.current.saveCache(key, patch);
      if (!context(ticket, key, epoch, snapshot)) return;
      setReady({ key, patch, bytes, retained: Boolean(actions.current.cached(key)), persisted: client.durable && persisted, restored: false });
    } catch (failure) {
      if (!context(ticket, key, epoch, snapshot)) return;
      if (!isNetworkError(failure)) { setReady(null); actions.current.dropCache(key); }
      setError(isNetworkError(failure) ? 'The patch could not be prepared while offline. A verified saved patch for this exact pair remains available if shown below.' : failure instanceof Error ? failure.message : 'The patch could not be prepared.');
    } finally { if (context(ticket, key, epoch, snapshot)) setBusy(false); }
  };
  const accessMatches = (value: Prepared) => patchAccessMatches(value.patch.accessEpoch, client.session?.accessEpoch, client.durable && !online && value.restored, value.savedEpoch);
  const prepared = ready?.key === key && accessMatches(ready) && (!expected || ready.patch.accessEpoch === expected.accessEpoch && ready.patch.baseTreeId === expected.baseTreeId && ready.patch.targetTreeId === expected.targetTreeId) ? ready : null;
  const download = () => {
    if (!prepared || busy || !active() || !accessMatches(prepared)) return;
    const url = URL.createObjectURL(new Blob([prepared.bytes], { type: 'application/octet-stream' })); urls.current.add(url);
    const link = document.createElement('a'); link.href = url; link.download = gitPatchFilename(id, query); link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
  };
  return <section className="repository-patch" aria-label="Exact patch export"><div className="repository-patch-heading"><h3>Exact Patch</h3><div className="repository-patch-actions"><button className="button" disabled={!online || busy} onClick={() => void prepare()}>{busy ? 'Verifying Patch…' : 'Prepare Exact Patch'}</button><button className="button" disabled={!prepared || busy} onClick={download}>Download Exact Patch</button></div></div>
    <p className="small muted">Export the complete patch from the displayed base to target commit, including supported binary and mode changes. Preparation is explicit and never applies the patch.</p>
    {error && <p className="info-strip" role="alert">{error}</p>}
    {prepared ? <div className="repository-patch-ready"><strong>{prepared.restored ? prepared.persisted ? 'Saved patch verified' : 'Retained patch verified' : 'Patch ready'} · {prepared.patch.bytes.toLocaleString()} bytes</strong><code>{gitPatchFilename(id, query)}</code><details><summary>Patch integrity</summary><code>SHA-256 {prepared.patch.sha256}</code></details>{prepared.patch.bytes === 0 && <p>These exact trees produce an empty patch.</p>}{!prepared.retained ? <p className="info-strip">This patch exceeds the repository’s offline cache limit. Download it now; leaving this view may require preparing it again.</p> : !client.durable ? <p className="small muted">This prepared patch stays in this signed-in tab only.</p> : !prepared.persisted ? <p className="info-strip">This patch is ready in memory but could not be saved on this device. Download it before leaving.</p> : prepared.restored ? <p className="small muted">Only this saved, verified commit pair can be downloaded offline.</p> : null}</div> : !busy && <p className="small muted">{online ? 'Prepare this exact pair to make its download available.' : 'No verified patch for this exact pair is saved here. Reconnect to prepare it.'}</p>}
  </section>;
}
