import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { runNarrowingPipeline, type NarrowingCandidate } from '../src/lib/resolve/narrowing-pipeline.js';
import { ApimProvider } from '../src/lib/providers/apim.js';
import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { AzureApimClient, ApimApiSummary, ApimServiceSummary } from '../src/lib/azure/clients.js';

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

const OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/pay': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function arm(api: string, rev?: string): string {
  const id = rev ? `${api};rev=${rev}` : api;
  return `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/contoso/apis/${id}`;
}

function service(overrides: Partial<ApimServiceSummary> = {}): ApimServiceSummary {
  return {
    name: 'contoso',
    resourceGroup: 'rg',
    tags: {},
    gatewayHostname: 'contoso.azure-api.net',
    customHostnames: [],
    gatewayAssignments: [],
    workspaceGateways: [],
    ...overrides
  };
}

function api(overrides: Partial<ApimApiSummary> & { apiId: string }): ApimApiSummary {
  return {
    displayName: overrides.apiId,
    apiType: 'http',
    isCurrent: true,
    path: overrides.path,
    serviceName: 'contoso',
    resourceGroup: 'rg',
    ...overrides
  };
}

function candidate(id: string, overrides: Partial<NarrowingCandidate> = {}): NarrowingCandidate {
  return { id, name: id.split('/').pop() ?? id, ...overrides };
}

describe('R1 gateway URL evidence', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('R1-URL-001: preserves normalized hostname + base path from azure-api.net and custom hosts', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'az-gw-url-'));
    await writeFile(
      path.join(root, 'README.md'),
      [
        'Gateway: https://Contoso.azure-api.net/payments/',
        'Custom: https://api.example.com/orders/v1',
        'Noise: https://example.com/docs'
      ].join('\n'),
      'utf8'
    );

    const signals = await collectRepoSignals({ repoRoot: root });
    expect(signals.gatewayUrls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: 'contoso.azure-api.net', basePath: 'payments', kind: 'azure-api-net' }),
        expect.objectContaining({ hostname: 'api.example.com', basePath: 'orders/v1', kind: 'https' })
      ])
    );
    // Arbitrary non-APIM URLs are evidence only — not select-grade by themselves.
    expect(signals.gatewayUrls.find((u) => u.hostname === 'example.com')?.kind).toBe('https');
  });
});

