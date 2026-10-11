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
import { GIT_LIMITS, isGitObjectId, isGitPath } from '../shared/repositories';
import type { GitBlob, GitHistory, GitImportInput, GitRefs, GitTree, GitVersionImportInput, RepositoryDetail } from '../shared/repositories';
import { paperCommand } from './paper-builds';
import { fileCommand } from './files';
import { citationCommand } from './citations';
import { pasteCommand } from './pastes';
import { docxCommand } from './docx';
import { docxDiscussionCommand } from './docx-discussion';
import { revisionDependenciesCommand } from './revision-dependencies';
import { wikiCommand } from './wiki';
import { wikiWriteCommand } from './wiki-write';
import { gitComparisonCommand } from './git-comparison';
import { gitBlameCommand } from './git-blame';
import { gitPatchCommand } from './git-patch';

const help = `Phabricator Next — arc (initial CLI)

  npm run arc -- check [--kind paper|document|code] FILE... [--json]
  npm run arc -- diff --title "Title" --kind paper FILE...
  npm run arc -- diff --revision P2 --message "Changes" FILE...
  npm run arc -- list
  npm run arc -- tasks [--owner me|all|unassigned|USERNAME] [--subscribed] [--project ID|NAME] [--status open|closed|all] [--order priority|created|modified] [--limit N] [--json]
  npm run arc -- projects [--status active|archived|all] [--joined] [--watching] [--limit N] [--json]
  npm run arc -- board PROJECT [--status open|all] [--owner me|all|unassigned|USERNAME] [--show-hidden] [--limit N] [--json]
  npm run arc -- repositories [--limit N] [--json]
  npm run arc -- refs R1 [--json]
  npm run arc -- browse R1 --commit FULL_ID [--path PATH] [--file] [--json]
  npm run arc -- history R1 --commit FULL_ID [--path PATH] [--after N] [--limit N] [--json]
  npm run arc -- blame R1 --commit FULL_ID --path PATH [--json]
  npm run arc -- compare-commits R1 --base FULL_ID|empty --commit FULL_ID [--before-path PATH] [--after-path PATH] [--json]
  npm run arc -- download-patch R1 --base FULL_ID|empty --commit FULL_ID --output NEW_FILE [--json]
  npm run arc -- import-git R1 --commit FULL_ID --title "Title" [--kind code|paper|document] [--project ID|NAME] [--request-id KEY] [--json]
  npm run arc -- import-git-version D1 --commit FULL_ID --version N --version-id ID --content-hash SHA256 --message "Changes" [--request-id KEY] [--json]
  npm run arc -- show P2|T1|PROJ1|R1
  npm run arc -- review P2 [--provider local|openai|ollama]
  npm run arc -- export P2 [--version 1]
  npm run arc -- revision-dependencies P2 --direction parents|children [--after ID] [--limit N] [--relationship-version N]
  npm run arc -- revision-dependency-history P2 [--before N] [--limit N] [--relationship-version N]
  npm run arc -- edit-revision-dependencies P2 --intent REQUEST.json [--request-id KEY]
  npm run arc -- builds P2 [--before N] [--limit N] [--json]
  npm run arc -- compile P2 --version-id ID --content-hash SHA256 --entrypoint main.tex --toolchain-id SHA256 [--request-id KEY] [--json]
  npm run arc -- build P2 BUILD_ID [--json]
  npm run arc -- cancel-build P2 BUILD_ID [--request-id KEY] [--json]
  npm run arc -- retry-build P2 BUILD_ID [--request-id KEY] [--json]
  npm run arc -- download-build P2 BUILD_ID --artifact pdf|log|manifest|synctex|mapping --output NEW_FILE [--json]
  npm run arc -- files [--name TEXT] [--author ID] [--status active|archived|all] [--before N] [--limit N] [--json]
  npm run arc -- file F1 [--json]
  npm run arc -- file-history F1 [--before N] [--limit N]
  npm run arc -- upload-file PATH [--name NAME] [--alt-text TEXT] [--request-id KEY] [--json]
  npm run arc -- upload-receipt REQUEST_ID [--json]
  npm run arc -- edit-file F1 --version N [--name NAME] [--alt-text TEXT] [--status active|archived] [--request-id KEY]
  npm run arc -- attach-file F1 --object P2 --mode attach|reference|detach --version N [--access-epoch N] [--request-id KEY]
  npm run arc -- download-file F1 --output NEW_FILE
  npm run arc -- set-figures P2 --assets-manifest FILE.json --version N --version-id ID --content-hash SHA256 --access-epoch N --message TEXT [--share-assets] [--request-id KEY]
  npm run arc -- inspect-docx F1
  npm run arc -- import-docx REQUEST.json [--request-id KEY]
  npm run arc -- reimport-docx L1 --intent REQUEST.json [--request-id KEY]
  npm run arc -- edit-docx L1 --intent REQUEST.json [--request-id KEY]
  npm run arc -- download-docx L1 --version N --version-id ID --content-hash SHA256 --output NEW_FILE
  npm run arc -- comment-docx L1 --intent REQUEST.json [--request-id KEY]
  npm run arc -- export-docx-discussion L1 --intent REQUEST.json --output NEW_FILE
  npm run arc -- citations P2 --version N [--json]
  npm run arc -- citation-evidence P2 --version-id ID [--target-id ID] [--before N] [--limit N]
  npm run arc -- citation-record P2 RECORD_ID
  npm run arc -- record-citation P2 --evidence FILE.json --attest-inspected [--request-id KEY]
  npm run arc -- retract-citation P2 RECORD_ID --version N --reason-file FILE.txt [--request-id KEY]
  npm run arc -- pastes [--query TEXT] [--author ID] [--language LANGUAGE] [--status active|archived|all] [--created-after ISO] [--created-before ISO] [--before N] [--limit N] [--json]
  npm run arc -- paste PA1
  npm run arc -- create-paste FILE --title "Title" [--language LANGUAGE] [--space S1] [--request-id KEY]
  npm run arc -- edit-paste PA1 --version N [--content-file FILE] [--title TEXT] [--language LANGUAGE] [--status active|archived] [--request-id KEY]
  npm run arc -- paste-version PA1 --version N
  npm run arc -- paste-versions PA1 [--before N] [--limit N]
  npm run arc -- paste-history PA1 [--before N] [--limit N]
  npm run arc -- comment-paste PA1 --version N --comment-file FILE [--request-id KEY]
  npm run arc -- archive-paste PA1 --version N [--status active] [--request-id KEY]
  npm run arc -- download-paste PA1 --version N --output NEW_FILE
  npm run arc -- wiki [--query TEXT] [--status active|all|deleted|moved|stub] [--path PATH] [--parent-path PATH] [--ancestor-path PATH] [--order newest|oldest] [--after CURSOR|--before CURSOR] [--limit N] [--json]
  npm run arc -- wiki-document W1
  npm run arc -- wiki-version W1 --version N
  npm run arc -- wiki-history W1 [--before N] [--limit N]
  npm run arc -- wiki-transactions W1 [--before N] [--limit N]
  npm run arc -- create-wiki REQUEST.json [--request-id KEY] [--json]
  npm run arc -- edit-wiki REQUEST.json [--request-id KEY] [--json]

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
Repository reads use operator-configured local Git copies. refs observes branches
and tags; browse/history require a full commit ID and never follow a moving ref.
browse lists a directory; --file reads one file. Text display escapes terminal
control characters; --json preserves the source as a JSON string. history reads
one commit-pinned page and reports the next --after value. Nothing is fetched,
checked out, imported, or pushed by these commands.
import-git explicitly creates a review from the entire pinned text tree, retaining
Git provenance and repository access requirements. Unsupported files reject the
whole import. Nothing is executed or reviewed automatically. The request ID is
printed to stderr before submission; repeat the identical command with that
--request-id to recover an uncertain result without creating another review.
import-git-version replaces an existing review's complete source tree with a new
immutable version. Copy --version, --version-id and --content-hash from the exact
version you inspected with show or export. These pins are required on every
attempt, including retries; the command never selects a newer review head.
The linked repository is selected by the server. Its view access and the review's
edit access are required. The exact request is printed as escaped JSON to stderr
before submission. Retry it unchanged with the same --request-id.
compile explicitly submits a saved paper version to the operator's isolated TeX
worker. Copy version pins from export and the toolchain ID from builds. No source
is compiled on this computer by arc. The job continues after the command exits;
build reads its status. retry-build creates a new job for the original exact
source and toolchain; repeating its request ID recovers the same saved receipt.
download-build verifies the artifact size and SHA-256 and never overwrites files.
Files are immutable bytes with editable metadata. Uploads begin private; attach
explicitly shares with the target object's readers within the File Space. Merely
referencing a File grants no access. File uploads and downloads are bounded to
16 MiB and verified by SHA-256. An upload receipt can recover a lost response.
set-figures replaces the complete figure manifest on the exact selected source;
each JSON entry pins path, fileId, sha256, bytes, mediaType. --share-assets explicitly
shares new figures. Ordinary text diff preserves the selected version's figures.
Removing figures does not detach earlier versions' grants or delete their bytes.
Word imports bind an inspected File and preserve its package. Word request JSON
contains exact source/version/access pins and an explicit shareSource choice.
edit-docx applies a supported exact text replacement as a tracked change.
comment-docx posts an exact original-version Word passage thread. Explicit
export-docx-discussion pins selected thread versions and saves a separate Word
copy containing their complete transcripts as classic comments, without changing
source or acceptance. Export works with read scope and never enters an outbox.
See docs/docx.md for request shapes and preservation limits. Word downloads verify
the selected version's package hash; they never overwrite an existing file.
citations inventories literal source in one saved version; check --kind paper
also checks bibliography keys offline. Neither verifies cited claims.
record-citation submits your explicit source-inspection attestation. Its JSON
pins versionId, contentHash, targetId, source {fileId,sha256,bytes,mediaType},
verdict, quote, locator, note, attested:true and expectedAccessEpoch. Records are
visible only to readers of both manuscript and supporting File; no File is
shared implicitly. Retain the input file and request ID for exact retry.
retract-citation appends a reason without erasing the original record.
Paste content comes from bounded regular UTF-8 files, preserving BOM, whitespace,
and newline bytes. Edit/archive --version is the metadata version; comment/read/
download --version is the immutable content version. Downloads verify SHA-256
and byte length and never overwrite a file. Empty --language selects plain text.
create-wiki and edit-wiki explicitly submit a bounded UTF-8 JSON file to Conduit.
Create requires slug, title and content; edit requires slug and accepts optional
title/content. Both accept description. These legacy commands publish immediately,
not as saved drafts, and do not fetch or pin the latest document automatically.
Edit ignores empty, "0" and null title/content. A changed title is compared with
published content; a changed body is compared with the latest saved content.
Effective changes use the published baseline; earlier draft versions remain in
history. A successful edit with no effect returns the prior published version. Keep the input
file and request ID printed before submission; retry unchanged with that ID after
an uncertain result. Output contains returned metadata and a content hash, never
the raw source. A receipt may be historical and is not a fresh editing base.
Password workspaces require an operator-issued PHABRICATOR_TOKEN environment
variable. Tokens are never accepted as command arguments or sent on redirects.
This is not a drop-in Arcanist replacement; working-copy patch application and
Git landing are planned.
compare-commits reads an explicit ordered commit pair. Omit file paths for the
complete change inventory; supply the listed before/after paths for one change.
An absent side is omitted, distinct from an existing empty file. Rename/copy
similarity is Git's inference; comparisons do not create review evidence.
blame attributes every line of an exact text file to its original commit and
path, including whole-file renames. It never changes source or review evidence.
download-patch saves a complete binary-capable Git patch for an exact pair,
verifies its byte length and SHA-256, and never overwrites an existing file.
It does not apply patches, update references, or select a newer branch head.
`;

