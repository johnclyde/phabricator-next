export type WorkspaceView = 'home' | 'drafts' | 'reviews' | 'papers' | 'tasks' | 'projects' | 'repositories' | 'wiki' | 'activity' | 'outbox';
export type VoiceCommand = { type: 'navigate'; view: WorkspaceView } | { type: 'search'; query: string } | { type: 'task'; title: string } | { type: 'summary' } | { type: 'changes' } | { type: 'filter'; value: string } | { type: 'unknown'; text: string };
export function parseCommand(input: string): VoiceCommand {
  const original = input.trim().replace(/[.!?]+$/, '');
  const text = original.toLowerCase();
  const aliases: Record<string, WorkspaceView> = { home: 'home', dashboard: 'home', reviews: 'reviews', differential: 'reviews', drafts: 'drafts', documents: 'drafts', papers: 'papers', research: 'papers', tasks: 'tasks', maniphest: 'tasks', projects: 'projects', repositories: 'repositories', diffusion: 'repositories', wiki: 'wiki', phriction: 'wiki', activity: 'activity', outbox: 'outbox' };
  const destination = text.replace(/^(open|show|go to)\s+(the\s+)?/, '');
  if (aliases[destination]) return { type: 'navigate', view: aliases[destination] };
  const search = original.match(/^(?:search(?: for)?|find)\s+(.+)$/i);
  if (search) return { type: 'search', query: search[1] };
  const task = original.match(/^(?:create|add|draft) (?:a )?task(?: called| titled)?\s+(.+)$/i);
  if (task) return { type: 'task', title: task[1] };
  if (/^(read|read the|read my|give me a|give me the) (summary|overview)$/.test(text)) return { type: 'summary' };
  if (/^read (?:the )?changes$/.test(text)) return { type: 'changes' };
  const filter = text.match(/^(?:filter|show) (?:by )?(open|all|in progress|resolved|accepted|needs review|draft)$/);
  if (filter) return { type: 'filter', value: filter[1].replaceAll(' ', '_') };
  return { type: 'unknown', text: original };
}
