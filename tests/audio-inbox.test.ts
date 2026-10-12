import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_INBOX_LIMITS, AudioInboxError, audioInboxDatabaseName, createAudioClip, createAudioInbox, sessionAudioClipCount, type AudioClip, type AudioInboxEntry, type AudioInboxMutation, type AudioInboxStore } from '../client/audio-inbox.ts';
import { activateSession, lockSession, SessionChangedError, type WorkspaceSession } from '../client/session.ts';

const session = (mode: 'local' | 'password' = 'local', workspaceId = 'audio-test', account = 'alice'): WorkspaceSession => activateSession({ mode, workspaceId, account: mode === 'local' ? null : { id: account, username: account, displayName: account, disabled: false }, sessionContext: mode === 'local' ? null : `context-${account}`, csrfToken: mode === 'local' ? null : `csrf-${account}`, expiresAt: null });
const clip = (id = 'clip-a', bytes = 8, patch: Partial<AudioClip> = {}): AudioClip => ({ id, title: 'Research note', createdAt: '2026-10-12T12:00:00.000Z', mimeType: 'audio/webm;codecs=opus', durationMs: 500, bytes, blob: new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' }), ...patch });
const saved = (value: AudioClip) => ({ format: 'phabricator.audio.v1', ...value });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** Simulates the atomic storage contract, including independent handles sharing a transaction queue. Native IDB is covered by the browser suite. */
class AtomicDatabase {
  rows = new Map<IDBValidKey, unknown>();
  private queue = Promise.resolve();
  failCommit: Error | null = null;
  beforeOperation: (() => Promise<void>) | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  afterCommit: (() => Promise<void>) | null = null;
  store(): AudioInboxStore {
    let closed = false;
    return {
      transaction: <T>(_mode: 'readonly' | 'readwrite', signal: AbortSignal, operation: (entries: readonly AudioInboxEntry[]) => AudioInboxMutation<T>) => {
        const work = this.queue.then(async () => {
          const check = () => { if (closed || signal.aborted) throw new SessionChangedError(); };
          check(); await this.beforeOperation?.(); check();
          const change = operation([...this.rows].map(([key, value]) => ({ key, value: structuredClone(value) })));
          await this.beforeCommit?.(); check();
          if (this.failCommit) throw this.failCommit;
          if (change.put) this.rows.set(change.put.key, structuredClone(change.put.value));
          if (change.deleteKey !== undefined) this.rows.delete(change.deleteKey);
          await this.afterCommit?.();
          return change.result;
        });
        this.queue = work.then(() => {}, () => {});
        return work;
      }, close() { closed = true; },
    };
  }
}

test('temporary clip creation is storage-free and validates actual Blob metadata and exact limits', () => {
  const temporary = createAudioClip(new Blob(['audio'], { type: 'audio/ogg;codecs=opus' }), { title: 'Argument café 😀', durationMs: 200 });
  assert.match(temporary.id, /^[a-f0-9-]{36}$/); assert.equal(temporary.bytes, 5); assert.equal(temporary.mimeType, temporary.blob.type);
  assert.equal(temporary.title, 'Argument café 😀');
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, AUDIO_INBOX_LIMITS.maxDurationMs + 1]) assert.throws(() => createAudioClip(temporary.blob, { title: 'Audio', durationMs }), AudioInboxError);
  assert.throws(() => createAudioClip(new Blob(['not audio'], { type: 'text/plain' }), { title: 'Note', durationMs: 10 }), /audio MIME/);
  assert.throws(() => createAudioClip(new Blob([], { type: 'audio/webm' }), { title: 'Note', durationMs: 10 }), /nonempty/);
  assert.throws(() => createAudioClip(temporary.blob, { title: 'x'.repeat(201), durationMs: 10 }), /title/);
  assert.throws(() => createAudioClip(temporary.blob, { title: ' ', durationMs: 10 }), /title/);
  const largest = new Blob([new Uint8Array(AUDIO_INBOX_LIMITS.maxClipBytes)], { type: 'audio/webm' });
  assert.equal(createAudioClip(largest, { title: 'Full clip', durationMs: AUDIO_INBOX_LIMITS.maxDurationMs }).bytes, AUDIO_INBOX_LIMITS.maxClipBytes);
  assert.throws(() => createAudioClip(new Blob([largest, 'x'], { type: 'audio/webm' }), { title: 'Too much', durationMs: 10 }), /25 MiB/);
});

