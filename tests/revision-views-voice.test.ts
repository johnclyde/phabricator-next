import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';

test('saved-view voice commands preserve exact names and distinguish revision kinds', () => {
  assert.deepEqual(parseCommand('Open paper view Literature review'), { type: 'revisionView', view: 'papers', name: 'Literature review' });
  assert.deepEqual(parseCommand('show revision view RV12'), { type: 'revisionView', view: 'reviews', name: 'RV12' });
  assert.deepEqual(parseCommand('Go to the document saved view "Draft 2."'), { type: 'revisionView', view: 'drafts', name: 'Draft 2.' });
  assert.deepEqual(parseCommand('open code revisions view Trials & errors'), { type: 'revisionView', view: 'reviews', name: 'Trials & errors' });
  for (const text of ['save paper view Review', 'delete revision view RV1', 'rename document view A', 'open paper view ' + 'a'.repeat(81), 'open paper view A\nB']) assert.equal(parseCommand(text).type, 'unknown');
});

test('authored navigation remains distinct from following, object navigation and tasks', () => {
  assert.deepEqual(parseCommand('show papers I authored'), { type: 'revisionAuthoredFilter', view: 'papers', authored: true });
  assert.deepEqual(parseCommand('open my documents'), { type: 'revisionAuthoredFilter', view: 'drafts', authored: true });
  assert.deepEqual(parseCommand('show code revisions authored by me'), { type: 'revisionAuthoredFilter', view: 'reviews', authored: true });
  assert.deepEqual(parseCommand('show reviews without an author filter'), { type: 'revisionAuthoredFilter', view: 'reviews', authored: false });
  assert.deepEqual(parseCommand('show papers I follow'), { type: 'revisionFollowingFilter', view: 'papers', following: true });
  assert.deepEqual(parseCommand('show my tasks'), { type: 'taskFilter', value: 'mine' });
  assert.deepEqual(parseCommand('open paper 12'), { type: 'openObject', id: 'P12' });
  assert.deepEqual(parseCommand('show active papers'), { type: 'revisionActive', kind: 'paper' });
});
