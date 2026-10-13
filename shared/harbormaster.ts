import type { DrydockWorkingCopy } from './drydock';
import type { RevisionKind, RevisionVersion } from './types';

export type BuildStatus = 'pending' | 'building' | 'passed' | 'failed' | 'aborted' | 'paused';
export type BuildTargetStatus = 'blocked' | 'pending' | 'building' | 'passed' | 'failed' | 'aborted';
export type BuildStepKind = 'local-checks' | 'external' | 'http' | 'working-copy';
export interface BuildStep { key: string; name: string; kind: BuildStepKind; dependsOn: string[]; worker: string | null; endpoint?: string; blueprintId?: string }
export interface BuildPlanInput { name: string; description: string; enabled: boolean; steps: BuildStep[] }
export interface BuildPlan extends BuildPlanInput { id: string; version: number; ownerId: string; createdAt: string; updatedAt: string }
export interface Buildable { id: string; sourceKind: 'revision' | 'commit'; revisionId: string | null; repositoryId: string | null; commitId: string | null; treeId: string | null; objectFormat: 'sha1' | 'sha256' | null; versionId: string | null; versionNumber: number | null; contentHash: string; kind: RevisionKind; createdAt: string }
export interface Build { id: string; buildableId: string; revisionId: string | null; planId: string; planVersion: number; plan: BuildPlan; version: number; status: BuildStatus; createdBy: string; createdAt: string; updatedAt: string; restartOf: string | null }
export interface BuildTarget { id: string; buildId: string; stepKey: string; status: BuildTargetStatus; version: number; attempt: number; worker: string | null; leaseUntil: string | null; startedAt: string | null; finishedAt: string | null; drydockLeaseId?: string }
export interface BuildUnitResult { name: string; result: 'pass' | 'fail' | 'skip' | 'broken' | 'unsound'; duration?: number; details?: string }
export interface BuildLintResult { name: string; code: string; severity: 'error' | 'warning' | 'advice' | 'autofix' | 'disabled'; path: string; line?: number; char?: number; description?: string }
export interface BuildArtifactInput { key: string; name: string; uri: string }
export interface BuildArtifact extends BuildArtifactInput { id: string; targetId: string; attempt: number; createdAt: string }
export interface BuildReportInput { leaseToken: string; reportId: string; type: 'work' | 'pass' | 'fail'; log?: string; unit?: BuildUnitResult[]; lint?: BuildLintResult[]; artifacts?: BuildArtifactInput[] }
export interface BuildReport { id: string; targetId: string; attempt: number; type: 'work' | 'pass' | 'fail'; log: string; unit: BuildUnitResult[]; lint: BuildLintResult[]; createdAt: string; actorId: string }
export interface BuildEvent { id: string; buildId: string; targetId: string | null; type: string; detail: string; actorId: string; createdAt: string }
export interface BuildDetail { build: Build; buildable: Buildable; targets: BuildTarget[]; events: BuildEvent[]; reports: BuildReport[]; artifacts: BuildArtifact[] }
export interface BuildRunInput { planId: string; planVersion: number; versionId: string; contentHash: string }
export interface BuildCommandInput { command: 'pause' | 'resume' | 'abort' | 'restart'; expectedVersion: number }
export interface BuildClaimInput { targetId: string; expectedVersion: number; worker: string }
export interface BuildClaim { target: BuildTarget; leaseToken: string; leaseUntil: string; buildable: Buildable; step: BuildStep; source: RevisionVersion | null; workingCopies?: DrydockWorkingCopy[] }

/** Upstream's default buildable behavior: any completed failure wins, otherwise
 * all plans must pass. Our explicit restart keeps old evidence as another build;
 * superseded attempts are therefore excluded from current aggregate status. */
