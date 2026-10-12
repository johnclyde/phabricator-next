import type { AppState, RevisionKind } from '../shared/types';
import { evaluateRevisionActive } from '../shared/revision-active';
import type { PaperCLI } from './paper-builds';

/** Read one authorized snapshot; never infer responsibility from subscriptions. */
export async function revisionActiveCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'active-revisions') return false;
  const allowed = ['server', 'json', 'help', 'kind', 'query'];
  if (args.length || optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported Active revision options without positional IDs.');
  const kind = options.kind ?? 'code', query = options.query ?? '';
  if (typeof kind !== 'string' || !['code', 'paper', 'document'].includes(kind)) throw new Error('Use --kind code, paper, or document.');
  if (typeof query !== 'string' || query.length > 512 || query.includes('\0') || /[\uD800-\uDFFF]/u.test(query)) throw new Error('Use a literal --query of at most 512 characters.');
  const state = await request<AppState>('/api/state');
  if (!state || typeof state !== 'object') throw new Error('The authorized Active revision snapshot is unavailable.');
  const result = evaluateRevisionActive(state, kind as RevisionKind, query);
  if (!result.available) throw new Error(result.reason);
  console.log(JSON.stringify({ kind, query, accessEpoch: state.accessEpoch, groups: result.groups, evaluation: 'Authorized workspace snapshot; direct author and reviewer responsibility; no server pagination.' }, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return true;
}
