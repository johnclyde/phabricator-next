import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidProjectSlug, normalizeProjectSlug, projectColor, PROJECT_COLOR_HEX } from '../shared/projects';

test('project aliases retain upstream Unicode and punctuation normalization', () => {
  for (const [input, expected] of [
    ['  Research / Paper #One  ', 'research_paper_one'],
    ['API-v2', 'api-v2'], ['Étude 研究', 'étude_研究'], ['ＡＢ', 'ａｂ'],
    ['__name___', 'name'], ['___', '_'], ['.', 'dot'], ['..', 'dotdot'], ['...', '...'],
    ['alpha\\beta\t\ngamma', 'alpha_beta_gamma'], ['a!@#$%^&*()+=?<>[]{}\'"`~,:;|b', 'a_b'],
    ['a\u0019b', 'a_b'], ['a\u001ab', 'a\u001ab'],
  ]) assert.equal(normalizeProjectSlug(input!), expected, JSON.stringify(input));
  assert.equal(isValidProjectSlug(''), false);
  assert.equal(isValidProjectSlug(' /# '), false);
  assert.equal(isValidProjectSlug('研究'.repeat(64)), true);
  assert.equal(isValidProjectSlug('研究'.repeat(64) + 'x'), false);
  assert.equal(isValidProjectSlug('🧪'.repeat(128)), true, 'slug limits count Unicode code points');
  assert.equal(isValidProjectSlug('🧪'.repeat(129)), false);
  assert.equal(isValidProjectSlug('name\ud800'), false);
  assert.equal(isValidProjectSlug('\udfffname'), false);
  assert.equal(isValidProjectSlug('valid\ud83e\uddea'), true);
});

test('project colors preserve legacy custom colors and mute archived projects', () => {
  assert.equal(projectColor({ color: '#123456' }), '#123456');
  assert.equal(projectColor({ color: '#123456', colorKey: 'blue' }), PROJECT_COLOR_HEX.blue);
  assert.equal(projectColor({ color: '#123456', colorKey: 'blue', status: 'archived' }), PROJECT_COLOR_HEX.grey);
});
