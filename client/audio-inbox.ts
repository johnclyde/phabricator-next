import { applicationBase, storageKey } from './mount.ts';
import { assertSession, sessionIsActive, SessionChangedError, type WorkspaceSession } from './session.ts';

export const AUDIO_INBOX_LIMITS = Object.freeze({ maxDurationMs: 600_000, maxClipBytes: 25 * 1024 * 1024, maxClips: 100, maxTotalBytes: 200 * 1024 * 1024, maxTitleCodeUnits: 200 });
export interface AudioClipMetadata { id: string; title: string; createdAt: string; mimeType: string; durationMs: number; bytes: number }
export interface AudioClip extends AudioClipMetadata { blob: Blob }
export interface AudioInboxIssue { id: string | null; message: string }
export interface AudioInboxListing { clips: AudioClipMetadata[]; issues: AudioInboxIssue[]; persistence: 'device' | 'session'; totalBytes: number }
export type AudioInboxErrorCode = 'invalid_clip' | 'storage_unavailable' | 'storage_error' | 'quota' | 'limit' | 'invalid_data' | 'conflict' | 'disposed';
export class AudioInboxError extends Error {
  constructor(public readonly code: AudioInboxErrorCode, message: string) { super(message); this.name = 'AudioInboxError'; }
}
const FORMAT = 'phabricator.audio.v1';
const STORE = 'clips';
interface StoredClip extends AudioClip { format: typeof FORMAT }
export interface AudioInboxEntry { key: IDBValidKey; value: unknown }
export interface AudioInboxMutation<T> { result: T; put?: { key: string; value: unknown }; deleteKey?: string }
/** Testable atomic storage boundary. The callback is synchronous; a promise resolves only after commit. */
export interface AudioInboxStore {
  transaction<T>(mode: 'readonly' | 'readwrite', signal: AbortSignal, operation: (entries: readonly AudioInboxEntry[]) => AudioInboxMutation<T>): Promise<T>;
  close(): void;
}
export interface AudioInbox {
  readonly persistence: 'device' | 'session';
  list(): Promise<AudioInboxListing>;
  read(id: string): Promise<AudioClip | null>;
  save(clip: AudioClip): Promise<AudioClipMetadata>;
  delete(id: string): Promise<boolean>;
  dispose(): void;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
function invalid(message: string): never { throw new AudioInboxError('invalid_clip', message); }
function metadata(clip: AudioClipMetadata): AudioClipMetadata { return { id: clip.id, title: clip.title, createdAt: clip.createdAt, mimeType: clip.mimeType, durationMs: clip.durationMs, bytes: clip.bytes }; }
/** Checks metadata and the actual Blob size/type, without decoding or claiming to verify encoded duration. */
function validateClip(value: unknown): asserts value is AudioClip {
  if (!record(value) || !validId(value.id)) invalid('The recording needs a valid clip identity.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > AUDIO_INBOX_LIMITS.maxTitleCodeUnits || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.title)) invalid('Give the recording a title of 1–200 characters without control characters.');
  if (typeof value.createdAt !== 'string' || value.createdAt.length !== 24 || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) invalid('The recording has an invalid creation time.');
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > AUDIO_INBOX_LIMITS.maxDurationMs) invalid('The complete recording must have an observed duration greater than zero and at most 10 minutes.');
  if (!(value.blob instanceof Blob) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0 || Number(value.bytes) > AUDIO_INBOX_LIMITS.maxClipBytes || value.blob.size !== value.bytes) invalid('The complete audio Blob must be nonempty, match its size metadata, and be at most 25 MiB.');
  if (typeof value.mimeType !== 'string' || value.mimeType.length > 200 || !/^audio\/[a-z0-9!#$&^_.+-]+(?:[\x20\t]*;[\x20-\x7e]*)?$/i.test(value.mimeType) || value.blob.type !== value.mimeType) invalid('The recording needs a supported audio MIME type matching its Blob.');
}
/** Creating a temporary clip does not save it anywhere. Keep this Blob available if saving fails. */
export function createAudioClip(blob: Blob, options: { title: string; durationMs: number }): AudioClip {
  const clip: AudioClip = { id: crypto.randomUUID(), title: options.title, createdAt: new Date().toISOString(), mimeType: blob.type, durationMs: options.durationMs, bytes: blob.size, blob };
  validateClip(clip); return clip;
}
/** Mount/workspace namespacing is logical separation, not isolation from other same-origin scripts. */
export function audioInboxDatabaseName(workspaceId: string, basePath = applicationBase()): string {
  if (!workspaceId || workspaceId.length > 200) throw new AudioInboxError('storage_unavailable', 'The workspace identity is unavailable for audio storage.');
  return storageKey(`audio-inbox:${encodeURIComponent(workspaceId)}`, basePath);
}
function storedClip(entry: AudioInboxEntry): StoredClip | null {
  const value = entry.value;
  if (!record(value) || value.format !== FORMAT || value.id !== entry.key) return null;
  try { validateClip(value); return value as unknown as StoredClip; } catch { return null; }
}
function inventory(entries: readonly AudioInboxEntry[]): { clips: StoredClip[]; issues: AudioInboxIssue[]; totalBytes: number } {
  if (entries.length > AUDIO_INBOX_LIMITS.maxClips) throw new AudioInboxError('limit', 'The audio inbox exceeds its 100-record inventory limit. Existing data was not changed.');
  const clips: StoredClip[] = [], issues: AudioInboxIssue[] = []; let totalBytes = 0;
  const ids = new Set<string>();
  for (const entry of entries) {
    const clip = storedClip(entry);
    if (!clip || ids.has(clip.id)) { issues.push({ id: typeof entry.key === 'string' && entry.key.length <= 200 ? entry.key : null, message: 'A stored audio record is malformed or unsupported. It was retained unchanged; saving is blocked until this data is recovered or explicitly removed outside the inbox.' }); continue; }
    ids.add(clip.id); clips.push(clip); totalBytes += clip.bytes;
  }
  if (totalBytes > AUDIO_INBOX_LIMITS.maxTotalBytes) issues.push({ id: null, message: 'Stored audio exceeds the 200 MiB inbox limit. Existing clips were retained; export or delete known recordings before saving more.' });
  clips.sort((left, right) => left.createdAt === right.createdAt ? left.id < right.id ? -1 : left.id > right.id ? 1 : 0 : left.createdAt > right.createdAt ? -1 : 1);
  return { clips, issues, totalBytes };
}
function storageError(error: unknown): Error {
  if (error instanceof AudioInboxError || error instanceof SessionChangedError) return error;
  if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError') return new AudioInboxError('quota', 'Browser storage is full or its audio quota was exceeded. The recording was not saved; keep or download the temporary clip.');
  return new AudioInboxError('storage_error', 'The audio storage operation failed. No successful save was confirmed; keep or download the temporary clip.');
}

/** Native transactions serialize aggregate checks with writes across tabs and inbox instances. */
function indexedStore(name: string, factory: IDBFactory | undefined): AudioInboxStore {
  let database: IDBDatabase | null = null, opening: Promise<IDBDatabase> | null = null, closed = false;
  const transactions = new Set<IDBTransaction>();
  const open = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new AudioInboxError('disposed', 'The audio inbox is closed.'));
    if (!factory) return Promise.reject(new AudioInboxError('storage_unavailable', 'IndexedDB is unavailable. Keep or download the temporary recording; it has not been saved.'));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest, settled = false;
      const fail = (error: unknown) => { if (settled) return; settled = true; opening = null; reject(error); };
      try { request = factory.open(name, 1); } catch (error) { fail(storageError(error)); return; }
      request.onupgradeneeded = event => {
        if (closed || settled) { request.transaction?.abort(); return; }
        // Never replace an unfamiliar database/store or erase its data.
        if (event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) { fail(new AudioInboxError('invalid_data', 'The audio database has an unsupported schema. Existing data was not changed.')); request.transaction?.abort(); return; }
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onblocked = () => fail(new AudioInboxError('storage_unavailable', 'Audio storage is blocked by another browser tab. Close that tab and retry; the temporary clip remains available.'));
      request.onerror = () => fail(storageError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (closed || settled) { db.close(); if (!settled) fail(new AudioInboxError('disposed', 'The audio inbox is closed.')); return; }
        if (!db.objectStoreNames.contains(STORE)) { db.close(); fail(new AudioInboxError('invalid_data', 'The audio database has an unsupported schema. Existing data was not changed.')); return; }
        try { const store = db.transaction(STORE, 'readonly').objectStore(STORE); if (store.keyPath !== 'id' || store.autoIncrement) throw new Error('schema'); }
        catch { db.close(); fail(new AudioInboxError('invalid_data', 'The audio database has an unsupported schema. Existing data was not changed.')); return; }
        db.onversionchange = () => { db.close(); if (database === db) database = null; opening = null; };
        database = db; settled = true; resolve(db);
      };
    });
    opening = attempt;
    void attempt.catch(() => { if (opening === attempt) opening = null; });
    return attempt;
  };
  return {
    async transaction<T>(mode: 'readonly' | 'readwrite', signal: AbortSignal, operation: (entries: readonly AudioInboxEntry[]) => AudioInboxMutation<T>): Promise<T> {
      const db = await open();
      if (closed || signal.aborted) throw new SessionChangedError();
      return new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try { transaction = db.transaction(STORE, mode); } catch (error) { reject(storageError(error)); return; }
        transactions.add(transaction);
        let outcome: AudioInboxMutation<T> | null = null, failure: unknown;
        const abort = () => { failure = new SessionChangedError(); try { transaction.abort(); } catch { /* Already complete; completion still checks the signal. */ } };
        const cleanup = () => { transactions.delete(transaction); signal.removeEventListener('abort', abort); };
        signal.addEventListener('abort', abort, { once: true });
        transaction.onabort = () => { cleanup(); reject(failure || storageError(transaction.error)); };
        transaction.onerror = event => { failure ||= storageError((event.target as IDBRequest | null)?.error ?? transaction.error); };
        transaction.oncomplete = () => { cleanup(); if (closed || signal.aborted) reject(new SessionChangedError()); else if (!outcome) reject(new AudioInboxError('storage_error', 'Audio storage completed without a valid result.')); else resolve(outcome.result); };
        const entries: AudioInboxEntry[] = [], store = transaction.objectStore(STORE), cursor = store.openCursor();
        cursor.onsuccess = () => {
          try {
            if (closed || signal.aborted) { abort(); return; }
            const row = cursor.result;
            if (row) { entries.push({ key: row.primaryKey, value: row.value }); if (entries.length > AUDIO_INBOX_LIMITS.maxClips) throw new AudioInboxError('limit', 'The audio inbox exceeds its 100-record inventory limit. Existing data was not changed.'); row.continue(); return; }
            outcome = operation(entries);
            if (mode === 'readonly' && (outcome.put || outcome.deleteKey !== undefined)) throw new Error('Readonly audio operation attempted a write.');
            if (outcome.put) store.add(outcome.put.value);
            if (outcome.deleteKey !== undefined) store.delete(outcome.deleteKey);
          } catch (error) { failure = error; try { transaction.abort(); } catch { /* Completion handler reports a retired operation. */ } }
        };
      });
    },
    close() { closed = true; for (const transaction of transactions) { try { transaction.abort(); } catch { /* Already completed. */ } } transactions.clear(); database?.close(); database = null; },
  };
}

