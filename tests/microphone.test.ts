import test from 'node:test';
import assert from 'node:assert/strict';
import { claimMicrophone } from '../client/microphone';

test('local recording synchronously retires command recognition and prevents parallel provider capture', () => {
  let stopped = 0;
  const commands = claimMicrophone('commands', () => { stopped++; commands(); });
  const audio = claimMicrophone('audio', () => { throw new Error('An audio lease must not be preempted.'); });
  try {
    assert.equal(stopped, 1);
    assert.throws(() => claimMicrophone('commands', () => {}), /Stop the audio recording/);
    assert.throws(() => claimMicrophone('audio', () => {}), /Stop the audio recording/);
    commands(); // A late recognizer cleanup cannot release the recording lease.
    assert.throws(() => claimMicrophone('commands', () => {}), /Stop the audio recording/);
  } finally { audio(); }
  const next = claimMicrophone('commands', () => {}); next(); next();
});

test('a failed recognizer retirement prevents recording until the previous capture is released', () => {
  const commands = claimMicrophone('commands', () => { throw new Error('Capture did not stop.'); });
  assert.throws(() => claimMicrophone('audio', () => {}), /Capture did not stop/);
  assert.throws(() => claimMicrophone('commands', () => {}), /already active/);
  assert.throws(() => claimMicrophone('audio', () => {}), /Capture did not stop/);
  commands();
  const next = claimMicrophone('audio', () => {}); next();
});
