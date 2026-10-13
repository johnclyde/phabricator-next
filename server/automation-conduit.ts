import { createHash } from 'node:crypto';
import type { AuthContext } from '../shared/auth.ts';
import { aggregateBuildableStatus, type Build, type BuildDetail, type BuildPlan, type BuildPlanInput } from '../shared/harbormaster.ts';
import type { Automation } from './automation.ts';
import { HttpError, integer, object, string } from './validation.ts';

export const AUTOMATION_CONDUIT_METHODS = new Set([
  'harbormaster.build.search', 'harbormaster.buildable.search', 'harbormaster.buildplan.search', 'harbormaster.buildstep.search',
  'harbormaster.target.search', 'harbormaster.buildlog.search', 'harbormaster.artifact.search', 'harbormaster.querybuilds', 'harbormaster.querybuildables',
  'harbormaster.sendmessage', 'harbormaster.createartifact', 'harbormaster.buildplan.edit',
]);
export const AUTOMATION_CONDUIT_WRITES = new Set(['harbormaster.sendmessage', 'harbormaster.createartifact', 'harbormaster.buildplan.edit']);
interface SearchRecord { id: string; type: string; phid: string; fields: Record<string, unknown>; attachments: Record<string, unknown> }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new HttpError(400, message); };
const cursorError = (): never => { throw new HttpError(409, 'Search cursor does not match this query or current access.', 'AUTOMATION_CURSOR_CHANGED'); };
const status = (value: string) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) });
const item = (id: string, type: string, fields: object): SearchRecord => ({ id, type, phid: id, fields: fields as Record<string, unknown>, attachments: {} });
const seconds = (timestamp: string) => Math.floor(Date.parse(timestamp) / 1_000);

/** Method names and basic payloads follow upstream. Native IDs and fenced
 * worker credentials are explicit extensions, not a PHID migration layer. */
