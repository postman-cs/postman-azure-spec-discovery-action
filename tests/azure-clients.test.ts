import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const { apimCtorSpy, appServiceCtorSpy, graphCtorSpy } = vi.hoisted(() => ({
  apimCtorSpy: vi.fn(),
  appServiceCtorSpy: vi.fn(),
  graphCtorSpy: vi.fn()
}));

vi.mock('@azure/arm-apimanagement', () => ({
  ApiManagementClient: class {
    public apiManagementService = { list: vi.fn(), listByResourceGroup: vi.fn() };
    public api = { listByService: vi.fn() };
    public apiExport = { get: vi.fn() };
    public constructor(...args: unknown[]) {
      apimCtorSpy(...args);
    }
  }
}));

vi.mock('@azure/arm-appservice', () => ({
  WebSiteManagementClient: class {
    public webApps = { list: vi.fn(), listByResourceGroup: vi.fn(), getConfiguration: vi.fn() };
    public constructor(...args: unknown[]) {
      appServiceCtorSpy(...args);
    }
  }
}));

vi.mock('@azure/arm-resourcegraph', () => ({
  ResourceGraphClient: class {
    public resources = vi.fn();
    public constructor(...args: unknown[]) {
      graphCtorSpy(...args);
    }
  }
}));

import {
  ApimSdkClient,
  AppServiceSdkClient,
  createAzureCredential,
  ResourceGraphSdkClient,
  SubscriptionsSdkClient
} from '../src/lib/azure/clients.js';

function fakeCredential() {
  return { getToken: vi.fn(async () => ({ token: 'tok', expiresOnTimestamp: Date.now() + 3600_000 })) };
}

describe('azure sdk client wrappers', () => {
  beforeEach(() => {
    apimCtorSpy.mockReset();
    appServiceCtorSpy.mockReset();
    graphCtorSpy.mockReset();
  });

  it('AZ-CLIENT-001: every wrapper receives the same shared TokenCredential', () => {
    const credential = fakeCredential();
    new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new AppServiceSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new ResourceGraphSdkClient(credential);

    expect(apimCtorSpy.mock.calls[0]?.[0]).toBe(credential);
    expect(appServiceCtorSpy.mock.calls[0]?.[0]).toBe(credential);
    expect(graphCtorSpy.mock.calls[0]?.[0]).toBe(credential);
  });

  it('AZ-CLIENT-001: source contains exactly one production DefaultAzureCredential construction', () => {
    const srcRoot = path.resolve(import.meta.dirname, '..', 'src');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) sources.push(readFileSync(full, 'utf8'));
      }
    };
    walk(srcRoot);
    const occurrences = sources.join('\n').match(/new DefaultAzureCredential\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(typeof createAzureCredential).toBe('function');
  });

  it('AZ-CLIENT-004: SDK clients are constructed with retry bounded by maxAttempts', () => {
    const credential = fakeCredential();
    new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 5 });
    new AppServiceSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 5 });

    expect(apimCtorSpy.mock.calls[0]?.[2]).toMatchObject({ retryOptions: { maxRetries: 5 } });
    expect(appServiceCtorSpy.mock.calls[0]?.[2]).toMatchObject({ retryOptions: { maxRetries: 5 } });
  });

  it('AZ-CLIENT-004: a 401 from the SDK surfaces after a single wrapper attempt', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    let calls = 0;
    sdk.apiManagementService.list.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            calls += 1;
            throw new Error('401 Unauthorized');
          }
        };
      }
    }));

    await expect(client.listServices()).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('AZ-CLIENT-005: exportApi reads the link from the runtime properties.value shape', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    // The live ARM API nests the SAS link under properties.value.link, not the
    // value.link shape the generated SDK model claims.
    sdk.apiExport.get.mockResolvedValue({
      id: '/subscriptions/sub-1/.../apis/payments-live',
      name: 'payments-live',
      properties: { format: 'openapi+json-link', value: { link: 'https://blob.example/export.json?sig=REDACTED' } }
    });
    const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(spec, { status: 200 }) as unknown as Response
    );
    try {
      const content = await client.exportApi('rg', 'svc', 'payments-live');
      expect(content).toContain('"openapi":"3.0.3"');
      // exportApi routes the SAS link through the hardened fetcher (HTTPS-only,
      // redirect:'manual', abort signal, size caps), not a bare fetch.
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://blob.example/export.json?sig=REDACTED',
        expect.objectContaining({ redirect: 'manual' })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CLIENT-005: exportApi still reads the flat value.link shape', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get.mockResolvedValue({ value: { link: 'https://blob.example/flat.json' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}', { status: 200 }) as unknown as Response
    );
    try {
      const content = await client.exportApi('rg', 'svc', 'payments-live');
      expect(content).toContain('"openapi":"3.0.3"');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://blob.example/flat.json',
        expect.objectContaining({ redirect: 'manual' })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CLIENT-005: exportApi throws when neither link shape is present', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get.mockResolvedValue({ properties: { format: 'openapi+json-link', value: {} } });
    await expect(client.exportApi('rg', 'svc', 'payments-live')).rejects.toThrow('no download link');
  });

  it('AZ-CLIENT-006: pagination ceiling allows exactly 100 pages and rejects the 101st', async () => {
    const credential = fakeCredential();
    const makePagedIterable = (pageCount: number) => {
      const iterable = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < pageCount * 2; i += 1) yield { name: `svc-${i}`, id: `/subscriptions/s/resourceGroups/rg/x/${i}` };
        },
        byPage: () => ({
          async *[Symbol.asyncIterator]() {
            for (let p = 0; p < pageCount; p += 1) {
              yield [
                { name: `svc-${p}-a`, id: `/subscriptions/s/resourceGroups/rg/x/${p}a` },
                { name: `svc-${p}-b`, id: `/subscriptions/s/resourceGroups/rg/x/${p}b` }
              ];
            }
          }
        })
      };
      return iterable;
    };

    const okClient = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const okSdk = (okClient as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    okSdk.apiManagementService.list.mockReturnValue(makePagedIterable(100));
    await expect(okClient.listServices()).resolves.toHaveLength(200);

    const failClient = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const failSdk = (failClient as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    failSdk.apiManagementService.list.mockReturnValue(makePagedIterable(101));
    await expect(failClient.listServices()).rejects.toThrow('pagination exceeded 100 pages');
  });

  it('AZ-CLIENT-006: subscription listing rejects when nextLink never terminates', async () => {
    const credential = fakeCredential();
    const client = new SubscriptionsSdkClient(credential);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get('page') ?? '0');
      return new Response(
        JSON.stringify({
          value: [{ subscriptionId: `sub-${page}`, state: 'Enabled' }],
          nextLink: `https://management.azure.com/subscriptions?api-version=2022-12-01&page=${page + 1}`
        }),
        { status: 200 }
      );
    });
    try {
      await expect(client.listEnabledSubscriptions()).rejects.toThrow('pagination exceeded 100 pages');
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(101);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
