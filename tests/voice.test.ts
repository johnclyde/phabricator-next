import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';

test('voice can navigate directly to an immutable-review object or wiki document', () => {
  for (const [command, id] of [['Open W 12.', 'W12'], ['show p2', 'P2'], ['go to L3', 'L3'], ['open code revision 4', 'D4'], ['open wiki page 5', 'W5'], ['show the paper 6', 'P6'], ['open draft 7', 'L7'], ['open R 12', 'R12'], ['show repository 3', 'R3']]) {
    assert.deepEqual(parseCommand(command), { type: 'openObject', id });
  }
  for (const command of ['open W0', 'open W-1', 'open W1 and delete it', 'open W9007199254740992', 'restore wiki 1', 'publish W1', 'open R0', 'open R1 and fetch it', 'clone repository 1', 'fetch repository 1']) {
    assert.equal(parseCommand(command).type, 'unknown');
  }
});

test('comparison commands are explicit navigation and reading actions', () => {
  for (const command of ['read changes', 'Read the changes.']) assert.deepEqual(parseCommand(command), { type: 'changes' });
  for (const command of ['read change', 'read current change', 'Read the current change!', 'read this change']) assert.deepEqual(parseCommand(command), { type: 'currentChange' });
  for (const command of ['next change', 'read next change', 'go to the next change']) assert.deepEqual(parseCommand(command), { type: 'nextChange' });
  for (const command of ['previous change', 'read the previous change', 'show prior change']) assert.deepEqual(parseCommand(command), { type: 'previousChange' });
  for (const command of ['next file', 'read next file', 'go to the next file', 'open next file']) assert.deepEqual(parseCommand(command), { type: 'nextFile' });
  for (const command of ['previous file', 'Read the previous file.', 'show prior file']) assert.deepEqual(parseCommand(command), { type: 'previousFile' });
  for (const command of ['next change and accept it', 'delete current change', 'read all files', 'apply next change', 'next file and publish it', 'delete previous file', 'apply next file']) assert.equal(parseCommand(command).type, 'unknown');
});

test('Paste navigation keeps PA distinct from manuscript P and never writes by voice', () => {
  for (const command of ['open pastes', 'go to paste', 'show the pastes']) assert.deepEqual(parseCommand(command), { type: 'navigate', view: 'pastes' });
  for (const command of ['open PA 12', 'show pa12', 'go to paste 12']) assert.deepEqual(parseCommand(command), { type: 'openObject', id: 'PA12' });
  assert.deepEqual(parseCommand('open P12'), { type: 'openObject', id: 'P12' });
  for (const command of ['open PA0', 'open PA9007199254740992', 'create paste execute this', 'archive PA12', 'paste secret text', 'open PA12 and publish']) assert.equal(parseCommand(command).type, 'unknown');
});
