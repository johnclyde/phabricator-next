import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution, RevisionStatus } from '../shared/types.ts';
import { isRevisionAuthor, isRevisionAuthorHead, isRevisionAuthorTransaction, type RevisionAuthor, type RevisionAuthorHead } from '../shared/revision-authorship.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionLifecycle, isRevisionLifecycleEvidence, isRevisionLifecycleTransaction, sameHead, type RevisionLifecycle, type RevisionLifecycleInput, type RevisionLifecycleTransaction, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import { DEFAULT_REVISION_REVIEWER_CONFIG, REVISION_REVIEWER_LIMITS, isRevisionReviewerAttribution, isRevisionReviewerState, isRevisionReviewerTransaction, revisionReviewerActions, revisionReviewerInput, revisionReviewerSummary, revisionReviewerPermission, validRevisionReviewerResult, type RevisionReviewerConfig, type RevisionReviewerConfiguration, type RevisionReviewerState, type RevisionReviewerSnapshot, type RevisionReviewerInput, type RevisionReviewerMember, type RevisionReviewerTransaction, type RevisionReviewerReceipt, type RevisionReviewerHistory, type RevisionReviewerAcceptance, type RevisionReviewerInvalidationReason } from '../shared/revision-reviewers.ts';
import type { RevisionLifecycleStore } from './revision-lifecycle.ts';
import { HttpError, object } from './validation.ts';

