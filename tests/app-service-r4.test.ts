import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import type { TokenCredential } from '@azure/identity';

import type { AzureAppServiceClient } from '../src/lib/azure/clients.js';
import {
  AppServiceRuntimeSdkClient,
  deriveCorrelatedScmHostName,
  safeUrlForEvidence,
  type AzureAppServiceRuntimeClient
} from '../src/lib/azure/app-service-runtime-client.js';
import { AppServiceProvider } from '../src/lib/providers/app-service.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0.0' },
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function appClient(overrides: Partial<AzureAppServiceClient> = {}): AzureAppServiceClient {
  return {
    listSites: vi.fn(async () => [
      {
        name: 'orders-api',
        resourceGroup: 'rg',
        tags: { 'postman:repo': 'contoso/orders' }
      }
    ]),
    probeAppServiceReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

function runtimeClient(overrides: Partial<AzureAppServiceRuntimeClient> = {}): AzureAppServiceRuntimeClient {
  return {
    getSiteRuntimeConfig: vi.fn(async () => ({
      apiSpecPath: '/home/data/.ai/apispec.json',
      defaultHostName: 'orders-api.azurewebsites.net',
      scmHostName: 'orders-api.scm.azurewebsites.net',
      publicNetworkAccess: 'Enabled'
    })),
    fetchApiSpecFromScm: vi.fn(async () => ({ kind: 'content' as const, content: VALID_OPENAPI })),
    ...overrides
  };
}

function fakeCredential(): TokenCredential {
  return {
    getToken: vi.fn(async () => ({ token: 'arm-token', expiresOnTimestamp: Date.now() + 3600_000 }))
  };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
  });
}

function armSitePayload(overrides: {
  defaultHostName?: string;
  enabledHostNames?: string[];
  publicNetworkAccess?: string;
} = {}): unknown {
  return {
    properties: {
      defaultHostName: overrides.defaultHostName ?? 'orders-api.azurewebsites.net',
      enabledHostNames: overrides.enabledHostNames ?? [
        'orders-api.azurewebsites.net',
        'orders-api.scm.azurewebsites.net'
      ],
      publicNetworkAccess: overrides.publicNetworkAccess ?? 'Enabled'
    }
  };
}

