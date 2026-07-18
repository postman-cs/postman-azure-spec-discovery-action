import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { SpecProvider } from '../src/lib/providers/types.js';

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'az-preflight-'));
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

describe('subscription preflight', () => {
  it('AZ-CLIENT-002: subscription listing failure rejects before provider enumeration', async () => {
    const listCandidates = vi.fn(async () => []);
    const provider: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates,
      exportSpec: vi.fn()
    };
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => {
          throw new Error('Subscription listing failed with HTTP 401');
        })
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: vi.fn(),
      providers: [provider]
    };

    const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
    await expect(execute(inputs, dependencies)).rejects.toThrow('Subscription listing failed with HTTP 401');
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('AZ-CLIENT-003: probe statuses stay ordered and fail-soft without raw ARM IDs in evidence', async () => {
    const armId = '/subscriptions/cccccccc-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments';
    const providers: SpecProvider[] = [
      {
        type: 'apim',
        probe: vi.fn(async () => 'skipped:iam' as const),
        listCandidates: vi.fn(async () => []),
        exportSpec: vi.fn()
      },
      {
        type: 'app-service',
        probe: vi.fn(async () => 'skipped:error' as const),
        listCandidates: vi.fn(async () => []),
        exportSpec: vi.fn()
      },
      {
        type: 'iac-local',
        probe: vi.fn(async () => 'available' as const),
        listCandidates: vi.fn(async () => []),
        exportSpec: vi.fn()
      }
    ];
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
      writeSpecFile: vi.fn(),
      providers
    };

    const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
    const result = await execute(inputs, dependencies);

    expect(result.resolution?.providerProbes).toEqual([
      { provider: 'apim', status: 'skipped:iam' },
      { provider: 'app-service', status: 'skipped:error' },
      { provider: 'iac-local', status: 'available' }
    ]);
    expect(JSON.stringify(result.resolution?.evidence ?? [])).not.toContain(armId);
  });
});
