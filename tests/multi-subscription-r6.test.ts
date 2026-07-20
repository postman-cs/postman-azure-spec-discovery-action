import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AzureApimClient, AzureFunctionsClient, ResourceGraphRow } from '../src/lib/azure/clients.js';
import { ApimProvider } from '../src/lib/providers/apim.js';
import {
  execute,
  resolveInputs,
  resolveSubscriptionId,
  resolveSubscriptionIds,
  type AzureDependencies,
  type ReporterLike
} from '../src/runtime.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

const SUB_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUB_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const SUB_C = 'cccccccc-0000-0000-0000-000000000003';

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

function stubApimClient(): AzureApimClient {
  return {
    listServices: vi.fn(async () => []),
    listApis: vi.fn(async () => []),
    getApi: vi.fn(async () => {
      throw new Error('getApi unused');
    }),
    exportApi: vi.fn(async () => VALID_OPENAPI),
    getGraphqlSchema: vi.fn(async () => ''),
    listApiSchemas: vi.fn(async () => []),
    getApiSchemaDocument: vi.fn(async () => {
      throw new Error('schema document unused');
    }),
    getProtobufSchema: vi.fn(async () => {
      throw new Error('protobuf unused');
    }),
    probeApimReadAccess: vi.fn(async () => undefined)
  };
}

function apimSummary(apiId: string, isCurrent = true) {
  return {
    apiId,
    displayName: apiId,
    apiType: 'http',
    path: apiId.replace(/;rev=\d+$/i, ''),
    isCurrent,
    assignedGatewayIds: [] as string[],
    serviceName: 'svc',
    resourceGroup: 'rg'
  };
}

function apimClientWithApis(
  apiIds: string[],
  options: { tags?: Record<string, string>; delayMs?: number } = {}
): AzureApimClient {
  return {
    listServices: vi.fn(async () => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return [
        {
          name: 'svc',
          resourceGroup: 'rg',
          tags: options.tags ?? {},
          customHostnames: [],
          gatewayAssignments: [],
          workspaceGateways: []
        }
      ];
    }),
    listApis: vi.fn(async () => apiIds.map((apiId) => apimSummary(apiId))),
    getApi: vi.fn(async (_rg, _svc, apiId: string) => apimSummary(apiId, !/;rev=\d+/i.test(apiId))),
    exportApi: vi.fn(async () => VALID_OPENAPI),
    getGraphqlSchema: vi.fn(async () => ''),
    listApiSchemas: vi.fn(async () => []),
    getApiSchemaDocument: vi.fn(async () => {
      throw new Error('schema document unused');
    }),
    getProtobufSchema: vi.fn(async () => {
      throw new Error('protobuf unused');
    }),
    probeApimReadAccess: vi.fn(async () => undefined)
  };
}

function deniedAppServiceClient() {
  return {
    listSites: vi.fn(async () => []),
    probeAppServiceReadAccess: vi.fn(async () => {
      throw new Error('401');
    })
  };
}

