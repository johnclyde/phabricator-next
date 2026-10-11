import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionReviewersFromEnvironment } from './revision-reviewer-config.ts';

test('reviewer self acceptance defaults off and requires a strict operator boolean', () => {
  assert.deepEqual(revisionReviewersFromEnvironment({}), { allowSelfAccept: false });
  assert.deepEqual(revisionReviewersFromEnvironment({ REVISION_ALLOW_SELF_ACCEPT: 'false' }), { allowSelfAccept: false });
  assert.deepEqual(revisionReviewersFromEnvironment({ REVISION_ALLOW_SELF_ACCEPT: 'true' }), { allowSelfAccept: true });
  for (const value of ['', '0', '1', 'TRUE', ' false', 'yes', 'secret-setting']) assert.throws(() => revisionReviewersFromEnvironment({ REVISION_ALLOW_SELF_ACCEPT: value }), { message: 'REVISION_ALLOW_SELF_ACCEPT must be exactly true or false.' });
});
