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
      subscriptions: { listEnabledSubscriptions: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }]) },
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

  it('AZ-CONTRACT-004: output-dir escaping repo root rejects with the exact message and writes nothing', async () => {
    const provider = stubProvider([apimCandidate('payments', { tags: { 'postman:repo': 'org/payments' } })]);
    const escaping = inputs();
    escaping.repoContext = { provider: 'github', repoSlug: 'org/payments' };
    escaping.outputDir = '../escape';
    await expect(execute(escaping, dependencies(provider))).rejects.toThrow(
      'output-dir must stay within repo-root/workspace; received'
    );
    await expect(stat(path.join(path.dirname(repoRoot), 'escape'))).rejects.toThrow();
  });

  it('unsupported-only candidates go to manual review without export attempts', async () => {
    const provider = stubProvider([apimCandidate('soap-only', { supported: false, tags: { 'postman:repo': 'org/soap-only' } })]);
    const withSlug = inputs();
    withSlug.repoContext = { provider: 'github', repoSlug: 'org/soap-only' };
    const result = await execute(withSlug, dependencies(provider));
    expect(result.resolution?.status).toBe('unresolved');
    expect(provider.exportSpec).not.toHaveBeenCalled();
  });
});
