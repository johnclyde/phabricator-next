import type { IncomingMessage } from 'node:http';
import type { AuthMode } from '../shared/auth.ts';
import { HttpError } from './validation.ts';

export interface HostedOrigin { readonly origin: string; readonly host: string }

/** Require the serialized origin itself; never silently normalize operator input. */
export function hostingConfiguration(publicOrigin: string | undefined, authMode: AuthMode): HostedOrigin | undefined {
  if (publicOrigin === undefined) return undefined;
  let url: URL;
  try { url = new URL(publicOrigin); } catch { throw new Error('APP_PUBLIC_ORIGIN must be a canonical HTTPS origin without a trailing slash, path, credentials, query, or fragment.'); }
  if (typeof publicOrigin !== 'string' || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(publicOrigin) || url.protocol !== 'https:' || publicOrigin !== url.origin) {
    throw new Error('APP_PUBLIC_ORIGIN must be a canonical HTTPS origin without a trailing slash, path, credentials, query, or fragment.');
  }
  if (authMode !== 'password') throw new Error('APP_PUBLIC_ORIGIN requires APP_AUTH_MODE=password.');
  return Object.freeze({ origin: url.origin, host: url.host });
}

/** The only supported TLS boundary is a proxy on the same host. Forwarding headers confer no authority. */
export function assertHostingRequest(req: IncomingMessage, configuredPort: number, hosting?: HostedOrigin, basePath = '/'): void {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) throw new HttpError(403, 'Only loopback clients are allowed.');
  const origin = req.headers.origin;
  if (hosting) {
    let hosts = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) if (req.rawHeaders[index]!.toLowerCase() === 'host') hosts++;
    if (hosts !== 1 || req.headers.host !== hosting.host) throw new HttpError(403, 'This host is not allowed.');
    if (origin !== undefined && origin !== hosting.origin) throw new HttpError(403, 'This origin is not allowed.');
  } else {
    const ports = new Set([configuredPort, req.socket.localPort ?? configuredPort, 5173]);
    const allowedHosts = [...ports].flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!req.headers.host || !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Only loopback hosts are allowed.');
    if (origin !== undefined && !allowedHosts.some(host => origin === `http://${host}`)) throw new HttpError(403, 'This origin is not allowed.');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' && !origin) {
    const pathname = (req.url ?? '/').split('?')[0];
    const entry = pathname === basePath || pathname === `${basePath}index.html` || basePath !== '/' && pathname === basePath.slice(0, -1);
    // The entry serves only the public static shell, never workspace data.
    // Link openers and previews may omit navigation metadata. API requests
    // retain this gate, and frame/CORS restrictions remain on the response.
    const publicEntry = hosting && entry && (req.method === 'GET' || req.method === 'HEAD');
    if (!publicEntry) throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
}
