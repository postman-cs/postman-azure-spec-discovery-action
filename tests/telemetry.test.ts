import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

import { runAction, type CoreLike } from '../src/index.js';
import type { AzureDependencies } from '../src/runtime.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import {
  prepareTelemetryCredentials,
  TELEMETRY_ENRICHMENT_TIMEOUT_MS
} from '../src/lib/postman/telemetry-credentials.js';

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
    providers: [provider],
    ...overrides
  };
}

describe('telemetry contract', () => {
  it('bounds never-settling account-type enrichment and aborts its request', async () => {
    vi.useFakeTimers();
    __resetIdentityMemo();
    let signal: AbortSignal | undefined;
    try {
      const pending = prepareTelemetryCredentials({
        postmanAccessToken: 'access-token',
        fetchImpl: vi.fn((_input, init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch
      });

      await vi.advanceTimersByTimeAsync(TELEMETRY_ENRICHMENT_TIMEOUT_MS);
      const result = await pending;
      expect(result.accountType).toBeUndefined();
      expect(signal?.aborted).toBe(true);
    } finally {
      __resetIdentityMemo();
      vi.useRealTimers();
    }
  });

  it('resolves access-token account type before the enrichment deadline', async () => {
    vi.useFakeTimers();
    __resetIdentityMemo();
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        session: { consumerType: 'service' }
      }), { status: 200 }));

      await expect(prepareTelemetryCredentials({
        postmanAccessToken: 'access-token',
        fetchImpl: fetchImpl as typeof fetch
      })).resolves.toMatchObject({ accountType: 'service' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      __resetIdentityMemo();
      vi.useRealTimers();
    }
  });

  it('keeps the action live when account-type enrichment never settles', async () => {
    vi.useFakeTimers();
    __resetIdentityMemo();
    const previousOptOut = process.env.POSTMAN_ACTIONS_TELEMETRY;
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    const localDeps = deps();
    const actionCore = coreStub();
    process.env.INPUT_POSTMAN_ACCESS_TOKEN = 'access-token';
    try {
      process.env.POSTMAN_ACTIONS_TELEMETRY = 'off';
      globalThis.fetch = vi.fn((_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch;

      const pending = runAction(actionCore, localDeps);
      await vi.waitFor(() => expect(signal).toBeDefined());
      await vi.advanceTimersByTimeAsync(TELEMETRY_ENRICHMENT_TIMEOUT_MS);
      await expect(pending).resolves.toEqual([]);
      expect(localDeps.providers?.[0]?.probe).toHaveBeenCalledTimes(1);
      expect(localDeps.providers?.[0]?.listCandidates).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      if (previousOptOut === undefined) {
        delete process.env.POSTMAN_ACTIONS_TELEMETRY;
      } else {
        process.env.POSTMAN_ACTIONS_TELEMETRY = previousOptOut;
      }
      delete process.env.INPUT_POSTMAN_ACCESS_TOKEN;
      globalThis.fetch = originalFetch;
      __resetIdentityMemo();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

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
          get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
          list: vi.fn(async () => {
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

  it('AZ-TELEMETRY-001: a rejecting or throwing transport never surfaces to the caller', async () => {
    // Rejecting transport (network failure shape).
    const rejecting = vi.fn(async () => {
      throw new Error('ECONNREFUSED events.pm-cse.dev');
    });
    const rejectingContext = createTelemetryContext({
      action: 'azure-spec-discovery',
      env: {},
      transport: rejecting as unknown as typeof fetch
    });
    rejectingContext.setTeamId('10490519');
    expect(() => rejectingContext.emitCompletion('success')).not.toThrow();
    // Fire-and-forget: give the rejected promise a tick to settle unhandled.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejecting).toHaveBeenCalledTimes(1);

    // Synchronously throwing transport.
    const throwing = vi.fn(() => {
      throw new Error('synchronous transport crash');
    });
    const throwingContext = createTelemetryContext({
      action: 'azure-spec-discovery',
      env: {},
      transport: throwing as unknown as typeof fetch
    });
    throwingContext.setTeamId('10490519');
    expect(() => throwingContext.emitCompletion('failure')).not.toThrow();
  });
});
