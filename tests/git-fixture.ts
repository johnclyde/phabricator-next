import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitFixture {
  root: string;
  barePath: string;
  objectFormat: 'sha1' | 'sha256';
  base: string;
  head: string;
  feature: string;
  emptyCommit: string;
  importCommit: string;
  importNextCommit: string;
  importEqualCommit: string;
  annotatedTag: string;
  readmeBlob: string;
  advanceMain(content?: string): Promise<string>;
  git(args: string[], input?: string | Buffer): Promise<string>;
  close(): Promise<void>;
}

/** Create objects directly: fixtures never check out or execute repository files. */
export async function createGitFixture(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'phab-git-fixture-'));
  const barePath = join(root, 'repository.git');
  const run = (args: string[], input?: string | Buffer): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: root,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
        GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
        LC_ALL: 'C',
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (data: Buffer) => out.push(data)); child.stderr.on('data', (data: Buffer) => err.push(data));
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); if (code === 0) resolve(Buffer.concat(out).toString('utf8')); else reject(new Error(`Git fixture failed (${code}): ${Buffer.concat(err).toString('utf8')}`)); });
    child.stdin.on('error', () => undefined); child.stdin.end(input);
  });
  const git = (args: string[], input?: string | Buffer) => run(['--git-dir', barePath, ...args], input);
  try {
    await run(['init', '--bare', '--template=', '--initial-branch=main', `--object-format=${objectFormat}`, barePath]);
    const blob = async (content: string | Buffer) => (await git(['hash-object', '-w', '--stdin'], content)).trim();
    type Entry = { path: string; mode: string; id: string; type: 'blob' | 'commit' };
    const tree = async (entries: Entry[], prefix = ''): Promise<string> => {
      const directories = [...new Set(entries.map(entry => entry.path.slice(prefix.length).split('/')).filter(parts => parts.length > 1).map(parts => parts[0]!))];
      const records = entries.filter(entry => !entry.path.slice(prefix.length).includes('/')).map(entry => `${entry.mode} ${entry.type} ${entry.id}\t${entry.path.slice(prefix.length)}\0`);
      for (const directory of directories) {
        const childPrefix = `${prefix}${directory}/`;
        records.push(`040000 tree ${await tree(entries.filter(entry => entry.path.startsWith(childPrefix)), childPrefix)}\t${directory}\0`);
      }
      return (await git(['mktree', '-z'], records.join(''))).trim();
    };
    const commit = async (treeId: string, message: string, parents: string[] = []) => (await git(['commit-tree', treeId, ...parents.flatMap(parent => ['-p', parent])], `${message}\n`)).trim();
    const before = await blob('# Example repository\nBefore the change.\n');
    const base = await commit(await tree([{ path: 'README.md', mode: '100644', type: 'blob', id: before }]), 'Initial source');
    const emptyCommit = await commit(await tree([]), 'Empty tree', [base]);
    const readmeBlob = await blob('# Example repository\nAfter the change.\n');
    const entries: Entry[] = [
      { path: 'README.md', mode: '100644', type: 'blob', id: readmeBlob },
      { path: 'docs/paper.tex', mode: '100644', type: 'blob', id: await blob('\\section{Introduction}\nAn immutable paper snapshot.\n') },
      { path: 'docs/empty.txt', mode: '100644', type: 'blob', id: await blob('') },
      { path: 'unicodé/研究.md', mode: '100644', type: 'blob', id: await blob('Unicode source.\n') },
      { path: 'tools/check.sh', mode: '100755', type: 'blob', id: await blob('#!/bin/sh\nexit 0\n') },
      { path: 'link', mode: '120000', type: 'blob', id: await blob('README.md') },
      { path: 'module', mode: '160000', type: 'commit', id: base },
      { path: 'binary.dat', mode: '100644', type: 'blob', id: await blob(Buffer.from([1, 0, 2])) },
      { path: 'invalid.txt', mode: '100644', type: 'blob', id: await blob(Buffer.from([0xc0, 0xaf])) },
      { path: 'oversized.txt', mode: '100644', type: 'blob', id: await blob('x'.repeat(256_001)) },
      { path: '<script>.txt', mode: '100644', type: 'blob', id: await blob('<script>window.fixtureExecuted = true</script>\n') },
      { path: 'name with spaces.md', mode: '100644', type: 'blob', id: await blob('A spaced file name.\n') },
    ];
    // Keep the complete importable tree independent of main's deliberate unsupported entries.
    const importEntries = entries.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && !['binary.dat', 'invalid.txt', 'oversized.txt'].includes(entry.path));
    importEntries.push({ path: '\ufeffsource.txt', mode: '100644', type: 'blob', id: await blob('\ufeffLiteral source.\n') });
    const importTree = await tree(importEntries);
    const importCommit = await commit(importTree, 'Complete text source for review', [base]);
    const importEqualCommit = await commit(importTree, 'Same complete tree in another commit', [importCommit]);
    const importNextEntries = importEntries.filter(entry => entry.path !== 'name with spaces.md').map(entry => ({ ...entry }));
    importNextEntries.find(entry => entry.path === 'README.md')!.id = await blob('# Example repository\nA new complete review version.\n');
    importNextEntries.find(entry => entry.path === 'tools/check.sh')!.mode = '100644';
    importNextEntries.push({ path: 'added.md', mode: '100644', type: 'blob', id: await blob('Added in the next complete tree.\n') });
    const importNextCommit = await commit(await tree(importNextEntries), 'Changed complete text source for review', [importCommit]);
    const feature = await commit(await tree([{ path: 'README.md', mode: '100644', type: 'blob', id: await blob('Feature source.\n') }]), 'Feature branch', [base]);
    const target = await commit(await tree(entries), 'Update source and add files', [base]);
    const head = await commit(await tree(entries), 'Merge feature branch', [target, feature]);
    const annotatedTag = (await git(['hash-object', '-t', 'tag', '-w', '--stdin'], `object ${head}\ntype commit\ntag v2\ntagger Fixture Author <fixture@example.invalid> 1704164645 +0000\n\nVersion two\n`)).trim();
    for (const [ref, id] of [['refs/heads/main', head], ['refs/heads/feature', feature], ['refs/tags/v1', base], ['refs/tags/v2', annotatedTag], ['refs/tags/source-blob', readmeBlob]]) await git(['update-ref', ref!, id!]);
    let latest = head;
    return {
      root, barePath, objectFormat, base, head, feature, emptyCommit, importCommit, importNextCommit, importEqualCommit, annotatedTag, readmeBlob, git,
      async advanceMain(content = '# Example repository\nA later branch head.\n') {
        const nextEntries = entries.map(entry => ({ ...entry })); nextEntries.find(entry => entry.path === 'README.md')!.id = await blob(content);
        const next = await commit(await tree(nextEntries), 'Advance main', [latest]); await git(['update-ref', 'refs/heads/main', next, latest]); latest = next; return next;
      },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

/** Independent comparison pair; ordinary browse fixtures do not pay its setup cost. */
export async function createGitComparisonFixture(fixture: GitFixture): Promise<{ base: string; target: string }> {
  const blob = async (content: string | Buffer) => (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
  const lines = Array.from({ length: 40 }, (_, index) => `Line ${index}: stable content for similarity detection.\n`).join('');
  const copyLines = Array.from({ length: 40 }, (_, index) => `Copy source ${index}: distinct content for copy detection.\n`).join('');
  const oldText = await blob(lines), copySource = await blob(copyLines), empty = await blob('');
  const oldEntries = [
    `100644 blob ${oldText}\trename-before.txt\0`,
    `100644 blob ${copySource}\tcopy-source.txt\0`,
    `100644 blob ${await blob('#!/bin/sh\nexit 0\n')}\texecutable.sh\0`,
    `100644 blob ${await blob('delete me\n')}\tdeleted.txt\0`,
    `100644 blob ${await blob('old file type\n')}\ttype-change\0`,
    `100644 blob ${empty}\tempty.txt\0`,
    `100644 blob ${await blob('directory replaced\n')}\tto-directory\0`,
  ];
  const childTree = (await fixture.git(['mktree', '-z'], `100644 blob ${await blob('nested content\n')}\tchild.txt\0`)).trim();
  const newEntries = [
    `100644 blob ${await blob(lines.replace('Line 20:', 'Updated 20:'))}\trename-after.txt\0`,
    `100644 blob ${await blob(copyLines.replace('Copy source 20:', 'Updated source 20:'))}\tcopy-source.txt\0`,
    `100644 blob ${copySource}\tcopy-result.txt\0`,
    oldEntries[2]!.replace('100644', '100755'),
    `120000 blob ${await blob('copy-source.txt')}\ttype-change\0`,
    `100644 blob ${empty}\tempty-added.txt\0`,
    `040000 tree ${childTree}\tto-directory\0`,
    `100644 blob ${await blob(Buffer.from([1, 0, 2]))}\tbinary.dat\0`,
    `100644 blob ${await blob(Buffer.from([0xc0, 0xaf]))}\tinvalid.txt\0`,
    `100644 blob ${await blob('x'.repeat(256_001))}\toversized.txt\0`,
    `160000 commit ${fixture.base}\tmodule\0`,
    `100644 blob ${await blob('\ufeffLiteral exact source.\r\n')}\t:(literal) unicode 研究\tname.txt\0`,
  ];
  const make = async (entries: string[], parent?: string) => {
    const tree = (await fixture.git(['mktree', '-z'], entries.join(''))).trim();
    return (await fixture.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Comparison fixture\n')).trim();
  };
  const base = await make(oldEntries); return { base, target: await make(newEntries, base) };
}
