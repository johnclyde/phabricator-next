import test from 'node:test';
import assert from 'node:assert/strict';
import { CONPHERENCE_LIVE_LIMITS, waitForConpherenceUpdate } from './conpherence-live.ts';
import { HttpError } from './validation.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('Conpherence update handshake exposes only an authorized epoch and validates cursors', async () => {
  let calls = 0;
  const authorize = () => { calls++; return 42; }, signal = new AbortController().signal;
  assert.deepEqual(await waitForConpherenceUpdate(null, authorize, signal), { accessEpoch: 42, changed: true });
  assert.deepEqual(await waitForConpherenceUpdate('41', authorize, signal), { accessEpoch: 42, changed: true });
  assert.deepEqual(await waitForConpherenceUpdate('43', authorize, signal), { accessEpoch: 42, changed: true });
  for (const cursor of ['', '-1', '+1', '1.1', '1e3', '00', ' 1', '9007199254740992']) await assert.rejects(waitForConpherenceUpdate(cursor, authorize, signal), error => error instanceof HttpError && error.status === 400);
  assert.equal(calls, 3, 'invalid cursors never reach storage');
});
test('Conpherence waits for a new epoch and reauthorizes before returning the wake-up hint', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let epoch = 5, calls = 0;
  const result = waitForConpherenceUpdate('5', () => { calls++; return epoch; }, new AbortController().signal);
  context.mock.timers.tick(1_000); await settle(); assert.equal(calls, 2);
  epoch = 6;
  context.mock.timers.tick(1_000);
  assert.deepEqual(await result, { accessEpoch: 6, changed: true }); assert.equal(calls, 3);
});
test('Conpherence long polls reject revoked credentials and abort immediately on disconnect', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let valid = true;
  const result = waitForConpherenceUpdate('7', () => { if (!valid) throw new HttpError(401, 'Session ended.'); return 7; }, new AbortController().signal);
  const rejected = assert.rejects(result, error => error instanceof HttpError && error.status === 401);
  valid = false; context.mock.timers.tick(1_000); await rejected;
  const controller = new AbortController();
  const aborted = assert.rejects(waitForConpherenceUpdate('7', () => 7, controller.signal), { name: 'AbortError' });
  controller.abort(); await aborted;
  await assert.rejects(waitForConpherenceUpdate('7', () => { throw new Error('Must not authorize an aborted connection'); }, controller.signal), { name: 'AbortError' });
});
test('Conpherence idle long polls expire after twenty seconds with a fresh authorization check', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const result = waitForConpherenceUpdate('8', () => { calls++; return 8; }, new AbortController().signal);
  for (let elapsed = 0; elapsed < CONPHERENCE_LIVE_LIMITS.waitMs; elapsed += 1_000) { context.mock.timers.tick(1_000); await settle(); }
  assert.deepEqual(await result, { accessEpoch: 8, changed: false }); assert.equal(calls, 21);
});
test('Conpherence bounds pending connections and releases capacity when they are cancelled', async () => {
  const controllers = Array.from({ length: CONPHERENCE_LIVE_LIMITS.pending }, () => new AbortController());
  const polls = controllers.map(controller => waitForConpherenceUpdate('9', () => 9, controller.signal).catch(error => { assert.equal(error.name, 'AbortError'); }));
  try {
    await assert.rejects(waitForConpherenceUpdate('9', () => 9, new AbortController().signal), error => error instanceof HttpError && error.status === 429);
  } finally { controllers.forEach(controller => controller.abort()); await Promise.all(polls); }
  const controller = new AbortController(), next = assert.rejects(waitForConpherenceUpdate('9', () => 9, controller.signal), { name: 'AbortError' });
  controller.abort(); await next;
});
