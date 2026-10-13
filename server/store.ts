import { initializeNotifications, initializeNotificationTargets, NotificationStore } from './notifications.ts';
import { initializeTaskNotifications, TaskNotificationsStore } from './task-notifications.ts';
import { initializeObjectSubscriptions, ObjectSubscriptionStore } from './object-subscriptions.ts';
import { NOTIFICATION_LIMITS, type NotificationContext, type NotificationKind } from '../shared/notifications.ts';
import { initializeWikiSearch, WikiSearchStore } from './wiki-search.ts';
import { initializeRevisionDependencies, RevisionDependencyStore } from './revision-dependencies.ts';
import { RevisionStackStore } from './revision-stack.ts';
import { initializeRevisionAuthorship, RevisionAuthorshipStore } from './revision-authorship.ts';
import { initializeRevisionLifecycle, RevisionLifecycleStore } from './revision-lifecycle.ts';
import type { RevisionLifecycleConfig } from '../shared/revision-lifecycle.ts';
import { initializeRevisionReviewers, RevisionReviewerStore } from './revision-reviewers.ts';
import type { RevisionReviewerConfig } from '../shared/revision-reviewers.ts';
import { initializeRevisionSubscriptions, RevisionSubscriptionStore } from './revision-subscriptions.ts';
import { initializeRevisionProjects, RevisionProjectStore } from './revision-projects.ts';
import { revisionProjectCreationInput } from '../shared/revision-projects.ts';
import { initializeRevisionMetadata, RevisionMetadataStore } from './revision-metadata.ts';
import { initializeReviewDrafts, ReviewDraftStore, type PreparedReviewDraft } from './review-drafts.ts';
import { initializeRevisionViews, RevisionViewStore } from './revision-views.ts';
import type { ReviewDraftPayload } from '../shared/review-drafts.ts';
import type { RevisionMetadataConfig } from '../shared/revision-metadata.ts';
import { revisionDependencyInput, type RevisionDependencyInput } from '../shared/revision-dependencies.ts';
import { initializeWikiConduit, parseWikiConduitCreateInput, parseWikiConduitEditInput, wikiConduitEffectiveText, wikiConduitInputHash } from './wiki-conduit.ts';
import type { WikiConduitMethod, WikiConduitReceipt } from '../shared/wiki-conduit.ts';
import { isDeepStrictEqual } from 'node:util';
import type { WikiDocumentSearchQuery, WikiContentSearchQuery, WikiDocumentSearchPage, WikiContentSearchPage, WikiDocumentIdentity, WikiContentIdentity } from '../shared/wiki-search.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializePaperBuilds } from './paper-builds.ts';
import { FileStore } from './files.ts';
import { migrateFiles } from './files-migration.ts';
import { PasteStore } from './pastes.ts';
import { migratePastes } from './pastes-migration.ts';
import type { PasteRecord } from '../shared/pastes.ts';
import { CitationEvidenceStore, initializeCitationEvidence } from './citation-evidence.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot, validateDocxSource } from '../shared/source-snapshot.ts';
import { parseTranscriptEditInput, validateTranscriptEditTarget, applyTranscriptTextEdit, transcriptSourceEdit, type TranscriptEditInput, type TranscriptSourceEdit } from '../shared/transcript-edit.ts';
import { DOCX_LIMITS, type DocxSource, type DocxProjection, type DocxFileIdentity, type DocxImportInput, type DocxReimportInput, type DocxReplaceInput, type DocxVersionPins } from '../shared/docx.ts';
import { createDocxPassageAnchor, validDocxPassageAnchor, DOCX_DISCUSSION_LIMITS, type DocxDiscussionExportInput, type DocxPackageComment, type DocxPassageAnchor } from '../shared/docx-discussion.ts';
import type { FileRecord, RevisionAsset } from '../shared/files.ts';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActorAttribution, Activity, AppState, PassageAnchor, Project, Repository, Revision, RevisionDetail, RevisionVersion, ReviewAnalysis, ReviewComment, ReviewRun, ReviewThread, ReviewThreadEvent, SourceFile, SuggestedReplacement, SuggestionApplication, Task, TaskDetail, TaskField, TaskFieldChange, TaskHistory, TaskReference, TaskSubscriptionPage, TaskSubscriptionState, TaskSubscriptionStatus, TaskTransaction, WikiDetail, WikiDocument, WikiHistory, WikiVersion, WikiVersionSummary } from '../shared/types.ts';
import { choice, files, HttpError, integer, object, optionalString, remoteUrl, string } from './validation.ts';
import { createCommentMentionProof, isStoredMentionProof, mentionRequestHash } from './mentions.ts';
import type { MentionProof } from '../shared/mentions.ts';
import { initializePolicies, registerDefaultPolicy, upgradeProjectPolicies } from './policy.ts';
import { initializeProjects, ProjectStore } from './projects.ts';
import { initializeProjectHierarchy, ancestorIds } from './project-graph.ts';
import { normalizeProjectTags } from '../shared/project-hierarchy.ts';
import type { ProjectChildPreview, ProjectKind, ProjectDetail, ProjectHistory, ProjectMembersPage, ProjectPreferences, ProjectWatchersPage } from '../shared/projects.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { applySuggestedReplacement, validateSuggestion } from '../shared/suggestions.ts';
import { GIT_LIMITS, isGitObjectId, type GitImportInput, type GitImportSnapshot, type GitSourceProvenance, type GitVersionImportInput } from '../shared/repositories.ts';
import { initializeWorkboards, WorkboardStore, type WorkboardVisibility } from './workboards.ts';
import type { TaskColumnMove, WorkboardBulkMovePreview, WorkboardBulkMoveQuery, WorkboardBulkMoveReceipt, WorkboardCardPage, WorkboardCardsQuery, WorkboardColumn, WorkboardDetail, WorkboardHistory, WorkboardImportPreview, WorkboardQuery, WorkboardReceipt } from '../shared/workboards.ts';
import { canonicalWikiPath, wikiAncestors, wikiReference, WIKI_WRITE_PATH_MAX_LENGTH, WIKI_CHILD_SCAN_LIMIT, type WikiLocation, type WikiChildren, type WikiAncestor, type WikiMoveInput, type WikiMoveReceipt, type WikiMoveProvenance, type WikiPublication, type WikiLifecyclePins, type WikiDraftInput, type WikiPublishInput, type WikiDeleteInput, type WikiLifecycleKind, type WikiLifecycleSnapshot, type WikiLifecycleTransaction, type WikiLifecycleHistory, type WikiLifecycleReceipt } from '../shared/wiki.ts';
import type { DiscussionPreferences, SetThreadPreferenceInput, ThreadPreference } from '../shared/discussion.ts';

type Entity = Project | Repository | Revision | Task | WikiDocument | FileRecord | PasteRecord;
type Kind = 'project' | 'repository' | 'revision' | 'task' | 'document' | 'file' | 'paste';
export interface MutationResponse { status: number; body: unknown }
export interface StoredResponse extends MutationResponse { fingerprint: string }
export interface StoreOptions { path?: string; revisionLifecycle?: Partial<RevisionLifecycleConfig>; revisionReviewers?: Partial<RevisionReviewerConfig>; revisionMetadata?: Partial<RevisionMetadataConfig> }
export interface MentionOptions { resolve: (objectId: string, username: string, actor: ActorAttribution) => { principalId: string; displayName: string } | null }
type JsonRow = { data: string };

export function parseRevisionDependencyInput(input: unknown): RevisionDependencyInput {
  try { return revisionDependencyInput(input); }
  catch { throw new HttpError(400, 'Choose parent or child revisions, 1–64 distinct changes, and exact relationship and access versions.'); }
}

export function threadPreferenceInput(input: unknown): SetThreadPreferenceInput {
  const data = object(input, ['collapsed', 'expectedVersion']);
  if (typeof data.collapsed !== 'boolean') throw new HttpError(400, 'collapsed must be a boolean.');
  if (typeof data.expectedVersion !== 'number' || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 0) throw new HttpError(400, 'expectedVersion must be a nonnegative safe integer.');
  return { collapsed: data.collapsed, expectedVersion: data.expectedVersion };
}

