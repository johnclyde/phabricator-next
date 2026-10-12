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

test('stack voice commands read and navigate the visible graph without accepting or changing it', () => {
  for (const command of ['Read the stack.', 'show stack', 'open revision stack']) assert.deepEqual(parseCommand(command), { type: 'stack' });
  for (const command of ['next stack revision', 'read the next stack revision', 'go to next stack revision']) assert.deepEqual(parseCommand(command), { type: 'nextStackRevision' });
  for (const command of ['previous stack revision', 'show prior stack revision']) assert.deepEqual(parseCommand(command), { type: 'previousStackRevision' });
  for (const command of ['read stack revision', 'read selected stack revision', 'read the current stack revision']) assert.deepEqual(parseCommand(command), { type: 'currentStackRevision' });
  for (const command of ['close stack', 'accept stack', 'land stack', 'next stack revision and approve it', 'add parent P1', 'remove stack']) assert.equal(parseCommand(command).type, 'unknown');
});
test('revision lifecycle filters navigate without voice mutation commands', () => {
  for (const value of ['changes planned', 'changes requested', 'closed', 'abandoned']) assert.deepEqual(parseCommand(`show ${value}`), { type: 'filter', value: value.replaceAll(' ', '_') });
  for (const value of ['abandon revision', 'reclaim revision', 'close revision', 'request review', 'accept reviewed version']) assert.equal(parseCommand(value).type, 'unknown');
});

test('following commands select the requested revision list without changing subscriptions', () => {
  for (const [noun, view] of [['revisions', 'reviews'], ['reviews', 'reviews'], ['papers', 'papers'], ['drafts', 'drafts'], ['documents', 'drafts']] as const) {
    for (const command of [`Show followed ${noun}.`, `open ${noun} I follow`, `show the followed ${noun}`]) assert.deepEqual(parseCommand(command), { type: 'revisionFollowingFilter', view, following: true });
    assert.deepEqual(parseCommand(`show all ${noun}`), { type: 'revisionFollowingFilter', view, following: false });
  }
  for (const command of ['follow P2', 'unfollow revision D1', 'mute all papers', 'subscribe Alice', 'show followed papers and unsubscribe', 'show all drafts and delete them']) assert.equal(parseCommand(command).type, 'unknown');
  assert.deepEqual(parseCommand('show followed tasks'), { type: 'taskFilter', value: 'following' });
});

test('revision project commands filter visible lists without changing project tags', () => {
  for (const [noun, view] of [['code revisions', 'reviews'], ['revisions', 'reviews'], ['reviews', 'reviews'], ['papers', 'papers'], ['drafts', 'drafts'], ['documents', 'drafts']] as const) {
    for (const command of [`Show ${noun} in project Research.`, `open ${noun} tagged with project Research`]) assert.deepEqual(parseCommand(command), { type: 'revisionProjectFilter', view, project: 'Research' });
    for (const command of [`show ${noun} in all projects`, `open ${noun} without a project filter`]) assert.deepEqual(parseCommand(command), { type: 'revisionProjectFilter', view, project: null });
  }
  assert.deepEqual(parseCommand('open documents tagged with project #filing'), { type: 'revisionProjectFilter', view: 'drafts', project: '#filing' });
  for (const command of ['add Research to P2', 'remove project tags from D1', 'replace all paper tags', 'show papers in project', 'open drafts in all projects and delete them']) assert.equal(parseCommand(command).type, 'unknown');
  assert.deepEqual(parseCommand('show tasks in project Research'), { type: 'taskProjectFilter', project: 'Research' });
});


test('notification commands select a private inbox without marking messages read', () => {
  for (const command of ['notifications', 'Open the notifications.', 'go to notification inbox']) assert.deepEqual(parseCommand(command), { type: 'notificationFilter', filter: 'all' });
  for (const filter of ['all', 'unread', 'read']) {
    for (const command of [`show ${filter} notifications`, `open the ${filter} notification inbox`]) assert.deepEqual(parseCommand(command), { type: 'notificationFilter', filter });
  }
  for (const command of ['mark all notifications read', 'clear notifications', 'delete notifications', 'open notifications and mark them read', 'read all notifications aloud', 'read notifications', 'open Bob notifications']) assert.equal(parseCommand(command).type, 'unknown');
  assert.deepEqual(parseCommand('open outbox'), { type: 'navigate', view: 'outbox' });
});

test('audio navigation never starts recording, retention or transcription', () => {
  for (const command of ['Open audio.', 'show the audio inbox', 'go to recordings']) assert.deepEqual(parseCommand(command), { type: 'navigate', view: 'audio' });
  for (const command of ['record audio', 'start recording', 'upload recordings', 'transcribe audio', 'open audio and start recording']) assert.equal(parseCommand(command).type, 'unknown');
});

test('finding commands navigate selected immutable evidence without requesting review or changing source', () => {
  for (const command of ['read findings', 'Read the review findings.']) assert.deepEqual(parseCommand(command), { type: 'findings' });
  for (const command of ['read finding', 'read current finding', 'read the selected finding', 'read this finding']) assert.deepEqual(parseCommand(command), { type: 'currentFinding' });
  for (const command of ['next finding', 'read the next finding', 'go to next finding']) assert.deepEqual(parseCommand(command), { type: 'nextFinding' });
  for (const command of ['previous finding', 'read the previous finding', 'show prior finding']) assert.deepEqual(parseCommand(command), { type: 'previousFinding' });
  for (const command of ['open original finding source', 'Show the original finding source.']) assert.deepEqual(parseCommand(command), { type: 'findingSource' });
  for (const command of ['run AI review', 'accept finding', 'dismiss finding', 'resolve finding', 'apply finding', 'next finding and accept', 'open original finding source and edit it']) assert.equal(parseCommand(command).type, 'unknown');
  assert.deepEqual(parseCommand('show reviews'), { type: 'navigate', view: 'reviews' });
  assert.deepEqual(parseCommand('next change'), { type: 'nextChange' });
  assert.deepEqual(parseCommand('next thread'), { type: 'nextThread' });
});
