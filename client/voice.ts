import type { RevisionDetail, ReviewThread } from '../shared/types';

export type WorkspaceView = 'home' | 'drafts' | 'reviews' | 'papers' | 'tasks' | 'projects' | 'repositories' | 'wiki' | 'activity' | 'outbox' | 'spaces';
export type VoiceCommand = { type: 'navigate'; view: WorkspaceView } | { type: 'openObject'; id: string } | { type: 'search'; query: string } | { type: 'task'; title: string } | { type: 'summary' } | { type: 'changes' } | { type: 'discussion' } | { type: 'filter'; value: string } | { type: 'unknown'; text: string };
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
  const search = original.match(/^(?:search(?: for)?|find)\s+(.+)$/i);
  if (search) return { type: 'search', query: search[1] };
  const task = original.match(/^(?:create|add|draft) (?:a )?task(?: called| titled)?\s+(.+)$/i);
  if (task) return { type: 'task', title: task[1] };
  if (/^(read|read the|read my|give me a|give me the) (summary|overview)$/.test(text)) return { type: 'summary' };
  if (/^read (?:the )?changes$/.test(text)) return { type: 'changes' };
  if (/^read (?:the )?(discussion|threads|open threads)$/.test(text)) return { type: 'discussion' };
  const filter = text.match(/^(?:filter|show) (?:by )?(open|all|in progress|resolved|accepted|needs review|draft)$/);
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
