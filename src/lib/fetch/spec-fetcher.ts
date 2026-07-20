import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, Pool, ProxyAgent, type Dispatcher } from 'undici';

const MAX_SPEC_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

export type SpecFetchErrorCode = 'blocked-ssrf' | 'private-network-unreachable' | 'fetch-failed';

export class SpecFetchError extends Error {
  public readonly code: SpecFetchErrorCode;

  public constructor(message: string, code: SpecFetchErrorCode, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SpecFetchError';
    this.code = code;
  }
}

export interface FetchSpecOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * Extra hostnames that redirects may target (lowercase). Default policy is
   * same-host only; callers that intentionally allow a short allowlist can
   * pass it here. Never used to relax IP/SSRF checks after DNS.
   */
  allowedRedirectHosts?: string[];
}

export interface FetchedSpec {
  content: string;
  contentType: string;
}

const NON_GLOBAL_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  NON_GLOBAL_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  NON_GLOBAL_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

/** Hostnames that must never be contacted (cloud metadata / IMDS aliases). */
const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local'
]);

type Connector = NonNullable<ConstructorParameters<typeof Pool>[1]>['connect'] extends infer T
  ? Extract<T, (...args: never[]) => unknown>
  : never;

interface RequestInitWithDispatcher extends RequestInit {
  dispatcher: Dispatcher;
}

function isNonGlobalAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const family = isIP(normalized);
  if (family === 4) return NON_GLOBAL_ADDRESSES.check(normalized, 'ipv4');
  if (family !== 6) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isNonGlobalAddress(mapped);
  return NON_GLOBAL_ADDRESSES.check(normalized, 'ipv6');
}

function safeUrl(parsed: URL): string {
  return `${parsed.origin}${parsed.pathname}`;
}

function normalizedHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
}

function assertSafeUrlTarget(parsed: URL, label: string): void {
  if (parsed.protocol !== 'https:') {
    throw new SpecFetchError(
      `Only HTTPS URLs are supported for remote spec fetch; got ${parsed.protocol}`,
      'blocked-ssrf'
    );
  }
  if (parsed.username || parsed.password) {
    throw new SpecFetchError(
      `URLs with embedded credentials (userinfo) are not allowed for remote spec fetch: ${safeUrl(parsed)}`,
      'blocked-ssrf'
    );
  }
  const hostname = normalizedHostname(parsed);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    BLOCKED_METADATA_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.internal') ||
    hostname === '169.254.169.254' ||
    hostname === '[169.254.169.254]'
  ) {
    throw new SpecFetchError(
      `Private or local addresses are not allowed for remote spec fetch (${label}): ${safeUrl(parsed)}`,
      'blocked-ssrf'
    );
  }
}

async function resolvePublicAddress(parsed: URL): Promise<string> {
  assertSafeUrlTarget(parsed, 'pre-dns');
  const hostname = normalizedHostname(parsed);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isNonGlobalAddress(address))) {
    throw new SpecFetchError(
      `Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`,
      'blocked-ssrf'
    );
  }
  return addresses.find(({ family }) => family === 4)?.address ?? addresses[0]!.address;
}

function shouldBypassProxy(parsed: URL): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const hostname = normalizedHostname(parsed);
  const port = parsed.port || '443';
  return noProxy.split(',').some((entry) => {
    const value = entry.trim().toLowerCase();
    if (!value) return false;
    if (value === '*') return true;
    const separator = value.lastIndexOf(':');
    const hasPort = separator > -1 && /^\d+$/.test(value.slice(separator + 1));
    const rulePort = hasPort ? value.slice(separator + 1) : undefined;
    const ruleHost = hasPort ? value.slice(0, separator) : value;
    if (rulePort && rulePort !== port) return false;
    if (ruleHost.startsWith('*.')) return hostname.endsWith(ruleHost.slice(1));
    if (ruleHost.startsWith('.')) return hostname.endsWith(ruleHost);
    return hostname === ruleHost;
  });
}

function createDispatcher(parsed: URL, address: string): Dispatcher {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy || shouldBypassProxy(parsed)) {
    const family = isIP(address) as 4 | 6;
    const hostname = normalizedHostname(parsed);
    return new Agent({
      connect: {
        ...(isIP(hostname) ? {} : { servername: hostname }),
        lookup(_hostname, options, callback) {
          // Pin the pre-validated address for this hop to resist DNS rebinding.
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }
      }
    });
  }

  const hostname = normalizedHostname(parsed);
  return new ProxyAgent({
    uri: proxy,
    requestTls: isIP(hostname) ? {} : { servername: hostname },
    factory(origin, options) {
      const { connect } = options as { connect: Connector };
      return new Pool(origin, {
        ...options,
        connect(connectOptions, callback) {
          connect({ ...connectOptions, host: address, hostname: address }, callback);
        }
      });
    }
  });
}

