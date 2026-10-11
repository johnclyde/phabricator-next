import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isTaskNotificationId, isTaskMuteSnapshot, isTaskMuteHistory, taskMuteInput, validTaskMuteResult } from '../shared/task-notifications';

const commands = new Set(['task-mute', 'task-mute-history', 'set-task-mute']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function taskNotificationsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const mutate = command === 'set-task-mute', history = command === 'task-mute-history', id = args[0];
  const allowed = ['server', 'json', 'help', ...(mutate ? ['intent', 'request-id'] : history ? ['before', 'limit', 'expected-mute-version'] : [])];
  if (args.length !== 1 || !isTaskNotificationId(id) || optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Choose one task and unique supported task mute options.');
  const path = `/api/tasks/${id}/mute`;
  if (mutate) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact mute action, preference version and access epoch.');
    const input = taskMuteInput(await readRequestIntent(options.intent, 'Task mute request')), requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact file and request ID to confirm an uncertain preference change. The inspected pins are never refreshed automatically.' }));
    const result = await request<unknown>(path, 'POST', input, requestId);
    if (!validTaskMuteResult(result, id) || result.inputSha256 !== inputSha256 || result.accessEpoch < input.expectedAccessEpoch) throw new Error('The task mute receipt does not match this exact request. Retain it for recovery.');
    console.log(safeJson(result)); return true;
  }
  const query = new URLSearchParams();
  if (history) for (const [flag, key] of [['before', 'before'], ['limit', 'limit'], ['expected-mute-version', 'expectedMuteVersion']] as const) {
    const value = options[flag]; if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (flag === 'expected-mute-version' ? 0 : 1) || flag === 'limit' && Number(value) > 100) throw new Error('Choose valid task mute history pagination.');
    query.set(key, value);
  }
  const result = await request<unknown>(`${path}${history ? `/history${query.size ? `?${query}` : ''}` : ''}`);
  if (history) {
    if (!isTaskMuteHistory(result, id) || result.entries.length > Number(options.limit ?? 100) || options.before !== undefined && result.entries.some(entry => entry.version >= Number(options.before)) || options['expected-mute-version'] !== undefined && result.version !== Number(options['expected-mute-version'])) throw new Error('The task mute history does not match the requested page.');
  } else if (!isTaskMuteSnapshot(result, id)) throw new Error('The task mute preference is invalid.');
  console.log(safeJson(result)); return true;
}