describe('R6 multi-subscription input parsing', () => {
  it('AZ-R6-001: parses subscription-ids-json, sorts lexically, and keeps empty as unset', () => {
    const base = { GITHUB_WORKSPACE: '/tmp/r6-repo' };
    expect(resolveInputs({ ...base }).subscriptionIds).toEqual([]);
    expect(resolveInputs({ ...base, INPUT_SUBSCRIPTION_IDS_JSON: '[]' }).subscriptionIds).toEqual([]);
    expect(
      resolveInputs({
        ...base,
        INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_B, SUB_A])
      }).subscriptionIds
    ).toEqual([SUB_A, SUB_B]);
  });

  it('AZ-R6-002: rejects invalid arrays and case-insensitive duplicates after normalization', () => {
    const base = { GITHUB_WORKSPACE: '/tmp/r6-repo' };
    expect(() => resolveInputs({ ...base, INPUT_SUBSCRIPTION_IDS_JSON: '{' })).toThrow(
      /Invalid JSON for subscription-ids-json/
    );
    expect(() => resolveInputs({ ...base, INPUT_SUBSCRIPTION_IDS_JSON: '{}' })).toThrow(
      /subscription-ids-json must be a JSON array/
    );
    expect(() => resolveInputs({ ...base, INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify(['', '  ']) })).toThrow(
      /subscription-ids-json must not contain empty subscription IDs/
    );
    expect(() =>
      resolveInputs({
        ...base,
        INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_A.toUpperCase()])
      })
    ).toThrow(/subscription-ids-json contains duplicate subscription IDs after normalization/);
  });

  it('AZ-R6-003: subscription-id conflicts with subscription-ids-json unless both name the same one ID', () => {
    const base = { GITHUB_WORKSPACE: '/tmp/r6-repo' };
    expect(() =>
      resolveInputs({
        ...base,
        INPUT_SUBSCRIPTION_ID: SUB_A,
        INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B])
      })
    ).toThrow(/subscription-id and subscription-ids-json conflict/);
    expect(() =>
      resolveInputs({
        ...base,
        INPUT_SUBSCRIPTION_ID: SUB_A,
        INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_B])
      })
    ).toThrow(/subscription-id and subscription-ids-json conflict/);
    const ok = resolveInputs({
      ...base,
      INPUT_SUBSCRIPTION_ID: SUB_A,
      INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A.toUpperCase()])
    });
    expect(ok.subscriptionId).toBe(SUB_A);
    expect(ok.subscriptionIds).toEqual([SUB_A.toUpperCase()]);
  });
});

