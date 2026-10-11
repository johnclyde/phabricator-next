import type { RevisionMetadataHistory, RevisionMetadataSnapshot } from '../shared/revision-metadata.ts';
export const snapshot: RevisionMetadataSnapshot = {
  metadata: { revisionId: 'P1', version: 0, title: 'Exact manuscript', summary: 'Original summary\r\n', testPlan: 'Compare cited results with source material.\r\n', updatedAt: null },
  head: { versionId: 'source-1', number: 1, contentHash: 'a'.repeat(64) }, config: { requireTestPlan: true }, configId: 'b'.repeat(64), accessEpoch: 1,
  access: { policy: { objectId: 'P1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' },
};
export const history: RevisionMetadataHistory = { revisionId: 'P1', metadataVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 };
