import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiManagementClient } from '@azure/arm-apimanagement';

import { ApimProvider } from '../src/lib/providers/apim.js';
import { ApimSdkClient } from '../src/lib/azure/clients.js';
import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { AzureApimClient } from '../src/lib/azure/clients.js';

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'az-apim-'));
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

function clientForApiType(apiType: string): AzureApimClient {
  return {
    listServices: vi.fn(async () => [{ name: 'svc', resourceGroup: 'rg', tags: { 'postman:project-name': 'payments' } }]),
    listApis: vi.fn(async () => [
      {
        apiId: 'payments',
        displayName: 'Payments API',
        apiType,
        isCurrent: true,
        serviceName: 'svc',
        resourceGroup: 'rg'
      }
    ]),
    exportApi: vi.fn(async () => {
      throw new Error('export must never be attempted for unsupported types');
    }),
    probeApimReadAccess: vi.fn(async () => undefined)
  };
}

describe('APIM unsupported API types', () => {
  it.each(['soap', 'graphql', 'websocket', 'grpc', 'odata'])(
    'AZ-APIM-004: selected %s candidate resolves to manual review without writes',
    async (apiType) => {
      const provider = new ApimProvider(clientForApiType(apiType), { subscriptionId: 'sub-1' });
      const writeSpecFile = vi.fn();
      const dependencies: AzureDependencies = {
        core: reporter,
        subscriptions: {
          get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
          list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
        },
        createApimClient: () => {
          throw new Error('unused');
        },
        createAppServiceClient: () => {
          throw new Error('unused');
        },
        writeSpecFile,
        providers: [provider]
      };

      const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
      const result = await execute(inputs, dependencies);

      expect(result.resolution?.status).toBe('unresolved');
      expect(result.resolution?.sourceType).toBe('manual-review');
      expect(JSON.stringify(result.resolution)).toContain(`APIM API type ${apiType} is not exportable in v1.0.0`);
      expect(writeSpecFile).not.toHaveBeenCalled();
    }
  );
});

describe('APIM export link lifecycle', () => {
  it('AZ-APIM-003: each 403 discards the SAS URL and re-exports within maxAttempts', async () => {
    const credential = { getToken: vi.fn(async () => ({ token: 'token', expiresOnTimestamp: Date.now() + 60_000 })) };
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: ApiManagementClient }).client;
    const exportSpy = vi.spyOn(sdk.apiExport, 'get');
    exportSpy
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/first?sig=first' } })
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/second?sig=second' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"openapi":"3.0.3","paths":{"/ok":{}}}', { status: 200 }));

    await expect(client.exportApi('rg', 'svc', 'payments')).resolves.toContain('openapi');
    expect(exportSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    exportSpy.mockReset();
    fetchSpy.mockReset();
    exportSpy.mockResolvedValue({ value: { link: 'https://1.1.1.1/expired?sig=secret' } });
    fetchSpy.mockResolvedValue(new Response('expired', { status: 403 }));
    await expect(client.exportApi('rg', 'svc', 'payments')).rejects.toThrow('HTTP 403 after 3 attempt(s)');
    expect(exportSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
