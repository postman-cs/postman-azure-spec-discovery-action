import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const { apimCtorSpy, appServiceCtorSpy, eventGridCtorSpy, serviceBusCtorSpy, graphCtorSpy } = vi.hoisted(() => ({
  apimCtorSpy: vi.fn(),
  appServiceCtorSpy: vi.fn(),
  eventGridCtorSpy: vi.fn(),
  serviceBusCtorSpy: vi.fn(),
  graphCtorSpy: vi.fn()
}));

vi.mock('@azure/arm-apimanagement', () => ({
  ApiManagementClient: class {
    public apiManagementService = { list: vi.fn(), listByResourceGroup: vi.fn() };
    public api = { listByService: vi.fn(), get: vi.fn() };
    public apiExport = { get: vi.fn() };
    public workspace = { listByService: vi.fn() };
    public workspaceApi = { listByService: vi.fn(), get: vi.fn() };
    public workspaceApiExport = { get: vi.fn() };
    public apiSchema = { listByApi: vi.fn(), get: vi.fn() };
    public workspaceApiSchema = { listByApi: vi.fn(), get: vi.fn() };
    public gateway = { listByService: vi.fn(async function* () {}) };
    public gatewayApi = { listByService: vi.fn(async function* () {}) };
    public apiManagementWorkspaceLinks = { listByService: vi.fn(async function* () {}) };
    public constructor(...args: unknown[]) {
      apimCtorSpy(...args);
    }
  }
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('@azure/arm-appservice', () => ({
  WebSiteManagementClient: class {
    public webApps = { list: vi.fn(), listByResourceGroup: vi.fn(), getConfiguration: vi.fn() };
    public constructor(...args: unknown[]) {
      appServiceCtorSpy(...args);
    }
  }
}));

vi.mock('@azure/arm-eventgrid', () => ({
  EventGridManagementClient: class {
    public topics = { listBySubscription: vi.fn(), listByResourceGroup: vi.fn() };
    public domains = { listBySubscription: vi.fn(), listByResourceGroup: vi.fn() };
    public systemTopics = { listBySubscription: vi.fn(), listByResourceGroup: vi.fn() };
    public topicEventSubscriptions = { list: vi.fn() };
    public domainEventSubscriptions = { list: vi.fn() };
    public systemTopicEventSubscriptions = { listBySystemTopic: vi.fn() };
    public constructor(...args: unknown[]) {
      eventGridCtorSpy(...args);
    }
  }
}));

vi.mock('@azure/arm-servicebus', () => ({
  ServiceBusManagementClient: class {
    public namespaces = { list: vi.fn(), listByResourceGroup: vi.fn() };
    public topics = { listByNamespace: vi.fn() };
    public subscriptions = { listByTopic: vi.fn() };
    public rules = { listBySubscriptions: vi.fn() };
    public constructor(...args: unknown[]) {
      serviceBusCtorSpy(...args);
    }
  }
}));

vi.mock('@azure/arm-resourcegraph', () => ({
  ResourceGraphClient: class {
    public resources = vi.fn();
    public constructor(...args: unknown[]) {
      graphCtorSpy(...args);
    }
  }
}));

import {
  ApimSdkClient,
  AppServiceSdkClient,
  EventGridSdkClient,
  FunctionsSdkClient,
  LogicWorkflowsSdkClient,
  ServiceBusSdkClient,
  TemplateSpecsSdkClient,
  createAzureCredential,
  ResourceGraphSdkClient,
  CustomApisSdkClient,
  SubscriptionsSdkClient
} from '../src/lib/azure/clients.js';
import {
  createArmRestClientOptions,
  listArmPages,
  MAX_ARM_LIST_PAGES
} from '../src/lib/azure/arm-rest.js';
import { CustomApisProvider } from '../src/lib/providers/custom-apis.js';
import { ApimProvider } from '../src/lib/providers/apim.js';

function fakeCredential() {
  return { getToken: vi.fn(async () => ({ token: 'tok', expiresOnTimestamp: Date.now() + 3600_000 })) };
}

describe('azure sdk client wrappers', () => {
  beforeEach(() => {
    apimCtorSpy.mockReset();
    appServiceCtorSpy.mockReset();
    eventGridCtorSpy.mockReset();
    serviceBusCtorSpy.mockReset();
    graphCtorSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('AZ-CLIENT-001: every wrapper receives the same shared TokenCredential', () => {
    const credential = fakeCredential();
    new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new AppServiceSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    // ResourceGraphSdkClient now rides direct ARM REST (no SDK constructor);
    // its credential use is covered by tests/resource-graph.test.ts.
    new ResourceGraphSdkClient(credential);

    expect(apimCtorSpy.mock.calls[0]?.[0]).toBe(credential);
    expect(appServiceCtorSpy.mock.calls[0]?.[0]).toBe(credential);
  });

  it('AZ-CLIENT-001: source contains exactly one production DefaultAzureCredential construction', () => {
    const srcRoot = path.resolve(import.meta.dirname, '..', 'src');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) sources.push(readFileSync(full, 'utf8'));
      }
    };
    walk(srcRoot);
    const occurrences = sources.join('\n').match(/new DefaultAzureCredential\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(typeof createAzureCredential).toBe('function');
  });

  it('AZ-CLIENT-004: SDK clients are constructed with retry bounded by maxAttempts', () => {
    const credential = fakeCredential();
    new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 5 });
    new AppServiceSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 5 });

    expect(apimCtorSpy.mock.calls[0]?.[2]).toMatchObject({ retryOptions: { maxRetries: 4 } });
    expect(appServiceCtorSpy.mock.calls[0]?.[2]).toMatchObject({ retryOptions: { maxRetries: 4 } });
  });

  it('AZ-CLIENT-004: a 401 from the SDK surfaces after a single wrapper attempt', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    let calls = 0;
    sdk.apiManagementService.list.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            calls += 1;
            throw new Error('401 Unauthorized');
          }
        };
      }
    }));

    await expect(client.listServices()).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('AZ-CLIENT-ABORT-002: passes abortSignal to an SDK probe operation', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiManagementService.list.mockReturnValue((async function* () { yield undefined; })());
    const controller = new AbortController();
    await client.probeApimReadAccess(undefined, controller.signal);
    expect(sdk.apiManagementService.list).toHaveBeenCalledWith({ abortSignal: controller.signal });
  });

  it('AZ-CLIENT-ABORT-002b: all SDK probes pass the caller abortSignal', async () => {
    const signal = new AbortController().signal;
    const appService = new AppServiceSdkClient(fakeCredential(), 'sub-1');
    const appSdk = (appService as unknown as { client: { webApps: { list: ReturnType<typeof vi.fn> } } }).client;
    appSdk.webApps.list.mockReturnValue((async function* () { yield undefined; })());
    await appService.probeAppServiceReadAccess(undefined, signal);
    expect(appSdk.webApps.list).toHaveBeenCalledWith({ abortSignal: signal });

    for (const [client, property, method, probe] of [
      [new EventGridSdkClient(fakeCredential(), 'sub-1'), 'topics', 'listBySubscription', 'probeEventGridReadAccess'],
      [new ServiceBusSdkClient(fakeCredential(), 'sub-1'), 'namespaces', 'list', 'probeServiceBusReadAccess']
    ] as const) {
      const sdk = (client as unknown as { client: Record<string, Record<string, unknown>> }).client;
      const operation = vi.fn().mockReturnValue((async function* () { yield undefined; })());
      sdk[property]![method] = operation;
      await (client as unknown as Record<string, (resourceGroup?: string, signal?: AbortSignal) => Promise<void>>)[probe]!(undefined, signal);
      expect(operation).toHaveBeenCalledWith({ abortSignal: signal });
    }
  });

  it.each([
    ['logic workflows', LogicWorkflowsSdkClient, 'probeLogicWorkflowsReadAccess'],
    ['template specs', TemplateSpecsSdkClient, 'probeTemplateSpecsReadAccess'],
    ['functions', FunctionsSdkClient, 'probeFunctionsReadAccess']
  ] as const)('AZ-CLIENT-ABORT-001b: %s REST probe composes the caller signal', async (_name, Client, probe) => {
    const client = new Client(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = (client as unknown as Record<string, (resourceGroup?: string, signal?: AbortSignal) => Promise<void>>)[probe]!(undefined, controller.signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('AZ-CLIENT-005: exportApi reads the link from the runtime properties.value shape', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    // The live ARM API nests the SAS link under properties.value.link, not the
    // value.link shape the generated SDK model claims.
    sdk.apiExport.get.mockResolvedValue({
      id: '/subscriptions/sub-1/.../apis/payments-live',
      name: 'payments-live',
      properties: { format: 'openapi+json-link', value: { link: 'https://blob.example/export.json?sig=REDACTED' } }
    });
    const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(spec, { status: 200 }) as unknown as Response
    );
    try {
      const content = await client.exportApi('rg', 'svc', 'payments-live');
      expect(content).toContain('"openapi":"3.0.3"');
      // exportApi routes the SAS link through the hardened fetcher (HTTPS-only,
      // redirect:'manual', abort signal, size caps), not a bare fetch.
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://blob.example/export.json?sig=REDACTED',
        expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CLIENT-005: exportApi still reads the flat value.link shape', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get.mockResolvedValue({ value: { link: 'https://blob.example/flat.json' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}', { status: 200 }) as unknown as Response
    );
    try {
      const content = await client.exportApi('rg', 'svc', 'payments-live');
      expect(content).toContain('"openapi":"3.0.3"');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://blob.example/flat.json',
        expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CLIENT-005: exportApi throws when neither link shape is present', async () => {
    const credential = fakeCredential();
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get.mockResolvedValue({ properties: { format: 'openapi+json-link', value: {} } });
    await expect(client.exportApi('rg', 'svc', 'payments-live')).rejects.toThrow('no download link');
  });

  it('AZ-CLIENT-005b: exportApi passes the requested WSDL link format', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get.mockResolvedValue({ value: { link: 'https://blob.example/service.wsdl' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<definitions/>', { status: 200 }));

    await expect(client.exportApi('rg', 'svc', 'soap-api', undefined, 'wsdl-link')).resolves.toBe('<definitions/>');
    expect(sdk.apiExport.get).toHaveBeenCalledWith('rg', 'svc', 'soap-api', 'wsdl-link', 'true');
  });

  it('AZ-CLIENT-005c: getGraphqlSchema prefers graphql schema id and reads flattened SDL value', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as {
      client: {
        apiSchema: { listByApi: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      };
    }).client;
    sdk.apiSchema.listByApi.mockReturnValue((async function* () {
      yield { name: 'fallback', contentType: 'application/vnd.ms-azure-apim.graphql.schema' };
      yield { name: 'graphql', contentType: 'application/vnd.ms-azure-apim.graphql.schema' };
    })());
    sdk.apiSchema.get.mockResolvedValue({ value: 'type Query { ping: String! }' });

    await expect(client.getGraphqlSchema('rg', 'svc', 'graphql-api')).resolves.toContain('type Query');
    expect(sdk.apiSchema.get).toHaveBeenCalledWith('rg', 'svc', 'graphql-api', 'graphql');
  });

  it('AZ-APIM-GW-001: listServices + listApis enumerate gateway assignments once per service', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as {
      client: {
        apiManagementService: { list: ReturnType<typeof vi.fn> };
        api: { listByService: ReturnType<typeof vi.fn> };
        workspace: { listByService: ReturnType<typeof vi.fn> };
        gateway: { listByService: ReturnType<typeof vi.fn> };
        gatewayApi: { listByService: ReturnType<typeof vi.fn> };
        apiManagementWorkspaceLinks: { listByService: ReturnType<typeof vi.fn> };
      };
    }).client;

    sdk.apiManagementService.list.mockReturnValue((async function* () {
      yield {
        name: 'svc',
        id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc',
        gatewayUrl: 'https://svc.azure-api.net'
      };
    })());
    sdk.api.listByService.mockReturnValue((async function* () {
      yield { name: 'payments', displayName: 'Payments', apiType: 'http', isCurrent: true };
    })());
    sdk.workspace.listByService.mockReturnValue((async function* () {})());
    sdk.apiManagementWorkspaceLinks.listByService.mockReturnValue((async function* () {})());

    let gatewayListCalls = 0;
    sdk.gateway.listByService.mockImplementation(() => {
      gatewayListCalls += 1;
      return (async function* () {
        yield { name: 'edge-1' };
      })();
    });
    sdk.gatewayApi.listByService.mockReturnValue((async function* () {
      yield { name: 'payments' };
    })());

    const services = await client.listServices();
    expect(services).toHaveLength(1);
    expect(services[0]?.gatewayAssignments).toEqual([{ gatewayId: 'edge-1', apiIds: ['payments'] }]);
    expect(gatewayListCalls).toBe(1);

    const apis = await client.listApis('rg', 'svc');
    expect(apis).toEqual([
      expect.objectContaining({ apiId: 'payments', assignedGatewayIds: ['edge-1'] })
    ]);
    // Hot path must not re-enumerate gateways after listServices already did.
    expect(gatewayListCalls).toBe(1);
    expect(sdk.gateway.listByService).toHaveBeenCalledTimes(1);
    expect(sdk.gatewayApi.listByService).toHaveBeenCalledTimes(1);
  });

  it('AZ-APIM-001: service and workspace APIs retain current revisions and full scope metadata', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as {
      client: {
        api: { listByService: ReturnType<typeof vi.fn> };
        workspace: { listByService: ReturnType<typeof vi.fn> };
        workspaceApi: { listByService: ReturnType<typeof vi.fn> };
      };
    }).client;
    sdk.api.listByService.mockReturnValue((async function* () {
      yield { name: 'service-current', displayName: 'Service current', apiType: 'http', isCurrent: true, apiVersionSetId: '/sets/a' };
      yield { name: 'service-old;rev=1', displayName: 'Service old', apiType: 'http', isCurrent: false, apiVersionSetId: '/sets/a' };
      yield { name: 'service-unknown', displayName: 'Service unknown', apiType: 'http', apiVersionSetId: '/sets/a' };
    })());
    sdk.workspace.listByService.mockReturnValue((async function* () { yield { name: 'team-a' }; })());
    sdk.workspaceApi.listByService.mockReturnValue((async function* () {
      yield { name: 'workspace-api', displayName: 'Workspace API', apiType: 'http', isCurrent: true };
    })());

    const apis = await client.listApis('rg', 'svc');
    expect(apis.map((api) => api.apiId)).toEqual(['service-current', 'workspace-api']);
    expect(apis[1]?.workspaceId).toBe('team-a');
    expect(sdk.workspaceApi.listByService).toHaveBeenCalledWith('rg', 'svc', 'team-a');
  });

  it('AZ-APIM-001b: workspace listing failure on non-workspace tiers keeps service-level APIs', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as {
      client: {
        api: { listByService: ReturnType<typeof vi.fn> };
        workspace: { listByService: ReturnType<typeof vi.fn> };
        workspaceApi: { listByService: ReturnType<typeof vi.fn> };
      };
    }).client;
    sdk.api.listByService.mockImplementation(() => (async function* () {
      yield { name: 'service-current', displayName: 'Service current', apiType: 'http', isCurrent: true };
    })());
    // Consumption/Developer/Basic/Standard tiers reject the workspace surface.
    // Live ARM commonly returns MethodNotAllowedInPricingTier (message may live on RestError.response).
    const pricingTierError = Object.assign(
      new Error("Operation returned an invalid status code 'BadRequest'"),
      {
        code: 'MethodNotAllowedInPricingTier',
        statusCode: 400,
        response: {
          bodyAsText: JSON.stringify({
            error: {
              code: 'MethodNotAllowedInPricingTier',
              message: 'Method not allowed in Consumption pricing tier'
            }
          })
        }
      }
    );
    sdk.workspace.listByService.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw pricingTierError;
      }
    });

    const apis = await client.listApis('rg', 'svc');
    expect(apis.map((api) => api.apiId)).toEqual(['service-current']);
    expect(sdk.workspaceApi.listByService).not.toHaveBeenCalled();

    // Documented workspace-feature wording remains accepted.
    sdk.workspace.listByService.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw new Error('ValidationError: The workspace feature is not supported in this service tier');
      }
    });
    await expect(client.listApis('rg', 'svc')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ apiId: 'service-current' })])
    );
  });

  it('AZ-APIM-001c: unexpected workspace listing and workspace API failures are not masked', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as {
      client: {
        api: { listByService: ReturnType<typeof vi.fn> };
        workspace: { listByService: ReturnType<typeof vi.fn> };
        workspaceApi: { listByService: ReturnType<typeof vi.fn> };
      };
    }).client;
    sdk.api.listByService.mockImplementation(() => (async function* () {
      yield { name: 'service-current', displayName: 'Service current', apiType: 'http', isCurrent: true };
    })());
    sdk.workspace.listByService.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw new Error('ServiceUnavailable: workspace listing failed with HTTP 503');
      }
    });

    await expect(client.listApis('rg', 'svc')).rejects.toThrow('HTTP 503');

    sdk.workspace.listByService.mockReturnValue((async function* () { yield { name: 'team-a' }; })());
    sdk.workspaceApi.listByService.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw new Error('403 Forbidden reading workspace APIs');
      }
    });

    await expect(client.listApis('rg', 'svc')).rejects.toThrow('403 Forbidden');
  });

  it('AZ-APIM-003: a SAS 403 triggers a fresh export and total cycles stay within maxAttempts', async () => {
    const client = new ApimSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: { apiExport: { get: ReturnType<typeof vi.fn> } } }).client;
    sdk.apiExport.get
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/first.json?sig=first-secret' } })
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/second.json?sig=second-secret' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"openapi":"3.0.3","paths":{"/x":{}}}', { status: 200 }));

    await expect(client.exportApi('rg', 'svc', 'payments')).resolves.toContain('openapi');
    expect(sdk.apiExport.get).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'https://1.1.1.1/first.json?sig=first-secret',
      'https://1.1.1.1/second.json?sig=second-secret'
    ]);

    sdk.apiExport.get.mockReset();
    fetchSpy.mockReset();
    sdk.apiExport.get.mockResolvedValue({ value: { link: 'https://1.1.1.1/expired.json?sig=never-log' } });
    fetchSpy.mockResolvedValue(new Response('expired', { status: 403 }));
    await expect(client.exportApi('rg', 'svc', 'payments')).rejects.toThrow(
      'APIM export fetch failed with HTTP 403 after 3 attempt(s)'
    );
    expect(sdk.apiExport.get).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('AZ-CLIENT-006: pagination ceiling allows exactly 100 pages and rejects the 101st', async () => {
    const credential = fakeCredential();
    const makePagedIterable = (pageCount: number) => {
      const iterable = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < pageCount * 2; i += 1) yield { name: `svc-${i}`, id: `/subscriptions/s/resourceGroups/rg/x/${i}` };
        },
        byPage: () => ({
          async *[Symbol.asyncIterator]() {
            for (let p = 0; p < pageCount; p += 1) {
              yield [
                { name: `svc-${p}-a`, id: `/subscriptions/s/resourceGroups/rg/x/${p}a` },
                { name: `svc-${p}-b`, id: `/subscriptions/s/resourceGroups/rg/x/${p}b` }
              ];
            }
          }
        })
      };
      return iterable;
    };

    const okClient = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const okSdk = (okClient as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    okSdk.apiManagementService.list.mockReturnValue(makePagedIterable(100));
    await expect(okClient.listServices()).resolves.toHaveLength(200);

    const failClient = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const failSdk = (failClient as unknown as { client: { apiManagementService: { list: ReturnType<typeof vi.fn> } } }).client;
    failSdk.apiManagementService.list.mockReturnValue(makePagedIterable(101));
    await expect(failClient.listServices()).rejects.toThrow('pagination exceeded 100 pages');
  });

  it('AZ-CLIENT-006: subscription listing rejects when nextLink never terminates', async () => {
    const credential = fakeCredential();
    const client = new SubscriptionsSdkClient(credential);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get('page') ?? '0');
      return new Response(
        JSON.stringify({
          value: [{ subscriptionId: `sub-${page}`, state: 'Enabled' }],
          nextLink: `https://management.azure.com/subscriptions?api-version=2022-12-01&page=${page + 1}`
        }),
        { status: 200 }
      );
    });
    try {
      await expect(client.list()).rejects.toThrow('pagination exceeded 100 pages');
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(101);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CLIENT-002: explicit subscription lookup uses the exact ARM subscription endpoint', async () => {
    const client = new SubscriptionsSdkClient(fakeCredential());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ subscriptionId: 'sub-1', state: 'Enabled' }), { status: 200 })
    );
    await expect(client.get('sub-1')).resolves.toMatchObject({ subscriptionId: 'sub-1' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://management.azure.com/subscriptions/sub-1?api-version=2022-12-01'
    );
  });

  it('AZ-CLIENT-004: subscription REST retries transient responses but not 401', async () => {
    const client = new SubscriptionsSdkClient(fakeCredential(), {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscriptionId: 'sub-1', state: 'Enabled' }), { status: 200 })
      );
    await expect(client.get('sub-1')).resolves.toMatchObject({ subscriptionId: 'sub-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(client.get('sub-1')).rejects.toThrow('HTTP 401');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('AZ-CLOUD-010: clients.ts does not hardcode the public ARM host outside the cloud profile', () => {
    const clientsSrc = readFileSync(path.resolve(import.meta.dirname, '..', 'src/lib/azure/clients.ts'), 'utf8');
    expect(clientsSrc).not.toContain('https://management.azure.com');
  });

  it('AZ-CLOUD-011: sovereign profiles wire SDK endpoint and REST token scope without public leakage', async () => {
    vi.stubEnv('AZURE_ENVIRONMENT', 'AzureUSGovernment');
    const credential = fakeCredential();
    new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new AppServiceSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new EventGridSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    new ServiceBusSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });

    expect(apimCtorSpy.mock.calls[0]?.[2]).toMatchObject({
      endpoint: 'https://management.usgovcloudapi.net'
    });
    expect(appServiceCtorSpy.mock.calls[0]?.[2]).toMatchObject({
      endpoint: 'https://management.usgovcloudapi.net'
    });
    expect(eventGridCtorSpy.mock.calls[0]?.[2]).toMatchObject({
      endpoint: 'https://management.usgovcloudapi.net'
    });
    expect(serviceBusCtorSpy.mock.calls[0]?.[2]).toMatchObject({
      endpoint: 'https://management.usgovcloudapi.net'
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ subscriptionId: 'sub-1', state: 'Enabled' }), { status: 200 })
    );
    const subscriptions = new SubscriptionsSdkClient(credential, {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    await subscriptions.get('sub-1');
    expect(credential.getToken).toHaveBeenCalledWith('https://management.usgovcloudapi.net/.default');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://management.usgovcloudapi.net/subscriptions/sub-1?api-version=2022-12-01'
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('management.azure.com');
  });

  it('AZ-CLOUD-012: China profile keeps REST requests on chinacloudapi.cn', async () => {
    vi.stubEnv('AZURE_ENVIRONMENT', 'AzureChinaCloud');
    const credential = fakeCredential();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [] }), { status: 200 })
    );
    const client = new CustomApisSdkClient(credential, 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    await client.listCustomApis();
    expect(credential.getToken).toHaveBeenCalledWith('https://management.chinacloudapi.cn/.default');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('https://management.chinacloudapi.cn/');
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('management.azure.com');
  });

  it('AZ-PAGINATION-010: rejects non-HTTPS and wrong-host nextLink before forwarding credentials', async () => {
    const credential = fakeCredential();
    const client = new SubscriptionsSdkClient(credential, {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [{ subscriptionId: 'sub-0', state: 'Enabled' }],
          nextLink: 'http://management.azure.com/subscriptions?api-version=2022-12-01&page=1'
        }),
        { status: 200 }
      )
    );
    await expect(client.list()).rejects.toThrow(/HTTPS/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [{ subscriptionId: 'sub-0', state: 'Enabled' }],
          nextLink: 'https://evil.example/subscriptions?api-version=2022-12-01'
        }),
        { status: 200 }
      )
    );
    await expect(client.list()).rejects.toThrow(/management endpoint|nextLink host/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Credential was used for the first page only; malicious nextLink must not be fetched.
    expect(credential.getToken).toHaveBeenCalled();
  });

  it('AZ-PAGINATION-011: rejects malformed and repeated nextLink values', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [], nextLink: 'not a url' }), { status: 200 })
    );
    await expect(client.listCustomApis()).rejects.toThrow(/malformed nextLink/i);

    const repeated = vi.spyOn(globalThis, 'fetch').mockReset().mockImplementation(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify({
          value: [
            {
              id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/customApis/a',
              name: 'a',
              properties: { swagger: {} }
            }
          ],
          nextLink: url
        }),
        { status: 200 }
      );
    });
    await expect(client.listCustomApis()).rejects.toThrow(/repeated nextLink/i);
    expect(repeated).toHaveBeenCalledTimes(1);
  });

  it('AZ-RETRY-010: honors Retry-After seconds with injectable sleep and does not retry permanent 400', async () => {
    const sleeps: number[] = [];
    const client = new SubscriptionsSdkClient(fakeCredential(), {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscriptionId: 'sub-1', state: 'Enabled' }), { status: 200 })
      );
    await expect(client.get('sub-1')).resolves.toMatchObject({ subscriptionId: 'sub-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3000]);

    fetchSpy.mockReset();
    sleeps.length = 0;
    fetchSpy.mockResolvedValue(new Response('bad request', { status: 400 }));
    await expect(client.get('sub-1')).rejects.toThrow('HTTP 400');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it.each([501, 505] as const)(
    'AZ-RETRY-011: subscription REST does not retry permanent HTTP %s',
    async (status) => {
      const client = new SubscriptionsSdkClient(fakeCredential(), {
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        sleep: async () => undefined
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('permanent', { status }));
      await expect(client.get('sub-1')).rejects.toThrow(`HTTP ${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );

  it.each([500, 502, 503, 504] as const)(
    'AZ-RETRY-012: subscription REST retries HTTP %s within maxAttempts then surfaces',
    async (status) => {
      const client = new SubscriptionsSdkClient(fakeCredential(), {
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        sleep: async () => undefined
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('transient', { status }));
      await expect(client.get('sub-1')).rejects.toThrow(`HTTP ${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    }
  );

  it('AZ-RETRY-013: generic ARM client never retries permanent 400', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(client.listCustomApis()).rejects.toThrow('HTTP 400');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([501, 505] as const)(
    'AZ-RETRY-014: generic ARM client (Custom APIs) does not retry permanent HTTP %s',
    async (status) => {
      const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', {
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        sleep: async () => undefined
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('permanent', { status }));
      await expect(client.listCustomApis()).rejects.toThrow(`HTTP ${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );
});

describe('shared ARM listArmPages helper (R1-R7 list seam)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-PAGINATION-020: listArmPages aborts at the page ceiling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get('page') ?? '0');
      return new Response(
        JSON.stringify({
          value: [{ id: `item-${page}` }],
          nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Test/items?api-version=2024-01-01&page=${page + 1}`
        }),
        { status: 200 }
      );
    });
    const options = createArmRestClientOptions({
      maxAttempts: 1,
      requestTimeoutMs: 30000,
      sleep: async () => undefined
    });
    await expect(
      listArmPages(
        'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Test/items?api-version=2024-01-01',
        'tok',
        'Shared ARM list',
        options
      )
    ).rejects.toThrow(`Shared ARM list pagination exceeded ${MAX_ARM_LIST_PAGES} pages`);
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_ARM_LIST_PAGES);
  });

  it('AZ-PAGINATION-021: listArmPages rejects malformed and repeated nextLink', async () => {
    const options = createArmRestClientOptions({
      maxAttempts: 1,
      requestTimeoutMs: 30000,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [], nextLink: 'not a url' }), { status: 200 })
    );
    await expect(
      listArmPages(
        'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Test/items?api-version=2024-01-01',
        'tok',
        'Shared ARM list',
        options
      )
    ).rejects.toThrow(/malformed nextLink/i);

    const repeated = vi.spyOn(globalThis, 'fetch').mockReset().mockImplementation(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify({ value: [{ id: 'a' }], nextLink: url }), { status: 200 });
    });
    await expect(
      listArmPages(
        'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Test/items?api-version=2024-01-01',
        'tok',
        'Shared ARM list',
        options
      )
    ).rejects.toThrow(/repeated nextLink/i);
    expect(repeated).toHaveBeenCalledTimes(1);
  });

  const restOpts = { requestTimeoutMs: 30000, maxAttempts: 1, sleep: async () => undefined };

  it.each([
    [
      'subscriptions',
      () => new SubscriptionsSdkClient(fakeCredential(), restOpts),
      (client: SubscriptionsSdkClient) => client.list(),
      'Subscription listing',
      (page: number) => ({
        value: [{ subscriptionId: `sub-${page}`, state: 'Enabled' }],
        nextLink: `https://management.azure.com/subscriptions?api-version=2022-12-01&page=${page + 1}`
      })
    ],
    [
      'custom-apis',
      () => new CustomApisSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: CustomApisSdkClient) => client.listCustomApis(),
      'Custom API listing',
      (page: number) => ({
        value: [
          {
            id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/customApis/a-${page}`,
            name: `a-${page}`,
            properties: { swagger: {} }
          }
        ],
        nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Web/customApis?api-version=2016-06-01&page=${page + 1}`
      })
    ],
    [
      'logic-workflows',
      () => new LogicWorkflowsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: LogicWorkflowsSdkClient) => client.listWorkflows(),
      'Logic workflow listing',
      (page: number) => ({
        value: [
          {
            id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf-${page}`,
            name: `wf-${page}`,
            properties: { state: 'Enabled' }
          }
        ],
        nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Logic/workflows?api-version=2019-05-01&page=${page + 1}`
      })
    ],
    [
      'template-specs',
      () => new TemplateSpecsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: TemplateSpecsSdkClient) => client.listTemplateSpecs(),
      'Template spec listing',
      (page: number) => ({
        value: [
          {
            id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Resources/templateSpecs/ts-${page}`,
            name: `ts-${page}`
          }
        ],
        nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Resources/templateSpecs?api-version=2022-02-01&page=${page + 1}`
      })
    ],
    [
      'function-apps',
      () => new FunctionsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: FunctionsSdkClient) => client.listFunctionApps(),
      'Function app listing',
      (page: number) => ({
        value: [
          {
            id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/fn-${page}`,
            name: `fn-${page}`,
            kind: 'functionapp'
          }
        ],
        nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Web/sites?api-version=2023-12-01&page=${page + 1}`
      })
    ]
  ] as const)(
    'AZ-PAGINATION-022: %s list seam hits the 100-page ceiling through the shared nextLink helper',
    async (_name, createClient, invoke, operationLabel, pageBody) => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        const page = Number(new URL(url).searchParams.get('page') ?? '0');
        return new Response(JSON.stringify(pageBody(page)), { status: 200 });
      });
      await expect(invoke(client as never)).rejects.toThrow(`${operationLabel} pagination exceeded 100 pages`);
      expect(fetchSpy.mock.calls.length).toBe(100);
    }
  );

  it.each([
    [
      'logic-workflows',
      () => new LogicWorkflowsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: LogicWorkflowsSdkClient) => client.listWorkflows()
    ],
    [
      'template-specs',
      () => new TemplateSpecsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: TemplateSpecsSdkClient) => client.listTemplateSpecs()
    ],
    [
      'function-apps',
      () => new FunctionsSdkClient(fakeCredential(), 'sub-1', restOpts),
      (client: FunctionsSdkClient) => client.listFunctionApps()
    ]
  ] as const)(
    'AZ-PAGINATION-023: %s list seam rejects malformed and repeated nextLink',
    async (_name, createClient, invoke) => {
      const client = createClient();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [], nextLink: ':::bad' }), { status: 200 })
      );
      await expect(invoke(client as never)).rejects.toThrow(/malformed nextLink/i);

      const repeated = vi.spyOn(globalThis, 'fetch').mockReset().mockImplementation(async (input) => {
        const url = String(input);
        return new Response(JSON.stringify({ value: [], nextLink: url }), { status: 200 });
      });
      await expect(invoke(client as never)).rejects.toThrow(/repeated nextLink/i);
      expect(repeated).toHaveBeenCalledTimes(1);
    }
  );
});