test('mount and workspace namespace are explicit, normalized, and collision-resistant', () => {
  assert.equal(audioInboxDatabaseName('workspace', '/'), 'phabricator-next:audio-inbox:workspace');
  assert.equal(audioInboxDatabaseName('workspace', '/phabricator/'), 'phabricator-next:mount:%2Fphabricator%2F:audio-inbox:workspace');
  assert.notEqual(audioInboxDatabaseName('one', '/'), audioInboxDatabaseName('two', '/'));
  assert.notEqual(audioInboxDatabaseName('one', '/'), audioInboxDatabaseName('one', '/phabricator'));
  assert.notEqual(audioInboxDatabaseName('a:b', '/'), audioInboxDatabaseName('a%3Ab', '/'));
});

test('explicit save/list/read/delete preserves Blob bytes and deterministic metadata order without aliases', async () => {
  const db = new AtomicDatabase(), context = session(), inbox = createAudioInbox(context, { store: db.store(), basePath: '/' });
  try {
    assert.deepEqual(await inbox.list(), { clips: [], issues: [], totalBytes: 0, persistence: 'device' });
    const source = clip('z', 11), original = structuredClone(source); await inbox.save(source); await inbox.save(clip('b')); await inbox.save(clip('a')); await inbox.save(clip('newest', 1, { createdAt: '2026-10-13T12:00:00.000Z' }));
    const listed = await inbox.list(); assert.deepEqual(listed.clips.map(value => value.id), ['newest', 'a', 'b', 'z']); assert.equal(listed.totalBytes, 28);
    listed.clips[0]!.title = 'Changed result'; assert.equal((await inbox.read('newest'))!.title, 'Research note');
    const reread = await inbox.read('z'); assert.ok(reread); assert.deepEqual(await reread.blob.arrayBuffer(), await original.blob.arrayBuffer()); assert.equal(reread.bytes, 11);
    assert.equal('blob' in listed.clips[0]!, false); assert.deepEqual(source, original);
    assert.equal(await inbox.delete('z'), true); assert.equal(await inbox.read('z'), null); assert.equal(await inbox.delete('z'), false);
  } finally { inbox.dispose(); lockSession(); }
});

test('protected clips never open IndexedDB and survive route disposal only within the same session and mount', async () => {
  const context = session('password'); let opened = 0;
  const forbidden = { open: () => { opened++; throw new Error('Protected audio touched IDB'); } } as unknown as IDBFactory;
  const inbox = createAudioInbox(context, { indexedDB: forbidden, basePath: '/alpha' });
  try {
    assert.equal(inbox.persistence, 'session'); await inbox.save(clip()); assert.equal(sessionAudioClipCount(context), 1); inbox.dispose();
    const reopened = createAudioInbox(context, { indexedDB: forbidden, basePath: '/alpha' }), otherMount = createAudioInbox(context, { indexedDB: forbidden, basePath: '/beta' });
    assert.equal((await reopened.list()).clips.length, 1); assert.equal((await otherMount.list()).clips.length, 0);
    const other = session('password', 'audio-test', 'bob');
    assert.equal(sessionAudioClipCount(context), 0); assert.equal(sessionAudioClipCount(other), 0);
    await assert.rejects(reopened.read('clip-a'), SessionChangedError); await assert.rejects(reopened.save(clip('old')), SessionChangedError);
    const replacement = createAudioInbox(other, { indexedDB: forbidden, basePath: '/alpha' }); assert.equal((await replacement.list()).clips.length, 0);
    reopened.dispose(); otherMount.dispose(); replacement.dispose(); assert.equal(opened, 0);
  } finally { inbox.dispose(); lockSession(); }
});

