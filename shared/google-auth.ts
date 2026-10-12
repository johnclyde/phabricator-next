/** Public Firebase web configuration. This never contains workspace account mappings. */
export interface GoogleAuthPublicConfig {
  readonly projectId: string;
  readonly apiKey: string;
  readonly authDomain: string;
  readonly appId: string;
}
export interface AuthProviders { google: GoogleAuthPublicConfig | null }
