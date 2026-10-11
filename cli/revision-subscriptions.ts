import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isRevisionId } from '../shared/revision-dependencies';
import { revisionSubscriptionInput, isRevisionSubscriptionSnapshot, isRevisionSubscriptionPerson, isRevisionSubscriptionHistory, isRevisionMuteHistory, validRevisionSubscriptionResult } from '../shared/revision-subscriptions';

const commands = new Set(['revision-subscriptions', 'revision-subscription-status', 'revision-subscription-history', 'revision-mute-history', 'edit-revision-subscriptions']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function revisionSubscriptionsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const edit = command === 'edit-revision-subscriptions', history = command === 'revision-subscription-history', mute = command === 'revision-mute-history', person = command === 'revision-subscription-status';
  const allowed = ['server', 'json', 'help', ...(edit ? ['intent', 'request-id'] : person ? ['principal'] : mute ? ['before', 'limit', 'mute-version'] : history ? ['before', 'limit', 'subscription-version'] : ['after', 'limit', 'subscription-version', 'author-version', 'reviewer-version'])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported revision following options.');
  const id = args[0]; if (args.length !== 1 || !isRevisionId(id)) throw new Error('Provide one revision ID such as D1, P2 or L3.');
  const path = `/api/revisions/${id}/subscriptions`;
  if (edit) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact following action and inspected versions.');
    const input = revisionSubscriptionInput(await readRequestIntent(options.intent, 'Revision following request'));
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact request file and ID to retry an uncertain following change. No source or role versions are refreshed automatically.' }));
    const result = await request<unknown>(path, 'POST', input, requestId);
    if (!validRevisionSubscriptionResult(result, id, input) || result.inputSha256 !== inputSha256) throw new Error('The following receipt does not match the exact request. Retain it for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  const query = new URLSearchParams();
  for (const [name, key, minimum, maximum] of [['before', 'before', 1, Number.MAX_SAFE_INTEGER], ['limit', 'limit', 1, 100], ['subscription-version', 'expectedSubscriptionVersion', 0, Number.MAX_SAFE_INTEGER], ['author-version', 'expectedAuthorVersion', 0, Number.MAX_SAFE_INTEGER], ['reviewer-version', 'expectedReviewerVersion', 0, Number.MAX_SAFE_INTEGER], ['mute-version', 'expectedMuteVersion', 0, Number.MAX_SAFE_INTEGER]] as const) {
    const value = options[name]; if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
    query.set(key, value);
  }
  for (const [option, key] of [['after', 'after'], ['principal', 'principalId']] as const) {
    const value = options[option]; if (value === undefined) continue;
    if (typeof value !== 'string' || !value.length || value.length > 240 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw new Error(`--${option} must identify one inspected member.`);
    query.set(key, value);
  }
  if (person && !query.has('principalId')) throw new Error('Choose --principal ID to inspect the exact subscription version of one person.');
  const result = await request<unknown>(`${path}${person ? '/person' : mute ? '/mute-history' : history ? '/history' : ''}${query.size ? `?${query}` : ''}`);
  const valid = person ? isRevisionSubscriptionPerson(result, id) && result.status.principalId === options.principal : mute ? isRevisionMuteHistory(result, id) : history ? isRevisionSubscriptionHistory(result, id) : isRevisionSubscriptionSnapshot(result, id);
  if (!valid) throw new Error('The following response does not match the requested revision snapshot.');
  // Shared guards establish shape; explicit page pins must also match this read.
  const value = result as unknown as Record<string, unknown>;
  for (const [option, key] of [['subscription-version', 'subscriptionVersion'], ['author-version', 'authorVersion'], ['reviewer-version', 'reviewerVersion'], ['mute-version', 'muteVersion']] as const) if (options[option] !== undefined && value[key] !== Number(options[option])) throw new Error('The following response uses a different inspected version.');
  const rows = (history || mute ? value.transactions : value.subscribers) as unknown[] | undefined;
  if (options.before !== undefined && (rows as Record<string, unknown>[]).some(row => Number(row[history ? 'subscriptionVersion' : 'version']) >= Number(options.before))) throw new Error('The following response does not match the requested history cursor.');
  if (options.after !== undefined && (rows as Record<string, unknown>[]).some(row => String(row.principalId) <= String(options.after))) throw new Error('The following response does not match the requested subscriber cursor.');
  if (rows && rows.length > Number(options.limit ?? 25)) throw new Error('The following response exceeded the requested page size.');
  console.log(safeJson(result)); return true;
}
