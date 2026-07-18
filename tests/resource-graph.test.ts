import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resourcesMock } = vi.hoisted(() => ({ resourcesMock: vi.fn() }));

vi.mock('@azure/arm-resourcegraph', () => ({
  ResourceGraphClient: class {
    public resources = resourcesMock;
  }
}));

import { ResourceGraphSdkClient } from '../src/lib/azure/clients.js';
import { buildCandidateQuery } from '../src/lib/resolve/resource-graph-query.js';

describe('resource graph paging', () => {
  beforeEach(() => {
    resourcesMock.mockReset();
  });

  it('AZ-GRAPH-001: two pages use the same KQL, forward only the first skipToken, and stop', async () => {
    resourcesMock
      .mockResolvedValueOnce({
        data: [{ id: '/a', name: 'a', type: 't', resourceGroup: 'rg', tags: {} }],
        skipToken: 'page-2'
      })
      .mockResolvedValueOnce({
        data: [{ id: '/b', name: 'b', type: 't', resourceGroup: 'rg', tags: {} }]
      });

    const credential = { getToken: vi.fn(async () => ({ token: 't', expiresOnTimestamp: 0 })) };
    const client = new ResourceGraphSdkClient(credential);
    const kql = buildCandidateQuery();
    const rows = await client.queryResources('sub-1', kql);

    expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
    expect(resourcesMock).toHaveBeenCalledTimes(2);
    expect(resourcesMock.mock.calls[0]?.[0]).toMatchObject({ query: kql, subscriptions: ['sub-1'] });
    expect(resourcesMock.mock.calls[0]?.[0].options).toBeUndefined();
    expect(resourcesMock.mock.calls[1]?.[0]).toMatchObject({ query: kql, options: { skipToken: 'page-2' } });
  });

  it('AZ-GRAPH-001: a repeated skip token fails instead of returning partial discovery', async () => {
    resourcesMock
      .mockResolvedValueOnce({ data: [], skipToken: 'repeat' })
      .mockResolvedValueOnce({ data: [], skipToken: 'repeat' });
    const credential = { getToken: vi.fn(async () => ({ token: 't', expiresOnTimestamp: 0 })) };
    const client = new ResourceGraphSdkClient(credential);
    await expect(client.queryResources('sub-1', buildCandidateQuery())).rejects.toThrow('repeated skip token');
    expect(resourcesMock).toHaveBeenCalledTimes(2);
  });

  it('AZ-CLIENT-004: Resource Graph retries transient failures within maxAttempts and never retries 400', async () => {
    const credential = { getToken: vi.fn(async () => ({ token: 't', expiresOnTimestamp: 0 })) };
    resourcesMock
      .mockRejectedValueOnce(Object.assign(new Error('503 unavailable'), { statusCode: 503 }))
      .mockResolvedValueOnce({ data: [] });
    const transientClient = new ResourceGraphSdkClient(credential, { requestTimeoutMs: 30000, maxAttempts: 2 });
    await expect(transientClient.queryResources('sub-1', buildCandidateQuery())).resolves.toEqual([]);
    expect(resourcesMock).toHaveBeenCalledTimes(2);

    resourcesMock.mockReset();
    resourcesMock.mockRejectedValue(Object.assign(new Error('400 bad request'), { statusCode: 400 }));
    const validationClient = new ResourceGraphSdkClient(credential, { requestTimeoutMs: 30000, maxAttempts: 3 });
    await expect(validationClient.queryResources('sub-1', buildCandidateQuery())).rejects.toThrow('400');
    expect(resourcesMock).toHaveBeenCalledTimes(1);
  });
});
