import type { DocxProjection, DocxVersionPins } from './docx';

export interface DocxChangeDecision { changeId: string; action: 'accept' | 'reject' }
export interface DocxResolveInput extends DocxVersionPins { decisions: DocxChangeDecision[]; message: string }
export interface DocxResolvableChange { changeId: string; blockId: string; kind: 'ins' | 'del'; text: string; author?: string; date?: string }
export interface DocxResolutionSegment { text: string; changeId?: string; kind?: 'ins' | 'del' }
export interface DocxResolutionInspection {
  format: 'phabricator.docx.resolution.v1';
  changes: DocxResolvableChange[];
  paragraphs: { blockId: string; segments: DocxResolutionSegment[] }[];
  unsupportedChanges: { changeId: string; reason: string }[];
}
export interface DocxResolutionDetail { versionId: string; contentHash: string; packageHash: string; accessEpoch: number; inspection: DocxResolutionInspection }
export const DOCX_RESOLUTION_LIMITS = { serializedBytes: 512 * 1024 } as const;
export function docxResolutionInputCanonical(input: DocxResolveInput): string {
  return JSON.stringify({ expectedVersion: input.expectedVersion, expectedVersionId: input.expectedVersionId, expectedContentHash: input.expectedContentHash, expectedAccessEpoch: input.expectedAccessEpoch,
    decisions: input.decisions.map(decision => ({ changeId: decision.changeId, action: decision.action })), message: input.message });
}
export async function docxResolutionDigest(input: DocxResolveInput): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(docxResolutionInputCanonical(input)))), value => value.toString(16).padStart(2, '0')).join('');
}
/** Pins exact lexical projection identities, never imported w:id or author names. */
export function validateDocxResolution(projection: DocxProjection, decisions: readonly DocxChangeDecision[], inspection?: DocxResolutionInspection): void {
  if (!Array.isArray(decisions) || !decisions.length) throw new Error('Choose at least one tracked Word text change.');
  if (new TextEncoder().encode(JSON.stringify(decisions)).length > DOCX_RESOLUTION_LIMITS.serializedBytes) throw new Error('The complete Word change selection exceeds 512 KiB.');
  const changes = new Map(projection.changes.map(change => [change.id, change])), supported = inspection && new Set(inspection.changes.map(change => change.changeId)), seen = new Set<string>();
  for (const decision of decisions) {
    if (!decision || typeof decision.changeId !== 'string' || !['accept', 'reject'].includes(decision.action)) throw new Error('Choose accept or reject for each exact Word change.');
    if (seen.has(decision.changeId)) throw new Error('Each tracked Word change can have only one decision.'); seen.add(decision.changeId);
    const change = changes.get(decision.changeId);
    if (!change || change.part !== projection.mainPart || !['ins', 'del'].includes(change.kind)) throw new Error('That Word text change is unsupported or no longer matches this source.');
    if (supported && !supported.has(decision.changeId)) throw new Error('Selected Word changes must be ordinary main-document text insertions or deletions, without nested or complex markup.');
  }
}
/** Current/final text hides unresolved deletions; imported revision metadata is unchanged. */
export function docxResolutionPreview(inspection: DocxResolutionInspection, decisions: readonly DocxChangeDecision[]): { blockId: string; before: string; after: string }[] {
  const selected = new Map(decisions.map(decision => [decision.changeId, decision.action]));
  return inspection.paragraphs.filter(paragraph => paragraph.segments.some(segment => segment.changeId && selected.has(segment.changeId))).map(paragraph => ({ blockId: paragraph.blockId,
    before: paragraph.segments.filter(segment => segment.kind !== 'del').map(segment => segment.text).join(''),
    after: paragraph.segments.filter(segment => {
      const action = segment.changeId && selected.get(segment.changeId);
      if (!segment.kind) return true;
      return segment.kind === 'ins' ? action !== 'reject' : action === 'reject';
    }).map(segment => segment.text).join(''),
  }));
}
