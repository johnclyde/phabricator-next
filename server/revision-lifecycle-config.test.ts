import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionLifecycleFromEnvironment } from './revision-lifecycle-config.ts';

test('lifecycle operator settings default off and require exact boolean strings', () => {
  const defaults = { allowReopen: false, alwaysAllowClose: false, alwaysAllowAbandon: false, closeOnAccept: false };
  assert.deepEqual(revisionLifecycleFromEnvironment({}), defaults);
  const fields = { REVISION_ALLOW_REOPEN: 'allowReopen', REVISION_ALWAYS_ALLOW_CLOSE: 'alwaysAllowClose', REVISION_ALWAYS_ALLOW_ABANDON: 'alwaysAllowAbandon', REVISION_CLOSE_ON_ACCEPT: 'closeOnAccept' } as const;
  for (const [name, field] of Object.entries(fields)) {
    assert.deepEqual(revisionLifecycleFromEnvironment({ [name]: 'true' }), { ...defaults, [field]: true });
    assert.deepEqual(revisionLifecycleFromEnvironment({ [name]: 'false' }), defaults);
    for (const value of ['', '1', '0', 'TRUE', 'False', ' true', 'false ', 'yes', 'undefined']) assert.throws(() => revisionLifecycleFromEnvironment({ [name]: value }), new RegExp(`${name} must be exactly true or false`));
  }
});
