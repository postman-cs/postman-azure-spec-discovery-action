import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResourceGraphSdkClient } from '../src/lib/azure/clients.js';
import { buildCandidateQuery, buildRepoTagLookupQuery } from '../src/lib/resolve/resource-graph-query.js';

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
    vi.unstubAllEnvs();
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
    const transientClient = new ResourceGraphSdkClient(credentialStub(), {
      requestTimeoutMs: 30000,
      maxAttempts: 2,
      sleep: async () => undefined
    });
    await expect(transientClient.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    const validationClient = new ResourceGraphSdkClient(credentialStub(), {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    await expect(validationClient.queryResources('sub-1', buildCandidateQuery())).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AZ-CLOUD-020: US Government profile uses gov ARM host and scope with unchanged query/subscriptions paging', async () => {
    vi.stubEnv('AZURE_ENVIRONMENT', 'AzureUSGovernment');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: '/a', name: 'a', type: 't', resourceGroup: 'rg', tags: {} }], $skipToken: 'page-2' })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: '/b', name: 'b', type: 't', resourceGroup: 'rg', tags: {} }] }));

    const credential = credentialStub();
    const client = new ResourceGraphSdkClient(credential, {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const kql = buildCandidateQuery();
    const rows = await client.queryResources('sub-1', kql);

    expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
    expect(credential.getToken).toHaveBeenCalledWith('https://management.usgovcloudapi.net/.default');
    expect(credential.getToken).not.toHaveBeenCalledWith('https://management.azure.com/.default');

    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe(
      'https://management.usgovcloudapi.net/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01'
    );
    expect(firstUrl).not.toContain('management.azure.com');
    const firstBody = JSON.parse(String(firstInit.body)) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ query: kql, subscriptions: ['sub-1'] });
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(secondBody).toMatchObject({ query: kql, subscriptions: ['sub-1'], options: { $skipToken: 'page-2' } });
  });

  it('AZ-RETRY-020: Resource Graph honors Retry-After and uses deterministic jitter when absent', async () => {
    const sleeps: number[] = [];
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'throttled' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '2' }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = new ResourceGraphSdkClient(credentialStub(), {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.25
    });
    await expect(client.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
    expect(sleeps).toEqual([2000]);

    fetchMock.mockReset();
    sleeps.length = 0;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const jitterClient = new ResourceGraphSdkClient(credentialStub(), {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5
    });
    await expect(jitterClient.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
    // attempt 1 -> ceiling 500; 0.5 * 500 = 250
    expect(sleeps).toEqual([250]);
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

describe('repo tag lookup query', () => {
  it('AZ-GRAPH-003: query covers canonical, custom, and Fox pair keys with case-insensitive value matching', () => {
    const kql = buildRepoTagLookupQuery('Org/Payments.git', ['team:source-repo'], 'my-rg');

    // Slug is normalized (trailing .git stripped) and compared with =~.
    expect(kql).toContain("=~ 'Org/Payments'");
    expect(kql).toContain("=~ 'Org/Payments.git'");
    // Canonical + custom keys appear in common casings.
    expect(kql).toContain("tags['postman:repo']");
    expect(kql).toContain("tags['team:source-repo']");
    expect(kql).toContain("tags['TeamSourceRepo']");
    // Fox pair composes org and repo halves.
    expect(kql).toContain("tags['GithubOrg']");
    expect(kql).toContain("tags['GithubRepo']");
    expect(kql).toContain("=~ 'Org'");
    expect(kql).toContain("=~ 'Payments'");
    // Resource group scoping and projection stay intact.
    expect(kql).toContain("resourceGroup =~ 'my-rg'");
    expect(kql).toContain('| project id, name, type, resourceGroup, tags');
  });

  it('AZ-GRAPH-004: single-segment slug omits the pair clause and escapes quotes', () => {
    const kql = buildRepoTagLookupQuery("o'rg");
    expect(kql).not.toContain("tags['GithubOrg']");
    expect(kql).toContain("\\'rg'");
  });
});
