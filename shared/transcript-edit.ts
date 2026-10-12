import { createPassageAnchor } from './anchors.ts';
import { createDocxPassageAnchor } from './docx-discussion.ts';
import { applySuggestedReplacement, validateSuggestion } from './suggestions.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from './transcription-model.ts';
import type { PassageAnchor, RevisionVersion, SourceFile } from './types.ts';

/** Client-reported provenance, not server-verified ASR or review evidence. */
export interface TranscriptEditOrigin {
  kind: 'client-local-transcript';
  clipId: string; runId: string; audioSha256: string; audioBytes: number;
  modelId: string; modelRevision: string; modelManifestSha256: string; runtimeVersion: string;
  originalTextSha256: string; editedTextSha256: string;
}
export type TranscriptEditTarget = { kind: 'text'; anchor: PassageAnchor } | { kind: 'docx'; rangeId: string; start: number; end: number; quote: string };
export interface TranscriptEditInput {
  format: 'phabricator.transcript-edit.v1'; revisionId: string;
  expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedAccessEpoch: number;
  target: TranscriptEditTarget; replacement: string; message: string; origin: TranscriptEditOrigin;
}
export interface TranscriptSourceEdit {
  format: 'phabricator.transcript-source-edit.v1'; fromVersionId: string; fromContentHash: string;
  target: TranscriptEditTarget; origin: TranscriptEditOrigin; inputSha256: string;
}
export const TRANSCRIPT_EDIT_LIMITS = Object.freeze({ textCodeUnits: 20_000, messageCodeUnits: 1000 });
const fail = (message: string): never => { throw new RangeError(message); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Provide a supported transcript edit object.');
  if (Object.keys(value).some(key => !keys.includes(key))) return fail('The transcript edit contains an unsupported field.');
  return value as Record<string, unknown>;
};
/** UTF-8 hashing is unambiguous only for complete Unicode strings. No normalization occurs. */
export function transcriptEditText(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0) || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) return fail(`${label} must contain ${empty ? '' : 'nonempty '}complete Unicode text of at most ${max.toLocaleString('en-US')} characters, without null characters.`);
  return value;
}
function identity(value: unknown, label: string, max = 100): string {
  const text = transcriptEditText(value, max, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(text)) return fail(`${label} is invalid.`);
  return text;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(`${label} must be an exact lowercase SHA-256 digest.`);
  return value;
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return fail(`${label} must be a safe integer of at least ${minimum}.`);
  return value;
}
export function parseTranscriptEditOrigin(value: unknown): TranscriptEditOrigin {
  const row = object(value, ['kind', 'clipId', 'runId', 'audioSha256', 'audioBytes', 'modelId', 'modelRevision', 'modelManifestSha256', 'runtimeVersion', 'originalTextSha256', 'editedTextSha256']);
  if (row.kind !== 'client-local-transcript' || row.modelId !== TRANSCRIPTION_MODEL.repository || row.modelRevision !== TRANSCRIPTION_MODEL.revision || row.modelManifestSha256 !== TRANSCRIPTION_MODEL_SHA256 || row.runtimeVersion !== '4.3.1') return fail('The client-reported transcription model identity is unsupported.');
  const audioBytes = integer(row.audioBytes, 'Audio bytes', 1);
  if (audioBytes > 25 * 1024 * 1024) return fail('The original audio exceeds the supported recording size.');
  return { kind: row.kind, clipId: identity(row.clipId, 'Clip identity', 200), runId: identity(row.runId, 'Run identity', 200), audioSha256: digest(row.audioSha256, 'Audio digest'), audioBytes, modelId: row.modelId, modelRevision: row.modelRevision, modelManifestSha256: row.modelManifestSha256, runtimeVersion: row.runtimeVersion, originalTextSha256: digest(row.originalTextSha256, 'Original transcript digest'), editedTextSha256: digest(row.editedTextSha256, 'Edited transcript digest') };
}
function parseTarget(value: unknown): TranscriptEditTarget {
  const kind = value && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  const row = object(value, kind === 'text' ? ['kind', 'anchor'] : ['kind', 'rangeId', 'start', 'end', 'quote']);
  const data = kind === 'text' ? object(row.anchor, ['versionId', 'contentHash', 'filePath', 'start', 'end', 'quote', 'prefix', 'suffix']) : row;
  const start = integer(data.start, 'Passage start'), end = integer(data.end, 'Passage end', 1), quote = transcriptEditText(data.quote, TRANSCRIPT_EDIT_LIMITS.textCodeUnits, 'Original quotation');
  if (end <= start || end - start !== quote.length) return fail('The passage offsets must match its exact nonempty quotation.');
  if (kind === 'docx') return { kind, rangeId: transcriptEditText(row.rangeId, 2000, 'Word range identity'), start, end, quote };
  if (kind !== 'text') return fail('Choose a text or supported Word passage.');
  const filePath = transcriptEditText(data.filePath, 240, 'Source path');
  if (filePath.startsWith('/') || /[\u0000-\u001f\u007f\\:]/.test(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..')) return fail('Choose a safe relative source path.');
  return { kind, anchor: { versionId: identity(data.versionId, 'Anchor version'), contentHash: digest(data.contentHash, 'Anchor content digest'), filePath, start, end, quote, prefix: transcriptEditText(data.prefix, 80, 'Passage prefix', true), suffix: transcriptEditText(data.suffix, 80, 'Passage suffix', true) } };
}
/** Fixed field construction makes JSON.stringify of the returned value canonical for operation hashing. */
export function parseTranscriptEditInput(value: unknown): TranscriptEditInput {
  const row = object(value, ['format', 'revisionId', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', 'target', 'replacement', 'message', 'origin']);
  if (row.format !== 'phabricator.transcript-edit.v1' || typeof row.revisionId !== 'string' || !/^[DPL][1-9]\d{0,14}$/.test(row.revisionId)) return fail('Choose a supported revision for this transcript edit.');
  const expectedVersion = integer(row.expectedVersion, 'Expected version', 1), expectedVersionId = identity(row.expectedVersionId, 'Expected version identity'), expectedContentHash = digest(row.expectedContentHash, 'Expected content digest'), expectedAccessEpoch = integer(row.expectedAccessEpoch, 'Expected access epoch', 1);
  const target = parseTarget(row.target), replacement = transcriptEditText(row.replacement, TRANSCRIPT_EDIT_LIMITS.textCodeUnits, 'Replacement');
  const quote = target.kind === 'text' ? target.anchor.quote : target.quote;
  validateSuggestion({ quote }, { replacement });
  if (target.kind === 'text' && (target.anchor.versionId !== expectedVersionId || target.anchor.contentHash !== expectedContentHash)) return fail('The selected passage belongs to a different immutable source version.');
  if (target.kind === 'docx' && /[\u0000-\u001F\uFFFE\uFFFF]/u.test(replacement)) return fail('Word replacements support one line of prose without tabs, line breaks, or control characters.');
  const message = transcriptEditText(row.message, TRANSCRIPT_EDIT_LIMITS.messageCodeUnits, 'Edit message');
  if (!message.trim()) return fail('Describe the source edit before saving.');
  return { format: row.format, revisionId: row.revisionId, expectedVersion, expectedVersionId, expectedContentHash, expectedAccessEpoch, target, replacement, message, origin: parseTranscriptEditOrigin(row.origin) };
}
/** Snapshot equality and exact source validation; no quote search, relocation, interpretation, or head fallback. */
export function validateTranscriptEditTarget(version: RevisionVersion, value: TranscriptEditInput): void {
  const input = parseTranscriptEditInput(value);
  if (version.revisionId !== input.revisionId || version.number !== input.expectedVersion || version.id !== input.expectedVersionId || version.contentHash !== input.expectedContentHash) return fail('The transcript edit belongs to a different immutable source version.');
  if (input.target.kind === 'docx') {
    if (!version.docx || version.files.length) return fail('Choose a supported Word version.');
    createDocxPassageAnchor(version, input.target);
    return;
  }
  if (version.docx) return fail('Word edits require an exact supported Word passage.');
  const expected = createPassageAnchor(version, input.target.anchor.filePath, input.target.anchor);
  if (expected.prefix !== input.target.anchor.prefix || expected.suffix !== input.target.anchor.suffix) return fail('The original passage context does not match this source version.');
}
export function applyTranscriptTextEdit(version: RevisionVersion, value: TranscriptEditInput): SourceFile[] {
  const input = parseTranscriptEditInput(value); validateTranscriptEditTarget(version, input);
  if (input.target.kind !== 'text') return fail('Word edits must use the tracked Word package replacement engine.');
  return applySuggestedReplacement(version, input.target.anchor, { replacement: input.replacement });
}
export function transcriptSourceEdit(value: TranscriptEditInput, inputSha256: string): TranscriptSourceEdit {
  const input = parseTranscriptEditInput(value);
  return { format: 'phabricator.transcript-source-edit.v1', fromVersionId: input.expectedVersionId, fromContentHash: input.expectedContentHash, target: input.target, origin: input.origin, inputSha256: digest(inputSha256, 'Operation digest') };
}
