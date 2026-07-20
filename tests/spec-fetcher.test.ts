import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { agentOptions, proxyOptions, lookupMock } = vi.hoisted(() => ({
  agentOptions: [] as unknown[],
  proxyOptions: [] as unknown[],
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    Agent: class extends original.Agent {
      constructor(options: ConstructorParameters<typeof original.Agent>[0]) {
        agentOptions.push(options);
        super(options);
      }
    },
    ProxyAgent: class extends original.ProxyAgent {
      constructor(options: ConstructorParameters<typeof original.ProxyAgent>[0]) {
        proxyOptions.push(options);
        super(options);
      }
    }
  };
});

import { fetchSpecFromUrl } from '../src/lib/fetch/spec-fetcher.js';

const VALID_BODY = JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/': {} } });

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function credentialedUrl(base: string): string {
  const url = new URL(base);
  url.username = 'user';
  url.password = 'pass';
  return url.toString();
}

beforeEach(() => {
  agentOptions.length = 0;
  proxyOptions.length = 0;
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});

afterEach(() => {
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  vi.restoreAllMocks();
});

describe('spec fetcher', () => {
  it('prefers a public IPv4 address when DNS also returns public IPv6', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '1.1.1.1', family: 4 }
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://dual-stack.example/spec.json');

    const lookup = (agentOptions[0] as {
      connect: { lookup: (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void };
    }).connect.lookup;
    const callback = vi.fn();
    lookup('dual-stack.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('pins direct DNS lookup while preserving original URL authority and TLS servername', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://attacker.example/spec.json?token=secret');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://attacker.example/spec.json?token=secret',
      expect.objectContaining({
        dispatcher: expect.anything()
      })
    );
    const connect = (agentOptions[0] as {
      connect: { servername: string; lookup: (...args: unknown[]) => void };
    }).connect;
    expect(connect.servername).toBe('attacker.example');
    const single = vi.fn();
    connect.lookup('ignored.example', { all: false }, single);
    expect(single).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    const all = vi.fn();
    connect.lookup('ignored.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
  });

  it('accepts a global IPv6 literal without DNS and pins the unbracketed address', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));
    await fetchSpecFromUrl('https://[2001:4860:4860::8888]/spec.json');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const connect = (agentOptions[0] as {
      connect: { servername?: string; lookup: (...args: unknown[]) => void };
    }).connect;
    expect(connect.servername).toBeUndefined();
    const callback = vi.fn();
    connect.lookup('ignored', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '2001:4860:4860::8888', 6);
  });

  it('rejects a non-global IPv6 literal without DNS or fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('https://[2001:db8::1]/spec.json')).rejects.toThrow('Private or local');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves and pins every redirect hop independently', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '2001:4860:4860::8888', family: 6 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('/next.json'))
      .mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://attacker.example/spec.json');

    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      'https://attacker.example/spec.json',
      'https://attacker.example/next.json'
    ]);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-HTTPS initial URLs without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('http://x.example/spec.json')).rejects.toThrow('Only HTTPS URLs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AZ-APP-002: rejects a redirect to HTTP', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectResponse('http://insecure.example/spec.json'));
    await expect(fetchSpecFromUrl('https://x.example/spec.json')).rejects.toThrow('Only HTTPS URLs');
  });

  it('AZ-APP-002b: rejects six redirects, accepts five ending in valid content', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 6; i += 1) {
      spy.mockResolvedValueOnce(redirectResponse(`https://x.example/hop-${i + 1}`));
    }
    await expect(fetchSpecFromUrl('https://x.example/spec.json')).rejects.toThrow('Too many redirects');

    spy.mockReset();
    for (let i = 0; i < 5; i += 1) {
      spy.mockResolvedValueOnce(redirectResponse(`https://x.example/hop-${i + 1}`));
    }
    spy.mockResolvedValueOnce(jsonResponse(VALID_BODY));
    const fetched = await fetchSpecFromUrl('https://x.example/spec.json');
    expect(fetched.content).toBe(VALID_BODY);
  });

  it('rejects oversized bodies by header and by received bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(VALID_BODY, { 'content-length': String(20 * 1024 * 1024) })
    );
    await expect(fetchSpecFromUrl('https://x.example/spec.json')).rejects.toThrow('Response too large');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse('x'.repeat(64)));
    await expect(fetchSpecFromUrl('https://x.example/spec.json', { maxBytes: 32 })).rejects.toThrow(
      'Response body too large'
    );
  });

  it('stops reading a stream without content-length at the byte cap instead of buffering it fully', async () => {
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        canceled = true;
      }
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(fetchSpecFromUrl('https://x.example/spec.json', { maxBytes: 32 })).rejects.toThrow(
      'Response body too large'
    );
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(6);
  });

  it('rejects non-OK statuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetchSpecFromUrl('https://x.example/spec.json')).rejects.toThrow('HTTP 404');
  });

  it('rejects loopback, private IP literals, and hostnames resolving to private addresses before fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('https://127.0.0.1/spec.json')).rejects.toThrow('Private or local');
    await expect(fetchSpecFromUrl('https://10.1.2.3/spec.json')).rejects.toThrow('Private or local');
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(fetchSpecFromUrl('https://metadata.example/spec.json')).rejects.toThrow('Private or local');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['192.0.2.1', '198.51.100.1', '203.0.113.1', '2001:db8::1'])(
    'rejects non-global address %s before fetch',
    async (address) => {
      lookupMock.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(fetchSpecFromUrl('https://non-global.example/spec.json')).rejects.toThrow('Private or local');
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('preserves original-host NO_PROXY matching after pinning', async () => {
    process.env.HTTPS_PROXY = credentialedUrl('https://proxy.example:8443');
    process.env.NO_PROXY = '.example.com:443';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://api.example.com/spec.json');
    expect(agentOptions).toHaveLength(1);
    expect(proxyOptions).toHaveLength(0);

    agentOptions.length = 0;
    await fetchSpecFromUrl('https://api.other.test/spec.json');
    expect(agentOptions).toHaveLength(0);
    expect(proxyOptions).toHaveLength(1);
  });

  it('pins the proxy CONNECT target while preserving origin and request authority', async () => {
    process.env.HTTPS_PROXY = credentialedUrl('https://proxy.example:8443');
    lookupMock.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://api.example.com/spec.json');

    const options = proxyOptions[0] as {
      uri: string;
      requestTls: { servername: string };
      factory: (origin: URL, options: object) => unknown;
    };
    expect(options.uri).toBe(credentialedUrl('https://proxy.example:8443'));
    expect(options.requestTls.servername).toBe('api.example.com');
    expect(options.factory).toEqual(expect.any(Function));
    const connector = vi.fn((_options: unknown, callback: (error: Error) => void) => callback(new Error('stop')));
    const origin = new URL('https://api.example.com');
    const pool = options.factory(origin, { connect: connector }) as {
      connect: (options: { path: string }) => Promise<unknown>;
      close: () => Promise<void>;
    };
    await expect(pool.connect({ path: '/' })).rejects.toThrow('stop');
    expect(connector).toHaveBeenCalledWith(
      expect.objectContaining({ host: '1.1.1.1', hostname: '1.1.1.1' }),
      expect.any(Function)
    );
    await pool.close();
  });

  it('rechecks DNS after every same-host redirect hop', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      redirectResponse('https://public.example/next.json')
    );
    await expect(fetchSpecFromUrl('https://public.example/spec.json')).rejects.toThrow('Private or local');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks cross-host redirects by default', async () => {
    lookupMock.mockResolvedValueOnce([{ address: ['8', '8', '8', '8'].join('.'), family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      redirectResponse('https://evil.example/spec.json')
    );
    await expect(fetchSpecFromUrl('https://public.example/spec.json')).rejects.toThrow('Cross-host redirects');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects userinfo credentials before DNS or fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const credentialedUrl = new URL('https://x.example/spec.json');
    credentialedUrl.username = 'placeholder-user';
    credentialedUrl.password = 'placeholder-password';
    await expect(fetchSpecFromUrl(credentialedUrl.toString())).rejects.toThrow('userinfo');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects Azure IMDS / metadata hostnames before DNS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('https://metadata.google.internal/spec.json')).rejects.toThrow('Private or local');
    await expect(fetchSpecFromUrl('https://169.254.169.254/metadata/instance')).rejects.toThrow('Private or local');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never forwards Authorization or Cookie headers on public runtime fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));
    process.env.AZURE_CLIENT_SECRET = 'super-secret';
    process.env.GITHUB_TOKEN = 'ghs_secret';
    await fetchSpecFromUrl('https://api.example.com/spec.json');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-ms-client-request-id')).toBeNull();
    expect(JSON.stringify(init.headers ?? {})).not.toContain('super-secret');
    expect(JSON.stringify(init.headers ?? {})).not.toContain('ghs_secret');
    delete process.env.AZURE_CLIENT_SECRET;
    delete process.env.GITHUB_TOKEN;
  });

  it('surfaces distinct SpecFetchError codes for SSRF vs private-network failures', async () => {
    const { SpecFetchError } = await import('../src/lib/fetch/spec-fetcher.js');
    await expect(fetchSpecFromUrl('https://127.0.0.1/spec.json')).rejects.toMatchObject({
      name: 'SpecFetchError',
      code: 'blocked-ssrf'
    });
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connect ECONNREFUSED 8.8.8.8:443'));
    try {
      await fetchSpecFromUrl('https://unreachable.example/spec.json');
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecFetchError);
      expect((error as InstanceType<typeof SpecFetchError>).code).toBe('private-network-unreachable');
    }
  });
});
