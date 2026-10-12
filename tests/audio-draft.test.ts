import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioClip } from '../client/audio-inbox';
import { discardTemporaryAudio, hasTemporaryAudio, retainTemporaryAudio, temporaryAudio } from '../client/audio-draft';
import { activateSession, lockSession, SessionChangedError } from '../client/session';
import type { SessionState } from '../shared/auth';

const identity = (name: string): SessionState => ({ mode: 'password', workspaceId: 'audio-drafts', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
const draft = () => ({ clip: createAudioClip(new Blob(['test encoded bytes'], { type: 'audio/webm' }), { title: 'Unsaved recording', durationMs: 1000 }), notice: '' });

test('temporary audio survives readers reopening but cannot cross session replacement or accept a late callback', () => {
  try {
    const alice = activateSession(identity('alice')), first = draft();
    retainTemporaryAudio(alice, first);
    assert.equal(hasTemporaryAudio(alice), true);
    assert.equal(temporaryAudio(alice)?.clip.blob, first.clip.blob);
    const bob = activateSession(identity('bob'));
    assert.equal(hasTemporaryAudio(alice), false);
    assert.equal(hasTemporaryAudio(bob), false);
    assert.throws(() => retainTemporaryAudio(alice, first), SessionChangedError);
    const second = draft(); retainTemporaryAudio(bob, second);
    assert.throws(() => discardTemporaryAudio(alice), SessionChangedError);
    assert.equal(temporaryAudio(bob), second);
    discardTemporaryAudio(bob); assert.equal(hasTemporaryAudio(bob), false);
  } finally { lockSession(); }
});

test('page hiding clears temporary local audio without durable persistence and unregisters on session retirement', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
  try {
    const session = activateSession({ mode: 'local', workspaceId: 'local-audio', account: null, sessionContext: null, csrfToken: null, expiresAt: null });
    retainTemporaryAudio(session, draft());
    windowEvents.dispatchEvent(new Event('pagehide'));
    assert.equal(hasTemporaryAudio(session), false);
    retainTemporaryAudio(session, draft());
    assert.equal(hasTemporaryAudio(session), true);
    lockSession();
    assert.equal(hasTemporaryAudio(session), false);
    windowEvents.dispatchEvent(new Event('pagehide'));
  } finally { lockSession(); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});
