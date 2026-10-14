import type { PassageAnchor, RevisionVersion } from '../shared/types';
import { AI_PROPOSAL_LIMITS, aiProposalGenerateInput, aiProposalApplyInput, applyAIProposal, isAIProposalDetail, type AIProposalDetail, type AIProposalApplyInput, type AIProposalGenerateInput } from '../shared/ai-proposals';
import { createPassageAnchor } from '../shared/anchors';

export interface AIProposalDraft { revisionId: string; principalId: string; versionId: string; contentHash: string; instruction: string; scope: PassageAnchor | null }
export type AIProposalIntent = { id: string; revisionId: string; principalId: string } & ({ kind: 'generate'; proposalId: null; input: AIProposalGenerateInput } | { kind: 'apply'; proposalId: string; input: AIProposalApplyInput });
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, maximum = 20_000): v is string => typeof v === 'string' && v.length <= maximum;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
function anchor(v: unknown): v is PassageAnchor {
  return object(v) && keys(v, ['versionId', 'contentHash', 'filePath', 'start', 'end', 'quote', 'prefix', 'suffix']) && id(v.versionId) && hash(v.contentHash) && text(v.filePath, 240) && v.filePath.length > 0 && integer(v.start) && integer(v.end, 1) && v.end > v.start && text(v.quote) && v.quote.length === v.end - v.start && text(v.prefix, 80) && text(v.suffix, 80);
}
function head(v: unknown): boolean { return object(v) && keys(v, ['versionId', 'number', 'contentHash']) && id(v.versionId) && integer(v.number, 1) && hash(v.contentHash); }
export function aiProposalDraft(value: unknown, revisionId: string, principalId: string): AIProposalDraft | null {
  if (!object(value) || !keys(value, ['revisionId', 'principalId', 'versionId', 'contentHash', 'instruction', 'scope']) || value.revisionId !== revisionId || value.principalId !== principalId || !id(value.versionId) || !hash(value.contentHash) || !text(value.instruction, AI_PROPOSAL_LIMITS.instruction) || value.scope !== null && (!anchor(value.scope) || value.scope.versionId !== value.versionId || value.scope.contentHash !== value.contentHash)) return null;
  return value as unknown as AIProposalDraft;
}
export function aiProposalIntent(value: unknown, revisionId: string, principalId: string): AIProposalIntent | null {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'principalId', 'kind', 'proposalId', 'input']) || !uuid(value.id) || value.revisionId !== revisionId || value.principalId !== principalId || !object(value.input) || !head(value.input.expectedHead) || !integer(value.input.expectedAccessEpoch)) return null;
  const input = value.input;
  if (value.kind === 'generate') {
    if (value.proposalId !== null || !keys(input, ['provider', 'model', 'instruction', 'expectedHead', 'expectedAccessEpoch', 'scope', 'allowHosted']) || !['openai', 'ollama'].includes(String(input.provider)) || !text(input.model, 200) || !input.model.trim() || !text(input.instruction, AI_PROPOSAL_LIMITS.instruction) || !input.instruction.trim() || input.allowHosted !== (input.provider === 'openai') || input.scope !== null && (!anchor(input.scope) || input.scope.versionId !== (input.expectedHead as Record<string, unknown>).versionId || input.scope.contentHash !== (input.expectedHead as Record<string, unknown>).contentHash)) return null;
  } else if (value.kind === 'apply') {
    if (!uuid(value.proposalId) || !keys(input, ['expectedHead', 'expectedAccessEpoch', 'expectedProposalSha256']) || !hash(input.expectedProposalSha256)) return null;
  } else return null;
  try { if (value.kind === 'generate') aiProposalGenerateInput(value.input); else aiProposalApplyInput(value.input); } catch { return null; }
  return value as unknown as AIProposalIntent;
}
/** Exact original authority only; a matching quotation in another version is not enough. */
export function aiProposalScopeMatches(version: RevisionVersion, scope: PassageAnchor | null): boolean {
  if (scope === null) return !version.docx;
  if (version.docx || scope.versionId !== version.id || scope.contentHash !== version.contentHash) return false;
  try { const exact = createPassageAnchor(version, scope.filePath, scope); return (Object.keys(exact) as (keyof PassageAnchor)[]).every(key => exact[key] === scope[key]); } catch { return false; }
}
export const aiProposalDraftKey = (revisionId: string, versionId: string) => `ai-proposal-draft:${revisionId}:${versionId}`;

/** A complete preview must still agree with the original immutable source. */
export function aiProposalDetailForVersion(value: unknown, revisionId: string, principalId: string, version: RevisionVersion): AIProposalDetail | null {
  if (!isAIProposalDetail(value) || value.proposal.revisionId !== revisionId || value.proposal.principalId !== principalId || value.proposal.request.expectedHead.versionId !== version.id || value.proposal.request.expectedHead.number !== version.number || value.proposal.request.expectedHead.contentHash !== version.contentHash || !aiProposalScopeMatches(version, value.proposal.request.scope)) return null;
  try {
    if (value.proposal.result?.edits.length) {
      const scope = value.proposal.request.scope;
      if (scope && value.proposal.result.edits.some(edit => edit.anchor.filePath !== scope.filePath || edit.anchor.start < scope.start || edit.anchor.end > scope.end)) return null;
      applyAIProposal(version, value.proposal.result);
    }
  } catch { return null; }
  return value;
}
