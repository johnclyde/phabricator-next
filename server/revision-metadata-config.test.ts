import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionMetadataFromEnvironment } from './revision-metadata-config.ts';

test('revision test plans default to required and operator configuration uses strict booleans', () => {
  assert.deepEqual(revisionMetadataFromEnvironment({}), { requireTestPlan: true });
  assert.deepEqual(revisionMetadataFromEnvironment({ REVISION_REQUIRE_TEST_PLAN: 'true' }), { requireTestPlan: true });
  assert.deepEqual(revisionMetadataFromEnvironment({ REVISION_REQUIRE_TEST_PLAN: 'false' }), { requireTestPlan: false });
  for (const value of ['', '0', '1', 'TRUE', ' true', 'yes', 'secret-setting']) assert.throws(() => revisionMetadataFromEnvironment({ REVISION_REQUIRE_TEST_PLAN: value }), { message: 'REVISION_REQUIRE_TEST_PLAN must be exactly true or false.' });
});