function terminalText(value: string, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g;
  return value.replace(controls, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

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
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true, strict: true, tokens: true,
    options: {
      kind: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
      revision: { type: 'string' }, message: { type: 'string' }, provider: { type: 'string', default: 'local' },
      server: { type: 'string', default: process.env.PHABRICATOR_URL || 'http://127.0.0.1:4310' },
      version: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      status: { type: 'string' }, order: { type: 'string' }, limit: { type: 'string' },
      project: { type: 'string', multiple: true }, owner: { type: 'string' }, unassigned: { type: 'boolean' }, subscribed: { type: 'boolean' },
      joined: { type: 'boolean' }, watching: { type: 'boolean' },
      'show-hidden': { type: 'boolean' },
      commit: { type: 'string' }, path: { type: 'string' }, file: { type: 'boolean' }, after: { type: 'string' },
      base: { type: 'string' }, 'before-path': { type: 'string' }, 'after-path': { type: 'string' },
      'parent-path': { type: 'string', multiple: true }, 'ancestor-path': { type: 'string', multiple: true },
      'request-id': { type: 'string' },
      intent: { type: 'string' },
      direction: { type: 'string' }, 'relationship-version': { type: 'string' },
      'version-id': { type: 'string' }, 'content-hash': { type: 'string' },
      entrypoint: { type: 'string' }, 'toolchain-id': { type: 'string' }, before: { type: 'string' },
      artifact: { type: 'string' }, output: { type: 'string' },
      name: { type: 'string' }, author: { type: 'string' }, 'alt-text': { type: 'string' },
      object: { type: 'string' }, mode: { type: 'string' }, 'access-epoch': { type: 'string' },
      'assets-manifest': { type: 'string' }, 'share-assets': { type: 'boolean' },
      'target-id': { type: 'string' }, evidence: { type: 'string' }, 'attest-inspected': { type: 'boolean' }, 'reason-file': { type: 'string' },
      query: { type: 'string' }, language: { type: 'string' }, space: { type: 'string' }, 'created-after': { type: 'string' }, 'created-before': { type: 'string' }, 'content-file': { type: 'string' }, 'comment-file': { type: 'string' },
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
  const rawRequest = async (path: string, method = 'GET', body?: unknown, requestId?: string): Promise<Response> => {
    const token = process.env.PHABRICATOR_TOKEN;
    if (token && (!/^[A-Za-z0-9._-]{1,256}$/.test(token))) throw new Error('PHABRICATOR_TOKEN has an invalid format.');
    if (token && server.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) throw new Error('API tokens require HTTPS except for a loopback server.');
    return fetch(new URL(mountPath(path, basePath), server), {
      method, signal: AbortSignal.timeout(135_000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'Idempotency-Key': requestId ?? randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const request = async <T>(path: string, method = 'GET', body?: unknown, requestId?: string): Promise<T> => {
    const response = await rawRequest(path, method, body, requestId);
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Server returned HTTP ${response.status}`);
    return value;
  };
  const download = async (path: string, maxBytes: number): Promise<Uint8Array> => {
    const response = await rawRequest(path);
    if (!response.ok) { const error = await response.json() as { error?: string }; throw new Error(error.error || `Server returned HTTP ${response.status}`); }
    if (!response.body) throw new Error('The artifact response has no body.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('The artifact exceeds its declared size. No output file was written.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  };
  if (await paperCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await fileCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await docxCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await docxDiscussionCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await revisionDependenciesCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await citationCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await pasteCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await wikiCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await wikiWriteCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await gitComparisonCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await gitBlameCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
  if (await gitPatchCommand({ command, args, options: values, optionNames: tokens.flatMap(token => token.kind === 'option' ? [token.name] : []), request, download })) return;
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
      : id && /^PROJ[1-9]\d*$/.test(id) ? await request<ProjectDetail>(`/api/projects/${id}`)
        : id && /^R[1-9]\d*$/.test(id) ? await request<RepositoryDetail>(`/api/repositories/${id}`) : await getDetail(id);
    return console.log(JSON.stringify(detail, null, 2));
  }
  if (command === 'import-git') {
    const id = args[0]; const commitId = values.commit;
    if (args.length !== 1 || !id || !/^R[1-9]\d*$/.test(id)) throw new Error('Provide one repository ID such as R1.');
    if (!commitId || !isGitObjectId(commitId)) throw new Error('--commit requires a full lowercase Git object ID, not a branch name or revision expression.');
    if (!values.title?.trim()) throw new Error('--title is required for a new imported review.');
    if ([values.path, values.file, values.revision, values.after, values.limit, values.version, values.message, values['version-id'], values['content-hash']].some(value => value !== undefined)) throw new Error('import-git creates a new review from the entire commit. File filters, paging and existing-revision options are not accepted.');
    if ((values.project?.length ?? 0) > 1) throw new Error('An imported review accepts at most one --project.');
    const requestId = values['request-id'] ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('--request-id must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
    const projectId = values.project?.[0] ? visibleProjectId(values.project[0], await request<AppState>('/api/state')) : undefined;
    const input: GitImportInput = { commitId, kind: kind as RevisionKind, title: values.title, ...(values.summary === undefined ? {} : { summary: values.summary }), ...(projectId ? { projectId } : {}) };
    console.error(`Import request ID: ${requestId}. Keep this ID and the same inputs when retrying an uncertain result.`);
    const detail = await request<RevisionDetail>(`/api/repositories/${id}/import-revision`, 'POST', input, requestId);
    const version = detail.versions.find(item => item.number === 1); const gitSource = version?.gitSource;
    if (detail.revision.repositoryId !== id || detail.revision.kind !== kind || !gitSource || gitSource.repositoryId !== id || gitSource.commitId !== commitId || gitSource.scope !== 'complete-text-tree' || !isGitObjectId(commitId, gitSource.objectFormat)) throw new Error('The import receipt does not match the requested repository and commit. Retain the request ID and inspect the saved result before starting another import.');
    if (values.json) console.log(JSON.stringify(detail, null, 2));
    else {
      console.log(`${detail.revision.id} · v${version!.number} · ${terminalText(detail.revision.title)}`);
      console.log(`Imported ${version!.files.length} files from ${id} at ${commitId}. Repository access remains required.`);
      console.log(new URL(`${basePath}#${detail.revision.id}`, server).href);
    }
    return;
  }
  if (command === 'import-git-version') {
    const allowed = new Set(['commit', 'version', 'version-id', 'content-hash', 'message', 'request-id', 'json', 'server', 'help']);
    if (tokens.some(token => token.kind === 'option' && !allowed.has(token.name))) throw new Error('import-git-version accepts only the target revision, exact source/version pins, message, request ID and output/server options. Create, source-filter, range and review-provider options are not accepted.');
    const id = args[0]; const commitId = values.commit; const expectedVersion = Number(values.version);
    const expectedVersionId = values['version-id']; const expectedContentHash = values['content-hash']; const message = values.message;
    if (args.length !== 1 || !id || !/^[DPL][1-9]\d{0,14}$/.test(id)) throw new Error('Provide one existing revision ID such as D1, P2 or L3.');
    if (!commitId || !isGitObjectId(commitId)) throw new Error('--commit requires a full lowercase Git object ID, not a branch name or revision expression.');
    if (!values.version || !/^[1-9]\d*$/.test(values.version) || !Number.isSafeInteger(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('--version requires the positive version number you inspected.');
    if (!expectedVersionId?.trim() || expectedVersionId.length > 100 || expectedVersionId.includes('\0')) throw new Error('--version-id requires the exact immutable version ID you inspected.');
    if (!expectedContentHash || !/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new Error('--content-hash requires the full lowercase SHA-256 content hash you inspected.');
    if (!message?.trim() || message.length > 10_000 || message.includes('\0')) throw new Error('--message requires a nonempty description of at most 10,000 characters.');
    const requestId = values['request-id'] ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('--request-id must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
    const input: GitVersionImportInput = { commitId, expectedVersion, expectedVersionId, expectedContentHash, message };
    console.error(`Import request ID: ${requestId}. Keep the exact request below for an unchanged retry.`);
    console.error(`Import intent: ${terminalText(JSON.stringify({ server: server.href, revisionId: id, requestId, input }))}`);
    const detail = await request<RevisionDetail>(`/api/revisions/${id}/import-git`, 'POST', input, requestId);
    const previous = detail.versions.find(item => item.number === expectedVersion);
    const version = detail.versions.find(item => item.number === expectedVersion + 1); const source = version?.gitSource;
    if (detail.revision.id !== id || !detail.revision.repositoryId || !/^R[1-9]\d*$/.test(detail.revision.repositoryId)
      || previous?.revisionId !== id || previous.id !== expectedVersionId || previous.contentHash !== expectedContentHash
      || version?.revisionId !== id || version.message !== message || !source || source.kind !== 'git' || source.scope !== 'complete-text-tree'
      || source.repositoryId !== detail.revision.repositoryId || source.commitId !== commitId || !['sha1', 'sha256'].includes(source.objectFormat)
      || !isGitObjectId(commitId, source.objectFormat) || !isGitObjectId(source.treeId, source.objectFormat)) throw new Error('The import receipt does not match the requested revision, source commit and version pins. Retain the exact request and retry it unchanged before starting another import.');
    if (values.json) console.log(JSON.stringify(detail, null, 2));
    else {
      console.log(`${id} · v${version.number} · ${terminalText(detail.revision.title)}`);
      console.log(`Imported ${version.files.length} files from ${source.repositoryId} at ${commitId}. Repository access remains required.`);
      console.log(new URL(`${basePath}#${id}`, server).href);
    }
    return;
  }
  if (command === 'repositories') {
    if (args.length) throw new Error('repositories accepts options, not positional IDs. Use show R1 for one repository.');
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!/^[1-9]\d*$/.test(values.limit!) || !Number.isSafeInteger(limit))) throw new Error('--limit must be a positive integer.');
    const state = await request<AppState>('/api/state');
    const repositories = [...state.repositories].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id, 'en', { numeric: true })).slice(0, limit);
    if (values.json) console.log(JSON.stringify(repositories, null, 2));
    else for (const repository of repositories) console.log(`${repository.id}\t${terminalText(repository.name)}\t${terminalText(repository.defaultBranch)}`);
    return;
  }
  if (command === 'refs' || command === 'browse' || command === 'history') {
    const id = args[0];
    if (args.length !== 1 || !id || !/^R[1-9]\d*$/.test(id)) throw new Error('Provide one repository ID such as R1.');
    const endpoint = `/api/repositories/${id}`;
    if (command === 'refs') {
      const result = await request<GitRefs>(`${endpoint}/refs`);
      if (result.repositoryId !== id) throw new Error('The server returned a different repository.');
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${id} · Refs observed ${terminalText(result.observedAt)} · HEAD ${result.headCommit || 'unborn or unavailable'}`);
        for (const ref of result.refs) console.log(`${ref.kind}\t${terminalText(ref.name)}\t${ref.commitId || 'not a commit'}\t${ref.objectId}`);
      }
      return;
    }
    const commit = values.commit; const path = values.path ?? '';
    if (!commit || !isGitObjectId(commit)) throw new Error('--commit requires a full lowercase Git object ID, not a branch name or revision expression.');
    if (!isGitPath(path)) throw new Error('--path must be a canonical relative Git path without dot segments or NUL.');
    if (command === 'browse' && values.file && !path) throw new Error('--file requires a nonempty --path.');
    const query = new URLSearchParams({ commit, path });
    const exact = (result: GitBlob | GitTree | GitHistory) => {
      if (result.repositoryId !== id || result.commitId !== commit || result.path !== path || !isGitObjectId(commit, result.objectFormat)) throw new Error('The server returned a different Git snapshot or path.');
    };
    if (command === 'history') {
      const after = values.after === undefined ? 0 : Number(values.after);
      const limit = values.limit === undefined ? GIT_LIMITS.historyDefault : Number(values.limit);
      if ((values.after !== undefined && !/^(?:0|[1-9]\d*)$/.test(values.after)) || !Number.isSafeInteger(after) || after < 0 || after > GIT_LIMITS.historyOffset) throw new Error(`--after must be an integer from 0 to ${GIT_LIMITS.historyOffset}.`);
      if ((values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > GIT_LIMITS.historyPage) throw new Error(`--limit must be an integer from 1 to ${GIT_LIMITS.historyPage}.`);
      query.set('after', String(after)); query.set('limit', String(limit));
      const result = await request<GitHistory>(`${endpoint}/history?${query}`); exact(result);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${id} · History at ${commit}${path ? ` · ${terminalText(path)}` : ''}`);
        for (const item of result.commits) console.log(`${item.id}\t${terminalText(item.author.timestamp)}\t${terminalText(item.message.split('\n')[0] || '(No message)')}${item.messageTruncated ? ' [message shortened]' : ''}`);
        if (result.nextAfter !== null) console.log(`More history: repeat with --after ${result.nextAfter}.`);
      }
      return;
    }
    if (values.file) {
      const result = await request<GitBlob>(`${endpoint}/blob?${query}`); exact(result);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${id} · ${commit} · ${terminalText(path)} · ${result.objectId}`);
        if (result.state === 'text') console.log(terminalText(result.content, true));
        else console.log(`Source unavailable as text: ${result.state.replaceAll('_', ' ')} (${result.size === null ? 'no file size' : `${result.size} bytes`}).`);
      }
    } else {
      const result = await request<GitTree>(`${endpoint}/tree?${query}`); exact(result);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${id} · ${commit} · ${terminalText(path || '/')}`);
        for (const entry of result.entries) console.log(`${entry.mode}\t${entry.type}\t${entry.size ?? '-'}\t${terminalText(entry.name)}\t${entry.objectId}`);
        if (!result.entries.length) console.log('Empty directory.');
      }
    }
    return;
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
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\0')) throw new Error(`${name} contains binary content.`);
    size += bytes.length;
    if (size > 1_000_000) throw new Error('Snapshot exceeds 1 MB.');
    files.push({ path: name, content });
  }
  return files;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed.'); process.exitCode = 1; });
