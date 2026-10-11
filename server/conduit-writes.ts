import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { AuthContext } from '../shared/auth.ts';
import type { ActorAttribution, WikiVersion } from '../shared/types.ts';
import type { WikiConduitMethod, WikiConduitReceipt } from '../shared/wiki-conduit.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import type { PolicyStore } from './policy.ts';
import { AccessLayer } from './access.ts';
import { HttpError } from './validation.ts';
import { parseWikiConduitCreateInput, parseWikiConduitEditInput, wikiConduitInputHash } from './wiki-conduit.ts';

const unavailable = () => new HttpError(404, 'The wiki destination is unavailable for this operation.', 'CONDUIT_BAD_DOCUMENT');
const badReceipt = () => new HttpError(409, 'The saved write response cannot be verified.', 'CONDUIT_INVALID_RECEIPT');
function existing(store: Store, slug: string): string | null {
  return (store.database.prepare('SELECT document_id FROM wiki_locations WHERE path=?').get(slug) as { document_id: string } | undefined)?.document_id ?? null;
}

/** Legacy methods deliberately observe current content under a serialized writer lock.
 * Optional retry keys bind to an immutable execution receipt, including no-ops.
 */
export function executeConduitWrite(req: IncomingMessage, method: WikiConduitMethod, params: unknown, store: Store, auth: Auth, policies: PolicyStore, context: AuthContext): { receipt: WikiConduitReceipt; content: WikiVersion; phid: string } {
  const input = method === 'phriction.create' ? parseWikiConduitCreateInput(params) : parseWikiConduitEditInput(params);
  const digest = wikiConduitInputHash(method, input);
  const rawKey = req.headers['idempotency-key'];
  if (rawKey !== undefined && (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(rawKey))) throw new HttpError(400, 'Provide a valid Idempotency-Key.');
  // Brackets cannot occur in native retry namespaces, including local raw keys.
  const key = rawKey === undefined ? undefined : JSON.stringify(['conduit', context.workspaceId, context.principalId, rawKey]);
  const retryKeySha256 = key === undefined ? null : createHash('sha256').update(key).digest('hex');
  const access = new AccessLayer(store, auth, policies, context);
  const attribution: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
  let currentId: string | null = null;
  const requireEdit = (id: string) => { const capabilities = policies.access(id, context.principalId); if (!capabilities.view || !capabilities.edit) throw unavailable(); };
  const authorize = () => {
    auth.revalidate(context, 'write');
    if (method === 'phriction.create') access.authorize('POST', '/api/documents', { slug: input.slug });
    currentId = existing(store, input.slug);
    if (currentId) requireEdit(currentId);
    else if (method === 'phriction.edit') throw unavailable();
  };
  const present = (response: MutationResponse): MutationResponse => {
    const saved = response.body;
    if (response.status !== 200 || !saved || typeof saved !== 'object' || Array.isArray(saved) || !('id' in saved) || typeof saved.id !== 'string'
      || !('documentId' in saved) || typeof saved.documentId !== 'string' || existing(store, input.slug) !== saved.documentId) throw badReceipt();
    requireEdit(saved.documentId);
    // A forged response must not make the canonical verifier load another page's source.
    const owner = store.database.prepare('SELECT document_id FROM wiki_conduit_receipts WHERE id=?').get(saved.id) as { document_id: string } | undefined;
    if (owner?.document_id !== saved.documentId) throw badReceipt();
    let receipt: WikiConduitReceipt;
    try { receipt = store.wikiConduitReceipt(saved.id); } catch { throw badReceipt(); }
    if (!isDeepStrictEqual(receipt, saved) || receipt.method !== method || receipt.inputSha256 !== digest || receipt.retryKeySha256 !== retryKeySha256 || receipt.attribution.principalId !== context.principalId
      || receipt.snapshot.location.path !== input.slug || existing(store, input.slug) !== receipt.documentId) throw badReceipt();
    requireEdit(receipt.documentId);
    // Validate the selected immutable content before committing even a fresh write.
    try { store.wikiConduitContent(receipt.id); } catch { throw badReceipt(); }
    return { status: 200, body: receipt };
  };
  let selected: { receipt: WikiConduitReceipt; content: WikiVersion; phid: string } | undefined;
  try {
    store.mutate(key, digest, () => {
      if (method === 'phriction.create' && currentId) throw unavailable();
      const receipt = method === 'phriction.create' ? store.createConduitDocument(input, attribution, retryKeySha256) : store.editConduitDocument(currentId!, input, attribution, retryKeySha256);
      if (method === 'phriction.create') policies.configureNew(receipt.documentId, undefined, context.principalId);
      return { status: 200, body: receipt };
    }, authorize, response => {
      const verified = present(response), receipt = verified.body as WikiConduitReceipt;
      selected = { receipt, content: store.wikiConduitContent(receipt.id), phid: store.wikiDocumentIdentity(receipt.documentId).phid };
      return verified;
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && !error.code) throw new HttpError(409, 'This retry key belongs to a different request.', 'CONDUIT_CONFLICT');
    throw error;
  }
  if (!selected) throw badReceipt();
  return selected;
}
