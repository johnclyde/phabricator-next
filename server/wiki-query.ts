import { HttpError } from './validation.ts';
import { parseWikiDocumentSearchQuery } from './wiki-search.ts';
import type { WikiDocumentSearchQuery } from '../shared/wiki-search.ts';

/** Repeated list fields are deliberate; repeated scalar parameters are ambiguous. */
export function wikiDocumentQuery(parameters: URLSearchParams): WikiDocumentSearchQuery {
  const lists = ['statuses', 'paths', 'parentPaths', 'ancestorPaths', 'ids', 'phids'];
  const scalars = ['queryKey', 'query', 'order', 'after', 'before', 'limit', 'includeContent'];
  const input: Record<string, unknown> = {};
  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    if (!lists.includes(key) && (!scalars.includes(key) || values.length !== 1)) throw new HttpError(400, 'Wiki search accepts only supported filters and one value for each scalar parameter.');
    if (key === 'ids' || key === 'limit') {
      if (values.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new HttpError(400, 'Wiki IDs and limits must be positive integers.');
      input[key] = key === 'ids' ? values.map(Number) : Number(values[0]);
    } else if (key === 'includeContent') {
      if (!['true', 'false'].includes(values[0]!)) throw new HttpError(400, 'includeContent must be true or false.');
      input[key] = values[0] === 'true';
    } else input[key] = lists.includes(key) ? values : values[0];
  }
  return parseWikiDocumentSearchQuery(input);
}
