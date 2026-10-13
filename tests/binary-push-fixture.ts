import type { GitFixture } from './git-fixture';

/** Disposable Git objects only: nothing is checked out or executed. */
export async function createBinaryPushFixture(fixture: GitFixture) {
  const blob = async (content: string | Buffer) => (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
  const record = (mode: string, id: string, path: string) => `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${id}\t${path}\0`;
  const commit = async (entries: string[], parent: string) => {
    const tree = (await fixture.git(['mktree', '-z'], entries.join(''))).trim();
    return (await fixture.git(['commit-tree', tree, '-p', parent], 'Binary receive inspection fixture\n')).trim();
  };
  const oldImage = await blob(Buffer.from([1, 0, 2])), newImage = await blob(Buffer.from([1, 0, 2, 3]));
  const executable = await blob('#!/bin/sh\n# Fixture text is never executed.\n');
  const base = await commit([
    record('100644', oldImage, 'deleted.png'), record('100644', oldImage, 'image.png'),
    record('100644', executable, 'mode.sh'), record('100644', await blob('Original text.\n'), 'text.md'),
  ], fixture.base);
  const textBlob = await blob('Small inspected text.\n');
  const target = await commit([
    record('100644', newImage, 'image.png'), record('100644', await blob(Buffer.from([0xc0, 0xaf])), 'invalid.txt'),
    record('100755', executable, 'mode.sh'), record('160000', fixture.base, 'module'),
    record('100644', await blob('x'.repeat(8 * 1024 * 1024 + 1)), 'oversized.txt'),
    record('100644', await blob('Updated text.\n'), 'text.md'),
    ...Array.from({ length: 30 }, (_, index) => record('100644', textBlob, `text-${String(index).padStart(2, '0')}.md`)),
    record('100644', textBlob, '研究-paper-with-a-long-filename-that-wraps-on-small-mobile-screens-and-retains-its-exact-name.md'),
  ], base);
  const refName = 'refs/heads/binary-inspection';
  await fixture.git(['update-ref', refName, base]);
  return { base, target, refName };
}
