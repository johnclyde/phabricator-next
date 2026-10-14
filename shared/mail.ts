export interface MailPreference {
  principalId: string; version: number; enabled: boolean; available: boolean;
  address: string | null; accessEpoch: number;
  counts: { pending: number; sent: number; failed: number; uncertain: number };
}
export interface MailPreferenceInput { expectedVersion: number; enabled: boolean }
export function mailPreferenceInput(value: unknown): MailPreferenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose email preferences.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'enabled,expectedVersion' || typeof input.enabled !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) throw new Error('Provide the inspected email preference version.');
  return { enabled: input.enabled, expectedVersion: Number(input.expectedVersion) };
}
