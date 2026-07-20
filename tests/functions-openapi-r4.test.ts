import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import type { AzureFunctionsClient, FunctionSummary } from '../src/lib/azure/clients.js';
import { detectFunctionsOpenApiRoutes } from '../src/lib/azure/functions-openapi.js';
import { FunctionBindingsProvider } from '../src/lib/providers/function-bindings.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'OrdersFn', version: '1.0.0' },
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function fn(name: string, route?: string): FunctionSummary {
  return {
    name,
    bindings: [
      {
        type: 'httpTrigger',
        methods: ['get'],
        ...(route ? { route } : {})
      }
    ]
  };
}

function client(overrides: Partial<AzureFunctionsClient> = {}): AzureFunctionsClient {
  return {
    listFunctionApps: vi.fn(async () => [
      {
        id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/orders-fn',
        name: 'orders-fn',
        resourceGroup: 'rg',
        tags: { 'postman:repo': 'contoso/orders' },
        defaultHostName: 'orders-fn.azurewebsites.net'
      }
    ]),
    listFunctions: vi.fn(async () => [
      fn('RenderOpenApiDocument', 'openapi/{version}.{extension}'),
      fn('GetOrder', 'orders/{id}')
    ]),
    probeFunctionsReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('R4 Functions OpenAPI extension detection', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-FN-R4-001: detects RenderOpenApiDocument / swagger routes from metadata', () => {
    const routes = detectFunctionsOpenApiRoutes({
      functions: [fn('RenderOpenApiDocument', 'openapi/{version}.{extension}'), fn('GetOrder', 'orders/{id}')],
      defaultHostName: 'orders-fn.azurewebsites.net'
    });
    expect(routes.some((route) => route.path.includes('openapi'))).toBe(true);
    expect(routes[0]?.url).toMatch(/^https:\/\/orders-fn\.azurewebsites\.net\/api\/openapi/);
  });

  it('AZ-FN-R4-002: accepts explicit repo-provided OpenAPI path without blind probing', () => {
    const routes = detectFunctionsOpenApiRoutes({
      functions: [fn('GetOrder', 'orders/{id}')],
      defaultHostName: 'orders-fn.azurewebsites.net',
      explicitPath: '/api/swagger.json'
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/api/swagger.json');
    expect(routes[0]?.evidence).toMatch(/Repository\/manifest declared/i);
  });

  it('AZ-FN-R4-003: opt-in export fetches evidenced OpenAPI URL and never calls key/secret APIs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const functionsClient = client();
    const provider = new FunctionBindingsProvider(functionsClient, {
      enableOpenApiExtension: true
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.meta.openApiUrl).toContain('https://orders-fn.azurewebsites.net/');
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.content).toContain('OrdersFn');
    expect(provider.getKeyApiCallAttempts()).toEqual([]);
    expect(JSON.stringify(functionsClient)).not.toMatch(/listHostKeys|listFunctionKeys|listFunctionSecrets|listkeys/i);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('AZ-FN-R4-004: OpenAPI extension remains disabled by default (synthesis only)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new FunctionBindingsProvider(client());
    const [candidate] = await provider.listCandidates();
    expect(candidate!.meta.openApiUrl).toBeUndefined();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    expect(exported.contractClass).toBe('partial');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