function assertAllowedRedirectHost(from: URL, to: URL, allowedRedirectHosts: Set<string>): void {
  const fromHost = normalizedHostname(from);
  const toHost = normalizedHostname(to);
  if (toHost === fromHost) return;
  if (allowedRedirectHosts.has(toHost)) return;
  throw new SpecFetchError(
    `Cross-host redirects are not allowed for remote spec fetch (${fromHost} -> ${toHost})`,
    'blocked-ssrf'
  );
}

function isPrivateNetworkTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`.toLowerCase();
  return (
    /econnrefused|etimedout|enotfound|ehostunreach|enetunreach|socket hang up|network is unreachable|connect econnrefused/i.test(
      message
    )
  );
}

/**
 * Fetch a spec from a remote URL with strict guards:
 *  - HTTPS only, for the initial URL and every redirect hop;
 *  - no userinfo;
 *  - loopback / link-local / private / multicast / unspecified / metadata blocked before and after DNS;
 *  - DNS lookup pinned per hop to resist rebinding;
 *  - same-host redirects only (or an explicit allowlist);
 *  - at most 5 redirects, 15 s default timeout, 10 MiB body cap;
 *  - never forwards Authorization / Cookie / Azure / GitHub credentials.
 */
export async function fetchSpecFromUrl(url: string, options: FetchSpecOptions = {}): Promise<FetchedSpec> {
  const maxBytes = options.maxBytes ?? MAX_SPEC_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const allowedRedirectHosts = new Set((options.allowedRedirectHosts ?? []).map((host) => host.toLowerCase()));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; ; hop += 1) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        throw new SpecFetchError(`Invalid URL for remote spec fetch: ${url}`, 'blocked-ssrf', { cause: error });
      }
      assertSafeUrlTarget(parsed, 'request');
      const address = await resolvePublicAddress(parsed);
      // Re-check the pinned address immediately before connect (rebinding defense).
      if (isNonGlobalAddress(address)) {
        throw new SpecFetchError(
          `Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`,
          'blocked-ssrf'
        );
      }
      const dispatcher = createDispatcher(parsed, address);
      try {
        const init: RequestInitWithDispatcher = {
          signal: controller.signal,
          // Intentionally minimal — never Authorization, Cookie, or cloud tokens.
          headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
          redirect: 'manual',
          dispatcher
        };
        let response: Response;
        try {
          response = await fetch(currentUrl, init);
        } catch (error) {
          if (error instanceof SpecFetchError) throw error;
          if (controller.signal.aborted) {
            throw new SpecFetchError(`Timed out fetching ${safeUrl(parsed)}`, 'fetch-failed', { cause: error });
          }
          if (isPrivateNetworkTransportFailure(error)) {
            throw new SpecFetchError(
              `Private network unreachable while fetching ${safeUrl(parsed)}`,
              'private-network-unreachable',
              { cause: error }
            );
          }
          throw new SpecFetchError(`Failed fetching ${safeUrl(parsed)}`, 'fetch-failed', { cause: error });
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new SpecFetchError(
              `Redirect response ${response.status} without a Location header for ${safeUrl(parsed)}`,
              'fetch-failed'
            );
          }
          if (hop >= maxRedirects) {
            throw new SpecFetchError(
              `Too many redirects (limit ${maxRedirects}) fetching ${safeUrl(new URL(url))}`,
              'fetch-failed'
            );
          }
          const next = new URL(location, currentUrl);
          // HTTPS/userinfo checks before host policy so insecure redirects fail closed
          // with the protocol error (even when they would also be cross-host).
          assertSafeUrlTarget(next, 'redirect');
          assertAllowedRedirectHost(parsed, next, allowedRedirectHosts);
          currentUrl = next.toString();
          continue;
        }

        if (!response.ok) {
          throw new SpecFetchError(`HTTP ${response.status} fetching ${safeUrl(parsed)}`, 'fetch-failed');
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
          throw new SpecFetchError(
            `Response too large (${contentLength} bytes); limit is ${maxBytes}`,
            'fetch-failed'
          );
        }

        const chunks: Uint8Array[] = [];
        let received = 0;
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
              await reader.cancel();
              throw new SpecFetchError(
                `Response body too large (over ${maxBytes} bytes); limit is ${maxBytes}`,
                'fetch-failed'
              );
            }
            chunks.push(value);
          }
        }
        const buffer = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const content = new TextDecoder().decode(buffer);
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        return { content, contentType };
      } finally {
        await dispatcher.close();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
