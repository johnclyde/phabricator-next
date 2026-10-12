/** Wiki content links keep object identity and immutable version separate from
 * the application fragment. Parsing happens before decoding query values. */
import { REMARKUP_LIMITS } from './remarkup';

export interface WikiLinkSelection {
  version: number | null;
  section: string | null;
  error: string | null;
  /** Exact incoming fragment, without the leading '#'. */
  key: string;
}
export interface WikiLinkRoute { documentId: string; navigation: WikiLinkSelection }

// Each UTF-16 unit can require up to nine URI characters. Heading projection
// has the same source bound as Remarkup; malformed incoming URLs are bounded too.
export const WIKI_LINK_LIMITS = { section: REMARKUP_LIMITS.bodyLength, hash: REMARKUP_LIMITS.bodyLength * 9 + 256, objectId: 64 } as const;
const invalidLink = 'This wiki link is invalid. Open the published version or use a complete version-pinned link.';
const validId = (value: string): boolean => /^W\d+$/.test(value) && value.length <= WIKI_LINK_LIMITS.objectId;
const validVersion = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function validSection(value: string): boolean {
  if (!value || value.length > WIKI_LINK_LIMITS.section || /[\u0000-\u001f\u007f-\u009f\\]/.test(value)) return false;
  // encodeURIComponent rejects lone surrogates instead of silently changing a
  // heading identity. Non-Latin names, NBSP and combining marks remain exact.
  try { encodeURIComponent(value); return true; } catch { return false; }
}

export function wikiContentHref(documentId: string, version: number, section?: string | null): string {
  if (!validId(documentId) || !validVersion(version) || (section != null && !validSection(section))) throw new RangeError('Invalid wiki content link.');
  return `#${documentId}?version=${version}${section == null ? '' : `&section=${encodeURIComponent(section)}`}`;
}

/** Authored wiki fragment links may also point at existing workspace routes.
 * A caller can prefer an actual matching local heading before this test. */
export function isWorkspaceHashReference(href: string): boolean {
  if (!href.startsWith('#')) return false;
  if (parseWikiLinkHash(href)) return true;
  let hash: string; try { hash = decodeURIComponent(href.slice(1)); } catch { return false; }
  return /^(?:(?:D|P|L|T|W|F|R|PA|PROJ)\d+|PROJ\d+\/workboard)$/.test(hash) || hash.startsWith('wiki/') ||
    ['home', 'reviews', 'papers', 'drafts', 'tasks', 'projects', 'repositories', 'pastes', 'files', 'wiki', 'spaces', 'notifications', 'activity', 'outbox'].includes(hash);
}

/** Unrelated workspace routes return null. Recognized but invalid wiki query
 * links retain the document route and an error; they never become latest text. */
export function parseWikiLinkHash(hash: string): WikiLinkRoute | null {
  const key = hash.startsWith('#') ? hash.slice(1) : hash;
  const question = key.indexOf('?');
  const rawId = question < 0 ? key : key.slice(0, question);
  if (rawId.length > WIKI_LINK_LIMITS.objectId * 3) return null;
  let documentId: string;
  try { documentId = decodeURIComponent(rawId); } catch { return null; }
  if (!validId(documentId)) return null;
  const result = (version: number | null, section: string | null, error: string | null): WikiLinkRoute => ({ documentId, navigation: { version, section, error, key } });
  if (key.length > WIKI_LINK_LIMITS.hash) return result(null, null, invalidLink);
  if (question < 0) return result(null, null, null);
  // URLSearchParams repairs malformed percent-encoding and UTF-8. Reject that
  // ambiguity explicitly before parsing or accepting a historical target.
  const query = key.slice(question + 1);
  try { decodeURIComponent(query.replaceAll('+', ' ')); } catch { return result(null, null, invalidLink); }
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(name => name !== 'version' && name !== 'section') || params.getAll('version').length !== 1 || params.getAll('section').length > 1) return result(null, null, invalidLink);
  const rawVersion = params.get('version')!;
  if (!/^[1-9]\d*$/.test(rawVersion)) return result(null, null, invalidLink);
  const version = Number(rawVersion), section = params.get('section');
  if (!validVersion(version) || (section !== null && !validSection(section))) return result(null, null, invalidLink);
  return result(version, section, null);
}
