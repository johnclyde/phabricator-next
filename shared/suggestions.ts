import { createPassageAnchor } from './anchors';
import type { PassageAnchor, RevisionVersion, SourceFile, SuggestedReplacement } from './types';

const MAX_REPLACEMENT_LENGTH = 20_000;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** An empty replacement deliberately deletes the anchored passage. */
export function validateSuggestion(anchor: Pick<PassageAnchor, 'quote'>, suggestion: SuggestedReplacement): SuggestedReplacement {
  if (!anchor || typeof anchor.quote !== 'string' || !anchor.quote.length) {
    throw new RangeError('A suggested replacement requires a nonempty original passage.');
  }
  if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)
    || Object.keys(suggestion).some(key => key !== 'replacement') || typeof suggestion.replacement !== 'string') {
    throw new RangeError('Provide a suggestion containing only replacement text. Use an empty string to delete the passage.');
  }
  const { replacement } = suggestion;
  if (replacement.length > MAX_REPLACEMENT_LENGTH) throw new RangeError('Suggested replacement text must contain at most 20,000 UTF-16 code units.');
  if (replacement.includes('\0')) throw new RangeError('Suggested replacement text must not contain null characters.');
  if (hasUnpairedSurrogate(replacement)) throw new RangeError('Suggested replacement text must contain complete Unicode characters, without unpaired surrogates.');
  if (replacement === anchor.quote) throw new RangeError('Change the replacement text before suggesting an edit; it currently matches the original passage.');
  return { replacement };
}

/** Apply only to the exact original snapshot. Projection never authorizes a write. */
export function applySuggestedReplacement(version: RevisionVersion, anchor: PassageAnchor, suggestion: SuggestedReplacement): SourceFile[] {
  const { replacement } = validateSuggestion(anchor, suggestion);
  if (version.id !== anchor.versionId || version.contentHash !== anchor.contentHash) {
    throw new RangeError('This suggestion belongs to a different source version. Review the current source and create a new suggestion.');
  }
  const verified = createPassageAnchor(version, anchor.filePath, { start: anchor.start, end: anchor.end, quote: anchor.quote });
  if (verified.prefix !== anchor.prefix || verified.suffix !== anchor.suffix) {
    throw new RangeError('The original passage context does not match this source. Reload the revision before applying the suggestion.');
  }
  return version.files.map(file => ({
    path: file.path,
    content: file.path === verified.filePath
      ? file.content.slice(0, verified.start) + replacement + file.content.slice(verified.end)
      : file.content,
  }));
}