export function aggregateBuildableStatus(builds: readonly Pick<Build, 'id' | 'restartOf' | 'status'>[]): 'preparing' | 'building' | 'passed' | 'failed' {
  const superseded = new Set(builds.map(build => build.restartOf).filter((id): id is string => id !== null));
  const current = builds.filter(build => !superseded.has(build.id));
  if (!current.length) return 'preparing';
  if (current.some(build => build.status === 'failed' || build.status === 'aborted')) return 'failed';
  return current.every(build => build.status === 'passed') ? 'passed' : 'building';
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid build configuration fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\uD800-\uDFFF]/u.test(value) || value.includes('\0')) throw new Error(`Invalid ${name}.`);
  return value;
}
export function buildPlanInput(value: unknown): BuildPlanInput {
  const data = record(value, ['name', 'description', 'enabled', 'steps']);
  if (typeof data.enabled !== 'boolean' || !Array.isArray(data.steps) || !data.steps.length) throw new Error('A build plan needs a status and at least one step.');
  const keys = new Set<string>();
  const steps = data.steps.map((entry): BuildStep => {
    const step = record(entry, ['key', 'name', 'kind', 'dependsOn', 'worker', 'endpoint', 'blueprintId']);
    const key = text(step.key, 'step key', 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key) || keys.has(key)) throw new Error('Build step keys must be unique letters, numbers, dots, underscores or dashes.');
    keys.add(key);
    if (step.kind !== 'local-checks' && step.kind !== 'external' && step.kind !== 'http' && step.kind !== 'working-copy') throw new Error('Choose deterministic local checks, an external worker or an HTTP request or a Drydock working copy.');
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some(item => typeof item !== 'string') || new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error('Step dependencies must be unique step keys.');
    const worker = step.kind === 'external' || step.kind === 'http' || step.kind === 'working-copy' ? text(step.worker, 'worker label', 100) : null;
    if (step.kind === 'local-checks' && step.worker !== null && step.worker !== undefined) throw new Error('Local checks cannot select an external worker.');
    let endpoint: string | undefined;
    if (step.kind === 'http') {
      endpoint = text(step.endpoint, 'HTTP endpoint', 2_000);
      try { const url = new URL(endpoint); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error(); } catch { throw new Error('HTTP steps need an HTTP(S) URL without credentials or fragments.'); }
    } else if (step.endpoint !== undefined) throw new Error('Only HTTP steps may have an endpoint.');
    const blueprintId = step.kind === 'working-copy' ? text(step.blueprintId, 'Drydock blueprint', 100) : undefined;
    if (step.kind !== 'working-copy' && step.blueprintId !== undefined) throw new Error('Only working-copy steps may select a Drydock blueprint.');
    return { key, name: text(step.name, 'step name', 240), kind: step.kind, dependsOn: [...step.dependsOn] as string[], worker, ...(endpoint ? { endpoint } : {}), ...(blueprintId ? { blueprintId } : {}) };
  });
  const incoming = new Map(steps.map(step => [step.key, step.dependsOn.length])), children = new Map<string, string[]>();
  for (const step of steps) for (const dependency of step.dependsOn) {
    if (!keys.has(dependency) || dependency === step.key) throw new Error('Build steps must depend on other steps in this plan.');
    const list = children.get(dependency) ?? []; list.push(step.key); children.set(dependency, list);
  }
  const ready = steps.filter(step => !step.dependsOn.length).map(step => step.key); let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    visited++;
    for (const child of children.get(ready[index]!) ?? []) { const remaining = incoming.get(child)! - 1; incoming.set(child, remaining); if (!remaining) ready.push(child); }
  }
  if (visited !== steps.length) throw new Error('Build dependencies cannot contain a cycle.');
  return { name: text(data.name, 'plan name', 240), description: text(data.description ?? '', 'plan description', 20_000, true), enabled: data.enabled, steps };
}

export function buildReportInput(value: unknown): BuildReportInput {
  const data = record(value, ['leaseToken', 'reportId', 'type', 'log', 'unit', 'lint', 'artifacts']);
  if (!['work', 'pass', 'fail'].includes(String(data.type))) throw new Error('Build messages must be work, pass or fail.');
  const unit: BuildUnitResult[] = [], lint: BuildLintResult[] = [], artifacts: BuildArtifactInput[] = [];
  for (const key of ['unit', 'lint', 'artifacts']) if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`Invalid ${key} results.`);
  for (const entry of (data.unit ?? []) as unknown[]) {
    const item = record(entry, ['name', 'result', 'duration', 'details']);
    if (!['pass', 'fail', 'skip', 'broken', 'unsound'].includes(String(item.result))) throw new Error('Invalid unit result.');
    if (item.duration !== undefined && (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0)) throw new Error('Unit duration must be nonnegative.');
    unit.push({ name: text(item.name, 'unit name', 500), result: item.result as BuildUnitResult['result'], ...(item.duration === undefined ? {} : { duration: item.duration as number }), ...(item.details === undefined ? {} : { details: text(item.details, 'unit details', 100_000, true) }) });
  }
  for (const entry of (data.lint ?? []) as unknown[]) {
    const item = record(entry, ['name', 'code', 'severity', 'path', 'line', 'char', 'description']);
    if (!['error', 'warning', 'advice', 'autofix', 'disabled'].includes(String(item.severity))) throw new Error('Invalid lint severity.');
    for (const key of ['line', 'char']) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 1)) throw new Error('Lint positions must be positive integers.');
    lint.push({ name: text(item.name, 'lint name', 500), code: text(item.code, 'lint code', 100), severity: item.severity as BuildLintResult['severity'], path: text(item.path, 'lint path', 500), ...(item.line === undefined ? {} : { line: item.line as number }), ...(item.char === undefined ? {} : { char: item.char as number }), ...(item.description === undefined ? {} : { description: text(item.description, 'lint description', 100_000, true) }) });
  }
  const artifactKeys = new Set<string>();
  for (const entry of (data.artifacts ?? []) as unknown[]) {
    const item = record(entry, ['key', 'name', 'uri']), key = text(item.key, 'artifact key', 240), uri = text(item.uri, 'artifact URI', 2_000);
    try { const url = new URL(uri); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error(); } catch { throw new Error('Artifacts must reference HTTP or HTTPS URLs without credentials.'); }
    if (artifactKeys.has(key)) throw new Error('Artifact keys must be unique within a report.'); artifactKeys.add(key);
    artifacts.push({ key, name: text(item.name, 'artifact name', 240), uri });
  }
  return { leaseToken: text(data.leaseToken, 'lease token', 128), reportId: text(data.reportId, 'report identity', 128), type: data.type as BuildReportInput['type'], log: data.log === undefined ? '' : text(data.log, 'log chunk', 500_000, true), unit, lint, artifacts };
}
