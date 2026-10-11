import { isTaskMuteHistory, isTaskMuteSnapshot, isTaskNotificationId, taskMuteInput, validTaskMuteResult, type TaskMuteHistory, type TaskMuteInput, type TaskMuteReceipt, type TaskMuteSnapshot } from '../shared/task-notifications';
export interface TaskMuteReading { snapshot: TaskMuteSnapshot; history: TaskMuteHistory }
export interface TaskMuteDraft { taskId: string; principalId: string; input: TaskMuteInput }
export interface TaskMuteIntent { id: string; taskId: string; principalId: string; body: TaskMuteInput; draft: TaskMuteDraft }
export const TASK_MUTE_HISTORY_LIMIT = 500;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function history(value: unknown, id: string, self: string): value is TaskMuteHistory {
  if (!record(value) || !Array.isArray(value.entries) || value.entries.length > TASK_MUTE_HISTORY_LIMIT || !isTaskMuteHistory({ ...value, entries: value.entries.slice(0, 100), nextBefore: null }, id, self)) return false;
  const entries = value.entries as TaskMuteHistory['entries'];
  return entries.every((entry, index) => isTaskMuteHistory({ ...value, entries: [entry], nextBefore: null }, id, self) && (!index || entries[index - 1]!.version > entry.version)) && new Set(entries.map(entry => entry.id)).size === entries.length && (value.nextBefore === null || entries.at(-1)?.version === value.nextBefore);
}
export function taskMuteReading(value: unknown, id: string, self: string): TaskMuteReading | null {
  if (!record(value) || Object.keys(value).length !== 2 || !isTaskMuteSnapshot(value.snapshot, id, self) || !history(value.history, id, self)) return null;
  const { snapshot, history: page } = value;
  const newest = page.entries[0];
  const stateMatches = snapshot.version === 0 ? page.entries.length === 0 : newest?.version === snapshot.version && newest.after === snapshot.muted && newest.createdAt === snapshot.updatedAt;
  return stateMatches && snapshot.version === page.version && snapshot.accessEpoch === page.accessEpoch ? { snapshot, history: page } : null;
}
export function mergeTaskMuteHistory(previous: TaskMuteHistory, next: TaskMuteHistory): TaskMuteHistory {
  if (!history(previous, previous.taskId, previous.principalId) || !isTaskMuteHistory(next, previous.taskId, previous.principalId) || previous.nextBefore === null || previous.version !== next.version || previous.accessEpoch !== next.accessEpoch || next.entries.some(entry => entry.version >= previous.nextBefore! || previous.entries.some(old => old.id === entry.id)) || previous.entries.length + next.entries.length > TASK_MUTE_HISTORY_LIMIT) throw new Error('Your notification preference history changed. Reload Task Notifications.');
  return { ...next, entries: [...previous.entries, ...next.entries] };
}
export function taskMuteDraft(value: unknown, id: string, self: string): TaskMuteDraft | null {
  if (!record(value) || Object.keys(value).length !== 3 || value.taskId !== id || !isTaskNotificationId(id) || value.principalId !== self) return null;
  try { return { taskId: id, principalId: self, input: taskMuteInput(value.input) }; } catch { return null; }
}
export function taskMuteIntent(value: unknown, id: string, self: string): TaskMuteIntent | null {
  if (!record(value) || Object.keys(value).length !== 5 || !uuid(value.id) || value.taskId !== id || value.principalId !== self) return null;
  const draft = taskMuteDraft(value.draft, id, self); if (!draft) return null;
  try { const body = taskMuteInput(value.body); return JSON.stringify(body) === JSON.stringify(draft.input) ? { id: value.id, taskId: id, principalId: self, body, draft } : null; } catch { return null; }
}
export function taskMuteDraftMatches(draft: TaskMuteDraft, snapshot: TaskMuteSnapshot): boolean { return draft.taskId === snapshot.taskId && draft.principalId === snapshot.principalId && draft.input.expectedMuteVersion === snapshot.version && draft.input.expectedAccessEpoch === snapshot.accessEpoch; }
export async function verifiedTaskMuteReceipt(value: unknown, intent: TaskMuteIntent): Promise<TaskMuteReceipt> {
  if (!validTaskMuteResult(value, intent.taskId)) throw new Error('The task notification receipt is invalid. Retain the exact request for recovery.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(taskMuteInput(intent.body))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The receipt belongs to another preference request. Retry the original request.');
  return value;
}
