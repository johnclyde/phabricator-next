import type { MailPreference } from '../shared/mail';
import { AutomationRecovery, useAutomationMutation, useAutomationRead } from './AutomationSupport';

export function MailPreferences({ online }: { online: boolean }) {
  const read = useAutomationRead<MailPreference>('/api/mail/preferences', online), mutation = useAutomationMutation('mail', online);
  const save = async () => {
    if (!read.data || mutation.pending) return;
    const result = await mutation.send<MailPreference>({ id: crypto.randomUUID(), path: '/api/mail/preferences', method: 'POST',
      body: { expectedVersion: read.data.version, enabled: !read.data.enabled }, label: read.data.enabled ? 'Disable notification email' : 'Enable notification email' });
    if (result) await read.reload();
  };
  const retry = async () => { if (mutation.pending && await mutation.send<MailPreference>(mutation.pending)) await read.reload(); };
  return <details className="card-body" aria-label="Notification email settings"><summary>Email settings</summary>
    <p className="muted small">Choose email on each object you follow, then enable delivery here. Emails link to your private inbox and contain no document or message text. Only new notifications qualify.</p>
    {read.error && <p role="alert">{read.error}</p>}
    {read.data && <>
      <p>{read.data.available ? <>Operator-configured address: <strong style={{ overflowWrap: 'anywhere' }}>{read.data.address}</strong>. Email is {read.data.enabled ? 'enabled' : 'off'}.</> : 'Email is unavailable until an operator configures a mail service and an address for your account.'}</p>
      <button className="button" disabled={!online || mutation.busy || !!mutation.pending || !read.data.available && !read.data.enabled} onClick={() => void save()}>{read.data.enabled ? 'Disable Email' : 'Enable Email'}</button>
      <p className="muted small">{read.data.counts.pending} pending · {read.data.counts.sent} accepted by mail server · {read.data.counts.failed} rejected · {read.data.counts.uncertain} unconfirmed. Rejected or unconfirmed messages are retained for operator inspection and are not automatically resent.</p>
    </>}
    {!online && <p className="muted small">Reconnect to inspect or change email delivery.</p>}
    <button className="button" disabled={!online || read.loading} onClick={() => void read.reload()}>Refresh Email Status</button>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    <AutomationRecovery pending={mutation.pending} busy={mutation.busy} online={online} retry={() => void retry()} forget={() => void mutation.forget()}/>
  </details>;
}
