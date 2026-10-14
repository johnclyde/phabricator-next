import { createPassageAnchor } from './anchors';
import { applySuggestedReplacement } from './suggestions';
import { docxBatchParagraphs, validateDocxBatch, type DocxPassageReplacement } from './docx-batch';
import type { PassageAnchor, RevisionVersion, SourceFile, SuggestedPassageEdit } from './types';

export const AI_PROPOSAL_LIMITS = { sourceBytes: 200_000, localSourceBytes: 60_000, resultBytes: 1_000_000, responseBytes: 2_000_000, instruction: 10_000, explanation: 20_000, page: 30 } as const;
export type AIProposalProvider = 'openai' | 'ollama';
export interface AIProposalHead { versionId: string; number: number; contentHash: string }
export interface AIProposalConfiguration { configured: boolean; model: string | null; localConfigured: boolean; localModel: string | null }
export interface AIProposalGenerateInput { provider: AIProposalProvider; model: string; instruction: string; expectedHead: AIProposalHead; expectedAccessEpoch: number; scope: PassageAnchor | null; allowHosted: boolean }
export interface AIProposalApplyInput { expectedHead: AIProposalHead; expectedAccessEpoch: number; expectedProposalSha256: string }
export interface AIProposalResult { summary: string; limitations: string; edits: SuggestedPassageEdit[] }
export interface AIProposalProvenance { provider: AIProposalProvider; model: string; responseModel: string | null; providerResponseId: string | null; promptVersion: '1'; sourceSha256: string }
export type AIProposalStatus = 'pending' | 'ready' | 'no_changes' | 'failed' | 'uncertain';
export interface AIProposalApplication { operationId: string; toVersionId: string; toVersion: number; toContentHash: string; createdAt: string }
export interface AIProposal { id: string; revisionId: string; principalId: string; status: AIProposalStatus; request: AIProposalGenerateInput; createdAt: string; completedAt: string | null; provenance: AIProposalProvenance; result: AIProposalResult | null; proposalSha256: string | null; failure: string | null; applied: AIProposalApplication | null }
export interface AIProposalDetail { proposal: AIProposal; currentHead: AIProposalHead; accessEpoch: number; canApply: boolean; stale: boolean }
export interface AIProposalSummary { id: string; status: AIProposalStatus; provider: AIProposalProvider; model: string; instruction: string; source: AIProposalHead; createdAt: string; completedAt: string | null; editCount: number; applied: AIProposalApplication | null }
export interface AIProposalList { items: AIProposalSummary[]; nextBefore: string | null; accessEpoch: number; currentHead: AIProposalHead; configuration: AIProposalConfiguration; canGenerate: boolean }
export interface AIProposalRawEdit { filePath: string; start: number; end: number; quote: string; replacement: string; explanation: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => expected.length === Object.keys(v).length && expected.every(key => Object.hasOwn(v, key));
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const isAIProposalId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const isAIProposalDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function text(v: unknown, max: number, empty = false): string { if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max || v.includes('\0') || /[\uD800-\uDFFF]/u.test(v)) throw new RangeError('Provide complete, bounded text.'); return v; }
export function isAIProposalHead(v: unknown): v is AIProposalHead { return record(v) && keys(v, ['versionId', 'number', 'contentHash']) && isAIProposalId(v.versionId) && natural(v.number) && v.number > 0 && isAIProposalDigest(v.contentHash); }
export const aiProposalHead = (version: RevisionVersion): AIProposalHead => ({ versionId: version.id, number: version.number, contentHash: version.contentHash });
export const sameAIProposalHead = (a: AIProposalHead, b: AIProposalHead): boolean => a.versionId === b.versionId && a.number === b.number && a.contentHash === b.contentHash;
/** Word paragraph paths retain the original block index, never a filtered-list
 * index. Synthetic text is a projection pinned to the original package hash. */
export function aiProposalSourceVersion(version: RevisionVersion): RevisionVersion {
  if (!version.docx) return version;
  const supported = new Set(docxBatchParagraphs(version.docx.projection).map(block => block.id));
  const files = version.docx.projection.blocks.flatMap((block, index) => supported.has(block.id) ? [{ path: `docx/paragraph-${index + 1}.txt`, content: block.text }] : []);
  if (!files.length) throw new RangeError('This Word document has no supported ordinary paragraphs for AI proposals.');
  const { docx: _docx, assets: _assets, ...source } = version;
  return { ...source, files };
}
/** Validate every complete synthetic anchor before mapping it back to Word.
 * The isolated package editor additionally checks original XML structure. */