test('simultaneous saves share atomic count limits across independent inbox handles', async () => {
  const db = new AtomicDatabase(), context = session();
  for (let index = 0; index < 99; index++) db.rows.set(`prior-${index}`, saved(clip(`prior-${index}`, 1)));
  const one = createAudioInbox(context, { store: db.store() }), two = createAudioInbox(context, { store: db.store() });
  try {
    const results = await Promise.allSettled([one.save(clip('one')), two.save(clip('two'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(db.rows.size, 100);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult; assert.equal(failed.reason.code, 'limit');
  } finally { one.dispose(); two.dispose(); lockSession(); }
});

test('aggregate bytes and duplicate IDs are enforced atomically without replacing existing audio', async () => {
  const db = new AtomicDatabase(), context = session(), large = clip('original', AUDIO_INBOX_LIMITS.maxClipBytes);
  for (let index = 0; index < 7; index++) db.rows.set(`prior-${index}`, saved({ ...large, id: `prior-${index}` }));
  const one = createAudioInbox(context, { store: db.store() }), two = createAudioInbox(context, { store: db.store() });
  try {
    const results = await Promise.allSettled([one.save({ ...large, id: 'one' }), two.save({ ...large, id: 'two' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal((await one.list()).totalBytes, AUDIO_INBOX_LIMITS.maxTotalBytes);
    const id = (await one.list()).clips[0]!.id; const before = db.rows.get(id);
    await assert.rejects(one.save({ ...large, id, title: 'Overwrite' }), error => error instanceof AudioInboxError && error.code === 'conflict');
    assert.equal(db.rows.get(id), before);
  } finally { one.dispose(); two.dispose(); lockSession(); }
});

test('quota or failed commit never claims a saved clip and preserves the input for download/retry', async () => {
  const db = new AtomicDatabase(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), temporary = clip();
  try {
    db.failCommit = new DOMException('Full', 'QuotaExceededError');
    await assert.rejects(inbox.save(temporary), error => error instanceof AudioInboxError && error.code === 'quota' && /not saved/.test(error.message));
    assert.equal(db.rows.size, 0); assert.equal((await temporary.blob.arrayBuffer()).byteLength, temporary.bytes);
    db.failCommit = new Error('Commit failed'); await assert.rejects(inbox.save(temporary), error => error instanceof AudioInboxError && error.code === 'storage_error'); assert.equal(db.rows.size, 0);
    db.failCommit = null; assert.equal((await inbox.save(temporary)).id, temporary.id); assert.equal(db.rows.size, 1);
  } finally { inbox.dispose(); lockSession(); }
});

test('a successful request is not a committed save and a session change aborts pending writes', async () => {
  const db = new AtomicDatabase(), context = session(), gate = deferred(), reached = deferred(), inbox = createAudioInbox(context, { store: db.store() });
  let completed = false;
  db.beforeCommit = async () => { reached.resolve(); await gate.promise; };
  const save = inbox.save(clip()); save.then(() => { completed = true; }, () => {});
  await reached.promise; assert.equal(completed, false); assert.equal(db.rows.size, 0);
  lockSession(); gate.resolve(); await assert.rejects(save, SessionChangedError); assert.equal(db.rows.size, 0); assert.equal(completed, false);
});

test('late reads and completed writes cannot return private data or successful completion after session retirement', async () => {
  const db = new AtomicDatabase(), context = session(), gate = deferred(), reached = deferred(), inbox = createAudioInbox(context, { store: db.store() });
  db.rows.set('clip-a', saved(clip()));
  db.afterCommit = async () => { reached.resolve(); await gate.promise; };
  const reading = inbox.read('clip-a'); await reached.promise; session('password', 'other-workspace', 'bob'); gate.resolve();
  await assert.rejects(reading, SessionChangedError); lockSession();
});

test('save captures explicit title and identity before asynchronous storage, and disposal aborts without clearing session clips', async () => {
  const db = new AtomicDatabase(), context = session(), gate = deferred(), reached = deferred(), inbox = createAudioInbox(context, { store: db.store() }), temporary = clip();
  db.beforeOperation = async () => { reached.resolve(); await gate.promise; };
  const saving = inbox.save(temporary); await reached.promise; temporary.title = 'Later edit'; temporary.id = 'changed'; gate.resolve();
  assert.equal((await saving).id, 'clip-a'); assert.equal((await inbox.read('clip-a'))!.title, 'Research note'); assert.equal(await inbox.read('changed'), null);
  inbox.dispose(); await assert.rejects(inbox.read('clip-a'), error => error instanceof AudioInboxError && error.code === 'disposed'); lockSession();
});

test('malformed or unknown records stay untouched, known clips remain readable, and new saves are blocked', async () => {
  const db = new AtomicDatabase(), context = session(), inbox = createAudioInbox(context, { store: db.store() });
  const unknown = { format: 'future-audio', payload: 'opaque' }, wrongBlob = { ...saved(clip('bad')), bytes: 1 };
  db.rows.set('known', saved(clip('known'))); db.rows.set('unknown', unknown); db.rows.set('bad', wrongBlob);
  try {
    const listing = await inbox.list(); assert.deepEqual(listing.clips.map(value => value.id), ['known']); assert.equal(listing.issues.length, 2);
    assert.ok(await inbox.read('known')); await assert.rejects(inbox.read('bad'), error => error instanceof AudioInboxError && error.code === 'invalid_data');
    await assert.rejects(inbox.save(clip('new')), error => error instanceof AudioInboxError && error.code === 'invalid_data');
    await assert.rejects(inbox.delete('unknown'), error => error instanceof AudioInboxError && error.code === 'invalid_data');
    assert.equal(db.rows.get('unknown'), unknown); assert.equal(db.rows.get('bad'), wrongBlob); assert.equal(db.rows.size, 3);
    assert.equal(await inbox.delete('known'), true); assert.equal(db.rows.size, 2);
  } finally { inbox.dispose(); lockSession(); }
});

test('external over-limit inventories report explicit limits while preserving every unknown record', async () => {
  const db = new AtomicDatabase(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), large = clip('big', AUDIO_INBOX_LIMITS.maxClipBytes);
  try {
    for (let index = 0; index < 9; index++) db.rows.set(`large-${index}`, saved({ ...large, id: `large-${index}` }));
    const listing = await inbox.list(); assert.equal(listing.clips.length, 9); assert.match(listing.issues[0]!.message, /200 MiB/);
    await assert.rejects(inbox.save(clip('extra')), error => error instanceof AudioInboxError && error.code === 'limit'); assert.equal(db.rows.size, 9);
    assert.equal(await inbox.delete('large-0'), true); assert.equal((await inbox.list()).issues.length, 0);
    for (let index = 0; index < 101; index++) db.rows.set(`unknown-${index}`, { future: true });
    await assert.rejects(inbox.list(), error => error instanceof AudioInboxError && error.code === 'limit'); assert.equal(db.rows.size, 109);
  } finally { inbox.dispose(); lockSession(); }
});

test('stored key identity, format, dates, Blob type, and MIME claims are validated without trying to repair records', async () => {
  const malformed = [
    { ...saved(clip()), id: 'different' }, { ...saved(clip()), format: 'v2' }, { ...saved(clip()), createdAt: 'not-a-date' },
    { ...saved(clip()), mimeType: 'audio/mpeg' }, { ...saved(clip()), blob: { size: 8, type: 'audio/webm;codecs=opus' } },
    { ...saved(clip()), durationMs: AUDIO_INBOX_LIMITS.maxDurationMs + 1 }, { ...saved(clip()), title: '' },
  ];
  for (const value of malformed) {
    const db = new AtomicDatabase(), context = session(), inbox = createAudioInbox(context, { store: db.store() }); db.rows.set('clip-a', value);
    try { assert.equal((await inbox.list()).issues.length, 1); await assert.rejects(inbox.read('clip-a'), AudioInboxError); assert.equal(db.rows.get('clip-a'), value); }
    finally { inbox.dispose(); lockSession(); }
  }
});

test('native storage opens lazily and a denied open keeps clips exportable without a durable success', async () => {
  let opens = 0; const context = session(), temporary = clip();
  const inbox = createAudioInbox(context, { indexedDB: { open() { opens++; throw new DOMException('Denied', 'SecurityError'); } } as unknown as IDBFactory });
  try { assert.equal(opens, 0); await assert.rejects(inbox.save(temporary), AudioInboxError); assert.equal(opens, 1); await assert.rejects(inbox.save(temporary), AudioInboxError); assert.equal(opens, 2, 'a failed open can be retried'); assert.equal(await temporary.blob.text(), '\0'.repeat(8)); }
  finally { inbox.dispose(); lockSession(); }
});

test('native pending open after lock closes its connection and never creates stores or starts a transaction', async () => {
  const context = session(); let creates = 0, closes = 0, transactions = 0, aborts = 0;
  const request = { result: { close() { closes++; }, createObjectStore() { creates++; }, transaction() { transactions++; }, objectStoreNames: { contains: () => false, length: 0 } }, transaction: { abort() { aborts++; } }, onupgradeneeded: null, onerror: null, onsuccess: null, onblocked: null } as unknown as IDBOpenDBRequest;
  const inbox = createAudioInbox(context, { indexedDB: { open: () => request } as unknown as IDBFactory });
  const pending = inbox.save(clip()); lockSession();
  request.onupgradeneeded?.call(request, { oldVersion: 0 } as IDBVersionChangeEvent);
  request.onsuccess?.call(request, new Event('success'));
  await assert.rejects(pending, SessionChangedError); assert.equal(creates, 0); assert.equal(transactions, 0); assert.equal(aborts, 1); assert.equal(closes, 1);
});