interface MemoryLifetime { records: Map<string, Map<string, StoredClip>> }
const lifetimes = new WeakMap<WorkspaceSession, MemoryLifetime>();
/** Used by the session departure warning; does not read durable storage or expose clip metadata. */
export function sessionAudioClipCount(session: WorkspaceSession | null): number {
  if (!sessionIsActive(session) || session.state.mode !== 'password') return 0;
  let count = 0; for (const records of lifetimes.get(session)?.records.values() ?? []) count += records.size;
  return count;
}
function lifetime(session: WorkspaceSession): MemoryLifetime {
  const existing = lifetimes.get(session); if (existing) return existing;
  const value: MemoryLifetime = { records: new Map() }; lifetimes.set(session, value);
  session.cleanupCallbacks.add(() => { for (const records of value.records.values()) records.clear(); value.records.clear(); lifetimes.delete(session); });
  return value;
}
function memoryStore(records: Map<string, StoredClip>): AudioInboxStore {
  let closed = false;
  return {
    async transaction<T>(_mode: 'readonly' | 'readwrite', signal: AbortSignal, operation: (entries: readonly AudioInboxEntry[]) => AudioInboxMutation<T>): Promise<T> {
      if (closed || signal.aborted) throw new SessionChangedError();
      const result = operation([...records].map(([key, value]) => ({ key, value })));
      if (closed || signal.aborted) throw new SessionChangedError();
      if (result.put) records.set(result.put.key, result.put.value as StoredClip);
      if (result.deleteKey !== undefined) records.delete(result.deleteKey);
      return result.result;
    }, close() { closed = true; },
  };
}