export function aiProposalWordEdits(version: RevisionVersion, result: AIProposalResult): DocxPassageReplacement[] {
  if (!version.docx) throw new RangeError('A Word proposal requires its original Word source.');
  const source = aiProposalSourceVersion(version); applyTextProposal(source, result);
  const paths = new Set(source.files.map(file => file.path));
  const replacements = result.edits.map(edit => {
    const match = /^docx\/paragraph-([1-9]\d*)\.txt$/.exec(edit.anchor.filePath), block = match && version.docx!.projection.blocks[Number(match[1]) - 1];
    if (!block || !paths.has(edit.anchor.filePath)) throw new RangeError('This proposal refers to an unsupported Word paragraph.');
    return { blockId: block.id, start: edit.anchor.start, end: edit.anchor.end, quote: edit.anchor.quote, replacement: edit.replacement };
  });
  try { validateDocxBatch(version.docx.projection, replacements); } catch (error) { throw new RangeError(error instanceof Error ? error.message : 'The Word edit batch is invalid.'); }
  return replacements;
}
function anchor(v: unknown): PassageAnchor {
  if (!record(v) || !keys(v, ['versionId', 'contentHash', 'filePath', 'start', 'end', 'quote', 'prefix', 'suffix']) || !isAIProposalId(v.versionId) || !isAIProposalDigest(v.contentHash) || !natural(v.start) || !natural(v.end) || v.end <= v.start) throw new RangeError('Choose an exact source passage.');
  const a = { versionId: v.versionId, contentHash: v.contentHash, filePath: text(v.filePath, 240), start: v.start, end: v.end, quote: text(v.quote, 20_000), prefix: text(v.prefix, 80, true), suffix: text(v.suffix, 80, true) };
  if (a.end - a.start !== a.quote.length) throw new RangeError('Passage offsets must match its exact quotation.'); return a;
}
export function aiProposalGenerateInput(v: unknown): AIProposalGenerateInput {
  if (!record(v) || !keys(v, ['provider', 'model', 'instruction', 'expectedHead', 'expectedAccessEpoch', 'scope', 'allowHosted']) || !['openai', 'ollama'].includes(String(v.provider)) || !isAIProposalHead(v.expectedHead) || !natural(v.expectedAccessEpoch) || v.allowHosted !== (v.provider === 'openai')) throw new RangeError('Choose a provider, exact current source and explicit hosted processing permission.');
  return { provider: v.provider as AIProposalProvider, model: text(v.model, 200), instruction: text(v.instruction, AI_PROPOSAL_LIMITS.instruction), expectedHead: { ...v.expectedHead }, expectedAccessEpoch: v.expectedAccessEpoch, scope: v.scope === null ? null : anchor(v.scope), allowHosted: v.allowHosted };
}
export function aiProposalApplyInput(v: unknown): AIProposalApplyInput {
  if (!record(v) || !keys(v, ['expectedHead', 'expectedAccessEpoch', 'expectedProposalSha256']) || !isAIProposalHead(v.expectedHead) || !natural(v.expectedAccessEpoch) || !isAIProposalDigest(v.expectedProposalSha256)) throw new RangeError('Review the complete proposal and current source before applying.');
  return { expectedHead: { ...v.expectedHead }, expectedAccessEpoch: v.expectedAccessEpoch, expectedProposalSha256: v.expectedProposalSha256 };
}
/** Providers return exact UTF-16 offsets, never fuzzy quotation matches. A bad
 * edit rejects the entire proposal, with no partial truncation or application. */
