const MAX_SPEC_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

export interface FetchSpecOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface FetchedSpec {
  content: string;
  contentType: string;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice('::ffff:'.length));
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  );
}

function safeUrl(parsed: URL): string {
  return `${parsed.origin}${parsed.pathname}`;
}

async function assertPublicAddress(parsed: URL): Promise<void> {
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`);
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`);
  }
}

/**
 * Fetch a spec from a remote URL with strict guards:
 *  - HTTPS only, for the initial URL and every redirect hop;
 *  - at most 5 redirects;
 *  - 15 s default timeout;
 *  - Content-Length and received bytes both capped at 10 MiB.
 */
export async function fetchSpecFromUrl(url: string, options: FetchSpecOptions = {}): Promise<FetchedSpec> {
  const maxBytes = options.maxBytes ?? MAX_SPEC_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; ; hop += 1) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== 'https:') {
        throw new Error(`Only HTTPS URLs are supported for remote spec fetch; got ${parsed.protocol}`);
      }
      await assertPublicAddress(parsed);

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
        redirect: 'manual'
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response ${response.status} without a Location header for ${safeUrl(parsed)}`);
        }
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (limit ${maxRedirects}) fetching ${safeUrl(new URL(url))}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${safeUrl(parsed)}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
        throw new Error(`Response too large (${contentLength} bytes); limit is ${maxBytes}`);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Response body too large (${buffer.byteLength} bytes); limit is ${maxBytes}`);
      }

      const content = new TextDecoder().decode(buffer);
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      return { content, contentType };
    }
  } finally {
    clearTimeout(timer);
  }
}
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
