import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFile } from '../shared/comparison.ts';
import { comparisonNarration, COMPARISON_SPEECH_LIMIT, type ComparisonVoiceSnapshot } from '../client/comparison-voice.ts';

function snapshot(before: string | null, after: string | null, path = 'motion.md'): ComparisonVoiceSnapshot {
  return {
    revisionId: 'L3', base: { id: 'old', number: 1, contentHash: 'hash-old' }, target: { id: 'new', number: 3, contentHash: 'hash-new' },
    filePath: path, result: compareFile(before === null ? null : { path, content: before }, after === null ? null : { path, content: after }), passageIndex: 0,
  };
}

test('narration names the exact selected pair and file and reads only its literal changes', () => {
  const selected = snapshot('The term is short.', 'The term is seven days.');
  const spoken = comparisonNarration(selected);
  assert.match(spoken, /^L3, version 1 to version 3, file motion\.md\./);
  assert.match(spoken, /Removed text: short/); assert.match(spoken, /Added text: seven days/);
  assert.doesNotMatch(spoken, /current version|latest|AI/);
  const reversed = { ...snapshot('The term is seven days.', 'The term is short.'), base: selected.target, target: selected.base! };
  assert.match(comparisonNarration(reversed), /version 3 to version 1/);
  assert.match(comparisonNarration(reversed), /Removed text: seven days/);
});

test('deleted and empty files are narrated distinctly from unchanged text', () => {
  assert.match(comparisonNarration(snapshot('Removed argument.', null)), /File deleted\..*Removed text: Removed argument/s);
  assert.match(comparisonNarration(snapshot('', null)), /Empty file deleted/);
  assert.match(comparisonNarration({ ...snapshot(null, ''), base: null }), /empty base to version 3.*Empty file added/s);
  assert.match(comparisonNarration(snapshot('', '')), /No text changes in this file/);
  assert.match(comparisonNarration(snapshot('same', 'same')), /No text changes in this file/);
});

test('whitespace changes are audible without losing their order or pretending they are empty', () => {
  const spoken = comparisonNarration(snapshot('a \t\nb', 'a\t \r\nb'));
  assert.match(spoken, /space|tab|carriage return|line feed/);
  assert.doesNotMatch(spoken, /No text changes/);
  const spaces = comparisonNarration(snapshot('a b', 'a  b'));
  assert.match(spaces, /Removed text: \[space\]/); assert.match(spaces, /Added text: \[2 spaces\]/);
  assert.match(comparisonNarration(snapshot('a b', 'a\u00a0b')), /non-breaking space/);
});

test('current passage uses the shared cursor while all passages explicitly reports omissions', () => {
  const selected = snapshot('a one b two c three d four e', 'a ONE b TWO c THREE d FOUR e');
  assert.equal(selected.result.status, 'ready');
  if (selected.result.status !== 'ready') return;
  assert.equal(selected.result.passages.length, 4);
  assert.match(comparisonNarration(selected), /4 changed passages\. Reading the first 3/);
  assert.doesNotMatch(comparisonNarration(selected), /FOUR/);
  assert.match(comparisonNarration({ ...selected, passageIndex: 3 }, 'current'), /Change 4 of 4\..*Added text: FOUR/s);
  assert.doesNotMatch(comparisonNarration({ ...selected, passageIndex: 3 }, 'current'), /Added text: ONE/);
  assert.match(comparisonNarration({ ...selected, passageIndex: 4 }, 'current'), /Select a changed passage first/);
});

test('bounded comparison failures never produce an empty-change claim or expose source excerpts', () => {
  const selected = snapshot('confidential old'.repeat(20_000), 'confidential new');
  assert.equal(selected.result.status, 'too_large');
  const spoken = comparisonNarration(selected);
  assert.match(spoken, /exceeds the comparison limit/);
  assert.doesNotMatch(spoken, /No text changes|confidential/);
  assert.match(comparisonNarration({ ...selected, filePath: 'other.md' }), /comparison is unavailable/);
});

