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

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
        redirect: 'manual'
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response ${response.status} without a Location header for ${currentUrl}`);
        }
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (limit ${maxRedirects}) fetching ${url}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${currentUrl}`);
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
