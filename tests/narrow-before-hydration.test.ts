import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execute, resolveInputs, type AzureDependencies, type ReporterLike, type ResolvedInputs } from '../src/runtime.js';
import type { SpecCandidate, SpecCandidateHeader, SpecProvider } from '../src/lib/providers/types.js';
import { adaptLegacyProvider } from '../src/lib/providers/types.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

function candidate(
  providerType: SpecCandidate['providerType'],
  shortId: string,
  overrides: Partial<SpecCandidate> = {}
): SpecCandidate {
  const armId =
    overrides.id ??
    `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Test/${providerType}/${shortId}`;
  return {
    id: armId,
    name: shortId,
    providerType,
    resourceGroup: 'rg',
    tags: { 'postman:repo': 'acme/payments' },
    supported: true,
    evidence: [`header ${shortId}`],
    meta: {},
    ...overrides
  };
}

function baseDeps(providers: SpecProvider[]): AzureDependencies {
  return {
    core: reporter,
    subscriptions: {
      get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
      list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
    },
    createApimClient: () => {
      throw new Error('not used with injected providers');
    },
    createAppServiceClient: () => {
      throw new Error('not used with injected providers');
    },
    writeSpecFile: async (outputPath, content) => {
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(path.dirname(outputPath), { recursive: true });
      await wf(outputPath, content, 'utf8');
    },
    providers
  };
}

