import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function run(cwd: string, paths: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, 'check', '--kind', 'document', '--json', '--server', 'https://network-access-is-not-needed.invalid', ...paths], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI checks regular Unicode source names offline and validates path limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-'));
  try {
    await writeFile(join(root, 'résumé-研究.md'), '# Argument\nA complete draft.');
    const valid = await run(root, ['résumé-研究.md']);
    assert.equal(valid.code, 0, valid.stderr); assert.equal(JSON.parse(valid.stdout).provider, 'local');
    const directoryName = 'a'.repeat(120); await mkdir(join(root, directoryName));
    const longFile = `${'b'.repeat(120)}.md`; await writeFile(join(root, directoryName, longFile), 'Draft');
    const long = await run(root, [`${directoryName}/${longFile}`]);
    assert.equal(long.code, 1); assert.match(long.stderr, /240 characters/);
    const duplicate = await run(root, ['résumé-研究.md', './résumé-研究.md']);
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /unique paths/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects file and directory symlinks before reading outside or credential sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-boundary-')); const workspace = join(root, 'workspace');
  try {
    await mkdir(workspace); await mkdir(join(root, 'outside')); await mkdir(join(workspace, '.aws'));
    await writeFile(join(root, 'outside', 'private.md'), 'DO-NOT-DISCLOSE-OUTSIDE');
    await writeFile(join(workspace, '.env'), 'DO-NOT-DISCLOSE-ENV');
    await writeFile(join(workspace, '.aws', 'credentials'), 'DO-NOT-DISCLOSE-CREDENTIALS');
    await writeFile(join(workspace, 'allowed.md'), 'Allowed draft');
    await symlink(join(root, 'outside', 'private.md'), join(workspace, 'outside.md'));
    await symlink(join(root, 'outside'), join(workspace, 'directory'));
    await symlink(join(workspace, '.env'), join(workspace, 'innocent.md'));
    await symlink(join(workspace, '.aws'), join(workspace, 'configuration'));
    await symlink(join(workspace, 'allowed.md'), join(workspace, 'allowed-alias.md'));
    for (const path of ['outside.md', 'directory/private.md', 'innocent.md', 'configuration/credentials', 'allowed-alias.md']) {
      const result = await run(workspace, [path]);
      assert.equal(result.code, 1, path); assert.match(result.stderr, /Symbolic links cannot be submitted/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-DISCLOSE'));
    }
    for (const path of ['../outside/private.md', '.env', '.aws/credentials']) {
      const result = await run(workspace, [path]); assert.equal(result.code, 1, path);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-DISCLOSE'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI refuses binary, invalid UTF-8, and oversized source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-content-'));
  try {
    await writeFile(join(root, 'binary.md'), Buffer.from([97, 0, 98]));
    await writeFile(join(root, 'encoding.md'), Buffer.from([0xc0, 0xaf]));
    await writeFile(join(root, 'large.md'), 'x'.repeat(500_001));
    for (const path of ['binary.md', 'encoding.md', 'large.md']) assert.equal((await run(root, [path])).code, 1, path);
  } finally { await rm(root, { recursive: true, force: true }); }
});