export function aiProposalResult(v: unknown, version: RevisionVersion, scope: PassageAnchor | null): AIProposalResult {
  if (!record(v) || !keys(v, ['summary', 'limitations', 'edits']) || !Array.isArray(v.edits) || new TextEncoder().encode(JSON.stringify(v)).length > AI_PROPOSAL_LIMITS.resultBytes) throw new RangeError('The provider returned an invalid or oversized proposal.');
  const source = aiProposalSourceVersion(version);
  const result: AIProposalResult = { summary: text(v.summary, 20_000), limitations: text(v.limitations, 20_000), edits: v.edits.map(raw => {
    if (!record(raw) || !keys(raw, ['filePath', 'start', 'end', 'quote', 'replacement', 'explanation']) || !natural(raw.start) || !natural(raw.end)) throw new RangeError('Every edit must contain an exact source passage and an explanation.');
    const a = createPassageAnchor(source, text(raw.filePath, 240), { start: raw.start, end: raw.end, quote: text(raw.quote, 20_000) });
    if (scope && (a.filePath !== scope.filePath || a.start < scope.start || a.end > scope.end)) throw new RangeError('A proposed edit falls outside the selected passage.');
    return { anchor: a, replacement: text(raw.replacement, 20_000, true), explanation: text(raw.explanation, AI_PROPOSAL_LIMITS.explanation) };
  }) };
  if (result.edits.length) applyAIProposal(version, result);
  return result;
}
export function applyAIProposal(version: RevisionVersion, result: AIProposalResult): SourceFile[] {
  if (version.docx) aiProposalWordEdits(version, result);
  return applyTextProposal(aiProposalSourceVersion(version), result);
}
function applyTextProposal(version: RevisionVersion, result: AIProposalResult): SourceFile[] {
  const first = result.edits[0]; if (!first) throw new RangeError('A no-change proposal has no source edits to apply.');
  return applySuggestedReplacement(version, first.anchor, { replacement: first.replacement, additionalEdits: result.edits.slice(1) }, first.explanation);
}
function application(v: unknown): v is AIProposalApplication { return record(v) && keys(v, ['operationId', 'toVersionId', 'toVersion', 'toContentHash', 'createdAt']) && isAIProposalId(v.operationId) && isAIProposalId(v.toVersionId) && natural(v.toVersion) && v.toVersion > 0 && isAIProposalDigest(v.toContentHash) && typeof v.createdAt === 'string'; }
export function isAIProposalDetail(v: unknown): v is AIProposalDetail {
  try {
    if (!record(v) || !keys(v, ['proposal', 'currentHead', 'accessEpoch', 'canApply', 'stale']) || !isAIProposalHead(v.currentHead) || !natural(v.accessEpoch) || typeof v.canApply !== 'boolean' || typeof v.stale !== 'boolean') return false;
    const p = v.proposal;
    if (!record(p) || !keys(p, ['id', 'revisionId', 'principalId', 'status', 'request', 'createdAt', 'completedAt', 'provenance', 'result', 'proposalSha256', 'failure', 'applied']) || !isAIProposalId(p.id) || typeof p.revisionId !== 'string' || !/^[DPL][1-9]\d*$/.test(p.revisionId) || typeof p.principalId !== 'string' || !p.principalId || !['pending', 'ready', 'no_changes', 'failed', 'uncertain'].includes(String(p.status))) return false;
    const input = aiProposalGenerateInput(p.request); text(p.createdAt, 100); if (p.completedAt !== null) text(p.completedAt, 100); if (p.failure !== null) text(p.failure, 1000);
    const provenance = p.provenance;
    if (!record(provenance) || !keys(provenance, ['provider', 'model', 'responseModel', 'providerResponseId', 'promptVersion', 'sourceSha256']) || provenance.provider !== input.provider || provenance.model !== input.model || provenance.promptVersion !== '1' || !isAIProposalDigest(provenance.sourceSha256)) return false;
    if (provenance.responseModel !== null) text(provenance.responseModel, 200); if (provenance.providerResponseId !== null) text(provenance.providerResponseId, 200);
    if (p.applied !== null && !application(p.applied)) return false;
    if (p.status === 'ready' || p.status === 'no_changes') {
      if (!isAIProposalDigest(p.proposalSha256) || p.completedAt === null || p.failure !== null || !record(p.result) || !keys(p.result, ['summary', 'limitations', 'edits']) || !Array.isArray(p.result.edits)) return false;
      text(p.result.summary, 20_000); text(p.result.limitations, 20_000);
      for (const edit of p.result.edits) { if (!record(edit) || !keys(edit, ['anchor', 'replacement', 'explanation'])) return false; const a = anchor(edit.anchor); if (a.versionId !== input.expectedHead.versionId || a.contentHash !== input.expectedHead.contentHash) return false; text(edit.replacement, 20_000, true); text(edit.explanation, 20_000); }
      if ((p.status === 'ready') !== (p.result.edits.length > 0) || new TextEncoder().encode(JSON.stringify(p.result)).length > AI_PROPOSAL_LIMITS.resultBytes) return false;
    } else if (p.result !== null || p.proposalSha256 !== null || p.applied !== null) return false;
    return v.stale === !sameAIProposalHead(input.expectedHead, v.currentHead) && (!v.canApply || p.status === 'ready' && !v.stale && p.applied === null);
  } catch { return false; }
}
export function isAIProposalList(v: unknown): v is AIProposalList {
  if (!record(v) || !keys(v, ['items', 'nextBefore', 'accessEpoch', 'currentHead', 'configuration', 'canGenerate']) || !Array.isArray(v.items) || v.items.length > AI_PROPOSAL_LIMITS.page || !natural(v.accessEpoch) || !isAIProposalHead(v.currentHead) || typeof v.canGenerate !== 'boolean' || (v.nextBefore !== null && !isAIProposalId(v.nextBefore))) return false;
  const c = v.configuration; if (!record(c) || !keys(c, ['configured', 'model', 'localConfigured', 'localModel']) || typeof c.configured !== 'boolean' || typeof c.localConfigured !== 'boolean' || c.model !== null && typeof c.model !== 'string' || c.localModel !== null && typeof c.localModel !== 'string') return false;
  return v.items.every(item => record(item) && keys(item, ['id', 'status', 'provider', 'model', 'instruction', 'source', 'createdAt', 'completedAt', 'editCount', 'applied']) && isAIProposalId(item.id) && ['pending', 'ready', 'no_changes', 'failed', 'uncertain'].includes(String(item.status)) && ['openai', 'ollama'].includes(String(item.provider)) && typeof item.model === 'string' && typeof item.instruction === 'string' && isAIProposalHead(item.source) && typeof item.createdAt === 'string' && (item.completedAt === null || typeof item.completedAt === 'string') && natural(item.editCount) && (item.applied === null || application(item.applied))) && new Set(v.items.map(item => (item as AIProposalSummary).id)).size === v.items.length;
}
