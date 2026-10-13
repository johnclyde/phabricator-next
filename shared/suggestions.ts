import { createPassageAnchor } from './anchors';
import type { PassageAnchor, RevisionVersion, SourceFile, SuggestedPassageEdit, SuggestedReplacement } from './types';

export const SUGGESTION_LIMITS = { edits: 20, replacement: 20_000, explanation: 20_000, totalText: 100_000 } as const;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new RangeError(`${name} must be text.`);
  if (value.length > maximum) throw new RangeError(`${name} must contain at most ${maximum.toLocaleString('en-US')} UTF-16 code units.`);
  if (value.includes('\0')) throw new RangeError(`${name} must not contain null characters.`);
  if (/[\uD800-\uDFFF]/u.test(value)) throw new RangeError(`${name} must contain complete Unicode characters, without unpaired surrogates.`);
  return value;
}

function passage(value: unknown): PassageAnchor {
  if (!record(value) || !exactKeys(value, ['versionId', 'contentHash', 'filePath', 'start', 'end', 'quote', 'prefix', 'suffix'])) throw new RangeError('Every additional edit requires a complete exact source anchor.');
  const versionId = text(value.versionId, 'Passage version', 100), contentHash = text(value.contentHash, 'Passage hash', 100), filePath = text(value.filePath, 'Passage file path', 240);
  const quote = text(value.quote, 'Original passage', 20_000), prefix = text(value.prefix, 'Passage prefix', 80), suffix = text(value.suffix, 'Passage suffix', 80);
  if (!versionId.length || !contentHash.length || !filePath.length || !quote.length || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || Number(value.start) < 0 || Number(value.end) <= Number(value.start) || Number(value.end) - Number(value.start) !== quote.length) throw new RangeError('Every additional edit requires a nonempty original passage with exact integer offsets.');
  return { versionId, contentHash, filePath, start: value.start as number, end: value.end as number, quote, prefix, suffix };
}

function validate(anchor: Pick<PassageAnchor, 'quote'>, suggestion: SuggestedReplacement, primaryExplanation: string, draft: boolean): SuggestedReplacement {
  if (!anchor || typeof anchor.quote !== 'string' || !anchor.quote.length) throw new RangeError('A suggested replacement requires a nonempty original passage.');
  const original = text(anchor.quote, 'Original passage', 20_000);
  if (!record(suggestion) || !exactKeys(suggestion, ['replacement'], ['additionalEdits'])) throw new RangeError('Provide a suggestion containing replacement text and optional additional edits. Use an empty string to delete a passage.');
  const replacement = text(suggestion.replacement, 'Suggested replacement text', SUGGESTION_LIMITS.replacement);
  if (!draft && replacement === original) throw new RangeError('Change the replacement text before suggesting an edit; it currently matches the original passage.');
  let total = original.length + replacement.length + text(primaryExplanation, 'Suggested edit explanation', SUGGESTION_LIMITS.explanation).length;
  let additionalEdits: SuggestedPassageEdit[] | undefined;
  if (suggestion.additionalEdits !== undefined) {
    if (!Array.isArray(suggestion.additionalEdits) || suggestion.additionalEdits.length >= SUGGESTION_LIMITS.edits) throw new RangeError('A suggestion may contain at most 20 passages, including its original passage.');
    additionalEdits = suggestion.additionalEdits.map((edit: unknown) => {
      if (!record(edit) || !exactKeys(edit, ['anchor', 'replacement', 'explanation'])) throw new RangeError('Every additional edit requires an anchor, replacement text and explanation.');
      const anchor = passage(edit.anchor), replacement = text(edit.replacement, 'Suggested replacement text', SUGGESTION_LIMITS.replacement), explanation = text(edit.explanation, 'Suggested edit explanation', SUGGESTION_LIMITS.explanation);
      if (!draft && !explanation.trim()) throw new RangeError('Explain every additional edit before proposing it.');
      if (!draft && replacement === anchor.quote) throw new RangeError('Change every replacement before suggesting edits; one still matches its original passage.');
      total += anchor.quote.length + replacement.length + explanation.length;
      return { anchor, replacement, explanation };
    });
  }
  // Keep locally edited text recoverable even when it exceeds the publication
  // budget. Passage count and individual text limits still bound retained drafts.
  if (!draft && total > SUGGESTION_LIMITS.totalText) throw new RangeError('A suggestion may contain at most 100,000 UTF-16 code units across original passages, replacements and explanations.');
  return { replacement, ...(additionalEdits !== undefined ? { additionalEdits } : {}) };
}

