import type { GitFixture } from './git-fixture';

/** Exact disposable commits for post-receive Audit browser coverage. */
export async function createAuditFixture(fixture: GitFixture) {
  return Promise.all(['workflow', 'recovery', 'herald', 'gates'].map(async name => {
    const source = `Audit ${name} source.\nExact committed change.\n`;
    const blob = (await fixture.git(['hash-object', '-w', '--stdin'], source)).trim();
    const tree = (await fixture.git(['mktree', '-z'], `100644 blob ${blob}\tREADME.md\0`)).trim();
    const target = (await fixture.git(['commit-tree', tree, '-p', fixture.base], `Audit ${name} fixture\n`)).trim();
    const refName = `refs/heads/audit-${name}`;
    await fixture.git(['update-ref', refName, name === 'gates' ? fixture.base : target]);
    return { name, base: fixture.base, target, refName };
  }));
}
