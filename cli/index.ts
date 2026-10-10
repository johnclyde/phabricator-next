#!/usr/bin/env node
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { analyzeLocally } from '../shared/review';
import { mountPath, normalizeBasePath } from '../shared/mount';
import { isTaskClosed } from '../shared/tasks';
import { normalizeProjectSlug, projectDisplayName } from '../shared/projects';
import { visibleProjectScope } from '../shared/project-hierarchy';
import type { AppState, ProjectDetail, RevisionDetail, RevisionKind, SourceFile, TaskDetail } from '../shared/types';
import type { WorkboardCardPage, WorkboardDetail } from '../shared/workboards';

const help = `Phabricator Next — arc (initial CLI)

  npm run arc -- check [--kind paper|document|code] FILE... [--json]
  npm run arc -- diff --title "Title" --kind paper FILE...
  npm run arc -- diff --revision P2 --message "Changes" FILE...
  npm run arc -- list
  npm run arc -- tasks [--owner me|all|unassigned|USERNAME] [--subscribed] [--project ID|NAME] [--status open|closed|all] [--order priority|created|modified] [--limit N] [--json]
  npm run arc -- projects [--status active|archived|all] [--joined] [--watching] [--limit N] [--json]
  npm run arc -- board PROJECT [--status open|all] [--owner me|all|unassigned|USERNAME] [--show-hidden] [--limit N] [--json]
  npm run arc -- show P2|T1|PROJ1
  npm run arc -- review P2 [--provider local|openai|ollama]
  npm run arc -- export P2 [--version 1]

check is fully offline and never executes source. diff uploads an explicit list
of text files as a complete snapshot; omitted files are removed in that version.
export writes a JSON snapshot to stdout. --server defaults to
http://127.0.0.1:4310 (or PHABRICATOR_URL); include any application path prefix.
Hosted review is always explicit.
tasks lists your assigned open tasks by default. --owner all includes all visible
owners; --unassigned selects unowned tasks. --subscribed selects tasks you follow.
Use a principal ID or user:USERNAME to disambiguate reserved owner filter names.
--project selects a visible project ID, exact name or alias, including visible descendants.
Repeat it to require a matching tag in each selected project's subtree.
show T1 includes the current task, visible dependencies, and the first history page.
projects lists active visible projects; --joined and --watching select your relationships.
show PROJ1 includes the project profile, hierarchy, preferences, and first history page.
board reads the project's actual workboard in column order. It defaults to open
tasks with all owners; --limit caps cards per column. Without a limit it follows
all pages, rejecting concurrent board or access changes instead of mixing pages.
Password workspaces require an operator-issued PHABRICATOR_TOKEN environment
variable. Tokens are never accepted as command arguments or sent on redirects.
This is not a drop-in Arcanist replacement; Git landing/patching is planned.
`;

