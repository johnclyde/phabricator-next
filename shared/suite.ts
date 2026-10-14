/** Portable contracts for the collaboration and service-directory applications. */
export const SUITE_APPS = ['almanac', 'conpherence', 'calendar', 'slowvote', 'phame', 'legalpad'] as const;
export type SuiteApp = typeof SUITE_APPS[number];
export interface SuiteAccess { spaceId: string; visibility: 'workspace' | 'members'; memberIds: string[]; editorIds: string[] }
export interface SuiteRecord<D = Record<string, unknown>> { id: string; app: SuiteApp; kind: string; title: string; ownerId: string; version: number; createdAt: string; updatedAt: string; access: SuiteAccess; data: D }
export interface SuiteEvent { sequence: number; recordId: string; version: number; actorId: string; actorName: string; action: string; summary: string; createdAt: string }
export interface SuiteDetail { record: SuiteRecord; events: SuiteEvent[]; nextBefore: number | null; canEdit: boolean; accessEpoch: number }
export interface SuiteList { records: SuiteRecord[]; nextBefore: number | null; accessEpoch: number }
