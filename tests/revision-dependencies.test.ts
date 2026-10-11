import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionDependencyInput, revisionDependencyChanges, validRevisionDependencyReceipt } from '../shared/revision-dependencies.ts';

const input = { direction: 'parents' as const, add: ['P2', 'D1'], remove: ['L3'], expectedRelationshipVersion: 4, expectedAccessEpoch: 9 };
test('revision dependency intent retains exact versions and distinct explicit deltas', () => {
  const value = revisionDependencyInput(input);
  assert.deepEqual(value, { ...input, add: ['D1', 'P2'] });
  assert.deepEqual(input.add, ['P2', 'D1']);
  for (const invalid of [null, [], { ...input, add: [], remove: [] }, { ...input, add: ['P2', 'P2'] }, { ...input, add: ['L3'] }, { ...input, add: ['T1'] }, { ...input, expectedRelationshipVersion: -1 }, { ...input, expectedAccessEpoch: 1.1 }, { ...input, direction: 'set' }, { ...input, replaceAll: true }, { ...input, add: Array.from({ length: 64 }, (_, n) => `P${n + 1}`) }]) assert.throws(() => revisionDependencyInput(invalid));
  assert.deepEqual(revisionDependencyChanges(value), [{ direction: 'parents', action: 'removed', revisionId: 'L3' }, { direction: 'parents', action: 'added', revisionId: 'D1' }, { direction: 'parents', action: 'added', revisionId: 'P2' }]);
});

test('dependency receipts bind source, exact delta, resulting version and current authority', () => {
  const value = revisionDependencyInput(input), receipt = { revisionId: 'P10', relationshipVersion: 5, operationId: 'f4711306-0057-49aa-9ed8-248f87ebdca5', changes: revisionDependencyChanges(value), createdAt: '2026-10-11T00:00:00.000Z', accessEpoch: 9 };
  assert.equal(validRevisionDependencyReceipt(receipt, 'P10', input), true);
  assert.equal(validRevisionDependencyReceipt({ ...receipt, accessEpoch: 12 }, 'P10', input), true, 'replay may be presented under newer current access');
  for (const invalid of [null, { ...receipt, revisionId: 'D10' }, { ...receipt, relationshipVersion: 6 }, { ...receipt, changes: receipt.changes.slice(1) }, { ...receipt, changes: [...receipt.changes].reverse() }, { ...receipt, changes: [null, ...receipt.changes.slice(1)] }, { ...receipt, operationId: '../private' }, { ...receipt, createdAt: 'invalid' }, { ...receipt, accessEpoch: 8 }]) assert.equal(validRevisionDependencyReceipt(invalid, 'P10', input), false);
  assert.equal(validRevisionDependencyReceipt({ ...receipt, relationshipVersion: Number.MAX_SAFE_INTEGER + 1 }, 'P10', { ...input, expectedRelationshipVersion: Number.MAX_SAFE_INTEGER }), false);
});