describe('R6 subscription scope resolution', () => {
  it('AZ-R6-004: verifies each explicit subscription independently with scoped fallback and never auto-enumerates all', async () => {
    const get = vi.fn(async (subscriptionId: string) => {
      if (subscriptionId === SUB_B) {
        throw new Error('Subscription lookup failed with HTTP 403');
      }
      return { subscriptionId, state: 'Enabled' };
    });
    const list = vi.fn(async () => [
      { subscriptionId: SUB_A, state: 'Enabled' },
      { subscriptionId: SUB_B, state: 'Enabled' },
      { subscriptionId: SUB_C, state: 'Enabled' }
    ]);
    await expect(resolveSubscriptionIds({ subscriptionIds: [SUB_B, SUB_A] }, { get, list })).resolves.toEqual([
      SUB_A,
      SUB_B
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.flat()).not.toContain(SUB_C);
  });

  it('AZ-R6-005: rejects an explicit ID that is not visible and never claims global absence', async () => {
    const get = vi.fn(async () => {
      throw new Error('Subscription lookup failed with HTTP 403');
    });
    const list = vi.fn(async () => [{ subscriptionId: SUB_A, state: 'Enabled' }]);
    await expect(resolveSubscriptionIds({ subscriptionIds: [SUB_B] }, { get, list })).rejects.toSatisfy(
      (error: Error) => {
        expect(error.message).toMatch(/not visible via listing/);
        expect(error.message.toLowerCase()).not.toMatch(/no azure subscriptions exist|across azure|in azure globally/);
        expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
        return true;
      }
    );
  });

  it('AZ-R6-006: empty explicit list keeps single-enabled-subscription behavior', async () => {
    const client = {
      get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
      list: vi.fn(async () => [{ subscriptionId: SUB_A, state: 'Enabled' }])
    };
    await expect(resolveSubscriptionIds({ subscriptionIds: [] }, client)).resolves.toEqual([SUB_A]);
    await expect(resolveSubscriptionId(undefined, client)).resolves.toBe(SUB_A);
  });
});

describe('R6 multi-scope discovery', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-r6-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<AzureDependencies> = {}): AzureDependencies {
    return {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => [
          { subscriptionId: SUB_A, state: 'Enabled' },
          { subscriptionId: SUB_B, state: 'Enabled' }
        ])
      },
      createApimClient: () => stubApimClient(),
      createAppServiceClient: deniedAppServiceClient,
      writeSpecFile: vi.fn(async () => undefined),
      ...overrides
    };
  }

  it('AZ-R6-007: merges candidates across two subscriptions by full ARM ID with deterministic order', async () => {
    // Distinct API names avoid on-disk path collision; full ARM IDs still prove cross-sub merge.
    const clients = new Map<string, AzureApimClient>([
      [SUB_A, apimClientWithApis(['zeta', 'alpha'])],
      [SUB_B, apimClientWithApis(['beta'], { delayMs: 20 })]
    ]);
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_MODE: 'discover-many',
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_B, SUB_A]),
          INPUT_MAX_CANDIDATES: '100'
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: (subscriptionId: string) => {
          const client = clients.get(subscriptionId);
          if (!client) throw new Error('unexpected subscription');
          return client;
        }
      })
    );
    expect(result.discovered).toHaveLength(3);
    expect(result.discovered.map((service) => service.apiId).sort()).toEqual(
      [
        `/subscriptions/${SUB_A}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/alpha`,
        `/subscriptions/${SUB_A}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/zeta`,
        `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/beta`
      ].sort()
    );
  });

  it('AZ-R6-008: exact APIM ARM ID routes only to its named subscription client', async () => {
    const target = `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments;rev=3`;
    const getApiA = vi.fn(async () => {
      throw new Error('sub-A client must not resolve sub-B exact id');
    });
    const getApiB = vi.fn(async () => apimSummary('payments;rev=3', false));
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B]),
          INPUT_API_ID: target
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: (subscriptionId: string): AzureApimClient => ({
          listServices: vi.fn(async () => []),
          listApis: vi.fn(async () => []),
          getApi: subscriptionId === SUB_B ? getApiB : getApiA,
          exportApi: vi.fn(async () => VALID_OPENAPI),
          getGraphqlSchema: vi.fn(async () => ''),
          listApiSchemas: vi.fn(async () => []),
          getApiSchemaDocument: vi.fn(async () => {
            throw new Error('schema document unused');
          }),
          getProtobufSchema: vi.fn(async () => {
            throw new Error('protobuf unused');
          }),
          probeApimReadAccess: vi.fn(async () => undefined)
        })
      })
    );
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.apiId?.toLowerCase()).toContain(SUB_B);
    expect(getApiB).toHaveBeenCalled();
    expect(getApiA).not.toHaveBeenCalled();
  });

  it('AZ-R6-008b: case-insensitive ARM prefixes keep exact APIM routing subscription-scoped', async () => {
    const target = `/SUBSCRIPTIONS/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments;rev=3`;
    const getApiA = vi.fn(async () => {
      throw new Error('sub-A client must not resolve sub-B exact id');
    });
    const getApiB = vi.fn(async () => apimSummary('payments;rev=3', false));
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B]),
          INPUT_API_ID: target
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: (subscriptionId: string): AzureApimClient => ({
          listServices: vi.fn(async () => []),
          listApis: vi.fn(async () => []),
          getApi: subscriptionId === SUB_B ? getApiB : getApiA,
          exportApi: vi.fn(async () => VALID_OPENAPI),
          getGraphqlSchema: vi.fn(async () => ''),
          listApiSchemas: vi.fn(async () => []),
          getApiSchemaDocument: vi.fn(async () => {
            throw new Error('schema document unused');
          }),
          getProtobufSchema: vi.fn(async () => {
            throw new Error('protobuf unused');
          }),
          probeApimReadAccess: vi.fn(async () => undefined)
        })
      })
    );
    expect(result.resolution?.status).toBe('resolved');
    expect(getApiB).toHaveBeenCalled();
    expect(getApiA).not.toHaveBeenCalled();
  });

  it('AZ-R6-009: same repo tag in two subscriptions remains ambiguous (no first-subscription bias)', async () => {
    const clientA = apimClientWithApis(['payments'], { tags: { 'postman:repo': 'org/payments' } });
    const clientB = apimClientWithApis(['payments'], { tags: { 'postman:repo': 'org/payments' } });
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B]),
          INPUT_REPO_SLUG: 'org/payments'
        }),
        repoRoot,
        repoContext: { provider: 'github', repoSlug: 'org/payments' }
      },
      baseDeps({
        createApimClient: (subscriptionId: string) => (subscriptionId === SUB_A ? clientA : clientB)
      })
    );
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.rankedCandidates?.length).toBe(2);
    expect(clientA.exportApi).not.toHaveBeenCalled();
    expect(clientB.exportApi).not.toHaveBeenCalled();
  });

  it('AZ-R6-010: IAM failure in one subscription does not erase candidates from another', async () => {
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_MODE: 'discover-many',
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B])
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: (subscriptionId: string) => {
          if (subscriptionId === SUB_A) {
            return {
              listServices: vi.fn(async () => {
                throw new Error('AuthorizationFailed 403');
              }),
              listApis: vi.fn(async () => []),
              getApi: vi.fn(async () => {
                throw new Error('unused');
              }),
              exportApi: vi.fn(async () => VALID_OPENAPI),
              getGraphqlSchema: vi.fn(async () => ''),
              listApiSchemas: vi.fn(async () => []),
              getApiSchemaDocument: vi.fn(async () => {
                throw new Error('schema document unused');
              }),
              getProtobufSchema: vi.fn(async () => {
                throw new Error('protobuf unused');
              }),
              probeApimReadAccess: vi.fn(async () => {
                throw new Error('403 Forbidden');
              })
            };
          }
          return apimClientWithApis(['payments']);
        }
      })
    );
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.apiId?.toLowerCase()).toContain(SUB_B);
  });

  it('AZ-R7-018: deferred hydration routes each multi-subscription Functions header to its owning client', async () => {
    const functionClients = new Map<string, AzureFunctionsClient>();
    for (const subscriptionId of [SUB_A, SUB_B]) {
      const appName = subscriptionId === SUB_A ? 'alpha-functions' : 'beta-functions';
      functionClients.set(subscriptionId, {
        probeFunctionsReadAccess: vi.fn(async () => undefined),
        listFunctionApps: vi.fn(async () => [
          {
            id: `/subscriptions/${subscriptionId}/resourceGroups/rg/providers/Microsoft.Web/sites/${appName}`,
            name: appName,
            resourceGroup: 'rg',
            tags: {},
            defaultHostName: `${appName}.azurewebsites.net`
          }
        ]),
        listFunctions: vi.fn(async (_resourceGroup, requestedAppName) => {
          if (requestedAppName !== appName) throw new Error(`wrong subscription client for ${requestedAppName}`);
          return [{ name: 'HttpTrigger', bindings: [{ type: 'httpTrigger', methods: ['get'] }] }];
        })
      });
    }
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_MODE: 'discover-many',
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B]),
          INPUT_MAX_CANDIDATES: '10'
        }),
        repoRoot
      },
      baseDeps({
        createFunctionsClient: (subscriptionId) => functionClients.get(subscriptionId)!
      })
    );
    expect(result.discovered.map((service) => service.serviceName).sort()).toEqual(['alpha-functions', 'beta-functions']);
    for (const client of functionClients.values()) {
      expect(client.listFunctions).toHaveBeenCalledTimes(1);
    }
  });

  it('AZ-R6-011: scoped absence wording identifies counts and never claims global absence', async () => {
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B]),
          INPUT_EXPECTED_SERVICE_NAME: 'missing'
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: () => stubApimClient()
      })
    );
    expect(result.resolution?.status).toBe('unresolved');
    const evidence = (result.resolution?.evidence ?? []).join('\n').toLowerCase();
    expect(evidence).toMatch(/no visible candidates in selected scope/);
    expect(evidence).toMatch(/2 subscription/);
    expect(evidence).not.toMatch(/no api exists|across azure|in azure globally|no azure apis exist/);
    expect((result.resolution?.evidence ?? []).join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('AZ-R6-012: discover-estate aggregates and dedupes associations across explicit scopes', async () => {
    const rowsBySub: Record<string, ResourceGraphRow[]> = {
      [SUB_A]: [
        {
          id: `/subscriptions/${SUB_A}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc-a`,
          name: 'svc-a',
          type: 'microsoft.apimanagement/service',
          resourceGroup: 'rg',
          tags: { 'postman:repo': 'acme/payments' }
        }
      ],
      [SUB_B]: [
        {
          id: `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc-b`,
          name: 'svc-b',
          type: 'microsoft.apimanagement/service',
          resourceGroup: 'rg',
          tags: { 'postman:repo': 'acme/payments' }
        },
        {
          id: `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.Web/sites/other`,
          name: 'other',
          type: 'microsoft.web/sites',
          resourceGroup: 'rg',
          tags: { 'postman:repo': 'acme/billing' }
        }
      ]
    };
    const queryResources = vi.fn(async (subscriptionIds: string | readonly string[]) => {
      const ids = Array.isArray(subscriptionIds) ? [...subscriptionIds] : [subscriptionIds];
      return ids.flatMap((id) => rowsBySub[id] ?? []);
    });
    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_MODE: 'discover-estate',
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_B, SUB_A])
        }),
        repoRoot
      },
      baseDeps({
        createResourceGraphClient: () => ({ queryResources })
      })
    );
    expect(queryResources).toHaveBeenCalledTimes(1);
    expect(queryResources.mock.calls[0]?.[0]).toEqual([SUB_A, SUB_B]);
    expect(result.estate).toHaveLength(2);
    const payments = result.estate?.find((entry) => entry.repo === 'payments');
    expect(payments?.resourceIds).toHaveLength(2);
    expect(result.outputs['repo-count']).toBe('2');
  });

  it('AZ-R6-013: ApimProvider.resolveExplicitApi ignores ARM IDs from other subscriptions', async () => {
    const provider = new ApimProvider(stubApimClient(), { subscriptionId: SUB_A });
    const other = `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments`;
    await expect(provider.resolveExplicitApi(other)).resolves.toBeUndefined();
  });

  it('AZ-IDENTITY-010: wrong-subscription exact ID stays scoped; insufficient RBAC is fail-soft; selected export remains fatal', async () => {
    const providerA = new ApimProvider(stubApimClient(), { subscriptionId: SUB_A });
    const foreign = `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments`;
    await expect(providerA.resolveExplicitApi(foreign)).resolves.toBeUndefined();

    const result = await execute(
      {
        ...resolveInputs({
          INPUT_REPO_ROOT: repoRoot,
          INPUT_MODE: 'discover-many',
          INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_A, SUB_B])
        }),
        repoRoot
      },
      baseDeps({
        createApimClient: (subscriptionId: string) => {
          if (subscriptionId === SUB_A) {
            return {
              ...stubApimClient(),
              listApiSchemas: vi.fn(async () => []),
              getApiSchemaDocument: vi.fn(async () => {
                throw new Error('schema document unused');
              }),
              getProtobufSchema: vi.fn(async () => {
                throw new Error('protobuf unused');
              }),
              probeApimReadAccess: vi.fn(async () => {
                throw new Error('AuthorizationFailed: insufficient RBAC on SUB_A');
              }),
              listServices: vi.fn(async () => {
                throw new Error('AuthorizationFailed: insufficient RBAC on SUB_A');
              })
            };
          }
          return apimClientWithApis(['payments']);
        }
      })
    );
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.apiId?.toLowerCase()).toContain(SUB_B);

    const selectedDenied = apimClientWithApis(['payments']);
    selectedDenied.exportApi = vi.fn(async () => {
      throw new Error('AuthorizationFailed: selected export denied');
    });
    await expect(
      execute(
        {
          ...resolveInputs({
            INPUT_REPO_ROOT: repoRoot,
            INPUT_SUBSCRIPTION_IDS_JSON: JSON.stringify([SUB_B]),
            INPUT_API_ID: `/subscriptions/${SUB_B}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments`
          }),
          repoRoot
        },
        baseDeps({
          createApimClient: () => selectedDenied
        })
      )
    ).rejects.toThrow(/AuthorizationFailed|Export failed|selected export denied/i);
  });
});
