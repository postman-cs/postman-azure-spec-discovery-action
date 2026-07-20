import { describe, expect, it, vi } from 'vitest';

import type { AzureAppServiceClient } from '../src/lib/azure/clients.js';
import type { AzureAppServiceRuntimeClient } from '../src/lib/azure/app-service-runtime-client.js';
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

describe('R4 App Service ApiSpecPath + SCM opt-in', () => {
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
});
