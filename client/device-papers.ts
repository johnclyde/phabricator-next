import { applicationBase, storageKey } from './mount';
import { DEVICE_PAPER_FORMAT, validateDevicePaper, validDevicePaperId, type DevicePaper } from '../shared/device-papers';
import type { SourceFile } from '../shared/types';

export type { DevicePaper } from '../shared/device-papers';
export type DevicePaperStorageErrorCode = 'unavailable' | 'blocked' | 'quota' | 'invalid_data' | 'storage_error' | 'closed';
export class DevicePaperStorageError extends Error {
  constructor(public readonly code: DevicePaperStorageErrorCode, message: string) { super(message); this.name = 'DevicePaperStorageError'; }
}
export class DevicePaperConflictError extends Error {
  constructor(public readonly current: DevicePaper | null) {
    super(current ? 'This paper changed in another tab. Your edits were not saved. Reload the saved paper or keep your edits as a new copy.' : 'This paper was deleted in another tab. Your edits were not saved; keep them as a new copy.');
    this.name = 'DevicePaperConflictError';
  }
}
export interface DevicePaperStore {
  list(): Promise<DevicePaper[]>;
  read(id: string): Promise<DevicePaper | null>;
  save(paper: DevicePaper, expectedRevision: number | null): Promise<DevicePaper>;
  delete(id: string, expectedRevision: number): Promise<void>;
  close(): void;
}
const STORE = 'papers';
const error = (cause: unknown): Error => {
  if (cause instanceof DevicePaperStorageError || cause instanceof DevicePaperConflictError) return cause;
  const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
  if (name === 'QuotaExceededError') return new DevicePaperStorageError('quota', 'This device has insufficient browser storage. The paper was not saved; download a backup or free space and retry.');
  if (name === 'SecurityError' || name === 'InvalidStateError') return new DevicePaperStorageError('unavailable', 'Browser storage is unavailable. The paper was not saved; keep or download your edits.');
  return new DevicePaperStorageError('storage_error', 'Browser storage did not confirm a successful save. Keep or download your edits and retry.');
};
const validRevision = (value: number) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
function requireId(id: string): void { if (!validDevicePaperId(id)) throw new DevicePaperStorageError('invalid_data', 'Choose a valid device paper identity.'); }
function stored(value: unknown, key: IDBValidKey): DevicePaper {
  try {
    if (!value || typeof value !== 'object' || !('format' in value) || value.format !== DEVICE_PAPER_FORMAT) throw new Error('format');
    const paper = validateDevicePaper(value);
    if (paper.id !== key) throw new Error('key');
    return paper;
  } catch { throw new DevicePaperStorageError('invalid_data', 'A saved device paper is malformed or unsupported. Existing data was retained unchanged.'); }
}
export function devicePaperDatabaseName(basePath = applicationBase()): string { return storageKey('device-papers', basePath); }

/** A temporary draft is not saved until an explicit save operation completes. */
export function newDevicePaper(title = 'Untitled paper', files: SourceFile[] = [{ path: 'main.tex', content: '' }]): DevicePaper {
  const now = new Date().toISOString();
  return validateDevicePaper({ id: crypto.randomUUID(), title, files, revision: 0, createdAt: now, updatedAt: now }, true);
}

