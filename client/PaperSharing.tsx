import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { RevisionVersion } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import type { PaperShareLink, PaperShareList } from '../shared/paper-shares';
import { useWorkspace } from './SessionGate';
import { applicationPath } from './mount';
import { onSessionLocked, RequestError } from './session';

type CreateIntent = { id: string; body: { token: string; versionId: string; contentHash: string; label: string } };
function createToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function shareUrl(token: string): string { return new URL(`${applicationPath('/')}#paper-share/${token}`, location.origin).href; }
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : 'The link could not be updated. Retry the same request.';

/** Tokens and unresolved creation intents stay in this mounted dialog only. */
export default function PaperSharing({ revisionId, version, online, close }: { revisionId: string; version: RevisionVersion; online: boolean; close: () => void }) {
  const client = useWorkspace();
  const [page, setPage] = useState<PaperShareList | null>(null), [label, setLabel] = useState('');
  const [pending, setPending] = useState<CreateIntent | null>(null), [fresh, setFresh] = useState<{ link: PaperShareLink; token: string } | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; linkId: string } | null>(null);
  const [authorityEpoch, setAuthorityEpoch] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), generation = useRef(0);
  const scope = `${revisionId}:${version.id}:${version.contentHash}`, liveScope = useRef(scope); liveScope.current = scope;
  const active = useCallback((ticket: number) => mounted.current && ticket === generation.current && client.isActive() && !client.unavailableObject(revisionId) && liveScope.current === scope, [client, revisionId, scope]);
  const clear = useCallback(() => { generation.current++; setAuthorityEpoch(null); setPage(null); setFresh(null); setPending(null); setRevoke(null); setNotice(''); setBusy(false); }, []);
  const load = useCallback(async (before?: string) => {
    if (!online || !client.isActive() || client.unavailableObject(revisionId)) return;
    const ticket = generation.current; setBusy(true); setError('');
    try {
      const policy = await client.request<ObjectAccess>(`/api/policies/${revisionId}`);
      if (!active(ticket)) return;
      if (!policy.capabilities.managePolicy) throw new RequestError('You no longer have permission to manage sharing.', 403);
      const next = await client.request<PaperShareList>(`/api/revisions/${revisionId}/share-links${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      if (!active(ticket) || next.accessEpoch !== client.session?.accessEpoch) return;
      setAuthorityEpoch(next.accessEpoch); setPage(current => before && current ? { ...next, links: [...new Map([...current.links, ...next.links].map(link => [link.id, link])).values()] } : next);
    } catch (failure) {
      if (!active(ticket)) return;
      if (failure instanceof RequestError && [401, 403, 404].includes(failure.status)) clear();
      setError(failureMessage(failure));
    } finally { if (active(ticket)) setBusy(false); }
  }, [active, clear, client, online, revisionId]);
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal(); void load();
    const changed = () => { clear(); };
    const off = client.onAccessChange(changed), offSnapshot = client.onTaskSnapshotChange(changed), offSession = onSessionLocked(changed);
    const hide = () => { setFresh(null); setNotice(''); };
    window.addEventListener('pagehide', hide);
    return () => { mounted.current = false; generation.current++; off(); offSnapshot(); offSession(); window.removeEventListener('pagehide', hide); };
  }, [load, clear, client]);
  const permitted = online && client.isActive() && !client.unavailableObject(revisionId) && authorityEpoch !== null && authorityEpoch === client.session?.accessEpoch;
  const apply = (link: PaperShareLink) => setPage(current => current ? { ...current, links: [link, ...current.links.filter(item => item.id !== link.id)] } : current);
  const create = async (intent: CreateIntent) => {
    if (!permitted || busy) return;
    const ticket = generation.current, epoch = client.session?.accessEpoch; setPending(intent); setBusy(true); setError(''); setNotice('');
    try {
      const link = await client.request<PaperShareLink>(`/api/revisions/${revisionId}/share-links`, { method: 'POST', body: intent.body, id: intent.id });
      if (!active(ticket) || client.session?.accessEpoch !== epoch) return;
      if (link.versionId !== intent.body.versionId || link.contentHash !== intent.body.contentHash || link.label !== intent.body.label) throw new Error('The sharing receipt did not match the selected version. Retry the same request.');
      setPending(null); setFresh(link.revokedAt ? null : { link, token: intent.body.token }); apply(link); setLabel('');
      setNotice(link.revokedAt ? 'This link was already revoked.' : 'Link created. Copy it before closing this dialog.');
    } catch (failure) { if (active(ticket)) { if (failure instanceof RequestError && [401, 403, 404].includes(failure.status)) clear(); setError(failureMessage(failure)); } }
    finally { if (active(ticket)) setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending && permitted && !busy) void create({ id: crypto.randomUUID(), body: { token: createToken(), versionId: version.id, contentHash: version.contentHash, label: label.trim() } }); };
  const retract = async (intent: { id: string; linkId: string }) => {
    if (!permitted || busy) return;
    const ticket = generation.current, epoch = client.session?.accessEpoch; setRevoke(intent); setBusy(true); setError(''); setNotice('');
    try {
      const link = await client.request<PaperShareLink>(`/api/revisions/${revisionId}/share-links/${encodeURIComponent(intent.linkId)}/revoke`, { method: 'POST', body: {}, id: intent.id });
      if (!active(ticket) || client.session?.accessEpoch !== epoch) return;
      if (link.id !== intent.linkId || !link.revokedAt) throw new Error('Revocation was not confirmed. Retry the same request.');
      apply(link); setRevoke(null); setFresh(current => current?.link.id === link.id ? null : current); setNotice('Link revoked. The paper and its history are intact.');
    } catch (failure) { if (active(ticket)) { if (failure instanceof RequestError && [401, 403, 404].includes(failure.status)) clear(); setError(failureMessage(failure)); } }
    finally { if (active(ticket)) setBusy(false); }
  };
  const copy = async () => {
    if (!fresh || !permitted || fresh.link.revokedAt) return;
    const ticket = generation.current, epoch = client.session?.accessEpoch;
    try { await navigator.clipboard.writeText(shareUrl(fresh.token)); if (active(ticket) && client.session?.accessEpoch === epoch) setNotice('Link copied.'); }
    catch { if (active(ticket)) setError('Copy is unavailable in this browser. Select the link above and copy it.'); }
  };
  return <dialog ref={dialog} className="modal paper-sharing-dialog" onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="paper-sharing-title"><div className="modal-heading"><h2 id="paper-sharing-title">Share paper</h2><button className="button" type="button" onClick={close}>Close</button></div><div className="modal-body">
    <p>Create a read-only link to <strong>Version {version.number}</strong>. Anyone with the link can read its text files without signing in. Other versions, discussion, and attachments stay private.</p><p className="muted small">Revoking a link keeps the paper intact. Previously downloaded copies cannot be recalled.</p>
    {error && <p className="banner error" role="alert">{error}</p>}{notice && <p role="status" className="info-strip">{notice}</p>}
    {!permitted && <p className="info-strip">{online ? 'Verify access to manage sharing.' : 'Reconnect to manage sharing.'} <button type="button" className="text-button" disabled={!online || busy} onClick={() => void load()}>Reload sharing</button></p>}
    <form onSubmit={submit}><label className="field"><span>Link label</span><input aria-label="Link label" maxLength={120} value={label} disabled={!permitted || busy || Boolean(pending)} onChange={event => setLabel(event.target.value)} placeholder="Optional, for your records"/></label><div className="paper-sharing-actions"><button className="button primary" disabled={!permitted || busy || Boolean(pending) || Boolean(revoke)}>Create link</button>{pending && <button type="button" className="button" disabled={!permitted || busy} onClick={() => void create(pending)}>Retry creating link</button>}</div></form>
    {pending && <p className="muted small">Creation is unconfirmed. Retry uses the same link. Closing this dialog loses its address; any completed link can still be revoked below.</p>}
    {fresh && permitted && <section className="paper-sharing-created" aria-label="New share link"><label className="field"><span>Share link</span><input aria-label="Share link" value={shareUrl(fresh.token)} readOnly onFocus={event => event.currentTarget.select()}/></label><button className="button" type="button" onClick={() => void copy()}>Copy link</button><small>This address is only shown now. You can create a new link later.</small></section>}
    <section aria-label="Paper share links"><h3>Links for this paper</h3>{page?.links.length ? <ul className="paper-sharing-list">{page.links.map(link => <li key={link.id} data-share-id={link.id}><div><strong>{link.label || 'Untitled link'}</strong><span>Version {link.versionNumber} · {link.revokedAt ? 'Revoked' : 'Active'}</span><small>Created {new Date(link.createdAt).toLocaleString()}</small></div>{!link.revokedAt && <button className="button danger" type="button" disabled={!permitted || busy || Boolean(revoke && revoke.linkId !== link.id)} onClick={() => void retract(revoke?.linkId === link.id ? revoke : { id: crypto.randomUUID(), linkId: link.id })}>{revoke?.linkId === link.id ? 'Retry revoking link' : 'Revoke link'}</button>}</li>)}</ul> : <p className="muted">{busy ? 'Loading links…' : page ? 'No links yet.' : 'Links have not been loaded.'}</p>}{page?.nextCursor && <button className="button" type="button" disabled={!permitted || busy} onClick={() => void load(page.nextCursor!)}>Load more links</button>}</section>
  </div></dialog>;
}
