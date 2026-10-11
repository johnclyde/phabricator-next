import { useEffect, useRef, useState } from 'react';
import type { DiscussionPreferences, ThreadPreference } from '../shared/discussion';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { choiceMatches, discussionChoice, discussionPreferences, type DiscussionChoice } from './discussion-state';

export function useDiscussionPreferences(revisionId: string, threadIds: readonly string[], online: boolean, accessEpoch?: number) {
  const { request, readStored, writeStored, clearDiscussionChoice, isActive, unavailableObject, onAccessChange, storageKey, draftHasUnsavedMemory, writeDiscussionChoice } = useWorkspace();
  const cacheKey = `discussion-preferences:${revisionId}`; const choiceKey = (id: string) => `discussion-choice:${revisionId}:${id}`;
  const [preferences, setPreferences] = useState(() => discussionPreferences(readStored(cacheKey, null), revisionId)); const prefRef = useRef(preferences); prefRef.current = preferences;
  const readChoices = () => Object.fromEntries(threadIds.flatMap(id => { const choice = discussionChoice(readStored(choiceKey(id), null), revisionId, id); return choice ? [[id, choice]] : []; }));
  const [choices, setChoices] = useState<Record<string, DiscussionChoice>>(readChoices); const choiceRef = useRef(choices); choiceRef.current = choices;
  const [busy, setBusy] = useState<Set<string>>(new Set()); const busyRef = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({}); const [warning, setWarning] = useState(''); const [loading, setLoading] = useState(false);
  const mounted = useRef(true); const sequence = useRef(0); const active = () => mounted.current && isActive() && !unavailableObject(revisionId);
  const replaceChoices = (next: Record<string, DiscussionChoice>) => { choiceRef.current = next; setChoices(next); };
  const load = async () => {
    if (!active()) return null; const generation = ++sequence.current; setLoading(true);
    try { const raw = await request<DiscussionPreferences>(`/api/revisions/${revisionId}/discussion-preferences`); if (!active()) return null; const next = discussionPreferences(raw, revisionId); if (!next) throw new Error('The saved presentation response was invalid. Local choices remain unchanged.'); if (generation === sequence.current) { prefRef.current = next; setPreferences(next); setWarning(writeStored(cacheKey, next) ? '' : 'Saved presentation could not be cached here.'); } return generation === sequence.current ? next : null; }
    catch (failure) { if (active() && generation === sequence.current) setWarning(isNetworkError(failure) ? 'Offline presentation uses saved preferences and local choices. Reconnect and explicitly save pending choices.' : failure instanceof Error ? failure.message : 'Saved presentation could not be loaded.'); return null; }
    finally { if (active() && generation === sequence.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { const sync = (event: StorageEvent) => { if (!active()) return; if (event.key === null || event.key.startsWith(storageKey(`discussion-choice:${revisionId}:`))) replaceChoices(readChoices()); if (event.key === null || event.key === storageKey(cacheKey)) { sequence.current++; setLoading(false); const next = discussionPreferences(readStored(cacheKey, null), revisionId); prefRef.current = next; setPreferences(next); } }; window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync); }, [threadIds.join('|')]);
  useEffect(() => onAccessChange(ids => { if (ids.includes(revisionId)) { sequence.current++; prefRef.current = null; setPreferences(null); replaceChoices({}); setLoading(false); } }), []);
  useEffect(() => { replaceChoices({ ...readChoices(), ...choiceRef.current }); void load(); }, [online, threadIds.join('|'), accessEpoch]);
  useEffect(() => { const refresh = () => { if (online && document.visibilityState !== 'hidden') void load(); }; window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, [online]);
  const save = async (id: string, expected = choiceRef.current[id]) => {
    if (!active() || !online || !expected || expected.expectedVersion === null || busyRef.current.has(id)) return;
    const submitted = { ...expected, attempted: true };
    if (!choiceMatches(choiceRef.current[id], expected)) return;
    busyRef.current.add(id); setBusy(new Set(busyRef.current)); setErrors(current => ({ ...current, [id]: '' }));
    try {
      const stored = await writeDiscussionChoice(choiceKey(id), expected, submitted, () => active() && choiceMatches(choiceRef.current[id], expected));
      if (!active()) return;
      if (stored === 'changed' || stored === 'unavailable') throw new Error('Another tab changed this local choice. Reload saved presentation before choosing again.');
      replaceChoices({ ...choiceRef.current, [id]: submitted });
      if (stored === 'memory') setWarning('Storage could not save this choice. Keep this tab open until it is confirmed, or export unsaved work before closing.');
      const result = await request<ThreadPreference>(`/api/revisions/${revisionId}/threads/${id}/preference`, { method: 'PATCH', id: submitted.requestId, body: { collapsed: submitted.collapsed, expectedVersion: submitted.expectedVersion } });
      if (!active()) return;
      if (result.revisionId !== revisionId || result.threadId !== id || result.collapsed !== submitted.collapsed || !Number.isSafeInteger(result.version) || result.version < submitted.expectedVersion! || result.version > submitted.expectedVersion! + 1) throw new Error('The preference response did not match this choice. Retry its exact request explicitly.');
      // Saved retries may return historical preferences. Read current authorized
      // presentation before replacing a local choice, without rebasing a write.
      const current = await load(); if (!active() || !current) throw new Error('The preference was acknowledged, but current presentation could not be loaded. Retry this exact choice to confirm current state.');
      await clearDiscussionChoice(choiceKey(id), submitted, active); await clearDiscussionChoice(choiceKey(id), expected, active); if (!active()) return;
      if (choiceMatches(choiceRef.current[id], submitted)) { const remaining = discussionChoice(readStored(choiceKey(id), null), revisionId, id); const next = { ...choiceRef.current }; if (remaining) next[id] = remaining; else delete next[id]; replaceChoices(next); }
    } catch (failure) { if (active()) setErrors(current => ({ ...current, [id]: isNetworkError(failure) ? 'Save outcome is unknown. Retry this exact personal preference when connected.' : failure instanceof Error ? failure.message : 'Could not save presentation. Reload saved presentation before choosing again.' })); }
    finally { busyRef.current.delete(id); if (mounted.current) setBusy(new Set(busyRef.current)); }
  };
  const collapsed = (id: string) => choiceRef.current[id]?.collapsed ?? prefRef.current?.preferences.find(item => item.threadId === id)?.collapsed ?? false;
  const choose = (id: string, value: boolean): { saving: boolean; changed: boolean } => {
    if (!active() || busyRef.current.has(id) || !threadIds.includes(id)) return { saving: false, changed: false };
    const pending = choiceRef.current[id];
    if (pending?.attempted) { setErrors(current => ({ ...current, [id]: 'This choice has already been submitted. Retry it exactly or reload saved presentation before making another choice.' })); return { saving: false, changed: false }; }
    const base = prefRef.current?.preferences.find(item => item.threadId === id); const choice: DiscussionChoice = { revisionId, threadId: id, collapsed: value, expectedVersion: pending ? pending.expectedVersion : base?.version ?? null, requestId: crypto.randomUUID(), attempted: false };
    replaceChoices({ ...choiceRef.current, [id]: choice });
    const saving = online && !pending && choice.expectedVersion !== null;
    void writeDiscussionChoice(choiceKey(id), pending || null, choice, () => active() && choiceMatches(choiceRef.current[id], choice)).then(result => {
      if (!active() || !choiceMatches(choiceRef.current[id], choice)) return;
      if (result === 'changed' || result === 'unavailable') { replaceChoices(readChoices()); setErrors(current => ({ ...current, [id]: 'Another tab changed this personal choice. Its exact request was kept. Reload saved presentation before choosing again.' })); return; }
      if (result === 'memory') setWarning('This local presentation choice is only in memory. Keep this tab open until saved, or export unsaved work before closing.');
      if (saving) void save(id, choice);
    });
    return { saving, changed: true };
  };
  const reload = async (id: string) => {
    if (!active() || !online || busyRef.current.has(id)) return;
    const existing = choiceRef.current[id];
    if (existing && !window.confirm('Reload your saved presentation and discard this local collapse choice? An uncertain request may already have saved. Source and reply drafts are kept.')) return;
    const next = await load(); if (!next || !active()) return;
    if (existing) await clearDiscussionChoice(choiceKey(id), existing, active); if (!active()) return;
    if (!existing || choiceMatches(choiceRef.current[id], existing)) { const remaining = discussionChoice(readStored(choiceKey(id), null), revisionId, id); const choices = { ...choiceRef.current }; if (remaining) choices[id] = remaining; else delete choices[id]; replaceChoices(choices); setErrors(current => ({ ...current, [id]: '' })); }
  };
  return { collapsed, choices, busy, errors, warning, loading, choose, save, reload, unsavedMemory: (id: string) => draftHasUnsavedMemory(choiceKey(id)) };
}
