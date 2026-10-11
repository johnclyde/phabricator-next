import { canonicalRevisionStack, isRevisionStack, type RevisionStack } from '../shared/revision-stack';

export const STACK_ROW_HEIGHT = 132;
export const STACK_LANE_WIDTH = 18;
export interface StackRow { id: string; lane: number; parents: string[]; children: string[] }
export interface StackTrace { childId: string; parentId: string; path: string; lane: number }
export interface StackLayout { rows: StackRow[]; traces: StackTrace[]; width: number; height: number; lanes: number }
export type StackVoiceAction = 'stack' | 'currentStackRevision' | 'nextStackRevision' | 'previousStackRevision';
export interface StackController { revisionId: string; readonly identity: string; execute: (action: StackVoiceAction) => { text: string; identity: string } }
export type RegisterStack = (controller: StackController | null) => void;

export function stackNarration(stack: RevisionStack, selected: string, summary = false): string {
  const node = stack.nodes.find(item => item.id === selected); if (!node) return 'No stack revision is selected.';
  const parents = stack.edges.filter(edge => edge.childId === selected).map(edge => edge.parentId), children = stack.edges.filter(edge => edge.parentId === selected).map(edge => edge.childId);
  const links = (ids: string[]) => ids.length ? `${ids.slice(0, 12).join(', ')}${ids.length > 12 ? `, and ${ids.length - 12} more visible revisions` : ''}` : 'none visible';
  const lead = summary ? `Stack for ${stack.revisionId}: ${stack.nodes.length} visible revisions and ${stack.openParentIds.length} open transitive parents. This count is advisory. ` : '';
  return `${lead}${node.id}: ${node.title.slice(0, 240)}. ${node.status.replaceAll('_', ' ')}. Current author: ${node.author?.displayName ?? 'not recorded'}. Direct parents: ${links(parents)}. Direct children: ${links(children)}.`;
}

/** Verify every saved or fetched graph before rendering labels, links, or traces. */
export async function verifiedRevisionStack(value: unknown, id: string): Promise<RevisionStack> {
  if (!isRevisionStack(value, id)) throw new Error('The revision stack is incomplete or invalid. Reload the stack.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRevisionStack(value)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== value.snapshotId) throw new Error('The revision stack does not match its snapshot. Reload the stack.');
  return value;
}

/** A remembered local workspace may reopen its last authorized snapshot offline only. */
export function stackAccessMatches(snapshotEpoch: number, currentEpoch: number, durable: boolean, online: boolean): boolean {
  return snapshotEpoch === currentEpoch || durable && !online && currentEpoch < 0;
}

/** Reserve lanes for pending parents. Multiple children share their parent's lane at a merge. */
export function revisionStackLayout(stack: RevisionStack): StackLayout {
  const parents = new Map(stack.nodes.map(node => [node.id, [] as string[]])), children = new Map(stack.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of stack.edges) { parents.get(edge.childId)!.push(edge.parentId); children.get(edge.parentId)!.push(edge.childId); }
  const pending = new Map<string, number>(), occupied = new Set<number>(), rows: StackRow[] = [];
  let lanes = 1;
  const free = () => { let lane = 0; while (occupied.has(lane)) lane++; return lane; };
  for (const node of stack.nodes) {
    const lane = pending.get(node.id) ?? free(); pending.delete(node.id); occupied.delete(lane);
    const row = { id: node.id, lane, parents: parents.get(node.id)!, children: children.get(node.id)! }; rows.push(row); lanes = Math.max(lanes, lane + 1);
    for (const parent of row.parents) if (!pending.has(parent)) { const next = free(); pending.set(parent, next); occupied.add(next); lanes = Math.max(lanes, next + 1); }
  }
  const positions = new Map(rows.map((row, index) => [row.id, { ...row, index }]));
  const traces = stack.edges.map(edge => {
    const from = positions.get(edge.childId)!, to = positions.get(edge.parentId)!, x = 12 + from.lane * STACK_LANE_WIDTH, endX = 12 + to.lane * STACK_LANE_WIDTH;
    const y = from.index * STACK_ROW_HEIGHT + STACK_ROW_HEIGHT / 2, endY = to.index * STACK_ROW_HEIGHT + STACK_ROW_HEIGHT / 2;
    return { ...edge, lane: to.lane, path: x === endX ? `M ${x} ${y} V ${endY}` : `M ${x} ${y} C ${x} ${y + 38}, ${endX} ${y + 28}, ${endX} ${y + 66} V ${endY}` };
  });
  return { rows, traces, lanes, width: Math.max(42, lanes * STACK_LANE_WIDTH + 12), height: rows.length * STACK_ROW_HEIGHT };
}
