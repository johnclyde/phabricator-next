import type { ActorAttribution, Task } from './types';
import type { ProjectReference } from './projects';

/** Board versions cover structure, ordering and current layout inputs. */
export interface Workboard { projectId: string; enabled: boolean; version: number }
export interface WorkboardColumn {
  id: string; projectId: string; kind: 'normal' | 'proxy'; proxyProjectId: string | null;
  isDefault: boolean; name: string; hidden: boolean; pointLimit: number | null;
}
export interface WorkboardColumnSnapshot { id: string; name: string; proxyProjectId: string | null }
export type WorkboardCard = Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'ownerId' | 'projectIds' | 'version'> & { canMove: boolean };
export interface WorkboardCardPage { projectId: string; columnId: string; boardVersion: number; filter: WorkboardFilter; cards: WorkboardCard[]; nextAfter: string | null; accessEpoch?: number }
export interface WorkboardColumnView extends WorkboardColumn {
  proxyProject?: ProjectReference; cards: WorkboardCardPage; visibleCardCount: number; overLimit: boolean;
}
export interface WorkboardFilter { status: 'open' | 'all'; ownerId?: string | null; showHidden: boolean }
export interface WorkboardQuery extends Partial<WorkboardFilter> { limit?: number }
export interface WorkboardCardsQuery extends WorkboardQuery { after?: string; expectedBoardVersion: number }
export interface WorkboardDetail {
  project: ProjectReference; board: Workboard; columns: WorkboardColumnView[]; subprojects: ProjectReference[];
  filter: WorkboardFilter; canEdit: boolean; accessEpoch?: number;
}
/** Successful writes contain no layout or task content; clients explicitly reload. */
export interface WorkboardReceipt {
  projectId: string; saved: true; refreshRequired: true; boardVersion: number;
  columnId?: string; taskId?: string; taskVersion?: number; accessEpoch?: number;
}
export interface ConfigureWorkboardInput { enabled: boolean; expectedBoardVersion: number }
export interface CreateWorkboardColumnInput { name: string; pointLimit?: number | null; expectedBoardVersion: number }
export interface UpdateWorkboardColumnInput { expectedBoardVersion: number; name?: string; hidden?: boolean; pointLimit?: number | null }
export type WorkboardColumnPosition = { beforeColumnId: string } | { afterColumnId: string } | { edge: 'start' | 'end' };
export interface ReorderWorkboardColumnInput { expectedBoardVersion: number; position: WorkboardColumnPosition }
export type WorkboardCardPosition = { beforeTaskId: string } | { afterTaskId: string } | { edge: 'start' | 'end' };
export interface MoveWorkboardCardInput {
  taskId: string; columnId: string; expectedBoardVersion: number; expectedTaskVersion: number; position: WorkboardCardPosition;
}
export type WorkboardImportColumn = Pick<WorkboardColumn, 'id' | 'name' | 'isDefault' | 'pointLimit'>;
export interface WorkboardImportPreview {
  projectId: string; sourceProject: ProjectReference;
  expectedBoardVersion: number; expectedSourceBoardVersion: number;
  columns: WorkboardImportColumn[]; accessEpoch?: number;
}
export interface ImportWorkboardColumnsInput {
  sourceProjectId: string; expectedBoardVersion: number; expectedSourceBoardVersion: number;
}
export interface TaskColumnMove {
  projectId: string; fromColumns: WorkboardColumnSnapshot[]; toColumn: WorkboardColumnSnapshot; operationId: string;
}
export interface WorkboardFieldChange {
  field: 'enabled' | 'name' | 'hidden' | 'pointLimit'; oldValue: string | boolean | number | null; newValue: string | boolean | number | null;
}
export interface WorkboardTransaction {
  id: string; projectId: string; sequence: number; boardVersion: number;
  kind: 'enable' | 'disable' | 'column_create' | 'column_edit' | 'column_reorder' | 'card_move' | 'proxy_create' | 'column_import';
  actor: string | null; createdAt: string; attribution?: ActorAttribution; operationId: string;
  column?: WorkboardColumnSnapshot; changes?: WorkboardFieldChange[];
  columnConfiguration?: Pick<WorkboardColumn, 'isDefault' | 'pointLimit'>;
  importedFrom?: { projectId: string; boardVersion: number; columnCount: number; columnId?: string };
  position?: WorkboardColumnPosition | WorkboardCardPosition;
  taskId?: string; taskVersion?: number; move?: TaskColumnMove;
  /** All related policy objects must remain visible before an event is shown. */
  relatedProjectIds: string[]; relatedTaskIds: string[];
}
export interface WorkboardHistory { transactions: WorkboardTransaction[]; nextBefore: number | null; firstAvailableSequence: number | null; accessEpoch?: number }