describe('R1 host+path and tag selection', () => {
  it('R1-HOST-001: exact default/custom gateway host + base path selects one API from multi-API service', async () => {
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: {
          serviceHints: [],
          explicitApiIdHints: [],
          inferredApiIdHints: [],
          evidence: [],
          gatewayUrls: [{ hostname: 'contoso.azure-api.net', basePath: 'payments', kind: 'azure-api-net' }]
        }
      },
      [
        candidate(arm('payments'), {
          apiPath: 'payments',
          hostnames: ['contoso.azure-api.net', 'api.contoso.com'],
          tagSource: 'service-inherited'
        }),
        candidate(arm('orders'), {
          apiPath: 'orders',
          hostnames: ['contoso.azure-api.net', 'api.contoso.com'],
          tagSource: 'service-inherited'
        })
      ]
    );
    expect(result?.mode).toBe('select');
    expect(result?.tier).toBe('gateway-host-path');
    expect(result?.apiIds).toEqual([arm('payments')]);
  });

  it('R1-HOST-002: host without path does not select a multi-API service', async () => {
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: {
          serviceHints: [],
          explicitApiIdHints: [],
          inferredApiIdHints: [],
          evidence: [],
          gatewayUrls: [{ hostname: 'contoso.azure-api.net', basePath: '', kind: 'azure-api-net' }]
        }
      },
      [
        candidate(arm('payments'), { apiPath: 'payments', hostnames: ['contoso.azure-api.net'] }),
        candidate(arm('orders'), { apiPath: 'orders', hostnames: ['contoso.azure-api.net'] })
      ]
    );
    expect(result?.mode).not.toBe('select');
  });

  it('R1-TAG-001: unique GithubOrg/GithubRepo tag selects; inherited service tag across two APIs narrows only', async () => {
    const githubOrgRepo = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      [
        candidate(arm('payments'), {
          tags: { GithubOrg: 'org', GithubRepo: 'payments' },
          tagSource: 'api'
        }),
        candidate(arm('orders'), { tags: {}, tagSource: 'api' })
      ]
    );
    expect(githubOrgRepo?.mode).toBe('select');
    expect(githubOrgRepo?.apiIds).toEqual([arm('payments')]);

    const inherited = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      [
        candidate(arm('payments'), {
          tags: { 'postman:repo': 'org/payments' },
          tagSource: 'service-inherited'
        }),
        candidate(arm('orders'), {
          tags: { 'postman:repo': 'org/payments' },
          tagSource: 'service-inherited'
        })
      ]
    );
    expect(inherited?.mode).toBe('narrow');
    expect(inherited?.apiIds.sort()).toEqual([arm('orders'), arm('payments')].sort());
  });

  it('R1-ENV-001: same repo across two environments is unresolved without selector and exact with selector', async () => {
    const candidates = [
      candidate(arm('payments-prod'), {
        tags: { 'postman:repo': 'org/payments', environment: 'prod' },
        tagSource: 'api',
        apiVersion: undefined
      }),
      candidate(arm('payments-staging'), {
        tags: { 'postman:repo': 'org/payments', environment: 'staging' },
        tagSource: 'api'
      })
    ];

    const unresolved = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      candidates
    );
    expect(unresolved?.mode).toBe('narrow');
    expect(unresolved?.evidence.join(' ')).toMatch(/environment/i);

    const selected = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        environment: 'prod',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      candidates
    );
    expect(selected?.mode).toBe('select');
    expect(selected?.apiIds).toEqual([arm('payments-prod')]);
  });

  it('R1-VER-001: version/revision multiplicity is unresolved; selectors disambiguate', async () => {
    const candidates = [
      candidate(arm('payments'), { apiPath: 'payments', apiVersion: 'v1', apiRevision: '1', hostnames: ['contoso.azure-api.net'] }),
      candidate(arm('payments-v2'), { apiPath: 'payments', apiVersion: 'v2', apiRevision: '1', hostnames: ['contoso.azure-api.net'] })
    ];
    const unresolved = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: {
          serviceHints: [],
          explicitApiIdHints: [],
          inferredApiIdHints: [],
          evidence: [],
          gatewayUrls: [{ hostname: 'contoso.azure-api.net', basePath: 'payments', kind: 'azure-api-net' }]
        }
      },
      candidates
    );
    expect(unresolved?.mode).toBe('narrow');
    expect(unresolved?.evidence.join(' ')).toMatch(/version/i);

    const selected = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        apiVersion: 'v2',
        serviceHints: [],
        signals: {
          serviceHints: [],
          explicitApiIdHints: [],
          inferredApiIdHints: [],
          evidence: [],
          gatewayUrls: [{ hostname: 'contoso.azure-api.net', basePath: 'payments', kind: 'azure-api-net' }]
        }
      },
      candidates
    );
    expect(selected?.mode).toBe('select');
    expect(selected?.apiIds).toEqual([arm('payments-v2')]);
  });

  it('R1-GW-001: gateway assignment narrows; managed is never a self-hosted gateway id', async () => {
    const narrowed = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        gatewayId: 'edge-1',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      [
        candidate(arm('payments'), { assignedGatewayIds: ['edge-1'] }),
        candidate(arm('orders'), { assignedGatewayIds: ['edge-2'] }),
        candidate(arm('shared'), { assignedGatewayIds: ['edge-1', 'edge-2'] })
      ]
    );
    expect(narrowed?.tier).toBe('gateway-assignment');
    expect(narrowed?.mode).toBe('narrow');
    expect(narrowed?.apiIds.sort()).toEqual([arm('payments'), arm('shared')].sort());

    const managed = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        gatewayId: 'managed',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      [candidate(arm('payments'), { assignedGatewayIds: ['edge-1'] })]
    );
    expect(managed?.tier).not.toBe('gateway-assignment');
  });
});

