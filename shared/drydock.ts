import type { GitObjectFormat } from './repositories';

export type DrydockLeaseStatus = 'pending' | 'acquired' | 'active' | 'releasing' | 'released' | 'broken' | 'expired';
export type DrydockResourceStatus = 'pending' | 'active' | 'releasing' | 'released' | 'broken';
export interface DrydockBinding { key: string; worker: string; repositoryIds: string[] }
export interface DrydockBlueprintInput { name: string; description: string; enabled: boolean; repositoryId: string; binding: string; worker: string; limit: number }
export interface DrydockBlueprint extends DrydockBlueprintInput { id: string; version: number; ownerId: string; type: 'working-copy'; createdAt: string; updatedAt: string }
export interface DrydockAuthorization { id: string; version: number; blueprintId: string; subjectKind: 'principal' | 'build-plan'; subjectId: string; status: 'pending' | 'approved' | 'denied' | 'revoked'; requestedBy: string; decidedBy: string | null; createdAt: string; updatedAt: string }
export interface DrydockSource { repositoryId: string; commitId: string; treeId: string; objectFormat: GitObjectFormat }
export interface DrydockLease { id: string; version: number; blueprintId: string; blueprintVersion: number; blueprint: DrydockBlueprint; authorizationId: string; source: DrydockSource; status: DrydockLeaseStatus; holderId: string; buildId: string | null; targetId: string | null; resourceId: string | null; createdAt: string; updatedAt: string; expiresAt: string; reason: string }
export interface DrydockResource { id: string; version: number; blueprintId: string; leaseId: string; status: DrydockResourceStatus; binding: string; worker: string; workerPrincipalId: string; handle: string; source: DrydockSource; createdAt: string; updatedAt: string }
export interface DrydockLog { id: string; leaseId: string; resourceId: string | null; type: string; message: string; actorId: string; createdAt: string }
export interface DrydockLeaseDetail { lease: DrydockLease; resource: DrydockResource | null; logs: DrydockLog[] }
export interface DrydockBlueprintDetail { blueprint: DrydockBlueprint; authorizations: DrydockAuthorization[]; leases: DrydockLease[]; resources: DrydockResource[] }
export interface DrydockRequestInput { blueprintId: string; blueprintVersion: number; durationSeconds?: number }
export interface DrydockClaim { operation: 'provision' | 'release'; lease: DrydockLease; resource: DrydockResource; token: string; claimUntil: string }
export interface DrydockReportInput { token: string; reportId: string; type: 'active' | 'released' | 'broken' | 'heartbeat'; log?: string }
export interface DrydockWorkingCopy { leaseId: string; resourceId: string; binding: string; worker: string; handle: string; source: DrydockSource; expiresAt: string }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid Drydock configuration fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\uD800-\uDFFF]/u.test(value) || value.includes('\0')) throw new Error(`Invalid ${name}.`);
  return value;
}
export function drydockBlueprintInput(value: unknown): DrydockBlueprintInput {
  const data = record(value, ['name', 'description', 'enabled', 'repositoryId', 'binding', 'worker', 'limit']);
  if (typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.limit) || Number(data.limit) < 1) throw new Error('Choose a blueprint status and a positive resource limit.');
  const binding = text(data.binding, 'operator binding', 100), worker = text(data.worker, 'worker label', 100), repositoryId = text(data.repositoryId, 'repository', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(binding) || !/^R[1-9]\d*$/.test(repositoryId)) throw new Error('Choose a configured binding and repository.');
  return { name: text(data.name, 'blueprint name', 240), description: text(data.description ?? '', 'description', 20_000, true), enabled: data.enabled, repositoryId, binding, worker, limit: data.limit as number };
}
export function drydockReportInput(value: unknown): DrydockReportInput {
  const data = record(value, ['token', 'reportId', 'type', 'log']);
  if (!['active', 'released', 'broken', 'heartbeat'].includes(String(data.type))) throw new Error('Invalid resource report type.');
  return { token: text(data.token, 'claim token', 128), reportId: text(data.reportId, 'report identity', 128), type: data.type as DrydockReportInput['type'], log: text(data.log ?? '', 'resource log', 20_000, true) };
}
