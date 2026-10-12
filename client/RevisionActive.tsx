import { useRef, useState, type ReactNode } from 'react';
import type { RevisionActiveResult } from '../shared/revision-active';
import type { Revision, RevisionKind } from '../shared/types';
import { useWorkspace } from './SessionGate';

export interface RevisionListMode { mode: 'views' | 'active'; query: string }
export function revisionListMode(value: unknown): RevisionListMode {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Partial<RevisionListMode>;
    if (Object.keys(value).length === 2 && (row.mode === 'views' || row.mode === 'active') && typeof row.query === 'string' && row.query.length <= 512 && !row.query.includes('\0') && !/[\uD800-\uDFFF]/u.test(row.query)) return { mode: row.mode, query: row.query };
  }
  return { mode: 'views', query: '' };
}
function useKindMode(kind: RevisionKind) {
  const client = useWorkspace(), key = `revision-list-mode:${kind}`;
  const [value, setValue] = useState(() => revisionListMode(client.readStored(key, null)));
  const latest = useRef(value); latest.current = value;
  const update = (patch: Partial<RevisionListMode>) => {
    try { client.assertActive(); } catch { return false; }
    const next = { ...latest.current, ...patch }, valid = revisionListMode(next);
    if (JSON.stringify(next) !== JSON.stringify(valid)) return false;
    latest.current = valid; setValue(valid); client.writeStored(key, valid); return true;
  };
  return { value, current: latest, update };
}
/** Presentation-only state never rewrites a saved filter or retained request. */
export function useRevisionListModes() {
  const code = useKindMode('code'), paper = useKindMode('paper'), document = useKindMode('document');
  const modes = { code, paper, document };
  return { modes, current: (kind: RevisionKind) => modes[kind].current.current, show: (kind: RevisionKind, mode: RevisionListMode['mode']) => modes[kind].update({ mode }), search: (kind: RevisionKind, query: string) => modes[kind].update({ query }) };
}

const empty: Record<string, string> = {
  'must-review': 'No revisions are blocked on your review.',
  'ready-to-review': 'No revisions are waiting on you to review them.',
  'ready-to-land': 'No revisions are ready to land.',
  'ready-to-update': 'No revisions are waiting for your updates.',
  drafts: 'You have no draft revisions.',
  'waiting-on-review': 'None of your revisions are waiting on review.',
  'waiting-on-authors': 'No revisions are waiting on author action.',
  'waiting-on-other-reviewers': 'No revisions are waiting for other reviewers.',
};
export default function RevisionActive({ result, online, loading, reload, renderRows }: { result: RevisionActiveResult; online: boolean; loading: boolean; reload: () => void; renderRows: (revisions: Revision[]) => ReactNode }) {
  const count = result.available ? result.groups.reduce((total, group) => total + group.revisions.length, 0) : null;
  return <section className="revision-active" aria-label="Active revisions">
    <div className="revision-active-heading"><div><h3>Active Revisions</h3><p>Your open authored work and direct review assignments, grouped by the next action.</p></div><button className="button" disabled={!online || loading} onClick={reload}>{loading ? 'Refreshing Active revisions…' : 'Refresh Active revisions'}</button></div>
    {!online && <p className="info-strip" role="status">Saved Active queue. Reconnect and refresh to verify current responsibilities.</p>}
    {!result.available ? <p className="info-strip" role="status">{result.reason} Reconnect and refresh Active revisions.</p> : <>
      {count === 0 && <p className="revision-active-empty" role="status">No active revisions match this queue and search.</p>}
      {result.groups.map(group => <details className="revision-active-group" data-active-group={group.key} key={group.key} open={group.revisions.length > 0}>
        <summary><span>{group.label}</span><span className="revision-active-count" aria-label={`${group.revisions.length} revisions`}>{group.revisions.length}</span></summary>
        {group.revisions.length ? renderRows(group.revisions) : <p className="revision-active-empty">{empty[group.key]}</p>}
      </details>)}
    </>}
  </section>;
}
