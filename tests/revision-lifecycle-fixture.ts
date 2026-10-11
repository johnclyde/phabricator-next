import type { Store } from '../server/store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionLifecycleAction, RevisionLifecycleInput } from '../shared/revision-lifecycle.ts';

/** Deliberate lifecycle actions for fixtures, preserving the same pins as HTTP. */
export function lifecycleInput(store: Store, id: string, action: RevisionLifecycleAction, message = ''): RevisionLifecycleInput {
  const snapshot = store.revisionLifecycle.snapshot(id);
  return { action, message, expectedLifecycleVersion: snapshot.lifecycle.version, expectedReviewerVersion: snapshot.reviewers.version, expectedAuthorVersion: snapshot.authorship.version,
    expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash,
    expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number,
    expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 };
}
export function lifecycleAction(store: Store, id: string, action: RevisionLifecycleAction, actor?: ActorAttribution, message = '') {
  const author = store.revisionAuthorship.state(id).author;
  const attribution = actor ?? { principalId: author?.principalId ?? 'lifecycle-fixture-editor', displayName: author?.displayName ?? 'Fixture editor', credentialId: null, requestId: 'lifecycle-fixture-action' };
  return store.revisionLifecycle.mutate(id, lifecycleInput(store, id, action, message), attribution);
}
export function closeRevision(store: Store, id: string, actor?: ActorAttribution): void {
  const detail = store.detail(id);
  if (detail.revision.status !== 'accepted') {
    store.saveReview(id, detail.revision.currentVersion, { provider: 'local', model: 'fixture', summary: 'Explicit fixture evidence before closure.', findings: [] }, actor);
    lifecycleAction(store, id, 'accept_reviewed', actor);
  }
  lifecycleAction(store, id, 'close', actor);
}
