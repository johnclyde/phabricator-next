import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { notificationQuery, notificationReadInput, isNotificationInbox, isNotificationSummary, validNotificationReadResult } from '../shared/notifications';

const commands = new Set(['notifications', 'notification-count', 'mark-notifications']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function notificationsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const mark = command === 'mark-notifications', count = command === 'notification-count';
  const allowed = ['server', 'json', 'help', ...(mark ? ['intent', 'request-id'] : count ? [] : ['filter', 'before', 'limit'])];
  if (args.length || optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported notification options without positional arguments.');
  if (mark) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json containing the exact notification action and observed version or horizon.');
    const input = notificationReadInput(await readRequestIntent(options.intent, 'Notification read request'));
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex'), path = '/api/notifications/read';
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact request file and ID to retry an uncertain read-state change. Versions and observed horizons are never refreshed automatically.' }));
    const result = await request<unknown>(path, 'POST', input, requestId);
    if (!validNotificationReadResult(result) || result.inputSha256 !== inputSha256 || result.accessEpoch < input.expectedAccessEpoch) throw new Error('The notification receipt does not match the exact request. Retain it for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  if (count) {
    const result = await request<unknown>('/api/notifications/count');
    if (!isNotificationSummary(result)) throw new Error('The notification count is invalid.');
    console.log(safeJson(result)); return true;
  }
  if (options.limit !== undefined && (typeof options.limit !== 'string' || !/^[1-9]\d*$/.test(options.limit))) throw new Error('--limit must be an integer from 1 to 100.');
  const query = notificationQuery({ ...(options.filter === undefined ? {} : { filter: options.filter }), ...(options.before === undefined ? {} : { before: options.before }), ...(options.limit === undefined ? {} : { limit: Number(options.limit) }) });
  const parameters = new URLSearchParams({ filter: query.filter, limit: String(query.limit), ...(query.before === undefined ? {} : { before: query.before }) });
  const result = await request<unknown>(`/api/notifications?${parameters}`);
  if (!isNotificationInbox(result) || result.items.length > query.limit || result.nextBefore !== null && result.nextBefore === query.before
    || query.filter !== 'all' && result.items.some(item => item.read !== (query.filter === 'read'))) throw new Error('The notification inbox does not match the requested page.');
  console.log(safeJson(result)); return true;
}
