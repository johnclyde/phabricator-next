/** Herald rule semantics follow the pinned 2021 engine. Host integrations supply
 * object snapshots, authority, and bounded regular-expression evaluation. */
export type HeraldContentType = 'revision' | 'task' | 'wiki' | 'paste' | 'commit' | 'push-ref' | 'push-content';
export type HeraldRuleType = 'personal' | 'object' | 'global';
export type HeraldRepetition = 'every' | 'first' | 'change';
export type HeraldField = 'always' | 'isNew' | 'title' | 'body' | 'comment' | 'status' | 'priority' | 'actorId' | 'authorId' | 'ownerId' | 'repositoryId' | 'projectIds' | 'subscriberIds' | 'reviewerIds' | 'filePaths' | 'fileContent' | 'rule' | 'refName' | 'refType' | 'refChange' | 'forced' | 'commitId' | 'authorRaw' | 'committerRaw' | 'branches' | 'isMerge' | 'diffAdded' | 'diffRemoved';
export type HeraldOperator = 'contains' | '!contains' | 'is' | '!is' | 'isany' | '!isany' | 'all' | 'any' | 'none' | 'exists' | '!exists' | 'true' | 'false' | 'regexp' | '!regexp' | 'regexp-pair' | 'conditions' | '!conditions';
export interface HeraldCondition { field: HeraldField; operator: HeraldOperator; value: string | string[] | boolean | null }
export type HeraldAction =
  | { type: 'nothing' | 'add-self-subscriber' | 'remove-self-subscriber' | 'add-self-reviewer' | 'assign-self' }
  | { type: 'add-subscribers' | 'remove-subscribers' | 'add-projects' | 'remove-projects' | 'run-build-plans'; targets: string[] }
  | { type: 'add-reviewers'; targets: string[]; required?: boolean }
  | { type: 'comment' | 'task-status' | 'task-priority' | 'block-push'; value: string }
  | { type: 'assign'; value: string | null };
