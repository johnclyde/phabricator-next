import type { AuthContext } from '../shared/auth.ts';
import type { SuiteAccess, SuiteApp, SuiteEvent, SuiteRecord } from '../shared/suite.ts';
export interface SuiteContext {
  actor: AuthContext; now: string;
  creationAccess?: SuiteAccess;
  get(id: string): SuiteRecord;
  list(app: SuiteApp, kind?: string): SuiteRecord[];
  exists(app: SuiteApp, kind: string, predicate: (record: SuiteRecord) => boolean): boolean;
  canEdit(record: SuiteRecord): boolean;
  requireEdit(record: SuiteRecord): void;
  requirePerson(id: string): { id: string; displayName: string };
}
export interface SuiteCreation { kind: string; title: string; data: Record<string, unknown>; access?: Partial<SuiteAccess>; summary?: string }
export interface SuiteChange { title?: string; data: Record<string, unknown>; access?: Partial<SuiteAccess>; summary: string }
export interface SuiteModule {
  app: SuiteApp; prefix: string;
  /** Resolve an inherited creation Space before validating default access. */
  creationAccessSource?(input: Record<string, unknown>, context: SuiteContext): string | null;
  create(input: unknown, context: SuiteContext): SuiteCreation;
  command(record: SuiteRecord, action: string, input: unknown, context: SuiteContext): SuiteChange;
  /** Inherit the current parent's audience in addition to this record's Space. */
  accessSource?(record: SuiteRecord): string | null;
  /** Additional current-source constraints; the common Space/object policy still applies. */
  canView?(record: SuiteRecord, context: SuiteContext): boolean;
  canEdit?(record: SuiteRecord, context: SuiteContext): boolean;
  /** Redact private answers, ballot identities, etc. before any response or history. */
  present?(record: SuiteRecord, context: SuiteContext): SuiteRecord;
  presentEvents?(events: SuiteEvent[], record: SuiteRecord, context: SuiteContext): SuiteEvent[];
}
