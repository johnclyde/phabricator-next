/** Personal presentation state. This is separate from shared discussion and evidence. */
export interface ThreadPreference {
  revisionId: string;
  threadId: string;
  collapsed: boolean;
  version: number;
  updatedAt: string | null;
}

export interface DiscussionPreferences {
  revisionId: string;
  preferences: ThreadPreference[];
  accessEpoch?: number;
}

export interface SetThreadPreferenceInput {
  collapsed: boolean;
  expectedVersion: number;
}