describe('R1 APIM metadata and explicit revision export', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('R1-TAG-002: sole supported API keeps select-grade inherited tags; unsupported siblings do not poison eligibility', async () => {
    const client: AzureApimClient = {
      listServices: vi.fn(async () => [
        service({ tags: { 'postman:repo': 'org/payments', GithubOrg: 'org', GithubRepo: 'payments' } })
      ]),
      listApis: vi.fn(async () => [
        api({ apiId: 'payments', path: 'payments', apiType: 'http' }),
        api({ apiId: 'events-ws', path: 'events', apiType: 'websocket' }),
        api({ apiId: 'orders-grpc', path: 'orders', apiType: 'grpc' })
      ]),
      exportApi: vi.fn(async () => OPENAPI),
      getGraphqlSchema: vi.fn(async () => 'type Query { x: String }'),
      getApi: vi.fn(async () => {
        throw new Error('unused');
      }),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };

    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(3);
    const payments = candidates.find((c) => c.meta.apiId === 'payments');
    expect(payments?.supported).toBe(true);
    expect(payments?.meta.tagSource).toBe('api');
    expect(payments?.tags['postman:repo']).toBe('org/payments');
    // Unsupported siblings remain listed but must not carry select-grade ownership tags.
    for (const unsupported of candidates.filter((c) => !c.supported)) {
      expect(unsupported.tags['postman:repo']).toBeUndefined();
      expect(unsupported.tags.GithubOrg).toBeUndefined();
      expect(unsupported.tags.GithubRepo).toBeUndefined();
    }

    const narrowed = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      candidates.map((c) =>
        candidate(c.apiId ?? c.id, {
          tags: c.tags,
          tagSource: c.meta.tagSource as 'api' | 'service-inherited' | undefined,
          apiPath: c.meta.path,
          hostnames: (c.meta.hostnames ?? '').split(',').filter(Boolean)
        })
      )
    );
    expect(narrowed?.mode).toBe('select');
    expect(narrowed?.apiIds).toEqual([arm('payments')]);
  });

  it('R1-TAG-003: two supported APIs keep service tags inherited/fail-closed (narrow, never select)', async () => {
    const client: AzureApimClient = {
      listServices: vi.fn(async () => [service({ tags: { 'postman:repo': 'org/payments' } })]),
      listApis: vi.fn(async () => [
        api({ apiId: 'payments', path: 'payments', apiType: 'http' }),
        api({ apiId: 'billing', path: 'billing', apiType: 'soap' })
      ]),
      exportApi: vi.fn(async () => OPENAPI),
      getGraphqlSchema: vi.fn(async () => 'type Query { x: String }'),
      getApi: vi.fn(async () => {
        throw new Error('unused');
      }),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };

    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates.every((c) => c.meta.tagSource === 'service-inherited')).toBe(true);

    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: [],
        signals: { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], gatewayUrls: [] }
      },
      candidates.map((c) =>
        candidate(c.apiId ?? c.id, {
          tags: c.tags,
          tagSource: 'service-inherited',
          apiPath: c.meta.path
        })
      )
    );
    expect(result?.mode).toBe('narrow');
    expect(result?.mode).not.toBe('select');
    expect(result?.apiIds.sort()).toEqual([arm('billing'), arm('payments')].sort());
  });

  it('R1-META-001: service/workspace/custom-hostname/self-hosted gateway metadata preserve identity and assignment', async () => {
    const client: AzureApimClient = {
      listServices: vi.fn(async () => [
        service({
          customHostnames: ['api.contoso.com'],
          gatewayAssignments: [{ gatewayId: 'edge-1', apiIds: ['payments'] }],
          workspaceGateways: [{ workspaceId: 'team-a', gatewayIds: ['ws-gw-1'] }]
        })
      ]),
      listApis: vi.fn(async () => [
        api({
          apiId: 'payments',
          path: 'payments',
          apiVersion: 'v1',
          apiRevision: '2',
          apiVersionSetId: '/sets/pay',
          assignedGatewayIds: ['edge-1']
        }),
        api({
          apiId: 'workspace-api',
          path: 'internal',
          workspaceId: 'team-a',
          assignedGatewayIds: ['ws-gw-1']
        })
      ]),
      exportApi: vi.fn(async () => OPENAPI),
      getGraphqlSchema: vi.fn(async () => 'type Query { x: String }'),
      getApi: vi.fn(async () => {
        throw new Error('unused');
      }),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };

    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    const payments = candidates.find((c) => c.meta.apiId === 'payments');
    expect(payments?.meta.path).toBe('payments');
    expect(payments?.meta.apiVersion).toBe('v1');
    expect(payments?.meta.apiRevision).toBe('2');
    expect(payments?.meta.hostnames).toContain('api.contoso.com');
    expect(payments?.meta.assignedGatewayIds).toContain('edge-1');
    expect(payments?.meta.tagSource).toBe('service-inherited');

    const workspace = candidates.find((c) => c.meta.apiId === 'workspace-api');
    expect(workspace?.meta.workspaceId).toBe('team-a');
    expect(workspace?.meta.assignedGatewayIds).toContain('ws-gw-1');
  });

  it('R1-REV-001: explicit ;rev=N exports historical revision; implicit discovery stays on current', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'az-rev-'));
    const historicalId = arm('payments', '1');
    const currentId = arm('payments');
    const client: AzureApimClient = {
      listServices: vi.fn(async () => [service()]),
      listApis: vi.fn(async () => [api({ apiId: 'payments', path: 'payments', isCurrent: true, apiRevision: '2' })]),
      exportApi: vi.fn(async (_rg, _svc, apiId) => {
        expect(apiId).toBe('payments;rev=1');
        return OPENAPI;
      }),
      getGraphqlSchema: vi.fn(async () => {
        throw new Error('unused');
      }),
      getApi: vi.fn(async () =>
        api({ apiId: 'payments;rev=1', path: 'payments', isCurrent: false, apiRevision: '1' })
      ),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (id) => ({ subscriptionId: id, state: 'Enabled' })),
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: () => client,
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: vi.fn(async () => undefined),
      providers: [provider]
    };

    const listed = await provider.listCandidates();
    expect(listed.map((c) => c.apiId)).toEqual([currentId]);

    const inputs = resolveInputs({
      INPUT_REPO_ROOT: root,
      INPUT_API_ID: historicalId,
      INPUT_SUBSCRIPTION_ID: 'sub-1'
    });
    const result = await execute(inputs, dependencies);
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.apiId).toBe(historicalId);
    expect(client.exportApi).toHaveBeenCalledWith('rg', 'contoso', 'payments;rev=1', undefined);
  });

  it('R1-REV-002: caller-selected historical revision must satisfy an explicit revision selector', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'az-rev-selector-'));
    const historicalId = arm('payments', '1');
    const client: AzureApimClient = {
      listServices: vi.fn(async () => [service()]),
      listApis: vi.fn(async () => [api({ apiId: 'payments', isCurrent: true, apiRevision: '2' })]),
      exportApi: vi.fn(async () => OPENAPI),
      getGraphqlSchema: vi.fn(async () => 'unused'),
      getApi: vi.fn(async () => api({ apiId: 'payments;rev=1', isCurrent: false, apiRevision: '1' })),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const result = await execute(
      resolveInputs({
        INPUT_REPO_ROOT: root,
        INPUT_API_ID: historicalId,
        INPUT_API_REVISION: '2',
        INPUT_SUBSCRIPTION_ID: 'sub-1'
      }),
      {
        core: reporter,
        subscriptions: { get: vi.fn(async (id) => ({ subscriptionId: id, state: 'Enabled' })), list: vi.fn(async () => []) },
        createApimClient: () => client,
        createAppServiceClient: () => { throw new Error('unused'); },
        writeSpecFile: vi.fn(async () => undefined),
        providers: [provider]
      }
    );
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.evidence.join(' ')).toMatch(/api-revision=2/);
    expect(client.exportApi).not.toHaveBeenCalled();
  });

  it('R1-BIND-005: .postman/resources.yaml exact binding wins over broader discovery', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'az-bind-win-'));
    await mkdir(path.join(root, '.postman'), { recursive: true });
    const target = arm('payments');
    await writeFile(
      path.join(root, '.postman/resources.yaml'),
      `azure:\n  apimApiId: ${target}\n`,
      'utf8'
    );

    const client: AzureApimClient = {
      listServices: vi.fn(async () => [service({ tags: { 'postman:repo': 'org/other' } })]),
      listApis: vi.fn(async () => [
        api({ apiId: 'payments', path: 'payments' }),
        api({ apiId: 'orders', path: 'orders' })
      ]),
      exportApi: vi.fn(async () => OPENAPI),
      getGraphqlSchema: vi.fn(async () => {
        throw new Error('unused');
      }),
      getApi: vi.fn(async () => {
        throw new Error('unused');
      }),
      listApiSchemas: vi.fn(async () => []),
      getApiSchemaDocument: vi.fn(async () => {
        throw new Error('schema document unused');
      }),
      getProtobufSchema: vi.fn(async () => {
        throw new Error('protobuf unused');
      }),
      probeApimReadAccess: vi.fn(async () => undefined)
    };
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (id) => ({ subscriptionId: id, state: 'Enabled' })),
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: () => client,
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: vi.fn(async () => undefined),
      providers: [provider]
    };

    const inputs = resolveInputs({
      INPUT_REPO_ROOT: root,
      INPUT_SUBSCRIPTION_ID: 'sub-1',
      INPUT_REPO_SLUG: 'org/payments'
    });
    const result = await execute(inputs, dependencies);
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.apiId).toBe(target);
    expect(result.resolution?.evidence.join(' ')).toMatch(/binding|resources\.yaml/i);
  });
});
