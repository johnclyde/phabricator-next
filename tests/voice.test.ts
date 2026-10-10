import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';

test('voice can navigate directly to an immutable-review object or wiki document', () => {
  for (const [command, id] of [['Open W 12.', 'W12'], ['show p2', 'P2'], ['go to L3', 'L3'], ['open code revision 4', 'D4'], ['open wiki page 5', 'W5'], ['show the paper 6', 'P6'], ['open draft 7', 'L7']]) {
    assert.deepEqual(parseCommand(command), { type: 'openObject', id });
  }
  for (const command of ['open W0', 'open W-1', 'open W1 and delete it', 'open W9007199254740992', 'restore wiki 1', 'publish W1']) {
    assert.equal(parseCommand(command).type, 'unknown');
  }
});
