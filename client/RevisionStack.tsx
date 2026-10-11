import { revisionStatusLabel } from '../shared/revision-status';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RevisionStack as Stack } from '../shared/revision-stack';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { onSessionLocked } from './session';
import { revisionStackLayout, STACK_LANE_WIDTH, STACK_ROW_HEIGHT, stackAccessMatches, stackNarration, verifiedRevisionStack, type RegisterStack, type StackVoiceAction } from './revision-stack';

const colors = ['#286b9c', '#8851a2', '#27764e', '#a15d1f', '#a04365', '#487780'];

export default function RevisionStack({ id, online, open, onOpen, register }: { id: string; online: boolean; open: boolean; onOpen: () => void; register?: RegisterStack }) {
  const client = useWorkspace(), cacheKey = `revision-stack:${id}`;
  const [stack, setStack] = useState<Stack | null>(null), [selected, setSelected] = useState(id), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(true);
  const mounted = useRef(false), generation = useRef(0), current = useRef<Stack | null>(null), loadRef = useRef<() => void>(() => {}), selectedRef = useRef(id), openRef = useRef(open), onOpenRef = useRef(onOpen);
  const publishRef = useRef<() => void>(() => {}), savedRef = useRef(true);
  openRef.current = open; onOpenRef.current = onOpen;
  const select = (next: string) => { selectedRef.current = next; setSelected(next); publishRef.current(); };
  const retire = () => { generation.current++; current.current = null; setStack(null); setBusy(false); publishRef.current(); };
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const load = useCallback(async () => {
    if (!open || !active()) return;
    const ticket = ++generation.current, snapshot = client.revisionStackGeneration();
    const valid = () => active() && ticket === generation.current && snapshot === client.revisionStackGeneration();
    const retained = !online && current.current && stackAccessMatches(current.current.accessEpoch, client.session?.accessEpoch ?? -1, client.durable, online) ? current.current : null;
    setBusy(true); setError('');
    // Focus and reconnect retire old labels before requesting current authority.
    current.current = null; setStack(null); publishRef.current();
    try {
      const value: unknown = online ? await client.request(`/api/revisions/${id}/dependencies/graph`) : retained ?? client.readStored(cacheKey, null);
      if (!valid()) return;
      if (value === null) { setError('No saved stack is available. Reconnect and open Stack to load it.'); return; }
      const verified = await verifiedRevisionStack(value, id);
      if (!valid()) return;
      if (!stackAccessMatches(verified.accessEpoch, client.session?.accessEpoch ?? -1, client.durable, online)) throw new Error('Stack access changed. Reload the stack.');
      current.current = verified; setStack(verified); select(verified.nodes.some(node => node.id === selectedRef.current) ? selectedRef.current : id);
      savedRef.current = online ? client.writeStored(cacheKey, verified) : retained ? savedRef.current : !client.draftHasUnsavedMemory(cacheKey); setSaved(savedRef.current);
    } catch (failure) {
      if (!valid()) return;
      if (!isNetworkError(failure)) client.removeStored(cacheKey);
      setError(failure instanceof Error ? failure.message : 'The stack could not be loaded.');
    } finally { if (valid()) setBusy(false); }
  }, [id, online, open]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true;
    const changed = () => { retire(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const offStack = client.onRevisionStackChange(changed), offAccess = client.onAccessChange(changed), offSession = onSessionLocked(retire);
    const focus = () => { if (open) loadRef.current(); };
    window.addEventListener('focus', focus); void load();
    return () => { mounted.current = false; generation.current++; offStack(); offAccess(); offSession(); window.removeEventListener('focus', focus); };
  }, [load]);
  const identity = () => current.current ? `${id}:${current.current.snapshotId}:${selectedRef.current}` : `${id}:unavailable:${generation.current}`;
  const executeRef = useRef<(action: StackVoiceAction) => { text: string; identity: string }>(() => ({ text: '', identity: '' }));
  executeRef.current = action => {
    if (!active()) return { text: 'This stack is no longer available.', identity: identity() };
    if (!openRef.current) onOpenRef.current();
    const value = current.current;
    if (!value) return { text: online ? 'The stack is loading. Read the stack again when loading is complete.' : 'No verified saved stack is open. Open Stack to check the saved snapshot.', identity: identity() };
    const index = value.nodes.findIndex(item => item.id === selectedRef.current), next = action === 'nextStackRevision' ? index + 1 : action === 'previousStackRevision' ? index - 1 : index;
    if (next >= 0 && next < value.nodes.length) select(value.nodes[next]!.id);
    const boundary = next < 0 ? 'Already at the first stack revision. ' : next >= value.nodes.length ? 'Already at the last stack revision. ' : '';
    return { text: boundary + stackNarration(value, selectedRef.current, action === 'stack'), identity: identity() };
  };
  useEffect(() => {
    if (!register) return;
    const controller = { revisionId: id, get identity() { return identity(); }, execute: (action: StackVoiceAction) => executeRef.current(action) };
    publishRef.current = () => register(controller); publishRef.current();
    return () => { publishRef.current = () => {}; register(null); };
  }, [id, register]);
  const layout = useMemo(() => stack ? revisionStackLayout(stack) : null, [stack]);
  const node = stack?.nodes.find(item => item.id === selected), row = layout?.rows.find(item => item.id === selected);
  const nodes = useMemo(() => new Map(stack?.nodes.map(item => [item.id, item]) ?? []), [stack]);
  if (!open) return null;
  return <section className="revision-stack" aria-label="Revision Stack">
    <div className="file-actions"><h3>Stack</h3><button className="button" disabled={!online || busy} onClick={() => void load()}>{busy ? 'Loading Stack…' : 'Reload Stack'}</button></div>
    <p className="small muted">The connected visible revisions, including branches and shared parents. Closed revisions remain in the graph. Hidden revisions and paths through them are omitted.</p>
    {!online && <p className="info-strip">Saved stack snapshot. Reconnect to check current relationships, status, and access.</p>}
    {!saved && <p className="banner warning">This stack is only retained in this tab because it could not be saved on this device.</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {stack && layout ? <>
      <p className="revision-stack-count"><strong>{stack.openParentIds.length} open transitive parent {stack.openParentIds.length === 1 ? 'revision' : 'revisions'}</strong> for {id}. This is advisory; it does not block review acceptance or closing.</p>
      <p className="small muted">{stack.nodes.length} visible revisions · {stack.edges.length} relationships. Select a revision for its exact parent and child links. Trace lanes scroll horizontally when needed.</p>
      <div className="file-actions revision-stack-navigation"><button className="button" disabled={stack.nodes[0]?.id === selected} onClick={() => { window.dispatchEvent(new Event('stack-navigation')); executeRef.current('previousStackRevision'); }}>Previous Stack Revision</button><button className="button" disabled={stack.nodes.at(-1)?.id === selected} onClick={() => { window.dispatchEvent(new Event('stack-navigation')); executeRef.current('nextStackRevision'); }}>Next Stack Revision</button></div>
      {node && row && <section className="revision-stack-selection" aria-label="Selected Stack Revision"><h4><a href={`#${node.id}`}>{node.id} {node.title}</a>{node.id === id && <span className="badge">Current revision</span>}</h4><p><span className={`badge badge-${node.status}`}>{revisionStatusLabel(node.status)}</span> · {node.kind} · source version {node.head.number}</p><p>Current author: {node.author?.displayName ?? 'Unassigned'}</p><p>Original author: {node.originalAuthor?.displayName ?? 'Not recorded'}</p><div className="revision-stack-adjacency">{(['parents', 'children'] as const).map(direction => <div key={direction}><strong>{direction === 'parents' ? 'Direct parents' : 'Direct children'}</strong>{row[direction].length ? <ul>{row[direction].map(peer => <li key={peer}><a href={`#${peer}`}>{peer} {nodes.get(peer)!.title}</a></li>)}</ul> : <p className="small muted">None visible.</p>}</div>)}</div></section>}
      <div className="revision-stack-board">
        <div className="revision-stack-traces" tabIndex={0} role="img" aria-label="Branch and merge traces. Exact relationships are listed for each selected revision.">
          <svg width={layout.width} height={layout.height} aria-hidden="true">{[false, true].flatMap(highlight => layout.traces.filter(trace => (trace.childId === selected || trace.parentId === selected) === highlight).map(trace => <path key={`${trace.childId}:${trace.parentId}`} d={trace.path} fill="none" stroke={colors[trace.lane % colors.length]} strokeWidth={highlight ? 3 : 1.5} opacity={highlight ? 1 : 0.5}/>))}{layout.rows.map((item, index) => <circle key={item.id} cx={12 + item.lane * STACK_LANE_WIDTH} cy={index * STACK_ROW_HEIGHT + STACK_ROW_HEIGHT / 2} r={item.id === selected ? 6 : 4} fill={item.id === id ? '#b57512' : colors[item.lane % colors.length]} stroke="white" strokeWidth="2"/>)}</svg>
        </div>
        <ol className="revision-stack-rows">{stack.nodes.map((item, index) => <li key={item.id} className={item.id === id ? 'revision-stack-seed' : ''}><button className="revision-stack-node" aria-pressed={item.id === selected} aria-label={`${item.id}: ${item.title}. ${revisionStatusLabel(item.status)}. Current author: ${item.author?.displayName ?? 'Unassigned'}. Original author: ${item.originalAuthor?.displayName ?? 'Not recorded'}. Parents: ${layout.rows[index]!.parents.join(', ') || 'none visible'}. Children: ${layout.rows[index]!.children.join(', ') || 'none visible'}.`} onClick={() => { window.dispatchEvent(new Event('stack-navigation')); select(item.id); }}><span className="revision-stack-row-title"><strong>{item.id}</strong> {item.title}</span><span className="revision-stack-row-meta"><span className={`badge badge-${item.status}`}>{revisionStatusLabel(item.status)}</span>{item.id === id && <strong>Current</strong>}</span><span className="revision-stack-author">Current author: {item.author?.displayName ?? 'Unassigned'}</span></button></li>)}</ol>
      </div>
      <p className="small muted">The selected source version on each revision is preserved when following a link. Stack metadata describes the current revisions, not historical source relationships.</p>
    </> : !error && <p role="status">{busy ? 'Loading and verifying the stack…' : 'Open the stack while connected to load it.'}</p>}
  </section>;
}
