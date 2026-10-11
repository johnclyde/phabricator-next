import type { PaperCLI } from './paper-builds';
import { isGitObjectId, isGitPath } from '../shared/repositories';
import type { GitComparisonChange, GitComparisonFile, GitComparisonSide } from '../shared/repositories';
import { validGitComparison, validGitComparisonFile } from '../shared/git-comparison';
import { compareFile } from '../shared/comparison';

const safe = (value: string, multiline = false) => value.replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g : /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => safe(character));
function summary(change: GitComparisonChange): string {
  const side = (value: typeof change.before) => value ? `${safe(value.path)} [${value.mode} ${value.type} ${value.objectId}]` : '(absent)';
  return `${change.status}${change.similarity === null ? '' : ` (${change.similarity}% similarity)`}\t${side(change.before)} → ${side(change.after)}`;
}
function sourceState(value: GitComparisonSide | null): string { return value === null ? 'absent' : `${value.state.replaceAll('_', ' ')}${value.size === null ? '' : `, ${value.size} bytes`}`; }
function printFile(result: GitComparisonFile) {
  console.log(summary(result.change));
  console.log(`Before: ${sourceState(result.before)}; after: ${sourceState(result.after)}.`);
  if ([result.before, result.after].some(side => side !== null && side.state !== 'text')) {
    console.log('A text comparison is unavailable for these file types or preview limits. No missing or nontext source is treated as empty.'); return;
  }
  const path = result.change.after?.path ?? result.change.before!.path;
  // Rename alignment is explicit in the verified inventory. The literal helper
  // receives one display path while each original Git path remains in metadata.
  const source = (side: GitComparisonSide | null) => side?.state === 'text' ? { path, content: side.content } : null;
  const comparison = compareFile(source(result.before), source(result.after), 'lines');
  if (comparison.status === 'too_large') { console.log('The literal text comparison exceeds the display limit. Use --json for the exact bounded source response.'); return; }
  if (!comparison.passages.length) { console.log('No text changes. Path, type and mode changes remain listed above.'); return; }
  console.log('Literal lines (- before, + after, space unchanged):');
  for (const segment of comparison.segments) {
    const prefix = segment.kind === 'added' ? '+' : segment.kind === 'removed' ? '-' : ' ';
    const lines = segment.text.split('\n'); if (segment.text.endsWith('\n')) lines.pop();
    for (const line of lines) console.log(prefix + safe(line));
    if (!segment.text.endsWith('\n')) console.log('\\ No final newline in this source segment');
  }
}

/** An explicit immutable read; never selects a branch, edits Git, or creates review evidence. */
export async function gitComparisonCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'compare-commits') return false;
  if (optionNames.some(name => !['server', 'help', 'json', 'base', 'commit', 'before-path', 'after-path'].includes(name))) throw new Error('compare-commits received an unsupported option. Select explicit commit IDs and, optionally, exact before/after paths.');
  const [id] = args;
  if (args.length !== 1 || !id || !/^R[1-9]\d{0,14}$/.test(id)) throw new Error('Provide one repository ID such as R1.');
  const baseInput = options.base, target = options.commit;
  if (typeof baseInput !== 'string' || (baseInput !== 'empty' && !isGitObjectId(baseInput)) || typeof target !== 'string' || !isGitObjectId(target) || (baseInput !== 'empty' && baseInput.length !== target.length)) throw new Error('--base and --commit require full lowercase commit IDs in the same object format; --base empty explicitly selects an empty tree.');
  const pathOption = (name: string): string | null => {
    const value = options[name]; if (value === undefined) return null;
    if (typeof value !== 'string' || !value || !isGitPath(value)) throw new Error(`--${name} requires a nonempty exact Git path.`);
    return value;
  };
  const beforePath = pathOption('before-path'), afterPath = pathOption('after-path'), query = { base: baseInput === 'empty' ? null : baseInput, target };
  if (query.base === null && beforePath !== null) throw new Error('An empty base tree cannot have a before path.');
  const selected = beforePath !== null || afterPath !== null;
  const params = new URLSearchParams({ base: baseInput, target });
  if (beforePath !== null) params.set('beforePath', beforePath);
  if (afterPath !== null) params.set('afterPath', afterPath);
  const result = await request<unknown>(`/api/repositories/${id}/compare${selected ? '/file' : ''}?${params}`);
  if (selected) {
    if (!validGitComparisonFile(result, id, { ...query, beforePath, afterPath })) throw new Error('The comparison does not match the requested immutable commits and paths.');
    if (options.json) console.log(json(result));
    else { console.log(`${id} · ${baseInput} → ${target}`); printFile(result); }
  } else {
    if (!validGitComparison(result, id, query)) throw new Error('The comparison inventory does not match the requested immutable commits.');
    if (options.json) console.log(json(result));
    else {
      console.log(`${id} · ${baseInput} → ${target} · ${result.changes.length} changed entries`);
      for (const change of result.changes) console.log(summary(change));
      if (!result.changes.length) console.log('These exact commits have no file changes.');
      else console.log('Read a listed change by repeating this pair with its --before-path and/or --after-path; omit an absent side.');
    }
  }
  return true;
}
