import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFile } from '../shared/comparison.ts';
import { compareParagraphFile } from '../shared/paragraph-comparison.ts';
import { comparisonNarration, COMPARISON_SPEECH_LIMIT, type ComparisonVoiceSnapshot } from '../client/comparison-voice.ts';

function snapshot(before: string | null, after: string | null, path = 'motion.md'): ComparisonVoiceSnapshot {
  return {
    revisionId: 'L3', base: { id: 'old', number: 1, contentHash: 'hash-old' }, target: { id: 'new', number: 3, contentHash: 'hash-new' },
    filePath: path, result: compareFile(before === null ? null : { path, content: before }, after === null ? null : { path, content: after }), passageIndex: 0,
  };
}
function paragraphSnapshot(before: string | null, after: string | null, path = 'motion.md'): ComparisonVoiceSnapshot {
  return { ...snapshot(before, after, path), paragraphAlignment: true, result: compareParagraphFile(before === null ? null : { path, content: before }, after === null ? null : { path, content: after }) };
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

test('Word narration names exact projected scope and retains package identity limits', () => {
  const word = { scopeLabel: 'Footnotes', basePackageSha256: 'a'.repeat(64), targetPackageSha256: 'b'.repeat(64) };
  const selected = { ...snapshot('[Footnote ID: footnote:2]\nOld claim', '[Footnote ID: footnote:2]\nNew claim', 'footnotes'), word };
  const spoken = comparisonNarration(selected);
  assert.match(spoken, /^L3, version 1 to version 3, Word projected text, Footnotes\./);
  assert.match(spoken, /Removed text: Old.*Added text: New/s);
  assert.match(spoken, /limited tracked-change coverage; it is not fully accepted Word text/);
  assert.doesNotMatch(spoken, /file footnotes|packages match|package identical/);
  const equal = comparisonNarration({ ...snapshot('same', 'same', 'footnotes'), word });
  assert.match(equal, /No projected text changes in this scope\. This does not establish Word package equality/);
  assert.doesNotMatch(equal, /No text changes in this file/);
  assert.equal(comparisonNarration({ ...selected, word: { ...word, targetPackageSha256: 'wrong' } }), 'The selected comparison is unavailable. Choose the versions and file again.');
  assert.equal(comparisonNarration({ ...selected, filePath: 'motion.md' }), 'The selected comparison is unavailable. Choose the versions and file again.');
});

test('Word narration distinguishes absent scopes and bounded failures without projected source leaks', () => {
  const word = { scopeLabel: 'Endnotes', basePackageSha256: 'a'.repeat(64), targetPackageSha256: 'b'.repeat(64) };
  assert.match(comparisonNarration({ ...snapshot(null, '', 'endnotes'), word }), /Empty projected scope added/);
  assert.match(comparisonNarration({ ...snapshot('', null, 'endnotes'), word }), /Empty projected scope removed/);
  assert.match(comparisonNarration({ ...snapshot('Old note', null, 'endnotes'), word }), /Projected scope removed\..*Removed text: Old note/s);
  const tooLarge = comparisonNarration({ ...snapshot('confidential'.repeat(20_000), 'new', 'endnotes'), word });
  assert.match(tooLarge, /projected scope exceeds the comparison limit/);
  assert.doesNotMatch(tooLarge, /confidential|No projected text changes/);
  const bounded = comparisonNarration({ ...snapshot('\u2003\n'.repeat(100), '\u00a0\r'.repeat(100), 'endnotes'), word });
  assert.ok(Array.from(bounded).length <= COMPARISON_SPEECH_LIMIT);
  assert.match(bounded, /speech length limit/);
});

test('aligned narration follows original counterpart passages and calls them source text rather than rendered structure', () => {
  const first = 'The first \\emph{finding} is exact.', second = 'The second \\emph{finding} is exact.';
  const before = `${first}\n\n${second}\n\nConclusion remains.\n`, after = `${second}\n\n${first}\n\nConclusion remains.\n`;
  const selected = paragraphSnapshot(before, after, 'paper.tex');
  const result = compareParagraphFile({ path: 'paper.tex', content: before }, { path: 'paper.tex', content: after });
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(result.reordered.length, 1);
  const original = structuredClone(result), match = result.reordered[0]!;
  const removed = comparisonNarration({ ...selected, result, passageIndex: match.beforePassage }, 'current');
  const added = comparisonNarration({ ...selected, result, passageIndex: match.afterPassage }, 'current');
  for (const spoken of [removed, added]) {
    assert.match(spoken, /^L3, version 1 to version 3, file paper\.tex\./);
    assert.match(spoken, /Source paragraph alignment\. Exact paragraph matches describe source text, not rendered structure\./);
    assert.ok(spoken.includes(first), 'the selected original paragraph remains literal, including its TeX command');
    assert.doesNotMatch(spoken, /No text changes|latest version|semantic equivalence|AI/);
    assert.ok(Array.from(spoken).length <= COMPARISON_SPEECH_LIMIT);
  }
  assert.match(removed, new RegExp(`Change ${match.beforePassage + 1} of ${result.passages.length}\\.`));
  assert.match(removed, /Removed text:/); assert.doesNotMatch(removed, /Added text:/);
  assert.match(added, new RegExp(`Change ${match.afterPassage + 1} of ${result.passages.length}\\.`));
  assert.match(added, /Added text:.*The first/s);
  assert.match(added, /Removed text: \[2 line feeds\]/, 'counterpart navigation still narrates separator changes in the same original passage');
  assert.deepEqual(result, original, 'narration cannot change source offsets, matching rows, or the literal result');
});

test('aligned speech keeps filtering, Unicode bounds and whole-comparison failure truthful', () => {
  const filtered = comparisonNarration({ ...paragraphSnapshot('First  sentence.\n\nTail.', 'First sentence.\n\nTail.'), skipSpaceTabOnly: true });
  assert.match(filtered, /Source paragraph alignment/);
  assert.match(filtered, /No changed passages remain under this filter/);
  assert.doesNotMatch(filtered, /No text changes in this file/);
  const selected = paragraphSnapshot('\u2003\n'.repeat(100), '\u00a0\r'.repeat(100), `${'長😀'.repeat(150)}.tex`);
  assert.equal(selected.result.status, 'ready');
  const bounded = comparisonNarration(selected);
  assert.match(bounded, /Source paragraph alignment/); assert.match(bounded, /filename shortened/); assert.match(bounded, /speech length limit/);
  assert.ok(Array.from(bounded).length <= COMPARISON_SPEECH_LIMIT);
  assert.doesNotMatch(bounded, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  const unavailable = paragraphSnapshot('confidential paragraph'.repeat(12_000), 'new');
  assert.equal(unavailable.result.status, 'too_large');
  const failure = comparisonNarration(unavailable);
  assert.match(failure, /exceeds the comparison limit\. No changes were summarized/);
  assert.doesNotMatch(failure, /confidential|No text changes|changed passages|Removed text:|Added text:/);
  assert.match(comparisonNarration(paragraphSnapshot('same\n\nsource', 'same\n\nsource')), /No text changes in this file/);
});

test('literal and Word speech do not acquire paragraph interpretation from a dormant preference', () => {
  const literal = snapshot('Old claim.', 'New claim.');
  assert.equal(comparisonNarration({ ...literal, paragraphAlignment: false }), comparisonNarration(literal));
  assert.doesNotMatch(comparisonNarration(literal), /paragraph alignment|rendered structure/i);
  const word = { ...snapshot('Old note.', 'New note.', 'footnotes'), word: { scopeLabel: 'Footnotes', basePackageSha256: 'a'.repeat(64), targetPackageSha256: 'b'.repeat(64) } };
  assert.equal(comparisonNarration({ ...word, paragraphAlignment: true }), comparisonNarration(word), 'Word always retains its separate projected-text contract');
  assert.match(comparisonNarration(word), /limited tracked-change coverage/);
});
