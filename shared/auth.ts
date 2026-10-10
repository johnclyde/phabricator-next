export type AuthMode = 'local' | 'password';
export type AuthScope = 'read' | 'write' | 'review:local' | 'review:hosted';
export interface PublicAccount { id: string; username: string; displayName: string; disabled: boolean }
export interface SessionState { mode: AuthMode; workspaceId: string; account: PublicAccount | null; sessionContext: string | null; csrfToken: string | null; expiresAt: string | null }
export interface AuthContext { workspaceId: string; principalId: string; displayName: string; credentialId: string | null; kind: 'local' | 'session' | 'token'; sessionContext: string | null; scopes: AuthScope[] }
export interface AuthToken { id: string; name: string; accountId: string; scopes: AuthScope[]; createdAt: string; expiresAt: string; revoked: boolean }