export interface HeraldRuleInput { name: string; contentType: HeraldContentType; ruleType: HeraldRuleType; objectId: string | null; enabled: boolean; match: 'all' | 'any'; repetition: HeraldRepetition; conditions: HeraldCondition[]; actions: HeraldAction[] }
export interface HeraldRule extends HeraldRuleInput { id: string; version: number; authorId: string; createdAt: string; updatedAt: string }
export interface HeraldRuleVersion { rule: HeraldRule; actorId: string; createdAt: string }
export interface HeraldGitSnapshot {
  commitId: string | null; refName: string | null; refType: 'branch' | 'tag' | null; refChange: 'create' | 'update' | 'delete' | null;
  forced: boolean; isMerge: boolean; authorRaw: string; committerRaw: string; branches: string[];
  diffAdded: { path: string; content: string }[]; diffRemoved: { path: string; content: string }[];
}
export interface HeraldSnapshot {
  objectId: string; contentType: HeraldContentType; eventId: string; actorId: string; isNew: boolean;
  title: string; body: string; comment: string; status: string; priority: string | null; authorId: string | null;
  ownerId: string | null; repositoryId: string | null; projectIds: string[]; subscriberIds: string[]; reviewerIds: string[];
  git?: HeraldGitSnapshot;
  files: { path: string; content: string }[]; version: number; versionId: string | null; contentHash: string | null;
}
export interface HeraldRuleState { applied: boolean; matched: boolean }
export interface HeraldConditionResult { index: number; condition: HeraldCondition; matched: boolean | null; error?: string }
export type HeraldRuleResultStatus = 'matched' | 'not-matched' | 'disabled' | 'wrong-content-type' | 'out-of-scope' | 'forbidden' | 'already-applied' | 'previously-matched' | 'error';
export interface HeraldRuleResult { ruleId: string; ruleVersion: number; name: string; status: HeraldRuleResultStatus; matched: boolean; shouldAct: boolean; conditions: HeraldConditionResult[]; error?: string }
export interface HeraldEffect { ruleId: string; ruleVersion: number; actionIndex: number; action: HeraldAction }
export interface HeraldActionResult extends HeraldEffect { status: 'applied' | 'no-effect' | 'dry-run' | 'forbidden' | 'error'; message: string; references?: string[] }
export interface HeraldEvaluation { rules: HeraldRuleResult[]; effects: HeraldEffect[]; state: Record<string, HeraldRuleState> }
export interface HeraldTranscript { id: string; eventId: string; objectId: string; contentType: HeraldContentType; createdAt: string; dryRun: boolean; actorId: string; snapshot: HeraldSnapshot; rules: HeraldRuleResult[]; actions: HeraldActionResult[] }
export interface HeraldFieldDefinition { key: HeraldField; label: string; type: 'boolean' | 'text' | 'identity' | 'list' | 'text-list' | 'text-map' | 'rule'; contentTypes: readonly HeraldContentType[] }
export const HERALD_CONTENT_TYPES: readonly HeraldContentType[] = ['revision', 'task', 'wiki', 'paste', 'commit', 'push-ref', 'push-content'];
const allTypes = HERALD_CONTENT_TYPES;
const objectTypes: readonly HeraldContentType[] = ['revision', 'task', 'wiki', 'paste'];
const gitTypes: readonly HeraldContentType[] = ['commit', 'push-ref', 'push-content'];
const gitContentTypes: readonly HeraldContentType[] = ['commit', 'push-content'];
export const HERALD_FIELDS: readonly HeraldFieldDefinition[] = [
  { key: 'always', label: 'Always', type: 'boolean', contentTypes: allTypes },
  { key: 'isNew', label: 'Object is newly created', type: 'boolean', contentTypes: allTypes },
  { key: 'title', label: 'Title', type: 'text', contentTypes: allTypes },
  { key: 'body', label: 'Description or content', type: 'text', contentTypes: allTypes },
  { key: 'comment', label: 'Comment content', type: 'text', contentTypes: objectTypes },
  { key: 'status', label: 'Status', type: 'text', contentTypes: ['revision', 'task', 'wiki', 'paste'] },
  { key: 'priority', label: 'Priority', type: 'text', contentTypes: ['task'] },
  { key: 'actorId', label: 'Acting user', type: 'identity', contentTypes: allTypes },
  { key: 'authorId', label: 'Author', type: 'identity', contentTypes: ['revision', 'task', 'paste'] },
  { key: 'ownerId', label: 'Assigned to', type: 'identity', contentTypes: ['task'] },
  { key: 'repositoryId', label: 'Repository', type: 'identity', contentTypes: ['revision', ...gitTypes] },
  { key: 'projectIds', label: 'Project tags', type: 'list', contentTypes: ['revision', 'task', ...gitTypes] },
  { key: 'subscriberIds', label: 'Subscribers', type: 'list', contentTypes: objectTypes },
  { key: 'reviewerIds', label: 'Reviewers', type: 'list', contentTypes: ['revision'] },
  { key: 'filePaths', label: 'Source filenames', type: 'text-list', contentTypes: ['revision', ...gitContentTypes] },
  { key: 'fileContent', label: 'Source file content or commit diff', type: 'text-map', contentTypes: ['revision', ...gitContentTypes] },
  { key: 'refName', label: 'Full ref name', type: 'text', contentTypes: ['push-ref'] },
  { key: 'refType', label: 'Ref type (branch or tag)', type: 'text', contentTypes: ['push-ref'] },
  { key: 'refChange', label: 'Ref change (create, update or delete)', type: 'text', contentTypes: ['push-ref'] },
  { key: 'forced', label: 'Non-fast-forward update', type: 'boolean', contentTypes: ['push-ref'] },
  { key: 'commitId', label: 'Commit object ID', type: 'text', contentTypes: gitContentTypes },
  { key: 'authorRaw', label: 'Commit author (raw name and email)', type: 'text', contentTypes: gitContentTypes },
  { key: 'committerRaw', label: 'Committer (raw name and email)', type: 'text', contentTypes: gitContentTypes },
  { key: 'branches', label: 'Affected branches', type: 'text-list', contentTypes: gitContentTypes },
  { key: 'isMerge', label: 'Merge commit', type: 'boolean', contentTypes: gitContentTypes },
  { key: 'diffAdded', label: 'Added diff content', type: 'text-map', contentTypes: gitContentTypes },
  { key: 'diffRemoved', label: 'Removed diff content', type: 'text-map', contentTypes: gitContentTypes },
  { key: 'rule', label: 'Another Herald rule', type: 'rule', contentTypes: allTypes },
];
export const HERALD_OPERATORS: Readonly<Record<HeraldFieldDefinition['type'], readonly HeraldOperator[]>> = {
  boolean: ['true', 'false'], text: ['contains', '!contains', 'is', '!is', 'regexp', '!regexp'],
  identity: ['isany', '!isany', 'exists', '!exists'], list: ['all', 'any', 'none', 'exists', '!exists'],
  'text-list': ['contains', '!contains', 'regexp', '!regexp', 'exists', '!exists'],
  'text-map': ['contains', '!contains', 'regexp', '!regexp', 'regexp-pair'], rule: ['conditions', '!conditions'],
};
export const HERALD_ACTIONS: readonly { type: HeraldAction['type']; label: string; contentTypes: readonly HeraldContentType[]; personal: boolean }[] = [
  { type: 'nothing', label: 'Do nothing', contentTypes: allTypes, personal: true },
  { type: 'add-self-subscriber', label: 'Add me as a subscriber', contentTypes: objectTypes, personal: true },
  { type: 'remove-self-subscriber', label: 'Remove me as a subscriber', contentTypes: objectTypes, personal: true },
  { type: 'add-self-reviewer', label: 'Add me as a reviewer', contentTypes: ['revision'], personal: true },
  { type: 'assign-self', label: 'Assign to me', contentTypes: ['task'], personal: true },
  { type: 'add-subscribers', label: 'Add subscribers', contentTypes: objectTypes, personal: false },
  { type: 'remove-subscribers', label: 'Remove subscribers', contentTypes: objectTypes, personal: false },
  { type: 'add-reviewers', label: 'Add reviewers', contentTypes: ['revision'], personal: false },
  { type: 'add-projects', label: 'Add project tags', contentTypes: ['revision', 'task'], personal: false },
  { type: 'remove-projects', label: 'Remove project tags', contentTypes: ['revision', 'task'], personal: false },
  { type: 'run-build-plans', label: 'Run build plans', contentTypes: ['revision', 'commit'], personal: false },
  { type: 'comment', label: 'Add comment', contentTypes: ['revision', 'task', 'paste'], personal: false },
  { type: 'task-status', label: 'Change task status', contentTypes: ['task'], personal: false },
  { type: 'task-priority', label: 'Change task priority', contentTypes: ['task'], personal: false },
  { type: 'block-push', label: 'Block push with message', contentTypes: ['push-ref', 'push-content'], personal: false },
  { type: 'assign', label: 'Assign task', contentTypes: ['task'], personal: false },
];
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected Herald input fields.'); return value; }
function text(value: unknown, name: string, maximum = 20_000, empty = false): string { if (typeof value !== 'string' || !empty && !value.trim() || value.length > maximum || /[\u0000\uD800-\uDFFF]/u.test(value)) throw new Error(`${name} must be valid text of at most ${maximum} characters.`); return value; }
function identities(value: unknown): string[] { if (!Array.isArray(value) || !value.length) throw new Error('Choose one or more distinct identities.'); const result = value.map(value => text(value, 'Identity', 200)); if (new Set(result).size !== result.length) throw new Error('Choose distinct identities.'); return result; }
export function parseHeraldCondition(input: unknown, contentType: HeraldContentType): HeraldCondition {
  const data = exact(input, ['field', 'operator', 'value']), definition = HERALD_FIELDS.find(field => field.key === data.field && field.contentTypes.includes(contentType));
  if (!definition || !HERALD_OPERATORS[definition.type].includes(data.operator as HeraldOperator)) throw new Error('Choose a supported field and condition.');
  const field = definition.key, operator = data.operator as HeraldOperator;
  let value: HeraldCondition['value'];
  if (['true', 'false', 'exists', '!exists'].includes(operator)) { if (data.value !== null && typeof data.value !== 'boolean') throw new Error('This condition takes no text value.'); value = null; }
  else if (['isany', '!isany', 'all', 'any', 'none'].includes(operator)) value = identities(data.value);
  else { value = text(data.value, 'Condition value', 20_000, true); if (field === 'rule' && !/^H[1-9]\d{0,14}$/.test(value)) throw new Error('Choose an existing Herald rule.'); }
  if (operator === 'regexp-pair') { let pair: unknown; try { pair = JSON.parse(String(value)); } catch { throw new Error('Enter a JSON array containing two regular expressions.'); } if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(value => typeof value === 'string')) throw new Error('Enter a JSON array containing two regular expressions.'); }
  return { field, operator, value };
}
export function parseHeraldAction(input: unknown, contentType: HeraldContentType, ruleType: HeraldRuleType): HeraldAction {
  if (!record(input)) throw new Error('Choose a Herald action.');
  const definition = HERALD_ACTIONS.find(action => action.type === input.type && action.contentTypes.includes(contentType));
  if (!definition || ruleType === 'personal' && !definition.personal) throw new Error('This action is unavailable for the rule type.');
  const type = definition.type;
  if (['nothing', 'add-self-subscriber', 'remove-self-subscriber', 'add-self-reviewer', 'assign-self'].includes(type)) { exact(input, ['type']); return { type } as HeraldAction; }
  if (['add-subscribers', 'remove-subscribers', 'add-reviewers', 'add-projects', 'remove-projects', 'run-build-plans'].includes(type)) {
    exact(input, type === 'add-reviewers' ? ['type', 'targets', 'required'] : ['type', 'targets']); const targets = identities(input.targets);
    if (type === 'add-reviewers') { if (input.required !== undefined && typeof input.required !== 'boolean') throw new Error('Required reviewer flag must be boolean.'); return { type, targets, ...(input.required === undefined ? {} : { required: input.required }) }; }
    return { type, targets } as HeraldAction;
  }
  exact(input, ['type', 'value']);
  if (type === 'assign') return { type, value: input.value === null ? null : text(input.value, 'Assignee', 200) };
  const value = text(input.value, 'Action value', type === 'comment' || type === 'block-push' ? 10_000 : 200);
  if (type === 'task-status' && !['open', 'in_progress', 'resolved'].includes(value)) throw new Error('Choose open, in_progress, or resolved; duplicate status requires a merge.');
  if (type === 'task-priority' && !['low', 'normal', 'high', 'urgent'].includes(value)) throw new Error('Choose a valid task priority.');
  return { type, value } as HeraldAction;
}
export function parseHeraldRuleInput(input: unknown): HeraldRuleInput {
  const data = exact(input, ['name', 'contentType', 'ruleType', 'objectId', 'enabled', 'match', 'repetition', 'conditions', 'actions']);
  if (!allTypes.includes(data.contentType as HeraldContentType) || !['personal', 'object', 'global'].includes(String(data.ruleType)) || typeof data.enabled !== 'boolean' || !['all', 'any'].includes(String(data.match)) || !['every', 'first', 'change'].includes(String(data.repetition))) throw new Error('Choose a valid rule type, content type, match mode, and repetition policy.');
  const contentType = data.contentType as HeraldContentType, ruleType = data.ruleType as HeraldRuleType;
  if (ruleType === 'object' ? typeof data.objectId !== 'string' || !/^(?:R|PROJ)[1-9]\d{0,14}$/.test(data.objectId) : data.objectId !== null) throw new Error('Object rules require a repository or project; other rules have no scope object.');
  if (!Array.isArray(data.conditions) || !Array.isArray(data.actions) || !data.actions.length) throw new Error('Provide conditions and at least one action.');
  return { name: text(data.name, 'Rule name', 255).trim(), contentType, ruleType, objectId: data.objectId as string | null, enabled: data.enabled, match: data.match as 'all' | 'any', repetition: data.repetition as HeraldRepetition, conditions: data.conditions.map(condition => parseHeraldCondition(condition, contentType)), actions: data.actions.map(action => parseHeraldAction(action, contentType, ruleType)) };
}
export interface HeraldEvaluationOptions { dryRun?: boolean; canEvaluate?: (rule: HeraldRule, snapshot: HeraldSnapshot) => boolean; matchesScope?: (rule: HeraldRule, snapshot: HeraldSnapshot) => boolean; regexp?: (pattern: string, values: readonly string[]) => boolean }
const order: Record<HeraldRuleType, number> = { personal: 0, object: 1, global: 2 };
export function heraldRuleOrder(a: HeraldRule, b: HeraldRule): number { return order[a.ruleType] - order[b.ruleType] || Number(a.id.slice(1)) - Number(b.id.slice(1)); }
/** All conditions see the original snapshot, never effects of earlier rules. */
export function evaluateHeraldRules(rules: readonly HeraldRule[], snapshot: HeraldSnapshot, previous: Readonly<Record<string, HeraldRuleState>> = {}, options: HeraldEvaluationOptions = {}): HeraldEvaluation {
  const sorted = [...rules].sort(heraldRuleOrder), byId = new Map(sorted.map(rule => [rule.id, rule])), results = new Map<string, HeraldRuleResult>(), active: string[] = [];
  const evaluate = (rule: HeraldRule): HeraldRuleResult => {
    const cached = results.get(rule.id); if (cached) return cached;
    if (active.includes(rule.id)) throw new Error(`Recursive rule dependency: ${[...active.slice(active.indexOf(rule.id)), rule.id].join(' → ')}.`);
    const result: HeraldRuleResult = { ruleId: rule.id, ruleVersion: rule.version, name: rule.name, status: 'not-matched', matched: false, shouldAct: false, conditions: [] };
    const finish = (status: HeraldRuleResultStatus) => { result.status = status; results.set(rule.id, result); return result; };
    if (!rule.enabled) return finish('disabled');
    if (rule.contentType !== snapshot.contentType) return finish('wrong-content-type');
    const inScope = rule.ruleType !== 'object' || (options.matchesScope ? options.matchesScope(rule, snapshot) : rule.objectId === snapshot.repositoryId || snapshot.projectIds.includes(rule.objectId!));
    if (!inScope) return finish('out-of-scope');
    if (!options.canEvaluate?.(rule, snapshot)) return finish('forbidden');
    if (!options.dryRun && rule.repetition === 'first' && (previous[rule.id]?.applied || previous[rule.id]?.matched)) return finish('already-applied');
    active.push(rule.id);
    try {
      let matched = rule.conditions.length > 0 && rule.match === 'all';
      for (const [index, condition] of rule.conditions.entries()) {
        let conditionMatched: boolean;
        try {
        let value: string | string[] | boolean | null;
        if (condition.field === 'rule') {
          const dependency = byId.get(String(condition.value)); if (!dependency || !dependency.enabled) throw new Error(`Referenced rule ${String(condition.value)} is unavailable.`);
          const dependent = evaluate(dependency); if (dependent.status === 'error') throw new Error(dependent.error ?? 'Referenced rule failed.');
          value = dependent.shouldAct;
        } else if (condition.field === 'always') value = true;
        else if (condition.field === 'filePaths') value = snapshot.files.map(file => file.path);
        else if (condition.field === 'fileContent') value = snapshot.files.map(file => file.content);
        else if (condition.field === 'diffAdded' || condition.field === 'diffRemoved') { if (!snapshot.git) throw new Error('Exact Git event facts are unavailable.'); value = snapshot.git[condition.field].map(file => file.content); }
        else if (['refName', 'refType', 'refChange', 'forced', 'commitId', 'authorRaw', 'committerRaw', 'branches', 'isMerge'].includes(condition.field)) { if (!snapshot.git) throw new Error('Exact Git event facts are unavailable.'); value = snapshot.git[condition.field as Exclude<keyof HeraldGitSnapshot, 'diffAdded' | 'diffRemoved'>]; }
        else value = snapshot[condition.field as Exclude<HeraldField, keyof HeraldGitSnapshot | 'filePaths' | 'fileContent' | 'rule' | 'always'>];
          const values = Array.isArray(value) ? value : value === null ? [] : [String(value)], targets = Array.isArray(condition.value) ? condition.value : [];
          switch (condition.operator) {
            case 'contains': case '!contains': { const found = values.some(value => value.toLocaleLowerCase('en-US').includes(String(condition.value).toLocaleLowerCase('en-US'))); conditionMatched = condition.operator === 'contains' ? found : !found; break; }
            case 'is': conditionMatched = value === condition.value; break;
            case '!is': conditionMatched = value !== condition.value; break;
            case 'isany': conditionMatched = typeof value === 'string' && targets.includes(value); break;
            case '!isany': conditionMatched = typeof value !== 'string' || !targets.includes(value); break;
            case 'all': conditionMatched = targets.every(target => values.includes(target)); break;
            case 'any': conditionMatched = targets.some(target => values.includes(target)); break;
            case 'none': conditionMatched = targets.every(target => !values.includes(target)); break;
            case 'exists': case 'true': conditionMatched = Array.isArray(value) ? value.length > 0 : Boolean(value); break;
            case '!exists': case 'false': conditionMatched = Array.isArray(value) ? value.length === 0 : !value; break;
            case 'conditions': conditionMatched = Boolean(value); break;
            case '!conditions': conditionMatched = !value; break;
            case 'regexp': case '!regexp': { if (!options.regexp) throw new Error('Bounded regular-expression evaluation is unavailable.'); const found = options.regexp(String(condition.value), values); conditionMatched = condition.operator === 'regexp' ? found : !found; break; }
            case 'regexp-pair': { if (!options.regexp) throw new Error('Bounded regular-expression evaluation is unavailable.'); const pair = JSON.parse(String(condition.value)) as [string, string]; const files = condition.field === 'diffAdded' || condition.field === 'diffRemoved' ? snapshot.git?.[condition.field] : snapshot.files; if (!files) throw new Error('Exact diff content is unavailable.'); conditionMatched = files.some(file => options.regexp!(pair[0], [file.path]) && options.regexp!(pair[1], [file.content])); break; }
          }
        } catch (error) { result.conditions.push({ index, condition, matched: null, error: error instanceof Error ? error.message : 'Condition evaluation failed.' }); throw error; }
        result.conditions.push({ index, condition, matched: conditionMatched });
        if (rule.match === 'all' && !conditionMatched) { matched = false; break; }
        if (rule.match === 'any' && conditionMatched) { matched = true; break; }
      }
      result.matched = matched;
      if (!matched) return finish('not-matched');
      if (!options.dryRun && rule.repetition === 'change' && (previous[rule.id]?.matched || previous[rule.id]?.applied)) return finish('previously-matched');
      result.shouldAct = true; return finish('matched');
    } catch (error) { result.error = error instanceof Error ? error.message : 'Rule evaluation failed.'; return finish('error'); }
    finally { active.pop(); }
  };
  for (const rule of sorted) evaluate(rule);
  const effects: HeraldEffect[] = [], state: Record<string, HeraldRuleState> = {};
  for (const rule of sorted) {
    const result = results.get(rule.id)!;
    if (result.shouldAct) for (const [actionIndex, action] of rule.actions.entries()) effects.push({ ruleId: rule.id, ruleVersion: rule.version, actionIndex, action });
    if (!options.dryRun && !['disabled', 'wrong-content-type', 'out-of-scope', 'forbidden', 'error'].includes(result.status)) state[rule.id] = { applied: rule.repetition === 'first' && Boolean(previous[rule.id]?.applied || previous[rule.id]?.matched || result.shouldAct), matched: rule.repetition === 'change' && result.matched };
  }
  return { rules: sorted.map(rule => results.get(rule.id)!), effects, state };
}