type Snapshot = Omit<RevisionReviewerSnapshot, 'access' | 'accessEpoch'>;
type Core = Omit<Snapshot, 'actions'>;
export interface RevisionReviewerOperation { id: string; revisionId: string; input: RevisionReviewerInput; inputSha256: string; attribution: ActorAttribution; before: Core; after: RevisionReviewerState; reviewProofs: { id: string; sha256: string }[]; receipt: RevisionReviewerReceipt }
export interface RevisionReviewerLifecycleProof { before: RevisionReviewerState; after: RevisionReviewerState }
type Baseline = { state: RevisionReviewerState; head: RevisionAuthorHead; lifecycleVersion: number; authorVersion: number };
const invalid = () => new HttpError(409, 'Revision reviewer history cannot be verified.', 'REVISION_REVIEWER_INVALID_RECEIPT');
const changed = () => new HttpError(409, 'Reviewers, lifecycle, ownership, source or evidence changed. Reload before continuing.', 'REVISION_REVIEWER_CHANGED');
const unavailable = () => new HttpError(404, 'Revision reviewers are unavailable.', 'REVISION_REVIEWER_UNAVAILABLE');
const limited = () => new HttpError(422, 'The supported reviewer limit was reached.', 'REVISION_REVIEWER_LIMIT');
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_reviewers_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE revision_reviewers SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function head(db: DatabaseSync, id: string, number?: number): RevisionAuthorHead {
  const row = db.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS stored_id,json_extract(data,'$.revisionId') AS stored_revision,json_extract(data,'$.number') AS stored_number,json_type(data,'$.number') AS number_type,json_extract(data,'$.contentHash') AS content_hash FROM versions WHERE revision_id=? ${number === undefined ? 'ORDER BY number DESC LIMIT 1' : 'AND number=?'}`).get(...(number === undefined ? [id] : [id, number])) as Record<string, unknown> | undefined;
  if (!row || row.revision_id !== id || row.id !== row.stored_id || row.stored_revision !== id || row.number !== row.stored_number || !['integer', 'real'].includes(String(row.number_type))) throw invalid();
  const result = { versionId: row.id, number: row.number, contentHash: row.content_hash }; if (!isRevisionAuthorHead(result)) throw invalid(); return result;
}
function ensureBaseline(db: DatabaseSync, id: string): void {
  if (!isRevisionId(id) || !db.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision'").get(id)) throw unavailable();
  if (db.prepare('SELECT 1 FROM revision_reviewers WHERE revision_id=?').get(id)) return;
  const source = head(db, id), life = db.prepare('SELECT version,data FROM revision_lifecycle WHERE revision_id=?').get(id) as { version: number; data: string } | undefined;
  const author = db.prepare('SELECT version FROM revision_authorship WHERE revision_id=?').get(id) as { version: number } | undefined;
  if (!life || !author || !natural(author.version)) throw invalid();
  const lifecycle = decode<RevisionLifecycle>(life.data); if (!isRevisionLifecycle(lifecycle, id) || lifecycle.version !== life.version) throw invalid();
  let acceptance: RevisionReviewerAcceptance | null = null;
  if (lifecycle.status === 'accepted' || lifecycle.resumeAcceptanceHead !== null) {
    const row = db.prepare("SELECT data FROM revision_lifecycle_transactions WHERE revision_id=? AND json_extract(data,'$.toStatus')='accepted' ORDER BY version DESC LIMIT 1").get(id) as { data: string } | undefined;
    const transaction = row ? decode<RevisionLifecycleTransaction>(row.data) : null;
    if (transaction && isRevisionLifecycleTransaction(transaction, id) && ['accept_reviewed', 'request_review'].includes(transaction.action) && sameHead(transaction.head, source)) acceptance = { kind: 'evidence', head: source, transactionId: transaction.id };
    else acceptance = { kind: 'legacy', head: null, transactionId: null };
  }
  const state: RevisionReviewerState = { revisionId: id, version: 0, members: [], acceptance, updatedAt: null };
  const baseline: Baseline = { state, head: source, lifecycleVersion: life.version, authorVersion: author.version };
  db.prepare('INSERT INTO revision_reviewer_baselines(revision_id,data) VALUES(?,?)').run(id, JSON.stringify(baseline));
  db.prepare('INSERT INTO revision_reviewers(revision_id,version,data) VALUES(?,0,?)').run(id, JSON.stringify(state));
}
/** Additive initialization. Existing source, lifecycle and authorship bytes are never rewritten. */
export function initializeRevisionReviewers(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_reviewers(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.version')=version));
      CREATE TABLE IF NOT EXISTS revision_reviewer_baselines(revision_id TEXT PRIMARY KEY REFERENCES entities(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS revision_reviewer_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS revision_reviewer_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE REFERENCES revision_reviewer_operations(id),cause_id TEXT NOT NULL,before_lifecycle_version INTEGER NOT NULL CHECK(before_lifecycle_version>=0),data TEXT NOT NULL CHECK(json_valid(data)),before_state TEXT NOT NULL CHECK(json_valid(before_state)),after_state TEXT NOT NULL CHECK(json_valid(after_state)),UNIQUE(revision_id,version));
    `);
    for (const table of ['revision_reviewer_baselines', 'revision_reviewer_operations', 'revision_reviewer_transactions']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Reviewer evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Reviewer evidence is immutable'); END;`);
    }
    for (const [table, columns] of Object.entries({ revision_reviewers: ['revision_id', 'version', 'data'], revision_reviewer_baselines: ['revision_id', 'data'], revision_reviewer_operations: ['id', 'revision_id', 'input_sha256', 'data'], revision_reviewer_transactions: ['id', 'revision_id', 'version', 'operation_id', 'cause_id', 'before_lifecycle_version', 'data', 'before_state', 'after_state'] })) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name); if (!isDeepStrictEqual(actual, columns)) throw new Error(`Unexpected ${table} schema; reviewer migration was not applied.`);
    }
    for (const row of db.prepare("SELECT id FROM entities WHERE kind='revision' ORDER BY id").all() as { id: string }[]) ensureBaseline(db, row.id);
  });
}
function parse(value: unknown): RevisionReviewerInput { try { return revisionReviewerInput(value); } catch { throw new HttpError(400, 'Provide an exact reviewer action and all concurrency pins.', 'REVISION_REVIEWER_INVALID_INPUT'); } }
export function revisionReviewerInputHash(input: RevisionReviewerInput): string { return sha(JSON.stringify(parse(input))); }
export function revisionReviewerConfigHash(config: RevisionReviewerConfiguration): string { return sha(JSON.stringify({ allowReopen: config.allowReopen, alwaysAllowClose: config.alwaysAllowClose, alwaysAllowAbandon: config.alwaysAllowAbandon, closeOnAccept: config.closeOnAccept, allowSelfAccept: config.allowSelfAccept })); }
function validConfig(value: unknown): value is RevisionReviewerConfiguration { return Boolean(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'allowReopen,allowSelfAccept,alwaysAllowAbandon,alwaysAllowClose,closeOnAccept' && Object.values(value).every(item => typeof item === 'boolean')); }
function clone(state: RevisionReviewerState): RevisionReviewerState { return structuredClone(state); }

