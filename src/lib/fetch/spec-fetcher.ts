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

async function resolvePublicAddress(parsed: URL): Promise<string> {
  const hostname = normalizedHostname(parsed);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`);
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isNonGlobalAddress(address))) {
    throw new Error(`Private or local addresses are not allowed for remote spec fetch: ${safeUrl(parsed)}`);
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
      const address = await resolvePublicAddress(parsed);
      const dispatcher = createDispatcher(parsed, address);
      try {
        const init: RequestInitWithDispatcher = {
          signal: controller.signal,
          headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
          redirect: 'manual',
          dispatcher
        };
        const response = await fetch(currentUrl, init);

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
              throw new Error(`Response body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
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
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, Pool, ProxyAgent, type Dispatcher } from 'undici';

type Connector = NonNullable<ConstructorParameters<typeof Pool>[1]>['connect'] extends infer T
  ? Extract<T, (...args: never[]) => unknown>
  : never;

interface RequestInitWithDispatcher extends RequestInit {
  dispatcher: Dispatcher;
}
