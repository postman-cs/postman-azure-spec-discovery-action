import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResourceGraphSdkClient } from '../src/lib/azure/clients.js';
import { buildCandidateQuery } from '../src/lib/resolve/resource-graph-query.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function credentialStub() {
  return { getToken: vi.fn(async () => ({ token: 'arm-token', expiresOnTimestamp: Date.now() + 3600_000 })) };
}

describe('resource graph paging (direct ARM REST)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AZ-GRAPH-001: two pages use the same KQL, forward only the first skipToken, and stop', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: '/a', name: 'a', type: 't', resourceGroup: 'rg', tags: {} }], $skipToken: 'page-2' })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: '/b', name: 'b', type: 't', resourceGroup: 'rg', tags: {} }] }));

    const credential = credentialStub();
    const client = new ResourceGraphSdkClient(credential);
    const kql = buildCandidateQuery();
    const rows = await client.queryResources('sub-1', kql);

    expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
    expect(credential.getToken).toHaveBeenCalledWith('https://management.azure.com/.default');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toContain('providers/Microsoft.ResourceGraph/resources?api-version=');
    expect(firstInit.method).toBe('POST');
    expect(String((firstInit.headers as Record<string, string>).authorization)).toBe('Bearer arm-token');
    const firstBody = JSON.parse(String(firstInit.body)) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ query: kql, subscriptions: ['sub-1'] });
    expect(firstBody.options).toBeUndefined();

    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(secondBody).toMatchObject({ query: kql, options: { $skipToken: 'page-2' } });
  });

  it('AZ-GRAPH-001: a repeated skip token fails instead of returning partial discovery', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [], $skipToken: 'repeat' }))
      .mockResolvedValueOnce(jsonResponse({ data: [], $skipToken: 'repeat' }));
    const client = new ResourceGraphSdkClient(credentialStub());
    await expect(client.queryResources('sub-1', buildCandidateQuery())).rejects.toThrow('repeated skip token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AZ-CLIENT-004: Resource Graph retries transient failures within maxAttempts and never retries 400', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const transientClient = new ResourceGraphSdkClient(credentialStub(), { requestTimeoutMs: 30000, maxAttempts: 2 });
    await expect(transientClient.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    const validationClient = new ResourceGraphSdkClient(credentialStub(), { requestTimeoutMs: 30000, maxAttempts: 3 });
    await expect(validationClient.queryResources('sub-1', buildCandidateQuery())).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AZ-GRAPH-002: native AbortSignal reaches fetch so Node undici accepts the request', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ data: [] });
    });
    const client = new ResourceGraphSdkClient(credentialStub());
    await expect(client.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
  });
});
