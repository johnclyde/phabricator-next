import { isRevisionStatus } from '../shared/revision-status.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { canonicalRevisionStack, revisionStackTopology, REVISION_STACK_LIMITS, type RevisionStack, type RevisionStackNode, type RevisionStackEdge } from '../shared/revision-stack.ts';
import { HttpError } from './validation.ts';
import { RevisionLifecycleStore } from './revision-lifecycle.ts';
import { RevisionAuthorshipStore } from './revision-authorship.ts';

const invalid = () => new HttpError(409, 'The revision stack cannot be verified.', 'REVISION_STACK_INVALID');
const limited = () => new HttpError(422, 'This revision stack exceeds the supported read limit.', 'REVISION_STACK_LIMIT');
const unavailable = () => new HttpError(404, 'The revision stack is unavailable.', 'REVISION_STACK_UNAVAILABLE');
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && Boolean(value.trim()) && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
let savepoint = 0;

/** Metadata-only graph reads. Stored source identities are bound to the result;
 * manuscript bodies and package bytes are not loaded or reverified here. */
export class RevisionStackStore {
  constructor(private readonly database: DatabaseSync, private readonly closeOnAccept = false) {}

  read(id: string, visible: (id: string) => boolean, accessEpoch: number, expectedSnapshotId?: string): RevisionStack {
    if (!isRevisionId(id)) throw unavailable();
    if (!natural(accessEpoch) || expectedSnapshotId !== undefined && !digest(expectedSnapshotId)) throw new HttpError(400, 'Choose a valid stack snapshot and access epoch.');
    const name = `revision_stack_read_${++savepoint}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = this.snapshot(id, visible, accessEpoch);
      if (expectedSnapshotId !== undefined && expectedSnapshotId !== result.snapshotId) throw new HttpError(409, 'The revision stack changed. Reload it before continuing.', 'REVISION_STACK_CHANGED');
      this.database.exec(`RELEASE ${name}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }

  private node(id: string, root: boolean): RevisionStackNode {
    const row = this.database.prepare(`SELECT json_extract(data,'$.id') AS id,substr(json_extract(data,'$.title'),1,1001) AS title,
      json_extract(data,'$.kind') AS kind,json_extract(data,'$.status') AS status,
      json_extract(data,'$.currentVersion') AS currentVersion,json_extract(data,'$.updatedAt') AS updatedAt,
      (json_type(data,'$.id')='text' AND json_type(data,'$.title')='text'
      AND json_type(data,'$.kind')='text' AND json_type(data,'$.status')='text' AND json_type(data,'$.currentVersion') IN ('integer','real')
      AND json_type(data,'$.updatedAt')='text') AS validTypes FROM entities WHERE id=? AND kind='revision'`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw root ? unavailable() : invalid();
    if (row.validTypes !== 1 || row.id !== id || !text(row.title, 1000) || !['code', 'paper', 'document'].includes(String(row.kind))
      || !isRevisionStatus(row.status)
      || !natural(row.currentVersion) || row.currentVersion < 1 || !text(row.updatedAt, 64) || !Number.isFinite(Date.parse(row.updatedAt))) throw invalid();
    const version = this.database.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS storedId,
      json_extract(data,'$.revisionId') AS storedRevisionId,json_extract(data,'$.number') AS storedNumber,
      json_extract(data,'$.contentHash') AS contentHash,(json_type(data,'$.id')='text' AND json_type(data,'$.revisionId')='text'
      AND json_type(data,'$.number') IN ('integer','real') AND json_type(data,'$.contentHash')='text') AS validTypes
      FROM versions WHERE revision_id=? ORDER BY number DESC LIMIT 1`).get(id) as Record<string, unknown> | undefined;
    if (!version || version.validTypes !== 1 || !text(version.id, 240) || version.revision_id !== id || version.number !== row.currentVersion
      || version.storedId !== version.id || version.storedRevisionId !== id || version.storedNumber !== version.number || !digest(version.contentHash)) throw invalid();
    const initial = this.database.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS storedId,
      json_extract(data,'$.revisionId') AS storedRevisionId,json_extract(data,'$.number') AS storedNumber,
      (json_type(data,'$.id')='text' AND json_type(data,'$.revisionId')='text' AND json_type(data,'$.number') IN ('integer','real')) AS validTypes,
      json_type(data,'$.attribution') AS attributionType,
      json_type(data,'$.attribution.principalId') AS principalType,substr(json_extract(data,'$.attribution.principalId'),1,129) AS principalId,
      json_type(data,'$.attribution.displayName') AS displayType,substr(json_extract(data,'$.attribution.displayName'),1,241) AS displayName,
      json_type(data,'$.attribution.credentialId') AS credentialType,substr(json_extract(data,'$.attribution.credentialId'),1,241) AS credentialId,
      json_type(data,'$.attribution.requestId') AS requestType,substr(json_extract(data,'$.attribution.requestId'),1,241) AS requestId
      FROM versions WHERE revision_id=? AND number=1`).get(id) as Record<string, unknown> | undefined;
    if (!initial || initial.validTypes !== 1 || !text(initial.id, 240) || initial.revision_id !== id || initial.number !== 1
      || initial.storedId !== initial.id || initial.storedRevisionId !== id || initial.storedNumber !== 1) throw invalid();
    let author: RevisionStackNode['author'] = null;
    if (initial.attributionType !== null) {
      if (initial.attributionType !== 'object' || initial.principalType !== 'text' || typeof initial.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(initial.principalId)
        || initial.displayType !== 'text' || !text(initial.displayName, 240) || !(initial.credentialType === 'null' || initial.credentialType === 'text' && text(initial.credentialId, 240))
        || initial.requestType !== 'text' || !text(initial.requestId, 240)) throw invalid();
      author = { principalId: initial.principalId, displayName: initial.displayName };
    }
    const relationship = this.database.prepare('SELECT version FROM revision_dependency_versions WHERE revision_id=?').get(id) as { version: unknown } | undefined;
    if (relationship && !natural(relationship.version)) throw invalid();
    let authorship, lifecycle;
    try { authorship = new RevisionAuthorshipStore(this.database).state(id); lifecycle = new RevisionLifecycleStore(this.database).state(id); } catch { throw invalid(); }
    if (lifecycle.status !== row.status || authorship.originalAuthor?.principalId !== author?.principalId || authorship.originalAuthor?.displayName !== author?.displayName) throw invalid();
    return { id, title: row.title, kind: row.kind as RevisionStackNode['kind'], status: row.status as RevisionStackNode['status'], currentVersion: row.currentVersion, updatedAt: row.updatedAt,
      relationshipVersion: relationship ? relationship.version as number : 0,
      head: { versionId: version.id, number: row.currentVersion, contentHash: version.contentHash }, author: authorship.author, originalAuthor: author, authorVersion: authorship.version, lifecycleVersion: lifecycle.version };
  }

