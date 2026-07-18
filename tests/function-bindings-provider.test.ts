import { describe, expect, it, vi } from 'vitest';

import type { AzureFunctionsClient, FunctionAppSummary, FunctionSummary } from '../src/lib/azure/clients.js';
import { FunctionBindingsProvider } from '../src/lib/providers/function-bindings.js';

const APP_ID = '/subscriptions/sub-1/resourceGroups/rg-fn/providers/Microsoft.Web/sites/orders-fn';
const SECRET_VALUE = 'Endpoint=sb://leaky;SharedAccessKeyName=root;SharedAccessKey=abc123';

function app(overrides: Partial<FunctionAppSummary> = {}): FunctionAppSummary {
  return {
    id: APP_ID,
    name: 'orders-fn',
    resourceGroup: 'rg-fn',
    tags: { 'postman:repo': 'contoso/orders' },
    defaultHostName: 'orders-fn.azurewebsites.net',
    ...overrides
  };
}

function functionsFixture(): FunctionSummary[] {
  return [
    {
      name: 'create-order',
      bindings: [
        { type: 'httpTrigger', direction: 'in', route: 'orders/{id}', methods: ['post', 'put'], authLevel: 'function' },
        { type: 'http', direction: 'out' }
      ]
    },
    {
      name: 'on-order-event',
      bindings: [
        { type: 'serviceBusTrigger', direction: 'in', topicName: 'order-events', subscriptionName: 'billing', connectionSettingName: 'ServiceBusConnection' }
      ]
    },
    { name: 'no-trigger', bindings: [{ type: 'blob', direction: 'out', path: 'exports/{name}' }] }
  ];
}

function client(overrides: Partial<AzureFunctionsClient> = {}): AzureFunctionsClient {
  return {
    listFunctionApps: vi.fn(async () => [app()]),
    listFunctions: vi.fn(async () => functionsFixture()),
    probeFunctionsReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('FunctionBindingsProvider', () => {
  it('AZ-FB-001: probe maps authorization failures to skipped:iam and other failures to skipped:error', async () => {
    const denied = new FunctionBindingsProvider(
      client({ probeFunctionsReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: HTTP 403'); }) })
    );
    expect(await denied.probe()).toBe('skipped:iam');

    const broken = new FunctionBindingsProvider(
      client({ probeFunctionsReadAccess: vi.fn(async () => { throw new Error('socket hang up'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');

    expect(await new FunctionBindingsProvider(client()).probe()).toBe('available');
  });

  it('AZ-FB-002: apps with trigger bindings are supported candidates whose id never collides with app-service', async () => {
    const provider = new FunctionBindingsProvider(client());
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.providerType).toBe('function-bindings');
    expect(candidate.supported).toBe(true);
    expect(candidate.id).toBe(`${APP_ID}/functions`);
    expect(candidate.evidence.join(' ')).toContain('serviceBusTrigger');
  });

  it('AZ-FB-003: apps without trigger bindings stay visible as unsupported, never exported', async () => {
    const provider = new FunctionBindingsProvider(
      client({ listFunctions: vi.fn(async () => [{ name: 'out-only', bindings: [{ type: 'blob', direction: 'out' }] }]) })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no trigger bindings/);
  });

  it('AZ-FB-004: export synthesizes partial OpenAPI with real HTTP routes and documented event-source triggers', async () => {
    const provider = new FunctionBindingsProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    const doc = JSON.parse(exported.content) as {
      servers?: Array<{ url: string }>;
      paths: Record<string, Record<string, { description?: string; 'x-azure-trigger-documented'?: boolean }>>;
    };
    expect(doc.servers).toEqual([{ url: 'https://orders-fn.azurewebsites.net' }]);
    expect(Object.keys(doc.paths['/api/orders/{id}']!)).toEqual(['post', 'put']);
    const invoke = doc.paths['/functions/on-order-event/invocations']!.post!;
    expect(invoke['x-azure-trigger-documented']).toBe(true);
    expect(invoke.description).toContain('topic order-events');
    expect(invoke.description).toContain('connection setting name: ServiceBusConnection');
  });

  it('AZ-FB-005: httpTrigger without route or methods defaults to /api/<name> with get+post', async () => {
    const provider = new FunctionBindingsProvider(
      client({ listFunctions: vi.fn(async () => [{ name: 'ping', bindings: [{ type: 'httpTrigger', direction: 'in' }] }]) })
    );
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const doc = JSON.parse(exported.content) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths)).toEqual(['/api/ping']);
    expect(Object.keys(doc.paths['/api/ping']!)).toEqual(['get', 'post']);
  });

  it('AZ-FB-006: connection values, keys, and secrets never appear in candidates or exports', async () => {
    // Even if a hostile control plane echoed a value into an unknown field, the
    // client-side projection drops unknown fields; the provider must still
    // never serialize anything beyond setting names.
    const provider = new FunctionBindingsProvider(client());
    const candidates = await provider.listCandidates();
    const exported = await provider.exportSpec(candidates[0]!);
    for (const serialized of [JSON.stringify(candidates), exported.content, JSON.stringify(exported.evidence)]) {
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toMatch(/SharedAccessKey/i);
      expect(serialized).not.toMatch(/listFunctionKeys|listHostKeys/i);
    }
    expect(exported.content).toContain('ServiceBusConnection');
  });

  it('AZ-FB-007: export re-hydrates functions when the candidate cache is cold', async () => {
    const provider = new FunctionBindingsProvider(client());
    const [candidate] = await provider.listCandidates();
    const cold = new FunctionBindingsProvider(client());
    const exported = await cold.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
  });
});
