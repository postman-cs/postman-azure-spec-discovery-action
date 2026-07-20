import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '20.0.0.1', family: 4 }])
}));

import { ApiCenterSdkClient } from '../src/lib/azure/api-center-client.js';

function fakeCredential() {
  return { getToken: vi.fn(async () => ({ token: 'arm-token', expiresOnTimestamp: Date.now() + 3600_000 })) };
}

const DEF_ARM =
  '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v1/definitions/openapi';

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('ApiCenterSdkClient', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('AZ-APIC-001: hierarchy inventory walks services → workspaces → apis → versions → definitions across pages', async () => {
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/providers/Microsoft.ApiCenter/services?') && !url.includes('resourceGroups')) {
        if (!url.includes('page=2')) {
          return jsonResponse({
            value: [{ id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac', name: 'ac' }],
            nextLink:
              'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.ApiCenter/services?api-version=2024-03-01&page=2'
          });
        }
        return jsonResponse({
          value: [{ id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac2', name: 'ac2' }]
        });
      }
      if (url.includes('/workspaces?')) {
        return jsonResponse({ value: [{ id: '.../workspaces/default', name: 'default' }] });
      }
      if (url.includes('/apis?')) {
        return jsonResponse({ value: [{ id: '.../apis/echo', name: 'echo', properties: { title: 'Echo' } }] });
      }
      if (url.includes('/versions?')) {
        return jsonResponse({ value: [{ id: '.../versions/v1', name: 'v1', properties: { title: 'v1', lifecycleStage: 'production' } }] });
      }
      if (url.includes('/definitions?')) {
        return jsonResponse({
          value: [
            {
              id: DEF_ARM,
              name: 'openapi',
              properties: { title: 'OpenAPI', specification: { name: 'openapi', version: '3.0.3' } }
            }
          ]
        });
      }
      if (url.includes('/deployments?')) {
        return jsonResponse({
          value: [
            {
              name: 'prod',
              properties: {
                environmentId: '.../environments/prod',
                server: { type: 'Azure API Management', runtimeUri: ['https://gateway.azure-api.net'] }
              }
            }
          ]
        });
      }
      return jsonResponse({ value: [] });
    });

    const definitions = await client.listDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => d.serviceName).sort()).toEqual(['ac', 'ac2']);
    expect(definitions[0]!.id).toBe(DEF_ARM);
    expect(definitions[0]!.deployments?.some((d) => d.name === 'prod')).toBe(true);
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url).includes('exportSpecification') || init?.method === 'POST')).toBe(
      false
    );
  });

  it('AZ-APIC-002: nextLink repeat, cross-host, and 100-page ceiling abort inventory', async () => {
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        value: [{ id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac', name: 'ac' }],
        nextLink: 'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.ApiCenter/services?api-version=2024-03-01'
      })
    );
    await expect(client.listServices()).rejects.toThrow(/repeated nextLink/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        value: [],
        nextLink: 'https://evil.example/subscriptions/sub-1/providers/Microsoft.ApiCenter/services?api-version=2024-03-01'
      })
    );
    await expect(client.listServices()).rejects.toThrow(/outside the configured ARM/);

    let page = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      page += 1;
      const next =
        page < 101
          ? `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.ApiCenter/services?api-version=2024-03-01&page=${page}`
          : undefined;
      return jsonResponse({
        value: [{ id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/s${page}`, name: `s${page}` }],
        ...(next ? { nextLink: next } : {})
      });
    });
    await expect(client.listServices()).rejects.toThrow(/exceeded 100 pages/);
  });

  it('AZ-APIC-003: exportSpecification 200 inline returns bytes without Authorization on any later fetch', async () => {
    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Echo', version: '1.0.0' },
      paths: { '/echo': { get: { responses: { '200': { description: 'ok' } } } } }
    });
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ format: 'inline', value: openapi })
    );

    const exported = await client.exportSpecification({
      resourceGroup: 'rg',
      serviceName: 'ac',
      workspaceName: 'default',
      apiName: 'echo',
      versionName: 'v1',
      definitionName: 'openapi'
    });
    expect(exported.content).toContain('openapi');
    expect(exported.source).toBe('inline');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/exportSpecification?api-version=2024-03-01');
    expect(init.method).toBe('POST');
    expect(String((init.headers as Record<string, string>).authorization)).toContain('arm-token');
  });

  it('AZ-APIC-004: 202 Location polling honors Retry-After and returns result; SAS never appears in thrown errors', async () => {
    const sleeps: number[] = [];
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      maxLroPolls: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    const sas = 'https://stor.blob.core.windows.net/export/spec.json?sig=super-secret-sas&se=2099';
    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Echo', version: '1' },
      paths: { '/x': { get: { responses: { '200': { description: 'ok' } } } } }
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: {
            Location: 'https://management.azure.com/subscriptions/sub-1/operations/op-1?api-version=2024-03-01',
            'Retry-After': '2'
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: {
            'Azure-AsyncOperation':
              'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.ApiCenter/locations/eastus/operationStatuses/op-1?api-version=2024-03-01',
            'Retry-After': '1'
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ format: 'link', value: sas }))
      .mockResolvedValueOnce(
        new Response(openapi, { status: 200, headers: { 'content-type': 'application/json' } })
      );

    const exported = await client.exportSpecification({
      resourceGroup: 'rg',
      serviceName: 'ac',
      workspaceName: 'default',
      apiName: 'echo',
      versionName: 'v1',
      definitionName: 'openapi'
    });
    expect(exported.content).toContain('openapi');
    expect(exported.source).toBe('link');
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBe(1000);

    const linkFetch = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => String(url).includes('stor.blob.core.windows.net')
    );
    expect(linkFetch).toBeTruthy();
    const linkHeaders = (linkFetch?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    const authHeader = linkHeaders
      ? Object.entries(linkHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
      : undefined;
    expect(authHeader).toBeUndefined();
  });

  it('AZ-APIC-005: transient 429/5xx retry; permanent 400/401/403 do not retry; LRO ceiling aborts', async () => {
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      maxLroPolls: 2,
      sleep: async () => undefined,
      random: () => 0
    });

    const transient = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('slow', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          format: 'inline',
          value: '{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"description":"ok"}}}}}}'
        })
      );
    await expect(
      client.exportSpecification({
        resourceGroup: 'rg',
        serviceName: 'ac',
        workspaceName: 'default',
        apiName: 'echo',
        versionName: 'v1',
        definitionName: 'openapi'
      })
    ).resolves.toMatchObject({ source: 'inline' });
    expect(transient).toHaveBeenCalledTimes(2);
    transient.mockRestore();

    for (const status of [400, 401, 403] as const) {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status }));
      await expect(
        client.exportSpecification({
          resourceGroup: 'rg',
          serviceName: 'ac',
          workspaceName: 'default',
          apiName: 'echo',
          versionName: 'v1',
          definitionName: 'openapi'
        })
      ).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }

    const lro = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 202,
        headers: { Location: 'https://management.azure.com/subscriptions/sub-1/operations/forever?api-version=2024-03-01' }
      })
    );
    await expect(
      client.exportSpecification({
        resourceGroup: 'rg',
        serviceName: 'ac',
        workspaceName: 'default',
        apiName: 'echo',
        versionName: 'v1',
        definitionName: 'openapi'
      })
    ).rejects.toThrow(/LRO poll/);
    lro.mockRestore();
  });

  it('AZ-APIC-006: probe classifies 401/403 as authorization failures', async () => {
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(client.probeApiCenterReadAccess()).rejects.toThrow(/AuthorizationFailed/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ value: [] }));
    await expect(client.probeApiCenterReadAccess()).resolves.toBeUndefined();
  });

  it('AZ-APIC-007: link export evidence/errors never include SAS query material', async () => {
    const client = new ApiCenterSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const sas = 'https://stor.blob.core.windows.net/export/spec.json?sig=never-log-this&sv=2024';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ format: 'link', value: sas }))
      .mockResolvedValueOnce(new Response('gone', { status: 404 }));

    const error = await client
      .exportSpecification({
        resourceGroup: 'rg',
        serviceName: 'ac',
        workspaceName: 'default',
        apiName: 'echo',
        versionName: 'v1',
        definitionName: 'openapi'
      })
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('sig=');
    expect((error as Error).message).not.toContain('never-log-this');
  });
});