/** Empty replacement text deliberately deletes the original passage. */
export function validateSuggestion(anchor: Pick<PassageAnchor, 'quote'>, suggestion: SuggestedReplacement, primaryExplanation = ''): SuggestedReplacement {
  return validate(anchor, suggestion, primaryExplanation, false);
}

/** Local drafts retain unfinished or over-budget text; publication remains strict. */
export function validateSuggestionDraft(anchor: Pick<PassageAnchor, 'quote'>, suggestion: SuggestedReplacement, primaryExplanation = ''): SuggestedReplacement {
  return validate(anchor, suggestion, primaryExplanation, true);
}

/** Publication order is preserved for previews; application uses original source offsets. */
export function suggestionEdits(anchor: PassageAnchor, suggestion: SuggestedReplacement, explanation = ''): SuggestedPassageEdit[] {
  return [{ anchor: { ...anchor }, replacement: suggestion.replacement, explanation }, ...(suggestion.additionalEdits ?? []).map(edit => ({ ...edit, anchor: { ...edit.anchor } }))];
}

/** Apply the complete set only to its exact original snapshot. Projection never authorizes a write. */
export function applySuggestedReplacement(version: RevisionVersion, anchor: PassageAnchor, suggestion: SuggestedReplacement, primaryExplanation = ''): SourceFile[] {
  if (version.docx) throw new RangeError('Text suggestions cannot modify a Word package.');
  const validated = validateSuggestion(anchor, suggestion, primaryExplanation);
  const edits = suggestionEdits(anchor, validated, primaryExplanation);
  const byFile = new Map<string, SuggestedPassageEdit[]>();
  for (const edit of edits) {
    if (version.id !== edit.anchor.versionId || version.contentHash !== edit.anchor.contentHash) throw new RangeError('This suggestion belongs to a different source version. Review the current source and create a new suggestion.');
    if (version.files.filter(file => file.path === edit.anchor.filePath).length > 1) throw new RangeError('The original passage file is ambiguous in this source.');
    const verified = createPassageAnchor(version, edit.anchor.filePath, { start: edit.anchor.start, end: edit.anchor.end, quote: edit.anchor.quote });
    if (verified.prefix !== edit.anchor.prefix || verified.suffix !== edit.anchor.suffix) throw new RangeError('The original passage context does not match this source. Reload the revision before applying the suggestion.');
    const fileEdits = byFile.get(verified.filePath) ?? [];
    fileEdits.push({ ...edit, anchor: verified });
    byFile.set(verified.filePath, fileEdits);
  }
  for (const fileEdits of byFile.values()) {
    fileEdits.sort((left, right) => left.anchor.start - right.anchor.start);
    for (let index = 1; index < fileEdits.length; index++) {
      if (fileEdits[index]!.anchor.start < fileEdits[index - 1]!.anchor.end) throw new RangeError('Suggested passages must not overlap. Choose separate original passages.');
    }
  }
  return version.files.map(file => {
    let content = file.content;
    for (const edit of [...(byFile.get(file.path) ?? [])].reverse()) content = content.slice(0, edit.anchor.start) + edit.replacement + content.slice(edit.anchor.end);
    return { path: file.path, content };
  });
}
