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
  ResourceGraphSdkClient
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
});