function mockArmAndScmFetch(
  scmHandler: (url: string, init?: RequestInit) => Promise<Response> | Response
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('management.azure.com') && /\/sites\/orders-api\?/.test(url)) {
      return jsonResponse(armSitePayload());
    }
    if (url.includes('management.azure.com') && url.includes('/config/web')) {
      return jsonResponse({
        properties: { aiIntegration: { ApiSpecPath: '/home/data/.ai/apispec.json' } }
      });
    }
    if (url.includes('.scm.') || url.includes('/api/vfs/')) {
      return scmHandler(url, init);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function expectFailedDetail(
  result: Awaited<ReturnType<AppServiceRuntimeSdkClient['fetchApiSpecFromScm']>>,
  pattern: RegExp
): void {
  expect(result.kind).toBe('failed');
  if (result.kind !== 'failed') return;
  expect(result.detail).toMatch(pattern);
}

describe('R4 App Service ApiSpecPath + SCM opt-in', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-APP-R4-001: surfaces exact ApiSpecPath metadata without SCM fetch by default', async () => {
    const runtime = runtimeClient();
    const provider = new AppServiceProvider(appClient(), {
      subscriptionId: 'sub-1',
      runtimeClient: runtime
    });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.meta.apiSpecPath).toBe('/home/data/.ai/apispec.json');
    expect(candidates[0]!.supported).toBe(false);
    expect(candidates[0]!.meta.manualReviewReason).toBe('api-spec-path-metadata-only');
    expect(runtime.fetchApiSpecFromScm).not.toHaveBeenCalled();
  });

  it('AZ-APP-R4-002: opt-in SCM fetch retrieves authoritative bytes from site VFS only', async () => {
    const runtime = runtimeClient();
    const provider = new AppServiceProvider(appClient(), {
      subscriptionId: 'sub-1',
      enableScmSpecFetch: true,
      runtimeClient: runtime
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.supported).toBe(true);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.content).toContain('Orders');
    expect(runtime.fetchApiSpecFromScm).toHaveBeenCalledWith('rg', 'orders-api', '/home/data/.ai/apispec.json');
  });

  it('AZ-APP-R4-003: disabled SCM is a distinct manual-review reason', async () => {
    const provider = new AppServiceProvider(appClient(), {
      subscriptionId: 'sub-1',
      enableScmSpecFetch: true,
      runtimeClient: runtimeClient({
        fetchApiSpecFromScm: vi.fn(async () => ({
          kind: 'scm-disabled' as const,
          detail: 'no discoverable SCM hostname'
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/scm-disabled/i);
  });

  it('AZ-APP-R4-004: private unreachable is distinct from SSRF blocked', async () => {
    const provider = new AppServiceProvider(appClient(), {
      subscriptionId: 'sub-1',
      enableScmSpecFetch: true,
      runtimeClient: runtimeClient({
        getSiteRuntimeConfig: vi.fn(async () => ({
          apiSpecPath: '/home/data/.ai/apispec.json',
          defaultHostName: 'orders-api.azurewebsites.net',
          scmHostName: 'orders-api.scm.azurewebsites.net',
          publicNetworkAccess: 'Disabled'
        })),
        fetchApiSpecFromScm: vi.fn(async () => ({
          kind: 'private-network-unreachable' as const,
          detail: 'publicNetworkAccess disabled'
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/private-network-unreachable/i);
  });

  it('AZ-APP-R4-005: derives correlated SCM hosts for public, sovereign, and ASE shapes', () => {
    expect(deriveCorrelatedScmHostName('orders-api.azurewebsites.net', undefined)).toBe(
      'orders-api.scm.azurewebsites.net'
    );
    expect(deriveCorrelatedScmHostName('orders-api.azurewebsites.us', undefined)).toBe(
      'orders-api.scm.azurewebsites.us'
    );
    expect(deriveCorrelatedScmHostName('orders-api.chinacloudsites.cn', undefined)).toBe(
      'orders-api.scm.chinacloudsites.cn'
    );
    expect(deriveCorrelatedScmHostName('orders-api.myase.p.azurewebsites.net', undefined)).toBe(
      'orders-api.scm.myase.p.azurewebsites.net'
    );
    expect(deriveCorrelatedScmHostName('orders-api.myase.appserviceenvironment.net', undefined)).toBe(
      'orders-api.scm.myase.appserviceenvironment.net'
    );
    expect(
      deriveCorrelatedScmHostName('orders-api.azurewebsites.net', [
        'orders-api.azurewebsites.net',
        'orders-api.scm.azurewebsites.net'
      ])
    ).toBe('orders-api.scm.azurewebsites.net');
  });

  it('AZ-APP-R4-006: concrete client rejects malicious .scm. hostname before token/fetch', async () => {
    const credential = fakeCredential();
    const client = new AppServiceRuntimeSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 30_000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('management.azure.com') && /\/sites\/orders-api\?/.test(url)) {
        return jsonResponse(
          armSitePayload({
            enabledHostNames: ['orders-api.azurewebsites.net', 'evil.scm.attacker.com']
          })
        );
      }
      if (url.includes('management.azure.com') && url.includes('/config/web')) {
        return jsonResponse({
          properties: { aiIntegration: { ApiSpecPath: '/home/data/.ai/apispec.json' } }
        });
      }
      throw new Error(`Unexpected fetch (credential must not reach attacker): ${url}`);
    });

    const result = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expect(result.kind).toBe('scm-disabled');
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('attacker.com'))).toBe(true);
    expect(fetchSpy.mock.calls.every(([url]) => String(url).includes('management.azure.com'))).toBe(true);
    // ARM site+config share one token; SCM bearer must never be minted after rejection.
    expect(credential.getToken).toHaveBeenCalledTimes(1);
  });

  it('AZ-APP-R4-007: concrete client rejects userinfo, IP literals, and malformed SCM hosts', async () => {
    expect(deriveCorrelatedScmHostName('user:pass@orders-api.azurewebsites.net', undefined)).toBeUndefined();
    expect(deriveCorrelatedScmHostName('1.2.3.4', undefined)).toBeUndefined();
    expect(deriveCorrelatedScmHostName('[2001:db8::1]', undefined)).toBeUndefined();
    expect(
      deriveCorrelatedScmHostName('orders-api.azurewebsites.net', ['orders-api.scm.azurewebsites.net@evil'])
    ).toBeUndefined();
    expect(
      deriveCorrelatedScmHostName('orders-api.azurewebsites.net', ['203.0.113.9'])
    ).toBe('orders-api.scm.azurewebsites.net');
    expect(
      deriveCorrelatedScmHostName('orders-api.azurewebsites.net', ['1.2.3.4.scm.evil.com'])
    ).toBeUndefined();
  });

  it('AZ-APP-R4-008: concrete client times out despite a non-aborting caller signal', async () => {
    const credential = fakeCredential();
    const client = new AppServiceRuntimeSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 40,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const caller = new AbortController();
    mockArmAndScmFetch(async (_url, init): Promise<Response> => {
      const signal = init?.signal;
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });

    const result = await client.fetchApiSpecFromScm(
      'rg',
      'orders-api',
      '/home/data/.ai/apispec.json',
      caller.signal
    );
    expectFailedDetail(result, /timed out/i);
    expect(caller.signal.aborted).toBe(false);
  });

  it('AZ-APP-R4-009: concrete client does not follow SCM redirects (no credential re-forward)', async () => {
    const credential = fakeCredential();
    const client = new AppServiceRuntimeSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 30_000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const fetchSpy = mockArmAndScmFetch(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/steal?sig=secret-sas' }
        })
    );

    const result = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expectFailedDetail(result, /^SCM VFS returned unexpected redirect$/);
    if (result.kind === 'failed') {
      expect(result.detail).not.toMatch(/sig=|steal|evil\.example/i);
    }
    const scmCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('.scm.'));
    expect(scmCalls).toHaveLength(1);
    expect(scmCalls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(fetchSpy.mock.calls.every((call) => !String(call[0]).includes('evil.example'))).toBe(true);
  });

  it('AZ-APP-R4-010: concrete client rejects oversized Content-Length and chunked bodies', async () => {
    const credential = fakeCredential();
    const client = new AppServiceRuntimeSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 30_000,
      maxAttempts: 1,
      sleep: async () => undefined
    });

    mockArmAndScmFetch(
      async () =>
        new Response(VALID_OPENAPI, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024) }
        })
    );
    const oversizedHeader = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expectFailedDetail(oversizedHeader, /^SCM VFS artifact exceeds size ceiling$/);

    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        canceled = true;
      }
    });
    mockArmAndScmFetch(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    const oversizedStream = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expectFailedDetail(oversizedStream, /^SCM VFS artifact exceeds size ceiling$/);
    expect(canceled).toBe(true);
  });

  it('AZ-APP-R4-010a: concrete client classifies bounded Kudu 403 diagnostics as SCM disabled', async () => {
    const client = new AppServiceRuntimeSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30_000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    mockArmAndScmFetch(async () => new Response('Kudu publishing basic auth is disabled', { status: 403 }));

    const result = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expect(result).toMatchObject({ kind: 'scm-disabled' });
  });

  it('AZ-APP-R4-011: concrete client succeeds only for ARM-correlated SCM host with Entra bearer', async () => {
    const credential = fakeCredential();
    const client = new AppServiceRuntimeSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 30_000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const fetchSpy = mockArmAndScmFetch(async (url, init) => {
      expect(url).toBe('https://orders-api.scm.azurewebsites.net/api/vfs/home/data/.ai/apispec.json');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer arm-token');
      expect(init?.redirect).toBe('manual');
      return new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const result = await client.fetchApiSpecFromScm('rg', 'orders-api', '/home/data/.ai/apispec.json');
    expect(result.kind).toBe('content');
    if (result.kind === 'content') {
      expect(result.content).toContain('Orders');
    }
    expect(credential.getToken).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('.scm.azurewebsites.net'))).toBe(true);
  });

  it('AZ-APP-R4-012: provider errors/evidence redact query and SAS material', async () => {
    const sasUrl =
      'https://orders.example.com/openapi.json?sv=2024-01-01&sig=super-secret-sas-token&se=2099-01-01';
    expect(safeUrlForEvidence(sasUrl)).toBe('https://orders.example.com/openapi.json');
    expect(safeUrlForEvidence(sasUrl)).not.toMatch(/sig=|sv=|super-secret/);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const provider = new AppServiceProvider(appClient(), {
      subscriptionId: 'sub-1',
      runtimeClient: runtimeClient({
        getSiteRuntimeConfig: vi.fn(async () => ({
          apiDefinitionUrl: sasUrl,
          defaultHostName: 'orders-api.azurewebsites.net'
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.evidence.join('\n')).toContain('https://orders.example.com/openapi.json');
    expect(exported.evidence.join('\n')).not.toMatch(/sig=|super-secret-sas-token/);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('AZ-APP-R4-013: preserves private-network-unreachable vs blocked-ssrf distinction without query leakage', async () => {
    const sasUrl = 'https://127.0.0.1/openapi.json?sig=secret-sas';
    const provider = new AppServiceProvider(
      appClient({
        listSites: vi.fn(async () => [
          {
            name: 'orders-api',
            resourceGroup: 'rg',
            tags: {},
            apiDefinitionUrl: sasUrl
          }
        ])
      }),
      { subscriptionId: 'sub-1' }
    );
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/blocked by SSRF defenses/i);
    try {
      await provider.exportSpec(candidate!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/sig=|secret-sas/);
      expect(message).toContain('https://127.0.0.1/openapi.json');
      expect(message).not.toMatch(/private-network-unreachable/i);
    }
  });
});
