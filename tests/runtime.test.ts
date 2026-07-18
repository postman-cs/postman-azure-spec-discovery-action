import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execute, resolveInputs, type AzureDependencies, type ReporterLike, type ResolvedInputs } from '../src/runtime.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';

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

function stubProvider(candidates: SpecCandidate[], content = VALID_OPENAPI): SpecProvider {
  return {
    type: 'apim',
    probe: vi.fn(async () => 'available' as const),
    listCandidates: vi.fn(async () => candidates),
    exportSpec: vi.fn(async () => ({
      content,
      format: 'openapi-json' as const,
      filename: 'index.json' as const,
      evidence: ['stub export']
    }))
  };
}

function apimCandidate(shortId: string, overrides: Partial<SpecCandidate> = {}): SpecCandidate {
  const armId = `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/${shortId}`;
  return {
    id: armId,
    name: shortId,
    providerType: 'apim',
    apiId: armId,
    resourceGroup: 'rg',
    tags: {},
    supported: true,
    evidence: [],
    meta: {},
    ...overrides
  };
}

describe('runtime execute', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-runtime-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function inputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
    return resolveInputsFor({ INPUT_REPO_ROOT: repoRoot, INPUT_SUBSCRIPTION_ID: 'sub-1', ...envOverrides(overrides) }, overrides);
  }

  function envOverrides(overrides: Partial<ResolvedInputs>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (overrides.mode) env.INPUT_MODE = overrides.mode;
    if (overrides.apiId) env.INPUT_API_ID = overrides.apiId;
    if (overrides.expectedServiceName) env.INPUT_EXPECTED_SERVICE_NAME = overrides.expectedServiceName;
    return env;
  }

  function resolveInputsFor(env: NodeJS.ProcessEnv, overrides: Partial<ResolvedInputs>): ResolvedInputs {
    const resolved = resolveInputs(env);
    return { ...resolved, ...overrides, repoRoot, repoContext: overrides.repoContext ?? resolved.repoContext };
  }

  function dependencies(provider: SpecProvider): AzureDependencies {
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
      providers: [provider]
    };
  }

  it('repo spec wins before any provider is consulted', async () => {
    await writeFile(path.join(repoRoot, 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: x\n  version: "1"\npaths:\n  /a: {}\n');
    const provider = stubProvider([apimCandidate('payments')]);
    const result = await execute(inputs(), dependencies(provider));
    expect(result.resolution?.sourceType).toBe('repo-spec');
    expect(provider.listCandidates).not.toHaveBeenCalled();
    expect(result.outputs['resolution-status']).toBe('resolved');
  });

  it('explicit api-id is a caller selection with confidence 100', async () => {
    const provider = stubProvider([apimCandidate('payments'), apimCandidate('orders')]);
    const armId = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments';
    const result = await execute(inputs({ apiId: armId }), dependencies(provider));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.confidence).toBe(100);
    expect(result.resolution?.apiId).toBe(armId);
    expect(result.outputs['api-id']).toBe(armId);
    const specFile = path.join(repoRoot, 'discovered-specs', 'payments', 'index.json');
    await expect(stat(specFile)).resolves.toBeDefined();
    const written = await readFile(specFile, 'utf8');
    expect(written).toBe(VALID_OPENAPI);
  });

  it('short api-id matches the terminal ARM segment', async () => {
    const provider = stubProvider([apimCandidate('payments')]);
    const result = await execute(inputs({ apiId: 'payments' }), dependencies(provider));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.confidence).toBe(100);
  });

  it('single canonical tag match auto-selects with confidence 100', async () => {
    const tagged = apimCandidate('payments', { tags: { 'postman:repo': 'org/payments' } });
    const provider = stubProvider([tagged, apimCandidate('orders')]);
    const withSlug = inputs();
    withSlug.repoContext = { provider: 'github', repoSlug: 'org/payments' };
    const result = await execute(withSlug, dependencies(provider));
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.confidence).toBe(100);
    expect(result.resolution?.narrowing?.mode).toBe('select');
    expect(result.outputs['narrowing-strategy']).toBe('tag-prefilter');
  });

  it('AZ-GRAPH-001: production runtime issues one paged candidate query and enriches enumerated candidates', async () => {
    const candidate = apimCandidate('payments');
    const provider = stubProvider([candidate, apimCandidate('orders')]);
    const queryResources = vi.fn(async (subscriptionId: string, kql: string) => {
      expect(subscriptionId).toBe('sub-1');
      expect(kql).toContain('Resources');
      return [
        {
          id: candidate.id,
          name: candidate.name,
          type: 'microsoft.apimanagement/service/apis',
          resourceGroup: candidate.resourceGroup ?? 'rg',
          tags: { 'postman:repo': 'org/payments' }
        }
      ];
    });
    const deps = dependencies(provider);
    deps.createResourceGraphClient = () => ({ queryResources });
    const withSlug = inputs();
    withSlug.repoContext = { provider: 'github', repoSlug: 'org/payments' };

    const result = await execute(withSlug, deps);
    expect(queryResources).toHaveBeenCalledTimes(1);
    expect(result.resolution).toMatchObject({ status: 'resolved', confidence: 100 });
  });

  it('ambiguous equal-confidence candidates produce manual-review with ranked candidates', async () => {
    const provider = stubProvider([apimCandidate('payments-a'), apimCandidate('payments-b')]);
    const withHint = inputs({ expectedServiceName: 'payments' });
    const result = await execute(withHint, dependencies(provider));
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.rankedCandidates?.length).toBe(2);
    expect(JSON.parse(result.outputs['candidates-json'] as string)).toHaveLength(2);
    expect(provider.exportSpec).not.toHaveBeenCalled();
  });

  it('discover-many exports every supported candidate and reports the summary', async () => {
    const provider = stubProvider([
      apimCandidate('payments', { tags: { 'postman:project-name': 'payments' } }),
      apimCandidate('orders'),
      apimCandidate('soap-api', { supported: false })
    ]);
    const result = await execute(inputs({ mode: 'discover-many' }), dependencies(provider));
    expect(result.discovered).toHaveLength(2);
    expect(result.exportSummary).toEqual({ attempted: 2, exported: 2, failed: 0, skipped: 1 });
    expect(result.outputs['source-type']).toBe('discover-many');
    expect(result.outputs['service-count']).toBe('2');
    expect(result.outputs['resolution-status']).toBe('resolved');
  });

  it('AZ-NARROW-006/R5.AC6: canonical-tag match at position 70 of 75 survives the 50 cap and summary.skipped includes the 25 capped', async () => {
    const candidates: SpecCandidate[] = [];
    for (let i = 0; i < 75; i += 1) {
      candidates.push(apimCandidate(`api-${String(i).padStart(2, '0')}`));
    }
    candidates[69] = apimCandidate('target', { tags: { 'postman:repo': 'org/target' } });
    const provider = stubProvider(candidates);
    const withSlug = inputs({ mode: 'discover-many' });
    withSlug.repoContext = { provider: 'github', repoSlug: 'org/target' };
    const result = await execute(withSlug, dependencies(provider));
    // The tag-selected candidate is partitioned first, so it is inside the executed cap.
    expect(result.discovered.some((service) => service.serviceName === 'org/target' || service.apiId?.endsWith('/target'))).toBe(true);
    // 75 enumerated - 50 executed = 25 capped, all counted as skipped.
    const summary = JSON.parse(result.outputs['export-summary-json'] as string) as { attempted: number; skipped: number };
    expect(result.discovered).toHaveLength(50);
    expect(summary.attempted).toBe(50);
    expect(summary.skipped).toBe(25);
  });

  it('explicit full ARM api-id does not match a same-named API in another service', async () => {
    const requested = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments';
    const otherService = apimCandidate('payments', {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/OTHER/apis/payments',
      apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/OTHER/apis/payments'
    });
    const provider = stubProvider([otherService]);
    const result = await execute(inputs({ apiId: requested }), dependencies(provider));
    expect(result.resolution?.status).toBe('unresolved');
    expect(provider.exportSpec).not.toHaveBeenCalled();
  });

  it('bare-name api-id matching more than one short name stays unresolved', async () => {
    const a = apimCandidate('payments', {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svcA/apis/payments',
      apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svcA/apis/payments'
    });
    const b = apimCandidate('payments', {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svcB/apis/payments',
      apiId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svcB/apis/payments'
    });
    const provider = stubProvider([a, b]);
    const result = await execute(inputs({ apiId: 'payments' }), dependencies(provider));
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.rankedCandidates?.length).toBe(2);
    expect(provider.exportSpec).not.toHaveBeenCalled();
  });

  it('candidate cap does not fabricate uniqueness for tied candidates', async () => {
    const provider = stubProvider([apimCandidate('payments-a'), apimCandidate('payments-b')]);
    const withHint = inputs({ expectedServiceName: 'payments' });
    withHint.maxCandidates = 1;
    const result = await execute(withHint, dependencies(provider));
    // Ranking runs across all candidates, so the tie is still detected as ambiguous
    // even though only one candidate view is serialized under the cap.
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(provider.exportSpec).not.toHaveBeenCalled();
  });

  it('resolve-one fails loudly when the resolved candidate export throws', async () => {
    const tagged = apimCandidate('payments', { tags: { 'postman:repo': 'org/payments' } });
    const provider = stubProvider([tagged, apimCandidate('orders')]);
    provider.exportSpec = vi.fn(async () => {
      throw new Error('SAS link expired');
    });
    const withSlug = inputs();
    withSlug.repoContext = { provider: 'github', repoSlug: 'org/payments' };
    await expect(execute(withSlug, dependencies(provider))).rejects.toThrow('Export failed for resolved candidate');
  });

  it('discover-many fails an export whose path collides with an earlier one', async () => {
    const a = apimCandidate('a', { tags: { 'postman:project-name': 'shared' } });
    const b = apimCandidate('b', { tags: { 'postman:project-name': 'shared' } });
    const provider = stubProvider([a, b]);
    const result = await execute(inputs({ mode: 'discover-many' }), dependencies(provider));
    // Both derive folder "shared"; the second is failed, not silently overwritten.
    expect(result.exportSummary?.exported).toBe(1);
    expect(result.exportSummary?.failed).toBe(1);
    expect(result.discovered).toHaveLength(1);
    expect(result.outputs['resolution-status']).toBe('unresolved');
  });
});

