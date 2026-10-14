import { createTransport } from 'nodemailer';

export interface MailMessage { recipient: string; messageId: string; text: string }
export interface MailTransport { send(message: MailMessage): Promise<void>; close(): void }
export interface MailConfiguration {
  from: string; origin: string; recipients: Readonly<Record<string, string>>;
  host: string; port: number; secure: boolean; username?: string; password?: string;
}
// Deliberately accept ordinary single mailboxes only, never display names,
// comments, quoted local parts, lists, or attacker-controlled SMTP syntax.
export function mailbox(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
}
export function validateMailConfiguration(config: MailConfiguration): MailConfiguration {
  let origin: URL;
  try { origin = new URL(config.origin); } catch { throw new Error('Mail requires an HTTPS public origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Mail requires an HTTPS public origin.');
  if (!mailbox(config.from) || !config.host || config.host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(config.host)
    || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.secure !== 'boolean'
    || !!config.username !== !!config.password) throw new Error('Invalid SMTP configuration.');
  if (!config.recipients || typeof config.recipients !== 'object' || Array.isArray(config.recipients) || Object.keys(config.recipients).length > 10000) throw new Error('Mail recipients must map account IDs to single email addresses.');
  const recipients = Object.fromEntries(Object.entries(config.recipients).map(([id, address]) => {
    if (!id || id.length > 200 || !mailbox(address)) throw new Error('Mail recipients must map account IDs to single email addresses.');
    return [id, address];
  }));
  return { ...config, origin: origin.origin, recipients };
}
export function mailFromEnvironment(env: NodeJS.ProcessEnv = process.env): MailConfiguration | undefined {
  if (!env.APP_SMTP_HOST) {
    if (Object.keys(env).some(key => (key.startsWith('APP_SMTP_') || key === 'APP_MAIL_FROM' || key === 'APP_MAIL_RECIPIENTS') && env[key])) throw new Error('Mail settings require APP_SMTP_HOST.');
    return undefined;
  }
  if (env.APP_SMTP_SECURE !== undefined && !['true', 'false'].includes(env.APP_SMTP_SECURE)) throw new Error('APP_SMTP_SECURE must be true or false.');
  let recipients: unknown;
  try { recipients = JSON.parse(env.APP_MAIL_RECIPIENTS ?? '{}'); } catch { throw new Error('APP_MAIL_RECIPIENTS must be a JSON account-to-address map.'); }
  const secure = env.APP_SMTP_SECURE !== 'false';
  return validateMailConfiguration({ host: env.APP_SMTP_HOST, port: Number(env.APP_SMTP_PORT ?? (secure ? 465 : 587)), secure,
    from: env.APP_MAIL_FROM ?? '', origin: env.APP_PUBLIC_ORIGIN ?? '', recipients: recipients as Record<string, string>, username: env.APP_SMTP_USERNAME, password: env.APP_SMTP_PASSWORD });
}
export function smtpMailTransport(config: MailConfiguration): MailTransport {
  const checked = validateMailConfiguration(config);
  const transport = createTransport({ host: checked.host, port: checked.port, secure: checked.secure, requireTLS: true,
    auth: checked.username ? { user: checked.username, pass: checked.password! } : undefined,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  return {
    async send(message) {
      if (!mailbox(message.recipient)) throw new Error('Invalid mail recipient.');
      const result = await transport.sendMail({ from: checked.from, to: message.recipient,
        envelope: { from: checked.from, to: [message.recipient] }, messageId: message.messageId,
        subject: 'You have a new workspace notification', text: message.text,
        disableFileAccess: true, disableUrlAccess: true });
      if (result.accepted.length !== 1 || result.rejected.length) throw new Error('SMTP did not accept the recipient.');
    },
    close() { transport.close(); },
  };
}
