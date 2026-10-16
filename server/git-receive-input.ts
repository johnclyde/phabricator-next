import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { PublicGitProjection } from './git-public-projection.ts';
import { HttpError } from './validation.ts';

const invalid = () => new HttpError(422, 'The push must contain complete objects based on published repository history.', 'GIT_RECEIVE_OBJECTS');
const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };

/** Validate against an isolated published object database before receive-pack can
 * consult the authoritative database, which may contain unpublished drafts. */
export async function validateGitReceiveInput(input: string, bytes: number, projection: Pick<PublicGitProjection, 'path' | 'objectFormat'>, signal: AbortSignal): Promise<string> {
  const file = await open(input, 'r'); let offset = 0, commands = '';
  const length = projection.objectFormat === 'sha1' ? 40 : 64, refs = new Set<string>(), tips: string[] = [];
  try {
    while (true) {
      const header = Buffer.alloc(4);
      if (signal.aborted || (await file.read(header, 0, 4, offset)).bytesRead !== 4 || !/^[0-9a-f]{4}$/i.test(header.toString('ascii'))) throw invalid();
      offset += 4; const size = parseInt(header.toString('ascii'), 16);
      if (size === 0) break;
      if (size < 5 || size > 65520 || offset + size - 4 > bytes || offset + size - 4 > 128_000 || refs.size >= 100) throw invalid();
      const data = Buffer.alloc(size - 4);
      if ((await file.read(data, 0, data.length, offset)).bytesRead !== data.length) throw invalid();
      offset += data.length;
      let line: string;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw invalid(); }
      if (line.endsWith('\n')) line = line.slice(0, -1);
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        if (refs.size !== 0 || line.indexOf('\0', nul + 1) >= 0) throw invalid();
        const capabilities = line.slice(nul + 1).trim().split(' ');
        // No signed-push framing, push-options section or client-selected hooks.
        if (capabilities.some(value => !/^(report-status(?:-v2)?|side-band-64k|quiet|atomic|ofs-delta|agent=[!-~]+|object-format=sha(?:1|256))$/.test(value))) throw invalid();
        line = line.slice(0, nul);
      }
      const match = new RegExp(`^([0-9a-f]{${length}}) ([0-9a-f]{${length}}) (refs/(?:heads|tags)/[^\\s\\x00-\\x1f\\x7f]+)$`).exec(line);
      if (!match || refs.has(match[3]!) || match[1] === match[2]) throw invalid();
      refs.add(match[3]!); commands += line + '\n';
      if (!/^0+$/.test(match[2]!)) tips.push(match[2]!);
    }
  } finally { await file.close(); }
  if (!refs.size) throw invalid();
  async function run(args: string[], pack = false): Promise<void> {
    if (signal.aborted) throw invalid();
    const child = spawn('git', ['--no-replace-objects', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '--git-dir', projection.path, ...args], { cwd: '/', env: environment, stdio: [pack ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    let size = 0, failure = false;
    const stop = () => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const bounded = (chunk: Buffer) => { size += chunk.length; if (size > 128_000) stop(); };
    child.stdout!.on('data', bounded); child.stderr!.on('data', bounded); child.on('error', stop);
    signal.addEventListener('abort', stop, { once: true });
    const exit = new Promise<number | null>(resolve => child.once('close', resolve));
    const sending = pack ? pipeline(createReadStream(input, { start: offset }), child.stdin!).catch(stop) : Promise.resolve();
    if (signal.aborted) stop();
    try { const code = await exit; await sending; if (code !== 0 || failure || signal.aborted) throw invalid(); }
    finally { signal.removeEventListener('abort', stop); }
  }
  if (bytes > offset) await run(['index-pack', '--stdin', '--fix-thin', '--strict', '--max-input-size=134217728'], true);
  if (tips.length) await run(['fsck', '--connectivity-only', '--no-reflogs', '--no-dangling', ...tips]);
  return commands;
}