describe('identity contract (DefaultAzureCredential / token failure modes)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-IDENTITY-001: expired or unavailable token from getToken fails closed without inventing credentials', async () => {
    const expired = {
      getToken: vi.fn(async () => {
        throw new Error('AuthenticationRequiredError: AADSTS700084: The refresh token has expired due to inactivity');
      })
    };
    const client = new SubscriptionsSdkClient(expired, {
      requestTimeoutMs: 30000,
      maxAttempts: 2,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(client.get('sub-1')).rejects.toThrow(/refresh token has expired|AuthenticationRequiredError/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(expired.getToken).toHaveBeenCalledWith('https://management.azure.com/.default');
  });

  it('AZ-IDENTITY-002: credential that produces no token fails closed', async () => {
    const empty = { getToken: vi.fn(async () => null) };
    const client = new CustomApisSdkClient(empty, 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 2,
      sleep: async () => undefined
    });
    await expect(client.listCustomApis()).rejects.toThrow(/produced no ARM token/i);
    expect(empty.getToken).toHaveBeenCalledOnce();
  });

  it('AZ-IDENTITY-003: wrong tenant/subscription surfaces as not-found/unauthorized without retry storm', async () => {
    const credential = fakeCredential();
    const client = new SubscriptionsSdkClient(credential, {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SubscriptionNotFound' } }), { status: 404 }));
    await expect(client.get('00000000-0000-0000-0000-000000000099')).rejects.toThrow('HTTP 404');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationTokenTenant' } }), { status: 401 })
    );
    await expect(client.get('sub-1')).rejects.toThrow('HTTP 401');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('AZ-IDENTITY-004: insufficient RBAC maps probe to skipped:iam (fail-soft) while selected export stays fatal', async () => {
    const deniedClient = {
      probeCustomApisReadAccess: vi.fn(async () => {
        throw new Error('AuthorizationFailed: The client does not have authorization to perform action');
      }),
      listCustomApis: vi.fn(async () => []),
      getSwagger: vi.fn(async () => {
        throw new Error('unused');
      })
    };
    const provider = new CustomApisProvider(deniedClient);
    await expect(provider.probe()).resolves.toBe('skipped:iam');

    const apim = new ApimProvider(
      {
        listServices: vi.fn(async () => []),
        listApis: vi.fn(async () => []),
        getApi: vi.fn(async () => {
          throw new Error('unused');
        }),
        exportApi: vi.fn(async () => {
          throw new Error('AuthorizationFailed: export denied for selected API');
        }),
        getGraphqlSchema: vi.fn(async () => ''),
        probeApimReadAccess: vi.fn(async () => undefined)
      },
      { subscriptionId: 'sub-1' }
    );
    await expect(apim.probe()).resolves.toBe('available');
    await expect(
      apim.exportSpec({
        id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/pay',
        name: 'pay',
        providerType: 'apim',
        supported: true,
        evidence: [],
        tags: {},
        meta: {
          resourceGroup: 'rg',
          serviceName: 'svc',
          apiId: 'pay',
          apiType: 'http'
        }
      })
    ).rejects.toThrow(/AuthorizationFailed|export denied/i);
  });

  it('AZ-IDENTITY-005: createAzureCredential remains the sole DefaultAzureCredential construction seam', () => {
    expect(typeof createAzureCredential).toBe('function');
    const src = readFileSync(path.resolve(import.meta.dirname, '..', 'src/lib/azure/clients.ts'), 'utf8');
    expect(src).toMatch(/new DefaultAzureCredential\(\{\s*authorityHost:\s*cloud\.authorityHost/);
  });
});

describe('CustomApisSdkClient', () => {
  it('AZ-CLIENT-ABORT-001: an aborted direct REST probe receives the signal and does not retry', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = client.probeCustomApisReadAccess(undefined, controller.signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('AZ-CAPI-010: listCustomApis projects only secret-free fields from the ARM payload', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const armEntry = {
      id: '/subscriptions/sub-1/resourceGroups/rg-pay/providers/Microsoft.Web/customApis/pay',
      name: 'pay',
      tags: { team: 'payments' },
      properties: {
        swagger: { swagger: '2.0', info: { title: 'pay', version: '1' }, paths: {} },
        backendService: { serviceUrl: 'https://api.contoso.com/pay' },
        apiDefinitions: { originalSwaggerUrl: 'https://example.com/orig.json' },
        connectionParameters: { token: { oAuthSettings: { clientSecret: 'SUPER-SECRET-VALUE' } } }
      }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [armEntry] }), { status: 200 })
    );
    try {
      const summaries = await client.listCustomApis();
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      expect(summary).toMatchObject({
        name: 'pay',
        resourceGroup: 'rg-pay',
        hasSwagger: true,
        backendServiceUrl: 'https://api.contoso.com/pay',
        originalSwaggerUrl: 'https://example.com/orig.json'
      });
      expect(JSON.stringify(summary)).not.toContain('SUPER-SECRET-VALUE');
      expect(JSON.stringify(summary)).not.toContain('connectionParameters');
      const url = String(fetchSpy.mock.calls[0]?.[0]);
      expect(url).toContain('/subscriptions/sub-1/providers/Microsoft.Web/customApis');
      expect(url).toContain('api-version=2016-06-01');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CAPI-011: getSwagger returns only the inline swagger document, never sibling properties', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '/subscriptions/sub-1/resourceGroups/rg-pay/providers/Microsoft.Web/customApis/pay',
          name: 'pay',
          properties: {
            swagger: { swagger: '2.0', info: { title: 'pay', version: '1' }, paths: {} },
            connectionParameters: { token: { oAuthSettings: { clientSecret: 'SUPER-SECRET-VALUE' } } }
          }
        }),
        { status: 200 }
      )
    );
    try {
      const content = await client.getSwagger('rg-pay', 'pay');
      expect(content).toContain('"swagger": "2.0"');
      expect(content).not.toContain('SUPER-SECRET-VALUE');
      expect(content).not.toContain('connectionParameters');
      const url = String(fetchSpy.mock.calls[0]?.[0]);
      expect(url).toBe(
        'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-pay/providers/Microsoft.Web/customApis/pay?api-version=2016-06-01'
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CAPI-012: getSwagger rejects when the connector has no inline swagger', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', name: 'pay', properties: {} }), { status: 200 })
    );
    try {
      await expect(client.getSwagger('rg-pay', 'pay')).rejects.toThrow('no inline swagger');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AZ-CAPI-013: probe maps 403 to an authorization error and paginates via nextLink', async () => {
    const client = new CustomApisSdkClient(fakeCredential(), 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    try {
      await expect(client.probeCustomApisReadAccess()).rejects.toThrow(/AuthorizationFailed/);
    } finally {
      fetchSpy.mockRestore();
    }

    const pagedSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get('page') ?? '0');
      if (page >= 2) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          value: [
            {
              id: `/subscriptions/sub-1/resourceGroups/rg-${page}/providers/Microsoft.Web/customApis/api-${page}`,
              name: `api-${page}`,
              properties: { swagger: {} }
            }
          ],
          nextLink: `https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Web/customApis?api-version=2016-06-01&page=${page + 1}`
        }),
        { status: 200 }
      );
    });
    try {
      const summaries = await client.listCustomApis();
      expect(summaries).toHaveLength(2);
      expect(pagedSpy.mock.calls.length).toBe(3);
    } finally {
      pagedSpy.mockRestore();
    }
  });
});
