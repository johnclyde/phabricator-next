import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHeraldRules, parseHeraldRuleInput, type HeraldRule, type HeraldRuleInput, type HeraldSnapshot } from '../shared/herald.ts';

const input: HeraldRuleInput = { name: 'Route matching work', contentType: 'revision', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'title', operator: 'contains', value: 'duck' }], actions: [{ type: 'nothing' }] };
const snapshot: HeraldSnapshot = { objectId: 'D1', eventId: 'event1', contentType: 'revision', actorId: 'alice', isNew: false, title: 'A Duck revision', body: 'Description', comment: '', status: 'needs_review', priority: null, authorId: 'alice', ownerId: null, repositoryId: 'R1', projectIds: ['PROJ1'], subscriberIds: ['alice'], reviewerIds: ['bob'], files: [{ path: 'src/a.ts', content: 'old source' }], version: 1, versionId: 'v1', contentHash: 'a'.repeat(64) };
const rule = (id = 'H1', changes: Partial<HeraldRuleInput> = {}): HeraldRule => ({ ...input, ...changes, id, version: 1, authorId: 'alice', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const options = { canEvaluate: () => true };

test('Herald conditions match literal text without case sensitivity and preserve exact is semantics', () => {
  assert.equal(evaluateHeraldRules([rule()], snapshot, {}, options).effects.length, 1);
  for (const [operator, value, expected] of [['is', 'A Duck revision', true], ['is', 'a duck revision', false], ['!contains', 'goose', true], ['!is', 'a duck revision', true]] as const) assert.equal(evaluateHeraldRules([rule('H1', { conditions: [{ field: 'title', operator, value }] })], snapshot, {}, options).rules[0].matched, expected);
  assert.equal(evaluateHeraldRules([rule()], snapshot).rules[0].status, 'forbidden');
});

test('Herald supports typed identity, collection, boolean, and file conditions', () => {
  const conditions: HeraldRuleInput['conditions'] = [
    { field: 'actorId', operator: 'isany', value: ['alice'] }, { field: 'authorId', operator: '!isany', value: ['bob'] },
    { field: 'repositoryId', operator: 'exists', value: null }, { field: 'projectIds', operator: 'all', value: ['PROJ1'] },
    { field: 'subscriberIds', operator: 'any', value: ['alice', 'bob'] }, { field: 'reviewerIds', operator: 'none', value: ['alice'] },
    { field: 'filePaths', operator: 'contains', value: '.TS' }, { field: 'fileContent', operator: 'contains', value: 'SOURCE' },
    { field: 'always', operator: 'true', value: null }, { field: 'isNew', operator: 'false', value: null },
  ];
  assert.equal(evaluateHeraldRules([rule('H1', { conditions })], snapshot, {}, options).rules[0].conditions.length, 10);
  assert.equal(evaluateHeraldRules([rule('H1', { conditions })], snapshot, {}, options).effects.length, 1);
});

test('empty conditions never match; all and any short circuit and preserve evaluated evidence', () => {
  for (const match of ['all', 'any'] as const) assert.equal(evaluateHeraldRules([rule('H1', { match, conditions: [] })], snapshot, {}, options).effects.length, 0);
  const conditions: HeraldRuleInput['conditions'] = [{ field: 'isNew', operator: 'true', value: null }, { field: 'title', operator: 'contains', value: 'duck' }, { field: 'rule', operator: 'conditions', value: 'H999' }];
  const all = evaluateHeraldRules([rule('H1', { conditions })], snapshot, {}, options).rules[0], any = evaluateHeraldRules([rule('H1', { conditions, match: 'any' })], snapshot, {}, options).rules[0];
  assert.equal(all.conditions.length, 1); assert.equal(all.status, 'not-matched'); assert.equal(any.conditions.length, 2); assert.equal(any.status, 'matched');
});

test('personal, object, then global rules execute in numeric order against one snapshot', () => {
  const rules = [rule('H2'), rule('H10', { ruleType: 'personal' }), rule('H1', { ruleType: 'object', objectId: 'R1' }), rule('H9', { ruleType: 'personal' }), rule('H3', { ruleType: 'object', objectId: 'PROJ2' })];
  const result = evaluateHeraldRules(rules, snapshot, {}, options);
  assert.deepEqual(result.rules.map(value => value.ruleId), ['H9', 'H10', 'H1', 'H3', 'H2']);
  assert.deepEqual(result.effects.map(value => value.ruleId), ['H9', 'H10', 'H1', 'H2']); assert.equal(result.rules[3].status, 'out-of-scope');
});

test('first and change repetition preserve the nonmatch transition and dry runs consume no state', () => {
  const rules = [rule('H1', { repetition: 'first' }), rule('H2', { repetition: 'change' })];
  const first = evaluateHeraldRules(rules, snapshot, {}, options); assert.equal(first.effects.length, 2);
  const again = evaluateHeraldRules(rules, snapshot, first.state, options); assert.deepEqual(again.rules.map(value => value.status), ['already-applied', 'previously-matched']);
  const noMatch = evaluateHeraldRules(rules, { ...snapshot, title: 'goose' }, again.state, options); assert.equal(noMatch.state.H1.applied, true); assert.equal(noMatch.state.H2.matched, false);
  const changed = evaluateHeraldRules(rules, snapshot, noMatch.state, options); assert.deepEqual(changed.effects.map(value => value.ruleId), ['H2']);
  const dryRun = evaluateHeraldRules(rules, snapshot, first.state, { ...options, dryRun: true }); assert.equal(dryRun.effects.length, 2); assert.deepEqual(dryRun.state, {});
});

test('rule references resolve regardless of order and cycles fail without actions', () => {
  const first = rule('H1', { conditions: [{ field: 'rule', operator: 'conditions', value: 'H2' }] }), second = rule('H2');
  const result = evaluateHeraldRules([first, second], snapshot, {}, options); assert.equal(result.effects.length, 2); assert.deepEqual(result.effects.map(value => value.ruleId), ['H1', 'H2']);
  const cycle = evaluateHeraldRules([first, { ...second, conditions: [{ field: 'rule', operator: 'conditions', value: 'H1' }] }], snapshot, {}, options);
  assert.equal(cycle.effects.length, 0); assert.ok(cycle.rules.every(rule => rule.status === 'error')); assert.match(cycle.rules[0].error!, /Recursive/);
  const missing = evaluateHeraldRules([first], snapshot, {}, options); assert.equal(missing.rules[0].status, 'error');
});

test('bounded regular expression hooks receive inert exact values and failures become transcripts', () => {
  const regex = rule('H1', { conditions: [{ field: 'fileContent', operator: 'regexp-pair', value: '["/\\\\.ts$/", "/source/"]' }] });
  const seen: unknown[] = []; const result = evaluateHeraldRules([regex], snapshot, {}, { ...options, regexp: (pattern, values) => { seen.push([pattern, values]); return true; } });
  assert.equal(result.effects.length, 1); assert.deepEqual(seen, [['/\\.ts$/', ['src/a.ts']], ['/source/', ['old source']]]);
  const failed = evaluateHeraldRules([regex], snapshot, {}, { ...options, regexp: () => { throw new Error('Timed out'); } }); assert.equal(failed.rules[0].status, 'error'); assert.equal(failed.rules[0].conditions[0].matched, null);
});

test('strict rule authoring rejects unsupported actions, extra fields, incorrect field operators and arbitrary scope', () => {
  assert.deepEqual(parseHeraldRuleInput(input), input);
  for (const changes of [ { hacked: true }, { objectId: 'R1' }, { ruleType: 'object', objectId: 'D1' }, { enabled: 'true' }, { actions: [] }, { conditions: [{ field: 'title', operator: 'all', value: ['duck'] }] }, { conditions: [{ field: 'ownerId', operator: 'isany', value: ['alice'] }] }, { ruleType: 'personal', actions: [{ type: 'comment', value: 'hi' }] }, { actions: [{ type: 'nothing', value: 'extra' }] }, { name: '\ud800' } ]) assert.throws(() => parseHeraldRuleInput({ ...input, ...changes }));
  assert.equal(parseHeraldRuleInput({ ...input, contentType: 'task', actions: [{ type: 'assign', value: null }] }).actions[0].type, 'assign');
});

test('there is no arbitrary rule, condition, action, or target count cap', () => {
  const many = parseHeraldRuleInput({ ...input, conditions: Array.from({ length: 300 }, () => ({ field: 'always', operator: 'true', value: null })), actions: [{ type: 'add-subscribers', targets: Array.from({ length: 300 }, (_, i) => `person-${i}`) }, ...Array.from({ length: 300 }, () => ({ type: 'nothing' }))] });
  assert.equal(evaluateHeraldRules([rule('H1', many)], snapshot, {}, options).effects.length, 301);
});


test('switching first and change repetition keeps the upstream shared applied marker until an every run clears it', () => {
  const firstRule = rule('H1', { repetition: 'first' }), changeRule = { ...firstRule, repetition: 'change' as const };
  const first = evaluateHeraldRules([firstRule], snapshot, {}, options);
  const changedPolicy = evaluateHeraldRules([changeRule], snapshot, first.state, options); assert.equal(changedPolicy.rules[0].status, 'previously-matched');
  const firstAgain = evaluateHeraldRules([firstRule], snapshot, changedPolicy.state, options); assert.equal(firstAgain.rules[0].status, 'already-applied');
  const every = evaluateHeraldRules([{ ...firstRule, repetition: 'every' }], snapshot, firstAgain.state, options); assert.deepEqual(every.state.H1, { applied: false, matched: false });
  assert.equal(evaluateHeraldRules([firstRule], snapshot, every.state, options).effects.length, 1);
});

function gitSnapshot(): HeraldSnapshot {
  const files = [{ path: 'safe.txt', content: 'exact token' }, { path: 'asset.png', content: '' }, { path: 'huge.txt', content: '' }, { path: 'submodule', content: '' }];
  return { ...snapshot, contentType: 'push-content', files, git: { commitId: 'a'.repeat(40), refName: null, refType: null, refChange: null, forced: false, isMerge: false, authorRaw: 'Contributor', committerRaw: 'Contributor', branches: ['main'], diffAdded: files, diffRemoved: files, fileInspection: files.map((file, index) => ({ path: file.path, kind: (['text', 'binary', 'too-large', 'gitlink'] as const)[index]!, old: null, new: { id: String(index + 1).repeat(40), mode: index === 3 ? '160000' : '100644', bytes: index === 3 ? null : index === 2 ? 9_000_000 : 11 } })) } };
}
const gitRule = (conditions: HeraldRuleInput['conditions'], match: 'all' | 'any' = 'all') => rule('H1', { contentType: 'push-content', conditions, match });
const regexOptions = { ...options, regexp: (pattern: string, values: readonly string[]) => values.some(value => new RegExp(pattern).test(value)) };

test('Git inspection fields expose binary and unavailable paths while filename rules remain usable', () => {
  const source = gitSnapshot(), before = structuredClone(source);
  const conditions: HeraldRuleInput['conditions'] = [{ field: 'binaryFiles', operator: 'contains', value: 'asset.png' }, { field: 'binaryFiles', operator: '!contains', value: 'huge.txt' }, { field: 'uninspectableFiles', operator: 'contains', value: 'submodule' }, { field: 'diffEnormous', operator: 'true', value: null }, { field: 'textInspectionComplete', operator: 'false', value: null }, { field: 'filePaths', operator: 'contains', value: 'huge.txt' }];
  assert.deepEqual(parseHeraldRuleInput({ ...input, contentType: 'push-content', conditions }).conditions, conditions);
  assert.equal(evaluateHeraldRules([gitRule(conditions)], source, {}, options).rules[0].status, 'matched');
  assert.deepEqual(source, before);
});

test('positive and negative Git text conditions fail visibly when any selected text is unavailable', () => {
  for (const field of ['fileContent', 'diffAdded', 'diffRemoved'] as const) for (const operator of ['contains', '!contains', 'regexp', '!regexp'] as const) {
    const result = evaluateHeraldRules([gitRule([{ field, operator, value: operator.startsWith('!') ? 'absent' : 'token' }])], gitSnapshot(), {}, regexOptions);
    assert.equal(result.rules[0].status, 'error', `${field} ${operator}`); assert.match(result.rules[0].error!, /Text is unavailable/); assert.equal(result.effects.length, 0); assert.equal(result.rules[0].conditions[0].matched, null);
  }
});

test('ordered all and any guards preserve short circuit before unavailable Git text conditions', () => {
  const text = { field: 'fileContent', operator: 'contains', value: 'token' } as const;
  const all = evaluateHeraldRules([gitRule([{ field: 'textInspectionComplete', operator: 'true', value: null }, text])], gitSnapshot(), {}, options).rules[0];
  assert.equal(all.status, 'not-matched'); assert.equal(all.conditions.length, 1);
  const any = evaluateHeraldRules([gitRule([{ field: 'textInspectionComplete', operator: 'false', value: null }, text], 'any')], gitSnapshot(), {}, options).rules[0];
  assert.equal(any.status, 'matched'); assert.equal(any.conditions.length, 1);
  const reversed = evaluateHeraldRules([gitRule([text, { field: 'textInspectionComplete', operator: 'true', value: null }])], gitSnapshot(), {}, options).rules[0];
  assert.equal(reversed.status, 'error'); assert.equal(reversed.conditions.length, 1);
});

test('Git regular expression pairs require all selected paths but ignore unavailable unrelated paths', () => {
  for (const field of ['fileContent', 'diffAdded', 'diffRemoved'] as const) {
    const evaluate = (pattern: string) => evaluateHeraldRules([gitRule([{ field, operator: 'regexp-pair', value: JSON.stringify([pattern, 'token']) }])], gitSnapshot(), {}, regexOptions).rules[0];
    assert.equal(evaluate('^safe\\.txt$').status, 'matched', field);
    assert.equal(evaluate('^missing').status, 'not-matched', field);
    assert.equal(evaluate('.*').status, 'error', `${field}: matching text first must not conceal unavailable later paths`);
    assert.equal(evaluate('^asset').status, 'error', field);
  }
});

test('legacy Git evidence remains complete text without adding metadata, and malformed modern coverage errors', () => {
  const legacy = gitSnapshot(); delete legacy.git!.fileInspection; const before = JSON.stringify(legacy);
  const conditions: HeraldRuleInput['conditions'] = [{ field: 'binaryFiles', operator: '!contains', value: 'asset' }, { field: 'uninspectableFiles', operator: '!contains', value: 'huge' }, { field: 'diffEnormous', operator: 'false', value: null }, { field: 'textInspectionComplete', operator: 'true', value: null }, { field: 'fileContent', operator: 'contains', value: 'token' }];
  assert.equal(evaluateHeraldRules([gitRule(conditions)], legacy, {}, options).rules[0].status, 'matched'); assert.equal(JSON.stringify(legacy), before);
  for (const mutate of [(source: HeraldSnapshot) => { source.git!.fileInspection!.pop(); }, (source: HeraldSnapshot) => { source.git!.diffAdded = source.git!.diffAdded.slice(0, 1); }, (source: HeraldSnapshot) => { source.git!.diffRemoved = source.git!.diffRemoved.map(() => source.git!.diffRemoved[0]!); }]) {
    const source = gitSnapshot(); mutate(source);
    assert.equal(evaluateHeraldRules([gitRule([{ field: 'diffAdded', operator: 'regexp-pair', value: '[".*","token"]' }])], source, {}, regexOptions).rules[0].status, 'error');
  }
});