/** Resolve only reviewable states. Terminal/draft/planned states never change as a vote side effect. */
function resolve(state: RevisionReviewerState, source: RevisionAuthorHead, status: RevisionStatus, errors: number, transactionId: string): { status: RevisionStatus; acceptance: RevisionReviewerAcceptance | null } {
  const summary = revisionReviewerSummary(state, source), veto = summary.rejecting > 0 || summary.olderRejecting > 0 || summary.blocking > 0 || errors > 0;
  let acceptance = state.acceptance;
  if (veto || acceptance && acceptance.kind !== 'legacy' && !sameHead(acceptance.head, source) || acceptance?.kind === 'reviewers' && !summary.accepting) acceptance = null;
  if (!['needs_review', 'changes_requested', 'accepted'].includes(status)) return { status, acceptance };
  const existing = acceptance && (acceptance.kind === 'legacy' ? status === 'accepted' : sameHead(acceptance.head, source));
  if (!veto && (summary.accepting > 0 || existing)) return { status: 'accepted', acceptance: acceptance ?? { kind: 'reviewers', head: source, transactionId } };
  if (summary.rejecting || errors > 0 && (status === 'accepted' || status === 'changes_requested')) return { status: 'changes_requested', acceptance };
  return { status: status === 'accepted' || status === 'changes_requested' ? 'needs_review' : status, acceptance };
}
function applyMember(snapshot: Core, input: RevisionReviewerInput, actor: ActorAttribution, target: RevisionAuthor, createdAt: string): RevisionReviewerState {
  const option = revisionReviewerActions(snapshot, actor.principalId).find(item => item.action === input.action);
  if (!option?.available) throw new HttpError(409, option?.reason ?? 'This reviewer action is unavailable.', 'REVISION_REVIEWER_ACTION_UNAVAILABLE');
  const state = clone(snapshot.reviewers), index = state.members.findIndex(member => member.principalId === target.principalId), current = state.members[index];
  const noEffect = () => new HttpError(409, 'This reviewer change has no effect.', 'REVISION_REVIEWER_NO_EFFECT');
  if (input.action === 'add' || input.action === 'block') {
    if (target.principalId === snapshot.authorship.author?.principalId && !snapshot.config.allowSelfAccept) throw new HttpError(409, 'The current author cannot be a reviewer unless self acceptance is enabled.', 'REVISION_REVIEWER_AUTHOR');
  }
  if (input.action === 'add') { if (current) throw noEffect(); state.members.push({ ...target, status: 'added', decision: null }); }
  else if (input.action === 'remove') { if (!current) throw noEffect(); state.members.splice(index, 1); }
  else if (input.action === 'block') { if (!current || current.status === 'blocking') throw noEffect(); state.members[index] = { ...target, status: 'blocking', decision: null }; }
  else if (input.action === 'unblock') { if (!current || current.status !== 'blocking') throw noEffect(); state.members[index] = { ...target, status: 'added', decision: null }; }
  else {
    const member: RevisionReviewerMember = { ...target, status: input.action === 'accept' ? 'accepted' : input.action === 'request_changes' ? 'rejected' : 'resigned', decision: { head: snapshot.head, attribution: { ...actor }, createdAt, invalidated: null } };
    if (current) state.members[index] = member; else state.members.push(member);
  }
  if (state.members.length > REVISION_REVIEWER_LIMITS.members) throw limited();
  state.members.sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0);
  return state;
}