describe('narrow-before-hydration (R7 / POS-400)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-r7-'));
    await writeFile(
      path.join(repoRoot, 'README.md'),
      'repo\n',
      'utf8'
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function inputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
    const resolved = resolveInputs({
      INPUT_REPO_ROOT: repoRoot,
      INPUT_SUBSCRIPTION_ID: 'sub-1',
      INPUT_MODE: overrides.mode ?? 'resolve-one',
      ...(overrides.maxCandidates !== undefined ? { INPUT_MAX_CANDIDATES: String(overrides.maxCandidates) } : {}),
      ...(overrides.apiId ? { INPUT_API_ID: overrides.apiId } : {})
    });
    return {
      ...resolved,
      ...overrides,
      repoRoot,
      repoContext: {
        ...resolved.repoContext,
        repoSlug: 'acme/payments',
        ...(overrides.repoContext ?? {})
      }
    };
  }

  it('AZ-R7-010: resolve-one enumerates all headers but hydrates only the unique selected candidate', async () => {
    const detailSpies = {
      logic: vi.fn(),
      functions: vi.fn(),
      apim: vi.fn()
    };

    const logicHeaders = Array.from({ length: 40 }, (_, i) =>
      candidate('logic-apps', `wf-${String(i).padStart(3, '0')}`, {
        tags: {},
        supported: true,
        evidence: [`logic header ${i}`]
      })
    );
    const winner = candidate('logic-apps', 'wf-winner', {
      tags: { 'postman:repo': 'acme/payments' },
      evidence: ['logic winner header']
    });
    const functionHeaders = Array.from({ length: 30 }, (_, i) =>
      candidate('function-bindings', `fn-${i}`, {
        id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/fn-${i}/functions`,
        tags: {},
        evidence: [`fn header ${i}`]
      })
    );
    const apimHeaders: SpecCandidateHeader[] = Array.from({ length: 20 }, (_, i) => ({
      ...candidate('apim', `api-${i}`, {
        id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/api-${i}`,
        apiId: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/api-${i}`,
        tags: {}
      }),
      headerHydrated: true
    }));

    const logicProvider: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => {
        throw new Error('listCandidates must not be used by resolve-one when headers exist');
      }),
      listCandidateHeaders: vi.fn(async () =>
        [...logicHeaders, winner].map((c) => ({ ...c, headerHydrated: false }))
      ),
      hydrateCandidates: vi.fn(async (headers: SpecCandidateHeader[]) => {
        for (const header of headers) detailSpies.logic(header.id);
        return headers.map((header) => ({ ...header, evidence: [...header.evidence, 'hydrated'] }));
      }),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['logic export']
      }))
    };

    const functionsProvider: SpecProvider = {
      type: 'function-bindings',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => {
        throw new Error('listCandidates must not be used by resolve-one when headers exist');
      }),
      listCandidateHeaders: vi.fn(async () =>
        functionHeaders.map((c) => ({ ...c, headerHydrated: false }))
      ),
      hydrateCandidates: vi.fn(async (headers: SpecCandidateHeader[]) => {
        for (const header of headers) detailSpies.functions(header.id);
        return headers.map((header) => ({ ...header, evidence: [...header.evidence, 'hydrated'] }));
      }),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['fn export']
      }))
    };

    const apimProvider: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => apimHeaders),
      listCandidateHeaders: vi.fn(async () =>
        apimHeaders.map((c) => ({ ...c, headerHydrated: true }))
      ),
      hydrateCandidates: vi.fn(async (headers) => {
        for (const header of headers) detailSpies.apim(header.id);
        return headers;
      }),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['apim export']
      }))
    };

    const result = await execute(inputs(), baseDeps([logicProvider, functionsProvider, apimProvider]));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.providerType).toBe('logic-apps');
    expect(logicProvider.listCandidateHeaders).toHaveBeenCalled();
    expect(functionsProvider.listCandidateHeaders).toHaveBeenCalled();
    expect(apimProvider.listCandidateHeaders).toHaveBeenCalled();
    expect(detailSpies.logic).toHaveBeenCalledTimes(1);
    expect(detailSpies.logic).toHaveBeenCalledWith(winner.id);
    expect(detailSpies.functions).toHaveBeenCalledTimes(0);
    expect(detailSpies.apim).toHaveBeenCalledTimes(0);
    expect(logicProvider.exportSpec).toHaveBeenCalledTimes(1);
  });

  it('AZ-R7-011: equal top headers hydrate the minimal tied set and stay ambiguous if the tie persists', async () => {
    const a = candidate('logic-apps', 'twin-a', {
      tags: { 'postman:repo': 'acme/payments' },
      name: 'twin-a'
    });
    const b = candidate('logic-apps', 'twin-b', {
      tags: { 'postman:repo': 'acme/payments' },
      name: 'twin-b'
    });
    const hydrate = vi.fn(async (headers: SpecCandidateHeader[]) =>
      headers.map((header) => ({ ...header, evidence: [...header.evidence, 'hydrated'] }))
    );
    const provider: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => [a, b]),
      listCandidateHeaders: vi.fn(async () => [
        { ...a, headerHydrated: false },
        { ...b, headerHydrated: false }
      ]),
      hydrateCandidates: hydrate,
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };

    const result = await execute(inputs(), baseDeps([provider]));
    expect(result.resolution?.status).toBe('unresolved');
    expect(hydrate).toHaveBeenCalledTimes(1);
    const hydratedIds = (hydrate.mock.calls[0]?.[0] ?? []).map((header: SpecCandidateHeader) => header.id).sort();
    expect(hydratedIds).toEqual([a.id, b.id].sort());
    expect(provider.exportSpec).not.toHaveBeenCalled();
    expect(result.resolution?.rankedCandidates?.length).toBeGreaterThanOrEqual(2);
  });

  it('AZ-R7-012: discover-many hydrates only the post-partition/cap set', async () => {
    const headers = Array.from({ length: 10 }, (_, i) =>
      candidate('logic-apps', `wf-${i}`, {
        tags: i < 3 ? { 'postman:repo': 'acme/payments' } : {},
        supported: true
      })
    );
    const hydrate = vi.fn(async (selected: SpecCandidateHeader[]) =>
      selected.map((header) => ({ ...header, evidence: [...header.evidence, 'hydrated'] }))
    );
    const provider: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => {
        throw new Error('discover-many must use headers + bounded hydration');
      }),
      listCandidateHeaders: vi.fn(async () => headers.map((c) => ({ ...c, headerHydrated: false }))),
      hydrateCandidates: hydrate,
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };

    const result = await execute(inputs({ mode: 'discover-many', maxCandidates: 2 }), baseDeps([provider]));
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result.discovered.length).toBe(2);
    expect(result.exportSummary?.exported).toBe(2);
  });

  it('AZ-R7-013: out-of-order async providers yield stable candidate ordering', async () => {
    const logicId = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/slow';
    const apimId =
      '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/fast';
    const slow: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => []),
      listCandidateHeaders: vi.fn(
        () =>
          new Promise<SpecCandidateHeader[]>((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    ...candidate('logic-apps', 'slow', { id: logicId, tags: {} }),
                    headerHydrated: true
                  }
                ]),
              40
            );
          })
      ),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };
    const fast: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => []),
      listCandidateHeaders: vi.fn(async () => [
        {
          ...candidate('apim', 'fast', { id: apimId, apiId: apimId, tags: {} }),
          headerHydrated: true
        }
      ]),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };

    // Completion order is fast-then-slow; discovered order must be stable by
    // candidate id (not Promise settle order). Run twice with swapped timing.
    const resultA = await execute(inputs({ mode: 'discover-many', maxCandidates: 10 }), baseDeps([slow, fast]));
    const reverseSlow: SpecProvider = {
      ...fast,
      listCandidateHeaders: vi.fn(
        () =>
          new Promise<SpecCandidateHeader[]>((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    ...candidate('apim', 'fast', { id: apimId, apiId: apimId, tags: {} }),
                    headerHydrated: true
                  }
                ]),
              40
            );
          })
      )
    };
    const reverseFast: SpecProvider = {
      ...slow,
      listCandidateHeaders: vi.fn(async () => [
        { ...candidate('logic-apps', 'slow', { id: logicId, tags: {} }), headerHydrated: true }
      ])
    };
    const resultB = await execute(
      inputs({ mode: 'discover-many', maxCandidates: 10 }),
      baseDeps([reverseFast, reverseSlow])
    );
    expect(resultA.discovered.map((row) => row.specPath)).toEqual(resultB.discovered.map((row) => row.specPath));
    // ApiManagement ARM id sorts before Logic when tags do not reorder the partition.
    expect(resultA.discovered.map((row) => row.providerType)).toEqual(['apim', 'logic-apps']);
  });

  it('AZ-R7-014: unselected hydration failure is fail-soft; selected hydration/export fails hard', async () => {
    const winner: SpecCandidateHeader = {
      ...candidate('apim', 'winner', {
        id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/winner',
        apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/winner',
        tags: { 'postman:repo': 'acme/payments' }
      }),
      headerHydrated: true
    };

    const healthy: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => [winner]),
      listCandidateHeaders: vi.fn(async () => [{ ...winner, headerHydrated: true }]),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn(async () => {
        throw new Error('selected export boom');
      })
    };

    const brokenEnumerate: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => []),
      listCandidateHeaders: vi.fn(async () => {
        throw new Error('unselected enumerate boom');
      }),
      hydrateCandidates: vi.fn(async () => {
        throw new Error('unselected hydrate boom');
      }),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };

    await expect(execute(inputs(), baseDeps([healthy, brokenEnumerate]))).rejects.toThrow(/selected export boom|Export failed/i);
  });

  it('AZ-R7-015: probe timeout/failure remains fail-soft for unselected providers', async () => {
    const healthy = candidate('apim', 'only', {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/only',
      apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/only',
      tags: { 'postman:repo': 'acme/payments' }
    });
    const ok: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => [healthy]),
      listCandidateHeaders: vi.fn(async () => [{ ...healthy, headerHydrated: true }]),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['export']
      }))
    };
    const brokenProbe: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => {
        throw new Error('probe boom');
      }),
      listCandidates: vi.fn(async () => []),
      listCandidateHeaders: vi.fn(async () => []),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn()
    };

    const result = await execute(inputs(), baseDeps([ok, brokenProbe]));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.providerProbes?.find((p) => p.provider === 'logic-apps')?.status).toBe(
      'skipped:error'
    );
    expect(brokenProbe.listCandidateHeaders).not.toHaveBeenCalled();
  });

  it('AZ-R7-016: legacy injected providers without header methods still work via adapter', async () => {
    const only = candidate('apim', 'legacy', {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/legacy',
      apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/legacy',
      tags: { 'postman:repo': 'acme/payments' }
    });
    const legacy: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => [only]),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['legacy export']
      }))
    };
    const adapted = adaptLegacyProvider(legacy);
    expect(await adapted.listCandidateHeaders()).toHaveLength(1);
    expect((await adapted.listCandidateHeaders())[0]?.headerHydrated).toBe(true);

    const result = await execute(inputs(), baseDeps([legacy]));
    expect(result.resolution?.status).toBe('resolved');
    expect(legacy.listCandidates).toHaveBeenCalled();
    expect(legacy.exportSpec).toHaveBeenCalled();
  });

  it('AZ-R7-017: exact multi-subscription APIM selector still short-circuits without hydrating others', async () => {
    const targetId =
      '/subscriptions/sub-2/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments';
    const hydrateOther = vi.fn(async (headers: SpecCandidateHeader[]) => headers);
    const apim: SpecProvider = {
      type: 'apim',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => [
        candidate('apim', 'payments', {
          id: targetId,
          apiId: targetId,
          tags: {}
        })
      ]),
      listCandidateHeaders: vi.fn(async () => [
        {
          ...candidate('apim', 'payments', { id: targetId, apiId: targetId, tags: {} }),
          headerHydrated: true
        }
      ]),
      hydrateCandidates: vi.fn(async (headers) => headers),
      exportSpec: vi.fn(async () => ({
        content: VALID_OPENAPI,
        format: 'openapi-json' as const,
        filename: 'index.json',
        evidence: ['apim export']
      }))
    };
    const other: SpecProvider = {
      type: 'logic-apps',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => []),
      listCandidateHeaders: vi.fn(async () => [
        { ...candidate('logic-apps', 'other'), headerHydrated: false }
      ]),
      hydrateCandidates: hydrateOther,
      exportSpec: vi.fn()
    };

    const result = await execute(inputs({ apiId: targetId }), baseDeps([apim, other]));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.apiId).toBe(targetId);
    expect(hydrateOther).not.toHaveBeenCalled();
  });
});
