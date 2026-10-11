import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WikiConduitCreateInput, WikiConduitEditInput, WikiConduitMethod } from '../shared/wiki-conduit.ts';
import { canonicalWikiPath } from '../shared/wiki.ts';
import { HttpError, object } from './validation.ts';

/** Legacy text is exact: whitespace is content, and only edit treats "0" as absent. */
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw new HttpError(400, `${field} must be complete text of at most ${max} characters.`, 'WIKI_CONDUIT_INPUT_INVALID');
  return value;
}
function slug(value: unknown): string {
  const source = text(value, 'Slug', 512);
  if (!source.length) throw new HttpError(400, 'Provide a nonempty wiki slug.', 'WIKI_CONDUIT_INPUT_INVALID');
  try { return canonicalWikiPath(source); } catch { throw new HttpError(400, 'Provide a valid wiki slug.', 'WIKI_CONDUIT_INPUT_INVALID'); }
}
function description(value: unknown): string { return value === undefined || value === null ? '' : text(value, 'Description', 10_000); }
export function parseWikiConduitCreateInput(input: unknown): WikiConduitCreateInput & { description: string } {
  const data = object(input, ['slug', 'title', 'content', 'description']);
  return { slug: slug(data.slug), title: text(data.title, 'Title', 240), content: text(data.content, 'Content', 500_000), description: description(data.description) };
}
export function parseWikiConduitEditInput(input: unknown): WikiConduitEditInput & { description: string } {
  const data = object(input, ['slug', 'title', 'content', 'description']);
  return { slug: slug(data.slug), ...(data.title === undefined ? {} : { title: data.title === null ? null : text(data.title, 'Title', 240) }), ...(data.content === undefined ? {} : { content: data.content === null ? null : text(data.content, 'Content', 500_000) }), description: description(data.description) };
}
export function wikiConduitInputHash(method: WikiConduitMethod, input: unknown): string {
  const normalized = method === 'phriction.create' ? parseWikiConduitCreateInput(input) : parseWikiConduitEditInput(input);
  return createHash('sha256').update(JSON.stringify(['wiki-conduit-v1', method, normalized])).digest('hex');
}
/** PHP truthiness used by the historical edit endpoint; creation does not use this. */
export function wikiConduitEffectiveText(value: string | null | undefined): value is string { return value !== undefined && value !== null && value !== '' && value !== '0'; }
export function initializeWikiConduit(db: DatabaseSync): void {
  db.exec(`CREATE TABLE wiki_conduit_receipts (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES entities(id),
    selected_version_id TEXT NOT NULL REFERENCES wiki_versions(id),
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX wiki_conduit_receipts_document ON wiki_conduit_receipts(document_id);
  CREATE TRIGGER wiki_conduit_receipts_no_update BEFORE UPDATE ON wiki_conduit_receipts BEGIN SELECT RAISE(ABORT,'Wiki Conduit receipts are immutable'); END;
  CREATE TRIGGER wiki_conduit_receipts_no_delete BEFORE DELETE ON wiki_conduit_receipts BEGIN SELECT RAISE(ABORT,'Wiki Conduit receipts are immutable'); END;`);
}
