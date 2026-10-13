import type { HeraldRule, HeraldTranscript } from '../shared/herald.ts';
import type { HeraldStore } from './herald.ts';
import type { PolicyStore } from './policy.ts';
import { HttpError } from './validation.ts';

const objectReference = (value: string): boolean => /^(?:PROJ|R)[1-9]\d{0,14}$/.test(value);
function directReferences(rule: HeraldRule): { objects: string[]; rules: string[] } {
  const objects = rule.objectId === null ? [] : [rule.objectId], rules: string[] = [];
  for (const condition of rule.conditions) {
    if (condition.field === 'rule') rules.push(String(condition.value));
    if (condition.field === 'projectIds' || condition.field === 'repositoryId') for (const value of Array.isArray(condition.value) ? condition.value : typeof condition.value === 'string' ? [condition.value] : []) if (objectReference(value)) objects.push(value);
  }
  for (const action of rule.actions) if (action.type === 'add-projects' || action.type === 'remove-projects') objects.push(...action.targets);
  return { objects, rules };
}
type Resolution = HeraldRule | null | 'unavailable';
function visible(rule: HeraldRule, principalId: string, policies: PolicyStore, resolve: (id: string) => Resolution): boolean {
  const pending = [rule], visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!; if (visited.has(current.id)) continue; visited.add(current.id);
    const references = directReferences(current);
    if (references.objects.some(id => !policies.access(id, principalId).view)) return false;
    for (const id of references.rules) {
      if (visited.has(id)) continue;
      const dependency = resolve(id);
      // A broken reference has no content to reveal; its monogram is the
      // author's explicit rule configuration, just like an unavailable link.
      if (dependency === 'unavailable') return false;
      if (dependency) pending.push(dependency);
    }
  }
  return true;
}
/** Rule metadata must not reveal the identity of an inaccessible scope or
 * typed project/repository reference, including through another rule. */
export function visibleHeraldRule(rule: HeraldRule, principalId: string, herald: HeraldStore, policies: PolicyStore): boolean {
  return visible(rule, principalId, policies, id => { try { return herald.get(id); } catch (error) { return error instanceof HttpError && error.status === 404 ? null : 'unavailable'; } });
}
/** Historical transcripts use their exact saved rule configurations. Editing a
 * rule today must never make an older private condition readable. */
export function presentHeraldTranscript(transcript: HeraldTranscript, principalId: string, herald: HeraldStore, policies: PolicyStore): HeraldTranscript {
  policies.require(transcript.objectId, principalId, 'view');
  const saved = new Map<string, HeraldRule | null>();
  for (const result of transcript.rules) {
    try {
      const rule = herald.history(result.ruleId, result.ruleVersion + 1, 1).versions[0]?.rule;
      saved.set(result.ruleId, rule?.version === result.ruleVersion ? rule : null);
    } catch { saved.set(result.ruleId, null); }
  }
  const resolve = (id: string): Resolution => {
    if (saved.has(id)) return saved.get(id) ?? 'unavailable';
    try { return herald.get(id); } catch (error) { return error instanceof HttpError && error.status === 404 ? null : 'unavailable'; }
  };
  const allowed = new Set<string>();
  for (const result of transcript.rules) {
    const rule = saved.get(result.ruleId);
    if (rule && visible(rule, principalId, policies, resolve)) allowed.add(result.ruleId);
  }
  const projected = structuredClone(transcript);
  projected.snapshot.projectIds = projected.snapshot.projectIds.filter(id => policies.access(id, principalId).view);
  if (projected.snapshot.repositoryId && !policies.access(projected.snapshot.repositoryId, principalId).view) projected.snapshot.repositoryId = null;
  projected.rules = projected.rules.filter(result => allowed.has(result.ruleId));
  projected.actions = projected.actions.filter(action => allowed.has(action.ruleId)).map(action => ({ ...action, ...(action.references ? { references: action.references.filter(id => !objectReference(id) || policies.access(id, principalId).view) } : {}) }));
  return projected;
}
