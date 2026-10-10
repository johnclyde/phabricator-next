import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasePath, mountPath } from '../shared/mount.ts';

test('mount configuration normalizes a directory without accepting ambiguous paths', () => {
  assert.equal(normalizeBasePath(), '/');
  assert.equal(normalizeBasePath('/work'), '/work/');
  assert.equal(normalizeBasePath('/work/team_2/'), '/work/team_2/');
  for (const value of ['', 'work', '//work', '/work//team', '/.', '/../team', '/work/..', '/work%2fteam', '/work?x=1', '/work#x', '/work\\team', '/work space', `/${'x'.repeat(501)}`]) {
    assert.throws(() => normalizeBasePath(value), /APP_BASE_PATH/);
  }
});

test('mounting keeps application routes, query strings and object fragments under the prefix', () => {
  assert.equal(mountPath('/api/health'), '/api/health');
  assert.equal(mountPath('/api/revisions/P1/export?version=2', '/work'), '/work/api/revisions/P1/export?version=2');
  assert.equal(mountPath('/#P1', '/work/'), '/work/#P1');
  assert.equal(mountPath('/', '/work/'), '/work/');
  for (const value of ['api/state', '//elsewhere.test/path', '/\\elsewhere.test']) {
    assert.throws(() => mountPath(value, '/work/'), /single slash/);
  }
});
