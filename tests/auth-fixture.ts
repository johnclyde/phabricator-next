// Public fixtures for disposable test databases only; never used by npm start.
export const authAccounts = [
  { username: 'alice', displayName: 'Alice Researcher', password: 'test-only-alice-password-2026' },
  { username: 'bob', displayName: 'Bob Editor', password: 'test-only-bob-password-2026' },
] as const;
