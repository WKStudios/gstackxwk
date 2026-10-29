/**
 * The agent fetches URLs that can come from untrusted content (an email, a web
 * page). Keep those requests on the public internet: no localhost, private
 * ranges or cloud metadata endpoints.
 */

import { ToolError } from './tools/types';

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === 'metadata.google.internal' || host === 'metadata') return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some(re => re.test(host));
  if (host.includes(':')) {
    // IPv6 literal: block loopback, link-local, unique-local and v4-mapped private.
    if (host === '::1' || host === '::' || /^fe80:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return false;
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !PRIVATE_V4.some(re => re.test(mapped[1]));
  }
  return true;
}

export function assertPublicUrl(raw: string): void {
  if (!isPublicUrl(raw)) throw new ToolError(`Refusing to open ${raw}: only public http(s) addresses are allowed.`);
}
