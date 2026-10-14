import { useEffect, useRef, useState } from 'react';
import type { SuiteApp } from '../shared/suite';
import type { SuiteFollowing, SuiteNotificationPreference, SuiteNotificationPreferenceInput } from '../shared/suite-notifications';
import { useWorkspace } from './SessionGate';
import { useDraftRetention } from './draft-retention';
import { AutomationPanel, AutomationRecovery, exportAutomation, useAutomationMutation, useAutomationRead, type AutomationIntent } from './AutomationSupport';

export function SuiteNotificationSettings({ app, recordId, version, online }: { app: SuiteApp; recordId: string; version: number; online: boolean }) {
  const path = `/api/suite/${app}/${recordId}/notifications`, client = useWorkspace(), key = `draft:automation:suite:notifications:${recordId}:editor`;
  const current = useAutomationRead<SuiteNotificationPreference>(path, online), mutation = useAutomationMutation(`suite:notifications:${recordId}`, online);
  const [draft, setDraft] = useState<SuiteNotificationPreferenceInput | null>(() => client.readStored(key, null)), [saved, setSaved] = useState(true), [notice, setNotice] = useState('');
  const draftRef = useRef(draft); draftRef.current = draft;
  const retain = useDraftRetention(client, key, setSaved);
  useEffect(() => { void current.reload(); }, [version]);
  const change = (value: Partial<SuiteNotificationPreferenceInput>) => {
    if (!draft && !current.data) return;
    const next: SuiteNotificationPreferenceInput = { expectedPreferenceVersion: current.data?.version ?? 0, expectedAccessEpoch: current.data?.accessEpoch ?? 0, following: current.data?.following ?? 'default', muted: current.data?.muted ?? false, email: current.data?.email ?? false, ...draft, ...value };
    setDraft(next); retain(next);
  };
  const send = async (intent: AutomationIntent) => {
    if (intent.path !== path) return;
    const result = await mutation.send<SuiteNotificationPreference>(intent);
    if (!result || !client.isActive()) return;
    const matches = () => client.isActive() && JSON.stringify(draftRef.current) === JSON.stringify(intent.body);
    if (matches() && await client.removeRetainedDraftIfEqual(key, intent.body, matches) && matches()) { setDraft(null); draftRef.current = null; }
    await current.reload(); setNotice('Notification preferences saved.');
  };
  const busy = mutation.busy || Boolean(mutation.pending), values = draft ?? current.data;
  const stale = Boolean(draft && current.data && (draft.expectedPreferenceVersion !== current.data.version || draft.expectedAccessEpoch !== current.data.accessEpoch));
  return <AutomationPanel title="Your Notifications" actions={<button type="button" className="button" disabled={!online || current.loading} onClick={() => void current.reload()}>Refresh Preferences</button>}>
    <p className="small muted">Choose updates for this object. These preferences are private and do not change anyone’s access.</p>
    {[current.error, mutation.error].filter(Boolean).map((error, index) => <p key={index} className="banner error" role="alert">{error}</p>)}
    {notice && <p role="status" className="info-strip">{notice}</p>}
    <AutomationRecovery pending={mutation.pending} busy={mutation.busy} online={online} retry={() => { if (mutation.pending) void send(mutation.pending); }} forget={() => void mutation.forget()}/>
    {values && <form className="automation-form" aria-label="Notification preferences" onSubmit={event => { event.preventDefault(); if (draft && current.data && !stale) void send({ id: crypto.randomUUID(), method: 'POST', path, label: 'Save Notification Preferences', body: draft }); }}>
      <label className="field"><span>Follow updates</span><select aria-label="Follow updates" value={values.following} disabled={busy} onChange={event => change({ following: event.target.value as SuiteFollowing })}><option value="default">Automatic — based on participation</option><option value="following">Follow this object</option><option value="ignored">Do not follow</option></select></label>
      {current.data && <p className="small muted">{current.data.effectiveFollowing ? 'You currently follow this object.' : 'You do not currently follow this object.'} Muting stops future delivery; existing inbox entries remain.</p>}
      <label className="automation-check"><input type="checkbox" checked={values.muted} disabled={busy} onChange={event => change({ muted: event.target.checked })}/>Mute new notifications</label>
      <label className="automation-check"><input type="checkbox" checked={values.email} disabled={busy} onChange={event => change({ email: event.target.checked })}/>Allow email updates for this object</label>
      <p className="small muted">Email also requires your account’s email preference and an operator-configured mail service. Following and current access are required.</p>
      {stale && <p className="info-strip">Preferences or access changed. Your unsaved choices are retained. Review them before using the current version.</p>}
      {!saved && <p className="banner warning">These unsaved choices may only be held in this tab. Export them before closing.</p>}
      <div className="automation-actions"><button className="button" disabled={!online || busy || current.loading || !current.data || !draft || stale}>Save Notification Preferences</button>{stale && <button className="button" type="button" disabled={busy} onClick={() => { if (current.data) change({ expectedPreferenceVersion: current.data.version, expectedAccessEpoch: current.data.accessEpoch }); }}>Use Current Preference Version</button>}{draft && <><button className="button" type="button" onClick={() => exportAutomation(draft, 'notification-preferences')}>Export Choices</button><button className="button" type="button" disabled={busy} onClick={() => { const expected = draft; if (window.confirm('Discard these unsaved notification preferences?')) void client.removeRetainedDraftIfEqual(key, expected, () => JSON.stringify(draftRef.current) === JSON.stringify(expected)).then(removed => { if (removed && JSON.stringify(draftRef.current) === JSON.stringify(expected)) { setDraft(null); draftRef.current = null; } }); }}>Discard Choices</button></>}</div>
    </form>}
  </AutomationPanel>;
}
