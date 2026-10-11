/** English core labels and aliases from Differential 5720a38c. These are
 * reserved only at the start of a line immediately followed by a colon.
 * This check mirrors the metadata validator, not the complete arc parser. */
export const REVISION_MESSAGE_LABELS = Object.freeze([
  'Auditors', 'Auditor', 'Blame Revision', 'Blame Rev', 'Conflicts',
  'git-svn-id', 'JIRA Issues', 'JIRA', 'JIRA Issue', 'Revert Plan',
  'Reviewed By', 'Reviewers', 'Reviewer', 'Differential Revision',
  'Subscribers', 'CC', 'CCs', 'Subscriber', 'Summary',
  'Tags', 'Tag', 'Project', 'Projects', 'Maniphest Tasks',
  'Task', 'Tasks', 'Maniphest Task', 'Test Plan', 'Testplan',
  'Tested', 'Tests', 'Title',
] as const);

const header = new RegExp(`^(${REVISION_MESSAGE_LABELS.join('|')}):`, 'i');

/** The upstream validator prepends its own title before parsing the body, so
 * even a header on the body's first line counts. phutil_split_lines splits
 * LF/CRLF only; lone CR and Unicode line separators are literal text. */
export function revisionMessageCorpusHeader(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const match = header.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

export function validateRevisionMessageCorpus(value: string, field: 'Summary' | 'Test Plan'): void {
  const label = revisionMessageCorpusHeader(value);
  if (label !== null) throw new Error(`${field} contains the reserved commit-message header "${label}:" at the start of a line. Rephrase or indent that line so it remains part of ${field}.`);
}
