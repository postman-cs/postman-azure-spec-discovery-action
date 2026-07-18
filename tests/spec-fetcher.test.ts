import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { fetchSpecFromUrl } from '../src/lib/fetch/spec-fetcher.js';

const VALID_BODY = JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/': {} } });

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spec fetcher', () => {
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

  it('rechecks DNS after every redirect hop', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      redirectResponse('https://internal.example/spec.json')
    );
    await expect(fetchSpecFromUrl('https://public.example/spec.json')).rejects.toThrow('Private or local');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
