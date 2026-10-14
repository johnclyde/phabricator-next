import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import type { ActorAttribution, RevisionKind, RevisionVersion } from '../shared/types.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { AI_PROPOSAL_LIMITS, aiProposalApplyInput, aiProposalGenerateInput, aiProposalHead, aiProposalResult, aiProposalSourceVersion, aiProposalWordEdits, applyAIProposal, isAIProposalDetail, isAIProposalDigest, isAIProposalId, sameAIProposalHead, type AIProposal, type AIProposalApplication, type AIProposalApplyInput, type AIProposalConfiguration, type AIProposalDetail, type AIProposalGenerateInput, type AIProposalList, type AIProposalProvenance, type AIProposalResult, type AIProposalStatus } from '../shared/ai-proposals.ts';
import { aiConfiguration } from './ai.ts';
import { aiProposalSource, AIProposalProviderError, generateAIProposal, type AIProposalGenerator } from './ai-proposal-provider.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { contentHash, docxOperationHash, type Store } from './store.ts';
import { replaceDocxBatch } from './docx-package.ts';
import type { DocxReplaceBatchInput } from '../shared/docx-batch.ts';
import type { DocxProjection, DocxRun } from '../shared/docx.ts';
import { files, HttpError } from './validation.ts';

const definitions = [
  ['table', 'ai_proposal_requests', "CREATE TABLE ai_proposal_requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,retry_key_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(principal_id,retry_key_sha256))"],
  ['table', 'ai_proposal_results', 'CREATE TABLE ai_proposal_results(proposal_id TEXT PRIMARY KEY REFERENCES ai_proposal_requests(id),data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['table', 'ai_proposal_applications', 'CREATE TABLE ai_proposal_applications(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL UNIQUE REFERENCES ai_proposal_requests(id),principal_id TEXT NOT NULL,retry_key_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(principal_id,retry_key_sha256))'],
  ...['requests', 'results', 'applications'].flatMap(table => ['UPDATE', 'DELETE'].map(action => ['trigger', `ai_proposal_${table}_no_${action.toLowerCase()}`, `CREATE TRIGGER ai_proposal_${table}_no_${action.toLowerCase()} BEFORE ${action} ON ai_proposal_${table} BEGIN SELECT RAISE(ABORT,'AI proposal evidence is immutable'); END`])),
] as readonly (readonly string[])[];
export function initializeAIProposals(database: DatabaseSync): void {
  database.exec('SAVEPOINT ai_proposal_schema');
  try {
    const existing = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name GLOB 'ai_proposal_*'").all() as { type: string; name: string; sql: string }[];
    for (const row of existing) { const expected = definitions.find(item => item[1] === row.name); if (!expected || row.type !== expected[0] || row.sql !== expected[2]) throw new Error(`Unexpected ${row.name} schema; AI proposal migration was not applied.`); }
    for (const [, name, sql] of definitions) if (!existing.some(row => row.name === name)) database.exec(sql!);
    database.exec('RELEASE ai_proposal_schema');
  } catch (error) { database.exec('ROLLBACK TO ai_proposal_schema; RELEASE ai_proposal_schema'); throw error; }
}
export type AIProposalAuthorization = 'read' | 'generate:openai' | 'generate:ollama' | 'apply';
export interface AIProposalOptions { authorize(actor: AuthContext, revisionId: string, action: AIProposalAuthorization): void; configuration?: () => AIProposalConfiguration; provider?: AIProposalGenerator; replaceWordBatch?: typeof replaceDocxBatch }
interface RequestEvidence { id: string; revisionId: string; principalId: string; retryKeySha256: string; inputSha256: string; input: AIProposalGenerateInput; sourceSha256: string; createdAt: string; actor: ActorAttribution }
interface ResultEvidence { status: Exclude<AIProposalStatus, 'pending'>; completedAt: string; provenance: AIProposalProvenance; result: AIProposalResult | null; proposalSha256: string | null; failure: string | null }
interface ApplicationEvidence { proposalId: string; revisionId: string; principalId: string; retryKeySha256: string; inputSha256: string; input: AIProposalApplyInput; application: AIProposalApplication; actor: ActorAttribution }
const exact = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const timestamp = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unavailable = () => new HttpError(404, 'This private AI proposal is unavailable.', 'AI_PROPOSAL_UNAVAILABLE');
const invalid = () => new HttpError(409, 'Saved AI proposal evidence could not be verified.', 'AI_PROPOSAL_INVALID');
const changed = () => new HttpError(409, 'The source or access changed. Review the current source before generating or applying edits.', 'AI_PROPOSAL_CHANGED');
const parse = <T,>(work: () => T): T => { try { return work(); } catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message, 'AI_PROPOSAL_INPUT'); throw error; } };
const revisionId = (id: string): boolean => /^[DPL][1-9]\d{0,14}$/.test(id);
function attribution(actor: AuthContext, requestId: string): ActorAttribution { return { principalId: actor.principalId, displayName: actor.displayName, credentialId: actor.credentialId, requestId }; }
function digest(request: RequestEvidence, result: AIProposalResult, provenance: AIProposalProvenance): string { return hash({ inputSha256: request.inputSha256, sourceSha256: request.sourceSha256, provenance, result }); }

