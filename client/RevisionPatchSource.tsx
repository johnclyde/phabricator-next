import type { RevisionDetail, RevisionVersion } from '../shared/types';
import { revisionPatchBaseline, type RevisionPatchIdentity } from '../shared/revision-patch';
import { useAutomationRead } from './AutomationSupport';

export function revisionPatchUnavailable(detail: RevisionDetail, version: RevisionVersion): string | null { return revisionPatchBaseline(detail.revision.repositoryId, detail.versions, version.id).reason; }
export function RevisionPatchProperties({ patch }: { patch: RevisionPatchIdentity }) {
  return <dl className="automation-properties"><dt>Revision patch</dt><dd><a href={`#${patch.revisionId}`}>{patch.revisionId}</a> · Version {patch.versionNumber}</dd><dt>Source hash</dt><dd><code>{patch.contentHash}</code></dd><dt>Base commit</dt><dd><code>{patch.baseCommitId}</code></dd><dt>Base tree</dt><dd><code>{patch.baseTreeId}</code></dd><dt>Patched result tree</dt><dd><code>{patch.targetTreeId}</code></dd><dt>Patch SHA-256</dt><dd><code>{patch.patchSha256}</code></dd></dl>;
}
export default function RevisionPatchSource({ detail, version, online }: { detail: RevisionDetail; version: RevisionVersion; online: boolean }) {
  const { baseline, reason } = revisionPatchBaseline(detail.revision.repositoryId, detail.versions, version.id);
  const patch = useAutomationRead<{ revisionPatch: RevisionPatchIdentity; repositoryId: string; accessEpoch: number }>(reason ? null : `/api/drydock/revision-patches/${encodeURIComponent(detail.revision.id)}?versionId=${encodeURIComponent(version.id)}&contentHash=${version.contentHash}`, online);
  return <section className="automation-detail" aria-label="Revision patch source"><p className="small muted">The worker applies the selected immutable revision to its verified Git base. Saving a later version never changes this build.</p>{reason ? <p className="info-strip">{reason}</p> : patch.data ? <><p className="small muted">Imported baseline: version {baseline!.number}.</p><RevisionPatchProperties patch={patch.data.revisionPatch}/></> : <p className="small muted">{!online ? 'Reconnect to verify this revision patch.' : patch.loading ? 'Verifying exact revision patch…' : 'Exact revision patch is unavailable.'}</p>}{patch.error && <p className="banner warning">{patch.error}</p>}</section>;
}