export function executeAutomationConduit(method: string, params: unknown, context: AuthContext, automation: Automation, rawKey?: string): unknown {
  if (!AUTOMATION_CONDUIT_METHODS.has(method)) throw new HttpError(404, 'This automation Conduit method is not implemented.');
  const mutate = (verb: string, path: string, input: unknown): Record<string, unknown> => {
    if (!rawKey || !/^[A-Za-z0-9._:-]{1,200}$/.test(rawKey)) throw new HttpError(400, 'Automation Conduit writes require a valid Idempotency-Key.');
    return automation.mutate(verb, path, input, `conduit:${method}:${rawKey}`, context).body as Record<string, unknown>;
  };
  if (method === 'harbormaster.sendmessage' || method === 'harbormaster.createartifact') {
    const message = method === 'harbormaster.sendmessage';
    const data = object(params, message ? ['buildTargetPHID', 'type', 'unit', 'lint', 'leaseToken', 'reportId', 'log'] : ['buildTargetPHID', 'artifactKey', 'artifactType', 'artifactData', 'leaseToken', 'reportId']);
    const targetId = string(data.buildTargetPHID, 'Native build target ID', 100), leaseToken = string(data.leaseToken, 'Current worker lease token', 128), reportId = string(data.reportId, 'Unique report ID', 128);
    let input: Record<string, unknown>;
    if (message) { const { buildTargetPHID: _target, ...fields } = data; input = fields; }
    else {
      if (data.artifactType !== 'uri') invalid('Only URI artifacts are supported by this adapter.');
      const artifact = object(data.artifactData, ['uri', 'name', 'ui.external']);
      if (artifact['ui.external'] !== undefined && typeof artifact['ui.external'] !== 'boolean') invalid('The artifact external-link flag must be boolean.');
      const uri = string(artifact.uri, 'Artifact URI', 2_000), key = string(data.artifactKey, 'Artifact key', 240);
      input = { leaseToken, reportId, type: 'work', artifacts: [{ key, uri, name: artifact.name === undefined ? key : string(artifact.name, 'Artifact name', 240) }] };
    }
    const result = mutate('POST', `/api/harbormaster/targets/${targetId}/report`, input) as unknown as BuildDetail;
    return message ? { buildTargetPHID: targetId, buildPHID: result.build.id, status: result.build.status } : { data: result.artifacts.filter(artifact => artifact.targetId === targetId && artifact.key === data.artifactKey).map(artifact => item(artifact.id, 'HMAR', { ...artifact, buildTargetPHID: targetId, artifactType: 'uri', artifactKey: artifact.key, artifactData: { uri: artifact.uri, name: artifact.name, 'ui.external': true } })) };
  }
  if (method === 'harbormaster.buildplan.edit') {
    const data = object(params, ['objectIdentifier', 'transactions', 'expectedVersion']);
    if (!Array.isArray(data.transactions) || !data.transactions.length) invalid('Provide plan transactions.');
    const id = data.objectIdentifier === undefined || data.objectIdentifier === null ? null : string(data.objectIdentifier, 'Native plan ID', 100);
    let input: BuildPlanInput;
    if (id) { const existing = automation.harbormaster.planVersion(id, integer(data.expectedVersion, 'Expected plan version'), context); input = { name: existing.name, description: existing.description, enabled: existing.enabled, steps: existing.steps }; }
    else { if (data.expectedVersion !== undefined) invalid('New plans do not have an expected version.'); input = { name: '', description: '', enabled: true, steps: [] }; }
    const seen = new Set<string>();
    for (const transaction of data.transactions as unknown[]) {
      const entry = object(transaction, ['type', 'value']), kind = string(entry.type, 'Transaction type', 30); if (seen.has(kind)) invalid('Each plan field may be changed once per call.'); seen.add(kind);
      if (kind === 'name') input.name = string(entry.value, 'Plan name', 240);
      else if (kind === 'description') input.description = string(entry.value, 'Plan description', 20_000, true);
      else if (kind === 'status') { if (!['active', 'disabled'].includes(String(entry.value))) invalid('Plan status must be active or disabled.'); input.enabled = entry.value === 'active'; }
      else if (kind === 'steps') input.steps = entry.value as BuildPlanInput['steps'];
      else invalid('Supported plan transactions are name, description, status and the native complete steps configuration.');
    }
    const result = mutate(id ? 'PUT' : 'POST', id ? `/api/harbormaster/plans/${id}` : '/api/harbormaster/plans', { ...input, ...(id ? { expectedVersion: data.expectedVersion } : {}) });
    const plan = result.plan as BuildPlan; return { object: { id: plan.id, phid: plan.id }, plan, transactions: [] };
  }

  const legacyBuilds = method === 'harbormaster.querybuilds', legacyBuildables = method === 'harbormaster.querybuildables';
  const legacy = legacyBuilds || legacyBuildables;
  const data = object(params, legacy ? ['ids', 'phids', 'buildStatuses', 'buildablePHIDs', 'buildPlanPHIDs', 'containerPHIDs', 'limit', 'after', 'before'] : ['constraints', 'attachments', 'queryKey', 'order', 'limit', 'after', 'before']);
  if (data.queryKey !== undefined && data.queryKey !== null && data.queryKey !== '' && data.queryKey !== 'all') invalid('Only the all query is supported.');
  if (data.order !== undefined && !['newest', 'oldest'].includes(String(data.order))) invalid('Use newest or oldest ordering.');
  const attachment = data.attachments === undefined ? {} : object(data.attachments, []); void attachment;
  const kind = legacyBuilds ? 'build' : legacyBuildables ? 'buildable' : method.split('.')[1]!;
  const fields: Record<string, string[]> = {
    build: ['ids', 'phids', 'statuses', 'buildables', 'plans'], buildable: ['ids', 'phids', 'objectPHIDs', 'containerPHIDs'],
    buildplan: ['ids', 'phids', 'statuses'], buildstep: ['ids', 'phids', 'plans'], target: ['ids', 'phids', 'builds'], buildlog: ['ids', 'phids', 'buildTargetPHIDs'], artifact: ['ids', 'phids', 'buildTargetPHIDs'],
  };
  const constraints = legacy ? Object.fromEntries(Object.entries(data).filter(([key]) => !['limit', 'before', 'after'].includes(key)).map(([key, value]) => [({ buildStatuses: 'statuses', buildablePHIDs: legacyBuilds ? 'buildables' : 'objectPHIDs', buildPlanPHIDs: 'plans' } as Record<string, string>)[key] ?? key, value])) : object(data.constraints ?? {}, fields[kind]!);
  object(constraints, fields[kind]!);
  for (const value of Object.values(constraints)) if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry || entry.length > 200)) invalid('Search constraints must be lists of native string identities or statuses.');
  const limit = data.limit === undefined ? 100 : integer(data.limit, 'Limit'); if (limit > 100) invalid('Search pages may contain at most 100 records.');
  const current = automation.read('/api/harbormaster/plans', new URLSearchParams(), context) as { accessEpoch: number }, epoch = current.accessEpoch;
  let records: SearchRecord[];
  if (kind === 'buildplan' || kind === 'buildstep') {
    const plans = automation.harbormaster.plans(context);
    records = kind === 'buildplan' ? plans.map(plan => item(plan.id, 'HMCP', { ...plan, status: status(plan.enabled ? 'active' : 'disabled'), dateCreated: seconds(plan.createdAt), dateModified: seconds(plan.updatedAt) })) : plans.flatMap(plan => plan.steps.map(step => item(`${plan.id}:${step.key}`, 'HMCS', { ...step, planPHID: plan.id, planVersion: plan.version })));
  } else {
    const builds = automation.harbormaster.list(context), details = kind === 'build' ? [] : builds.map(build => automation.harbormaster.detail(build.id, context));
    if (kind === 'build') records = builds.map(build => item(build.id, 'HMBD', { ...build, buildablePHID: build.buildableId, buildPlanPHID: build.planId, buildStatus: status(build.status), dateCreated: seconds(build.createdAt), dateModified: seconds(build.updatedAt) }));
    else if (kind === 'buildable') {
      const grouped = new Map<string, Build[]>();
      for (const build of builds) { const group = grouped.get(build.buildableId) ?? []; group.push(build); grouped.set(build.buildableId, group); }
      const seen = new Set<string>(); records = details.filter(detail => { if (seen.has(detail.buildable.id)) return false; seen.add(detail.buildable.id); return true; }).map(detail => item(detail.buildable.id, 'HMBA', { ...detail.buildable, buildablePHID: detail.buildable.versionId ?? detail.buildable.commitId, containerPHID: detail.buildable.revisionId ?? detail.buildable.repositoryId, buildableStatus: status(aggregateBuildableStatus(grouped.get(detail.buildable.id)!)) }));
    }
    else if (kind === 'target') records = details.flatMap(detail => detail.targets.map(target => item(target.id, 'HMBT', { ...target, buildPHID: detail.build.id, step: detail.build.plan.steps.find(step => step.key === target.stepKey), status: status(target.status), contentHash: detail.buildable.contentHash })));
    else if (kind === 'buildlog') records = details.flatMap(detail => detail.reports.filter(report => report.log).map(report => item(report.id, 'HMBL', { buildTargetPHID: report.targetId, attempt: report.attempt, name: `Attempt ${report.attempt}`, text: report.log, dateCreated: seconds(report.createdAt) })));
    else records = details.flatMap(detail => detail.artifacts.map(artifact => item(artifact.id, 'HMAR', { ...artifact, buildTargetPHID: artifact.targetId, artifactType: 'uri', artifactKey: artifact.key, artifactData: { uri: artifact.uri, name: artifact.name, 'ui.external': true } })));
  }
  records = records.filter(record => Object.entries(constraints).every(([key, values]) => {
    const candidates = values as string[];
    const actual = key === 'ids' || key === 'phids' ? record.id : key === 'statuses' ? ((record.fields.buildStatus ?? record.fields.status) as { value: string })?.value : key === 'buildables' ? record.fields.buildablePHID : key === 'plans' ? record.fields.buildPlanPHID ?? record.fields.planPHID : key === 'builds' ? record.fields.buildPHID : key === 'objectPHIDs' ? record.fields.buildablePHID : key === 'containerPHIDs' ? record.fields.containerPHID : record.fields.buildTargetPHID;
    return candidates.includes(String(actual));
  }));
  if (data.order === 'oldest') records.reverse();
  const fingerprint = digest([method, constraints, data.order ?? 'newest', context.workspaceId, context.principalId]);
  const encode = (id: string): string => Buffer.from(JSON.stringify({ version: 1, fingerprint, epoch, id })).toString('base64url');
  const decode = (value: unknown): number => {
    if (typeof value !== 'string' || value.length > 1_000) cursorError();
    let cursor: Record<string, unknown>; try { cursor = object(JSON.parse(Buffer.from(value as string, 'base64url').toString('utf8')), ['version', 'fingerprint', 'epoch', 'id']); } catch { return cursorError(); }
    if (cursor.version !== 1 || cursor.fingerprint !== fingerprint || cursor.epoch !== epoch) cursorError(); const index = records.findIndex(record => record.id === cursor.id); if (index < 0) cursorError(); return index;
  };
  if (data.after != null && data.before != null) invalid('Use one page direction.');
  const start = data.after != null ? decode(data.after) + 1 : data.before != null ? Math.max(0, decode(data.before) - limit) : 0, end = data.before != null ? decode(data.before) : start + limit;
  const page = records.slice(start, end);
  const result = { data: legacy ? page.map(record => ({ id: record.id, phid: record.phid, ...record.fields, ...(legacyBuildables ? { buildableStatus: (record.fields.buildableStatus as { value: string }).value, buildableStatusName: (record.fields.buildableStatus as { name: string }).name } : {}) })) : page, maps: {}, query: { queryKey: data.queryKey ?? null }, cursor: { limit, after: start + page.length < records.length && page.length ? encode(page.at(-1)!.id) : null, before: start > 0 && page.length ? encode(page[0]!.id) : null, order: data.order ?? 'newest' }, accessEpoch: epoch, compatibility: { identities: 'native', status: 'partial', workerLeasesRequired: true } };
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) throw new HttpError(413, 'Build search response is too large. Narrow the query or page size.');
  return result;
}