/** Standalone device storage is deliberately independent of workspace authentication. */
export function createDevicePaperStore(options: { basePath?: string; indexedDB?: IDBFactory } = {}): DevicePaperStore {
  const name = devicePaperDatabaseName(options.basePath), factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  let database: IDBDatabase | null = null, opening: Promise<IDBDatabase> | null = null, closed = false;
  const transactions = new Set<IDBTransaction>();
  const open = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new DevicePaperStorageError('closed', 'The device paper store is closed.'));
    if (!factory) return Promise.reject(new DevicePaperStorageError('unavailable', 'This browser does not support device paper storage. Keep or download your edits.'));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest, settled = false;
      const fail = (cause: unknown) => { if (!settled) { settled = true; reject(error(cause)); } };
      try { request = factory.open(name, 1); } catch (cause) { fail(cause); return; }
      request.onupgradeneeded = event => {
        if (closed || settled) { request.transaction?.abort(); return; }
        if (event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) { fail(new DevicePaperStorageError('invalid_data', 'Device paper storage has an unsupported schema. Existing data was retained.')); request.transaction?.abort(); return; }
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onblocked = () => fail(new DevicePaperStorageError('blocked', 'Another tab is blocking device paper storage. Close it and retry; your edits have not been saved.'));
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (settled || closed) { db.close(); if (!settled) fail(new DevicePaperStorageError('closed', 'The device paper store is closed.')); return; }
        try {
          const store = db.transaction(STORE).objectStore(STORE);
          if (store.keyPath !== 'id' || store.autoIncrement) throw new Error('schema');
        } catch { db.close(); fail(new DevicePaperStorageError('invalid_data', 'Device paper storage has an unsupported schema. Existing data was retained.')); return; }
        db.onversionchange = () => { db.close(); if (database === db) { database = null; opening = null; } };
        db.onclose = () => { if (database === db) { database = null; opening = null; } };
        database = db; settled = true; resolve(db);
      };
    });
    opening = attempt;
    void attempt.catch(() => { if (opening === attempt) opening = null; });
    return attempt;
  };
  const transaction = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void, abort: (cause: unknown) => void) => void): Promise<T> => {
    const db = await open();
    if (closed) throw new DevicePaperStorageError('closed', 'The device paper store is closed.');
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); } catch (cause) { reject(error(cause)); return; }
      transactions.add(tx);
      let value: T, hasResult = false, failure: unknown;
      const abort = (cause: unknown) => { failure = cause; try { tx.abort(); } catch { /* Completion or abort handles the outcome. */ } };
      tx.onerror = event => { failure ??= (event.target as IDBRequest | null)?.error ?? tx.error; };
      tx.onabort = () => { transactions.delete(tx); reject(error(failure ?? tx.error)); };
      tx.oncomplete = () => { transactions.delete(tx); if (failure) reject(error(failure)); else if (!hasResult) reject(error(null)); else resolve(value); };
      try { action(tx.objectStore(STORE), result => { value = result; hasResult = true; }, abort); } catch (cause) { abort(cause); }
    });
  };
  return {
    list: () => transaction<DevicePaper[]>('readonly', (store, done, abort) => {
      const papers: DevicePaper[] = [], request = store.openCursor();
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) { papers.push(stored(cursor.value, cursor.primaryKey)); cursor.continue(); }
          else done(papers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
        } catch (cause) { abort(cause); }
      };
    }),
    async read(id) {
      requireId(id);
      return transaction<DevicePaper | null>('readonly', (store, done, abort) => {
        const request = store.get(id);
        request.onsuccess = () => { try { done(request.result === undefined ? null : stored(request.result, id)); } catch (cause) { abort(cause); } };
      });
    },
    async save(input, expectedRevision) {
      const paper = validateDevicePaper(input, true);
      if (expectedRevision !== null && !validRevision(expectedRevision)) throw new DevicePaperStorageError('invalid_data', 'Saving requires the exact previously saved revision.');
      if ((expectedRevision === null && paper.revision !== 0) || (expectedRevision !== null && paper.revision !== expectedRevision)) throw new DevicePaperStorageError('invalid_data', 'The draft revision does not match its expected saved revision.');
      return transaction<DevicePaper>('readwrite', (store, done, abort) => {
        const request = store.get(paper.id);
        request.onsuccess = () => {
          try {
            const current = request.result === undefined ? null : stored(request.result, paper.id);
            if (expectedRevision === null ? current !== null : current?.revision !== expectedRevision) throw new DevicePaperConflictError(current);
            const now = new Date().toISOString();
            const saved: DevicePaper = { ...paper, createdAt: current?.createdAt ?? paper.createdAt, updatedAt: [now, current?.updatedAt ?? paper.createdAt].sort().at(-1)!, revision: (current?.revision ?? 0) + 1 };
            store.put({ ...saved, format: DEVICE_PAPER_FORMAT }); done(saved);
          } catch (cause) { abort(cause); }
        };
      });
    },
    async delete(id, expectedRevision) {
      requireId(id);
      if (!validRevision(expectedRevision)) throw new DevicePaperStorageError('invalid_data', 'Deleting requires the exact previously saved revision.');
      return transaction<void>('readwrite', (store, done, abort) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try { const current = request.result === undefined ? null : stored(request.result, id); if (current?.revision !== expectedRevision) throw new DevicePaperConflictError(current); store.delete(id); done(); } catch (cause) { abort(cause); }
        };
      });
    },
    close() { closed = true; for (const tx of transactions) { try { tx.abort(); } catch { /* Already completed. */ } } database?.close(); database = null; opening = null; },
  };
}

const stores = new Map<string, DevicePaperStore>();
const deviceStore = () => { const base = applicationBase(); let store = stores.get(base); if (!store) { store = createDevicePaperStore({ basePath: base }); stores.set(base, store); } return store; };
export const listDevicePapers = (): Promise<DevicePaper[]> => deviceStore().list();
export const readDevicePaper = (id: string): Promise<DevicePaper | null> => deviceStore().read(id);
export const saveDevicePaper = (paper: DevicePaper, expectedRevision: number | null): Promise<DevicePaper> => deviceStore().save(paper, expectedRevision);
export const deleteDevicePaper = (id: string, expectedRevision: number): Promise<void> => deviceStore().delete(id, expectedRevision);

/** Invoke from an explicit device-save gesture; denial never prevents a normal IDB save. */
export async function requestPersistentPaperStorage(): Promise<{ persisted: boolean }> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { persisted: false };
  try { return { persisted: Boolean(await navigator.storage.persisted?.() || await navigator.storage.persist?.()) }; } catch { return { persisted: false }; }
}
export async function paperStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
