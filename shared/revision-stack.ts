import { isRevisionStatus, revisionIsClosed } from './revision-status';
import { isRevisionId, type RevisionDependencyReference } from './revision-dependencies';
import { isRevisionAuthor, type RevisionAuthor } from './revision-authorship';

export const REVISION_STACK_FORMAT = 'phabricator.revision-stack.v3' as const;
export const REVISION_STACK_LIMITS = { nodes: 1_000, edges: 5_000, scannedEdges: 50_000, candidates: 10_000, bytes: 2 * 1024 * 1024 } as const;
export interface RevisionStackNode extends RevisionDependencyReference {
  relationshipVersion: number;
  head: { versionId: string; number: number; contentHash: string };
  /** Mutable ownership and immutable original source attribution are distinct. */
  author: RevisionAuthor | null;
  originalAuthor: RevisionAuthor | null;
  authorVersion: number;
  lifecycleVersion: number;
}
export interface RevisionStackEdge { childId: string; parentId: string }
export interface RevisionStack {
  format: typeof REVISION_STACK_FORMAT;
  revisionId: string;
  accessEpoch: number;
  closeOnAccept: boolean;
  snapshotId: string;
  nodes: RevisionStackNode[];
  edges: RevisionStackEdge[];
  openParentIds: string[];
}
export type RevisionStackContent = Omit<RevisionStack, 'snapshotId'>;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const invalid = (): never => { throw new RangeError('Invalid revision stack topology.'); };

/** Whole visible connected component. Dependencies point from children to parents. */
export function revisionStackTopology(revisionId: string, nodes: readonly Pick<RevisionStackNode, 'id' | 'status'>[], edges: readonly RevisionStackEdge[], closeOnAccept = false): { order: string[]; openParentIds: string[] } {
  if (!isRevisionId(revisionId) || !nodes.length || nodes.length > REVISION_STACK_LIMITS.nodes || edges.length > REVISION_STACK_LIMITS.edges) return invalid();
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || !byId.has(revisionId) || nodes.some(node => !isRevisionId(node.id))) return invalid();
  const parents = new Map(nodes.map(node => [node.id, [] as string[]])), children = new Map(nodes.map(node => [node.id, [] as string[]]));
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.childId) || !byId.has(edge.parentId) || edge.childId === edge.parentId) return invalid();
    const key = `${edge.childId}:${edge.parentId}`; if (pairs.has(key)) return invalid(); pairs.add(key);
    parents.get(edge.childId)!.push(edge.parentId); children.get(edge.parentId)!.push(edge.childId);
  }
  const reached = new Set([revisionId]), pending = [revisionId];
  while (pending.length) {
    const id = pending.pop()!;
    for (const adjacent of [...parents.get(id)!, ...children.get(id)!]) if (!reached.has(adjacent)) { reached.add(adjacent); pending.push(adjacent); }
  }
  if (reached.size !== nodes.length) return invalid();
  const remaining = new Map(nodes.map(node => [node.id, children.get(node.id)!.length]));
  const ready = nodes.filter(node => !remaining.get(node.id)).map(node => node.id).sort(lexical), order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const parent of parents.get(id)!) { const count = remaining.get(parent)! - 1; remaining.set(parent, count); if (!count) { ready.push(parent); ready.sort(lexical); } }
  }
  if (order.length !== nodes.length) return invalid();
  const ancestors = new Set<string>(), look = [revisionId];
  while (look.length) for (const parent of parents.get(look.pop()!)!) if (!ancestors.has(parent)) { ancestors.add(parent); look.push(parent); }
  return { order, openParentIds: order.filter(id => id !== revisionId && ancestors.has(id) && !revisionIsClosed(byId.get(id)!.status, closeOnAccept)) };
}

