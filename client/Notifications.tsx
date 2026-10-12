import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, RefreshCw, X } from 'lucide-react';
import { isNotificationInbox, isNotificationSummary, type NotificationInput, type NotificationItem, type NotificationSummary } from '../shared/notifications';
import { useWorkspace } from './SessionGate';
import { isNetworkError, RequestError } from './offline';
import { onSessionLocked } from './session';
import { retainFileIntent } from './file-client';
import { mergeNotifications, notificationCache, notificationContextLabel, notificationIntent, notificationIntentObjectId, notificationLabel, notificationSummary, NOTIFICATION_CACHE_LIMIT, verifiedNotificationReceipt, type NotificationCache, type NotificationFilter, type NotificationIntent, type NotificationPage } from './notification-client';

export function useNotifications(online: boolean, workspaceEpoch: number, refreshWorkspace: () => Promise<number>) {
  const client = useWorkspace(), principalId = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`;
  const cacheKey = `notifications:${principalId}`, requestKey = `notification-request:${principalId}`;
  const [cache, setCache] = useState<NotificationCache | null>(() => notificationCache(client.readStored(cacheKey, null), principalId));
  const current = useRef(cache), onlineRef = useRef(online), mounted = useRef(true), sequence = useRef(0), summarySequence = useRef(0), pageSequence = useRef(0);
  const [pending, setPending] = useState<NotificationIntent | null>(() => notificationIntent(client.readStored(requestKey, null), principalId));
  const [busy, setBusy] = useState(false), busyRef = useRef(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true);
  const refreshRef = useRef<() => void>(() => {}); onlineRef.current = online;
  const authorityEpoch = useRef(workspaceEpoch), authorityRefresh = useRef(refreshWorkspace), authorityRequest = useRef<Promise<number> | null>(null);
  authorityEpoch.current = Math.max(authorityEpoch.current, workspaceEpoch); authorityRefresh.current = refreshWorkspace;
  const ensureAuthority = async (epoch: number) => {
    if (authorityEpoch.current < epoch) {
      const request = authorityRequest.current || (authorityRequest.current = authorityRefresh.current());
      try { authorityEpoch.current = Math.max(authorityEpoch.current, await request); }
      finally { if (authorityRequest.current === request) authorityRequest.current = null; }
    }
    return mounted.current && client.isActive() && onlineRef.current && authorityEpoch.current === epoch && client.session?.accessEpoch === epoch;
  };
  const valid = (ticket: number, generation: number, epoch?: number) => mounted.current && client.isActive() && sequence.current === ticket && client.notificationGeneration() === generation && (epoch === undefined || epoch === client.session?.accessEpoch);
  const store = (next: NotificationCache) => { current.current = next; setCache(next); setSaved(client.writeStored(cacheKey, next)); };
  const retire = useCallback(() => { sequence.current++; summarySequence.current++; pageSequence.current++; current.current = null; if (mounted.current) { setCache(null); setLoading(false); } }, []);
  const loadSummary = useCallback(async (): Promise<NotificationSummary | null> => {
    if (!onlineRef.current || !client.isActive()) return null;
    const ticket = sequence.current, call = ++summarySequence.current;
    try {
      const value = await client.request<unknown>('/api/notifications/count'), generation = client.notificationGeneration();
      if (!valid(ticket, generation) || call !== summarySequence.current) return null;
      if (!isNotificationSummary(value, principalId) || !valid(ticket, generation, value.accessEpoch)) throw new Error('The notification summary is invalid. Reload Notifications.');
      if (!await ensureAuthority(value.accessEpoch) || !valid(ticket, generation, value.accessEpoch) || call !== summarySequence.current) return null;
      const previous = current.current;
      if (previous && value.readVersion < previous.summary.readVersion) return null;
      store({ summary: value, pages: previous?.summary.readVersion === value.readVersion && previous.summary.accessEpoch === value.accessEpoch ? previous.pages : [] });
      setError(''); return value;
    } catch (failure) { if (mounted.current && call === summarySequence.current && ticket === sequence.current) { if (!isNetworkError(failure)) { retire(); client.removeStored(cacheKey); } setError(failure instanceof Error ? failure.message : 'Could not load notifications.'); } return null; }
  }, []);
  const loadPage = useCallback(async (filter: NotificationFilter, more = false, compact = false) => {
    if (!onlineRef.current || !client.isActive()) return;
    const previous = current.current?.pages.find(page => page.filter === filter);
    if (more && (!previous?.nextBefore || previous.items.length >= NOTIFICATION_CACHE_LIMIT)) return;
    const ticket = sequence.current, call = ++pageSequence.current;
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ filter, limit: compact ? '10' : '25' }); if (more && previous?.nextBefore) query.set('before', previous.nextBefore);
      const value = await client.request<unknown>(`/api/notifications?${query}`), generation = client.notificationGeneration();
      if (!valid(ticket, generation) || call !== pageSequence.current) return;
      if (!isNotificationInbox(value, principalId) || !valid(ticket, generation, value.accessEpoch)) throw new Error('The notification page is invalid. Reload Notifications.');
      if (!await ensureAuthority(value.accessEpoch) || !valid(ticket, generation, value.accessEpoch) || call !== pageSequence.current) return;
      const previousCache = current.current;
      if (previousCache && value.readVersion < previousCache.summary.readVersion) throw new Error('Notification read state changed. Reload Notifications.');
      const next: NotificationPage = { ...value, filter }, page = more && previous ? mergeNotifications(previous, next) : next;
      const pages = previousCache?.summary.readVersion === value.readVersion && previousCache.summary.accessEpoch === value.accessEpoch ? previousCache.pages.filter(item => item.filter !== filter) : [];
      store({ summary: notificationSummary(value), pages: [...pages, page] });
    } catch (failure) { if (mounted.current && call === pageSequence.current && ticket === sequence.current) { if (!isNetworkError(failure)) { client.removeStored(cacheKey); retire(); } setError(failure instanceof Error ? failure.message : 'Could not load notifications.'); } }
    finally { if (mounted.current && call === pageSequence.current) setLoading(false); }
  }, []);
  refreshRef.current = () => { if (onlineRef.current) void loadSummary(); };
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { retire(); queueMicrotask(() => { if (mounted.current) refreshRef.current(); }); };
    const stop = client.onNotificationChange(invalidate), locked = onSessionLocked(retire);
    const focus = () => refreshRef.current(), visible = () => { if (document.visibilityState === 'visible') focus(); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === client.storageKey(requestKey)) setPending(notificationIntent(client.readStored(requestKey, null), principalId)); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible); window.addEventListener('storage', storage);
    return () => { mounted.current = false; sequence.current++; stop(); locked(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => { if (online) void loadSummary(); else { sequence.current++; summarySequence.current++; pageSequence.current++; setLoading(false); } }, [online]);
  const send = async (intent: NotificationIntent) => {
    if (!onlineRef.current || busyRef.current || !client.isActive() || client.draftIsHeld(requestKey)) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(notificationIntent(retained.intent, principalId));
      if (!retained.accepted) throw new Error('An earlier notification change needs confirmation. Retry or export its exact request first.');
      if (!retained.persisted) setNotice('The exact request is kept only in this tab. Keep this tab open or export it.');
      const result = await client.request<unknown>('/api/notifications/read', { method: 'POST', body: intent.body, id: intent.id }, notificationIntentObjectId(intent) ? [notificationIntentObjectId(intent)!] : []);
      const generation = client.notificationGeneration(), receipt = await verifiedNotificationReceipt(result, intent);
      if (!client.isActive() || generation !== client.notificationGeneration() || receipt.accessEpoch !== client.session?.accessEpoch) return;
      client.removeStoredIfEqual(requestKey, intent);
      if (mounted.current) { setPending(notificationIntent(client.readStored(requestKey, null), principalId)); setNotice(receipt.changed ? 'Notification read state saved.' : 'The notification read state already matched this request.'); }
      client.invalidateNotifications();
    } catch (failure) { if (failure instanceof RequestError && client.isActive()) client.invalidateNotifications(); if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not save notification read state.'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const mark = (body: NotificationInput, objectId: string | null = null) => send({ id: crypto.randomUUID(), principalId, body, objectId });
  const opened = async (objectId: string, observed: NotificationSummary | null | Promise<NotificationSummary | null>, stillOpen: () => boolean) => {
    // Called once for a deliberate, successfully loaded foreground navigation.
    if (!onlineRef.current || busyRef.current || client.readStored(requestKey, null) || client.draftIsHeld(requestKey)) return;
    const summary = await observed;
    if (!summary || !stillOpen() || !onlineRef.current || !client.isActive() || summary.accessEpoch !== client.session?.accessEpoch || client.unavailableObject(objectId)) return;
    if (!await ensureAuthority(summary.accessEpoch) || !stillOpen() || client.unavailableObject(objectId)) return;
    await mark({ action: 'read_object', objectId, horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch }, objectId);
  };
  const observeOpening = async () => {
    const summary = current.current?.summary;
    if (summary && summary.accessEpoch === client.session?.accessEpoch) return summary;
    const observed = await loadSummary();
    // Startup authority can supersede the first summary. A single fresh read is
    // part of this opening, not a later focus/reconnect action.
    return observed || (mounted.current && onlineRef.current && client.isActive() ? await loadSummary() : null);
  };
  return { cache, pending, busy, loading, error, notice, saved, online, writable: online && cache?.summary.accessEpoch === client.session?.accessEpoch && cache?.summary.accessEpoch === authorityEpoch.current, durable: client.durable, held: client.draftIsHeld(requestKey), loadPage, loadSummary, mark, opened, observeOpening, retry: () => pending && void send(pending), discard: () => { if (pending && window.confirm('Discard this retained notification request? Its server outcome may still be unknown.')) { client.removeStoredIfEqual(requestKey, pending); setPending(notificationIntent(client.readStored(requestKey, null), principalId)); } } };
}
export type NotificationController = ReturnType<typeof useNotifications>;
function exportRequest(intent: NotificationIntent) { const url = URL.createObjectURL(new Blob([JSON.stringify(intent, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `notification-request-${intent.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function NotificationRecovery({ controller: c }: { controller: NotificationController }) { return <>{c.error && <p className="error-text" role="alert">{c.error}</p>}{c.notice && <p className="muted small" role="status">{c.notice}</p>}{c.pending && <div className="notification-recovery"><strong>Unconfirmed notification change</strong><p>The original request is retained. Retrying confirms the same change, including its original read boundary.</p><div className="notification-actions"><button className="button" disabled={!c.online || c.busy || c.held} onClick={c.retry}>Retry Exact Change</button><button className="button" onClick={() => exportRequest(c.pending!)}>Export Request</button><button className="button" disabled={c.busy} onClick={c.discard}>Discard Request</button></div></div>}</>; }
function NotificationRows({ items, controller: c, close }: { items: NotificationItem[]; controller: NotificationController; close?: () => void }) {
  return <div className="notification-rows">{items.map(item => <article key={item.id} className={`notification-row ${item.read ? 'is-read' : 'is-unread'}`} data-notification-id={item.id}><span className="notification-state" aria-label={item.read ? 'Read' : 'Unread'}>{item.read ? <Check size={14}/> : <span/>}</span><div className="notification-main"><p><strong>{item.event.actor?.displayName || 'Actor not recorded'}</strong> {notificationLabel(item.event.kind, item.object.kind)}.</p><a href={`#${item.object.id}`} onClick={close}>{item.object.id} {item.object.title}</a><div className="notification-meta"><time dateTime={item.event.createdAt}>{new Date(item.event.createdAt).toLocaleString()}</time>{notificationContextLabel(item) && <span>{notificationContextLabel(item)}</span>}</div></div><button className="button notification-read-action" disabled={!c.writable || c.busy || Boolean(c.pending) || c.held || !c.cache} onClick={() => void c.mark({ action: item.read ? 'unread' : 'read', notificationId: item.id, expectedVersion: item.version, expectedAccessEpoch: c.cache!.summary.accessEpoch }, item.object.id)}>{item.read ? 'Mark Unread' : 'Mark Read'}</button></article>)}</div>;
}
export function NotificationBell({ controller: c, viewAll }: { controller: NotificationController; viewAll: () => void }) {
  const [open, setOpen] = useState(false), element = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const page = c.cache?.pages.find(item => item.filter === 'all');
  useEffect(() => { if (open && c.online && !page && !c.loading && !c.error) void c.loadPage('all', false, true); }, [open, c.online, page, c.loading, c.error]);
  useEffect(() => { if (!open) return; const outside = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) setOpen(false); }, key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } }; document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); }; }, [open]);
  const count = c.cache?.summary.unreadCount;
  return <div className="notification-bell" ref={element}><button ref={button} className="icon-button notification-bell-button" aria-label={`Notifications${count === undefined ? ', count unavailable' : `, ${count} unread`}`} aria-expanded={open} aria-controls="notification-menu" onClick={() => { setOpen(!open); if (!open && c.online) { void c.loadSummary(); void c.loadPage('all', false, true); } }}><Bell size={19}/>{count !== undefined && count > 0 && <span className="notification-count">{count > 999 ? '999+' : count}</span>}</button>{open && <section id="notification-menu" className="notification-menu" aria-label="Notification menu"><div className="notification-menu-heading"><strong>Notifications</strong><button className="icon-button" aria-label="Close notifications" onClick={() => { setOpen(false); button.current?.focus(); }}><X size={18}/></button></div><NotificationReadThrough controller={c}/><p className="muted small notification-opening-help">Links open the current object. Saved source selections are retained.</p><NotificationRecovery controller={c}/>{page ? <NotificationRows items={page.items.slice(0, 10)} controller={c} close={() => setOpen(false)}/> : <p>{c.loading ? 'Loading notifications…' : 'No saved notification page. Reconnect or reload to read it.'}</p>}{page?.items.length === 0 && <p>You have no notifications.</p>}<button className="button notification-view-all" onClick={() => { setOpen(false); viewAll(); }}>View All Notifications</button>{!c.online && <p className="muted small">Offline · saved notifications. Read changes require a connection.</p>}</section>}</div>;
}
function NotificationReadThrough({ controller: c }: { controller: NotificationController }) { const summary = c.cache?.summary; return <div className="notification-clear"><button className="button" disabled={!c.writable || c.busy || Boolean(c.pending) || c.held || !summary || summary.unreadCount === 0} onClick={() => { if (summary && window.confirm('Mark notifications through the boundary observed in this inbox as read? Notifications delivered after that boundary stay unread.')) void c.mark({ action: 'read_through', horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch }); }}>Mark All Read</button><small>Through the last observed boundary; later notifications stay unread.</small></div>; }
export default function Notifications({ controller: c, filter, changeFilter }: { controller: NotificationController; filter: NotificationFilter; changeFilter: (filter: NotificationFilter) => void }) {
  const page = c.cache?.pages.find(item => item.filter === filter);
  useEffect(() => { if (c.online) void c.loadPage(filter); }, [filter, c.online]);
  useEffect(() => { if (c.online && !page && !c.loading && !c.error) void c.loadPage(filter); }, [page, c.online, c.loading, c.error, filter]);
  return <section className="panel notification-inbox" aria-label="Notification inbox"><div className="panel-heading"><h2><Bell size={18}/>Your Notifications</h2><button className="button" disabled={!c.online || c.loading} onClick={() => void c.loadPage(filter)}><RefreshCw size={14}/>Reload Notifications</button></div><div className="notification-inbox-controls"><div className="filter-bar" aria-label="Notification filter">{(['all', 'unread', 'read'] as const).map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => changeFilter(value)}>{value === 'all' ? 'All Notifications' : value === 'unread' ? 'Unread Notifications' : 'Read Notifications'}</button>)}</div><NotificationReadThrough controller={c}/><p className="muted small">Updates for tasks, revisions, documents and pastes you follow. Project watching also delivers supported task and revision updates. No email or push notifications are sent. Links open the current object. Saved source selections are retained.</p>{!c.online && <p className="info-strip">Offline · {c.durable ? 'authorized saved notifications' : 'notifications loaded in this tab'}. Read changes require an explicit online action.</p>}{!c.saved && <p className="info-strip">Browser storage is unavailable. These notifications remain in this tab only.</p>}<NotificationRecovery controller={c}/></div>{page ? <NotificationRows items={page.items} controller={c}/> : <p className="notification-empty">{c.loading ? 'Loading notifications…' : 'No saved page for this filter. Reconnect and reload Notifications.'}</p>}{page?.items.length === 0 && <p className="notification-empty">{filter === 'unread' ? 'You have no unread notifications.' : filter === 'read' ? 'You have no read notifications.' : 'You have no notifications.'}</p>}{page?.nextBefore && <div className="notification-pagination"><button className="button" disabled={!c.online || c.loading || page.items.length >= NOTIFICATION_CACHE_LIMIT} onClick={() => void c.loadPage(filter, true)}>Load Older Notifications</button>{page.items.length >= NOTIFICATION_CACHE_LIMIT && <small>Showing the first {NOTIFICATION_CACHE_LIMIT} notifications in this view.</small>}</div>}</section>;
}
