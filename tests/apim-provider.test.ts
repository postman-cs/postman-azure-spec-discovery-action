import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApimProvider } from '../src/lib/providers/apim.js';
import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { AzureApimClient } from '../src/lib/azure/clients.js';

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'az-apim-'));
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
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
  it.each(['soap', 'graphql', 'websocket'])(
    'AZ-APIM-004: selected %s candidate resolves to manual review without writes',
    async (apiType) => {
      const provider = new ApimProvider(clientForApiType(apiType), { subscriptionId: 'sub-1' });
      const writeSpecFile = vi.fn();
      const dependencies: AzureDependencies = {
        core: reporter,
        subscriptions: { listEnabledSubscriptions: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }]) },
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
      expect(JSON.stringify(result.resolution)).toContain(`API type ${apiType} is not exportable in v1`);
      expect(writeSpecFile).not.toHaveBeenCalled();
    }
  );
});