function visibleProjectId(value: string, state: AppState): string {
  const byId = state.projects.find(project => project.id === value);
  if (byId) return byId.id;
  const matches = state.projects.filter(project => project.name.toLocaleLowerCase() === value.toLocaleLowerCase() || projectDisplayName(project).toLocaleLowerCase() === value.toLocaleLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) {
    const slug = normalizeProjectSlug(value.replace(/^#/, ''));
    const aliases = state.projects.filter(project => project.primarySlug === slug || project.aliases.includes(slug));
    if (aliases.length === 1) return aliases[0]!.id;
  }
  throw new Error('Project is unavailable or its name is ambiguous. Use a visible project ID, exact name or alias.');
}

function visibleOwnerId(owner: string, state: AppState): string | null | undefined {
  if (owner === 'me') return state.currentPrincipalId;
  if (owner === 'unassigned') return null;
  if (owner === 'all') return undefined;
  const username = owner.startsWith('user:') ? owner.slice(5) : owner;
  const id = state.principals.find(account => account.username.toLowerCase() === username.toLowerCase() || account.id === owner)?.id;
  if (id) return id;
  if (state.tasks.some(task => task.ownerId === owner)) return owner;
  throw new Error('Owner is not an available workspace account. Use a username, principal ID, me, all or unassigned.');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      kind: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
      revision: { type: 'string' }, message: { type: 'string' }, provider: { type: 'string', default: 'local' },
      server: { type: 'string', default: process.env.PHABRICATOR_URL || 'http://127.0.0.1:4310' },
      version: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      status: { type: 'string' }, order: { type: 'string' }, limit: { type: 'string' },
      project: { type: 'string', multiple: true }, owner: { type: 'string' }, unassigned: { type: 'boolean' }, subscribed: { type: 'boolean' },
      joined: { type: 'boolean' }, watching: { type: 'boolean' },
      'show-hidden': { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === 'help') return console.log(help);
  const server = new URL(values.server!);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || values.server!.includes('?') || values.server!.includes('#') || values.server!.includes('\\')) throw new Error('Provide an HTTP(S) server URL without embedded credentials, query parameters, or a fragment.');
  // Read the unnormalized path so a dot segment cannot silently change mounts.
  const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)$/i.exec(values.server!)?.[1];
  if (rawPath === undefined) throw new Error('Provide an absolute HTTP(S) server URL.');
  const basePath = normalizeBasePath(rawPath || '/');
  server.pathname = basePath;
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const token = process.env.PHABRICATOR_TOKEN;
    if (token && (!/^[A-Za-z0-9._-]{1,256}$/.test(token))) throw new Error('PHABRICATOR_TOKEN has an invalid format.');
    if (token && server.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) throw new Error('API tokens require HTTPS except for a loopback server.');
    const response = await fetch(new URL(mountPath(path, basePath), server), {
      method, signal: AbortSignal.timeout(135_000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Server returned HTTP ${response.status}`);
    return value;
  };
  const kind = values.kind || 'code';
  if (!['code', 'paper', 'document'].includes(kind)) throw new Error('--kind must be code, paper or document.');
  const getDetail = (id: string | undefined) => {
    if (!id || !/^[DPL]\d+$/.test(id)) throw new Error('Provide a revision ID such as D1, P2 or L3.');
    return request<RevisionDetail>(`/api/revisions/${id}`);
  };
  if (command === 'check') {
    const files = await readSources(args);
    const review = analyzeLocally(kind as RevisionKind, files);
    if (values.json) console.log(JSON.stringify(review, null, 2));
    else {
      console.log(review.summary);
      for (const finding of review.findings) console.log(`${finding.filePath}:${finding.line} [${finding.severity}] ${finding.title}\n  ${finding.body}`);
    }
    if (review.findings.some(finding => finding.severity === 'error')) process.exitCode = 1;
    return;
  }
  if (command === 'diff') {
    const files = await readSources(args);
    let detail: RevisionDetail;
    if (values.revision) {
      const existing = await getDetail(values.revision);
      detail = await request<RevisionDetail>(`/api/revisions/${existing.revision.id}/versions`, 'POST', {
        files, message: values.message || 'Updated via arc', expectedVersion: existing.revision.currentVersion,
      });
    } else {
      if (!values.title?.trim()) throw new Error('--title is required for a new revision.');
      detail = await request<RevisionDetail>('/api/revisions', 'POST', { title: values.title, summary: values.summary || '', kind, files });
    }
    console.log(`${detail.revision.id} · v${detail.revision.currentVersion} · ${detail.revision.title}`);
    console.log(new URL(`${basePath}#${detail.revision.id}`, server).href);
    return;
  }
  if (command === 'list') {
    const state = await request<AppState>('/api/state');
    for (const revision of state.revisions) console.log(`${revision.id}\tv${revision.currentVersion}\t${revision.status}\t${revision.title}`);
    return;
  }
  if (command === 'tasks') {
    if (args.length) throw new Error('tasks accepts options, not positional task IDs. Use show T1 for one task.');
    const status = values.status || 'open'; const order = values.order || 'priority';
    if (!['open', 'closed', 'all'].includes(status)) throw new Error('--status must be open, closed or all. Open includes tasks in progress.');
    if (!['priority', 'created', 'modified'].includes(order)) throw new Error('--order must be priority, created or modified.');
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!/^[1-9]\d*$/.test(values.limit!) || !Number.isSafeInteger(limit))) throw new Error('--limit must be a positive integer.');
    const state = await request<AppState>('/api/state');
    if (values.unassigned && values.owner) throw new Error('Use --unassigned or --owner, not both.');
    const owner = values.unassigned ? 'unassigned' : values.owner || 'me';
    const ownerId = visibleOwnerId(owner, state);
    const projectIds = (values.project || []).map(value => visibleProjectId(value, state));
    const projectScopes = projectIds.map(id => new Set(visibleProjectScope(id, state.projects)));
    const ranks = { urgent: 4, high: 3, normal: 2, low: 1 };
    const tasks = state.tasks.filter(task => status === 'all' || (status === 'closed' ? isTaskClosed(task.status) : !isTaskClosed(task.status)))
      .filter(task => owner === 'all' || task.ownerId === ownerId)
      .filter(task => !values.subscribed || state.followingTaskIds.includes(task.id))
      .filter(task => projectScopes.every(scope => task.projectIds.some(id => scope.has(id))))
      .sort((left, right) => (order === 'priority' ? ranks[right.priority] - ranks[left.priority] : (order === 'created' ? right.createdAt.localeCompare(left.createdAt) : right.updatedAt.localeCompare(left.updatedAt))) || left.id.localeCompare(right.id, 'en', { numeric: true }))
      .slice(0, limit);
    if (values.json) console.log(JSON.stringify(tasks, null, 2));
    else for (const task of tasks) console.log(`${task.id}\tv${task.version}\t${task.status}\t${task.priority}\t${task.title}`);
    return;
  }
  if (command === 'projects') {
    if (args.length) throw new Error('projects accepts options, not positional IDs. Use show PROJ1 for one project.');
    const status = values.status || 'active';
    if (!['active', 'archived', 'all'].includes(status)) throw new Error('--status must be active, archived or all.');
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!/^[1-9]\d*$/.test(values.limit!) || !Number.isSafeInteger(limit))) throw new Error('--limit must be a positive integer.');
    const state = await request<AppState>('/api/state');
    const projects = state.projects.filter(project => status === 'all' || project.status === status)
      .filter(project => !values.joined || state.joinedProjectIds.includes(project.id))
      .filter(project => !values.watching || state.watchingProjectIds.includes(project.id))
      .sort((left, right) => projectDisplayName(left).localeCompare(projectDisplayName(right)) || left.id.localeCompare(right.id, 'en', { numeric: true }))
      .slice(0, limit);
    if (values.json) console.log(JSON.stringify(projects, null, 2));
    else for (const project of projects) console.log(`${project.id}\tv${project.version}\t${project.status}\t${projectDisplayName(project)}`);
    return;
  }
  if (command === 'show') {
    const id = args[0];
    const detail = id && /^T[1-9]\d*$/.test(id) ? await request<TaskDetail>(`/api/tasks/${id}`)
      : id && /^PROJ[1-9]\d*$/.test(id) ? await request<ProjectDetail>(`/api/projects/${id}`) : await getDetail(id);
    return console.log(JSON.stringify(detail, null, 2));
  }
  if (command === 'board') {
    if (args.length !== 1) throw new Error('Provide one project ID, exact name or alias.');
    const status = values.status || 'open';
    if (!['open', 'all'].includes(status)) throw new Error('--status must be open or all. Open includes tasks in progress.');
    if (values.unassigned && values.owner) throw new Error('Use --unassigned or --owner, not both.');
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!/^[1-9]\d*$/.test(values.limit!) || !Number.isSafeInteger(limit))) throw new Error('--limit must be a positive integer.');
    const state = await request<AppState>('/api/state');
    const id = visibleProjectId(args[0]!, state);
    const ownerId = visibleOwnerId(values.unassigned ? 'unassigned' : values.owner || 'all', state);
    const query = new URLSearchParams({ status, showHidden: String(Boolean(values['show-hidden'])), limit: String(Math.min(limit ?? 100, 100)) });
    if (ownerId !== undefined) query.set('ownerId', ownerId === null ? 'null' : ownerId);
    const path = `/api/projects/${id}/workboard`;
    const board = await request<WorkboardDetail>(`${path}?${query}`);
    for (const column of board.columns) {
      const cursors = new Set<string>();
      while (column.cards.nextAfter !== null && (limit === undefined || column.cards.cards.length < limit)) {
        const cursor = column.cards.nextAfter;
        if (cursors.has(cursor)) throw new Error('The board page cursor repeated. Reload the board.');
        cursors.add(cursor);
        const pageQuery = new URLSearchParams(query);
        pageQuery.set('after', cursor); pageQuery.set('expectedBoardVersion', String(board.board.version));
        if (limit !== undefined) pageQuery.set('limit', String(Math.min(100, limit - column.cards.cards.length)));
        const page = await request<WorkboardCardPage>(`${path}/columns/${encodeURIComponent(column.id)}/cards?${pageQuery}`);
        if (page.projectId !== id || page.columnId !== column.id || page.boardVersion !== board.board.version || page.accessEpoch !== board.accessEpoch || page.filter.status !== board.filter.status || page.filter.showHidden !== board.filter.showHidden || page.filter.ownerId !== board.filter.ownerId) throw new Error('The board or its access changed while reading pages. Run the command again.');
        const known = new Set(column.cards.cards.map(card => card.id));
        if (page.cards.some(card => known.has(card.id)) || new Set(page.cards.map(card => card.id)).size !== page.cards.length) throw new Error('The board returned overlapping pages. Run the command again.');
        column.cards = { ...page, cards: [...column.cards.cards, ...page.cards] };
      }
    }
    if (values.json) console.log(JSON.stringify(board, null, 2));
    else {
      console.log(`${id} · ${projectDisplayName(board.project)} · ${board.board.enabled ? `Board v${board.board.version}` : 'Workboard disabled'}`);
      for (const column of board.columns) {
        console.log(`\n${column.name}${column.hidden ? ' [hidden]' : ''} · ${column.cards.cards.length}/${column.visibleCardCount} visible cards${column.pointLimit === null ? '' : ` · limit ${column.pointLimit}${column.overLimit ? ' exceeded' : ''}`}`);
        for (const card of column.cards.cards) console.log(`${card.id}\tv${card.version}\t${card.status}\t${card.priority}\t${card.title}`);
        if (column.cards.nextAfter !== null) console.log('More cards available; increase or omit --limit.');
      }
    }
    return;
  }
  if (command === 'review') {
    if (!['local', 'openai', 'ollama'].includes(values.provider!)) throw new Error('--provider must be local, openai or ollama.');
    const detail = await getDetail(args[0]);
    const review = await request(`/api/revisions/${detail.revision.id}/reviews`, 'POST', { provider: values.provider, expectedVersion: detail.revision.currentVersion });
    return console.log(JSON.stringify(review, null, 2));
  }
  if (command === 'export') {
    const detail = await getDetail(args[0]);
    const number = values.version ? Number(values.version) : detail.revision.currentVersion;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('--version must be a positive integer.');
    return console.log(JSON.stringify(await request(`/api/revisions/${detail.revision.id}/export?version=${number}`), null, 2));
  }
  throw new Error(`Unknown command: ${command}. Run npm run arc -- --help.`);
}