  private snapshot(id: string, visible: (id: string) => boolean, accessEpoch: number): RevisionStack {
    const allowed = new Map<string, boolean>();
    const canView = (candidate: string): boolean => {
      if (!isRevisionId(candidate)) throw invalid();
      if (allowed.has(candidate)) return allowed.get(candidate)!;
      if (allowed.size >= REVISION_STACK_LIMITS.candidates) throw limited();
      const result = visible(candidate); allowed.set(candidate, result); return result;
    };
    if (!canView(id)) throw unavailable();
    const pending = [id], queued = new Set([id]), nodes = new Map<string, RevisionStackNode>(), edges = new Map<string, RevisionStackEdge>();
    let scanned = 0;
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!; nodes.set(current, this.node(current, current === id));
      // Two indexed directional queries keep incident work bounded. Each active
      // visible edge is encountered twice, and hidden endpoints are never expanded.
      for (const direction of ['child_id', 'parent_id'] as const) {
        const rows = this.database.prepare(`SELECT child_id,parent_id FROM revision_dependency_edges WHERE ${direction}=? LIMIT ?`)
          .all(current, REVISION_STACK_LIMITS.scannedEdges - scanned + 1) as { child_id: string; parent_id: string }[];
        scanned += rows.length; if (scanned > REVISION_STACK_LIMITS.scannedEdges) throw limited();
        for (const row of rows) {
          if (!isRevisionId(row.child_id) || !isRevisionId(row.parent_id) || row.child_id === row.parent_id || row[direction] !== current) throw invalid();
          const peer = direction === 'child_id' ? row.parent_id : row.child_id;
          if (!canView(peer)) continue;
          if (!queued.has(peer)) {
            if (queued.size >= REVISION_STACK_LIMITS.nodes) throw limited();
            queued.add(peer); pending.push(peer);
          }
          const key = JSON.stringify([row.child_id, row.parent_id]);
          if (!edges.has(key)) {
            if (edges.size >= REVISION_STACK_LIMITS.edges) throw limited();
            edges.set(key, { childId: row.child_id, parentId: row.parent_id });
          }
        }
      }
    }
    const sortedEdges = [...edges.values()].sort((a, b) => compare(a.childId, b.childId) || compare(a.parentId, b.parentId));
    let topology: ReturnType<typeof revisionStackTopology>;
    try { topology = revisionStackTopology(id, [...nodes.values()], sortedEdges, this.closeOnAccept); } catch { throw invalid(); }
    const payload: Omit<RevisionStack, 'snapshotId'> = { format: 'phabricator.revision-stack.v3', revisionId: id, accessEpoch, closeOnAccept: this.closeOnAccept,
      nodes: topology.order.map(key => nodes.get(key)!), edges: sortedEdges, openParentIds: topology.openParentIds };
    const canonical = canonicalRevisionStack(payload);
    if (Buffer.byteLength(canonical, 'utf8') > REVISION_STACK_LIMITS.bytes) throw limited();
    return { ...payload, snapshotId: createHash('sha256').update(canonical, 'utf8').digest('hex') };
  }
}
