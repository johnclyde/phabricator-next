import type { ProjectSnapshot, RevisionDetail, ReviewThread } from '../shared/types';
import { normalizeProjectSlug, projectDisplayName } from '../shared/projects';

export function projectMatches(project: Pick<ProjectSnapshot, 'id' | 'name' | 'primarySlug' | 'aliases' | 'displayName'>, query: string): boolean {
  const exact = query.trim().toLowerCase(); const slug = normalizeProjectSlug(query.trim().replace(/^#/, ''));
  return project.id.toLowerCase() === exact || project.name.toLowerCase() === exact || projectDisplayName(project).toLowerCase() === exact || Boolean(slug && (project.primarySlug === slug || (project.aliases || []).includes(slug)));
}

export type WorkspaceView = 'home' | 'drafts' | 'reviews' | 'papers' | 'tasks' | 'projects' | 'repositories' | 'wiki' | 'activity' | 'outbox' | 'spaces';
export type ComparisonVoiceAction = 'changes' | 'currentChange' | 'nextChange' | 'previousChange';
export type VoiceCommand = { type: 'openWorkboard'; project: string } | { type: 'projectFilter'; value: 'joined' | 'watching' | 'active' | 'all' } | { type: 'openProject'; project: string } | { type: 'navigate'; view: WorkspaceView } | { type: 'openObject'; id: string } | { type: 'search'; query: string } | { type: 'task'; title: string } | { type: 'summary' } | { type: ComparisonVoiceAction } | { type: 'discussion' } | { type: 'taskProjectFilter'; project: string } | { type: 'taskFilter'; value: 'mine' | 'unassigned' | 'following' } | { type: 'filter'; value: string } | { type: 'unknown'; text: string };
export function parseCommand(input: string): VoiceCommand {
  const original = input.trim().replace(/[.!?]+$/, '');
  const text = original.toLowerCase();
  const aliases: Record<string, WorkspaceView> = { home: 'home', dashboard: 'home', reviews: 'reviews', differential: 'reviews', drafts: 'drafts', documents: 'drafts', papers: 'papers', research: 'papers', tasks: 'tasks', maniphest: 'tasks', projects: 'projects', repositories: 'repositories', diffusion: 'repositories', wiki: 'wiki', phriction: 'wiki', activity: 'activity', outbox: 'outbox', spaces: 'spaces' };
  const destination = text.replace(/^(open|show|go to)\s+(the\s+)?/, '');
  if (aliases[destination]) return { type: 'navigate', view: aliases[destination] };
  const object = text.match(/^(?:open|show|go to)\s+(?:the\s+)?([dplwt])\s*([1-9]\d*)$/);
  if (object && Number.isSafeInteger(Number(object[2]))) return { type: 'openObject', id: `${object[1].toUpperCase()}${object[2]}` };
  const namedObject = text.match(/^(?:open|show|go to)\s+(?:the\s+)?(wiki(?: page)?|paper|draft|code revision|task)\s*([1-9]\d*)$/);
  if (namedObject && Number.isSafeInteger(Number(namedObject[2]))) {
    const prefix = namedObject[1].startsWith('wiki') ? 'W' : namedObject[1] === 'paper' ? 'P' : namedObject[1] === 'draft' ? 'L' : namedObject[1] === 'task' ? 'T' : 'D';
    return { type: 'openObject', id: `${prefix}${namedObject[2]}` };
  }
  const project = original.match(/^(?:show|open) tasks (?:in|tagged with) project (.+)$/i);
  if (project) return { type: 'taskProjectFilter', project: project[1].trim() };
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
  if (/^(read|read the|read my|give me a|give me the) (summary|overview)$/.test(text)) return { type: 'summary' };
  if (/^read (?:the )?changes$/.test(text)) return { type: 'changes' };
  if (/^read (?:(?:the )?current |this )?change$/.test(text)) return { type: 'currentChange' };
  if (/^(?:(?:read|show|go to) (?:the )?)?next change$/.test(text)) return { type: 'nextChange' };
  if (/^(?:(?:read|show|go to) (?:the )?)?(?:previous|prior) change$/.test(text)) return { type: 'previousChange' };
  if (/^read (?:the )?(discussion|threads|open threads)$/.test(text)) return { type: 'discussion' };
  if (/^(?:show|open) (?:my tasks|tasks assigned to me)$/.test(text)) return { type: 'taskFilter', value: 'mine' };
  if (/^(?:show|open) unassigned tasks$/.test(text)) return { type: 'taskFilter', value: 'unassigned' };
  if (/^(?:show|open) (?:tasks i follow|followed tasks)$/.test(text)) return { type: 'taskFilter', value: 'following' };
  const filter = text.match(/^(?:filter|show) (?:by )?(open|all|in progress|resolved|duplicate|accepted|needs review|draft)$/);
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