test('long Unicode excerpts and metadata have explicit speech bounds and truncation notices', () => {
  const selected = snapshot('🧑🏽‍🔬'.repeat(150), '🦉'.repeat(150), `${'長'.repeat(200)}.md`);
  assert.equal(selected.result.status, 'ready');
  const spoken = comparisonNarration(selected);
  assert.match(spoken, /filename shortened/); assert.match(spoken, /Excerpt shortened/);
  assert.ok(Array.from(spoken).length <= COMPARISON_SPEECH_LIMIT);
  assert.doesNotMatch(spoken, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  const expanded = comparisonNarration(snapshot('\u2003\n'.repeat(100), '\u00a0\r'.repeat(100)));
  assert.ok(Array.from(expanded).length <= COMPARISON_SPEECH_LIMIT);
  assert.match(expanded, /speech length limit/);
});

test('filtered narration uses original passage identities and reports skipped space/tab-only changes', () => {
  const selected = { ...snapshot('First  sentence. Stable separator. Last old claim.', 'First sentence. Stable separator. Last new claim.'), skipSpaceTabOnly: true, passageIndex: 1 };
  assert.equal(selected.result.status, 'ready');
  if (selected.result.status !== 'ready') return;
  assert.equal(selected.result.passages.length, 2);
  const original = structuredClone(selected.result);
  const current = comparisonNarration(selected, 'current');
  assert.match(current, /Space and tab-only changes are skipped for navigation/);
  assert.match(current, /Navigating 1 of 2 changed passages\. 1 space\/tab-only passage skipped/);
  assert.match(current, /Change 1 of 1 under this filter/);
  assert.match(current, /Removed text: old.*Added text: new/s);
  assert.doesNotMatch(current, /Removed text: \[2 spaces\]/);
  assert.match(comparisonNarration({ ...selected, passageIndex: 0 }, 'current'), /Select a changed passage first/);
  assert.match(comparisonNarration({ ...selected, skipSpaceTabOnly: false }, 'current'), /Change 2 of 2/);
  assert.deepEqual(selected.result, original, 'narration must not rewrite literal evidence');
});

test('all-filtered changes, true equality, and added/deleted whitespace files stay distinct', () => {
  const filtered = comparisonNarration({ ...snapshot('a  b', 'a\tb'), skipSpaceTabOnly: true });
  assert.match(filtered, /Navigating 0 of 1 changed passage/);
  assert.match(filtered, /No changed passages remain under this filter/);
  assert.doesNotMatch(filtered, /No text changes in this file/);
  assert.match(comparisonNarration({ ...snapshot('same', 'same'), skipSpaceTabOnly: true }), /No text changes in this file/);
  assert.match(comparisonNarration({ ...snapshot(null, '  \t'), skipSpaceTabOnly: true }), /File added\..*Added text:/s);
  assert.match(comparisonNarration({ ...snapshot(' \t', null), skipSpaceTabOnly: true }), /File deleted\..*Removed text:/s);
  assert.match(comparisonNarration({ ...snapshot('', null), skipSpaceTabOnly: true }), /Empty file deleted/);
});

test('filtered narration retains line-ending and non-ASCII whitespace changes and respects speech limits', () => {
  for (const [before, after, expected] of [['a b', 'a\u00a0b', /non-breaking space/], ['a\nb', 'a\r\nb', /carriage return/]] as const) {
    const spoken = comparisonNarration({ ...snapshot(before, after), skipSpaceTabOnly: true });
    assert.match(spoken, expected); assert.doesNotMatch(spoken, /No changed passages remain under this filter/);
  }
  const spoken = comparisonNarration({ ...snapshot('\u2003\n'.repeat(100), '\u00a0\r'.repeat(100)), skipSpaceTabOnly: true });
  assert.ok(Array.from(spoken).length <= COMPARISON_SPEECH_LIMIT);
  assert.match(spoken, /speech length limit/);
  const huge = comparisonNarration({ ...snapshot('x'.repeat(210000), 'small'), skipSpaceTabOnly: true });
  assert.match(huge, /exceeds the comparison limit/);
  assert.doesNotMatch(huge, /0 of|No changed passages remain/);
});