/** Public import metadata contains no source, policy, or provenance supplied by a client. */
function parseRevisionProjectCreation(input: { projectId?: unknown; projectIds?: unknown }): { projectId?: string | null; projectIds?: string[] } {
  try { return revisionProjectCreationInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid project tags.', 'REVISION_PROJECT_INVALID_INPUT'); }
}
export function gitImportInput(input: unknown): GitImportInput {
  const data = object(input, ['commitId', 'kind', 'title', 'summary', 'testPlan', 'projectId', 'projectIds', 'draft']);
  if (typeof data.commitId !== 'string' || !isGitObjectId(data.commitId)) throw new HttpError(400, 'Select a full lowercase commit object ID.', 'GIT_INVALID_QUERY');
  const tags = parseRevisionProjectCreation(data);
  if (data.draft !== undefined && typeof data.draft !== 'boolean') throw new HttpError(400, 'draft must be a boolean.');
  return { commitId: data.commitId, kind: choice(data.kind, 'kind', ['code', 'paper', 'document']), title: string(data.title, 'Title', 255, true), summary: optionalString(data.summary, 'Summary'), ...(data.testPlan === undefined ? {} : { testPlan: string(data.testPlan, 'Test plan', 100_000, true) }), ...tags, ...(data.draft === undefined ? {} : { draft: data.draft }) };
}

export function gitVersionImportInput(input: unknown): GitVersionImportInput {
  const data = object(input, ['commitId', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'message']);
  if (typeof data.commitId !== 'string' || !isGitObjectId(data.commitId)) throw new HttpError(400, 'Select a full lowercase commit object ID.', 'GIT_INVALID_QUERY');
  const expectedContentHash = string(data.expectedContentHash, 'Expected content hash', 64);
  if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new HttpError(400, 'Expected content hash must be a SHA-256 digest.');
  return { commitId: data.commitId, expectedVersion: integer(data.expectedVersion, 'expectedVersion'), expectedVersionId: string(data.expectedVersionId, 'Expected version ID', 100), expectedContentHash, message: string(data.message, 'Message', 10_000) };
}

const docxUnsupported = () => new HttpError(409, 'This operation does not support DOCX versions. Use the Word document workflow.', 'DOCX_OPERATION_UNSUPPORTED');
const docxMismatch = () => new HttpError(409, 'The immutable Word document source does not match.', 'DOCX_SOURCE_MISMATCH');
const docxPinKeys = ['expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch'];
function docxIdentity(value: unknown): DocxFileIdentity {
  const data = object(value, ['fileId', 'sha256', 'bytes']);
  if (typeof data.fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(data.fileId) || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new HttpError(400, 'Choose an exact uploaded File identity.');
  const bytes = integer(data.bytes, 'Source byte size');
  if (bytes > DOCX_LIMITS.compressedBytes) throw new HttpError(400, 'The DOCX package exceeds the supported byte limit.');
  return { fileId: data.fileId, sha256: data.sha256, bytes };
}
function docxPins(data: Record<string, unknown>): DocxVersionPins {
  const expectedContentHash = string(data.expectedContentHash, 'Expected content hash', 64);
  if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new HttpError(400, 'Expected content hash must be a SHA-256 digest.');
  return { expectedVersion: integer(data.expectedVersion, 'expectedVersion'), expectedVersionId: string(data.expectedVersionId, 'Expected version ID', 100), expectedContentHash, expectedAccessEpoch: integer(data.expectedAccessEpoch, 'expectedAccessEpoch') };
}
export function parseDocxVersionPins(input: unknown): DocxVersionPins { return docxPins(object(input, docxPinKeys)); }
export function parseDocxImportInput(input: unknown): DocxImportInput {
  const data = object(input, ['title', 'summary', 'testPlan', 'sourceFile', 'expectedAccessEpoch', 'shareSource', 'access', 'draft', 'projectId', 'projectIds']);
  if (typeof data.shareSource !== 'boolean') throw new HttpError(400, 'shareSource must be an explicit boolean.');
  if (data.draft !== undefined && typeof data.draft !== 'boolean') throw new HttpError(400, 'draft must be a boolean.');
  return { title: string(data.title, 'Title', 255, true), summary: optionalString(data.summary, 'Summary'), ...(data.testPlan === undefined ? {} : { testPlan: string(data.testPlan, 'Test plan', 100_000, true) }), ...parseRevisionProjectCreation(data), sourceFile: docxIdentity(data.sourceFile), expectedAccessEpoch: integer(data.expectedAccessEpoch, 'expectedAccessEpoch'), shareSource: data.shareSource, ...(data.access === undefined ? {} : { access: data.access as DocxImportInput['access'] }), ...(data.draft === undefined ? {} : { draft: data.draft }) };
}
export function parseDocxReimportInput(input: unknown): DocxReimportInput {
  const data = object(input, [...docxPinKeys, 'sourceFile', 'shareSource', 'message']);
  if (typeof data.shareSource !== 'boolean') throw new HttpError(400, 'shareSource must be an explicit boolean.');
  return { ...docxPins(data), sourceFile: docxIdentity(data.sourceFile), shareSource: data.shareSource, message: string(data.message, 'Message', 10_000) };
}
export function parseDocxReplaceInput(input: unknown): DocxReplaceInput {
  const data = object(input, [...docxPinKeys, 'rangeId', 'start', 'end', 'quote', 'replacement', 'message']);
  const quote = string(data.quote, 'Exact quote', DOCX_LIMITS.replacementLength, true), replacement = string(data.replacement, 'Replacement', DOCX_LIMITS.replacementLength, true);
  if (/[\uD800-\uDFFF]/u.test(quote) || /[\uD800-\uDFFF]/u.test(replacement)
    || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end) || (data.start as number) < 0 || (data.end as number) < (data.start as number)
    || (data.end as number) - (data.start as number) !== quote.length) throw new HttpError(400, 'Choose an exact UTF-16 range and replacement.');
  return { ...docxPins(data), rangeId: string(data.rangeId, 'Range ID', 2000), start: data.start as number, end: data.end as number, quote, replacement, message: string(data.message, 'Message', 10_000) };
}
/** Immutable mutation provenance binds receipts to the complete normalized request. */
export function docxOperationHash(input: DocxImportInput | DocxReimportInput | DocxReplaceInput): string {
  const normalized = 'replacement' in input ? parseDocxReplaceInput(input) : 'expectedVersion' in input ? parseDocxReimportInput(input) : parseDocxImportInput(input);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export function contentHash(sourceFiles: SourceFile[], assets: RevisionAsset[] = [], docx?: DocxSource): string {
  return createHash('sha256').update(sourceSnapshotCanonical(sourceFiles, assets, docx)).digest('hex');
}
export function transcriptEditInput(input: unknown): TranscriptEditInput {
  try { return parseTranscriptEditInput(input); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid transcript edit.', 'TRANSCRIPT_EDIT_INVALID'); }
}
export function transcriptEditInputHash(input: TranscriptEditInput): string {
  return createHash('sha256').update(JSON.stringify(transcriptEditInput(input))).digest('hex');
}
/** Only the literal replacement and server-authenticated attribution reach the Word engine. */
export function transcriptDocxReplacement(input: TranscriptEditInput): DocxReplaceInput {
  const data = transcriptEditInput(input);
  if (data.target.kind !== 'docx') throw new HttpError(400, 'Choose a supported Word passage.', 'TRANSCRIPT_EDIT_INVALID');
  const { kind: _kind, ...range } = data.target;
  return parseDocxReplaceInput({ expectedVersion: data.expectedVersion, expectedVersionId: data.expectedVersionId, expectedContentHash: data.expectedContentHash, expectedAccessEpoch: data.expectedAccessEpoch, ...range, replacement: data.replacement, message: data.message });
}

function wikiPath(input: unknown): string {
  try { return canonicalWikiPath(string(input, 'Wiki path', 512, true)); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid wiki path.'); }
}
export function parseWikiMoveInput(input: unknown): WikiMoveInput {
  const data = object(input, ['destinationPath', 'expectedVersion', 'expectedSourceVersionId', 'expectedDestinationId', 'expectedDestinationVersion', 'expectedAccessEpoch', 'expectedPublicationRevision', 'expectedPublishedVersionId', 'expectedDestinationPublicationRevision', 'expectedDestinationPublishedVersionId', 'message']);
  const destinationPath = wikiPath(data.destinationPath);
  if (data.expectedDestinationId !== null && (typeof data.expectedDestinationId !== 'string' || !/^W[1-9]\d{0,14}$/.test(data.expectedDestinationId))) throw new HttpError(400, 'Choose the exact destination identity, or null for a new path.');
  if (!Number.isSafeInteger(data.expectedDestinationVersion) || (data.expectedDestinationVersion as number) < 0 || (data.expectedDestinationId === null) !== (data.expectedDestinationVersion === 0)) throw new HttpError(400, 'Choose the exact destination version, or zero for a new path.');
  return { destinationPath, expectedVersion: integer(data.expectedVersion, 'expectedVersion'), expectedSourceVersionId: string(data.expectedSourceVersionId, 'Expected source version ID', 100), expectedDestinationId: data.expectedDestinationId as string | null, expectedDestinationVersion: data.expectedDestinationVersion as number, expectedAccessEpoch: integer(data.expectedAccessEpoch, 'expectedAccessEpoch'), ...(data.expectedPublicationRevision===undefined?{}:{expectedPublicationRevision:integer(data.expectedPublicationRevision,'expectedPublicationRevision')}), ...(data.expectedPublishedVersionId===undefined?{}:{expectedPublishedVersionId:string(data.expectedPublishedVersionId,'Expected published version ID',100)}), ...(data.expectedDestinationPublicationRevision===undefined?{}:{expectedDestinationPublicationRevision:integer(data.expectedDestinationPublicationRevision,'expectedDestinationPublicationRevision')}), ...(data.expectedDestinationPublishedVersionId===undefined?{}:{expectedDestinationPublishedVersionId:string(data.expectedDestinationPublishedVersionId,'Expected destination published version ID',100)}), message: optionalString(data.message, 'Message', 10_000) };
}
export function wikiMoveInputHash(input: WikiMoveInput): string { return createHash('sha256').update(JSON.stringify(parseWikiMoveInput(input))).digest('hex'); }

const wikiPinKeys=['expectedVersion','expectedHeadVersionId','expectedPublishedVersionId','expectedPublicationRevision','expectedAccessEpoch'];
function wikiPins(data:Record<string,unknown>):WikiLifecyclePins {
  return {expectedVersion:integer(data.expectedVersion,'expectedVersion'),expectedHeadVersionId:string(data.expectedHeadVersionId,'Expected head version ID',100),expectedPublishedVersionId:string(data.expectedPublishedVersionId,'Expected published version ID',100),expectedPublicationRevision:integer(data.expectedPublicationRevision,'expectedPublicationRevision'),expectedAccessEpoch:integer(data.expectedAccessEpoch,'expectedAccessEpoch')};
}
function optionalWikiPins(data:Record<string,unknown>):Partial<WikiLifecyclePins> {
  const result:Partial<WikiLifecyclePins>={};
  if(data.expectedVersion!==undefined)result.expectedVersion=integer(data.expectedVersion,'expectedVersion');
  if(data.expectedHeadVersionId!==undefined)result.expectedHeadVersionId=string(data.expectedHeadVersionId,'Expected head version ID',100);
  if(data.expectedPublishedVersionId!==undefined)result.expectedPublishedVersionId=string(data.expectedPublishedVersionId,'Expected published version ID',100);
  if(data.expectedPublicationRevision!==undefined)result.expectedPublicationRevision=integer(data.expectedPublicationRevision,'expectedPublicationRevision');
  if(data.expectedAccessEpoch!==undefined)result.expectedAccessEpoch=integer(data.expectedAccessEpoch,'expectedAccessEpoch');
  return result;
}
function wikiAuthoredContent(value:unknown):string {const content=string(value,'Content',500_000,true);if(content.length===0)throw new HttpError(400,'Documents must have content. Use Delete to remove a document.');return content;}
export function parseWikiDraftInput(input:unknown):WikiDraftInput {const data=object(input,[...wikiPinKeys,'title','content','message']);return {...wikiPins(data),title:string(data.title,'Title'),content:wikiAuthoredContent(data.content),message:optionalString(data.message,'Message',10_000)};}
export function parseWikiPublishInput(input:unknown):WikiPublishInput {const data=object(input,[...wikiPinKeys,'targetVersionId','message']);return {...wikiPins(data),targetVersionId:string(data.targetVersionId,'Target version ID',100),message:optionalString(data.message,'Message',10_000)};}
export function parseWikiDeleteInput(input:unknown):WikiDeleteInput {const data=object(input,[...wikiPinKeys,'message']);return {...wikiPins(data),message:optionalString(data.message,'Message',10_000)};}
export function parseWikiEditInput(input:unknown) {const data=object(input,[...wikiPinKeys,'title','slug','content','message']);return {...optionalWikiPins(data),title:string(data.title,'Title'),slug:wikiPath(data.slug),content:wikiAuthoredContent(data.content),message:optionalString(data.message,'Message',10_000,data.expectedVersion===undefined?'Initial version':'Updated document')};}
export function parseWikiRestoreInput(input:unknown) {const data=object(input,[...wikiPinKeys,'version','message']);const version=integer(data.version,'version');return {...optionalWikiPins(data),version,message:optionalString(data.message,'Message',10_000,`Restored content from version ${version}. Current slug retained.`)};}
export function wikiLifecycleInputHash(kind:'draft'|'publish'|'delete'|'edit'|'restore'|'create',input:unknown):string {
  const normalized=kind==='draft'?parseWikiDraftInput(input):kind==='publish'?parseWikiPublishInput(input):kind==='delete'?parseWikiDeleteInput(input):kind==='restore'?parseWikiRestoreInput(input):parseWikiEditInput(input);
  return createHash('sha256').update(JSON.stringify([kind,normalized])).digest('hex');
}

export class Store {
  readonly database: DatabaseSync;
  readonly fresh: boolean;
  readonly files: FileStore;
  readonly pastes: PasteStore;
  readonly citationEvidence: CitationEvidenceStore;
  readonly revisionDependencies: RevisionDependencyStore;
  readonly revisionStack: RevisionStackStore;
  readonly revisionAuthorship: RevisionAuthorshipStore;
  readonly revisionLifecycle: RevisionLifecycleStore;
  readonly revisionReviewers: RevisionReviewerStore;
  readonly revisionMetadata: RevisionMetadataStore;
  readonly reviewDrafts: ReviewDraftStore;
  readonly revisionViews: RevisionViewStore;
  readonly revisionSubscriptions: RevisionSubscriptionStore;
  readonly revisionProjects: RevisionProjectStore;
  readonly notifications: NotificationStore;
  readonly taskNotifications: TaskNotificationsStore;
  readonly objectSubscriptions: ObjectSubscriptionStore;
  private taskProjectsReady = false;
  private wikiLocationsReady = false;
  private wikiPublicationReady = false;
  private wikiSearch?:WikiSearchStore;
  private projects: ProjectStore;
  private workboards?: WorkboardStore;
  private mentions?: MentionOptions;
  private mentionRequestSha256?: string;
  constructor(options: StoreOptions = {}) {
    const path = options.path ?? '.data/phabricator.sqlite';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 36) { this.database.close(); throw new Error(`Database schema ${version} is newer than this application supports.`); }
    this.fresh = version === 0;
    if (version === 0) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX entities_kind ON entities(kind);
      CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data, '$.slug')) WHERE kind = 'document';
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX activity_object ON activity(object_id, sequence);
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    if (version < 2) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE wiki_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL CHECK(number > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id, number));
            CREATE TRIGGER wiki_versions_no_update BEFORE UPDATE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
            CREATE TRIGGER wiki_versions_no_delete BEFORE DELETE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
          `);
          // Schema 1 kept only the latest document. Preserve exactly that known
          // snapshot and version number; earlier edits and authors are unknown.
          for (const document of this.all<WikiDocument>('document')) this.saveWikiVersion(document, {
            kind: 'legacy', author: null, message: 'Latest content preserved from the previous storage format. Earlier history is unavailable.', restoredFrom: null,
          });
          this.database.exec('PRAGMA user_version = 2');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 4) {
      try { this.transaction(() => { initializePolicies(this.database); this.database.exec('PRAGMA user_version = 4'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 5) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE review_threads (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX review_threads_revision ON review_threads(revision_id);
            CREATE TABLE thread_events (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX thread_events_revision ON thread_events(revision_id);
            CREATE TRIGGER comments_no_update BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
            CREATE TRIGGER comments_no_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
            CREATE TRIGGER thread_events_no_update BEFORE UPDATE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
            CREATE TRIGGER thread_events_no_delete BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
          `);
          // Existing comments are already historical evidence. Only add their
          // thread records; never rewrite their JSON, anchors or attribution.
          for (const row of this.database.prepare('SELECT id, revision_id, data FROM comments ORDER BY rowid').all() as { id: string; revision_id: string; data: string }[]) {
            const comment = JSON.parse(row.data) as ReviewComment;
            const thread: ReviewThread = { id: row.id, revisionId: row.revision_id, rootCommentId: row.id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt };
            this.database.prepare('INSERT INTO review_threads (id, revision_id, root_comment_id, data) VALUES (?, ?, ?, ?)').run(thread.id, thread.revisionId, thread.rootCommentId, JSON.stringify(thread));
          }
          this.database.exec('PRAGMA user_version = 5');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 6) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE suggestion_applications (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), from_version_id TEXT NOT NULL REFERENCES versions(id), to_version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX suggestion_applications_revision ON suggestion_applications(revision_id);
            CREATE TRIGGER suggestion_applications_no_update BEFORE UPDATE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
            CREATE TRIGGER suggestion_applications_no_delete BEFORE DELETE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
            PRAGMA user_version = 6;
          `);
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 7) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_transactions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL CHECK(sequence > 0), task_version INTEGER NOT NULL CHECK(task_version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(task_id, sequence));
            CREATE TRIGGER task_transactions_no_update BEFORE UPDATE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
            CREATE TRIGGER task_transactions_no_delete BEFORE DELETE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
            CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES entities(id), dependency_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, dependency_id), CHECK(task_id <> dependency_id));
            CREATE INDEX task_dependencies_inverse ON task_dependencies(dependency_id, task_id);
          `);
          const migratedAt = new Date().toISOString();
          // Earlier schemas kept only the current task. Record an explicitly
          // unknown-author baseline at migration time, not invented edits.
          for (const old of this.all<Task>('task')) {
            const task = { ...old, version: 1 };
            this.save('task', task);
            this.appendTaskTransaction(task, { kind: 'legacy', snapshot: task }, undefined, migratedAt);
          }
          this.database.exec('PRAGMA user_version = 7');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 8) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_subscriptions (task_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('subscribed', 'unsubscribed')), version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL, PRIMARY KEY(task_id, principal_id));
            CREATE INDEX task_subscriptions_principal ON task_subscriptions(principal_id, state, task_id);
          `);
          for (const task of this.all<Task>('task')) {
            const row = this.database.prepare('SELECT data FROM task_transactions WHERE task_id = ? AND sequence = 1').get(task.id) as JsonRow | undefined;
            const created = row ? JSON.parse(row.data) as TaskTransaction : undefined;
            const attribution = created?.attribution;
            const authorId = created?.kind === 'create' && created.taskId === task.id && created.sequence === 1 && created.taskVersion === 1
              && created.snapshot?.id === task.id && created.snapshot.version === 1 && created.snapshot.createdAt === task.createdAt
              && attribution && typeof attribution.principalId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(attribution.principalId)
              && typeof attribution.displayName === 'string' && created.actor === attribution.displayName
              ? attribution.principalId : null;
            // New current fields do not rewrite historical snapshots, infer
            // prior assignment, or retroactively subscribe historical actors.
            this.save('task', { ...task, ownerId: null, authorId });
          }
          this.database.exec('PRAGMA user_version = 8');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 9) {
      try {
        this.transaction(() => {
          // Duplicate links retain historical relationships, not canonical
          // aliases. Existing tasks, history and replay bytes remain intact.
          this.database.exec(`
            CREATE TABLE task_duplicates (source_id TEXT NOT NULL REFERENCES entities(id), target_id TEXT NOT NULL REFERENCES entities(id), operation_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id));
            CREATE INDEX task_duplicates_target ON task_duplicates(target_id, source_id);
            CREATE TRIGGER task_duplicates_no_update BEFORE UPDATE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
            CREATE TRIGGER task_duplicates_no_delete BEFORE DELETE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
            PRAGMA user_version = 9;
          `);
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 10) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_projects (task_id TEXT NOT NULL REFERENCES entities(id), project_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, project_id));
            CREATE INDEX task_projects_project ON task_projects(project_id, task_id);
          `);
          // Canonical edges are new storage, not new edits. Leave all existing
          // entity, history and replay JSON exactly as it was recorded.
          const rows = this.database.prepare("SELECT id, data FROM entities WHERE kind = 'task'").all() as { id: string; data: string }[];
          for (const row of rows) {
            const old = JSON.parse(row.data) as { projectId?: unknown };
            if (old.projectId === null || old.projectId === undefined) continue;
            if (typeof old.projectId !== 'string' || !/^PROJ[1-9]\d*$/.test(old.projectId) || !this.database.prepare("SELECT 1 FROM entities WHERE id = ? AND kind = 'project'").get(old.projectId)) throw new Error(`Task ${row.id} has an invalid legacy project reference. Repair it before upgrading.`);
            this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(row.id, old.projectId);
          }
          this.database.exec('PRAGMA user_version = 10');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    this.taskProjectsReady = true;
    if (version < 11) {
      try { this.transaction(() => { initializeProjects(this.database); upgradeProjectPolicies(this.database); this.database.exec('PRAGMA user_version = 11'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 12) {
      try { this.transaction(() => { initializeProjectHierarchy(this.database); this.database.exec('PRAGMA user_version = 12'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 13) {
      try { this.transaction(() => { initializeWorkboards(this.database); this.database.exec('PRAGMA user_version = 13'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 14) {
      try {
        this.transaction(() => {
          // Personal presentation state has no historical backfill and never
          // rewrites shared threads, source, review evidence or saved receipts.
          this.database.exec(`
            CREATE TABLE thread_preferences (thread_id TEXT NOT NULL REFERENCES review_threads(id), principal_id TEXT NOT NULL, collapsed INTEGER NOT NULL CHECK(collapsed IN (0, 1)), version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991), updated_at TEXT NOT NULL, PRIMARY KEY(thread_id, principal_id));
          `);
          this.database.exec('PRAGMA user_version = 14');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 15) {
      try { this.transaction(() => { initializePaperBuilds(this.database); this.database.exec('PRAGMA user_version = 15'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 16) {
      try { migrateFiles(this.database); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 17) {
      try { this.transaction(() => { initializeCitationEvidence(this.database); this.database.exec('PRAGMA user_version = 17'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 18) {
      try { migratePastes(this.database); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 19) {
      try { this.transaction(() => {
        this.database.exec(`
          CREATE TABLE revision_docx_packages (version_id TEXT PRIMARY KEY REFERENCES versions(id), sha256 TEXT NOT NULL CHECK(length(sha256)=64), byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=16777216), data BLOB NOT NULL CHECK(length(data)=byte_size));
          CREATE TRIGGER revision_docx_packages_no_update BEFORE UPDATE ON revision_docx_packages BEGIN SELECT RAISE(ABORT, 'DOCX packages are immutable'); END;
          CREATE TRIGGER revision_docx_packages_no_delete BEFORE DELETE ON revision_docx_packages BEGIN SELECT RAISE(ABORT, 'DOCX packages are immutable'); END;
          CREATE TRIGGER docx_versions_no_update BEFORE UPDATE ON versions WHEN json_type(OLD.data,'$.docx') IS NOT NULL OR json_type(NEW.data,'$.docx') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'DOCX versions are immutable'); END;
          CREATE TRIGGER docx_versions_no_delete BEFORE DELETE ON versions WHEN json_type(OLD.data,'$.docx') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'DOCX versions are immutable'); END;
          PRAGMA user_version = 19;
        `);
      }); } catch (error) { this.database.close(); throw error; }
    }
    if (version < 20) {
      try { this.transaction(() => {
        this.database.exec(`CREATE TABLE wiki_locations (document_id TEXT PRIMARY KEY REFERENCES entities(id), path TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','moved','deleted','stub')), moved_to_id TEXT REFERENCES entities(id), CHECK((status='moved')=(moved_to_id IS NOT NULL)));`);
        const insert = this.database.prepare("INSERT INTO wiki_locations(document_id,path,status,moved_to_id) VALUES (?,?,'active',NULL)");
        for (const row of this.database.prepare("SELECT id,json_extract(data,'$.slug') AS slug FROM entities WHERE kind='document' ORDER BY rowid").all() as {id:string;slug:string}[]) insert.run(row.id, canonicalWikiPath(row.slug));
        this.database.exec(`CREATE TABLE wiki_cursor_secret (singleton INTEGER PRIMARY KEY CHECK(singleton=1), key BLOB NOT NULL CHECK(length(key)=32));
          CREATE TRIGGER wiki_cursor_secret_no_update BEFORE UPDATE ON wiki_cursor_secret BEGIN SELECT RAISE(ABORT,'Wiki cursor keys are immutable'); END;
          CREATE TRIGGER wiki_cursor_secret_no_delete BEFORE DELETE ON wiki_cursor_secret BEGIN SELECT RAISE(ABORT,'Wiki cursor keys are immutable'); END;`);
        this.database.prepare('INSERT INTO wiki_cursor_secret(singleton,key) VALUES (1,?)').run(randomBytes(32));
        this.database.exec('PRAGMA user_version = 20');
      }); } catch (error) { this.database.close(); throw error; }
    }
    if(version<21) {
      try{this.transaction(()=>{
        this.database.exec(`CREATE TABLE wiki_publication(document_id TEXT PRIMARY KEY REFERENCES entities(id),revision INTEGER NOT NULL CHECK(revision>0),head_version_id TEXT NOT NULL REFERENCES wiki_versions(id),published_version_id TEXT NOT NULL REFERENCES wiki_versions(id));
          CREATE TABLE wiki_transactions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(document_id,sequence));
          CREATE TRIGGER wiki_transactions_no_update BEFORE UPDATE ON wiki_transactions BEGIN SELECT RAISE(ABORT,'Wiki lifecycle transactions are immutable'); END;
          CREATE TRIGGER wiki_transactions_no_delete BEFORE DELETE ON wiki_transactions BEGIN SELECT RAISE(ABORT,'Wiki lifecycle transactions are immutable'); END;`);
        for(const row of this.database.prepare("SELECT data FROM entities WHERE kind='document' ORDER BY rowid").all() as JsonRow[]) {
          const document=JSON.parse(row.data) as WikiDocument;
          const head=this.database.prepare('SELECT id FROM wiki_versions WHERE document_id=? AND number=?').get(document.id,document.version) as {id:string}|undefined;
          if(!head)throw new Error('Wiki migration requires the exact existing document head.');
          const publication:WikiPublication={revision:document.version,headVersion:document.version,headVersionId:head.id,publishedVersion:document.version,publishedVersionId:head.id};
          this.database.prepare('INSERT INTO wiki_publication VALUES(?,?,?,?)').run(document.id,publication.revision,head.id,head.id);
          const transaction:WikiLifecycleTransaction={id:randomUUID(),documentId:document.id,sequence:publication.revision,kind:'legacy',actor:null,createdAt:document.updatedAt,message:'Publication state preserved from the previous storage format. Earlier lifecycle transactions are unavailable.',inputSha256:null,before:null,after:{publication,location:this.documentLocation(document.id),updatedAt:document.updatedAt},newVersionId:null};
          this.database.prepare('INSERT INTO wiki_transactions VALUES(?,?,?,?)').run(transaction.id,document.id,transaction.sequence,JSON.stringify(transaction));
        }
        this.database.exec('PRAGMA user_version = 21');
      });}catch(error){this.database.close();throw error;}
    }
    if(version<22){try{this.transaction(()=>{initializeWikiSearch(this.database);this.database.exec('PRAGMA user_version = 22');});}catch(error){this.database.close();throw error;}}
    if(version<23){try{this.transaction(()=>{initializeWikiConduit(this.database);this.database.exec('PRAGMA user_version = 23');});}catch(error){this.database.close();throw error;}}
    if (version < 24) {
      try { this.transaction(() => { initializeRevisionDependencies(this.database); this.database.exec('PRAGMA user_version = 24'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 25) {
      try { this.transaction(() => { initializeRevisionAuthorship(this.database); this.database.exec('PRAGMA user_version = 25'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 26) {
      try { this.transaction(() => { initializeRevisionLifecycle(this.database); this.database.exec('PRAGMA user_version = 26'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 27) {
      try { this.transaction(() => { initializeRevisionReviewers(this.database); this.database.exec('PRAGMA user_version = 27'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 28) {
      try { this.transaction(() => { initializeRevisionMetadata(this.database); this.database.exec('PRAGMA user_version = 28'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 29) {
      try { this.transaction(() => { initializeRevisionSubscriptions(this.database); this.database.exec('PRAGMA user_version = 29'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 30) {
      try { this.transaction(() => { initializeRevisionProjects(this.database); this.database.exec('PRAGMA user_version = 30'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 31) {
      try { this.transaction(() => { initializeNotifications(this.database); this.database.exec('PRAGMA user_version = 31'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 32) {
      try { this.transaction(() => { initializeNotificationTargets(this.database); initializeTaskNotifications(this.database); this.database.exec('PRAGMA user_version = 32'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 33) {
      try { this.transaction(() => { initializeNotificationTargets(this.database); initializeObjectSubscriptions(this.database); this.database.exec('PRAGMA user_version = 33'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    // Format fence only: older binaries cannot interpret mention-caused history.
    if (version < 34) {
      try { this.transaction(() => this.database.exec('PRAGMA user_version = 34')); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 35) {
      try { this.transaction(() => { initializeReviewDrafts(this.database); this.database.exec('PRAGMA user_version = 35'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 36) {
      try { this.transaction(() => { initializeRevisionViews(this.database); this.database.exec('PRAGMA user_version = 36'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    this.revisionViews = new RevisionViewStore(this.database);
    this.objectSubscriptions = new ObjectSubscriptionStore(this.database);
    this.taskNotifications = new TaskNotificationsStore(this.database);
    this.revisionProjects = new RevisionProjectStore(this.database);
    this.revisionMetadata = new RevisionMetadataStore(this.database, options.revisionMetadata);
    this.revisionLifecycle = new RevisionLifecycleStore(this.database, options.revisionLifecycle);
    this.revisionReviewers = new RevisionReviewerStore(this.database, this.revisionLifecycle, options.revisionReviewers);
    this.revisionLifecycle.connectReviewers(this.revisionReviewers);
    this.revisionAuthorship = new RevisionAuthorshipStore(this.database, this.revisionLifecycle.config.closeOnAccept, (id, previous, author, actor, operationId) => this.revisionReviewers.authorChanged(id, previous, author, actor, operationId));
    this.revisionSubscriptions = new RevisionSubscriptionStore(this.database, this.revisionAuthorship, this.revisionReviewers);
    this.notifications = new NotificationStore(this.database, {
      revision: id => {
        const row = this.database.prepare("SELECT json_extract(data,'$.kind') AS kind FROM entities WHERE id=? AND kind='revision'").get(id) as { kind: Revision['kind'] } | undefined;
        if (!row || !['code', 'paper', 'document'].includes(row.kind)) throw new HttpError(404, 'Revision is unavailable.', 'OBJECT_UNAVAILABLE');
        return { title: this.revisionMetadata.state(id).title, kind: row.kind, head: this.revisionAuthorship.snapshot(id).head, broadcast: this.revisionLifecycle.state(id).reviewStarted };
      },
      task: id => { const task = this.get<Task>('task', id); return { title: task.title, version: task.version }; },
      wiki: id => { const document = this.get<WikiDocument>('document', id); return { title: document.title, context: this.wikiNotificationContext(document.publication!) }; },
      paste: id => { const paste = this.pastes.get(id); return { title: paste.title, context: { kind: 'paste', pasteVersion: paste.version, contentVersion: paste.contentVersion, contentHash: paste.contentHash } }; },
      recipients: id => {
        if (/^(?:W|PA)[1-9]\d{0,14}$/.test(id)) return this.objectSubscriptions.deliveryPreferences(id);
        const task = id.startsWith('T') ? this.get<Task>('task', id) : null;
        const projects = new Set<string>(), watchers = new Set<string>(); let scanned = 0;
        for (const tag of task?.projectIds ?? this.revisionProjects.state(id).projectIds) for (const project of [tag, ...ancestorIds(this.database, tag)]) projects.add(project);
        for (const project of projects) {
          const rows = this.database.prepare("SELECT principal_id FROM project_relations WHERE project_id=? AND relation='watcher' AND active=1 LIMIT ?").all(project, NOTIFICATION_LIMITS.projectRows - scanned + 1) as { principal_id: string }[];
          scanned += rows.length; if (scanned > NOTIFICATION_LIMITS.projectRows) throw new HttpError(422, 'Project watcher routing exceeds the complete notification limit.', 'NOTIFICATION_LIMIT');
          for (const row of rows) watchers.add(row.principal_id);
        }
        // Upstream watcher routing overrides project silence; object mute still wins.
        if (task) {
          const rows = this.database.prepare("SELECT principal_id FROM task_subscriptions WHERE task_id=? AND state='subscribed' ORDER BY principal_id LIMIT ?").all(id, NOTIFICATION_LIMITS.recipients + 1) as { principal_id: string }[];
          if (rows.length > NOTIFICATION_LIMITS.recipients) throw new HttpError(422, 'Task follower routing exceeds the complete notification limit.', 'NOTIFICATION_LIMIT');
          return { recipients: [...rows.map(row => row.principal_id), ...(task.ownerId ? [task.ownerId] : []), ...watchers], muted: this.taskNotifications.mutedPeople(id) };
        }
        return this.revisionSubscriptions.deliveryPreferences(id, [...watchers]);
      },
    });
    for (const domain of [this.revisionProjects, this.revisionMetadata, this.revisionAuthorship, this.revisionLifecycle, this.revisionReviewers, this.revisionSubscriptions, this.objectSubscriptions]) domain.connectNotifications(this.notifications.emit);
    this.reviewDrafts = new ReviewDraftStore(this.database, {
      head: id => this.revisionAuthorship.snapshot(id).head,
      title: id => this.revisionMetadata.state(id).title,
      threadVersion: (id, threadId) => this.thread(id, threadId).version,
      validate: (id, payload) => this.validatePrivateReviewPayload(id, payload),
      publish: (id, payload, actor) => payload.kind === 'reply'
        ? this.createReply(id, payload.threadId, { body: payload.body, viewedVersionId: payload.viewedVersionId }, actor)
        : this.createComment(id, this.privateReviewCommentInput(payload), actor),
      batch: (work, requestSha256) => {
        const previous = this.mentionRequestSha256; this.mentionRequestSha256 = requestSha256;
        try { return this.notifications.batch(work); } finally { this.mentionRequestSha256 = previous; }
      },
    });
    this.revisionDependencies = new RevisionDependencyStore(this.database, id => this.revisionMetadata.state(id));
    this.revisionStack = new RevisionStackStore(this.database, id => this.revisionMetadata.state(id), this.revisionLifecycle.config.closeOnAccept);
    this.wikiSearch=new WikiSearchStore(this.database);
    this.wikiPublicationReady = true;
    this.wikiLocationsReady = true;
    this.pastes = new PasteStore(this.database, {
      nextId: () => this.nextId('paste', 'PA'), event: (id, action, detail, actor) => this.event(id, action, detail, actor),
      batch: work => this.notifications.batch(work),
      mentions: (id, body, actor) => this.commentMentions(id, body, actor),
      notify: transaction => {
        if (transaction.kind === 'comment') { this.objectSubscriptions.mentioned(transaction); this.objectSubscriptions.implicitComment(transaction); }
        const status = transaction.changes?.find(change => change.field === 'status');
        const kind: NotificationKind = transaction.kind === 'create' ? 'created' : transaction.kind === 'comment' ? 'paste_commented' : status ? status.newValue === 'archived' ? 'paste_archived' : 'paste_reactivated' : 'paste_updated';
        this.notifications.emit({ objectId: transaction.pasteId, kind, cause: { type: 'paste_transaction', id: transaction.id }, attribution: transaction.attribution, createdAt: transaction.createdAt,
          context: { kind: 'paste', pasteVersion: transaction.pasteVersion, contentVersion: transaction.contentVersion, contentHash: transaction.contentHash } });
      },
    });
    this.files = new FileStore(this.database);
    this.citationEvidence = new CitationEvidenceStore(this.database, this.files);
    this.workboards = new WorkboardStore(this.database, { project: id => this.projects.get(id), task: id => this.get<Task>('task', id), nextColumnId: () => this.nextId('workboard_column', 'COL'), normalizeTags: ids => this.normalizeTaskProjectIds(ids), moveTask: (task, ids, move, attribution, now, operationId) => this.writeTaskWorkboardChange(task, ids, move, attribution, now, operationId) });
    this.projects = new ProjectStore(this.database, { nextId: () => this.nextId('project', 'PROJ'), event: (id, action, detail, attribution) => this.event(id, action, detail, attribution), activities: id => this.activities(id), changed: (project, created, attribution) => this.workboards!.projectChanged(project, created, attribution) });
  }

  close(): void { this.database.close(); }
  configureMentions(options: MentionOptions): void {
    if (this.mentions) throw new Error('Mention resolution is already configured.');
    this.mentions = options;
  }
  private commentMentions(id: string, body: string, actor?: ActorAttribution): MentionProof | undefined {
    if (!this.mentions || !actor) return undefined;
    try { return createCommentMentionProof(body, username => this.mentions!.resolve(id, username, actor), this.mentionRequestSha256); }
    catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message, 'MENTION_LIMIT'); throw error; }
  }
  read<T>(work: () => T): T {
    this.database.exec('SAVEPOINT read_snapshot');
    try { const result = work(); this.database.exec('RELEASE read_snapshot'); return result; }
    catch (error) { this.database.exec('ROLLBACK TO read_snapshot; RELEASE read_snapshot'); throw error; }
  }
  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  mutate(key: string | undefined, fingerprint: string, work: () => MutationResponse, authorize?: () => void, present?: (response: MutationResponse, replayed: boolean) => MutationResponse): MutationResponse {
    return this.transaction(() => this.notifications.batch(() => {
      // Credential revocation in another process may commit while BEGIN waits.
      // Check authority after acquiring the write lock and before replay/writes.
      authorize?.();
      if (key) {
        const existing = this.replay(key, fingerprint);
        if (existing) return present ? present(existing, true) : existing;
      }
      const previousMentionRequestSha256 = this.mentionRequestSha256;
      let response: MutationResponse;
      this.mentionRequestSha256 = mentionRequestHash(key, fingerprint);
      try { response = work(); }
      finally { this.mentionRequestSha256 = previousMentionRequestSha256; }
      this.notifications.flush();
      if (key) {
        this.revisionProjects.captureResponse(key, fingerprint, response);
        this.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(key, fingerprint, response.status, JSON.stringify(response.body), new Date().toISOString());
      }
      return present ? present(response, false) : response;
    }));
  }
  replay(key: string, fingerprint: string): MutationResponse | undefined {
    const row = this.database.prepare('SELECT fingerprint, status, body FROM idempotency WHERE key = ?').get(key) as { fingerprint: string; status: number; body: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, 'This idempotency key was already used for a different request.');
    const response = { status: row.status, body: JSON.parse(row.body) as unknown };
    this.revisionProjects.verifyResponse(key, fingerprint, response);
    return response;
  }
  private nextId(name: string, prefix: string): string {
    const row = this.database.prepare('INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value').get(name) as { value: number };
    return `${prefix}${row.value}`;
  }
  private get<T extends Entity>(kind: Kind, id: string): T {
    if (kind === 'project' && this.projects) return this.projects.get(id) as T;
    const row = this.database.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id) as JsonRow | undefined;
    if (!row) throw new HttpError(404, `${kind} ${id} was not found.`);
    const value = JSON.parse(row.data) as T;
    if (kind === 'document' && this.wikiLocationsReady) return this.hydrateDocument(value as WikiDocument) as T;
    if (kind === 'revision' && this.revisionAuthorship) return this.hydrateRevision(value as Revision) as T;
    return kind === 'task' && this.taskProjectsReady ? this.hydrateTask(value as Task) as T : value;
  }
  private all<T extends Entity>(kind: Kind): T[] {
    if (kind === 'project' && this.projects) return this.projects.all() as T[];
    const values = (this.database.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC').all(kind) as JsonRow[]).map(row => JSON.parse(row.data) as T);
    if (kind === 'document' && this.wikiLocationsReady) return values.map(value => this.hydrateDocument(value as WikiDocument) as T);
    if (kind === 'revision' && this.revisionAuthorship) return values.map(value => this.hydrateRevision(value as Revision) as T);
    if (kind !== 'task' || !this.taskProjectsReady) return values;
    const projects = new Map<string, string[]>();
    for (const row of this.database.prepare('SELECT task_id, project_id FROM task_projects ORDER BY task_id, project_id').all() as { task_id: string; project_id: string }[]) {
      const ids = projects.get(row.task_id) ?? []; ids.push(row.project_id); projects.set(row.task_id, ids);
    }
    return values.map(value => this.hydrateTask(value as Task, projects.get(value.id) ?? []) as T);
  }
  private hydrateTask(value: Task, projectIds?: string[]): Task {
    const { projectId: _legacyProjectId, projectIds: _oldProjectIds, ...metadata } = value as Task & { projectId?: unknown };
    return { ...metadata, projectIds: projectIds ?? (this.database.prepare('SELECT project_id FROM task_projects WHERE task_id = ? ORDER BY project_id').all(value.id) as { project_id: string }[]).map(row => row.project_id) };
  }
  private save(kind: Kind, value: Entity): void {
    let metadata: Entity | Omit<Task, 'projectIds'> = value;
    if (kind === 'task' && this.taskProjectsReady) {
      const { projectId: _legacyProjectId, projectIds: _projectIds, ...rest } = value as Task & { projectId?: unknown };
      metadata = rest;
    }
    if (kind === 'document') { const { location: _location, publication: _publication, ...rest } = value as WikiDocument; metadata = rest; }
    if (kind === 'revision') {
      const { authorId: _authorId, authorVersion: _authorVersion, authorDisplayName: _authorDisplayName, lifecycleVersion: _lifecycleVersion, reviewerVersion: _reviewerVersion, metadataVersion: _metadataVersion, testPlan: _testPlan, projectIds: _projectIds, projectVersion: _projectVersion, ...rest } = value as Revision;
      // Existing writers update source/status through this helper. Metadata is
      // authoritative in its sidecar; never copy a hydrated edit back over the
      // original entity fields retained for historical receipt compatibility.
      const old = this.database.prepare("SELECT data FROM entities WHERE id=? AND kind='revision'").get(value.id) as JsonRow | undefined;
      const original = old ? JSON.parse(old.data) as Revision : null;
      metadata = original ? { ...rest, title: original.title, summary: original.summary, projectId: original.projectId, ...(Object.hasOwn(original, 'testPlan') ? { testPlan: original.testPlan } : {}) } : rest;
    }
    const json = JSON.stringify(metadata);
    const created = this.database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(value.id, kind, json);
    if (created.changes) { registerDefaultPolicy(this.database, value.id); if(kind==='document')this.wikiSearch?.ensureDocument(value.id); }
    else this.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(json, value.id);
    if (kind === 'task') this.workboards?.touchTask(value as Task);
  }
  private hydrateRevision(value: Revision): Revision {
    const state = this.revisionAuthorship.state(value.id);
    const metadata = this.revisionMetadata.state(value.id), tags = this.revisionProjects.state(value.id);
    return { ...value, projectIds: tags.projectIds, projectVersion: tags.version, projectId: tags.projectIds[0] ?? null, title: metadata.title, summary: metadata.summary, testPlan: metadata.testPlan, metadataVersion: metadata.version, ...(metadata.updatedAt && metadata.updatedAt > value.updatedAt ? { updatedAt: metadata.updatedAt } : {}), authorId: state.author?.principalId ?? null, authorDisplayName: state.author?.displayName ?? null, authorVersion: state.version, lifecycleVersion: this.revisionLifecycle.state(value.id).version, reviewerVersion: this.revisionReviewers.state(value.id).version };
  }
  private reference(value: unknown, kind: 'project' | 'repository'): string | null {
    if (value === null || value === undefined) return null;
    const id = string(value, `${kind} ID`, 50);
    try { this.get(kind, id); } catch { throw new HttpError(400, `Unknown ${kind}: ${id}.`); }
    return id;
  }
  event(objectId: string, action: string, detail: string, attribution?: ActorAttribution): void {
    const value: Activity = { id: randomUUID(), objectId, actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), action, detail, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO activity (id, object_id, data) VALUES (?, ?, ?)').run(value.id, objectId, JSON.stringify(value));
  }
  activities(objectId?: string, visible?: (id: string) => boolean): Activity[] {
    const rows = objectId
      ? this.database.prepare('SELECT data FROM activity WHERE object_id = ? ORDER BY sequence DESC LIMIT 200').all(objectId)
      : this.database.prepare(`SELECT data FROM activity ORDER BY sequence DESC${visible ? '' : ' LIMIT 200'}`).all();
    return (rows as JsonRow[]).map(row => JSON.parse(row.data) as Activity).filter(item => !visible || visible(item.objectId)).slice(0, 200);
  }
  state(ai: AppState['ai'], mode: AppState['mode'] = 'local-single-user'): AppState {
    return { revisionMetadataConfig: { ...this.revisionMetadata.config, configId: this.revisionMetadata.configId }, pastes: this.all('paste'), files: this.all('file'), projects: this.all('project'), repositories: this.all('repository'), revisions: this.all('revision'), tasks: this.all('task'), documents: this.all('document'), activity: this.activities(), spaces: [], access: {}, principals: [], currentPrincipalId: '', followingTaskIds: [], joinedProjectIds: [], watchingProjectIds: [], accessEpoch: 0, canCreate: false, ai, mode };
  }
  createProject(input: unknown, attribution?: ActorAttribution): Project {
    return this.projects.create(input, attribution);
  }
  getProject(id: string): Project { return this.projects.get(id); }
  getRepository(id: string): Repository { return this.get<Repository>('repository', id); }
  workboard(id: string, query: WorkboardQuery = {}, visibility?: WorkboardVisibility): WorkboardDetail { return this.workboards!.detail(id, query, visibility); }
  workboardCards(id: string, columnId: string, query: WorkboardCardsQuery, visibility?: WorkboardVisibility): WorkboardCardPage { return this.workboards!.cards(id, columnId, query, visibility); }
  workboardHistory(id: string, before?: number, limit = 50, visible?: (id: string) => boolean): WorkboardHistory { return this.workboards!.history(id, before, limit, visible); }
  workboardColumn(id: string, columnId: string): WorkboardColumn { return this.workboards!.column(id, columnId); }
  workboardImportPreview(targetId: string, sourceId: string): WorkboardImportPreview { return this.workboards!.importPreview(targetId, sourceId); }
  importWorkboardColumns(targetId: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.workboards!.importColumns(targetId, input, attribution); }
  workboardBulkMovePreview(sourceId: string, query: WorkboardBulkMoveQuery, visibility?: WorkboardVisibility): WorkboardBulkMovePreview { return this.workboards!.bulkMovePreview(sourceId, query, visibility); }
  bulkMoveWorkboardCards(sourceId: string, input: unknown, attribution?: ActorAttribution): WorkboardBulkMoveReceipt { return this.taskMutation(() => this.workboards!.bulkMoveCards(sourceId, input, attribution)); }
  configureWorkboard(id: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.workboards!.configure(id, input, attribution); }
  createWorkboardColumn(id: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.workboards!.createColumn(id, input, attribution); }
  updateWorkboardColumn(id: string, columnId: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.workboards!.updateColumn(id, columnId, input, attribution); }
  reorderWorkboardColumn(id: string, columnId: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.workboards!.reorderColumn(id, columnId, input, attribution); }
  moveWorkboardCard(id: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt { return this.taskMutation(() => this.workboards!.moveCard(id, input, attribution)); }
  projectDetail(id: string, viewerId: string): ProjectDetail { return this.projects.detail(id, viewerId); }
  projectChildPreview(id: string, kind: ProjectKind): ProjectChildPreview { return this.projects.childPreview(id, kind); }
  projectHistory(id: string, before?: number, limit?: number, visible?: (id: string) => boolean): ProjectHistory { return this.projects.history(id, before, limit, visible); }
  projectMembers(id: string, viewerId: string, after?: string, limit?: number): ProjectMembersPage { return this.projects.members(id, viewerId, after, limit); }
  projectWatchers(id: string, viewerId: string, after?: string, limit?: number): ProjectWatchersPage { return this.projects.watchers(id, viewerId, after, limit); }
  projectPreferences(id: string, viewerId: string): ProjectPreferences { return this.projects.preferences(id, viewerId); }
  updateProject(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail { return this.projects.update(id, input, attribution); }
  updateProjectMembers(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail { return this.projects.updateMembers(id, input, attribution); }
  updateProjectMembership(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail { return this.projects.updateMembership(id, input, attribution); }
  updateProjectWatcher(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail { return this.projects.updateWatcher(id, input, attribution); }
  updateProjectSilence(id: string, input: unknown, attribution: ActorAttribution): ProjectPreferences { return this.projects.updateSilence(id, input, attribution); }
  transferLocalProjectMemberships(fromId: string, toId: string, attribution: ActorAttribution): number { return this.projects.transferMemberships(fromId, toId, attribution); }
  createRepository(input: unknown, attribution?: ActorAttribution): Repository {
    const data = object(input, ['name', 'remoteUrl', 'description', 'defaultBranch']);
    const repository: Repository = { id: this.nextId('repository', 'R'), name: string(data.name, 'Name'), remoteUrl: remoteUrl(data.remoteUrl), description: optionalString(data.description, 'Description'), defaultBranch: data.defaultBranch === undefined ? 'main' : string(data.defaultBranch, 'Default branch') };
    this.save('repository', repository); this.event(repository.id, 'registered', `Registered ${repository.name}; no remote content fetched.`, attribution); return repository;
  }
  private taskMutation<T>(work: () => T): T {
    this.database.exec('SAVEPOINT task_write');
    try {
      // Lock before loading task versions or traversing the dependency graph.
      this.database.prepare("UPDATE sequences SET value = value WHERE name = 'task'").run();
      const result = this.notifications.batch(() => this.workboards ? this.workboards.batch(work) : work()); this.database.exec('RELEASE task_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO task_write; RELEASE task_write'); throw error; }
  }
  private advanceTask(task: Task, now: string): Task {
    if (!Number.isSafeInteger(task.version) || task.version < 1 || !Number.isSafeInteger(task.version + 1)) throw new HttpError(409, 'This task has reached the supported version limit.');
    return { ...task, version: task.version + 1, updatedAt: now };
  }
  private appendTaskTransaction(task: Task, data: Pick<TaskTransaction, 'kind' | 'snapshot' | 'changes' | 'comment' | 'mentions' | 'dependency' | 'dependencyStatus' | 'subscription' | 'merge' | 'project' | 'column'>, attribution?: ActorAttribution, now = new Date().toISOString()): TaskTransaction {
    const last = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_transactions WHERE task_id = ?').get(task.id) as { sequence: number };
    const sequence = last.sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new HttpError(409, 'This task has reached the supported history limit.');
    const transaction: TaskTransaction = { id: randomUUID(), taskId: task.id, sequence, taskVersion: task.version, actor: data.kind === 'legacy' ? null : attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: now, ...data };
    this.database.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, task.id, sequence, task.version, JSON.stringify(transaction));
    return transaction;
  }
  createTask(input: unknown, attribution?: ActorAttribution): Task { return this.taskMutation(() => this.writeTask(input, undefined, attribution)); }
  updateTask(id: string, input: unknown, attribution?: ActorAttribution): Task { return this.taskMutation(() => this.writeTask(input, this.get<Task>('task', id), attribution)); }
  /** Explicit operator handoff; original attribution and preferences stay historical. */
  transferTaskOwners(fromId: string, toId: string, attribution: ActorAttribution): number {
    this.taskPrincipal(fromId); this.taskPrincipal(toId);
    return this.taskMutation(() => {
      if (fromId === toId) return 0;
      const rows = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ? ORDER BY id").all(fromId) as JsonRow[];
      for (const row of rows) {
        const task = this.hydrateTask(JSON.parse(row.data) as Task);
        this.updateTask(task.id, { expectedVersion: task.version, ownerId: toId }, attribution);
      }
      return rows.length;
    });
  }
  /** Explicit terminal handoff of current revision ownership, preserving source attribution. */
  transferLocalRevisionAuthors(fromId: string, toId: string, attribution: ActorAttribution): number {
    this.taskPrincipal(fromId); this.taskPrincipal(toId);
    return this.discussionMutation(() => {
      if (fromId === toId) return 0;
      const account = this.database.prepare('SELECT display_name FROM auth_accounts WHERE id = ? AND disabled = 0').get(toId) as { display_name: string } | undefined;
      if (!account) throw new HttpError(404, 'Active account not found.');
      const rows = this.database.prepare('SELECT revision_id FROM revision_authorship WHERE author_id = ? ORDER BY revision_id').all(fromId) as { revision_id: string }[];
      for (const row of rows) {
        const { authorship, head, reviewerVersion, lifecycleVersion } = this.revisionAuthorship.snapshot(row.revision_id);
        const epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value;
        this.revisionAuthorship.mutate(row.revision_id, { action: 'assign', authorId: toId, expectedAuthorVersion: authorship.version, expectedVersion: head.number, expectedVersionId: head.versionId, expectedContentHash: head.contentHash, expectedAccessEpoch: epoch, expectedReviewerVersion: reviewerVersion, expectedLifecycleVersion: lifecycleVersion, message: 'A terminal operator transferred local-only revision ownership to a workspace account.' }, attribution, { principalId: toId, displayName: account.display_name });
      }
      return rows.length;
    });
  }
  private writeTask(input: unknown, current?: Task, attribution?: ActorAttribution): Task {
    const fields: Exclude<TaskField, 'projectId'>[] = ['title', 'description', 'status', 'priority', 'ownerId'];
    const data = object(input, current ? [...fields, 'expectedVersion', 'projectIds', 'projectId'] : [...fields, 'projectIds', 'projectId']);
    if (current && ('projectId' in data || 'projectIds' in data)) throw new HttpError(400, 'Change project tags with the separate task projects action.');
    if (current && integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before saving.');
    if (current && !fields.some(field => data[field] !== undefined)) throw new HttpError(400, 'At least one task field is required.');
    const now = new Date().toISOString();
    const values = {
      title: data.title === undefined && current ? current.title : string(data.title, 'Title'),
      description: data.description === undefined && current ? current.description : optionalString(data.description, 'Description'),
      status: data.status === undefined ? current?.status ?? 'open' : data.status === 'duplicate' && current?.status === 'duplicate' ? 'duplicate' as const : choice(data.status, 'status', ['open', 'in_progress', 'resolved']),
      priority: data.priority === undefined ? current?.priority ?? 'normal' : choice(data.priority, 'priority', ['low', 'normal', 'high', 'urgent']),
      ownerId: data.ownerId === undefined && current ? current.ownerId : data.ownerId === undefined || data.ownerId === null ? null : this.taskPrincipal(data.ownerId),
    };
    if (!current && 'projectIds' in data && 'projectId' in data) throw new HttpError(400, 'Use projectIds or the legacy projectId field, not both.');
    const projectIds = current?.projectIds ?? this.normalizeTaskProjectIds(this.taskProjectIds('projectIds' in data ? data.projectIds : data.projectId === undefined || data.projectId === null ? [] : [data.projectId]));
    const changes: TaskFieldChange[] = current ? fields.filter(field => values[field] !== current[field]).map(field => ({ field, oldValue: current[field], newValue: values[field] })) : [];
    if (current && changes.length === 0) return current;
    const task: Task = current ? { ...this.advanceTask(current, now), ...values } : { id: this.nextId('task', 'T'), ...values, projectIds, authorId: attribution ? this.taskPrincipal(attribution.principalId) : null, version: 1, createdAt: now, updatedAt: now };
    const parents = current && task.status !== current.status
      ? (this.database.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id = ? ORDER BY task_id').all(task.id) as { task_id: string }[]).map(row => this.advanceTask(this.get<Task>('task', row.task_id), now)) : [];
    this.save('task', task);
    if (!current) for (const projectId of projectIds) this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(task.id, projectId);
    const transaction = this.appendTaskTransaction(task, current ? { kind: 'edit', changes } : { kind: 'create', snapshot: task }, attribution, now);
    this.event(task.id, current ? 'updated' : 'created', `${current ? 'Updated' : 'Created'} task ${task.title}.`, attribution);
    if (task.ownerId !== (current?.ownerId ?? null)) {
      const row = this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number };
      if (!Number.isSafeInteger(row.value + 1)) throw new HttpError(409, 'The workspace has reached the supported policy epoch limit.');
      this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
      if (current?.ownerId) this.changeTaskSubscription(task, current.ownerId, 'subscribed', 'former_owner', attribution, now);
    }
    if (!current && task.authorId) this.changeTaskSubscription(task, task.authorId, 'subscribed', 'created', attribution, now);
    for (const parent of parents) {
      this.save('task', parent);
      const parentTransaction = this.appendTaskTransaction(parent, { kind: 'dependency_status', dependencyStatus: { taskId: task.id, oldStatus: current!.status, newStatus: task.status } }, attribution, now);
      this.event(parent.id, 'dependency_status_changed', 'A dependency changed status.', attribution);
      this.notifications.emit({ objectId: parent.id, kind: 'task_subtask_status_changed', cause: { type: 'task_transaction', id: parentTransaction.id }, attribution, createdAt: now, requireActorView: true });
    }
    this.notifications.emit({ objectId: task.id, kind: !current ? 'created' : changes.length === 1 && changes[0]!.field === 'ownerId' ? 'task_owner_changed' : 'task_updated', cause: { type: 'task_transaction', id: transaction.id }, attribution, createdAt: now });
    return task;
  }
  private taskProjectIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'projectIds must contain at most 100 project IDs.');
    const ids = value.map(value => {
      const id = string(value, 'Project ID', 50);
      if (!/^PROJ[1-9]\d*$/.test(id)) throw new HttpError(400, 'Choose a valid project.');
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Choose each project only once.');
    for (const id of ids) this.reference(id, 'project');
    return ids;
  }
  private normalizeTaskProjectIds(ids: string[]): string[] {
    const graph = this.database.prepare('SELECT project_id AS id, parent_id AS parentId, kind FROM project_hierarchy').all() as { id: string; parentId: string | null; kind: ProjectKind }[];
    try { return normalizeProjectTags(ids, graph).sort(); } catch { throw new HttpError(409, 'The project hierarchy is incomplete or invalid.'); }
  }
  updateTaskProjects(id: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['action', 'projectIds', 'expectedVersion']);
      const action = choice(data.action, 'action', ['add', 'remove', 'set']);
      const current = this.get<Task>('task', id);
      if (integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before changing project tags.');
      const selected = this.taskProjectIds(data.projectIds);
      const selectedSet = new Set(selected); const existing = new Set(current.projectIds);
      const wanted = action === 'remove' ? current.projectIds.filter(projectId => !selectedSet.has(projectId)) : this.normalizeTaskProjectIds(action === 'set' ? selected : [...current.projectIds, ...selected]);
      const wantedSet = new Set(wanted);
      const removed = current.projectIds.filter(projectId => !wantedSet.has(projectId));
      const added = wanted.filter(projectId => !existing.has(projectId));
      if (!removed.length && !added.length) return this.taskDetail(id);
      const now = new Date().toISOString(); const operationId = randomUUID();
      const task = this.advanceTask(current, now);
      this.workboards!.tagsChanged(current, wanted);
      for (const projectId of removed) this.database.prepare('DELETE FROM task_projects WHERE task_id = ? AND project_id = ?').run(id, projectId);
      for (const projectId of added) this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(id, projectId);
      this.save('task', task);
      for (const projectId of removed) this.appendTaskTransaction(task, { kind: 'project', project: { projectId, action: 'removed', operationId } }, attribution, now);
      for (const projectId of added) this.appendTaskTransaction(task, { kind: 'project', project: { projectId, action: 'added', operationId } }, attribution, now);
      this.event(id, 'projects_changed', 'Updated project tags.', attribution);
      this.notifications.emit({ objectId: id, kind: 'task_projects_changed', cause: { type: 'task_projects', id: operationId }, attribution, createdAt: now });
      return this.taskDetail(id);
    });
  }
  private writeTaskWorkboardChange(current: Task, projectIds: string[], column: TaskColumnMove | undefined, attribution: ActorAttribution | undefined, now: string, operationId: string): Task {
    const task = { ...this.advanceTask(current, now), projectIds };
    const wanted = new Set(projectIds); const old = new Set(current.projectIds);
    const removed = current.projectIds.filter(id => !wanted.has(id)); const added = projectIds.filter(id => !old.has(id));
    this.workboards!.tagsChanged(current, projectIds);
    for (const id of removed) this.database.prepare('DELETE FROM task_projects WHERE task_id=? AND project_id=?').run(task.id,id);
    for (const id of added) this.database.prepare('INSERT INTO task_projects(task_id,project_id) VALUES(?,?)').run(task.id,id);
    this.save('task', task);
    for (const id of removed) this.appendTaskTransaction(task,{kind:'project',project:{projectId:id,action:'removed',operationId}},attribution,now);
    for (const id of added) this.appendTaskTransaction(task,{kind:'project',project:{projectId:id,action:'added',operationId}},attribution,now);
    if (column) this.appendTaskTransaction(task,{kind:'column',column},attribution,now);
    this.event(task.id,column?'column_changed':'projects_changed',column?'Moved task on a workboard.':'Updated project tags.',attribution);
    const changedColumn = column && !column.fromColumns.some(previous => previous.id === column.toColumn.id);
    if (changedColumn || removed.length || added.length) this.notifications.emit({ objectId: task.id, kind: changedColumn ? 'task_column_changed' : 'task_projects_changed', cause: { type: 'task_workboard', id: operationId }, attribution, createdAt: now });
    return task;
  }
  taskHistory(id: string, before?: number, limit = 50, visible?: (id: string) => boolean): TaskHistory {
    this.get<Task>('task', id);
    const cursor = before === undefined ? null : integer(before, 'before');
    const size = integer(limit, 'limit');
    if (size > 100) throw new HttpError(400, 'limit must be at most 100.');
    const canSee = (item: TaskTransaction) => !visible || ((!item.dependency || visible(item.dependency.taskId)) && (!item.dependencyStatus || visible(item.dependencyStatus.taskId)) && (!item.merge || visible(item.merge.taskId)) && (!item.project || visible(item.project.projectId)) && (!item.column || [item.column.projectId,...item.column.fromColumns.flatMap(column=>column.proxyProjectId?[column.proxyProjectId]:[]),...(item.column.toColumn.proxyProjectId?[item.column.toColumn.proxyProjectId]:[]),...(item.column.bulkSource?[item.column.bulkSource.projectId,...(item.column.bulkSource.column.proxyProjectId?[item.column.bulkSource.column.proxyProjectId]:[])]:[])].every(visible)));
    const pageStatement = this.database.prepare(cursor === null
      ? 'SELECT data FROM task_transactions WHERE task_id = ? ORDER BY sequence DESC'
      : 'SELECT data FROM task_transactions WHERE task_id = ? AND sequence < ? ORDER BY sequence DESC');
    const rows = cursor === null ? pageStatement.iterate(id) : pageStatement.iterate(id, cursor);
    const available: TaskTransaction[] = [];
    for (const row of rows) {
      const item = JSON.parse((row as JsonRow).data) as TaskTransaction;
      if (item.subscription?.reason === 'mentioned') this.verifyTaskMention(item);
      if (canSee(item)) available.push(item);
      if (available.length > size) break;
    }
    let firstAvailableSequence: number | null = null;
    const firstStatement = this.database.prepare('SELECT data FROM task_transactions WHERE task_id = ? ORDER BY sequence ASC');
    for (const row of firstStatement.iterate(id)) {
      const item = JSON.parse((row as JsonRow).data) as TaskTransaction;
      if (canSee(item)) { firstAvailableSequence = item.sequence; break; }
    }
    const page = available.slice(0, size);
    return { transactions: page, nextBefore: available.length > size ? page[page.length - 1]!.sequence : null, firstAvailableSequence };
  }
  taskDetail(id: string): TaskDetail {
    const task = this.get<Task>('task', id);
    const references = (direction: 'depends_on' | 'blocks' | 'duplicate_of' | 'duplicates'): TaskReference[] => {
      const queries = {
        depends_on: 'SELECT e.data FROM task_dependencies d JOIN entities e ON e.id = d.dependency_id WHERE d.task_id = ? ORDER BY d.dependency_id',
        blocks: 'SELECT e.data FROM task_dependencies d JOIN entities e ON e.id = d.task_id WHERE d.dependency_id = ? ORDER BY d.task_id',
        duplicate_of: 'SELECT e.data FROM task_duplicates d JOIN entities e ON e.id = d.target_id WHERE d.source_id = ? ORDER BY d.target_id',
        duplicates: 'SELECT e.data FROM task_duplicates d JOIN entities e ON e.id = d.source_id WHERE d.target_id = ? ORDER BY d.source_id',
      };
      const rows = this.database.prepare(queries[direction]).all(id);
      return (rows as JsonRow[]).map(row => { const value = JSON.parse(row.data) as Task; return { id: value.id, title: value.title, status: value.status, priority: value.priority, version: value.version }; });
    };
    return { task, history: this.taskHistory(id), dependsOn: references('depends_on'), blocks: references('blocks'), duplicateOf: references('duplicate_of'), duplicates: references('duplicates'), activity: this.activities(id) };
  }
  private mergeTaskId(value: unknown): string {
    const id = string(value, 'Task ID', 50);
    if (!/^T[1-9]\d*$/.test(id)) throw new HttpError(400, 'Choose a valid task.');
    return id;
  }
  mergeTask(sourceId: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['taskId', 'expectedVersion', 'expectedTargetVersion']);
      this.applyTaskMerge(this.mergeTaskId(data.taskId), integer(data.expectedTargetVersion, 'expectedTargetVersion'), [
        { taskId: this.mergeTaskId(sourceId), expectedVersion: integer(data.expectedVersion, 'expectedVersion') },
      ], attribution);
      return this.taskDetail(sourceId);
    });
  }
  mergeTasksInto(targetId: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['sources', 'expectedVersion']);
      if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 100) throw new HttpError(400, 'Choose between 1 and 100 source tasks.');
      const sources = data.sources.map(value => {
        const source = object(value, ['taskId', 'expectedVersion']);
        return { taskId: this.mergeTaskId(source.taskId), expectedVersion: integer(source.expectedVersion, 'expectedVersion') };
      });
      this.applyTaskMerge(this.mergeTaskId(targetId), integer(data.expectedVersion, 'expectedVersion'), sources, attribution);
      return this.taskDetail(targetId);
    });
  }
  private applyTaskMerge(targetId: string, expectedTargetVersion: number, sources: { taskId: string; expectedVersion: number }[], attribution?: ActorAttribution): void {
    const ids = sources.map(source => source.taskId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Choose each source task only once.');
    if (ids.includes(targetId)) throw new HttpError(400, 'A task cannot be merged into itself.');
    const originals = new Map<string, Task>();
    for (const endpoint of [{ taskId: targetId, expectedVersion: expectedTargetVersion }, ...sources]) {
      const row = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND id = ?").get(endpoint.taskId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'A selected task is unavailable.', 'TASK_UNAVAILABLE');
      const task = this.hydrateTask(JSON.parse(row.data) as Task);
      if (task.version !== endpoint.expectedVersion) throw new HttpError(409, 'A selected task changed. Reload before merging.');
      originals.set(task.id, task);
    }
    const now = new Date().toISOString(); const operationId = randomUUID();
    const changed = new Map<string, Task>();
    const advance = (id: string): Task => {
      let task = changed.get(id);
      if (!task) { task = this.advanceTask(originals.get(id) ?? this.get<Task>('task', id), now); changed.set(id, task); }
      return task;
    };
    const target = advance(targetId);
    const parentEffects: { parentId: string; sourceId: string; oldStatus: Task['status'] }[] = [];
    for (const id of ids) {
      const source = originals.get(id)!; advance(id).status = 'duplicate';
      if (source.status === 'duplicate') continue;
      for (const parent of this.database.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id = ? ORDER BY task_id').all(id) as { task_id: string }[]) {
        advance(parent.task_id);
        parentEffects.push({ parentId: parent.task_id, sourceId: id, oldStatus: source.status });
      }
    }
    // Every endpoint CAS is checked against the original snapshot. A task
    // advances only once even when also a parent of several merged sources.
    for (const task of changed.values()) this.save('task', task);
    for (const id of ids) {
      // A fresh merge may close this task again or carry new followers. Keep
      // the first link immutable while recording this operation separately.
      this.database.prepare('INSERT INTO task_duplicates (source_id, target_id, operation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, target_id) DO NOTHING').run(id, targetId, operationId, now);
      const original = originals.get(id)!; const source = changed.get(id)!;
      this.appendTaskTransaction(source, { kind: 'merge', merge: { taskId: targetId, direction: 'merged_into', operationId }, ...(original.status === 'duplicate' ? {} : { changes: [{ field: 'status', oldValue: original.status, newValue: 'duplicate' }] }) }, attribution, now);
      this.appendTaskTransaction(target, { kind: 'merge', merge: { taskId: id, direction: 'merged_from', operationId } }, attribution, now);
      this.event(id, 'merged', 'Closed this task as a duplicate.', attribution);
    }
    this.event(targetId, 'duplicates_merged', 'Merged duplicate tasks into this task.', attribution);
    for (const effect of parentEffects) {
      const parent = changed.get(effect.parentId)!;
      this.appendTaskTransaction(parent, { kind: 'dependency_status', dependencyStatus: { taskId: effect.sourceId, oldStatus: effect.oldStatus, newStatus: 'duplicate' } }, attribution, now);
      this.event(parent.id, 'dependency_status_changed', 'A dependency changed status.', attribution);
    }
    // Carry only the source's explicit subscribers, author and automatic
    // owner. Explicit merge additions override destination opt-out, without
    // changing source preferences or representing the recipient as actor.
    const parameters = ids.map(() => '?').join(',');
    const recipients = this.database.prepare(`SELECT principal_id FROM (
      SELECT principal_id FROM task_subscriptions WHERE task_id IN (${parameters}) AND state = 'subscribed'
      UNION SELECT json_extract(data, '$.authorId') FROM entities WHERE id IN (${parameters})
      UNION SELECT json_extract(data, '$.ownerId') FROM entities WHERE id IN (${parameters})
    ) WHERE principal_id IS NOT NULL ORDER BY principal_id`);
    for (const row of recipients.iterate(...ids, ...ids, ...ids) as Iterable<{ principal_id: string }>) this.changeTaskSubscription(target, row.principal_id, 'subscribed', 'merged', attribution, now);
    for (const objectId of [targetId, ...ids]) this.notifications.emit({ objectId, kind: 'task_merged', cause: { type: 'task_merge', id: operationId }, attribution, createdAt: now });
  }
  createTaskComment(id: string, input: unknown, attribution?: ActorAttribution): TaskTransaction {
    return this.taskMutation(() => {
      const data = object(input, ['body']); const body = string(data.body, 'Comment', 20_000);
      const task = this.get<Task>('task', id);
      const mentions = this.commentMentions(id, body, attribution);
      if (attribution && attribution.principalId !== task.ownerId) {
        const principalId = this.taskPrincipal(attribution.principalId);
        const membership = this.subscriptionForTask(task, principalId);
        if (membership.state === null) this.changeTaskSubscription(task, principalId, 'subscribed', 'commented', attribution);
      }
      const transaction = this.appendTaskTransaction(task, { kind: 'comment', comment: body, ...(mentions ? { mentions } : {}) }, attribution);
      this.mentionedTask(task, transaction);
      this.event(id, 'commented', 'Commented on this task.', attribution);
      this.notifications.emit({ objectId: id, kind: 'task_commented', cause: { type: 'task_transaction', id: transaction.id }, attribution, createdAt: transaction.createdAt });
      return transaction;
    });
  }
  private taskPrincipal(value: unknown): string {
    const principalId = string(value, 'Principal ID', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(principalId)) throw new HttpError(400, 'Choose a valid workspace principal.');
    return principalId;
  }
  private mentionTaskComment(taskId: string, commentId: string): TaskTransaction {
    const row = this.database.prepare('SELECT task_id,sequence,task_version,data FROM task_transactions WHERE id=?').get(commentId) as { task_id: string; sequence: number; task_version: number; data: string } | undefined;
    const fail = () => new HttpError(409, 'Task mention evidence cannot be verified.', 'MENTION_INVALID');
    if (!row) throw fail(); const comment = JSON.parse(row.data) as TaskTransaction;
    if (!comment || row.task_id !== taskId || comment.taskId !== taskId || comment.id !== commentId || comment.sequence !== row.sequence || comment.taskVersion !== row.task_version || comment.kind !== 'comment' || typeof comment.comment !== 'string' || !comment.attribution || comment.actor !== comment.attribution.displayName || !isStoredMentionProof(comment.mentions, comment.comment) || !Number.isFinite(Date.parse(comment.createdAt))) throw fail();
    return comment;
  }
  private taskOwnerAtComment(comment: TaskTransaction): string | null {
    const row = this.database.prepare(`SELECT owner FROM (
      SELECT sequence,json_extract(data,'$.snapshot.ownerId') AS owner FROM task_transactions WHERE task_id=? AND sequence<=? AND json_type(data,'$.snapshot')='object'
      UNION ALL SELECT t.sequence,json_extract(c.value,'$.newValue') AS owner FROM task_transactions t,json_each(t.data,'$.changes') c WHERE t.task_id=? AND t.sequence<=? AND json_extract(c.value,'$.field')='ownerId'
    ) ORDER BY sequence DESC LIMIT 1`).get(comment.taskId, comment.sequence, comment.taskId, comment.sequence) as { owner: unknown } | undefined;
    if (!row || row.owner !== null && (typeof row.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(row.owner))) throw new HttpError(409, 'Task mention owner evidence cannot be verified.', 'MENTION_INVALID');
    return row.owner as string | null;
  }
  private verifyTaskMention(transaction: TaskTransaction): void {
    const fail = () => new HttpError(409, 'Task mention subscription evidence cannot be verified.', 'MENTION_INVALID');
    const subscription = transaction.subscription;
    if (!subscription || subscription.reason !== 'mentioned' || typeof subscription.commentId !== 'string' || transaction.kind !== 'subscription' || subscription.newState !== 'subscribed' || ![null, 'unsubscribed'].includes(subscription.oldState) || !Number.isSafeInteger(subscription.membershipVersion) || subscription.membershipVersion < 1) throw fail();
    const comment = this.mentionTaskComment(transaction.taskId, subscription.commentId);
    if (comment.sequence >= transaction.sequence || comment.taskVersion !== transaction.taskVersion || comment.createdAt !== transaction.createdAt || !isDeepStrictEqual(comment.attribution, transaction.attribution) || transaction.actor !== comment.actor || this.taskOwnerAtComment(comment) === subscription.principalId || !comment.mentions!.tokens.some(token => token.principalId === subscription.principalId)) throw fail();
    const previous = this.database.prepare("SELECT data FROM task_transactions WHERE task_id=? AND sequence<? AND json_extract(data,'$.subscription.principalId')=? ORDER BY sequence DESC LIMIT 1").get(transaction.taskId, transaction.sequence, subscription.principalId) as JsonRow | undefined;
    const before = previous ? (JSON.parse(previous.data) as TaskTransaction).subscription : undefined;
    if ((before?.newState ?? null) !== subscription.oldState || (before?.membershipVersion ?? 0) + 1 !== subscription.membershipVersion) throw fail();
  }
  /** Original insertion only; saved HTTP retries do not call this hook. */
  private mentionedTask(task: Task, value: TaskTransaction): void {
    if (value.mentions === undefined) return;
    const comment = this.mentionTaskComment(task.id, value.id);
    if (!isDeepStrictEqual(comment, value) || this.taskOwnerAtComment(comment) !== task.ownerId) throw new HttpError(409, 'Task mention evidence cannot be verified.', 'MENTION_INVALID');
    const people = new Set(comment.mentions!.tokens.flatMap(token => token.principalId === null ? [] : [token.principalId]));
    for (const principalId of people) {
      if (this.subscriptionForTask(task, principalId).subscribed) continue;
      if (this.database.prepare("SELECT 1 FROM task_transactions WHERE task_id=? AND json_extract(data,'$.subscription.principalId')=? AND json_extract(data,'$.subscription.commentId')=?").get(task.id, principalId, comment.id)) continue;
      const count = this.database.prepare("SELECT count(*) AS n FROM task_subscriptions WHERE task_id=? AND state='subscribed'").get(task.id) as { n: number };
      if (count.n >= NOTIFICATION_LIMITS.recipients) throw new HttpError(422, 'Task mentions exceed the complete following limit.', 'MENTION_LIMIT');
      this.changeTaskSubscription(task, principalId, 'subscribed', 'mentioned', comment.attribution, comment.createdAt, comment.id);
    }
  }
  private subscriptionForTask(task: Task, principalId: string): TaskSubscriptionStatus {
    const row = this.database.prepare('SELECT state, version, updated_at FROM task_subscriptions WHERE task_id = ? AND principal_id = ?').get(task.id, principalId) as { state: TaskSubscriptionState; version: number; updated_at: string } | undefined;
    const automatic = task.ownerId === principalId;
    return { taskId: task.id, principalId, state: row?.state ?? null, version: row?.version ?? 0, automatic, subscribed: automatic || row?.state === 'subscribed', updatedAt: row?.updated_at ?? null };
  }
  subscriptionStatus(taskId: string, principalId: string): TaskSubscriptionStatus {
    return this.subscriptionForTask(this.get<Task>('task', taskId), this.taskPrincipal(principalId));
  }
  taskSubscriptions(taskId: string, viewerId: string, after?: string, limit = 50): TaskSubscriptionPage {
    const task = this.get<Task>('task', taskId); const viewer = this.subscriptionForTask(task, this.taskPrincipal(viewerId));
    const cursor = after === undefined ? null : this.taskPrincipal(after);
    const size = integer(limit, 'limit'); if (size > 100) throw new HttpError(400, 'limit must be at most 100.');
    const rows = this.database.prepare(`SELECT principal_id FROM (
      SELECT principal_id FROM task_subscriptions WHERE task_id = ? AND state = 'subscribed'
      UNION SELECT ? AS principal_id WHERE ? IS NOT NULL
    ) WHERE (? IS NULL OR principal_id > ?) ORDER BY principal_id LIMIT ?`).all(taskId, task.ownerId, task.ownerId, cursor, cursor, size + 1) as { principal_id: string }[];
    const subscribers = rows.slice(0, size).map(row => this.subscriptionForTask(task, row.principal_id));
    return { subscribers, nextAfter: rows.length > size ? subscribers[subscribers.length - 1]!.principalId : null, viewer };
  }
  private changeTaskSubscription(task: Task, principalId: string, state: TaskSubscriptionState, reason: NonNullable<TaskTransaction['subscription']>['reason'], attribution?: ActorAttribution, now = new Date().toISOString(), commentId?: string): TaskSubscriptionStatus {
    const current = this.subscriptionForTask(task, principalId);
    if (current.state === state) return current;
    const version = current.version + 1;
    if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(409, 'This membership has reached the supported version limit.');
    this.database.prepare(`INSERT INTO task_subscriptions (task_id, principal_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, principal_id) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at`).run(task.id, principalId, state, version, now);
    const transaction = this.appendTaskTransaction(task, { kind: 'subscription', subscription: { principalId, oldState: current.state, newState: state, membershipVersion: version, reason, ...(commentId ? { commentId } : {}) } }, attribution, now);
    if (reason === 'mentioned') this.verifyTaskMention(transaction);
    this.event(task.id, 'subscription_changed', 'Updated task subscription preferences.', attribution);
    if (reason === 'explicit' && attribution?.principalId !== principalId) this.notifications.emit({ objectId: task.id, kind: 'task_subscribers_changed', cause: { type: 'task_transaction', id: transaction.id }, attribution, createdAt: now });
    return this.subscriptionForTask(task, principalId);
  }
  updateTaskSubscription(id: string, input: unknown, attribution: ActorAttribution): TaskSubscriptionStatus {
    return this.taskMutation(() => {
      const data = object(input, ['principalId', 'action', 'expectedMembershipVersion']);
      const principalId = this.taskPrincipal(data.principalId);
      const action = choice(data.action, 'action', ['subscribe', 'unsubscribe']);
      const expected = data.expectedMembershipVersion;
      if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new HttpError(400, 'expectedMembershipVersion must be a nonnegative integer.');
      const task = this.get<Task>('task', id); const current = this.subscriptionForTask(task, principalId);
      if (current.version !== expected) throw new HttpError(409, 'This subscription changed. Reload before changing it.');
      if (action === 'unsubscribe' && current.automatic) throw new HttpError(409, 'The current owner is automatically subscribed. Reassign the task before unsubscribing.');
      return this.changeTaskSubscription(task, principalId, action === 'subscribe' ? 'subscribed' : 'unsubscribed', 'explicit', attribution);
    });
  }
  updateTaskDependencies(id: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['taskId', 'action', 'expectedVersion']);
      const dependencyId = string(data.taskId, 'Dependency task ID', 50);
      if (!/^T[1-9]\d*$/.test(dependencyId)) throw new HttpError(400, 'Choose a valid dependency task.');
      const action = choice(data.action, 'action', ['add', 'remove']);
      const current = this.get<Task>('task', id);
      if (integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before changing dependencies.');
      if (dependencyId === id) throw new HttpError(400, 'A task cannot depend on itself.');
      const row = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND id = ?").get(dependencyId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'Dependency task was not found.', 'TASK_UNAVAILABLE');
      const dependency = this.hydrateTask(JSON.parse(row.data) as Task);
      const exists = Boolean(this.database.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND dependency_id = ?').get(id, dependencyId));
      if ((action === 'add') === exists) throw new HttpError(409, action === 'add' ? 'This dependency already exists.' : 'This dependency no longer exists.');
      if (action === 'add' && this.database.prepare(`WITH RECURSIVE reachable(id) AS (
        SELECT dependency_id FROM task_dependencies WHERE task_id = ?
        UNION SELECT d.dependency_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.id
      ) SELECT 1 FROM reachable WHERE id = ? LIMIT 1`).get(dependencyId, id)) throw new HttpError(409, 'This dependency would create a cycle.');
      const now = new Date().toISOString(); const task = this.advanceTask(current, now); const other = this.advanceTask(dependency, now);
      if (action === 'add') this.database.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(id, dependencyId);
      else this.database.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND dependency_id = ?').run(id, dependencyId);
      this.save('task', task); this.save('task', other);
      const change = action === 'add' ? 'added' : 'removed';
      const transaction = this.appendTaskTransaction(task, { kind: 'dependency', dependency: { taskId: other.id, action: change, direction: 'depends_on' } }, attribution, now);
      const inverse = this.appendTaskTransaction(other, { kind: 'dependency', dependency: { taskId: task.id, action: change, direction: 'blocks' } }, attribution, now);
      this.event(task.id, `dependency_${change}`, `${action === 'add' ? 'Added' : 'Removed'} a task dependency.`, attribution);
      this.event(other.id, `dependency_${change}`, `${action === 'add' ? 'Added' : 'Removed'} a task blocked by this task.`, attribution);
      this.notifications.emit({ objectId: task.id, kind: 'task_dependencies_changed', cause: { type: 'task_transaction', id: transaction.id }, attribution, createdAt: now });
      this.notifications.emit({ objectId: other.id, kind: 'task_dependencies_changed', cause: { type: 'task_transaction', id: inverse.id }, attribution, createdAt: now });
      return this.taskDetail(id);
    });
  }
  searchWikiDocuments(query:WikiDocumentSearchQuery={},canView:(id:string)=>boolean,principalId:string):WikiDocumentSearchPage{return this.read(()=>this.wikiSearch!.documents(query,canView,principalId));}
  searchWikiContent(query:WikiContentSearchQuery={},canView:(id:string)=>boolean,principalId:string):WikiContentSearchPage{return this.read(()=>this.wikiSearch!.contents(query,canView,principalId));}
  wikiDocumentIdentity(id:string):WikiDocumentIdentity{return this.wikiSearch!.documentIdentity(id);}
  wikiContentIdentity(versionId:string):WikiContentIdentity{return this.wikiSearch!.contentIdentity(versionId);}
  resolveWikiDocumentIdentity(value:number|string):WikiDocumentIdentity|null{return this.wikiSearch!.resolveDocument(value);}
  resolveWikiContentIdentity(value:number|string):WikiContentIdentity|null{return this.wikiSearch!.resolveContent(value);}
  private documentMutation<T>(work: () => T): T {
    this.database.exec('SAVEPOINT wiki_document_write');
    try {
      // Acquire the writer lock before observing heads, including direct Store calls.
      this.database.prepare("UPDATE policy_meta SET value=value WHERE name='epoch'").run();
      const result = this.notifications.batch(work); this.database.exec('RELEASE wiki_document_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO wiki_document_write; RELEASE wiki_document_write'); throw error; }
  }
  private rawWikiVersion(id:string):WikiVersion {
    const row=this.database.prepare('SELECT data FROM wiki_versions WHERE id=?').get(id) as JsonRow|undefined;
    if(!row)throw new HttpError(404,'The wiki content version is unavailable.','WIKI_VERSION_UNAVAILABLE');return JSON.parse(row.data) as WikiVersion;
  }
  documentPublication(id:string):WikiPublication {
    const row=this.database.prepare('SELECT revision,head_version_id,published_version_id FROM wiki_publication WHERE document_id=?').get(id) as {revision:number;head_version_id:string;published_version_id:string}|undefined;
    if(!row)throw new HttpError(404,'Wiki publication is unavailable.','WIKI_PUBLICATION_UNAVAILABLE');
    const head=this.rawWikiVersion(row.head_version_id),published=this.rawWikiVersion(row.published_version_id);
    if(head.documentId!==id||published.documentId!==id||published.number>head.number)throw new HttpError(409,'Wiki publication does not match its content.','WIKI_PUBLICATION_MISMATCH');
    return {revision:row.revision,headVersion:head.number,headVersionId:head.id,publishedVersion:published.number,publishedVersionId:published.id};
  }
  private hydrateDocument(document:WikiDocument):WikiDocument {
    const location=this.documentLocation(document.id);if(!this.wikiPublicationReady)return {...document,location};
    const publication=this.documentPublication(document.id),published=this.rawWikiVersion(publication.publishedVersionId);
    if(document.version!==publication.headVersion)throw new HttpError(409,'Wiki head does not match its publication.','WIKI_PUBLICATION_MISMATCH');
    return {...document,title:published.title,content:published.content,location,publication};
  }
  private wikiSnapshot(document:WikiDocument):WikiLifecycleSnapshot {return {publication:document.publication!,location:document.location!,updatedAt:document.updatedAt};}
  private checkWikiPins(document:WikiDocument,input:Partial<WikiLifecyclePins>,required=false):void {
    const publication=document.publication!;
    const hasExtra=input.expectedHeadVersionId!==undefined||input.expectedPublishedVersionId!==undefined||input.expectedPublicationRevision!==undefined;
    if(required||hasExtra||publication.headVersionId!==publication.publishedVersionId||publication.revision!==publication.headVersion) wikiPins(input as Record<string,unknown>);
    if(input.expectedVersion!==document.version || (input.expectedHeadVersionId!==undefined&&input.expectedHeadVersionId!==publication.headVersionId) || (input.expectedPublishedVersionId!==undefined&&input.expectedPublishedVersionId!==publication.publishedVersionId) || (input.expectedPublicationRevision!==undefined&&input.expectedPublicationRevision!==publication.revision))throw new HttpError(409,'This document or its publication changed. Reload before saving.','WIKI_VERSION_CHANGED');
    if(input.expectedAccessEpoch!==undefined)this.docxEpoch(input.expectedAccessEpoch);
  }
  private publishWikiState(document:WikiDocument,head:WikiVersion,published:WikiVersion,before:WikiDocument|undefined,kind:WikiLifecycleKind,inputSha256:string|null,message:string,attribution?:ActorAttribution,newVersionId:string|null=head.id):WikiLifecycleTransaction {
    const publication:WikiPublication={revision:(before?.publication?.revision??0)+1,headVersion:head.number,headVersionId:head.id,publishedVersion:published.number,publishedVersionId:published.id};
    if(!Number.isSafeInteger(publication.revision))throw new HttpError(409,'This document has reached the supported publication limit.');
    document.publication=publication;document.title=published.title;document.content=published.content;
    this.save('document',document);
    this.database.prepare('INSERT INTO wiki_publication VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision,head_version_id=excluded.head_version_id,published_version_id=excluded.published_version_id').run(document.id,publication.revision,head.id,published.id);
    const transaction:WikiLifecycleTransaction={id:randomUUID(),documentId:document.id,sequence:publication.revision,kind,actor:attribution?.displayName??'You',...(attribution?{attribution}:{}),createdAt:document.updatedAt,message,inputSha256,before:before?this.wikiSnapshot(before):null,after:this.wikiSnapshot(document),newVersionId};
    this.database.prepare('INSERT INTO wiki_transactions VALUES(?,?,?,?)').run(transaction.id,document.id,transaction.sequence,JSON.stringify(transaction));
    // Title effects compare with the published title, even while saving a draft.
    // Body-only drafts and both ordinary move transactions are feed-hidden upstream.
    const titleChanged = !!before && head.title !== before.title;
    const bodyChanged = !!before && head.content !== this.rawWikiVersion(before.publication!.headVersionId).content;
    const statusChanged = !!before && document.location!.status !== before.location!.status;
    const notificationKind: NotificationKind | null = kind === 'create' ? 'created' : kind === 'draft' ? titleChanged ? 'wiki_title_changed' : null
      : kind === 'publish' ? 'wiki_published' : kind === 'delete' ? 'wiki_deleted'
      : (kind === 'edit' || kind === 'restore') && (titleChanged || bodyChanged || statusChanged) ? kind === 'restore' ? 'wiki_restored' : 'wiki_updated' : null;
    if (notificationKind) this.notifications.emit({ objectId: document.id, kind: notificationKind, cause: { type: 'wiki_transaction', id: transaction.id }, attribution, createdAt: transaction.createdAt, context: this.wikiNotificationContext(publication) });
    return transaction;
  }
  documentTransaction(id:string,sequence:number):WikiLifecycleTransaction {
    integer(sequence,'sequence');const row=this.database.prepare('SELECT data FROM wiki_transactions WHERE document_id=? AND sequence=?').get(id,sequence) as JsonRow|undefined;
    if(!row)throw new HttpError(404,'Wiki lifecycle transaction is unavailable.','WIKI_TRANSACTION_UNAVAILABLE');return JSON.parse(row.data) as WikiLifecycleTransaction;
  }
  documentTransactions(id:string,options:{before?:number;limit?:number}={}):WikiLifecycleHistory {
    this.get<WikiDocument>('document',id);const before=options.before===undefined?null:integer(options.before,'before'),limit=options.limit===undefined?20:integer(options.limit,'limit');if(limit>100)throw new HttpError(400,'limit must be at most 100.');
    const rows=this.database.prepare('SELECT data FROM wiki_transactions WHERE document_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(id,before,before,limit+1) as JsonRow[];
    const transactions=rows.slice(0,limit).map(row=>JSON.parse(row.data) as WikiLifecycleTransaction),first=this.database.prepare('SELECT MIN(sequence) AS sequence FROM wiki_transactions WHERE document_id=?').get(id) as {sequence:number|null};
    return {transactions,nextBefore:rows.length>limit?transactions.at(-1)!.sequence:null,firstAvailableSequence:first.sequence};
  }
  wikiLifecycleReceipt(id:string,transactionId:string):WikiLifecycleReceipt {
    const row=this.database.prepare('SELECT data FROM wiki_transactions WHERE document_id=? AND id=?').get(id,transactionId) as JsonRow|undefined;
    if(!row)throw new HttpError(404,'Wiki lifecycle transaction is unavailable.','WIKI_TRANSACTION_UNAVAILABLE');
    const transaction=JSON.parse(row.data) as WikiLifecycleTransaction,published=this.rawWikiVersion(transaction.after.publication.publishedVersionId),current=this.get<WikiDocument>('document',id);
    const document:WikiDocument={id,title:published.title,slug:current.slug,content:published.content,version:transaction.after.publication.headVersion,createdAt:current.createdAt,updatedAt:transaction.after.updatedAt,location:transaction.after.location,publication:transaction.after.publication};
    return {document,transaction};
  }
  documentLocation(id: string): WikiLocation {
    const row = this.database.prepare('SELECT path,status,moved_to_id FROM wiki_locations WHERE document_id=?').get(id) as {path:string;status:WikiLocation['status'];moved_to_id:string|null} | undefined;
    if (!row) throw new HttpError(404, 'Wiki location is unavailable.', 'WIKI_PATH_UNAVAILABLE');
    return {path:row.path,status:row.status,movedToId:row.moved_to_id};
  }
  documentAtPath(path: string): WikiDocument | null {
    const row = this.database.prepare('SELECT document_id FROM wiki_locations WHERE path=?').get(wikiPath(path)) as {document_id:string}|undefined;
    return row ? this.get<WikiDocument>('document',row.document_id) : null;
  }
  documentAncestry(path: string): WikiAncestor[] { return wikiAncestors(wikiPath(path)).map(path => { const document=this.documentAtPath(path); return {path,document:document?wikiReference(document):null}; }); }
  private wikiCursor(path:string, cursor:number):string {
    const key=(this.database.prepare('SELECT key FROM wiki_cursor_secret WHERE singleton=1').get() as {key:Uint8Array}).key;
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(path));
    const position=Buffer.alloc(8);position.writeBigUInt64BE(BigInt(cursor));
    const body=Buffer.concat([cipher.update(position),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64url');
  }
  private readWikiCursor(path:string,token?:string):number {
    if(token===undefined)return 0;
    try {
      if(!/^[A-Za-z0-9_-]{48}$/.test(token))throw new Error();
      const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)throw new Error();
      const key=(this.database.prepare('SELECT key FROM wiki_cursor_secret WHERE singleton=1').get() as {key:Uint8Array}).key;
      const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(path));decipher.setAuthTag(bytes.subarray(12,28));
      const position=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);if(position.length!==8)throw new Error();
      const cursor=Number(position.readBigUInt64BE());if(cursor<1||!Number.isSafeInteger(cursor))throw new Error();return cursor;
    }catch{throw new HttpError(400,'Invalid child cursor.');}
  }
  documentChildren(input: string, canView: (id:string)=>boolean, after?: string, limit=50): WikiChildren {
    const path=wikiPath(input); integer(limit,'limit'); if(limit>100) throw new HttpError(400,'limit must be at most 100.');
    const prefix=path==='/'?'':path, documents: WikiChildren['documents']=[], missingPaths=new Set<string>();
    let cursor=this.readWikiCursor(path,after),scanned=0,ended=false;
    while(scanned<WIKI_CHILD_SCAN_LIMIT && documents.length+missingPaths.size<limit) {
      const rows=this.database.prepare("SELECT rowid AS cursor,document_id,path,status FROM wiki_locations WHERE rowid>? AND path<>? AND substr(path,1,?)=? ORDER BY rowid LIMIT ?").all(cursor,path,prefix.length,prefix,Math.min(100,WIKI_CHILD_SCAN_LIMIT-scanned)) as {cursor:number;document_id:string;path:string;status:WikiLocation['status']}[];
      if(!rows.length){ended=true;break;}
      for(const row of rows) {
        cursor=row.cursor;scanned++;
        if(canView(row.document_id)) {
          const remainder=row.path.slice(prefix.length), component=remainder.split('/')[0]!;
          const immediate=`${prefix}${component}/`;
          if(immediate===row.path) documents.push(wikiReference(this.get<WikiDocument>('document',row.document_id)));
          else if(!this.database.prepare('SELECT 1 FROM wiki_locations WHERE path=?').get(immediate)) missingPaths.add(immediate);
        }
        if(scanned>=WIKI_CHILD_SCAN_LIMIT || documents.length+missingPaths.size>=limit) break;
      }
    }
    if(!ended) ended=!this.database.prepare('SELECT 1 FROM wiki_locations WHERE rowid>? AND path<>? AND substr(path,1,?)=? LIMIT 1').get(cursor,path,prefix.length,prefix);
    return {documents,missingPaths:[...missingPaths],nextAfter:ended?null:this.wikiCursor(path,cursor)};
  }
  private requireWikiAncestors(path: string): void {
    if(wikiAncestors(path).some(ancestor=>!this.database.prepare('SELECT 1 FROM wiki_locations WHERE path=?').get(ancestor))) throw new HttpError(409,'Create every parent document before using this path.','WIKI_ANCESTOR_REQUIRED');
  }
  private writeWikiLocation(id:string,location:WikiLocation):void {
    this.database.prepare('INSERT INTO wiki_locations(document_id,path,status,moved_to_id) VALUES (?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET path=excluded.path,status=excluded.status,moved_to_id=excluded.moved_to_id').run(id,location.path,location.status,location.movedToId);
  }
  private wikiChanged():void { this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run(); }
  private wikiConduitActor(attribution:ActorAttribution):ActorAttribution {
    if(!attribution || typeof attribution.principalId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(attribution.principalId)
      || typeof attribution.displayName!=='string' || !attribution.displayName.trim() || attribution.displayName.length>240
      || typeof attribution.requestId!=='string' || !attribution.requestId || attribution.requestId.length>240
      || (attribution.credentialId!==null && (typeof attribution.credentialId!=='string' || !attribution.credentialId || attribution.credentialId.length>240))) throw new HttpError(400,'Conduit writes require authenticated attribution.','WIKI_CONDUIT_ATTRIBUTION_INVALID');
    return {principalId:attribution.principalId,displayName:attribution.displayName,credentialId:attribution.credentialId,requestId:attribution.requestId};
  }
  private wikiConduitRetryKey(value:string|null):string|null {if(value!==null && (typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)))throw new HttpError(400,'The Conduit retry identity is invalid.','WIKI_CONDUIT_INPUT_INVALID');return value;}
  private saveWikiConduitReceipt(method:WikiConduitMethod,input:unknown,document:WikiDocument,attribution:ActorAttribution,transactionId:string|null,retryKeySha256:string|null):WikiConduitReceipt {
    const receipt:WikiConduitReceipt={id:randomUUID(),method,inputSha256:wikiConduitInputHash(method,input),retryKeySha256,attribution,documentId:document.id,selectedVersionId:document.publication!.publishedVersionId,snapshot:this.wikiSnapshot(document),transactionId,createdAt:transactionId?document.updatedAt:new Date().toISOString()};
    this.database.prepare('INSERT INTO wiki_conduit_receipts VALUES(?,?,?,?)').run(receipt.id,receipt.documentId,receipt.selectedVersionId,JSON.stringify(receipt));
    return receipt;
  }
  /** Legacy Conduit writes observe current state under the writer lock; native CAS saves are separate. */
  createConduitDocument(input:unknown,attribution:ActorAttribution,retryKeySha256:string|null=null):WikiConduitReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiConduitCreateInput(input),actor=this.wikiConduitActor(attribution),path=data.slug;this.wikiConduitRetryKey(retryKeySha256);
      if(!data.title.length || !data.content.length)throw new HttpError(400,'Documents must have a title and content.','WIKI_CONDUIT_REQUIRED');
      if(path.length>WIKI_WRITE_PATH_MAX_LENGTH)throw new HttpError(400,'New wiki paths must be at most 128 characters.');
      if(this.documentAtPath(path))throw new HttpError(409,'This wiki path is unavailable.','WIKI_PATH_CONFLICT');
      this.requireWikiAncestors(path);
      const now=new Date().toISOString(),document:WikiDocument={id:this.nextId('document','W'),title:data.title,slug:path,content:data.content,version:1,createdAt:now,updatedAt:now,location:{path,status:'active',movedToId:null}};
      this.save('document',document);this.writeWikiLocation(document.id,document.location!);
      const version=this.saveWikiVersion(document,{kind:'create',author:actor.displayName,attribution:actor,message:data.description,restoredFrom:null});
      const transaction=this.publishWikiState(document,version,version,undefined,'create',wikiConduitInputHash('phriction.create',data),data.description,actor);
      this.event(document.id,'created',`Saved document ${document.title}, version 1.`,actor);this.wikiChanged();
      return this.saveWikiConduitReceipt('phriction.create',data,document,actor,transaction.id,retryKeySha256);
    });
  }
  editConduitDocument(id:string,input:unknown,attribution:ActorAttribution,retryKeySha256:string|null=null):WikiConduitReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiConduitEditInput(input),actor=this.wikiConduitActor(attribution),current=this.get<WikiDocument>('document',id),head=this.rawWikiVersion(current.publication!.headVersionId);this.wikiConduitRetryKey(retryKeySha256);
      if(data.slug!==current.location!.path)throw new HttpError(409,'This wiki path does not match the selected document.','WIKI_PATH_CONFLICT');
      const hasTitle=wikiConduitEffectiveText(data.title),hasContent=wikiConduitEffectiveText(data.content);
      // Upstream validates proposed transactions against published content BEFORE
      // filtering no-effect transactions against title (published) and body (head).
      if(!(hasTitle?data.title!:current.title).length || !(hasContent?data.content!:current.content).length)throw new HttpError(400,'Documents must have a title and content.','WIKI_CONDUIT_REQUIRED');
      const titleChanged=hasTitle&&data.title!==current.title,contentChanged=hasContent&&data.content!==head.content;
      if(!titleChanged&&!contentChanged)return this.saveWikiConduitReceipt('phriction.edit',data,current,actor,null,retryKeySha256);
      const document:WikiDocument={...current,title:titleChanged?data.title!:current.title,content:contentChanged?data.content!:current.content,version:current.version+1,updatedAt:new Date().toISOString(),location:{...current.location!,status:'active',movedToId:null}};
      if(!Number.isSafeInteger(document.version))throw new HttpError(409,'This document has reached the supported version limit.');
      // Deliberately preserve the narrow historical edge: a nonempty submitted
      // body equal to a draft head is filtered, so a title effect can publish a
      // copy of an empty published marker. Native authored saves still reject it.
      const version=this.saveWikiVersion(document,{kind:'edit',author:actor.displayName,attribution:actor,message:data.description,restoredFrom:null});
      this.writeWikiLocation(id,document.location!);
      const transaction=this.publishWikiState(document,version,version,current,'edit',wikiConduitInputHash('phriction.edit',data),data.description,actor);
      this.event(id,'updated',`Saved document ${document.title}, version ${document.version}.`,actor);
      if(current.location!.status!==document.location!.status)this.wikiChanged();
      return this.saveWikiConduitReceipt('phriction.edit',data,document,actor,transaction.id,retryKeySha256);
    });
  }
  wikiConduitReceipt(id:string):WikiConduitReceipt {
    const row=this.database.prepare('SELECT document_id,selected_version_id,data FROM wiki_conduit_receipts WHERE id=?').get(id) as {document_id:string;selected_version_id:string;data:string}|undefined;
    if(!row)throw new HttpError(404,'The wiki Conduit receipt is unavailable.','WIKI_CONDUIT_RECEIPT_UNAVAILABLE');
    try {
      const receipt=JSON.parse(row.data) as WikiConduitReceipt;
      this.wikiConduitRetryKey(receipt.retryKeySha256);
      if(receipt.id!==id || receipt.documentId!==row.document_id || receipt.selectedVersionId!==row.selected_version_id || !['phriction.create','phriction.edit'].includes(receipt.method) || !/^[a-f0-9]{64}$/.test(receipt.inputSha256) || !Number.isFinite(Date.parse(receipt.createdAt)))throw new Error();
      if(!isDeepStrictEqual(receipt.attribution,this.wikiConduitActor(receipt.attribution)))throw new Error();
      const content=this.rawWikiVersion(receipt.selectedVersionId),publication=receipt.snapshot.publication,transaction=this.documentTransaction(receipt.documentId,publication.revision);
      if(content.documentId!==receipt.documentId || content.id!==publication.publishedVersionId || content.number!==publication.publishedVersion || canonicalWikiPath(content.slug)!==receipt.snapshot.location.path || !isDeepStrictEqual(transaction.after,receipt.snapshot))throw new Error();
      if(receipt.transactionId!==null && (receipt.transactionId!==transaction.id || transaction.kind!==(receipt.method==='phriction.create'?'create':'edit') || transaction.inputSha256!==receipt.inputSha256 || !isDeepStrictEqual(transaction.attribution,receipt.attribution) || transaction.newVersionId!==content.id || publication.headVersionId!==content.id || receipt.createdAt!==transaction.createdAt))throw new Error();
      if(receipt.method==='phriction.create' && (receipt.transactionId===null || transaction.before!==null || content.number!==1))throw new Error();
      return receipt;
    }catch{throw new HttpError(409,'The wiki Conduit receipt does not match immutable content.','WIKI_CONDUIT_RECEIPT_MISMATCH');}
  }
  wikiConduitContent(receiptId:string):WikiVersion {return this.rawWikiVersion(this.wikiConduitReceipt(receiptId).selectedVersionId);}
  createDocument(input: unknown, attribution?: ActorAttribution): WikiDocument { return this.documentMutation(() => this.writeDocument(input, undefined, null, attribution)); }
  updateDocument(id: string, input: unknown, attribution?: ActorAttribution): WikiDocument { return this.documentMutation(() => this.writeDocument(input, this.get<WikiDocument>('document', id), null, attribution)); }
  restoreDocument(id:string,input:unknown,attribution?:ActorAttribution):WikiDocument {
    return this.documentMutation(()=>{
      const data=parseWikiRestoreInput(input),current=this.get<WikiDocument>('document',id);this.checkWikiPins(current,data);
      const selected=this.documentVersion(id,data.version);wikiAuthoredContent(selected.content);
      return this.writeDocument({...optionalWikiPins(data),title:selected.title,slug:current.slug,content:selected.content,message:data.message},current,selected.number,attribution,wikiLifecycleInputHash('restore',input));
    });
  }
  private writeDocument(input:unknown,current?:WikiDocument,restoredFrom:number|null=null,attribution?:ActorAttribution,restoreHash?:string):WikiDocument {
    const data=parseWikiEditInput(input);
    if(current)this.checkWikiPins(current,data);
    else {if(data.expectedVersion!==undefined||data.expectedHeadVersionId!==undefined||data.expectedPublishedVersionId!==undefined||data.expectedPublicationRevision!==undefined)throw new HttpError(400,'Version pins are only used when updating a document.');if(data.expectedAccessEpoch!==undefined)this.docxEpoch(data.expectedAccessEpoch);}
    const path=data.slug;
    if(current&&path!==current.location!.path)throw new HttpError(409,'Use Move to transfer content to another path.','WIKI_MOVE_REQUIRED');
    if(!current){if(path.length>WIKI_WRITE_PATH_MAX_LENGTH)throw new HttpError(400,'New wiki paths must be at most 128 characters.');if(this.documentAtPath(path))throw new HttpError(409,'This wiki path is unavailable.','WIKI_PATH_CONFLICT');this.requireWikiAncestors(path);}
    const now=new Date().toISOString(),isDraft=restoredFrom===null&&!!current&&current.publication!.headVersionId!==current.publication!.publishedVersionId;
    const location:WikiLocation=isDraft&&data.title===current!.title?current!.location!:{path,status:'active',movedToId:null};
    const document:WikiDocument={id:current?.id??this.nextId('document','W'),title:data.title,slug:current?.slug??path,content:data.content,version:(current?.version??0)+1,createdAt:current?.createdAt??now,updatedAt:now,location};
    if(!Number.isSafeInteger(document.version))throw new HttpError(409,'This document has reached the supported version limit.');
    this.save('document',document);this.writeWikiLocation(document.id,location);
    const kind=restoredFrom!==null?'restore':isDraft?'draft':current?'edit':'create';
    const head=this.saveWikiVersion(document,{kind,author:attribution?.displayName??'You',...(attribution?{attribution}:{}),message:data.message,restoredFrom});
    const published=isDraft?this.rawWikiVersion(current!.publication!.publishedVersionId):head;
    this.publishWikiState(document,head,published,current,kind,restoreHash??wikiLifecycleInputHash(current?'edit':'create',input),data.message,attribution);
    this.event(document.id,restoredFrom!==null?'restored':isDraft?'draft_saved':current?'updated':'created',isDraft?`Saved document draft, version ${document.version}.`:restoredFrom===null?`Saved document ${document.title}, version ${document.version}.`:`Restored content from version ${restoredFrom} as version ${document.version}. Current slug retained.`,attribution);
    if(!current||current.location!.status!==location.status)this.wikiChanged();return document;
  }
  draftDocument(id:string,input:unknown,attribution?:ActorAttribution):WikiLifecycleReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiDraftInput(input),current=this.get<WikiDocument>('document',id);this.checkWikiPins(current,data,true);
      const document:WikiDocument={...current,title:data.title,content:data.content,version:current.version+1,updatedAt:new Date().toISOString(),location:data.title===current.title?current.location!:{...current.location!,status:'active',movedToId:null}};
      if(!Number.isSafeInteger(document.version))throw new HttpError(409,'This document has reached the supported version limit.');
      const head=this.saveWikiVersion(document,{kind:'draft',author:attribution?.displayName??'You',...(attribution?{attribution}:{}),message:data.message??'',restoredFrom:null});
      this.writeWikiLocation(id,document.location!);
      const transaction=this.publishWikiState(document,head,this.rawWikiVersion(current.publication!.publishedVersionId),current,'draft',wikiLifecycleInputHash('draft',input),data.message??'',attribution);
      if(current.location!.status!==document.location!.status)this.wikiChanged();
      this.event(id,'draft_saved',`Saved document draft, version ${head.number}.`,attribution);return {document,transaction};
    });
  }
  publishDocument(id:string,input:unknown,attribution?:ActorAttribution):WikiLifecycleReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiPublishInput(input),current=this.get<WikiDocument>('document',id);this.checkWikiPins(current,data,true);
      const target=this.rawWikiVersion(data.targetVersionId);if(target.documentId!==id)throw new HttpError(404,'The wiki content version is unavailable.','WIKI_VERSION_UNAVAILABLE');
      if(target.id===current.publication!.publishedVersionId)throw new HttpError(409,'This version is already published.','WIKI_ALREADY_PUBLISHED');
      const document:WikiDocument={...current,updatedAt:new Date().toISOString()},head=this.rawWikiVersion(current.publication!.headVersionId);
      const transaction=this.publishWikiState(document,head,target,current,'publish',wikiLifecycleInputHash('publish',input),data.message??'',attribution,null);
      this.event(id,'published',`Published content version ${target.number}.`,attribution);return {document,transaction};
    });
  }
  deleteDocument(id:string,input:unknown,attribution?:ActorAttribution):WikiLifecycleReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiDeleteInput(input),current=this.get<WikiDocument>('document',id);this.checkWikiPins(current,data,true);
      if(current.location!.status!=='active')throw new HttpError(409,'Only an active document can be deleted.','WIKI_SOURCE_INACTIVE');
      const document:WikiDocument={...current,content:'',version:current.version+1,updatedAt:new Date().toISOString(),location:{...current.location!,status:'deleted',movedToId:null}};
      if(!Number.isSafeInteger(document.version))throw new HttpError(409,'This document has reached the supported version limit.');
      const head=this.saveWikiVersion(document,{kind:'delete',author:attribution?.displayName??'You',...(attribution?{attribution}:{}),message:data.message??'',restoredFrom:null});this.writeWikiLocation(id,document.location!);
      const transaction=this.publishWikiState(document,head,head,current,'delete',wikiLifecycleInputHash('delete',input),data.message??'',attribution);
      this.event(id,'deleted','Deleted this document. Earlier content remains in history.',attribution);this.wikiChanged();return {document,transaction};
    });
  }
  moveDocument(id:string,input:unknown,attribution?:ActorAttribution):WikiMoveReceipt {
    return this.documentMutation(()=>{
      const data=parseWikiMoveInput(input); this.docxEpoch(data.expectedAccessEpoch);
      const current=this.get<WikiDocument>('document',id),head=this.documentVersion(id,current.version),existing=this.documentAtPath(data.destinationPath);
      if(current.version!==data.expectedVersion || head.id!==data.expectedSourceVersionId) throw new HttpError(409,'This document changed. Preview the move again.','WIKI_VERSION_CHANGED');
      if(data.expectedPublicationRevision!==undefined||data.expectedPublishedVersionId!==undefined||current.publication!.revision!==current.version||current.publication!.headVersionId!==current.publication!.publishedVersionId)this.checkWikiPins(current,{expectedVersion:data.expectedVersion,expectedHeadVersionId:data.expectedSourceVersionId,expectedPublicationRevision:data.expectedPublicationRevision,expectedPublishedVersionId:data.expectedPublishedVersionId,expectedAccessEpoch:data.expectedAccessEpoch},true);
      if(existing) {
        if(data.expectedDestinationPublicationRevision!==undefined||data.expectedDestinationPublishedVersionId!==undefined||existing.publication!.revision!==existing.version||existing.publication!.headVersionId!==existing.publication!.publishedVersionId) {
          if(data.expectedDestinationPublicationRevision!==existing.publication!.revision||data.expectedDestinationPublishedVersionId!==existing.publication!.publishedVersionId)throw new HttpError(409,'The destination publication changed. Preview the move again.','WIKI_DESTINATION_CHANGED');
        }
      }else if(data.expectedDestinationPublicationRevision!==undefined||data.expectedDestinationPublishedVersionId!==undefined)throw new HttpError(409,'The destination publication changed. Preview the move again.','WIKI_DESTINATION_CHANGED');
      if(current.location!.status!=='active') throw new HttpError(409,'Only an active document can be moved.','WIKI_SOURCE_INACTIVE');
      if(current.location!.path===data.destinationPath) throw new HttpError(409,'Choose a different destination path.','WIKI_PATH_CONFLICT');
      if((existing?.id??null)!==data.expectedDestinationId || (existing?.version??0)!==data.expectedDestinationVersion) throw new HttpError(409,'The destination changed. Preview the move again.','WIKI_DESTINATION_CHANGED');
      if(existing?.location!.status==='active') throw new HttpError(409,'The destination contains an active document.','WIKI_PATH_CONFLICT');
      if(!existing && data.destinationPath.length>WIKI_WRITE_PATH_MAX_LENGTH) throw new HttpError(400,'New wiki paths must be at most 128 characters.');
      this.requireWikiAncestors(data.destinationPath);
      const now=new Date().toISOString(),operationId=randomUUID(),destinationId=existing?.id??this.nextId('document','W');
      const move:WikiMoveProvenance={operationId,sourceId:id,destinationId,inputSha256:wikiMoveInputHash(data)};
      const source:WikiDocument={...current,content:'',version:current.version+1,updatedAt:now,location:{path:current.location!.path,status:'moved',movedToId:destinationId}};
      const destination:WikiDocument={id:destinationId,title:current.title,slug:existing?.slug??data.destinationPath,content:current.content,version:(existing?.version??0)+1,createdAt:existing?.createdAt??now,updatedAt:now,location:{path:data.destinationPath,status:'active',movedToId:null}};
      if(!Number.isSafeInteger(source.version)||!Number.isSafeInteger(destination.version)) throw new HttpError(409,'A document has reached the supported version limit.');
      this.save('document',destination);this.save('document',source);
      this.writeWikiLocation(destinationId,destination.location!);this.writeWikiLocation(id,source.location!);
      const metadata={author:attribution?.displayName??'You',...(attribution?{attribution}:{}),message:data.message??'',restoredFrom:null,move};
      const sourceVersion=this.saveWikiVersion(source,{...metadata,kind:'move_away'}),destinationVersion=this.saveWikiVersion(destination,{...metadata,kind:'move_to'});
      this.publishWikiState(source,sourceVersion,sourceVersion,current,'move_away',move.inputSha256,data.message??'',attribution);
      this.publishWikiState(destination,destinationVersion,destinationVersion,existing??undefined,'move_to',move.inputSha256,data.message??'',attribution);
      this.event(id,'moved_away','Moved document content to another path.',attribution);
      this.event(destinationId,'moved_to','Received moved document content.',attribution);this.wikiChanged();
      return {source,destination,sourceVersionId:sourceVersion.id,destinationVersionId:destinationVersion.id,operationId};
    });
  }
  wikiMoveReceipt(sourceId:string,sourceVersionId:string,destinationVersionId:string):WikiMoveReceipt {
    const read=(id:string):WikiVersion=>{const row=this.database.prepare('SELECT data FROM wiki_versions WHERE id=?').get(id) as JsonRow|undefined;if(!row)throw new HttpError(404,'Move evidence is unavailable.','WIKI_MOVE_UNAVAILABLE');return JSON.parse(row.data) as WikiVersion;};
    const source=read(sourceVersionId),destination=read(destinationVersionId);
    if(source.documentId!==sourceId || source.kind!=='move_away' || destination.kind!=='move_to' || !source.move || JSON.stringify(source.move)!==JSON.stringify(destination.move) || source.move.sourceId!==sourceId || source.move.destinationId!==destination.documentId || !source.location || !destination.location) throw new HttpError(409,'Move evidence does not match.','WIKI_MOVE_MISMATCH');
    const snapshot=(version:WikiVersion):WikiDocument=>{
      const row=this.database.prepare("SELECT id FROM wiki_transactions WHERE document_id=? AND json_extract(data,'$.newVersionId')=? AND json_extract(data,'$.kind')!='legacy'").get(version.documentId,version.id) as {id:string}|undefined;
      if(row)return this.wikiLifecycleReceipt(version.documentId,row.id).document;
      return {id:version.documentId,title:version.title,slug:version.slug,content:version.content,version:version.number,createdAt:this.get<WikiDocument>('document',version.documentId).createdAt,updatedAt:version.createdAt,location:version.location!};
    };
    return {source:snapshot(source),destination:snapshot(destination),sourceVersionId,destinationVersionId,operationId:source.move.operationId};
  }
  private wikiNotificationContext(publication: WikiPublication): Extract<NotificationContext, { kind: 'wiki' }> {
    return { kind: 'wiki', publicationRevision: publication.revision, headVersionId: publication.headVersionId, headVersion: publication.headVersion, publishedVersionId: publication.publishedVersionId, publishedVersion: publication.publishedVersion };
  }
  /** The policy layer calls this only after an existing destination's copied view/edit policy changes. */
  notifyWikiMovePolicy(receipt: WikiMoveReceipt, attribution: ActorAttribution): void {
    const canonical = this.wikiMoveReceipt(receipt.source.id, receipt.sourceVersionId, receipt.destinationVersionId);
    if (!isDeepStrictEqual(canonical, receipt) || canonical.destination.version === 1 || !canonical.destination.publication) throw new HttpError(409, 'Wiki move evidence does not match.', 'WIKI_MOVE_MISMATCH');
    this.notifications.emit({ objectId: canonical.destination.id, kind: 'wiki_policy_changed', cause: { type: 'wiki_move_policy', id: canonical.operationId }, attribution, createdAt: canonical.destination.updatedAt, context: this.wikiNotificationContext(canonical.destination.publication) });
  }
  private saveWikiVersion(document: WikiDocument, metadata: Pick<WikiVersion, 'kind' | 'author' | 'message' | 'restoredFrom' | 'attribution' | 'move'>): WikiVersion {
    const version: WikiVersion = { id: randomUUID(), documentId: document.id, number: document.version, title: document.title,
      slug: document.slug, content: document.content, createdAt: document.updatedAt, ...(document.location?{location:document.location}:{}), ...metadata };
    this.database.prepare('INSERT INTO wiki_versions (id, document_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, document.id, version.number, JSON.stringify(version));
    this.wikiSearch?.ensureContent(version.id);
    return version;
  }
  documentHistory(id: string, options: { before?: number; limit?: number } = {}): WikiHistory {
    this.get<WikiDocument>('document', id);
    const before = options.before === undefined ? null : integer(options.before, 'before');
    const limit = options.limit === undefined ? 20 : integer(options.limit, 'limit');
    if (limit > 100) throw new HttpError(400, 'limit must be at most 100.');
    const rows = this.database.prepare("SELECT json_remove(data, '$.content') AS data FROM wiki_versions WHERE document_id = ? AND (? IS NULL OR number < ?) ORDER BY number DESC LIMIT ?").all(id, before, before, limit + 1) as JsonRow[];
    const versions = rows.slice(0, limit).map(row => JSON.parse(row.data) as WikiVersionSummary);
    const first = this.database.prepare('SELECT MIN(number) AS number FROM wiki_versions WHERE document_id = ?').get(id) as { number: number };
    return { versions, nextBefore: rows.length > limit ? versions[versions.length - 1]!.number : null, firstAvailableVersion: first.number };
  }
  documentVersion(id: string, number: number): WikiVersion {
    this.get<WikiDocument>('document', id);
    integer(number, 'version');
    const row = this.database.prepare('SELECT data FROM wiki_versions WHERE document_id = ? AND number = ?').get(id, number) as JsonRow | undefined;
    if (!row) throw new HttpError(404, `Version ${number} of document ${id} was not found.`);
    return JSON.parse(row.data) as WikiVersion;
  }
  documentDetail(id: string): WikiDetail {
    const document=this.get<WikiDocument>('document',id);return {document,head:this.rawWikiVersion(document.publication!.headVersionId),lifecycle:this.documentTransactions(id),history:this.documentHistory(id),activity:this.activities(id)};
  }
  private notificationVersionHead(id: string, versionId: string) {
    const row = this.database.prepare("SELECT number,json_extract(data,'$.contentHash') AS contentHash FROM versions WHERE revision_id=? AND id=?").get(id, versionId) as { number: number; contentHash: string } | undefined;
    if (!row) throw new HttpError(409, 'Notification source identity is unavailable.', 'NOTIFICATION_INVALID_RECEIPT');
    return { versionId, number: row.number, contentHash: row.contentHash };
  }
  private notifyRevisionSource(id: string, kind: 'created' | 'source_updated', attribution?: ActorAttribution): void {
    const head = this.revisionAuthorship.snapshot(id).head; this.notifications.emit({ revisionId: id, kind, cause: { type: 'source', id: head.versionId }, attribution });
  }
  createRevision(input: unknown, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => this.createRevisionRecord(input, attribution));
  }
  private docxActor(attribution: ActorAttribution): ActorAttribution {
    if (!attribution || typeof attribution.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(attribution.principalId)
      || typeof attribution.displayName !== 'string' || !attribution.displayName.trim() || attribution.displayName.length > 240
      || typeof attribution.requestId !== 'string' || !attribution.requestId || attribution.requestId.length > 240
      || (attribution.credentialId !== null && typeof attribution.credentialId !== 'string')) throw new HttpError(400, 'DOCX writes require authenticated attribution.');
    return { ...attribution };
  }
  private docxEpoch(expected: number): void {
    if (expected !== (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value) throw new HttpError(409, 'Access changed. Reload the document before continuing.', 'ACCESS_EPOCH_CHANGED');
  }
  private docxFile(source: DocxFileIdentity, active: boolean): FileRecord {
    const file = this.files.get(source.fileId);
    if (file.sha256 !== source.sha256 || file.bytes !== source.bytes) throw docxMismatch();
    this.files.readBytes(file.id);
    if (active && file.status !== 'active') throw new HttpError(409, 'Restore the source File before importing it.', 'DOCX_FILE_ARCHIVED');
    return file;
  }
  private docxSource(bytes: Uint8Array, projection: DocxProjection, fileName: string, sourceFile: DocxFileIdentity): DocxSource {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > DOCX_LIMITS.compressedBytes) throw docxMismatch();
    const source: DocxSource = { format: 'docx', fileName, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, sourceFile: { ...sourceFile }, projection };
    try { validateDocxSource(source); } catch { throw docxMismatch(); }
    // Detach caller-owned projection objects before retaining authoritative data.
    return JSON.parse(JSON.stringify(source)) as DocxSource;
  }
  private attachDocxSource(id: string, source: DocxFileIdentity, share: boolean, actor: ActorAttribution): void {
    if (!share) return;
    const current = this.files.attachment(source.fileId, id);
    if (current?.mode === 'attach') return;
    this.files.setAttachment(source.fileId, { objectId: id, mode: 'attach', expectedVersion: current?.version ?? 0 }, actor);
    this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
  }
  private saveDocxVersion(revision: Revision, source: DocxSource, bytes: Uint8Array, message: string, actor: ActorAttribution, operation: NonNullable<RevisionVersion['docxOperation']>, transcriptEdit?: TranscriptSourceEdit): RevisionVersion {
    const version: RevisionVersion = { ...(transcriptEdit ? { transcriptEdit } : {}), id: randomUUID(), revisionId: revision.id, number: revision.currentVersion, files: [], docx: source, docxOperation: operation, message, contentHash: contentHash([], [], source), createdAt: new Date().toISOString(), attribution: actor };
    this.database.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)').run(version.id, revision.id, version.number, JSON.stringify(version));
    this.database.prepare('INSERT INTO revision_docx_packages(version_id,sha256,byte_size,data) VALUES(?,?,?,?)').run(version.id, source.sha256, source.bytes, bytes);
    if (version.number === 1) { this.revisionAuthorship.ensure(revision.id); this.revisionLifecycle.ensure(revision.id, revision.status !== 'draft'); this.revisionReviewers.ensure(revision.id); }
    else this.revisionLifecycle.sourceUpdated(revision.id, actor);
    return version;
  }
  /** Internal commit boundary: projection must come from the isolated DOCX parser, never HTTP input. */
  createDocxRevision(input: DocxImportInput, bytes: Uint8Array, projection: DocxProjection, attribution: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = parseDocxImportInput(input), actor = this.docxActor(attribution); this.docxEpoch(data.expectedAccessEpoch);
      const metadata = this.revisionMetadata.creationFields(data), projectIds = this.revisionProjects.creationTags(data);
      const file = this.docxFile(data.sourceFile, true), source = this.docxSource(bytes, projection, file.originalName, data.sourceFile);
      if (source.sha256 !== file.sha256 || source.bytes !== file.bytes || !Buffer.from(bytes).equals(this.files.readBytes(file.id))) throw docxMismatch();
      const now = new Date().toISOString();
      const revision: Revision = { id: this.nextId('revision', 'L'), title: metadata.title, summary: metadata.summary, kind: 'document', status: data.draft ? 'draft' : 'needs_review', repositoryId: null, projectId: projectIds[0] ?? null, currentVersion: 1, createdAt: now, updatedAt: now };
      this.save('revision', revision); this.attachDocxSource(revision.id, data.sourceFile, data.shareSource, actor);
      this.saveDocxVersion(revision, source, bytes, 'Imported Word document', actor, { kind: 'import', inputSha256: docxOperationHash(data) });
      this.revisionMetadata.ensure(revision.id, metadata); this.revisionProjects.ensure(revision.id, projectIds);
      this.event(revision.id, 'created', 'Imported Word document as version 1.', actor); this.notifyRevisionSource(revision.id, 'created', actor);
      return this.detail(revision.id);
    });
  }
  /** Fresh operations only. Idempotent saved receipts bypass current-head checks. */
  requireDocxVersion(id: string, input: DocxVersionPins): RevisionVersion {
    const pins = docxPins(input as unknown as Record<string, unknown>); this.docxEpoch(pins.expectedAccessEpoch);
    const detail = this.requireVersion(id, pins.expectedVersion), version = detail.versions.find(item => item.number === pins.expectedVersion);
    if (!version?.docx) throw docxUnsupported();
    if (version.id !== pins.expectedVersionId || version.contentHash !== pins.expectedContentHash) throw docxMismatch();
    this.docxBytes(id, version.id);
    return version;
  }
  docxBytes(id: string, versionId: string): Uint8Array {
    this.get<Revision>('revision', id);
    const row = this.database.prepare('SELECT v.id,v.number,v.data,p.sha256,p.byte_size,p.data AS bytes FROM versions v JOIN revision_docx_packages p ON p.version_id=v.id WHERE v.revision_id=? AND v.id=?').get(id, versionId) as { id: string; number: number; data: string; sha256: string; byte_size: number; bytes: Uint8Array } | undefined;
    if (!row) throw new HttpError(404, 'The selected Word document version is unavailable.', 'DOCX_VERSION_UNAVAILABLE');
    const version = JSON.parse(row.data) as RevisionVersion;
    try {
      if (!version.docx || version.id !== row.id || version.revisionId !== id || version.number !== row.number || !Array.isArray(version.files) || version.files.length || version.assets !== undefined || version.gitSource !== undefined
        || contentHash(version.files, version.assets, version.docx) !== version.contentHash || version.docx.sha256 !== row.sha256 || version.docx.bytes !== row.byte_size
        || row.bytes.byteLength !== row.byte_size || createHash('sha256').update(row.bytes).digest('hex') !== row.sha256) throw docxMismatch();
    } catch { throw docxMismatch(); }
    return Uint8Array.from(row.bytes);
  }
  /** Internal commit boundary: projection is the parser's verified interpretation of bytes. */
  createDocxVersion(id: string, input: DocxReimportInput, bytes: Uint8Array, projection: DocxProjection, attribution: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = parseDocxReimportInput(input), actor = this.docxActor(attribution); this.requireDocxVersion(id, data);
      const file = this.docxFile(data.sourceFile, true), source = this.docxSource(bytes, projection, file.originalName, data.sourceFile);
      if (source.sha256 !== file.sha256 || source.bytes !== file.bytes || !Buffer.from(bytes).equals(this.files.readBytes(file.id))) throw docxMismatch();
      const revision = this.get<Revision>('revision', id);
      if (!Number.isSafeInteger(revision.currentVersion + 1)) throw new HttpError(409, 'The supported version limit was reached.');
      revision.currentVersion++; revision.updatedAt = new Date().toISOString();
      this.save('revision', revision); this.attachDocxSource(id, data.sourceFile, data.shareSource, actor);
      this.saveDocxVersion(revision, source, bytes, data.message, actor, { kind: 'reimport', inputSha256: docxOperationHash(data) });
      this.event(id, 'version_created', `Imported Word document as version ${revision.currentVersion}. Previous acceptance no longer applies.`, actor); this.notifyRevisionSource(id, 'source_updated', actor);
      return this.detail(id);
    });
  }
  /** Internal commit boundary: bytes/projection are returned together by the isolated replacement engine. */
  replaceDocxVersion(id: string, input: DocxReplaceInput, bytes: Uint8Array, projection: DocxProjection, attribution: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = parseDocxReplaceInput(input), actor = this.docxActor(attribution), current = this.requireDocxVersion(id, data), original = current.docx!;
      this.docxFile(original.sourceFile, false);
      const range = original.projection.editableRanges.find(item => item.id === data.rangeId);
      const split = (offset: number) => { const previous = range?.text.charCodeAt(offset - 1), next = range?.text.charCodeAt(offset); return previous !== undefined && previous >= 0xd800 && previous <= 0xdbff && next !== undefined && next >= 0xdc00 && next <= 0xdfff; };
      if (!range || data.end > range.text.length || split(data.start) || split(data.end) || range.text.slice(data.start, data.end) !== data.quote) throw new HttpError(409, 'The selected editable Word text no longer matches.', 'DOCX_RANGE_MISMATCH');
      const source = this.docxSource(bytes, projection, original.fileName, original.sourceFile);
      if (data.quote === data.replacement) {
        if (contentHash([], [], source) !== current.contentHash || !Buffer.from(bytes).equals(this.docxBytes(id, current.id))) throw docxMismatch();
        return this.detail(id);
      }
      if (source.sha256 === original.sha256) throw docxMismatch();
      const revision = this.get<Revision>('revision', id);
      if (!Number.isSafeInteger(revision.currentVersion + 1)) throw new HttpError(409, 'The supported version limit was reached.');
      revision.currentVersion++; revision.updatedAt = new Date().toISOString();
      this.save('revision', revision); this.saveDocxVersion(revision, source, bytes, data.message, actor, { kind: 'replace', inputSha256: docxOperationHash(data) });
      this.event(id, 'version_created', `Edited Word document as version ${revision.currentVersion}. Previous acceptance no longer applies.`, actor); this.notifyRevisionSource(id, 'source_updated', actor);
      return this.detail(id);
    });
  }
  /** Only the verified server collector may supply Git provenance. */
  createRevisionFromGit(repositoryId: string, input: unknown, snapshot: GitImportSnapshot, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = gitImportInput(input);
      const { source, gitSource } = this.verifiedGitSnapshot(repositoryId, data.commitId, snapshot);
      return this.createRevisionRecord({ title: data.title, summary: data.summary, ...(data.testPlan === undefined ? {} : { testPlan: data.testPlan }), kind: data.kind, ...parseRevisionProjectCreation(data), repositoryId, files: source, ...(data.draft === undefined ? {} : { draft: data.draft }) }, attribution, gitSource);
    });
  }
  private verifiedGitSnapshot(repositoryId: string, commitId: string, snapshot: GitImportSnapshot): { source: SourceFile[]; gitSource: GitSourceProvenance } {
    const invalid = () => new HttpError(422, 'The Git snapshot could not be verified for import.', 'GIT_INVALID_OBJECT');
    const source = files(snapshot.files); const provenance = snapshot.provenance;
    if (snapshot.repositoryId !== repositoryId || !['sha1', 'sha256'].includes(snapshot.objectFormat)
      || !provenance || provenance.kind !== 'git' || provenance.repositoryId !== repositoryId || provenance.objectFormat !== snapshot.objectFormat
      || provenance.commitId !== commitId || !isGitObjectId(provenance.commitId, snapshot.objectFormat) || !isGitObjectId(provenance.treeId, snapshot.objectFormat)
      || provenance.scope !== 'complete-text-tree' || !Array.isArray(provenance.manifest) || provenance.manifest.length !== source.length) throw invalid();
    const manifest = source.map((file, index) => {
      const entry = provenance.manifest[index]; const bytes = Buffer.from(file.content, 'utf8');
      if (!entry || entry.path !== file.path || !['100644', '100755'].includes(entry.mode) || !isGitObjectId(entry.objectId, snapshot.objectFormat)
        || bytes.length > GIT_LIMITS.blobBytes || /[\uD800-\uDFFF]/u.test(file.content)
        || createHash(snapshot.objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.objectId) throw invalid();
      return { path: entry.path, mode: entry.mode, objectId: entry.objectId };
    });
    return { source, gitSource: { kind: 'git', repositoryId, objectFormat: snapshot.objectFormat, commitId, treeId: provenance.treeId, scope: 'complete-text-tree', manifest } };
  }
  /** Fresh-operation pins only: saved retries must bypass these head checks. */
  requireGitImportVersion(id: string, input: unknown): RevisionDetail {
    const data = gitVersionImportInput(input); const detail = this.requireVersion(id, data.expectedVersion);
    const current = detail.versions.find(version => version.number === detail.revision.currentVersion);
    if (current?.docx) throw docxUnsupported();
    if (!detail.revision.repositoryId) throw new HttpError(400, 'This revision is not linked to a repository.', 'GIT_IMPORT_UNLINKED');
    const actualHash = current ? contentHash(current.files, current.assets) : null;
    if (!current || current.revisionId !== id || current.id !== data.expectedVersionId || actualHash !== data.expectedContentHash || actualHash !== current.contentHash) throw new HttpError(409, 'The selected current source does not match this revision. Reload before importing.');
    if (current.assets?.length) throw new HttpError(409, 'A Git text-tree import cannot replace a version containing figures. Explicitly remove the figures in a new version before importing.', 'GIT_IMPORT_ASSETS');
    if (!Number.isSafeInteger(detail.revision.currentVersion + 1)) throw new HttpError(409, 'This revision has reached the supported version limit.');
    return detail;
  }
  createVersionFromGit(id: string, input: unknown, snapshot: GitImportSnapshot, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = gitVersionImportInput(input); const { revision } = this.requireGitImportVersion(id, data);
      if (revision.repositoryId !== snapshot.repositoryId) throw new HttpError(409, 'The linked source repository changed. Reload before importing.');
      const { source, gitSource } = this.verifiedGitSnapshot(revision.repositoryId!, data.commitId, snapshot);
      revision.currentVersion += 1; revision.updatedAt = new Date().toISOString();
      this.save('revision', revision); this.saveVersion(revision, source, data.message, attribution, gitSource);
      this.event(id, 'version_created', `Imported Git commit ${gitSource.commitId} as version ${revision.currentVersion}. Previous acceptance no longer applies.`, attribution); this.notifyRevisionSource(id, 'source_updated', attribution);
      return this.detail(id);
    });
  }
  private createRevisionRecord(input: unknown, attribution?: ActorAttribution, gitSource?: GitSourceProvenance): RevisionDetail {
    const data = object(input, ['title', 'summary', 'testPlan', 'kind', 'files', 'assets', 'shareAssets', 'expectedAccessEpoch', 'repositoryId', 'projectId', 'projectIds', 'draft']);
    if (data.draft !== undefined && typeof data.draft !== 'boolean') throw new HttpError(400, 'draft must be a boolean.');
    const kind = choice(data.kind, 'kind', ['code', 'paper', 'document']);
    const metadata = this.revisionMetadata.creationFields({ title: data.title, summary: data.summary, testPlan: data.testPlan }), projectIds = this.revisionProjects.creationTags(data);
    const source = files(data.files);
    const assets = this.sourceAssets(source, data.assets ?? [], []);
    const now = new Date().toISOString();
    const revision: Revision = { id: this.nextId('revision', kind === 'code' ? 'D' : kind === 'paper' ? 'P' : 'L'), title: metadata.title, summary: metadata.summary, kind, status: data.draft ? 'draft' : 'needs_review', repositoryId: this.reference(data.repositoryId, 'repository'), projectId: projectIds[0] ?? null, currentVersion: 1, createdAt: now, updatedAt: now };
    this.save('revision', revision); this.shareSourceAssets(revision.id, assets, [], data.shareAssets, attribution);
    this.saveVersion(revision, source, 'Initial version', attribution, gitSource, assets); this.revisionMetadata.ensure(revision.id, metadata); this.revisionProjects.ensure(revision.id, projectIds); this.event(revision.id, 'created', `Created ${kind === 'paper' ? 'paper' : 'revision'} ${revision.title}.`, attribution); this.notifyRevisionSource(revision.id, 'created', attribution); return this.detail(revision.id);
  }
  private sourceAssets(source: SourceFile[], input: unknown, previous: RevisionAsset[]): RevisionAsset[] {
    const resolved = this.files.resolveAssets(input);
    const assets = resolved.map(({ data: _bytes, ...asset }) => asset);
    const known = new Set(previous.map(asset => asset.fileId));
    for (const asset of assets) if (!known.has(asset.fileId) && this.files.get(asset.fileId).status === 'archived') throw new HttpError(409, 'Archived files cannot be added to a new figure binding.');
    // Preserve legacy text-only namespaces. Combined source must be portable
    // across the browser, CLI, and isolated compiler filesystem.
    if (assets.length) try { validateSourceSnapshot(source, assets); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid source paths.'); }
    return assets;
  }
  private shareSourceAssets(id: string, assets: RevisionAsset[], previous: RevisionAsset[], share: unknown, attribution?: ActorAttribution): void {
    const known = new Set(previous.map(asset => asset.fileId));
    for (const fileId of new Set(assets.map(asset => asset.fileId))) {
      if (known.has(fileId) && share !== true) continue;
      const binding = this.files.attachment(fileId, id);
      if (binding?.mode === 'attach') continue;
      if (share !== true || !attribution) throw new HttpError(400, 'Explicitly share new figures with this revision before saving.');
      this.files.setAttachment(fileId, { objectId: id, mode: 'attach', expectedVersion: binding?.version ?? 0 }, attribution);
      this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
    }
  }
  private saveVersion(revision: Revision, source: SourceFile[], message: string, attribution?: ActorAttribution, gitSource?: GitSourceProvenance, assets: RevisionAsset[] = [], transcriptEdit?: TranscriptSourceEdit): RevisionVersion {
    const version: RevisionVersion = { ...(transcriptEdit ? { transcriptEdit } : {}), ...(attribution ? { attribution } : {}), ...(gitSource ? { gitSource } : {}), ...(assets.length ? { assets } : {}), id: randomUUID(), revisionId: revision.id, number: revision.currentVersion, files: source, message, contentHash: contentHash(source, assets), createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, revision.id, version.number, JSON.stringify(version));
    if (version.number === 1) { this.revisionAuthorship.ensure(revision.id); this.revisionLifecycle.ensure(revision.id, revision.status !== 'draft'); this.revisionReviewers.ensure(revision.id); }
    else this.revisionLifecycle.sourceUpdated(revision.id, attribution);
    return version;
  }
  requireVersion(id: string, expected: unknown): RevisionDetail {
    const version = integer(expected, 'expectedVersion'); const detail = this.detail(id);
    if (detail.revision.currentVersion !== version) throw new HttpError(409, 'This revision changed. Reload before continuing.');
    return detail;
  }
  /** Fresh writes only; saved receipts remain bound to their original source after later changes. */
  requireTranscriptEditVersion(id: string, input: TranscriptEditInput): RevisionVersion {
    const data = transcriptEditInput(input);
    if (data.revisionId !== id) throw new HttpError(400, 'The transcript edit names another revision.', 'TRANSCRIPT_EDIT_INVALID');
    this.docxEpoch(data.expectedAccessEpoch);
    const detail = this.requireVersion(id, data.expectedVersion), current = detail.versions.find(item => item.number === data.expectedVersion);
    try {
      if (!current || contentHash(current.files, current.assets, current.docx) !== current.contentHash) throw new Error('The original source cannot be verified.');
      validateTranscriptEditTarget(current, data);
    } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'The selected source changed.', 'TRANSCRIPT_SOURCE_CHANGED'); }
    if (createHash('sha256').update(data.replacement).digest('hex') !== data.origin.editedTextSha256) throw new HttpError(400, 'The replacement does not match the edited transcript digest.', 'TRANSCRIPT_EDIT_DIGEST_MISMATCH');
    if (current.docx) { this.docxBytes(id, current.id); this.docxFile(current.docx.sourceFile, false); }
    return current;
  }
  /** The HTTP input contains neither files nor Word projections; the server derives a new immutable version. */
  createTranscriptEdit(id: string, input: TranscriptEditInput, attribution: ActorAttribution, editedWord?: { bytes: Uint8Array; projection: DocxProjection }): RevisionDetail {
    return this.discussionMutation(() => {
      const data = transcriptEditInput(input), current = this.requireTranscriptEditVersion(id, data), actor = this.docxActor(attribution);
      const provenance = transcriptSourceEdit(data, transcriptEditInputHash(data));
      let source: SourceFile[] | undefined, docx: DocxSource | undefined;
      if (data.target.kind === 'docx') {
        if (!editedWord || !current.docx) throw new HttpError(409, 'The prepared Word replacement is unavailable.', 'TRANSCRIPT_SOURCE_CHANGED');
        docx = this.docxSource(editedWord.bytes, editedWord.projection, current.docx.fileName, current.docx.sourceFile);
        if (docx.sha256 === current.docx.sha256) throw new HttpError(409, 'The prepared Word package did not change.', 'TRANSCRIPT_SOURCE_CHANGED');
      } else {
        if (editedWord) throw new HttpError(400, 'A text replacement cannot carry Word bytes.', 'TRANSCRIPT_EDIT_INVALID');
        source = files(applyTranscriptTextEdit(current, data));
        this.sourceAssets(source, current.assets ?? [], current.assets ?? []);
      }
      const revision = this.get<Revision>('revision', id);
      if (!Number.isSafeInteger(revision.currentVersion + 1)) throw new HttpError(409, 'The supported version limit was reached.');
      revision.currentVersion++; revision.updatedAt = new Date().toISOString(); this.save('revision', revision);
      if (docx && editedWord) this.saveDocxVersion(revision, docx, editedWord.bytes, data.message, actor, { kind: 'replace', inputSha256: docxOperationHash(transcriptDocxReplacement(data)) }, provenance);
      else this.saveVersion(revision, source!, data.message, actor, undefined, current.assets ?? [], provenance);
      this.event(id, 'version_created', `Applied an explicit transcript replacement as version ${revision.currentVersion}. Previous acceptance no longer applies.`, actor);
      this.notifyRevisionSource(id, 'source_updated', actor);
      return this.detail(id);
    });
  }
  createVersion(id: string, input: unknown, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const data = object(input, ['files', 'assets', 'message', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', 'shareAssets']);
      const { revision, versions } = this.requireVersion(id, data.expectedVersion);
      const current = versions.find(version => version.number === revision.currentVersion)!;
      if (current.docx) throw docxUnsupported();
      const source = files(data.files); const message = string(data.message, 'Message', 10_000);
      const assets = this.sourceAssets(source, data.assets === undefined ? current.assets ?? [] : data.assets, current.assets ?? []);
      if (data.assets !== undefined && (data.expectedVersionId !== current.id || data.expectedContentHash !== current.contentHash || contentHash(current.files, current.assets) !== current.contentHash)) throw new HttpError(409, 'Figure changes require the exact reviewed source version. Reload before continuing.');
      this.shareSourceAssets(id, assets, current.assets ?? [], data.shareAssets, attribution);
      if (!Number.isSafeInteger(revision.currentVersion + 1)) throw new HttpError(409, 'This revision has reached the supported version limit.');
      revision.currentVersion += 1; revision.updatedAt = new Date().toISOString();
      this.save('revision', revision); this.saveVersion(revision, source, message, attribution, undefined, assets); this.event(id, 'version_created', `Uploaded version ${revision.currentVersion}. Previous acceptance no longer applies.`, attribution); this.notifyRevisionSource(id, 'source_updated', attribution); return this.detail(id);
    });
  }
  updateRevision(id: string, input: unknown, attribution?: ActorAttribution): Revision {
    void id; void input; void attribution;
    throw new HttpError(409, 'Choose an explicit revision lifecycle action with exact source and lifecycle pins.', 'REVISION_LIFECYCLE_ACTION_REQUIRED');
  }
  /** A bounded read snapshot; callers must enforce current revision/source visibility. */
  docxDiscussion(id: string, input: unknown): { input: DocxDiscussionExportInput; version: RevisionVersion; bytes: Uint8Array; comments: DocxPackageComment[] } {
    const data = object(input, ['versionId', 'contentHash', 'expectedAccessEpoch', 'threads']);
    const versionId = string(data.versionId, 'Version ID', 100);
    const hash = string(data.contentHash, 'Content hash', 64);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(400, 'Choose an exact content hash.');
    if (!Number.isSafeInteger(data.expectedAccessEpoch) || (data.expectedAccessEpoch as number) < 0) throw new HttpError(400, 'Choose a valid access epoch.');
    if (!Array.isArray(data.threads) || !data.threads.length || data.threads.length > DOCX_DISCUSSION_LIMITS.threads) throw new HttpError(400, 'Select between 1 and 64 discussion threads.');
    const threads = data.threads.map(value => {
      const pin = object(value, ['threadId', 'expectedThreadVersion']);
      return { threadId: string(pin.threadId, 'Thread ID', 100), expectedThreadVersion: integer(pin.expectedThreadVersion, 'expectedThreadVersion') };
    });
    if (new Set(threads.map(pin => pin.threadId)).size !== threads.length) throw new HttpError(400, 'Choose each discussion thread once.');
    this.docxEpoch(data.expectedAccessEpoch as number);
    const version = this.commentVersion(id, versionId);
    if (!version.docx || version.contentHash !== hash) throw docxMismatch();
    const bytes = this.docxBytes(id, versionId);
    let bodyLength = 0;
    const viewedVersions = new Set([versionId]);
    const changed = () => new HttpError(409, 'The selected discussion changed or does not belong to this exact Word version.', 'DOCX_DISCUSSION_CHANGED');
    const comments = threads.map(pin => {
      const thread = this.thread(id, pin.threadId);
      if (thread.version !== pin.expectedThreadVersion) throw changed();
      const rootRow = this.database.prepare('SELECT data FROM comments WHERE revision_id=? AND id=?').get(id, thread.rootCommentId) as JsonRow | undefined;
      const root = rootRow ? JSON.parse(rootRow.data) as ReviewComment : undefined;
      if (!root || root.id !== thread.rootCommentId || root.threadId !== thread.id || root.versionId !== versionId || !root.docxAnchor || !validDocxPassageAnchor(root.docxAnchor, version)) throw changed();
      const pieces = [`Application discussion ${thread.id}\nStatus: ${thread.status}\nOriginal version: ${versionId} (v${version.number})\nThis is a transcript of the selected application thread, not a native Word reply or resolved-state record.`];
      bodyLength += pieces[0]!.length;
      let count = 0;
      const statement = this.database.prepare("SELECT data FROM comments WHERE revision_id=? AND (id=? OR json_extract(data,'$.threadId')=?) ORDER BY rowid");
      for (const row of statement.iterate(id, root.id, thread.id) as Iterable<JsonRow>) {
        const comment = JSON.parse(row.data) as ReviewComment;
        if (comment.revisionId !== id || comment.versionId !== versionId || comment.threadId !== thread.id || !comment.docxAnchor
          || !isDeepStrictEqual(comment.docxAnchor, root.docxAnchor) || (count === 0 && comment.id !== root.id)) throw changed();
        const viewed = comment.viewedVersionId ?? versionId;
        if (!viewedVersions.has(viewed)) {
          if (typeof viewed !== 'string' || viewed.length > 100 || !this.database.prepare('SELECT 1 FROM versions WHERE revision_id=? AND id=?').get(id, viewed)) throw changed();
          viewedVersions.add(viewed);
        }
        const piece = `\n\nMessage ${++count} (${comment.id})\nAuthor: ${JSON.stringify(comment.author)}\nPrincipal: ${comment.attribution?.principalId ?? 'unrecorded legacy author'}\nDate: ${comment.createdAt}\nViewed version: ${viewed}\n\n${comment.body}`;
        bodyLength += piece.length;
        if (bodyLength > DOCX_DISCUSSION_LIMITS.bodyLength) throw new HttpError(413, 'The complete selected discussions exceed the Word export text limit. Select fewer threads.', 'DOCX_DISCUSSION_LIMIT');
        pieces.push(piece);
      }
      if (!count) throw changed();
      return { passage: { rangeId: root.docxAnchor.rangeId, start: root.docxAnchor.start, end: root.docxAnchor.end, quote: root.docxAnchor.quote }, author: root.author, date: root.createdAt, body: pieces.join('') };
    });
    return { input: { versionId, contentHash: hash, expectedAccessEpoch: data.expectedAccessEpoch as number, threads }, version, bytes, comments };
  }
  private privateReviewCommentInput(payload: Exclude<ReviewDraftPayload, { kind: 'reply' }>): unknown {
    return { body: payload.body, versionId: payload.versionId, ...(payload.kind === 'summary' ? {} : payload.docxPassage ? { docxPassage: payload.docxPassage } : { filePath: payload.filePath, line: payload.line, ...(payload.passage ? { passage: payload.passage } : {}), ...(payload.suggestion ? { suggestion: payload.suggestion } : {}) }) };
  }
  private validatePrivateReviewPayload(id: string, payload: ReviewDraftPayload): PreparedReviewDraft {
    const version = this.commentVersion(id, payload.kind === 'reply' ? payload.viewedVersionId : payload.versionId);
    if (version.contentHash !== (payload.kind === 'reply' ? payload.viewedContentHash : payload.contentHash)) throw new HttpError(409, 'The private draft source hash does not match its immutable version.', 'REVIEW_DRAFT_CHANGED');
    if (payload.kind === 'reply') {
      const thread = this.thread(id, payload.threadId);
      const row = this.database.prepare('SELECT data FROM comments WHERE revision_id=? AND id=?').get(id, thread.rootCommentId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'Discussion thread was not found.', 'THREAD_UNAVAILABLE');
      const root = JSON.parse(row.data) as ReviewComment, original = this.commentVersion(id, root.versionId);
      return { sources: [{ versionId: version.id, contentHash: version.contentHash }, { versionId: original.id, contentHash: original.contentHash }], comment: { body: payload.body, threadId: thread.id, versionId: root.versionId, viewedVersionId: version.id, filePath: root.filePath, line: root.line, ...(root.anchor ? { anchor: root.anchor } : {}), ...(root.docxAnchor ? { docxAnchor: root.docxAnchor } : {}) } };
    }
    const prepared = this.prepareComment(id, this.privateReviewCommentInput(payload));
    return { sources: [{ versionId: version.id, contentHash: version.contentHash }], comment: { body: prepared.body, versionId: version.id, filePath: prepared.filePath, line: prepared.line, ...(prepared.anchor ? { anchor: prepared.anchor } : {}), ...(prepared.docxAnchor ? { docxAnchor: prepared.docxAnchor } : {}), ...(prepared.suggestion ? { suggestion: prepared.suggestion } : {}) } };
  }
  private prepareComment(id: string, input: unknown) {
      const data = object(input, ['body', 'versionId', 'filePath', 'line', 'passage', 'suggestion', 'docxPassage']);
      const version = this.commentVersion(id, data.versionId);
      let docxAnchor: DocxPassageAnchor | undefined;
      if (data.docxPassage !== undefined) {
        if (['filePath', 'line', 'passage', 'suggestion'].some(key => data[key] !== undefined)) throw new HttpError(400, 'A Word passage cannot be combined with a text-file anchor or suggestion.');
        const passage = object(data.docxPassage, ['rangeId', 'start', 'end', 'quote']);
        try { docxAnchor = createDocxPassageAnchor(version, passage as unknown as Parameters<typeof createDocxPassageAnchor>[1]); }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
        this.docxBytes(id, version.id);
      }
      const filePath = data.filePath === undefined || data.filePath === null ? null : string(data.filePath, 'File path', 240);
      const file = filePath ? version.files.find(item => item.path === filePath) : undefined;
      if (filePath && !file) throw new HttpError(400, 'Comment file does not exist in the selected version.');
      let line = data.line === undefined || data.line === null ? null : integer(data.line, 'Line');
      if (line !== null && (!file || line > file.content.split('\n').length)) throw new HttpError(400, 'Comment line must exist in the selected file and version.');
      let anchor: PassageAnchor | undefined;
      if (data.passage !== undefined) {
        if (!filePath || !file) throw new HttpError(400, 'A passage requires a file in the selected version.');
        const passage = object(data.passage, ['start', 'end', 'quote']);
        if (typeof passage.start !== 'number' || typeof passage.end !== 'number') throw new HttpError(400, 'Passage offsets must be numbers.');
        const quote = string(passage.quote, 'Passage quote', 20_000, true);
        try { anchor = createPassageAnchor(version, filePath, { start: passage.start, end: passage.end, quote }); }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
        const firstLine = file.content.slice(0, anchor.start).split('\n').length;
        if (line !== null && line !== firstLine) throw new HttpError(400, 'Comment line must match the beginning of the selected passage.');
        line = firstLine;
      }
      const body = string(data.body, 'Comment', 20_000);
      let suggestion: SuggestedReplacement | undefined;
      if (data.suggestion !== undefined) {
        if (!anchor) throw new HttpError(400, 'A suggested replacement requires an exact passage anchor.');
        try {
          suggestion = validateSuggestion(anchor, data.suggestion as SuggestedReplacement, body);
          // Validate every original anchor before publishing any part of the proposal.
          // Resulting source size is checked again when the complete set is applied.
          applySuggestedReplacement(version, anchor, suggestion, body);
        }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
      }
      return { version, filePath, line, anchor, docxAnchor, suggestion, body };
  }
  createComment(id: string, input: unknown, attribution?: ActorAttribution): ReviewComment {
    return this.discussionMutation(() => {
      const { version, filePath, line, anchor, docxAnchor, suggestion, body } = this.prepareComment(id, input);
      const commentId = randomUUID(), mentions = this.commentMentions(id, body, attribution);
      const comment: ReviewComment = { id: commentId, threadId: commentId, revisionId: id, versionId: version.id, filePath, line, ...(anchor ? { anchor } : {}), ...(docxAnchor ? { docxAnchor } : {}), ...(suggestion ? { suggestion } : {}), body, ...(mentions ? { mentions } : {}), author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: new Date().toISOString() };
      this.insertComment(comment);
      const thread: ReviewThread = { id: commentId, revisionId: id, rootCommentId: commentId, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt };
      this.database.prepare('INSERT INTO review_threads (id, revision_id, root_comment_id, data) VALUES (?, ?, ?, ?)').run(thread.id, id, commentId, JSON.stringify(thread));
      this.revisionSubscriptions.mentioned(comment); this.revisionSubscriptions.commented(id, comment.id, attribution);
      this.event(id, 'commented', `Commented on version ${version.number}${filePath ? `, ${filePath}${line ? `:${line}` : ''}` : ''}.`, attribution); this.notifications.emit({ revisionId: id, kind: 'commented', cause: { type: 'comment', id: comment.id }, attribution, createdAt: comment.createdAt, head: { versionId: version.id, number: version.number, contentHash: version.contentHash } }); return comment;
    });
  }
  private discussionMutation<T>(work: () => T): T {
    this.database.exec('SAVEPOINT discussion_write');
    try {
      // A no-op write acquires the SQLite writer lock before thread versions
      // are read, including direct Store callers outside an API transaction.
      this.database.prepare("UPDATE sequences SET value = value WHERE name = 'revision'").run();
      const result = this.notifications.batch(work); this.database.exec('RELEASE discussion_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO discussion_write; RELEASE discussion_write'); throw error; }
  }
  private commentVersion(id: string, value: unknown): RevisionVersion {
    this.get<Revision>('revision', id);
    const versionId = string(value, 'Version ID', 100);
    const row = this.database.prepare('SELECT data FROM versions WHERE revision_id = ? AND id = ?').get(id, versionId) as JsonRow | undefined;
    if (!row) throw new HttpError(400, 'Comment version does not belong to this revision.');
    return JSON.parse(row.data) as RevisionVersion;
  }
  private thread(id: string, threadId: string): ReviewThread {
    const row = typeof threadId === 'string' && threadId.length <= 100
      ? this.database.prepare('SELECT data FROM review_threads WHERE revision_id = ? AND id = ?').get(id, threadId) as JsonRow | undefined : undefined;
    if (!row) throw new HttpError(404, 'Discussion thread was not found.', 'THREAD_UNAVAILABLE');
    return JSON.parse(row.data) as ReviewThread;
  }
  private preferencePrincipal(principalId: string): string {
    if (typeof principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(principalId)) throw new HttpError(400, 'Invalid principal.');
    return principalId;
  }
  discussionPreferences(id: string, principalId: string): DiscussionPreferences {
    this.get<Revision>('revision', id);
    const rows = this.database.prepare(`SELECT t.id AS thread_id, p.collapsed, p.version, p.updated_at
      FROM review_threads t LEFT JOIN thread_preferences p ON p.thread_id = t.id AND p.principal_id = ?
      WHERE t.revision_id = ? ORDER BY t.rowid`).all(this.preferencePrincipal(principalId), id) as { thread_id: string; collapsed: number | null; version: number | null; updated_at: string | null }[];
    return { revisionId: id, preferences: rows.map(row => ({ revisionId: id, threadId: row.thread_id, collapsed: row.collapsed === 1, version: row.version ?? 0, updatedAt: row.updated_at })) };
  }
  threadPreference(id: string, threadId: string, principalId: string): ThreadPreference {
    this.get<Revision>('revision', id); this.thread(id, threadId);
    const row = this.database.prepare('SELECT collapsed, version, updated_at FROM thread_preferences WHERE thread_id = ? AND principal_id = ?').get(threadId, this.preferencePrincipal(principalId)) as { collapsed: number; version: number; updated_at: string } | undefined;
    return { revisionId: id, threadId, collapsed: row?.collapsed === 1, version: row?.version ?? 0, updatedAt: row?.updated_at ?? null };
  }
  setThreadPreference(id: string, threadId: string, input: unknown, principalId: string): ThreadPreference {
    const data = threadPreferenceInput(input);
    return this.discussionMutation(() => {
      const current = this.threadPreference(id, threadId, principalId);
      if (data.expectedVersion !== current.version) throw new HttpError(409, 'This discussion preference changed. Reload it before saving.');
      if (data.collapsed === current.collapsed) return current;
      if (!Number.isSafeInteger(current.version + 1)) throw new HttpError(409, 'This discussion preference has reached the supported version limit.');
      const next = { ...current, collapsed: data.collapsed, version: current.version + 1, updatedAt: new Date().toISOString() };
      this.database.prepare(`INSERT INTO thread_preferences (thread_id, principal_id, collapsed, version, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, principal_id) DO UPDATE SET collapsed = excluded.collapsed, version = excluded.version, updated_at = excluded.updated_at`).run(threadId, principalId, Number(next.collapsed), next.version, next.updatedAt);
      return next;
    });
  }
  private insertComment(comment: ReviewComment): void {
    this.database.prepare('INSERT INTO comments (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(comment.id, comment.revisionId, comment.versionId, JSON.stringify(comment));
  }
  private advanceThread(thread: ReviewThread, now: string): ReviewThread {
    if (!Number.isSafeInteger(thread.version + 1)) throw new HttpError(409, 'This discussion has reached the supported version limit.');
    return { ...thread, version: thread.version + 1, updatedAt: now };
  }
  private saveThread(thread: ReviewThread): void {
    this.database.prepare('UPDATE review_threads SET data = ? WHERE id = ? AND revision_id = ?').run(JSON.stringify(thread), thread.id, thread.revisionId);
  }
  createReply(id: string, threadId: string, input: unknown, attribution?: ActorAttribution): ReviewComment {
    return this.discussionMutation(() => {
      const thread = this.thread(id, threadId);
      const data = object(input, ['body', 'viewedVersionId']);
      const viewedVersion = this.commentVersion(id, data.viewedVersionId);
      const row = this.database.prepare('SELECT data FROM comments WHERE revision_id = ? AND id = ?').get(id, thread.rootCommentId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'Discussion thread was not found.', 'THREAD_UNAVAILABLE');
      const root = JSON.parse(row.data) as ReviewComment;
      const body = string(data.body, 'Reply', 20_000), mentions = this.commentMentions(id, body, attribution);
      const comment: ReviewComment = { id: randomUUID(), threadId, revisionId: id, versionId: root.versionId, viewedVersionId: viewedVersion.id, filePath: root.filePath, line: root.line, ...(root.anchor ? { anchor: root.anchor } : {}), ...(root.docxAnchor ? { docxAnchor: root.docxAnchor } : {}), body, ...(mentions ? { mentions } : {}), author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: new Date().toISOString() };
      const updated = this.advanceThread(thread, comment.createdAt);
      this.insertComment(comment); this.saveThread(updated);
      this.revisionSubscriptions.mentioned(comment); this.revisionSubscriptions.commented(id, comment.id, attribution);
      this.event(id, 'replied', `Replied to a discussion while viewing version ${viewedVersion.number}.`, attribution); this.notifications.emit({ revisionId: id, kind: 'replied', cause: { type: 'comment', id: comment.id }, attribution, createdAt: comment.createdAt, head: this.notificationVersionHead(id, comment.versionId) });
      return comment;
    });
  }
  updateThread(id: string, threadId: string, input: unknown, attribution?: ActorAttribution): ReviewThread {
    return this.discussionMutation(() => {
      const current = this.thread(id, threadId);
      const data = object(input, ['status', 'expectedThreadVersion', 'versionId']);
      if (integer(data.expectedThreadVersion, 'expectedThreadVersion') !== current.version) throw new HttpError(409, 'This discussion changed. Reload its replies before changing its status.');
      const status = choice(data.status, 'status', ['open', 'resolved']);
      if (status === current.status) throw new HttpError(409, 'This discussion already has the requested status.');
      const version = this.commentVersion(id, data.versionId);
      const thread = { ...this.advanceThread(current, new Date().toISOString()), status };
      const event: ReviewThreadEvent = { id: randomUUID(), revisionId: id, threadId, action: status === 'resolved' ? 'resolved' : 'reopened', versionId: version.id, threadVersion: thread.version, actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: thread.updatedAt };
      this.saveThread(thread);
      this.database.prepare('INSERT INTO thread_events (id, revision_id, thread_id, version_id, data) VALUES (?, ?, ?, ?, ?)').run(event.id, id, threadId, version.id, JSON.stringify(event));
      this.event(id, event.action, `${status === 'resolved' ? 'Resolved' : 'Reopened'} a discussion while viewing version ${version.number}.`, attribution);
      return thread;
    });
  }
  applySuggestion(id: string, commentId: string, input: unknown, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const missing = () => new HttpError(404, 'Suggested replacement was not found.', 'SUGGESTION_UNAVAILABLE');
      const row = typeof commentId === 'string' && commentId.length <= 100
        ? this.database.prepare('SELECT c.data AS comment_data, t.data AS thread_data FROM comments c JOIN review_threads t ON t.root_comment_id = c.id AND t.revision_id = c.revision_id WHERE c.revision_id = ? AND c.id = ?').get(id, commentId) as { comment_data: string; thread_data: string } | undefined : undefined;
      if (!row) throw missing();
      const comment = JSON.parse(row.comment_data) as ReviewComment;
      const thread = JSON.parse(row.thread_data) as ReviewThread;
      if (!comment.anchor || !comment.suggestion || comment.threadId !== thread.id || thread.rootCommentId !== comment.id || comment.viewedVersionId !== undefined) throw missing();
      if (this.database.prepare('SELECT id FROM suggestion_applications WHERE comment_id = ?').get(comment.id)) throw new HttpError(409, 'This suggested replacement has already been applied.');
      const data = object(input, ['expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedThreadVersion']);
      const detail = this.requireVersion(id, data.expectedVersion);
      const expectedVersionId = string(data.expectedVersionId, 'Expected version ID', 100);
      const expectedContentHash = string(data.expectedContentHash, 'Expected content hash', 64);
      if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new HttpError(400, 'Expected content hash must be a SHA-256 digest.');
      if (integer(data.expectedThreadVersion, 'expectedThreadVersion') !== thread.version) throw new HttpError(409, 'This discussion changed. Reload its replies before applying the suggestion.');
      const from = detail.versions.find(version => version.number === detail.revision.currentVersion)!;
      if (from.docx) throw docxUnsupported();
      const actualHash = contentHash(from.files, from.assets);
      if (from.id !== expectedVersionId || actualHash !== expectedContentHash || actualHash !== from.contentHash
        || comment.versionId !== from.id || comment.anchor.versionId !== from.id || comment.anchor.contentHash !== actualHash
        || comment.filePath !== comment.anchor.filePath) throw new HttpError(409, 'The suggestion must match the exact current source version and content. Review the current source before proposing another replacement.');
      let source: SourceFile[];
      try { source = applySuggestedReplacement(from, comment.anchor, comment.suggestion, comment.body); }
      catch (error) { if (error instanceof RangeError) throw new HttpError(409, 'The saved suggestion no longer matches its original source. Review the source before proposing another replacement.'); throw error; }
      // Validate the complete result, including UTF-8 byte limits, before any
      // source write. Provider/client input cannot supply an alternative patch.
      const validated = files(source);
      if (!Number.isSafeInteger(detail.revision.currentVersion + 1)) throw new HttpError(409, 'This revision has reached the supported version limit.');
      const nextThread = this.advanceThread(thread, new Date().toISOString());
      const updated = this.createVersion(id, { files: validated, message: `Applied suggested replacement from version ${from.number}.`, expectedVersion: from.number }, attribution);
      const to = updated.versions.find(version => version.number === updated.revision.currentVersion)!;
      const application: SuggestionApplication = {
        id: randomUUID(), revisionId: id, commentId: comment.id, threadId: thread.id, fromVersionId: from.id, toVersionId: to.id,
        fromContentHash: actualHash, toContentHash: to.contentHash, threadVersion: nextThread.version,
        actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: nextThread.updatedAt,
      };
      this.saveThread(nextThread);
      this.database.prepare('INSERT INTO suggestion_applications (id, revision_id, comment_id, thread_id, from_version_id, to_version_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(application.id, id, comment.id, thread.id, from.id, to.id, JSON.stringify(application));
      this.event(id, 'suggestion_applied', `Applied a suggested replacement from version ${from.number} as version ${to.number}. Discussion status is unchanged.`, attribution); this.notifications.discard('source', to.id); this.notifications.emit({ revisionId: id, kind: 'suggestion_applied', cause: { type: 'suggestion', id: application.id }, attribution, createdAt: application.createdAt });
      return this.detail(id);
    });
  }
  saveReview(id: string, expectedVersion: number, analysis: ReviewAnalysis, attribution?: ActorAttribution): ReviewRun {
    return this.discussionMutation(() => {
    const detail = this.requireVersion(id, expectedVersion); const version = detail.versions.find(item => item.number === expectedVersion)!;
    if (version.docx) throw docxUnsupported();
    const summary = version.assets?.length ? `${analysis.summary}\nReview covered text files only; ${version.assets.length} binary figure(s) were not inspected.` : analysis.summary;
    const review: ReviewRun = { ...analysis, summary, ...(attribution ? { attribution } : {}), id: randomUUID(), revisionId: id, versionId: version.id, contentHash: version.contentHash, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO reviews (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(review.id, id, version.id, JSON.stringify(review));
    this.revisionLifecycle.reviewSaved(id, attribution);
    if (detail.revision.status === 'accepted' && analysis.findings.some(finding => finding.severity === 'error')) {
      this.event(id, 'acceptance_invalidated', `New review errors invalidated acceptance of version ${expectedVersion}.`, attribution);
    }
    this.event(id, 'reviewed', `${analysis.provider === 'local' ? 'Local checks' : 'AI review'} completed for version ${expectedVersion}: ${analysis.findings.length} findings.`, attribution); this.notifications.emit({ revisionId: id, kind: 'review_completed', cause: { type: 'review', id: review.id }, attribution, createdAt: review.createdAt }); return review;
    });
  }
  detail(id: string): RevisionDetail {
    const revision = this.get<Revision>('revision', id);
    const versions = (this.database.prepare('SELECT data FROM versions WHERE revision_id = ? ORDER BY number').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as RevisionVersion);
    const comments = (this.database.prepare('SELECT data FROM comments WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewComment);
    const threads = (this.database.prepare('SELECT data FROM review_threads WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewThread);
    const threadEvents = (this.database.prepare('SELECT data FROM thread_events WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewThreadEvent);
    const suggestionApplications = (this.database.prepare('SELECT data FROM suggestion_applications WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as SuggestionApplication);
    const reviews = (this.database.prepare('SELECT data FROM reviews WHERE revision_id = ? ORDER BY rowid DESC').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewRun);
    return { revision, versions, comments, threads, threadEvents, suggestionApplications, reviews, activity: this.activities(id) };
  }
}

export function createStore(options: StoreOptions = {}): Store { return new Store(options); }
