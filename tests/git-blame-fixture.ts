import type { GitFixture } from './git-fixture.ts';

export interface GitBlameFixture {
  root: string; edit: string; renamed: string; main: string; feature: string; merge: string;
  originalPath: string; path: string; rootContent: string; content: string; paged: string; pagedPath: string;
}
/** Direct objects only: no checkout, hooks, external program or fixture source executes. */
export async function createGitBlameFixture(fixture: GitFixture): Promise<GitBlameFixture> {
  const originalPath = 'before 研究\t"name\\file\n.txt', path = 'after 研究\t"name\\file\n.txt';
  const make = async (name: string, content: string, parents: string[] = []) => {
    const blob = (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
    const tree = (await fixture.git(['mktree', '-z'], `100644 blob ${blob}\t${name}\0`)).trim();
    return (await fixture.git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], 'Line provenance fixture\n')).trim();
  };
  const rootContent = '\ufeffroot line\r\nrepeat\r\nrepeat\r\nwhitespace   \r\nroot tail';
  const root = await make(originalPath, rootContent);
  const edited = '\ufeffroot line\r\nrepeat\r\nedited line\r\nwhitespace   \r\nroot tail\nedit addition\n';
  const edit = await make(originalPath, edited, [root]);
  const renamed = await make(path, edited, [edit]);
  const main = await make(path, edited.replace('edited line', 'main change'), [renamed]);
  const feature = await make(path, edited.replace('whitespace   ', 'feature whitespace\t'), [renamed]);
  const content = edited.replace('edited line', 'main change').replace('whitespace   ', 'feature whitespace\t') + 'merge-only\n';
  const merge = await make(path, content, [main, feature]);
  const pagedPath = '205-lines.txt';
  const paged = await make(pagedPath, Array.from({ length: 205 }, (_, index) => `Literal line ${index + 1}\n`).join(''));
  return { root, edit, renamed, main, feature, merge, originalPath, path, rootContent, content, paged, pagedPath };
}
