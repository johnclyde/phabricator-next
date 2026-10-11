import type { PaperCLI } from './paper-builds';
import { canonicalWikiPath } from '../shared/wiki';
import type { WikiDocumentSearchPage } from '../shared/wiki-search';
import type { WikiDetail, WikiVersion } from '../shared/types';

const commands = new Set(['wiki', 'wiki-document', 'wiki-version', 'wiki-history', 'wiki-transactions']);
const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, safe));

/** Reads one bounded page. Continuation is explicit, so a search never drains the whole wiki. */
export async function wikiCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const extras: Record<string, string[]> = { wiki: ['query', 'status', 'path', 'parent-path', 'ancestor-path', 'order', 'after', 'before', 'limit'], 'wiki-document': [], 'wiki-version': ['version'], 'wiki-history': ['before', 'limit'], 'wiki-transactions': ['before', 'limit'] };
  if (optionNames.some(name => !['server', 'help', 'json', ...extras[command]!].includes(name))) throw new Error(`${command} received an unsupported option. Use --help.`);
  if (args.length !== (command === 'wiki' ? 0 : 1) || command !== 'wiki' && !/^W[1-9]\d{0,14}$/.test(args[0] ?? '')) throw new Error('Provide exactly one wiki document ID such as W1, or no arguments for wiki search.');
  const option = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const positive = (name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined => {
    const value = option(name); if (value === undefined) return;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error(`--${name} requires a positive integer no greater than ${maximum}.`);
    return Number(value);
  };
  const query = new URLSearchParams();
  const limit = positive('limit', 100); if (limit !== undefined) query.set('limit', String(limit));
  if (command === 'wiki') {
    const status = option('status') ?? 'active';
    query.set('queryKey', status === 'active' ? 'active' : 'all');
    if (status !== 'all') for (const value of status.split(',')) {
      if (!['active', 'deleted', 'moved', 'stub'].includes(value)) throw new Error('--status requires all or a comma-separated list of active, deleted, moved, stub.');
      query.append('statuses', value);
    }
    if (option('query') !== undefined) {
      const value = option('query')!;
      if (value.length > 1000 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw new Error('--query must contain complete characters and at most 1000 characters.');
      query.set('query', value);
    }
    if (option('order') !== undefined) { const order = option('order')!; if (!['newest', 'oldest'].includes(order)) throw new Error('--order requires newest or oldest.'); query.set('order', order); }
    if (option('after') !== undefined && option('before') !== undefined) throw new Error('Use either --after or --before.');
    for (const name of ['after', 'before']) if (option(name) !== undefined) { const value = option(name)!; if (!/^[A-Za-z0-9_-]{70}$/.test(value)) throw new Error(`--${name} requires an opaque wiki search cursor.`); query.set(name, value); }
    for (const [name, field] of [['path', 'paths'], ['parent-path', 'parentPaths'], ['ancestor-path', 'ancestorPaths']] as const) {
      const value = options[name]; if (value === undefined) continue;
      const paths = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      if (!paths.length || paths.length > 100) throw new Error(`--${name} requires at most 100 paths.`);
      for (const path of paths) query.append(field, canonicalWikiPath(path));
    }
    const page = await request<WikiDocumentSearchPage>(`/api/documents?${query}`);
    if (!page || !Array.isArray(page.documents)) throw new Error('The wiki search response is invalid.');
    if (options.json) print(page);
    else {
      for (const item of page.documents) console.log(`${safe(item.id)}\t${safe(item.title)}\t${safe(item.path)}\t${safe(item.status)}\tpublished ${item.published.version}, latest ${item.version}`);
      if (page.nextAfter !== null) console.log(`More documents: --after ${safe(page.nextAfter)}`);
      if (page.nextBefore !== null) console.log(`Previous documents: --before ${safe(page.nextBefore)}`);
    }
    return true;
  }
  const id = args[0]!, root = `/api/documents/${id}`;
  if (command === 'wiki-version') {
    const number = positive('version'); if (!number) throw new Error('wiki-version requires --version N.');
    const version = await request<WikiVersion>(`${root}/versions/${number}`);
    if (version.documentId !== id || version.number !== number) throw new Error('The wiki response belongs to another document or version.');
    print(version); return true;
  }
  if (command === 'wiki-document') {
    const detail = await request<WikiDetail>(root); if (detail.document.id !== id) throw new Error('The wiki response belongs to another document.');
    print(detail); return true;
  }
  const before = positive('before'); if (before !== undefined) query.set('before', String(before));
  print(await request(`${root}/${command === 'wiki-history' ? 'history' : 'transactions'}${query.size ? `?${query}` : ''}`)); return true;
}