/** Explicit saves only. Protected sessions never open IndexedDB or fall back to durable storage. */
export function createAudioInbox(session: WorkspaceSession, options: { basePath?: string; indexedDB?: IDBFactory; store?: AudioInboxStore } = {}): AudioInbox {
  assertSession(session);
  const name = audioInboxDatabaseName(session.state.workspaceId, options.basePath ?? applicationBase());
  const persistence = session.state.mode === 'local' ? 'device' : 'session';
  let store: AudioInboxStore;
  if (persistence === 'device') store = options.store ?? indexedStore(name, options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB));
  else { const scopes = lifetime(session).records; let records = scopes.get(name); if (!records) { records = new Map(); scopes.set(name, records); } store = memoryStore(records); }
  let disposed = false;
  const pending = new Set<AbortController>();
  const dispose = () => { if (disposed) return; disposed = true; for (const controller of pending) controller.abort(); pending.clear(); store.close(); session.cleanupCallbacks.delete(dispose); };
  session.cleanupCallbacks.add(dispose);
  const active = () => { assertSession(session); if (disposed) throw new AudioInboxError('disposed', 'The audio inbox is closed.'); };
  const run = async <T>(mode: 'readonly' | 'readwrite', action: (entries: readonly AudioInboxEntry[]) => AudioInboxMutation<T>): Promise<T> => {
    active(); const controller = new AbortController(); pending.add(controller);
    try { const result = await store.transaction(mode, controller.signal, entries => { active(); if (controller.signal.aborted) throw new SessionChangedError(); return action(entries); }); active(); if (controller.signal.aborted) throw new SessionChangedError(); return result; }
    catch (error) { active(); throw storageError(error); }
    finally { pending.delete(controller); }
  };
  return {
    persistence,
    list: () => run('readonly', entries => { const state = inventory(entries); return { result: { clips: state.clips.map(metadata), issues: state.issues, totalBytes: state.totalBytes, persistence } }; }),
    read: id => run('readonly', entries => {
      if (!validId(id)) invalid('Choose a valid recording identity.');
      const row = entries.find(entry => entry.key === id); if (!row) return { result: null };
      const clip = storedClip(row); if (!clip) throw new AudioInboxError('invalid_data', 'The selected audio record is malformed or unsupported. Existing data was not changed.');
      return { result: { ...metadata(clip), blob: clip.blob } };
    }),
    save: async clip => {
      active(); validateClip(clip);
      const captured: AudioClip = { ...metadata(clip), blob: clip.blob };
      return run('readwrite', entries => {
      const clip = captured;
      validateClip(clip);
      const state = inventory(entries);
      if (state.totalBytes > AUDIO_INBOX_LIMITS.maxTotalBytes) throw new AudioInboxError('limit', 'Stored audio exceeds the 200 MiB inbox limit. Existing clips were retained; export or delete known recordings before saving more.');
      if (state.issues.length) throw new AudioInboxError('invalid_data', 'Audio storage contains malformed or unsupported records. Nothing was overwritten; keep or download this temporary clip.');
      if (entries.some(entry => entry.key === clip.id)) throw new AudioInboxError('conflict', 'A recording with this identity already exists. Nothing was overwritten; reload the inbox to check the saved clip.');
      if (entries.length >= AUDIO_INBOX_LIMITS.maxClips || state.totalBytes + clip.bytes > AUDIO_INBOX_LIMITS.maxTotalBytes) throw new AudioInboxError('limit', 'The audio inbox is limited to 100 recordings and 200 MiB. Export or delete a saved recording, then retry; the temporary clip remains available.');
      const copy: StoredClip = { format: FORMAT, ...metadata(clip), blob: clip.blob };
      return { result: metadata(copy), put: { key: copy.id, value: copy } };
      });
    },
    delete: id => run('readwrite', entries => {
      if (!validId(id)) invalid('Choose a valid recording identity.');
      const row = entries.find(entry => entry.key === id); if (!row) return { result: false };
      if (!storedClip(row)) throw new AudioInboxError('invalid_data', 'The selected record is malformed or unsupported. It was not deleted automatically.');
      return { result: true, deleteKey: id };
    }),
    dispose,
  };
}
