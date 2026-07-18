import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

import { runAction, type CoreLike } from '../src/index.js';
import type { AzureDependencies } from '../src/runtime.js';
import type { SpecProvider } from '../src/lib/providers/types.js';

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'az-telemetry-'));
  process.env.INPUT_REPO_ROOT = repoRoot;
});

afterAll(async () => {
  delete process.env.INPUT_REPO_ROOT;
  await rm(repoRoot, { recursive: true, force: true });
});

function coreStub(): CoreLike & { outputs: Record<string, string>; failed: string[] } {
  const outputs: Record<string, string> = {};
  const failed: string[] = [];
  return {
    outputs,
    failed,
    getInput: (name: string) => (name === 'repo-root' ? repoRoot : name === 'api-id' ? 'payments' : ''),
    group: async (_n, fn) => fn(),
    info: () => undefined,
    warning: () => undefined,
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setFailed: (message) => {
      failed.push(message);
    }
  };
}

function deps(overrides: Partial<Omit<AzureDependencies, 'core'>> = {}): Omit<AzureDependencies, 'core'> {
  const provider: SpecProvider = {
    type: 'apim',
    probe: vi.fn(async () => 'available' as const),
    listCandidates: vi.fn(async () => []),
    exportSpec: vi.fn()
  };
  return {
    subscriptions: { listEnabledSubscriptions: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }]) },
    createApimClient: () => {
      throw new Error('unused');
    },
    createAppServiceClient: () => {
      throw new Error('unused');
    },
    writeSpecFile: vi.fn(),
    providers: [provider],
    ...overrides
  };
}

describe('telemetry contract', () => {
  it('AZ-TELEMETRY-001: opt-out env suppresses the transport entirely', () => {
    for (const env of [{ POSTMAN_ACTIONS_TELEMETRY: 'off' }, { DO_NOT_TRACK: '1' }]) {
      const transport = vi.fn();
      const telemetry = createTelemetryContext({
        action: 'azure-spec-discovery',
        env,
        transport: transport as unknown as typeof fetch
      });
      telemetry.setTeamId('10490519');
      telemetry.emitCompletion('success');
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('AZ-TELEMETRY-001: success and failure runs both complete, and telemetry never alters the runtime result', async () => {
    process.env.POSTMAN_ACTIONS_TELEMETRY = 'off';

    const successCore = coreStub();
    await expect(runAction(successCore, deps())).resolves.toEqual([]);
    expect(successCore.failed).toEqual([]);

    const failureCore = coreStub();
    await expect(
      runAction(failureCore, deps({
        subscriptions: {
          listEnabledSubscriptions: vi.fn(async () => {
            throw new Error('Subscription listing failed with HTTP 401');
          })
        }
      }))
    ).rejects.toThrow('Subscription listing failed with HTTP 401');
  });

  it('AZ-TELEMETRY-001: emitted payload uses the azure-spec-discovery action name and no Azure fixture values', () => {
    const calls: Array<{ url: string; body: string }> = [];
    const transport = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return { ok: true, status: 200 } as Response;
    });
    const telemetry = createTelemetryContext({
      action: 'azure-spec-discovery',
      env: {},
      transport: transport as unknown as typeof fetch
    });
    telemetry.setTeamId('10490519');
    telemetry.emitCompletion('success');

    expect(calls.length).toBeLessThanOrEqual(1);
    if (calls.length === 1) {
      expect(calls[0]?.body).toContain('azure-spec-discovery');
      expect(calls[0]?.body).not.toContain('/subscriptions/');
      expect(calls[0]?.body).not.toContain('aaaaaaaa-1111');
    }
  });
});