/** Fixed field order shared by the server, browser and CLI. Hashes confer no authority. */
export function canonicalRevisionStack(stack: RevisionStackContent | RevisionStack): string {
  return JSON.stringify({
    format: stack.format, revisionId: stack.revisionId, accessEpoch: stack.accessEpoch, closeOnAccept: stack.closeOnAccept,
    nodes: stack.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, status: node.status, currentVersion: node.currentVersion, updatedAt: node.updatedAt,
      relationshipVersion: node.relationshipVersion, head: { versionId: node.head.versionId, number: node.head.number, contentHash: node.head.contentHash },
      author: node.author === null ? null : { principalId: node.author.principalId, displayName: node.author.displayName },
      originalAuthor: node.originalAuthor === null ? null : { principalId: node.originalAuthor.principalId, displayName: node.originalAuthor.displayName }, authorVersion: node.authorVersion, lifecycleVersion: node.lifecycleVersion })),
    edges: stack.edges.map(edge => ({ childId: edge.childId, parentId: edge.parentId })), openParentIds: [...stack.openParentIds],
  });
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export const isRevisionStackId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Structural, semantic and size verification; callers separately verify the digest. */
export function isRevisionStack(value: unknown, revisionId?: string): value is RevisionStack {
  if (!record(value) || !exactKeys(value, ['format', 'revisionId', 'accessEpoch', 'closeOnAccept', 'snapshotId', 'nodes', 'edges', 'openParentIds'])
    || value.format !== REVISION_STACK_FORMAT || !isRevisionId(value.revisionId) || (revisionId !== undefined && value.revisionId !== revisionId)
    || typeof value.closeOnAccept !== 'boolean' || !integer(value.accessEpoch) || !isRevisionStackId(value.snapshotId) || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > REVISION_STACK_LIMITS.nodes
    || !Array.isArray(value.edges) || value.edges.length > REVISION_STACK_LIMITS.edges || !Array.isArray(value.openParentIds) || value.openParentIds.length > value.nodes.length) return false;
  for (const node of value.nodes) {
    if (!record(node) || !exactKeys(node, ['id', 'title', 'kind', 'status', 'currentVersion', 'updatedAt', 'relationshipVersion', 'head', 'author', 'originalAuthor', 'authorVersion', 'lifecycleVersion'])
      || !isRevisionId(node.id) || !text(node.title, 1_000) || typeof node.kind !== 'string' || !['code', 'paper', 'document'].includes(node.kind)
      || !isRevisionStatus(node.status) || !integer(node.currentVersion, 1) || !integer(node.relationshipVersion)
      || !text(node.updatedAt, 64) || !Number.isFinite(Date.parse(node.updatedAt)) || !record(node.head) || !exactKeys(node.head, ['versionId', 'number', 'contentHash'])
      || !text(node.head.versionId, 240) || node.head.number !== node.currentVersion || !isRevisionStackId(node.head.contentHash)) return false;
    if (!integer(node.lifecycleVersion) || !integer(node.authorVersion) || node.author !== null && !isRevisionAuthor(node.author) || node.originalAuthor !== null && !isRevisionAuthor(node.originalAuthor)) return false;
  }
  for (let index = 0; index < value.edges.length; index++) {
    const edge = value.edges[index], previous = value.edges[index - 1];
    if (!record(edge) || !exactKeys(edge, ['childId', 'parentId']) || !isRevisionId(edge.childId) || !isRevisionId(edge.parentId)
      || previous && (lexical(previous.childId, edge.childId) > 0 || previous.childId === edge.childId && lexical(previous.parentId, edge.parentId) >= 0)) return false;
  }
  try {
    const stack = value as unknown as RevisionStack, topology = revisionStackTopology(stack.revisionId, stack.nodes, stack.edges, stack.closeOnAccept);
    return topology.order.every((id, index) => stack.nodes[index]!.id === id) && JSON.stringify(topology.openParentIds) === JSON.stringify(stack.openParentIds)
      && new TextEncoder().encode(canonicalRevisionStack(stack)).byteLength <= REVISION_STACK_LIMITS.bytes;
  } catch { return false; }
}
