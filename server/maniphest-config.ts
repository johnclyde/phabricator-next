/** Hosted task administrators are designated by the operator, never self-appointed. */
export function maniphestAdministratorsFromEnvironment(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.APP_MANIPHEST_ADMIN_PRINCIPAL_IDS;
  if (!raw?.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('APP_MANIPHEST_ADMIN_PRINCIPAL_IDS must be a JSON array of account IDs.'); }
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 160 || /\s/.test(id))) throw new Error('APP_MANIPHEST_ADMIN_PRINCIPAL_IDS must be a JSON array of account IDs.');
  return [...new Set(value as string[])];
}
