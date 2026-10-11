import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PaperCLI } from './paper-builds';
import { canonicalWikiPath, WIKI_PATH_MAX_LENGTH, WIKI_WRITE_PATH_MAX_LENGTH } from '../shared/wiki';
import type { WikiConduitCreateInput, WikiConduitEditInput } from '../shared/wiki-conduit';

const MAX_INPUT_BYTES = 2_000_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, safe);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);

async function readIntent(path: string): Promise<Record<string, unknown>> {
  // Nonblocking open also prevents a named pipe from waiting for an unrelated writer.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new Error('Choose a readable regular wiki request file; symlinks are not accepted.'); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('Wiki request files must be regular files no larger than 2 MB.');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1); let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > MAX_INPUT_BYTES) throw new Error('The wiki request file grew beyond 2 MB.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown; }
    catch { throw new Error('The wiki request file must contain valid UTF-8 JSON.'); }
    if (!isRecord(value)) throw new Error('The wiki request must be a JSON object.');
    return value;
  } finally { await handle.close(); }
}

function input(value: Record<string, unknown>, creation: boolean): WikiConduitCreateInput | WikiConduitEditInput {
  if (Object.keys(value).some(key => !['slug', 'title', 'content', 'description'].includes(key))) throw new Error('The wiki request contains unsupported fields. Use slug, title, content and optional description; credentials belong in PHABRICATOR_TOKEN.');
  if (!validText(value.slug, WIKI_PATH_MAX_LENGTH) || value.slug.length === 0) throw new Error('slug must be a nonempty string of at most 512 characters.');
  const slug = canonicalWikiPath(value.slug);
  if (creation && slug.length > WIKI_WRITE_PATH_MAX_LENGTH) throw new Error('The canonical path for a new wiki document must contain at most 128 characters.');
  // Canonical property order makes the printed digest describe the exact submitted JSON body.
  const result: Record<string, unknown> = { slug };
  for (const [name, maximum] of [['title', 240], ['content', 500_000]] as const) {
    const field = value[name];
    if (creation ? !validText(field, maximum) || field.length === 0 : field !== undefined && field !== null && !validText(field, maximum)) throw new Error(`${name} must be ${creation ? 'a nonempty string' : 'a string or null'} of at most ${maximum} characters without NUL or incomplete characters.`);
    if (field !== undefined) result[name] = field;
  }
  if (value.description !== undefined) {
    if (value.description !== null && !validText(value.description, 10_000)) throw new Error('description must be null or a string of at most 10000 characters without NUL or incomplete characters.');
    result.description = value.description;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES) throw new Error('The submitted wiki request exceeds 2 MB.');
  return result as unknown as WikiConduitCreateInput | WikiConduitEditInput;
}

interface LegacyDocument { phid: string; uri: string; slug: string; version: number; authorPHID: string | null; title: string; content: string; status: string; description: string; dateCreated: number }
function receipt(value: unknown, slug: unknown): LegacyDocument {
  const fail = () => new Error('The wiki response is not a complete receipt for the requested path. Retain the original request file and request ID.');
  if (!isRecord(value) || !validText(value.phid, 100) || !/^PHID-WIKI-[A-Za-z0-9]{20}$/.test(value.phid)
    || !validText(value.uri, 4096) || /[\u0000-\u0020\u007f-\u009f]/.test(value.uri)
    || !validText(value.slug, WIKI_PATH_MAX_LENGTH) || canonicalWikiPath(value.slug) !== slug
    || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1
    || !(value.authorPHID === null || typeof value.authorPHID === 'string' && /^PHID-USER-[A-Za-z0-9]{20}$/.test(value.authorPHID))
    || !validText(value.title, 240) || !validText(value.content, 500_000) || !validText(value.description, 10_000)
    || typeof value.status !== 'string' || !['exists', 'deleted', 'moved', 'stubbed'].includes(value.status)
    || typeof value.dateCreated !== 'number' || !Number.isSafeInteger(value.dateCreated) || value.dateCreated < 0) throw fail();
  try { const uri = new URL(value.uri); if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash) throw fail(); }
  catch { throw fail(); }
  return value as unknown as LegacyDocument;
}

/** These legacy mutations publish directly, with upstream filtering and no automatic reads or rebases. */
export async function wikiWriteCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'create-wiki' && command !== 'edit-wiki') return false;
  if (optionNames.some(name => !['server', 'help', 'json', 'request-id'].includes(name))) throw new Error(`${command} received an unsupported option. Its request is supplied only by the JSON file.`);
  if (args.length !== 1 || !args[0] || args[0] === '-') throw new Error(`${command} requires one regular request JSON file.`);
  const requestId = typeof options['request-id'] === 'string' ? options['request-id'] : randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id. Use 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
  const body = input(await readIntent(args[0]), command === 'create-wiki');
  const path = `/api/phriction.${command === 'create-wiki' ? 'create' : 'edit'}`;
  console.error(`Wiki request: ${json({ path, requestId, inputPath: args[0], requestSha256: digest(JSON.stringify(body)) })}. Retain this exact input file and retry unchanged with --request-id ${requestId} if the outcome is uncertain. This operation publishes immediately; it does not save a draft.`);
  let envelope: unknown;
  try { envelope = await request<unknown>(path, 'POST', body, requestId); }
  catch { throw new Error('The wiki request did not return a verified receipt. Retain the original input file and request ID before retrying.'); }
  if (!isRecord(envelope) || !(envelope.error_code === null || typeof envelope.error_code === 'string') || !(envelope.error_info === null || typeof envelope.error_info === 'string')) throw new Error('The server did not return a valid Conduit envelope. Retain the original request file and request ID.');
  if (envelope.error_code !== null) {
    const code = /^ERR-[A-Z0-9-]{1,80}$/.test(envelope.error_code) ? envelope.error_code : 'ERR-UNKNOWN';
    throw new Error(`Wiki request failed (${code}). Retain the original request file and request ID; no successful receipt was returned.`);
  }
  if (envelope.error_info !== null) throw new Error('The Conduit success envelope is inconsistent. Retain the original request file and request ID.');
  const result = receipt(envelope.result, body.slug);
  if (command === 'create-wiki' && (result.version !== 1 || result.status !== 'exists' || result.title !== body.title || result.content !== body.content || result.description !== (body.description ?? ''))) throw new Error('The wiki creation receipt differs from the exact submitted source. Retain the original request file and request ID.');
  if (command === 'edit-wiki' && body.title !== undefined && body.title !== null && body.title !== '' && body.title !== '0' && result.title !== body.title) throw new Error('The wiki edit receipt differs from the submitted title. Retain the original request file and request ID.');
  const metadata = { phid: result.phid, uri: result.uri, slug: result.slug, version: result.version, status: result.status, title: result.title, authorPHID: result.authorPHID, dateCreated: result.dateCreated, contentSha256: digest(result.content) };
  if (options.json === true) console.log(json(metadata));
  else console.log(`${safe(result.phid)}\t${safe(result.slug)}\treturned published v${result.version}\t${safe(result.status)}\t${safe(result.title)}\nContent SHA-256: ${metadata.contentSha256}\nThis receipt may be historical or unchanged; it does not select a new editing base.`);
  return true;
}
