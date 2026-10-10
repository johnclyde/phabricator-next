/** A canonical application mount, shared by the browser, server, CLI and build. */
export function normalizeBasePath(input = '/'): string {
  if (input === '/') return '/';
  if (input.length > 500 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(input)) {
    throw new Error('APP_BASE_PATH must be / or a slash-separated path of letters, numbers, underscores and hyphens.');
  }
  return input.endsWith('/') ? input : `${input}/`;
}

/** Map an internal root-relative route into a configured mount without URL resolution. */
export function mountPath(path: string, basePath = '/'): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Application routes must start with a single slash.');
  }
  return `${normalizeBasePath(basePath)}${path.slice(1)}`;
}
