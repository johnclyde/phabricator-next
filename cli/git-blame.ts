import type { PaperCLI } from './paper-builds';
import { isGitObjectId, isGitPath } from '../shared/repositories';
import { gitSourceLines, validGitBlame } from '../shared/git-blame';

const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => safe(character));

/** Read provenance at one immutable source path; no branch lookup or review mutation. */
export async function gitBlameCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'blame') return false;
  if (optionNames.some(name => !['server', 'help', 'json', 'commit', 'path'].includes(name))) throw new Error('blame accepts only an exact --commit and --path, with optional --json.');
  const [id] = args, commitId = options.commit, path = options.path;
  if (args.length !== 1 || !id || !/^R[1-9]\d{0,14}$/.test(id)) throw new Error('Provide one repository ID such as R1.');
  if (typeof commitId !== 'string' || !isGitObjectId(commitId) || typeof path !== 'string' || !path || !isGitPath(path)) throw new Error('Provide a full lowercase --commit ID and a nonempty exact --path.');
  const params = new URLSearchParams({ commit: commitId, path });
  const result = await request<unknown>(`/api/repositories/${id}/blame?${params}`);
  if (!validGitBlame(result, id, commitId, path)) throw new Error('The line provenance does not match the requested immutable commit and path.');
  if (options.json) { console.log(json(result)); return true; }
  console.log(`${id} · ${commitId} · ${safe(path)}`);
  console.log(`Blob ${result.blob.objectId} · Mode ${result.blob.mode} · ${result.blob.size === null ? 'Gitlink' : `${result.blob.size} bytes`}`);
  if (result.blob.state !== 'text' || result.lines === null) {
    console.log(`Line provenance is unavailable: ${result.blob.state.replaceAll('_', ' ')}. No partial or substituted source is shown.`); return true;
  }
  if (!result.lines.length) { console.log('Empty text file: no source lines to attribute.'); return true; }
  console.log('Origin commits:');
  for (const commit of result.commits) console.log(`${commit.id} · ${safe(commit.author.name)} <${safe(commit.author.email)}> · ${safe(commit.author.timestamp)} · ${safe(commit.message.split('\n')[0] || '')}`);
  console.log('Line | Origin commit | Original path:line | Literal source');
  const lines = gitSourceLines(result.blob.content);
  for (const line of result.lines) console.log(`${line.lineNumber} | ${line.commitId} | ${safe(line.path)}:${line.originalLine} | ${safe(lines[line.lineNumber - 1]!)}`);
  if (!result.blob.content.endsWith('\n')) console.log('\\ No final newline in this source file');
  return true;
}