async function readSources(paths: string[]): Promise<SourceFile[]> {
  if (paths.length === 0 || paths.length > 50) throw new Error('Provide between 1 and 50 explicit text file paths.');
  const workingDirectory = process.cwd();
  const sourceRoot = await realpath(workingDirectory);
  const seen = new Set<string>();
  let size = 0;
  const files: SourceFile[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const localPath = relative(workingDirectory, absolute);
    const name = localPath.split(sep).join('/');
    if (!name || localPath === '..' || name.startsWith('../') || isAbsolute(localPath) || seen.has(name)) throw new Error('Files must have unique paths within the current directory.');
    if (name.length > 240 || /[\x00-\x1f:\\]/.test(name)) throw new Error('Source paths must be at most 240 characters and contain no control characters, colons, or backslashes.');
    const forbidden = (filePath: string) => filePath.split(sep).some(part => part === '.env' || part.startsWith('.env.') || ['.git', '.ssh', '.aws'].includes(part));
    if (forbidden(absolute)) throw new Error('Credential files and private configuration directories cannot be submitted by arc.');
    seen.add(name);
    // Refuse symlinks at every component: a harmless-looking alias must never
    // bypass the explicit file boundary or credential-name exclusions.
    let component = sourceRoot;
    for (const part of localPath.split(sep)) {
      component = resolve(component, part);
      if ((await lstat(component)).isSymbolicLink()) throw new Error(`Symbolic links cannot be submitted by arc: ${name}.`);
    }
    const canonical = await realpath(absolute);
    const canonicalRelative = relative(sourceRoot, canonical);
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative) || forbidden(canonical)) throw new Error('Source files must remain within the current directory and outside private configuration directories.');
    const expected = await lstat(canonical);
    if (!expected.isFile() || expected.size > 500_000) throw new Error(`${name} is not a text file under 500 KB.`);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size > 500_000) throw new Error(`${name} changed while being read. Retry with a stable source file.`);
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(500_001);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read > 500_000) throw new Error(`${name} exceeds 500 KB.`);
      bytes = buffer.subarray(0, read);
    } finally { await handle.close(); }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error(`${name} contains binary content.`);
    size += bytes.length;
    if (size > 1_000_000) throw new Error('Snapshot exceeds 1 MB.');
    files.push({ path: name, content });
  }
  return files;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed.'); process.exitCode = 1; });
