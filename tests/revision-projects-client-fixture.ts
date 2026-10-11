import type { RevisionProjectSnapshot, RevisionProjectHistory } from '../shared/revision-projects.ts';
import { access } from './revision-subscriptions-client-fixture.ts';
export const snapshot: RevisionProjectSnapshot = { tags: { revisionId: 'P1', version: 0, projectIds: ['PROJ1'], updatedAt: null }, access: access(), accessEpoch: 1 };
export const history: RevisionProjectHistory = { revisionId: 'P1', projectVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 };
