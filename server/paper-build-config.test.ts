import test from 'node:test';
import assert from 'node:assert/strict';
import { paperBuildConcurrencyFromEnvironment, validatePaperBuildConcurrency } from './paper-build-config.ts';
import { createApp } from './app.ts';

test('paper compilation defaults to two workers and accepts only exact supported concurrency values', () => {
  assert.equal(paperBuildConcurrencyFromEnvironment({}), 2);
  assert.equal(paperBuildConcurrencyFromEnvironment({ PHABRICATOR_TEX_CONCURRENCY: '1' }), 1);
  assert.equal(paperBuildConcurrencyFromEnvironment({ PHABRICATOR_TEX_CONCURRENCY: '2' }), 2);
  for (const value of ['', '0', '3', '-1', '1.0', '1.5', '01', '+1', ' 1', '2 ', '1\n', '1e0', 'Infinity', 'NaN', 'true']) {
    assert.throws(() => paperBuildConcurrencyFromEnvironment({ PHABRICATOR_TEX_CONCURRENCY: value }), { message: 'PHABRICATOR_TEX_CONCURRENCY must be exactly 1 or 2.' });
  }
});

test('programmatic paper concurrency is validated before application startup', () => {
  assert.equal(validatePaperBuildConcurrency(), 2);
  assert.equal(validatePaperBuildConcurrency(1), 1);
  assert.equal(validatePaperBuildConcurrency(2), 2);
  for (const value of [0, 3, -1, 1.5, NaN, Infinity, null, '1', true]) {
    assert.throws(() => validatePaperBuildConcurrency(value), { message: 'Paper compiler concurrency must be 1 or 2.' });
    assert.throws(() => createApp({ paperBuildConcurrency: value as number, databasePath: ':memory:', seed: false }), { message: 'Paper compiler concurrency must be 1 or 2.' });
  }
});
