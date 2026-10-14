import type { SuiteApp } from './suite';
export type SuiteFollowing = 'default' | 'following' | 'ignored';
export interface SuiteNotificationPreference {
  objectId: string; app: SuiteApp; principalId: string; version: number;
  following: SuiteFollowing; muted: boolean; email: boolean; effectiveFollowing: boolean; accessEpoch: number;
}
export interface SuiteNotificationPreferenceInput {
  expectedPreferenceVersion: number; expectedAccessEpoch: number;
  following: SuiteFollowing; muted: boolean; email: boolean;
}
export function suiteNotificationPreferenceInput(value: unknown): SuiteNotificationPreferenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose your notification preferences.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'email,expectedAccessEpoch,expectedPreferenceVersion,following,muted'
    || !Number.isSafeInteger(data.expectedPreferenceVersion) || Number(data.expectedPreferenceVersion) < 0
    || !Number.isSafeInteger(data.expectedAccessEpoch) || Number(data.expectedAccessEpoch) < 0
    || !['default', 'following', 'ignored'].includes(String(data.following)) || typeof data.muted !== 'boolean' || typeof data.email !== 'boolean') throw new Error('Provide the inspected preferences and access version.');
  return { expectedPreferenceVersion: Number(data.expectedPreferenceVersion), expectedAccessEpoch: Number(data.expectedAccessEpoch), following: data.following as SuiteFollowing, muted: data.muted, email: data.email };
}
