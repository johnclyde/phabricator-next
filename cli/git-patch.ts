import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { isGitObjectId } from '../shared/repositories';
import { gitPatchBytes, validGitPatch } from '../shared/git-patch';

const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Export bytes only after verifying the entire exact pair. No raw source on the terminal. */
export async function gitPatchCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'download-patch') return false;
  if (optionNames.some(name => !['server', 'help', 'json', 'base', 'commit', 'output'].includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('download-patch requires unique --base, --commit, and --output options.');
  const [id] = args;
  if (args.length !== 1 || !id || !/^R[1-9]\d{0,14}$/.test(id)) throw new Error('Provide one repository ID such as R1.');
  const base = options.base, target = options.commit, output = options.output;
  if (typeof base !== 'string' || base !== 'empty' && !isGitObjectId(base) || typeof target !== 'string' || !isGitObjectId(target) || base !== 'empty' && base.length !== target.length) throw new Error('--base and --commit require full lowercase commit IDs in the same object format, or --base empty.');
  if (typeof output !== 'string' || !output || output === '-' || output.includes('\0')) throw new Error('--output must name a new local file. Raw patch bytes are never printed to the terminal.');
  const query = { base: base === 'empty' ? null : base, target };
  const patch = await request<unknown>(`/api/repositories/${id}/compare/patch?${new URLSearchParams({ base, target })}`);
  const bytes = await gitPatchBytes(patch, id, query);
  if (!validGitPatch(patch, id, query)) throw new Error('Invalid patch metadata.');
  // Publish only complete bytes. A same-directory hard link is atomic and
  // cannot replace an existing destination, including a symbolic link.
  const temporary = join(dirname(output), `.phabricator-patch-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await link(temporary, output);
  } finally { await unlink(temporary); }
  const receipt = { repositoryId: id, base: query.base, target, baseTreeId: patch.baseTreeId, targetTreeId: patch.targetTreeId, format: patch.format, bytes: patch.bytes, sha256: patch.sha256, output };
  console.log(options.json ? JSON.stringify(receipt, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, safe) : `Saved exact patch to ${safe(output)} (${patch.bytes} bytes, SHA-256 ${patch.sha256}).`);
  return true;
}