/** Current policy and active membership targets are authorized by the API; this engine owns exact pins and atomic proof. */
export class RevisionReviewerStore {
  readonly config: RevisionReviewerConfig;
  constructor(private readonly database: DatabaseSync, private readonly lifecycle: RevisionLifecycleStore, configuration: Partial<RevisionReviewerConfig> = {}) {
    const config = { ...DEFAULT_REVISION_REVIEWER_CONFIG, ...configuration };
    if (Object.keys(config).length !== 1 || typeof config.allowSelfAccept !== 'boolean') throw new Error('Invalid reviewer configuration.'); this.config = Object.freeze(config);
  }
  ensure(id: string): void { ensureBaseline(this.database, id); }
  private baseline(id: string): Baseline {
    const row = this.database.prepare('SELECT data FROM revision_reviewer_baselines WHERE revision_id=?').get(id) as { data: string } | undefined;
    if (!row) throw invalid(); const baseline = decode<Baseline>(row.data);
    if (!baseline || Object.keys(baseline).sort().join(',') !== 'authorVersion,head,lifecycleVersion,state' || !isRevisionReviewerState(baseline.state, id) || baseline.state.version !== 0 || baseline.state.members.length || !natural(baseline.lifecycleVersion) || !natural(baseline.authorVersion) || !isRevisionAuthorHead(baseline.head) || !isDeepStrictEqual(head(this.database, id, baseline.head.number), baseline.head)) throw invalid(); return baseline;
  }
  private transactionAt(id: string, version: number): { transaction: RevisionReviewerTransaction; before: RevisionReviewerState; after: RevisionReviewerState; causeId: string; beforeLifecycleVersion: number } {
    const row = this.database.prepare('SELECT id,operation_id,cause_id,before_lifecycle_version,data,before_state,after_state FROM revision_reviewer_transactions WHERE revision_id=? AND version=?').get(id, version) as { id: string; operation_id: string | null; cause_id: string; before_lifecycle_version: number; data: string; before_state: string; after_state: string } | undefined;
    if (!row) throw invalid(); const transaction = decode<RevisionReviewerTransaction>(row.data), before = decode<RevisionReviewerState>(row.before_state), after = decode<RevisionReviewerState>(row.after_state);
    if (!isRevisionReviewerTransaction(transaction, id) || transaction.id !== row.id || !uuid(transaction.id) || transaction.operationId !== row.operation_id || transaction.reviewerVersion !== version || !isRevisionReviewerState(before, id) || !isRevisionReviewerState(after, id) || before.version + 1 !== version || after.version !== version || after.updatedAt !== transaction.createdAt || !isDeepStrictEqual(before.members, transaction.before) || !isDeepStrictEqual(after.members, transaction.after) || !isDeepStrictEqual(before.acceptance, transaction.beforeAcceptance) || !isDeepStrictEqual(after.acceptance, transaction.acceptance) || !isDeepStrictEqual(head(this.database, id, transaction.head.number), transaction.head)) throw invalid();
    for (const member of [...before.members, ...after.members]) if (member.decision && (!isDeepStrictEqual(head(this.database, id, member.decision.head.number), member.decision.head) || member.decision.invalidated && !isDeepStrictEqual(head(this.database, id, member.decision.invalidated.head.number), member.decision.invalidated.head))) throw invalid();
    if (!natural(row.before_lifecycle_version) || transaction.lifecycleVersion < row.before_lifecycle_version || transaction.lifecycleVersion > row.before_lifecycle_version + 1) throw invalid();
    return { transaction, before, after, causeId: row.cause_id, beforeLifecycleVersion: row.before_lifecycle_version };
  }
  stateAt(id: string, version: number): RevisionReviewerState { return version === 0 ? this.baseline(id).state : this.transactionAt(id, version).after; }
  state(id: string): RevisionReviewerState {
    if (!isRevisionId(id) || !this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision'").get(id)) throw unavailable();
    const row = this.database.prepare('SELECT version,data FROM revision_reviewers WHERE revision_id=?').get(id) as { version: number; data: string } | undefined;
    if (!row || !natural(row.version)) throw invalid(); const state = decode<RevisionReviewerState>(row.data);
    const latest = this.database.prepare('SELECT max(version) AS version FROM revision_reviewer_transactions WHERE revision_id=?').get(id) as { version: number | null };
    if (!isRevisionReviewerState(state, id) || state.version !== row.version || (latest.version ?? 0) !== state.version || !isDeepStrictEqual(state, this.stateAt(id, state.version))) throw invalid(); return state;
  }
  summary(id: string, source: RevisionAuthorHead) { return revisionReviewerSummary(this.state(id), source); }
  snapshot(id: string, principalId = ''): Snapshot {
    return scope(this.database, () => {
      const lifecycle = this.lifecycle.snapshot(id, principalId), config = { ...lifecycle.config, ...this.config };
      const core: Core = { reviewers: this.state(id), head: lifecycle.head, lifecycle: lifecycle.lifecycle, authorship: lifecycle.authorship, evidence: lifecycle.evidence, config, configId: revisionReviewerConfigHash(config) };
      return { ...core, actions: revisionReviewerActions(core, principalId) };
    });
  }
  history(id: string, input: { before?: number; limit?: number; expectedReviewerVersion?: number } = {}): Omit<RevisionReviewerHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['before', 'limit', 'expectedReviewerVersion']), state = this.state(id), limit = query.limit ?? 25;
      if (!natural(limit) || limit < 1 || limit > REVISION_REVIEWER_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedReviewerVersion !== undefined && !natural(query.expectedReviewerVersion)) throw new HttpError(400, 'Choose valid reviewer history versions and a page size between 1 and 100.');
      if (query.expectedReviewerVersion !== undefined && query.expectedReviewerVersion !== state.version) throw changed();
      const rows = this.database.prepare('SELECT version FROM revision_reviewer_transactions WHERE revision_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, query.before ?? null, query.before ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => this.transactionAt(id, row.version).transaction);
      return { revisionId: id, reviewerVersion: state.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.reviewerVersion : null };
    });
  }
  private append(before: RevisionReviewerState, after: RevisionReviewerState, transaction: RevisionReviewerTransaction, causeId: string, beforeLifecycleVersion: number): void {
    if (!Number.isSafeInteger(after.version) || after.version !== before.version + 1) throw limited();
    this.database.prepare('INSERT INTO revision_reviewer_transactions(id,revision_id,version,operation_id,cause_id,before_lifecycle_version,data,before_state,after_state) VALUES(?,?,?,?,?,?,?,?,?)').run(transaction.id, before.revisionId, after.version, transaction.operationId, causeId, beforeLifecycleVersion, JSON.stringify(transaction), JSON.stringify(before), JSON.stringify(after));
    this.database.prepare('UPDATE revision_reviewers SET version=?,data=? WHERE revision_id=?').run(after.version, JSON.stringify(after), before.revisionId);
  }
  mutate(id: string, input: RevisionReviewerInput, actor: ActorAttribution, targetRef?: RevisionAuthor): RevisionReviewerReceipt {
    const request = parse(input); if (!isRevisionReviewerAttribution(actor)) throw new HttpError(400, 'Authenticated reviewer attribution is required.');
    const target = 'reviewerId' in request ? targetRef : { principalId: actor.principalId, displayName: actor.displayName };
    if (!isRevisionAuthor(target) || 'reviewerId' in request && target.principalId !== request.reviewerId) throw new HttpError(400, 'Choose a valid active workspace reviewer.');
    return scope(this.database, () => {
      const { actions: _actions, ...before } = this.snapshot(id, actor.principalId), epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value;
      if (!natural(epoch)) throw invalid();
      if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      if (before.reviewers.version !== request.expectedReviewerVersion || before.lifecycle.version !== request.expectedLifecycleVersion || before.authorship.version !== request.expectedAuthorVersion || before.head.number !== request.expectedVersion || before.head.versionId !== request.expectedVersionId || before.head.contentHash !== request.expectedContentHash || before.configId !== request.expectedConfigId || before.evidence.sha256 !== request.expectedEvidenceSha256) throw changed();
      const now = new Date().toISOString(), transactionId = randomUUID(), operationId = randomUUID(), inputSha256 = revisionReviewerInputHash(request);
      const after = applyMember(before, request, actor, target, now), resolution = resolve(after, before.head, before.lifecycle.status, before.evidence.errorCount, transactionId);
      after.version++; after.updatedAt = now; after.acceptance = resolution.acceptance;
      const lifecycle = this.lifecycle.reviewerReassessed(id, resolution.status, actor, after.acceptance === null, now);
      const transaction: RevisionReviewerTransaction = { id: transactionId, revisionId: id, operationId, reviewerVersion: after.version, action: request.action, reviewerId: target.principalId, before: before.reviewers.members, after: after.members, beforeAcceptance: before.reviewers.acceptance, acceptance: after.acceptance, head: before.head, fromStatus: before.lifecycle.status, toStatus: lifecycle.status, lifecycleVersion: lifecycle.version, message: request.message, attribution: { ...actor }, createdAt: now };
      const receipt: RevisionReviewerReceipt = { revisionId: id, operationId, inputSha256, transaction, accessEpoch: epoch };
      const operation: RevisionReviewerOperation = { id: operationId, revisionId: id, input: request, inputSha256, attribution: { ...actor }, before, after, reviewProofs: this.lifecycle.reviewEvidence(id, before.head).proofs, receipt };
      this.database.prepare('INSERT INTO revision_reviewer_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, inputSha256, JSON.stringify(operation));
      this.append(before.reviewers, after, transaction, operationId, before.lifecycle.version); return receipt;
    }, true);
  }
  private automatic(id: string, before: RevisionReviewerState, after: RevisionReviewerState, action: RevisionReviewerTransaction['action'], source: RevisionAuthorHead, fromStatus: RevisionStatus, toStatus: RevisionStatus, lifecycleVersion: number, actor: ActorAttribution | undefined, causeId: string, now: string, beforeLifecycleVersion: number, force = false, transactionId = randomUUID()): void {
    if (!force && isDeepStrictEqual(before.members, after.members) && isDeepStrictEqual(before.acceptance, after.acceptance)) return;
    after.version = before.version + 1; after.updatedAt = now;
    const transaction: RevisionReviewerTransaction = { id: transactionId, revisionId: id, operationId: null, reviewerVersion: after.version, action, reviewerId: null, before: before.members, after: after.members, beforeAcceptance: before.acceptance, acceptance: after.acceptance, head: source, fromStatus, toStatus, lifecycleVersion, message: { source_updated: 'New source invalidated earlier reviewer decisions.', request_review: 'Request review voided earlier reviewer decisions.', review_error: 'Current-version errors invalidated acceptance.', author_changed: 'Authorship changed: the previous author became a reviewer and the new author was removed.', evidence_accepted: 'An editor accepted exact-version review evidence.' }[action as 'source_updated'] ?? '', attribution: actor ? { ...actor } : null, createdAt: now };
    this.append(before, after, transaction, causeId, beforeLifecycleVersion);
  }
  private invalidate(state: RevisionReviewerState, reason: RevisionReviewerInvalidationReason, source: RevisionAuthorHead, actor: ActorAttribution | undefined, now: string, accept = true, reject = true): void {
    for (const member of state.members) if (member.decision && (accept && member.status === 'accepted' || reject && member.status === 'rejected')) {
      if (reason === 'request_review' || !member.decision.invalidated) member.decision.invalidated = { reason, head: source, attribution: actor ? { ...actor } : null, createdAt: now };
    }
  }
  sourceUpdated(id: string, source: RevisionAuthorHead, fromStatus: RevisionStatus, toStatus: RevisionStatus, lifecycleVersion: number, actor?: ActorAttribution): void {
    const before = this.state(id), after = clone(before), now = new Date().toISOString(); this.invalidate(after, 'source_updated', source, actor, now); after.acceptance = null;
    this.automatic(id, before, after, 'source_updated', source, fromStatus, toStatus, lifecycleVersion, actor, source.versionId, now, lifecycleVersion - 1);
  }
  reviewError(id: string, source: RevisionAuthorHead, fromStatus: RevisionStatus, toStatus: RevisionStatus, lifecycleVersion: number, beforeLifecycleVersion: number, actor?: ActorAttribution): void {
    const before = this.state(id), after = clone(before), now = new Date().toISOString(); this.invalidate(after, 'review_error', source, actor, now, true, false); after.acceptance = null;
    this.automatic(id, before, after, 'review_error', source, fromStatus, toStatus, lifecycleVersion, actor, source.versionId, now, beforeLifecycleVersion);
  }
  private lifecyclePlan(before: RevisionReviewerState, input: RevisionLifecycleInput, beforeSnapshot: Omit<RevisionLifecycleSnapshot, 'access' | 'accessEpoch' | 'actions'>, proposed: RevisionLifecycle, transactionId: string, actor: ActorAttribution): { lifecycle: RevisionLifecycle; after: RevisionReviewerState } {
    const after = clone(before), source = beforeSnapshot.head, now = proposed.updatedAt!;
    if (input.action === 'request_review') {
      const restore = beforeSnapshot.lifecycle.status === 'changes_planned'; this.invalidate(after, 'request_review', source, actor, now, !restore, true); if (!restore) after.acceptance = null;
    }
    if (input.action === 'accept_reviewed') after.acceptance = { kind: 'evidence', head: source, transactionId };
    const resolution = resolve(after, source, proposed.status, beforeSnapshot.evidence.errorCount, transactionId);
    // Native evidence acceptance is explicit and must remain its own provenance.
    after.acceptance = resolution.acceptance;
    const lifecycle = { ...proposed, status: resolution.status, ...(after.acceptance === null ? { resumeAcceptanceHead: null } : {}) };
    return { lifecycle, after };
  }
  lifecycleChanged(id: string, input: RevisionLifecycleInput, beforeSnapshot: Omit<RevisionLifecycleSnapshot, 'access' | 'accessEpoch' | 'actions'>, proposed: RevisionLifecycle, transactionId: string, operationId: string, actor: ActorAttribution): { lifecycle: RevisionLifecycle; proof: RevisionReviewerLifecycleProof } {
    const before = this.state(id), source = beforeSnapshot.head, now = proposed.updatedAt!;
    const { lifecycle, after } = this.lifecyclePlan(before, input, beforeSnapshot, proposed, transactionId, actor);
    this.automatic(id, before, after, input.action === 'accept_reviewed' ? 'evidence_accepted' : 'request_review', source, beforeSnapshot.lifecycle.status, lifecycle.status, lifecycle.version, actor, operationId, now, beforeSnapshot.lifecycle.version);
    return { lifecycle, proof: { before, after: this.state(id) } };
  }
  authorChanged(id: string, previous: RevisionAuthor | null, author: RevisionAuthor, actor: ActorAttribution, operationId: string): void {
    const snapshot = this.lifecycle.snapshot(id), before = this.state(id), after = clone(before), now = new Date().toISOString(), transactionId = randomUUID();
    after.members = after.members.filter(member => member.principalId !== author.principalId);
    if (previous && !after.members.some(member => member.principalId === previous.principalId)) after.members.push({ ...previous, status: 'added', decision: null });
    if (after.members.length > REVISION_REVIEWER_LIMITS.members) throw limited(); after.members.sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0);
    const resolution = resolve(after, snapshot.head, snapshot.lifecycle.status, snapshot.evidence.errorCount, transactionId); after.acceptance = resolution.acceptance;
    const lifecycle = this.lifecycle.reviewerReassessed(id, resolution.status, actor, after.acceptance === null, now);
    this.automatic(id, before, after, 'author_changed', snapshot.head, snapshot.lifecycle.status, lifecycle.status, lifecycle.version, actor, operationId, now, snapshot.lifecycle.version, true, transactionId);
  }
  verifyLifecycleProof(id: string, operationId: string, proof: RevisionReviewerLifecycleProof): void {
    if (!proof || Object.keys(proof).sort().join(',') !== 'after,before' || !isRevisionReviewerState(proof.before, id) || !isRevisionReviewerState(proof.after, id) || !isDeepStrictEqual(this.stateAt(id, proof.before.version), proof.before) || !isDeepStrictEqual(this.stateAt(id, proof.after.version), proof.after) || proof.after.version < proof.before.version || proof.after.version > proof.before.version + 1) throw invalid();
    if (proof.after.version !== proof.before.version && this.transactionAt(id, proof.after.version).causeId !== operationId) throw invalid();
  }
  verifyLifecycleTransition(id: string, operationId: string, proof: RevisionReviewerLifecycleProof, input: RevisionLifecycleInput, beforeSnapshot: Omit<RevisionLifecycleSnapshot, 'access' | 'accessEpoch' | 'actions'>, proposed: RevisionLifecycle, transactionId: string, actor: ActorAttribution, expected: RevisionLifecycle): void {
    this.verifyLifecycleProof(id, operationId, proof);
    const result = this.lifecyclePlan(proof.before, input, beforeSnapshot, proposed, transactionId, actor);
    if (!isDeepStrictEqual(result.after.members, proof.before.members) || !isDeepStrictEqual(result.after.acceptance, proof.before.acceptance)) { result.after.version++; result.after.updatedAt = proposed.updatedAt; }
    if (!isDeepStrictEqual(result.after, proof.after) || !isDeepStrictEqual(result.lifecycle, expected)) throw invalid();
  }
  operationRevisionId(operationId: string): string { if (!uuid(operationId)) throw invalid(); const row = this.database.prepare('SELECT revision_id FROM revision_reviewer_operations WHERE id=?').get(operationId) as { revision_id: string } | undefined; if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id; }
  operation(operationId: string): RevisionReviewerOperation {
    return scope(this.database, () => {
      try {
        const id = this.operationRevisionId(operationId), row = this.database.prepare('SELECT input_sha256,data FROM revision_reviewer_operations WHERE id=?').get(operationId) as { input_sha256: string; data: string }, operation = decode<RevisionReviewerOperation>(row.data);
        if (!operation || Object.keys(operation).sort().join(',') !== 'after,attribution,before,id,input,inputSha256,receipt,reviewProofs,revisionId' || operation.id !== operationId || operation.revisionId !== id || !isRevisionReviewerAttribution(operation.attribution) || !isDeepStrictEqual(parse(operation.input), operation.input) || operation.inputSha256 !== row.input_sha256 || operation.inputSha256 !== revisionReviewerInputHash(operation.input) || !validRevisionReviewerResult(operation.receipt, id, operation.input, operation.attribution.principalId) || operation.receipt.operationId !== operationId || operation.receipt.inputSha256 !== operation.inputSha256 || operation.receipt.accessEpoch !== operation.input.expectedAccessEpoch) throw invalid();
        const before = operation.before, input = operation.input, stored = this.transactionAt(id, input.expectedReviewerVersion + 1);
        if (!before || Object.keys(before).sort().join(',') !== 'authorship,config,configId,evidence,head,lifecycle,reviewers' || !isRevisionReviewerState(before.reviewers, id) || !isDeepStrictEqual(before.reviewers, this.stateAt(id, input.expectedReviewerVersion)) || !isRevisionAuthorHead(before.head) || !isDeepStrictEqual(before.head, head(this.database, id, input.expectedVersion)) || before.head.versionId !== input.expectedVersionId || before.head.contentHash !== input.expectedContentHash || !isRevisionLifecycle(before.lifecycle, id) || before.lifecycle.version !== input.expectedLifecycleVersion || !isDeepStrictEqual(this.lifecycle.historicalState(id, input.expectedLifecycleVersion), before.lifecycle) || !validConfig(before.config) || before.configId !== revisionReviewerConfigHash(before.config) || before.configId !== input.expectedConfigId || !isRevisionLifecycleEvidence(before.evidence) || before.evidence.sha256 !== input.expectedEvidenceSha256) throw invalid();
        if (!before.authorship || Object.keys(before.authorship).sort().join(',') !== 'author,version' || before.authorship.version !== input.expectedAuthorVersion || !isDeepStrictEqual(before.authorship.author, this.historicalAuthor(id, before.authorship.version))) throw invalid();
        const evidence = this.lifecycle.reviewEvidence(id, before.head, before.evidence.reviewIds); if (!isDeepStrictEqual(evidence.evidence, before.evidence) || !isDeepStrictEqual(evidence.proofs, operation.reviewProofs)) throw invalid();
        if (!isDeepStrictEqual(stored.transaction, operation.receipt.transaction) || stored.causeId !== operationId || stored.beforeLifecycleVersion !== input.expectedLifecycleVersion || !isDeepStrictEqual(stored.before, before.reviewers) || !isDeepStrictEqual(stored.after, operation.after) || !isDeepStrictEqual(stored.transaction.attribution, operation.attribution) || stored.transaction.fromStatus !== before.lifecycle.status) throw invalid();
        const targetId = 'reviewerId' in input ? input.reviewerId : operation.attribution.principalId, target = stored.after.members.find(member => member.principalId === targetId) ?? stored.before.members.find(member => member.principalId === targetId);
        if (!target) throw invalid();
        const proposed = applyMember(before, input, operation.attribution, { principalId: target.principalId, displayName: target.displayName }, stored.transaction.createdAt), resolution = resolve(proposed, before.head, before.lifecycle.status, before.evidence.errorCount, stored.transaction.id);
        proposed.version++; proposed.updatedAt = stored.transaction.createdAt; proposed.acceptance = resolution.acceptance;
        if (!isDeepStrictEqual(proposed, stored.after) || resolution.status !== stored.transaction.toStatus || this.lifecycle.historicalState(id, stored.transaction.lifecycleVersion).status !== resolution.status) throw invalid();
        return operation;
      } catch { throw invalid(); }
    });
  }
  private historicalAuthor(id: string, version: number): RevisionAuthor | null {
    if (!natural(version)) throw invalid();
    if (version > 0) { const row = this.database.prepare('SELECT data FROM revision_author_transactions WHERE revision_id=? AND author_version=?').get(id, version) as { data: string } | undefined; if (!row) throw invalid(); const transaction = decode<unknown>(row.data); if (!isRevisionAuthorTransaction(transaction, id) || transaction.authorVersion !== version) throw invalid(); return transaction.author; }
    const row = this.database.prepare('SELECT data FROM revision_authorship WHERE revision_id=?').get(id) as { data: string } | undefined; if (!row) throw invalid(); const value = decode<{ originalAuthor: RevisionAuthor | null }>(row.data); if (value.originalAuthor !== null && !isRevisionAuthor(value.originalAuthor)) throw invalid(); return value.originalAuthor;
  }
}
