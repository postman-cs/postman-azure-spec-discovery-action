import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAzureResolverBinding } from '../src/lib/repo/azure-bindings.js';
import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';

describe('azure resolver bindings (R1)', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function makeRoot(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'az-bind-'));
    await mkdir(path.join(root, '.postman'), { recursive: true });
    return root;
  }

  it('R1-BIND-001: reads compatible azure seam from .postman/resources.yaml', async () => {
    const repo = await makeRoot();
    await writeFile(
      path.join(repo, '.postman/resources.yaml'),
      [
        'version: 2',
        'workspace: ws-1',
        'azure:',
        '  environment: prod',
        '  apimApiId: /subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments',
        '  gatewayId: edge-1',
        '  apiVersion: v1',
        '  apiRevision: "3"',
        '  nativeSpecPath: openapi/openapi.yaml',
        '  apiCenterDefinitionId: /subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/a/versions/v1/definitions/openapi',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await loadAzureResolverBinding(repo);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.binding.environment).toBe('prod');
    expect(result.binding.apimApiId).toContain('/apis/payments');
    expect(result.binding.gatewayId).toBe('edge-1');
    expect(result.binding.apiVersion).toBe('v1');
    expect(result.binding.apiRevision).toBe('3');
    expect(result.binding.nativeSpecPath).toBe('openapi/openapi.yaml');
    expect(result.binding.apiCenterDefinitionId).toContain('ApiCenter');
    expect(result.binding.source).toBe('resources.yaml');
  });

  it('R1-BIND-002: falls back to dedicated .postman/azure-bindings.yaml only when resources.yaml has no azure seam', async () => {
    const repo = await makeRoot();
    await writeFile(path.join(repo, '.postman/resources.yaml'), 'version: 2\nworkspace: ws-1\n', 'utf8');
    await writeFile(
      path.join(repo, '.postman/azure-bindings.yaml'),
      'environment: staging\napimApiId: /subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/orders\n',
      'utf8'
    );

    const result = await loadAzureResolverBinding(repo);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.binding.source).toBe('azure-bindings.yaml');
    expect(result.binding.environment).toBe('staging');
    expect(result.binding.apimApiId).toContain('/apis/orders');
  });

  it('R1-BIND-003: rejects path escape and out-of-root symlink for nativeSpecPath', async () => {
    const repo = await makeRoot();
    await writeFile(
      path.join(repo, '.postman/resources.yaml'),
      'azure:\n  nativeSpecPath: ../outside.yaml\n',
      'utf8'
    );
    const escape = await loadAzureResolverBinding(repo);
    expect(escape.status).toBe('error');
    if (escape.status === 'error') {
      expect(escape.reason).toMatch(/within repo-root|must stay within/i);
    }

    const linked = await makeRoot();
    const outside = await mkdtemp(path.join(tmpdir(), 'az-bind-out-'));
    await writeFile(path.join(outside, 'secret.yaml'), 'openapi: 3.0.3\n', 'utf8');
    await symlink(path.join(outside, 'secret.yaml'), path.join(linked, 'linked-spec.yaml'));
    await writeFile(
      path.join(linked, '.postman/resources.yaml'),
      'azure:\n  nativeSpecPath: linked-spec.yaml\n',
      'utf8'
    );
    const symlinkResult = await loadAzureResolverBinding(linked);
    expect(symlinkResult.status).toBe('error');
    if (symlinkResult.status === 'error') {
      expect(symlinkResult.reason).toMatch(/symbolic link/i);
    }
    await rm(outside, { recursive: true, force: true });
  });

  it('R1-BIND-004: conflicting duplicate azure bindings fail closed', async () => {
    const repo = await makeRoot();
    await writeFile(
      path.join(repo, '.postman/resources.yaml'),
      [
        'azure:',
        '  - environment: prod',
        '    apimApiId: /subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/a',
        '  - environment: staging',
        '    apimApiId: /subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/b',
        ''
      ].join('\n'),
      'utf8'
    );
    const result = await loadAzureResolverBinding(repo);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.reason).toMatch(/conflict|duplicate|ambiguous/i);
    }
  });

  it('R1-BIND-006: an exact nativeSpecPath resolves before local IaC or cloud discovery', async () => {
    const repo = await makeRoot();
    await mkdir(path.join(repo, 'contracts'), { recursive: true });
    await writeFile(
      path.join(repo, 'contracts', 'payments-contract.yaml'),
      'openapi: 3.0.3\ninfo: { title: Payments, version: 1.0.0 }\npaths:\n  /payments:\n    get:\n      responses:\n        "200": { description: ok }\n',
      'utf8'
    );
    await writeFile(path.join(repo, '.postman', 'resources.yaml'), 'azure:\n  nativeSpecPath: contracts/payments-contract.yaml\n', 'utf8');
    const reporter: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: { get: async () => { throw new Error('cloud discovery must not run'); }, list: async () => [] },
      createApimClient: () => { throw new Error('cloud discovery must not run'); },
      createAppServiceClient: () => { throw new Error('cloud discovery must not run'); },
      writeSpecFile: async () => undefined
    };
    const result = await execute(resolveInputs({ INPUT_REPO_ROOT: repo }), dependencies);
    expect(result.resolution).toMatchObject({ status: 'resolved', sourceType: 'repo-spec', specPath: 'contracts/payments-contract.yaml' });
  });

  it('R2-BIND-001: conflicting api-center-definition-id input and binding refuses to choose', async () => {
    const repo = await makeRoot();
    const defA =
      '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/a/versions/v1/definitions/openapi';
    const defB =
      '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/a/versions/v2/definitions/openapi';
    await writeFile(
      path.join(repo, '.postman/resources.yaml'),
      `azure:\n  apiCenterDefinitionId: ${defA}\n`,
      'utf8'
    );
    const reporter: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: async (subscriptionId) => ({ subscriptionId, state: 'Enabled' }),
        list: async () => [{ subscriptionId: 'sub', state: 'Enabled' }]
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: async () => undefined,
      providers: []
    };
    await expect(
      execute(
        resolveInputs({
          INPUT_REPO_ROOT: repo,
          INPUT_SUBSCRIPTION_ID: 'sub',
          INPUT_API_CENTER_DEFINITION_ID: defB
        }),
        dependencies
      )
    ).rejects.toThrow(/Conflicting api-center-definition-id/);
  });

  it('R2-BIND-002: exact apiCenterDefinitionId binding selects and exports the API Center candidate', async () => {
    const repo = await makeRoot();
    const defId =
      '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v1/definitions/openapi';
    const otherId =
      '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v2/definitions/openapi';
    await writeFile(
      path.join(repo, '.postman/resources.yaml'),
      `azure:\n  apiCenterDefinitionId: ${defId}\n`,
      'utf8'
    );
    const openapi = `${JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Echo', version: '1.0.0' },
      paths: { '/echo': { get: { responses: { '200': { description: 'ok' } } } } }
    })}\n`;
    const candidates: SpecCandidate[] = [
      {
        id: defId,
        name: 'echo-v1',
        providerType: 'api-center',
        apiId: defId,
        resourceGroup: 'rg',
        tags: {},
        supported: true,
        evidence: ['definition v1'],
        meta: {
          serviceName: 'ac',
          resourceGroup: 'rg',
          workspaceName: 'default',
          apiName: 'echo',
          versionName: 'v1',
          definitionName: 'openapi'
        }
      },
      {
        id: otherId,
        name: 'echo-v2',
        providerType: 'api-center',
        apiId: otherId,
        resourceGroup: 'rg',
        tags: {},
        supported: true,
        evidence: ['definition v2'],
        meta: {
          serviceName: 'ac',
          resourceGroup: 'rg',
          workspaceName: 'default',
          apiName: 'echo',
          versionName: 'v2',
          definitionName: 'openapi'
        }
      }
    ];
    const exportSpec = vi.fn(async (candidate: SpecCandidate) => ({
      content: openapi,
      format: 'openapi-json' as const,
      filename: 'index.json',
      contractClass: 'authoritative' as const,
      evidence: [`exported ${candidate.id}`]
    }));
    const provider: SpecProvider = {
      type: 'api-center',
      probe: vi.fn(async () => 'available' as const),
      listCandidates: vi.fn(async () => candidates),
      exportSpec
    };
    const reporter: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: async (subscriptionId) => ({ subscriptionId, state: 'Enabled' }),
        list: async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }]
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: async (outputPath, content) => {
        const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
        await mk(path.dirname(outputPath), { recursive: true });
        await wf(outputPath, content, 'utf8');
      },
      providers: [provider]
    };
    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repo, INPUT_SUBSCRIPTION_ID: 'sub-1' }),
      dependencies
    );
    expect(result.resolution).toMatchObject({
      status: 'resolved',
      sourceType: 'api-center-export',
      providerType: 'api-center',
      apiId: defId,
      contractClass: 'authoritative',
      confidence: 100
    });
    expect(exportSpec).toHaveBeenCalledTimes(1);
    expect(exportSpec.mock.calls[0]?.[0]?.id).toBe(defId);
  });
});
