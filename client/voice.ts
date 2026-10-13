import type { ProjectSnapshot, RevisionDetail, RevisionKind, ReviewThread } from '../shared/types';
import { normalizeProjectSlug, projectDisplayName } from '../shared/projects';
import { orderedDiscussionThreads } from '../shared/discussion-navigation';
import type { TranscriptEditVoiceAction } from './transcript-edit-voice';
import type { StackVoiceAction } from './revision-stack';

export function projectMatches(project: Pick<ProjectSnapshot, 'id' | 'name' | 'primarySlug' | 'aliases' | 'displayName'>, query: string): boolean {
  const exact = query.trim().toLowerCase(); const slug = normalizeProjectSlug(query.trim().replace(/^#/, ''));
  return project.id.toLowerCase() === exact || project.name.toLowerCase() === exact || projectDisplayName(project).toLowerCase() === exact || Boolean(slug && (project.primarySlug === slug || (project.aliases || []).includes(slug)));
}

export type WorkspaceView = 'herald' | 'harbormaster' | 'drydock' | 'home' | 'drafts' | 'reviews' | 'papers' | 'tasks' | 'projects' | 'repositories' | 'wiki' | 'activity' | 'outbox' | 'spaces' | 'files' | 'pastes' | 'notifications' | 'audio';
export type FindingVoiceAction = 'findings' | 'currentFinding' | 'nextFinding' | 'previousFinding' | 'findingSource';
export type ComparisonVoiceAction = 'changes' | 'currentChange' | 'nextChange' | 'previousChange' | 'nextFile' | 'previousFile';
export type DiscussionVoiceAction = 'nextThread' | 'previousThread' | 'nextThreadIncludingCollapsed' | 'previousThreadIncludingCollapsed' | 'currentThread' | 'collapseThread' | 'expandThread' | 'toggleThread';
export type VoiceCommand = { type: 'revisionActive'; kind: RevisionKind } | { type: 'revisionView'; view: 'reviews' | 'papers' | 'drafts'; name: string } | { type: 'revisionAuthoredFilter'; view: 'reviews' | 'papers' | 'drafts'; authored: boolean } | { type: 'notificationFilter'; filter: 'all' | 'unread' | 'read' } | { type: 'revisionProjectFilter'; view: 'reviews' | 'papers' | 'drafts'; project: string | null } | { type: 'revisionFollowingFilter'; view: 'reviews' | 'papers' | 'drafts'; following: boolean } | { type: 'openWorkboard'; project: string } | { type: 'projectFilter'; value: 'joined' | 'watching' | 'active' | 'all' } | { type: 'openProject'; project: string } | { type: 'navigate'; view: WorkspaceView } | { type: 'openObject'; id: string } | { type: 'search'; query: string } | { type: 'task'; title: string } | { type: 'summary' } | { type: FindingVoiceAction } | { type: ComparisonVoiceAction } | { type: DiscussionVoiceAction } | { type: StackVoiceAction } | { type: TranscriptEditVoiceAction } | { type: 'discussion' } | { type: 'taskProjectFilter'; project: string } | { type: 'taskFilter'; value: 'mine' | 'unassigned' | 'following' } | { type: 'filter'; value: string } | { type: 'unknown'; text: string };
export function parseCommand(input: string): VoiceCommand {
  const original = input.trim().replace(/[.!?]+$/, '');
  const text = original.toLowerCase();
  const aliases: Record<string, WorkspaceView> = { drydock: 'drydock', 'dry dock': 'drydock', blueprints: 'drydock', herald: 'herald', rules: 'herald', harbormaster: 'harbormaster', builds: 'harbormaster', audio: 'audio', 'audio inbox': 'audio', recordings: 'audio', home: 'home', dashboard: 'home', reviews: 'reviews', differential: 'reviews', drafts: 'drafts', documents: 'drafts', papers: 'papers', research: 'papers', tasks: 'tasks', maniphest: 'tasks', projects: 'projects', repositories: 'repositories', diffusion: 'repositories', wiki: 'wiki', phriction: 'wiki', activity: 'activity', outbox: 'outbox', spaces: 'spaces', files: 'files', uploads: 'files', pastes: 'pastes', paste: 'pastes' };
  const active = text.match(/^(?:open|show|go to) (?:the )?active (code revisions|revisions|reviews|papers|drafts|documents)$/);
  if (active) return { type: 'revisionActive', kind: active[1] === 'papers' ? 'paper' : active[1] === 'drafts' || active[1] === 'documents' ? 'document' : 'code' };
  const revisionView = original.match(/^(?:open|show|go to) (?:the )?(code revision|code revisions|revision|revisions|review|reviews|paper|papers|draft|drafts|document|documents) (?:saved )?view (.+)$/i);
  if (revisionView) {
    const noun = revisionView[1]!.toLowerCase();
    const name = revisionView[2]!.trim().replace(/^"([\s\S]*)"$/, '$1');
    if (name && name.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(name)) return { type: 'revisionView', view: /^papers?$/.test(noun) ? 'papers' : /^(?:drafts?|documents?)$/.test(noun) ? 'drafts' : 'reviews', name };
    return { type: 'unknown', text: original };
  }
  const authored = text.match(/^(?:show|open) (?:(?:my|authored) (code revisions|revisions|reviews|papers|drafts|documents)|(code revisions|revisions|reviews|papers|drafts|documents) (?:i authored|authored by me|without (?:an? )?author filter))$/);
  if (authored) {
    const noun = authored[1] ?? authored[2];
    return { type: 'revisionAuthoredFilter', view: noun === 'papers' ? 'papers' : noun === 'drafts' || noun === 'documents' ? 'drafts' : 'reviews', authored: !text.includes('without ') };
  }
  const notifications = text.match(/^(?:(?:open|show|go to) (?:the )?(?:(all|unread|read) )?(?:notifications|notification inbox)|notifications|notification inbox)$/);
  if (notifications) return { type: 'notificationFilter', filter: (notifications[1] ?? 'all') as 'all' | 'unread' | 'read' };
  const destination = text.replace(/^(open|show|go to)\s+(the\s+)?/, '');
  if (aliases[destination]) return { type: 'navigate', view: aliases[destination] };
  const object = text.match(/^(?:open|show|go to)\s+(?:the\s+)?(pa|[dplwtrf])\s*([1-9]\d*)$/);
  if (object && Number.isSafeInteger(Number(object[2]))) return { type: 'openObject', id: `${object[1].toUpperCase()}${object[2]}` };
  const namedObject = text.match(/^(?:open|show|go to)\s+(?:the\s+)?(wiki(?: page)?|paper|draft|code revision|task|repository|file|paste)\s*([1-9]\d*)$/);
  if (namedObject && Number.isSafeInteger(Number(namedObject[2]))) {
    const prefix = namedObject[1].startsWith('wiki') ? 'W' : namedObject[1] === 'paper' ? 'P' : namedObject[1] === 'draft' ? 'L' : namedObject[1] === 'task' ? 'T' : namedObject[1] === 'repository' ? 'R' : namedObject[1] === 'file' ? 'F' : namedObject[1] === 'paste' ? 'PA' : 'D';
    return { type: 'openObject', id: `${prefix}${namedObject[2]}` };
  }
  const project = original.match(/^(?:show|open) tasks (?:in|tagged with) project (.+)$/i);
  if (project) return { type: 'taskProjectFilter', project: project[1].trim() };
  const revisionProject = original.match(/^(?:show|open) (code revisions|revisions|reviews|papers|drafts|documents) (?:(?:in|tagged with) project (.+)|in all projects|without (?:a )?project filter)$/i);
  if (revisionProject) {
    const noun = revisionProject[1].toLowerCase();
    return { type: 'revisionProjectFilter', view: noun === 'papers' ? 'papers' : noun === 'drafts' || noun === 'documents' ? 'drafts' : 'reviews', project: revisionProject[2]?.trim() ?? null };
  }
  const projectFilter = text.match(/^(?:show|open) (joined|watching|active|all) projects$/);
  if (projectFilter) return { type: 'projectFilter', value: projectFilter[1] as 'joined' | 'watching' | 'active' | 'all' };
  const board = original.match(/^(?:open|show|go to) (?:the )?workboard (?:for )?(.+)$/i);
  if (board) return { type: 'openWorkboard', project: board[1].replace(/^PROJ\s+(\d+)$/i, 'PROJ$1').trim() };
  const profile = original.match(/^(?:open|show|go to) project (.+)$/i) || original.match(/^(?:open|show|go to) (PROJ\s*[1-9]\d*)$/i);
  if (profile) return { type: 'openProject', project: profile[1].replace(/^PROJ\s+(\d+)$/i, 'PROJ$1').trim() };
  const search = original.match(/^(?:search(?: for)?|find)\s+(.+)$/i);
  if (search) return { type: 'search', query: search[1] };
  const task = original.match(/^(?:create|add|draft) (?:a )?task(?: called| titled)?\s+(.+)$/i);
  if (task) return { type: 'task', title: task[1] };
  const transcriptEdit = text.match(/^(read|preview|confirm|cancel) transcript edit$/);
  if (transcriptEdit) return { type: `${transcriptEdit[1]}TranscriptEdit` as TranscriptEditVoiceAction };
  if (/^(read|read the|read my|give me a|give me the) (summary|overview)$/.test(text)) return { type: 'summary' };
  if (/^(?:read|show|open) (?:the )?(?:revision )?stack$/.test(text)) return { type: 'stack' };
  if (/^read (?:(?:the )?(?:current|selected) |this )?stack revision$/.test(text)) return { type: 'currentStackRevision' };
  if (/^(?:(?:read|show|go to) (?:the )?)?next stack revision$/.test(text)) return { type: 'nextStackRevision' };
  if (/^(?:(?:read|show|go to) (?:the )?)?(?:previous|prior) stack revision$/.test(text)) return { type: 'previousStackRevision' };
  if (/^read (?:the )?(?:review )?findings$/.test(text)) return { type: 'findings' };
  if (/^read (?:(?:the )?(?:current|selected) |this )?finding$/.test(text)) return { type: 'currentFinding' };
  if (/^(?:(?:read|show|go to) (?:the )?)?next finding$/.test(text)) return { type: 'nextFinding' };
  if (/^(?:(?:read|show|go to) (?:the )?)?(?:previous|prior) finding$/.test(text)) return { type: 'previousFinding' };
  if (/^(?:open|show) (?:the )?original finding source$/.test(text)) return { type: 'findingSource' };
  if (/^read (?:the )?changes$/.test(text)) return { type: 'changes' };
  if (/^read (?:(?:the )?current |this )?change$/.test(text)) return { type: 'currentChange' };
  if (/^(?:(?:read|show|go to) (?:the )?)?next change$/.test(text)) return { type: 'nextChange' };
  if (/^(?:(?:read|show|go to) (?:the )?)?(?:previous|prior) change$/.test(text)) return { type: 'previousChange' };
  if (/^(?:(?:read|show|open|go to) (?:the )?)?next file$/.test(text)) return { type: 'nextFile' };
  if (/^(?:(?:read|show|open|go to) (?:the )?)?(?:previous|prior) file$/.test(text)) return { type: 'previousFile' };
  if (/^read (?:the )?(discussion|threads|open threads)$/.test(text)) return { type: 'discussion' };
  const threadNavigation = text.match(/^(?:(?:read|show|go to) (?:the )?)?(next|previous|prior) thread( including collapsed(?: threads)?)?$/);
  if (threadNavigation) return { type: threadNavigation[1] === 'next' ? threadNavigation[2] ? 'nextThreadIncludingCollapsed' : 'nextThread' : threadNavigation[2] ? 'previousThreadIncludingCollapsed' : 'previousThread' };
  if (/^read (?:(?:the )?current |this )?thread$/.test(text)) return { type: 'currentThread' };
  const threadPresentation = text.match(/^(collapse|expand|toggle) (?:(?:the )?(?:current|selected) |this )?thread$/);
  if (threadPresentation) return { type: threadPresentation[1] === 'collapse' ? 'collapseThread' : threadPresentation[1] === 'expand' ? 'expandThread' : 'toggleThread' };
  if (/^(?:show|open) (?:my tasks|tasks assigned to me)$/.test(text)) return { type: 'taskFilter', value: 'mine' };
  if (/^(?:show|open) unassigned tasks$/.test(text)) return { type: 'taskFilter', value: 'unassigned' };
  if (/^(?:show|open) (?:tasks i follow|followed tasks)$/.test(text)) return { type: 'taskFilter', value: 'following' };
  const revisionFollowing = text.match(/^(?:show|open) (?:the )?(?:(followed|all) (revisions|reviews|papers|drafts|documents)|(revisions|reviews|papers|drafts|documents) i follow)$/);
  if (revisionFollowing) {
    const noun = revisionFollowing[2] || revisionFollowing[3];
    return { type: 'revisionFollowingFilter', view: noun === 'papers' ? 'papers' : noun === 'drafts' || noun === 'documents' ? 'drafts' : 'reviews', following: revisionFollowing[1] !== 'all' };
  }
  const filter = text.match(/^(?:filter|show) (?:by )?(open|all|in progress|resolved|duplicate|accepted|needs review|changes requested|changes planned|draft|closed|abandoned)$/);
  if (filter) return { type: 'filter', value: filter[1].replaceAll(' ', '_') };
  return { type: 'unknown', text: original };
}

/** Reads already-authorized, locally loaded discussion; never invokes a model. */
export function discussionSummary(detail: Pick<RevisionDetail, 'comments' | 'versions' | 'threads'>): string {
  const threads = new Map<string, Pick<ReviewThread, 'id' | 'rootCommentId' | 'status'>>((detail.threads || []).map(thread => [thread.id, thread]));
  for (const comment of detail.comments) {
    const id = comment.threadId || comment.id;
    if (!threads.has(id)) threads.set(id, { id, rootCommentId: id, status: 'open' });
  }
  if (!threads.size) return 'No discussion threads are recorded for this revision.';
  const open = [...threads.values()].filter(thread => thread.status === 'open');
  const shorten = (value: string, length: number) => {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length <= length ? text : text.slice(0, length).trimEnd() + '…';
  };
  const excerpts = open.slice(0, 3).map(thread => {
    const root = detail.comments.find(comment => comment.id === thread.rootCommentId);
    if (!root) return 'An open thread has no loaded original comment.';
    const version = detail.versions.find(item => item.id === root.versionId);
    const count = detail.comments.filter(comment => (comment.threadId || comment.id) === thread.id).length;
    return `Thread from version ${version?.number ?? 'unknown'}, ${count} ${count === 1 ? 'comment' : 'comments'}. ${root.anchor ? `Original passage: ${shorten(root.anchor.quote, 200)}. ` : ''}${shorten(root.body, 220)}`;
  });
  return `${open.length} open and ${threads.size - open.length} resolved discussion threads. ${open.length > 3 ? 'Reading the first three open threads. ' : ''}${excerpts.join(' ')}`.trim();
}

export const DISCUSSION_SPEECH_LIMIT = 1_800;
const DISCUSSION_COMMENT_LIMIT = 3;

/** Bounded code-point excerpt; original comments and anchors remain unchanged. */
function discussionExcerpt(value: string, limit: number, label = 'Excerpt'): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  let excerpt = ''; let count = 0;
  for (const point of text) {
    if (count === limit) return `${excerpt} … ${label} shortened.`;
    excerpt += point; count++;
  }
  return excerpt;
}

/** Reads authorized loaded data only. Collapsed navigation reads no comment body. */
export function discussionThreadNarration(detail: Pick<RevisionDetail, 'comments' | 'versions' | 'threads'>, threadId: string | null, collapsed: boolean): string {
  if (threadId === null) return 'No discussion thread is selected.';
  const thread = orderedDiscussionThreads(detail).find(item => item.id === threadId);
  if (!thread) return 'The selected discussion thread is unavailable.';
  const comments = detail.comments.filter(comment => (comment.threadId || comment.id) === thread.id)
    .sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const root = comments.find(comment => comment.id === thread.rootCommentId);
  if (!root) return 'The selected discussion thread has no loaded original comment.';
  const original = detail.versions.find(version => version.id === root.versionId && version.revisionId === root.revisionId);
  const location = root.docxAnchor ? 'Original Word passage.' : root.filePath ? `File ${discussionExcerpt(root.filePath, 160, 'Filename')}${root.line !== null ? `, line ${root.line}` : ', passage location'}.` : 'General discussion.';
  const additional = root.suggestion?.additionalEdits;
  const proposalFiles = new Set([root.filePath, ...(additional ?? []).map(edit => edit.anchor.filePath)]).size;
  const proposal = additional?.length ? ` This proposal contains ${additional.length + 1} suggested passages across ${proposalFiles} ${proposalFiles === 1 ? 'file' : 'files'}. The complete edit preview is available in the discussion.` : '';
  const header = `Thread from original version ${original?.number ?? 'unavailable'}. ${location} ${thread.status === 'resolved' ? 'Resolved' : 'Open'}, ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}.${proposal}`;
  if (collapsed) return `${header} Collapsed for you. Use read current thread to hear its content without expanding it.`;
  const replies = comments.filter(comment => comment.id !== root.id);
  const selected = [root, ...replies].slice(0, DISCUSSION_COMMENT_LIMIT);
  const quotation = root.docxAnchor ? ` Original Word passage: ${discussionExcerpt(root.docxAnchor.quote, 280)}.` : root.anchor ? ` Original passage: ${discussionExcerpt(root.anchor.quote, 280)}.` : '';
  const excerpts = selected.map((comment, index) => {
    const viewed = comment.viewedVersionId ? detail.versions.find(version => version.id === comment.viewedVersionId && version.revisionId === comment.revisionId) : undefined;
    const context = index === 0 ? 'Original comment' : viewed && viewed.id !== root.versionId ? `Reply while viewing version ${viewed.number}` : 'Reply';
    return `${context}: ${discussionExcerpt(comment.body, index === 0 ? 400 : 220)}.`;
  });
  const notice = comments.length > selected.length ? ` Reading the first ${selected.length} of ${comments.length} comments.` : '';
  return discussionExcerpt(`${header}${notice}${quotation} ${excerpts.join(' ')}`, DISCUSSION_SPEECH_LIMIT - 25, 'Discussion');
}
