import type { IncomingMessage } from 'node:http';
import type { Auth } from './auth.ts';
import type { Store } from './store.ts';
import type { PolicyStore } from './policy.ts';
import { AccessLayer } from './access.ts';
import { HttpError } from './validation.ts';
import { canonicalWikiPath, type WikiStatus } from '../shared/wiki.ts';
import type { WikiVersion } from '../shared/types.ts';
import type { WikiContentSearchItem, WikiContentSearchQuery, WikiDocumentSearchQuery } from '../shared/wiki-search.ts';
import { executeConduitWrite } from './conduit-writes.ts';
import type { Automation } from './automation.ts';
import { AUTOMATION_CONDUIT_METHODS, AUTOMATION_CONDUIT_WRITES, executeAutomationConduit } from './automation-conduit.ts';

const MAX_BODY = 2_000_000;
const HISTORY_LIMIT = 1000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const methods = new Set(['phriction.info', 'phriction.history', 'phriction.document.search', 'phriction.content.search']);
class ConduitError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const invalid = (message = 'Provide supported parameters with the documented types.') => new ConduitError('ERR-INVALID-PARAMETER', message);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Parameters must be an object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('This method received unsupported parameters.');
}
function json(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw invalid('Parameters must contain valid JSON.'); }
}
function plainForm(form: URLSearchParams, nativeBuildIds = false): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const arrays = new Map<string, { values: string[]; indexes: Set<string>; append: boolean }>();
  for (const [name, value] of form) {
    if (name === 'output') { if (value !== 'json') throw invalid('Only JSON responses are supported.'); continue; }
    const nested = /^(constraints|attachments)\[([A-Za-z][A-Za-z0-9]*)\](?:\[(\d*)\])?$/.exec(name);
    if (nested) {
      const group = nested[1]!, key = nested[2]!, index = nested[3];
      if (typeof result[group] === 'string') throw invalid('Do not mix nested fields and JSON fields.');
      const target = (result[group] ??= Object.create(null)) as Record<string, unknown>;
      if (index === undefined) { if (key in target) throw invalid('Duplicate parameter.'); target[key] = value; }
      else {
        const arrayKey = `${group}.${key}`;
        let entry = arrays.get(arrayKey);
        if (!entry) {
          if (key in target) throw invalid('Do not mix scalar and list fields.');
          entry = { values: [], indexes: new Set(), append: index === '' }; arrays.set(arrayKey, entry); target[key] = entry.values;
        }
        if (entry.append !== (index === '') || index !== '' && entry.indexes.has(index)) throw invalid('Ambiguous list parameter.');
        if (entry.values.length >= 100) throw invalid('Constraint lists may contain at most 100 values.');
        entry.indexes.add(index); entry.values.push(value);
      }
      continue;
    }
    if (!['slug', 'title', 'content', 'description', 'queryKey', 'order', 'before', 'after', 'limit', 'constraints', 'attachments', 'api.token', '__conduit__', 'buildTargetPHID', 'type', 'leaseToken', 'reportId', 'log', 'unit', 'lint', 'artifactKey', 'artifactType', 'artifactData', 'objectIdentifier', 'transactions', 'expectedVersion'].includes(name) || name in result) throw invalid('Unsupported or duplicate form field.');
    result[name] = value;
  }
  for (const name of ['constraints', 'attachments', '__conduit__', 'unit', 'lint', 'artifactData', 'transactions']) if (typeof result[name] === 'string') result[name] = json(result[name] as string);
  if (typeof result.limit === 'string') result.limit = formInteger(result.limit);
  if (typeof result.expectedVersion === 'string') result.expectedVersion = formInteger(result.expectedVersion);
  if (result.constraints !== undefined) {
    const constraints = record(result.constraints);
    for (const name of nativeBuildIds ? [] : ['ids', 'versions', 'version']) if (Array.isArray(constraints[name])) constraints[name] = (constraints[name] as unknown[]).map(value => typeof value === 'string' ? formInteger(value) : value);
  }
  if (result.attachments !== undefined) {
    const attachments = record(result.attachments);
    for (const name of Object.keys(attachments)) {
      if (attachments[name] === 'true' || attachments[name] === '1') attachments[name] = true;
      else if (attachments[name] === 'false' || attachments[name] === '0') attachments[name] = false;
    }
  }
  return result;
}
function formInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid('Numeric parameters require positive integers.');
  return Number(value);
}
async function parameters(req: IncomingMessage, method: string): Promise<{ params: Record<string, unknown>; token: unknown }> {
  const contentType = req.headers['content-type'] ?? '';
  const isJSON = /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!isJSON && !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) throw invalid('Use form-encoded parameters or an application/json object.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw invalid('Request exceeds the 2 MB body limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length; if (size > MAX_BODY) throw invalid('Request exceeds the 2 MB body limit.'); chunks.push(bytes);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw invalid('Request must contain valid UTF-8.'); }
  let params: Record<string, unknown>;
  if (isJSON) params = record(json(text));
  else {
    const form = new URLSearchParams(text);
    if (form.has('params')) {
      if ([...form.keys()].some(key => !['params', 'output', 'api.token'].includes(key) || form.getAll(key).length !== 1)) throw invalid('Do not mix encoded parameters with other form fields.');
      if (form.has('output') && form.get('output') !== 'json') throw invalid('Only JSON responses are supported.');
      params = record(json(form.get('params')!));
      if (form.has('api.token')) { if ('api.token' in params) throw invalid('Use one authentication method per request.'); params['api.token'] = form.get('api.token'); }
    } else params = plainForm(form, method.startsWith('harbormaster.'));
  }
  const tokens: unknown[] = [];
  if ('api.token' in params) { tokens.push(params['api.token']); delete params['api.token']; }
  if ('__conduit__' in params) {
    const metadata = record(params.__conduit__); keys(metadata, ['token']);
    if ('token' in metadata) tokens.push(metadata.token); delete params.__conduit__;
  }
  if (tokens.length > 1) throw invalid('Use one authentication method per request.');
  if (tokens.length && typeof tokens[0] !== 'string') throw new ConduitError('ERR-INVALID-AUTH', 'A valid access token is required.');
  return { params, token: tokens[0] };
}
function searchParameters(params: Record<string, unknown>, content: boolean): { query: WikiDocumentSearchQuery | WikiContentSearchQuery; queryKey: string | null; order: string | null; limit: number; attachment: boolean } {
  keys(params, ['queryKey', 'constraints', 'attachments', 'order', 'before', 'after', 'limit']);
  const queryKey = params.queryKey === '' ? null : params.queryKey ?? null;
  if (queryKey !== null && (content ? queryKey !== 'all' : queryKey !== 'all' && queryKey !== 'active')) throw invalid('Only the documented built-in queries are supported.');
  const constraints = params.constraints === undefined ? {} : record(params.constraints);
  keys(constraints, content ? ['ids', 'phids', 'documentPHIDs', 'document', 'documents', 'documentPHID', 'versions', 'version'] : ['ids', 'phids', 'statuses', 'paths', 'parentPaths', 'ancestorPaths', 'query']);
  const normalized = { ...constraints };
  if (content) {
    for (const [canonical, aliases] of [['documentPHIDs', ['document', 'documents', 'documentPHID']], ['versions', ['version']]] as const) {
      const provided = [canonical, ...aliases].filter(name => name in normalized);
      if (provided.length > 1) throw invalid('Use one name for each constraint.');
      if (provided.length) { normalized[canonical] = normalized[provided[0]!]; if (provided[0] !== canonical) delete normalized[provided[0]!]; }
    }
  }
  const attachments = params.attachments === undefined ? {} : record(params.attachments); keys(attachments, ['content']);
  if (attachments.content !== undefined && typeof attachments.content !== 'boolean') throw invalid('The content attachment flag must be boolean.');
  const order = params.order ?? null;
  if (order !== null && order !== 'newest' && order !== 'oldest' && order !== 'created') throw invalid('Supported orders are newest, oldest and created.');
  const limit = params.limit ?? 100;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be an integer from 1 to 100.');
  const query = { ...normalized, ...(!content ? { queryKey: queryKey ?? 'all' } : {}), order: order === 'created' ? 'newest' : order ?? 'newest', limit, includeContent: attachments.content === true,
    ...(params.after === undefined || params.after === null ? {} : { after: params.after }), ...(params.before === undefined || params.before === null ? {} : { before: params.before }) };
  return { query: query as WikiDocumentSearchQuery | WikiContentSearchQuery, queryKey: queryKey as string | null, order, limit, attachment: attachments.content === true };
}
const seconds = (date: string) => Math.floor(new Date(date).getTime() / 1000);
const attachment = (content: WikiContentSearchItem) => ({ title: content.title, path: content.path, authorPHID: null, content: { raw: content.content } });
function legacyDocument(store: Store, access: AccessLayer, slug: unknown): { id: string; status: WikiStatus; phid: string } {
  if (typeof slug !== 'string' || !slug.length) throw invalid('Provide a nonempty slug.');
  let path: string;
  try { path = canonicalWikiPath(slug); } catch { throw invalid('Provide a valid wiki slug.'); }
  const location = store.database.prepare('SELECT document_id AS id, status FROM wiki_locations WHERE path=?').get(path) as { id: string; status: WikiStatus } | undefined;
  if (!location || !access.canView(location.id)) throw new ConduitError('ERR-BAD-DOCUMENT', 'No visible document exists at this slug.');
  return { ...location, phid: store.wikiDocumentIdentity(location.id).phid };
}
function legacyDictionary(doc: { phid: string; status: WikiStatus }, version: WikiVersion, root: string): unknown {
  const path = canonicalWikiPath(version.slug);
  return { phid: doc.phid, uri: `${root}w/${path === '/' ? '' : path.split('/').map(encodeURIComponent).join('/')}`, slug: version.slug,
    version: version.number, authorPHID: null, title: version.title, content: version.content,
    status: { active: 'exists', deleted: 'deleted', moved: 'moved', stub: 'stubbed' }[doc.status], description: version.message, dateCreated: seconds(version.createdAt) };
}
function execute(method: string, params: Record<string, unknown>, store: Store, access: AccessLayer, root: string): unknown {
  if (!methods.has(method)) throw new ConduitError('ERR-UNKNOWN-METHOD', 'This Conduit method is not implemented. See the wiki API compatibility documentation.');
  if (method === 'phriction.info' || method === 'phriction.history') {
    keys(params, ['slug']); const doc = legacyDocument(store, access, params.slug);
    if (method === 'phriction.info') {
      const row = store.database.prepare('SELECT v.data FROM wiki_publication p JOIN wiki_versions v ON v.id=p.published_version_id WHERE p.document_id=?').get(doc.id) as { data: string };
      return legacyDictionary(doc, JSON.parse(row.data) as WikiVersion, root);
    }
    const metadata = store.database.prepare('SELECT id, length(CAST(data AS BLOB)) AS bytes FROM wiki_versions WHERE document_id=? ORDER BY number DESC LIMIT ?').all(doc.id, HISTORY_LIMIT + 1) as { id: string; bytes: number }[];
    const oversized = () => new ConduitError('ERR-RESPONSE-TOO-LARGE', 'History exceeds the legacy response limit. Use phriction.content.search with documentPHIDs and the content attachment.');
    if (metadata.length > HISTORY_LIMIT || metadata.reduce((sum, row) => sum + row.bytes, 0) > RESPONSE_LIMIT) throw oversized();
    let size = 2;
    return metadata.map(row => {
      const version = JSON.parse((store.database.prepare('SELECT data FROM wiki_versions WHERE id=?').get(row.id) as { data: string }).data) as WikiVersion;
      const item = legacyDictionary(doc, version, root); size += Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size > RESPONSE_LIMIT) throw oversized(); return item;
    });
  }
  const isContent = method === 'phriction.content.search', search = searchParameters(params, isContent);
  const page = isContent ? access.searchWikiContent(search.query as WikiContentSearchQuery) : access.searchWikiDocuments(search.query as WikiDocumentSearchQuery);
  const data = 'contents' in page ? page.contents.map(content => ({ id: content.id, type: 'WRDS', phid: content.phid,
    fields: { documentPHID: content.documentPHID, version: content.version, dateCreated: seconds(content.createdAt), dateModified: seconds(content.createdAt) }, attachments: search.attachment ? { content: attachment(content) } : {} }))
    : page.documents.map(document => ({ id: document.conduitId, type: 'WIKI', phid: document.phid,
      fields: { path: document.path, status: { value: document.status, name: { active: 'Active', deleted: 'Deleted', moved: 'Moved', stub: 'Stub' }[document.status] } }, attachments: search.attachment ? { content: attachment(document.published) } : {} }));
  return { data, maps: {}, query: { queryKey: search.queryKey }, cursor: { limit: search.limit, after: page.nextAfter, before: page.nextBefore, order: search.order } };
}
export interface ConduitEnvelope { result: unknown; error_code: string | null; error_info: string | null }
/** Errors never echo supplied tokens, field names, values, or internal exception messages. */
export async function conduitRequest(req: IncomingMessage, method: string, url: URL, store: Store, auth: Auth, policies: PolicyStore, basePath: string, publicOrigin?: string, automation?: Automation): Promise<ConduitEnvelope> {
  try {
    if (req.method !== 'POST' || url.search) throw invalid('Conduit methods require POST without URL query parameters.');
    const { params, token } = await parameters(req, method);
    const write = method === 'phriction.create' || method === 'phriction.edit' || AUTOMATION_CONDUIT_WRITES.has(method);
    let context;
    try { context = auth.authenticateConduit(req, token, write ? 'write' : 'read'); } catch { throw new ConduitError('ERR-INVALID-AUTH', `A valid ${write ? 'write' : 'read'} credential is required. Browser sessions also require their current context and CSRF headers.`); }
    if (AUTOMATION_CONDUIT_METHODS.has(method)) {
      if (!automation) throw new ConduitError('ERR-UNKNOWN-METHOD', 'Automation Conduit methods are unavailable.');
      const key = req.headers['idempotency-key']; if (key !== undefined && typeof key !== 'string') throw invalid('Use one valid Idempotency-Key.');
      const execute = () => executeAutomationConduit(method, params, context, automation, key);
      const result = write ? execute() : store.read(() => { auth.revalidate(context, 'read'); return execute(); });
      return { result, error_code: null, error_info: null };
    }
    if (method === 'phriction.create' || method === 'phriction.edit') {
      const selected = executeConduitWrite(req, method, params, store, auth, policies, context);
      return { result: legacyDictionary({ phid: selected.phid, status: selected.receipt.snapshot.location.status }, selected.content, `${publicOrigin ?? `http://${req.headers.host}`}${basePath}`), error_code: null, error_info: null };
    }
    const result = store.read(() => {
      auth.revalidate(context, 'read');
      return execute(method, params, store, new AccessLayer(store, auth, policies, context), `${publicOrigin ?? `http://${req.headers.host}`}${basePath}`);
    });
    return { result, error_code: null, error_info: null };
  } catch (error) {
    if (error instanceof ConduitError) return { result: null, error_code: error.code, error_info: error.message };
    if (error instanceof HttpError) {
      const mapped = { CONDUIT_BAD_DOCUMENT: ['ERR-BAD-DOCUMENT', 'The wiki destination is unavailable for this operation.'], CONDUIT_INVALID_RECEIPT: ['ERR-INVALID-RECEIPT', 'The saved write response cannot be verified.'], CONDUIT_CONFLICT: ['ERR-CONFLICT', 'This retry key belongs to a different request.'] }[error.code ?? ''];
      if (mapped) return { result: null, error_code: mapped[0]!, error_info: mapped[1]! };
    }
    if (error instanceof HttpError && error.status < 500) return { result: null, error_code: error.status === 401 || error.status === 403 ? 'ERR-INVALID-AUTH' : error.code?.includes('CURSOR') || error.code === 'ACCESS_EPOCH_CHANGED' ? 'ERR-CURSOR' : 'ERR-INVALID-PARAMETER', error_info: 'The request is invalid or its cursor is no longer valid. Reload with supported parameters and current credentials.' };
    return { result: null, error_code: 'ERR-INTERNAL', error_info: 'The request could not be completed.' };
  }
}
