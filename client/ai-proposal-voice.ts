import type { AIProposalDetail } from '../shared/ai-proposals';

export type AIProposalVoiceAction = 'currentAIEdit' | 'nextAIEdit' | 'previousAIEdit' | 'readAIExplanation' | 'prepareAIApply' | 'confirmAIApply' | 'cancelAIApply' | 'dictateAIInstruction';
export interface AIProposalController {
  revisionId: string;
  readonly identity: string;
  execute(action: AIProposalVoiceAction, instruction?: string): { text: string; identity: string };
}
export type RegisterAIProposal = (controller: AIProposalController | null) => void;
export const AI_PROPOSAL_SPEECH_LIMIT = 3_200;

function excerpt(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')} … Excerpt shortened; the complete text is in the edit preview.`;
}
export function aiProposalLocation(path: string): string {
  const paragraph = /^docx\/paragraph-([1-9]\d*)\.txt$/.exec(path);
  return paragraph ? `Word paragraph ${paragraph[1]}` : path;
}
/** Caller supplies an authorized exact-version result; this never reads or sends source. */
export function aiProposalEditNarration(detail: AIProposalDetail, index: number, explanationOnly = false): string {
  const edits = detail.proposal.result?.edits ?? [], edit = edits[index];
  if (!edit) return 'No AI edit is selected. Inspect a completed proposal first.';
  const header = `Edit ${index + 1} of ${edits.length}, original version ${detail.proposal.request.expectedHead.number}, ${excerpt(aiProposalLocation(edit.anchor.filePath), 180)}.`;
  const body = explanationOnly ? `Explanation: ${excerpt(edit.explanation, 2_500)}` : `Original: ${excerpt(edit.anchor.quote, 1_000)}. Replacement: ${edit.replacement ? excerpt(edit.replacement, 1_000) : '[delete the selected passage]'}. Say read AI explanation for the reason.`;
  return excerpt(`${header} ${body}${detail.stale ? ' Historical proposal; it cannot be applied to the current source.' : ''}`, AI_PROPOSAL_SPEECH_LIMIT);
}

/** Every field is a pin, including authority and the caller's source context. */
export function aiProposalConfirmationIdentity(detail: AIProposalDetail | null, sourceContext: string, authority: readonly (string | number | boolean | null)[]): string | null {
  if (!detail?.canApply || detail.stale || detail.proposal.applied || detail.proposal.status !== 'ready' || !detail.proposal.proposalSha256 || !detail.proposal.result?.edits.length) return null;
  return JSON.stringify([detail.proposal.id, detail.proposal.principalId, detail.proposal.proposalSha256, detail.proposal.request.expectedHead, detail.currentHead, detail.accessEpoch, sourceContext, authority]);
}