describe('probe resilience', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-probe-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function probeDependencies(providers: SpecProvider[]): AzureDependencies {
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
      writeSpecFile: vi.fn(async () => undefined),
      providers
    };
  }

  function probeInputs(): ResolvedInputs {
    const resolved = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_SUBSCRIPTION_ID: 'sub-1' });
    return { ...resolved, repoRoot };
  }

  it('AZ-PROBE-001: a throwing probe degrades to skipped:error without blocking other providers', async () => {
    const healthy = stubProvider([apimCandidate('payments', { tags: {} })]);
    const broken: SpecProvider = {
      type: 'custom-apis',
      probe: vi.fn(async () => {
        throw new Error('probe exploded');
      }),
      listCandidates: vi.fn(async () => []),
      exportSpec: vi.fn(async () => {
        throw new Error('never called');
      })
    };
    const result = await execute(probeInputs(), probeDependencies([broken, healthy]));
    const probes = result.resolution?.providerProbes ?? [];
    expect(probes).toEqual([
      { provider: 'custom-apis', status: 'skipped:error' },
      { provider: 'apim', status: 'available' }
    ]);
    expect(healthy.listCandidates).toHaveBeenCalled();
    expect(broken.listCandidates).not.toHaveBeenCalled();
  });

  it('AZ-PROBE-002: probes run concurrently, not serially', async () => {
    let concurrent = 0;
    let peak = 0;
    const slowProbe = async (): Promise<'available'> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 25));
      concurrent -= 1;
      return 'available';
    };
    const a: SpecProvider = { type: 'apim', probe: slowProbe, listCandidates: vi.fn(async () => []), exportSpec: vi.fn() };
    const b: SpecProvider = { type: 'app-service', probe: slowProbe, listCandidates: vi.fn(async () => []), exportSpec: vi.fn() };
    const c: SpecProvider = { type: 'custom-apis', probe: slowProbe, listCandidates: vi.fn(async () => []), exportSpec: vi.fn() };
    await execute(probeInputs(), probeDependencies([a, b, c]));
    expect(peak).toBeGreaterThanOrEqual(2);
  });
});