/** Generation has its own durable reservation, before the network call. An exact
 * retry can only read that attempt, never dispatch it again, including after a
 * process interruption. Applying uses Store.mutate for one atomic source version. */
export class AIProposalService {
  constructor(private readonly store: Store, private readonly options: AIProposalOptions) {}
  private epoch(): number { return Number(this.store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value); }
  private authorize(id: string, actor: AuthContext, action: AIProposalAuthorization): void {
    if (!revisionId(id)) throw unavailable();
    this.options.authorize(actor, id, action);
    if (!actor.scopes.includes('read') || action !== 'read' && !actor.scopes.includes('write') || action === 'generate:openai' && !actor.scopes.includes('review:hosted') || action === 'generate:ollama' && !actor.scopes.includes('review:local')) throw new HttpError(403, 'This credential does not permit the requested AI proposal action.', 'ACTION_FORBIDDEN');
  }
  private source(id: string, versionId?: string): { kind: RevisionKind; version: RevisionVersion } {
    const entity = this.store.database.prepare("SELECT data FROM entities WHERE id=? AND kind='revision'").get(id) as { data: string } | undefined;
    if (!entity) throw unavailable();
    const revision = JSON.parse(entity.data) as { kind: RevisionKind; currentVersion: number };
    const row = versionId ? this.store.database.prepare('SELECT data FROM versions WHERE revision_id=? AND id=?').get(id, versionId) : this.store.database.prepare('SELECT data FROM versions WHERE revision_id=? AND number=?').get(id, revision.currentVersion);
    if (!row) throw invalid();
    const version = JSON.parse(String(row.data)) as RevisionVersion;
    if (version.revisionId !== id || version.contentHash !== contentHash(version.files, version.assets, version.docx)) throw invalid();
    if (version.docx) this.store.docxBytes(id, version.id);
    return { kind: revision.kind, version };
  }
  private requireHead(id: string, input: { expectedHead: AIProposalGenerateInput['expectedHead']; expectedAccessEpoch: number }): { kind: RevisionKind; version: RevisionVersion } {
    const source = this.source(id); if (this.epoch() !== input.expectedAccessEpoch || !sameAIProposalHead(input.expectedHead, aiProposalHead(source.version))) throw changed();
    try { aiProposalSourceVersion(source.version); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'This source is unsupported.', 'AI_PROPOSAL_SOURCE_UNSUPPORTED'); } return source;
  }
  private key(key: string | undefined, actor: AuthContext): string { if (!key || key.length > 200 || key.includes('\0')) throw new HttpError(400, 'A bounded Idempotency-Key is required.'); return hash([actor.workspaceId, actor.principalId, key]); }
  private request(id: string, proposalId: string, actor: AuthContext): RequestEvidence {
    if (!isAIProposalId(proposalId)) throw unavailable();
    const row = this.store.database.prepare('SELECT revision_id,principal_id,retry_key_sha256,input_sha256,data FROM ai_proposal_requests WHERE id=? AND revision_id=? AND principal_id=?').get(proposalId, id, actor.principalId) as { revision_id: string; principal_id: string; retry_key_sha256: string; input_sha256: string; data: string } | undefined;
    if (!row) throw unavailable();
    try {
      const request = JSON.parse(row.data) as RequestEvidence, input = aiProposalGenerateInput(request.input), source = this.source(id, input.expectedHead.versionId);
      if (!exact(request, ['id', 'revisionId', 'principalId', 'retryKeySha256', 'inputSha256', 'input', 'sourceSha256', 'createdAt', 'actor']) || !isRevisionMetadataAttribution(request.actor) || !timestamp(request.createdAt) || !isAIProposalDigest(request.retryKeySha256) || !isAIProposalDigest(request.sourceSha256) || request.id !== proposalId || request.revisionId !== id || request.principalId !== actor.principalId || request.actor.principalId !== actor.principalId || request.retryKeySha256 !== row.retry_key_sha256 || request.inputSha256 !== row.input_sha256 || request.inputSha256 !== hash([id, input]) || !isDeepStrictEqual(input, request.input) || !sameAIProposalHead(input.expectedHead, aiProposalHead(source.version)) || request.sourceSha256 !== hash(aiProposalSource(source.kind, source.version, input))) throw invalid();
      this.scope(source.version, input); return request;
    } catch { throw invalid(); }
  }
  private scope(version: RevisionVersion, input: AIProposalGenerateInput): void {
    if (input.scope && (!isDeepStrictEqual(createPassageAnchor(aiProposalSourceVersion(version), input.scope.filePath, input.scope), input.scope) || input.scope.versionId !== version.id || input.scope.contentHash !== version.contentHash)) throw changed();
  }
  private application(request: RequestEvidence, proposalSha256: string | null): ApplicationEvidence | null {
    const row = this.store.database.prepare('SELECT id,principal_id,retry_key_sha256,input_sha256,data FROM ai_proposal_applications WHERE proposal_id=?').get(request.id) as { id: string; principal_id: string; retry_key_sha256: string; input_sha256: string; data: string } | undefined;
    if (!row) return null;
    try {
      const evidence = JSON.parse(row.data) as ApplicationEvidence, input = aiProposalApplyInput(evidence.input), to = this.source(request.revisionId, evidence.application.toVersionId).version;
      if (!exact(evidence, ['proposalId', 'revisionId', 'principalId', 'retryKeySha256', 'inputSha256', 'input', 'application', 'actor']) || !isRevisionMetadataAttribution(evidence.actor) || !isAIProposalDigest(evidence.retryKeySha256) || !timestamp(evidence.application.createdAt) || evidence.application.operationId !== row.id || evidence.proposalId !== request.id || evidence.revisionId !== request.revisionId || evidence.principalId !== request.principalId || evidence.principalId !== row.principal_id || evidence.actor.principalId !== request.principalId || evidence.retryKeySha256 !== row.retry_key_sha256 || evidence.inputSha256 !== row.input_sha256 || evidence.inputSha256 !== hash([request.id, input]) || input.expectedProposalSha256 !== proposalSha256 || !sameAIProposalHead(input.expectedHead, request.input.expectedHead) || to.number !== evidence.application.toVersion || to.contentHash !== evidence.application.toContentHash || to.number !== request.input.expectedHead.number + 1 || !isDeepStrictEqual(to.attribution, evidence.actor)) throw invalid();
      return evidence;
    } catch { throw invalid(); }
  }
  private proposal(request: RequestEvidence): AIProposal {
    const pending: AIProposal = { id: request.id, revisionId: request.revisionId, principalId: request.principalId, status: 'pending', request: request.input, createdAt: request.createdAt, completedAt: null, provenance: { provider: request.input.provider, model: request.input.model, responseModel: null, providerResponseId: null, promptVersion: '1', sourceSha256: request.sourceSha256 }, result: null, proposalSha256: null, failure: null, applied: null };
    const row = this.store.database.prepare('SELECT data FROM ai_proposal_results WHERE proposal_id=?').get(request.id) as { data: string } | undefined;
    if (!row) return pending;
    try {
      const result = JSON.parse(row.data) as ResultEvidence;
      if (!exact(result, ['status', 'completedAt', 'provenance', 'result', 'proposalSha256', 'failure']) || !timestamp(result.completedAt)) throw invalid();
      const application = this.application(request, result.proposalSha256);
      const proposal: AIProposal = { ...pending, ...result, applied: application?.application ?? null };
      if (!isAIProposalDetail({ proposal, currentHead: request.input.expectedHead, accessEpoch: this.epoch(), canApply: false, stale: false }) || result.provenance.sourceSha256 !== request.sourceSha256) throw invalid();
      if (result.result) {
        const source = this.source(request.revisionId, request.input.expectedHead.versionId).version;
        const verified = aiProposalResult({ ...result.result, edits: result.result.edits.map(edit => ({ filePath: edit.anchor.filePath, start: edit.anchor.start, end: edit.anchor.end, quote: edit.anchor.quote, replacement: edit.replacement, explanation: edit.explanation })) }, source, request.input.scope);
        if (!isDeepStrictEqual(verified, result.result) || result.proposalSha256 !== digest(request, result.result, result.provenance)) throw invalid();
        if (application) {
          const to = this.source(request.revisionId, application.application.toVersionId).version;
          if (source.docx) this.verifyWordApplication(source, to, proposal, application);
          else if (to.docx || !isDeepStrictEqual(applyAIProposal(source, verified), to.files) || !isDeepStrictEqual(source.assets ?? [], to.assets ?? [])) throw invalid();
        }
      }
      return proposal;
    } catch { throw invalid(); }
  }
  private detailFor(request: RequestEvidence, actor: AuthContext): AIProposalDetail {
    const proposal = this.proposal(request), currentHead = aiProposalHead(this.source(request.revisionId).version), stale = !sameAIProposalHead(currentHead, request.input.expectedHead);
    let canApply = false;
    if (proposal.status === 'ready' && !stale && !proposal.applied) { try { this.authorize(request.revisionId, actor, 'apply'); canApply = true; } catch { /* A private reader may lack source edit authority. */ } }
    return { proposal, currentHead, stale, canApply, accessEpoch: this.epoch() };
  }
  detail(id: string, proposalId: string, actor: AuthContext): AIProposalDetail { return this.store.read(() => { this.authorize(id, actor, 'read'); return this.detailFor(this.request(id, proposalId, actor), actor); }); }
  list(id: string, actor: AuthContext, query: { before?: string; limit?: number } = {}): AIProposalList {
    if (query.before !== undefined && !isAIProposalId(query.before) || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > AI_PROPOSAL_LIMITS.page)) throw new HttpError(400, 'Choose a valid private proposal page.');
    return this.store.read(() => {
      this.authorize(id, actor, 'read');
      const before = query.before ? this.store.database.prepare('SELECT sequence FROM ai_proposal_requests WHERE id=? AND revision_id=? AND principal_id=?').get(query.before, id, actor.principalId) : null;
      if (query.before && !before) throw unavailable();
      const size = query.limit ?? AI_PROPOSAL_LIMITS.page, rows = this.store.database.prepare('SELECT id FROM ai_proposal_requests WHERE revision_id=? AND principal_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(id, actor.principalId, before?.sequence ?? null, before?.sequence ?? null, size + 1) as { id: string }[];
      const more = rows.length > size; if (more) rows.pop();
      const items = rows.map(row => { const p = this.proposal(this.request(id, row.id, actor)); return { id: p.id, status: p.status, provider: p.provenance.provider, model: p.provenance.model, instruction: p.request.instruction, source: p.request.expectedHead, createdAt: p.createdAt, completedAt: p.completedAt, editCount: p.result?.edits.length ?? 0, applied: p.applied }; });
      let canGenerate = false; for (const provider of ['openai', 'ollama'] as const) { try { this.authorize(id, actor, `generate:${provider}`); canGenerate = true; } catch { /* Report current credential capability without exposing other owners. */ } }
      return { items, nextBefore: more ? items.at(-1)!.id : null, currentHead: aiProposalHead(this.source(id).version), accessEpoch: this.epoch(), configuration: (this.options.configuration ?? aiConfiguration)(), canGenerate };
    });
  }
  async generate(id: string, raw: unknown, key: string | undefined, actor: AuthContext, signal?: AbortSignal): Promise<AIProposalDetail> {
    signal?.throwIfAborted();
    const input = parse(() => aiProposalGenerateInput(raw)), retryKeySha256 = this.key(key, actor), inputSha256 = hash([id, input]);
    const reserved = this.store.transaction(() => {
      this.authorize(id, actor, `generate:${input.provider}`);
      const existing = this.store.database.prepare('SELECT id,revision_id,input_sha256 FROM ai_proposal_requests WHERE principal_id=? AND retry_key_sha256=?').get(actor.principalId, retryKeySha256) as { id: string; revision_id: string; input_sha256: string } | undefined;
      if (existing) { if (existing.revision_id !== id || existing.input_sha256 !== inputSha256) throw new HttpError(409, 'This retry key already names a different AI generation request.', 'AI_PROPOSAL_RETRY_MISMATCH'); const request = this.request(id, existing.id, actor); if (!isDeepStrictEqual(request.input, input)) throw invalid(); return { request, replay: true as const }; }
      const source = this.requireHead(id, input); parse(() => this.scope(source.version, input));
      const config = (this.options.configuration ?? aiConfiguration)();
      if (input.provider === 'openai' ? !config.configured || config.model !== input.model : !config.localConfigured || config.localModel !== input.model) throw new HttpError(409, 'The selected provider model is not currently configured. Refresh before generating.', 'AI_PROPOSAL_NOT_CONFIGURED');
      const submission = aiProposalSource(source.kind, source.version, input), proposalId = randomUUID();
      const request: RequestEvidence = { id: proposalId, revisionId: id, principalId: actor.principalId, retryKeySha256, inputSha256, input, sourceSha256: hash(submission), createdAt: new Date().toISOString(), actor: attribution(actor, `ai-proposal:${proposalId}`) };
      this.store.database.prepare('INSERT INTO ai_proposal_requests(id,revision_id,principal_id,retry_key_sha256,input_sha256,data) VALUES(?,?,?,?,?,?)').run(request.id, id, actor.principalId, retryKeySha256, inputSha256, JSON.stringify(request));
      return { request, replay: false as const, source: source.version, submission };
    });
    if (reserved.replay) return this.detail(id, reserved.request.id, actor);
    const request = reserved.request;
    try {
      // Reservation is committed before source leaves the process. No provider
      // action runs under a database lock, including a caller's exact retry.
      signal?.throwIfAborted();
      this.authorize(id, actor, `generate:${input.provider}`); this.requireHead(id, input);
      const generated = await (this.options.provider ?? generateAIProposal)(input, reserved.submission, signal, () => { signal?.throwIfAborted(); this.authorize(id, actor, `generate:${input.provider}`); this.requireHead(id, input); });
      signal?.throwIfAborted();
      const result = parse(() => aiProposalResult(generated.result, reserved.source, input.scope));
      if (result.edits.length && !reserved.source.docx) files(applyAIProposal(reserved.source, result));
      const provenance: AIProposalProvenance = { provider: input.provider, model: input.model, responseModel: generated.responseModel, providerResponseId: generated.providerResponseId, promptVersion: '1', sourceSha256: request.sourceSha256 };
      const evidence: ResultEvidence = { status: result.edits.length ? 'ready' : 'no_changes', completedAt: new Date().toISOString(), provenance, result, proposalSha256: digest(request, result, provenance), failure: null };
      this.store.transaction(() => {
        signal?.throwIfAborted();
        this.authorize(id, actor, `generate:${input.provider}`); this.requireHead(id, input);
        const candidate = { ...this.proposal(request), ...evidence };
        if (!isAIProposalDetail({ proposal: candidate, currentHead: input.expectedHead, accessEpoch: this.epoch(), canApply: false, stale: false })) throw invalid();
        this.store.database.prepare('INSERT INTO ai_proposal_results(proposal_id,data) VALUES(?,?)').run(request.id, JSON.stringify(evidence));
      });
    } catch (error) {
      const evidence: ResultEvidence = { status: signal?.aborted ? 'uncertain' : error instanceof AIProposalProviderError ? error.outcome : error instanceof HttpError || error instanceof RangeError ? 'failed' : 'uncertain', completedAt: new Date().toISOString(), provenance: { provider: input.provider, model: input.model, responseModel: null, providerResponseId: null, promptVersion: '1', sourceSha256: request.sourceSha256 }, result: null, proposalSha256: null,
        failure: signal?.aborted ? 'Generation was interrupted. The provider may have incurred usage; this attempt will not be sent again.' : error instanceof AIProposalProviderError ? error.message : error instanceof HttpError && error.code === 'AI_PROPOSAL_CHANGED' ? 'Source or access changed during generation. Generated edits were discarded.' : 'Generation could not produce a verified proposal. This attempt will not be sent again.' };
      // A revoked credential may not see its result, but its durable reservation
      // still needs a content-free outcome so recovery never re-dispatches it.
      this.store.transaction(() => { this.store.database.prepare('INSERT OR IGNORE INTO ai_proposal_results(proposal_id,data) VALUES(?,?)').run(request.id, JSON.stringify(evidence)); });
      this.authorize(id, actor, 'read');
    }
    return this.detail(id, request.id, actor);
  }
  private applyReplay(id: string, proposalId: string, input: AIProposalApplyInput, retryKeySha256: string, inputSha256: string, actor: AuthContext): { request: RequestEvidence; proposal: AIProposal; replay: boolean } {
    const request = this.request(id, proposalId, actor), proposal = this.proposal(request);
    const existing = this.store.database.prepare('SELECT proposal_id,input_sha256,data FROM ai_proposal_applications WHERE principal_id=? AND retry_key_sha256=?').get(actor.principalId, retryKeySha256) as { proposal_id: string; input_sha256: string; data: string } | undefined;
    if (existing) {
      if (existing.proposal_id !== proposalId || existing.input_sha256 !== inputSha256) throw new HttpError(409, 'This retry key already names a different proposal application.', 'AI_PROPOSAL_RETRY_MISMATCH');
      if (!isDeepStrictEqual((JSON.parse(existing.data) as ApplicationEvidence).input, input) || !proposal.applied) throw invalid();
    }
    return { request, proposal, replay: !!existing };
  }
  private applySource(id: string, input: AIProposalApplyInput, proposal: AIProposal): RevisionVersion {
    const source = this.requireHead(id, input).version;
    if (proposal.status !== 'ready' || !proposal.result || proposal.applied || proposal.proposalSha256 !== input.expectedProposalSha256 || !sameAIProposalHead(input.expectedHead, proposal.request.expectedHead)) throw changed();
    return source;
  }
  private message(proposal: AIProposal): string { return `Applied AI-assisted edits proposed by ${proposal.provenance.provider} model ${proposal.provenance.model}.`; }
  private wordInput(source: RevisionVersion, proposal: AIProposal, input: AIProposalApplyInput): DocxReplaceBatchInput {
    return { expectedVersion: input.expectedHead.number, expectedVersionId: input.expectedHead.versionId, expectedContentHash: input.expectedHead.contentHash, expectedAccessEpoch: input.expectedAccessEpoch, replacements: aiProposalWordEdits(source, proposal.result!), message: this.message(proposal) };
  }
  /** Checks immutable operation identity and the exact tracked textual result. XML
   * preservation is independently enforced by the package worker before commit. */
  private verifyWordApplication(source: RevisionVersion, to: RevisionVersion, proposal: AIProposal, evidence: ApplicationEvidence): void {
    const input = this.wordInput(source, proposal, evidence.input), before = source.docx!, after = to.docx;
    if (!after || to.files.length || to.assets !== undefined || !isDeepStrictEqual(before.sourceFile, after.sourceFile) || before.fileName !== after.fileName || before.sha256 === after.sha256
      || !isDeepStrictEqual(to.docxOperation, { kind: 'replace-batch', inputSha256: docxOperationHash(input) }) || to.message !== this.message(proposal)) throw invalid();
    this.verifyWordProjection(before.projection, after.projection, input, evidence.actor.displayName, evidence.application.createdAt);
  }
  private verifyWordProjection(before: DocxProjection, after: DocxProjection, input: DocxReplaceBatchInput, author: string, date: string): void {
    if (before.mainPart !== after.mainPart || before.blocks.length !== after.blocks.length || !isDeepStrictEqual(before.notes, after.notes) || !isDeepStrictEqual(before.comments, after.comments) || !isDeepStrictEqual(before.warnings, after.warnings)) throw invalid();
    const semanticRun = ({ rangeId: _rangeId, ...run }: DocxRun) => run;
    const changes = before.changes.map(({ id: _id, ...change }) => change);
    for (let index = 0; index < before.blocks.length; index++) {
      const block = before.blocks[index]!, next = after.blocks[index]!;
      if (block.part !== next.part || block.kind !== next.kind || block.headingLevel !== next.headingLevel) throw invalid();
      const edits = input.replacements.filter(edit => edit.blockId === block.id).sort((a, b) => a.start - b.start);
      if (!edits.length) { if (block.text !== next.text || !isDeepStrictEqual(block.runs.map(semanticRun), next.runs.map(semanticRun))) throw invalid(); continue; }
      let expected = block.text; for (const edit of [...edits].reverse()) expected = expected.slice(0, edit.start) + edit.replacement + expected.slice(edit.end);
      if (next.runs.filter(run => run.change !== 'deleted' && run.change !== 'moveFrom').map(run => run.text).join('') !== expected
        || next.runs.filter(run => run.change !== 'inserted' && run.change !== 'moveTo').map(run => run.text).join('') !== block.text) throw invalid();
      let offset = 0;
      for (const run of block.runs) {
        const end = offset + run.text.length;
        for (const edit of edits.filter(edit => edit.end > offset && edit.start < end)) {
          changes.push({ part: block.part, kind: 'del', text: run.text.slice(Math.max(offset, edit.start) - offset, Math.min(end, edit.end) - offset), author, date });
          if (edit.start >= offset && edit.start < end && edit.replacement) changes.push({ part: block.part, kind: 'ins', text: edit.replacement, author, date });
        }
        offset = end;
      }
    }
    const canonical = (values: typeof changes) => values.map(value => JSON.stringify([value.part, value.kind, value.text, value.author ?? null, value.date ?? null])).sort();
    if (!isDeepStrictEqual(canonical(changes), canonical(after.changes.map(({ id: _id, ...change }) => change)))) throw invalid();
  }
  /** Word package preparation is isolated and cancellable, outside any DB lock. */
  async applyAsync(id: string, proposalId: string, raw: unknown, key: string | undefined, actor: AuthContext, signal?: AbortSignal): Promise<AIProposalDetail> {
    signal?.throwIfAborted();
    const input = parse(() => aiProposalApplyInput(raw)), retryKeySha256 = this.key(key, actor), inputSha256 = hash([proposalId, input]);
    const prepared = this.store.read(() => {
      this.authorize(id, actor, 'apply');
      const current = this.applyReplay(id, proposalId, input, retryKeySha256, inputSha256, actor);
      if (current.replay) return { replay: this.detailFor(current.request, actor) };
      const source = this.applySource(id, input, current.proposal);
      if (!source.docx) return { text: true as const };
      const operationId = randomUUID(), actorProof = attribution(actor, `ai-proposal-apply:${operationId}`), createdAt = new Date().toISOString();
      return { source, wordInput: this.wordInput(source, current.proposal, input), bytes: this.store.docxBytes(id, source.id), operationId, actorProof, createdAt };
    });
    if (prepared.replay) return prepared.replay;
    if (prepared.text) return this.apply(id, proposalId, raw, key, actor);
    signal?.throwIfAborted(); this.authorize(id, actor, 'apply'); this.requireHead(id, input);
    let result: Awaited<ReturnType<typeof replaceDocxBatch>>;
    try { result = await (this.options.replaceWordBatch ?? replaceDocxBatch)(prepared.bytes!, prepared.wordInput!.replacements, { author: prepared.actorProof!.displayName, date: prepared.createdAt! }, signal); }
    catch (error) { this.authorize(id, actor, 'apply'); throw error; }
    signal?.throwIfAborted();
    return this.commitApply(id, proposalId, input, retryKeySha256, inputSha256, actor, { ...prepared, result } as PreparedWordApplication, signal);
  }
  apply(id: string, proposalId: string, raw: unknown, key: string | undefined, actor: AuthContext): AIProposalDetail {
    const input = parse(() => aiProposalApplyInput(raw)), retryKeySha256 = this.key(key, actor), inputSha256 = hash([proposalId, input]);
    return this.commitApply(id, proposalId, input, retryKeySha256, inputSha256, actor);
  }
  private commitApply(id: string, proposalId: string, input: AIProposalApplyInput, retryKeySha256: string, inputSha256: string, actor: AuthContext, prepared?: PreparedWordApplication, signal?: AbortSignal): AIProposalDetail {
    return this.store.mutate(undefined, inputSha256, () => {
      signal?.throwIfAborted();
      const { request, proposal, replay } = this.applyReplay(id, proposalId, input, retryKeySha256, inputSha256, actor);
      if (replay) return { status: 200, body: this.detailFor(request, actor) };
      const source = this.applySource(id, input, proposal), operationId = prepared?.operationId ?? randomUUID(), actorProof = prepared?.actorProof ?? attribution(actor, `ai-proposal-apply:${operationId}`), createdAt = prepared?.createdAt ?? new Date().toISOString();
      if (source.docx && !prepared) throw new HttpError(409, 'Word proposal application requires asynchronous package processing.', 'AI_PROPOSAL_WORD_PROCESSING');
      if (prepared && (!source.docx || !isDeepStrictEqual(prepared.wordInput, this.wordInput(source, proposal, input)))) throw changed();
      if (prepared) this.verifyWordProjection(source.docx!.projection, prepared.result.projection, prepared.wordInput, actorProof.displayName, createdAt);
      const detail = prepared ? this.store.replaceDocxBatchVersion(id, prepared.wordInput, prepared.result.bytes, prepared.result.projection, actorProof)
        : this.store.createVersion(id, { files: parse(() => applyAIProposal(source, proposal.result!)), message: this.message(proposal), expectedVersion: source.number }, actorProof);
      const to = detail.versions.find(version => version.number === detail.revision.currentVersion)!;
      const application: AIProposalApplication = { operationId, toVersionId: to.id, toVersion: to.number, toContentHash: to.contentHash, createdAt };
      const evidence: ApplicationEvidence = { proposalId, revisionId: id, principalId: actor.principalId, retryKeySha256, inputSha256, input, application, actor: actorProof };
      this.store.database.prepare('INSERT INTO ai_proposal_applications(id,proposal_id,principal_id,retry_key_sha256,input_sha256,data) VALUES(?,?,?,?,?,?)').run(operationId, proposalId, actor.principalId, retryKeySha256, inputSha256, JSON.stringify(evidence));
      return { status: 200, body: this.detailFor(request, actor) };
    }, () => { signal?.throwIfAborted(); this.authorize(id, actor, 'apply'); }).body as AIProposalDetail;
  }
}
interface PreparedWordApplication { wordInput: DocxReplaceBatchInput; operationId: string; actorProof: ActorAttribution; createdAt: string; result: Awaited<ReturnType<typeof replaceDocxBatch>> }
