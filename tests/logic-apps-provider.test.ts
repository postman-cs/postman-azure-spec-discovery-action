import { describe, expect, it, vi } from 'vitest';

import type { AzureLogicWorkflowsClient, LogicWorkflowDetail, LogicWorkflowSummary } from '../src/lib/azure/clients.js';
import { LogicAppsProvider } from '../src/lib/providers/logic-apps.js';
import { deriveOpenApiDocument } from '../src/lib/spec/oas-derivation.js';

function summary(overrides: Partial<LogicWorkflowSummary> = {}): LogicWorkflowSummary {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-flow/providers/Microsoft.Logic/workflows/order-intake',
    name: 'order-intake',
    resourceGroup: 'rg-flow',
    tags: { 'postman:repo': 'contoso/orders' },
    state: 'Enabled',
    ...overrides
  };
}

function detail(overrides: Partial<LogicWorkflowDetail> = {}): LogicWorkflowDetail {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-flow/providers/Microsoft.Logic/workflows/order-intake',
    name: 'order-intake',
    resourceGroup: 'rg-flow',
    tags: { 'postman:repo': 'contoso/orders' },
    accessEndpoint: 'https://prod-27.westus.logic.azure.com/workflows/abc123',
    triggers: [
      {
        name: 'manual',
        type: 'Request',
        kind: 'Http',
        method: 'POST',
        relativePath: 'orders/{orderId}',
        schema: { type: 'object', properties: { orderId: { type: 'string' } } }
      }
    ],
    ...overrides
  };
}

function client(overrides: Partial<AzureLogicWorkflowsClient> = {}): AzureLogicWorkflowsClient {
  return {
    listWorkflows: vi.fn(async () => [summary()]),
    getWorkflow: vi.fn(async () => detail()),
    probeLogicWorkflowsReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('LogicAppsProvider', () => {
  it('AZ-LOGIC-001: probe maps 403 to skipped:iam and other errors to skipped:error', async () => {
    const denied = new LogicAppsProvider(
      client({ probeLogicWorkflowsReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: HTTP 403'); }) })
    );
    expect(await denied.probe()).toBe('skipped:iam');
    const broken = new LogicAppsProvider(
      client({ probeLogicWorkflowsReadAccess: vi.fn(async () => { throw new Error('boom'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');
  });

  it('AZ-LOGIC-002: workflows with Request triggers are supported candidates; disabled workflows are skipped', async () => {
    const provider = new LogicAppsProvider(
      client({
        listWorkflows: vi.fn(async () => [
          summary(),
          summary({ id: '/subscriptions/sub-1/resourceGroups/rg-flow/providers/Microsoft.Logic/workflows/disabled-flow', name: 'disabled-flow', state: 'Disabled' })
        ])
      })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.providerType).toBe('logic-apps');
    expect(candidates[0]!.supported).toBe(true);
    expect(candidates[0]!.tags['postman:repo']).toBe('contoso/orders');
  });

  it('AZ-LOGIC-003: workflows without Request triggers stay visible as unsupported', async () => {
    const provider = new LogicAppsProvider(
      client({ getWorkflow: vi.fn(async () => detail({ triggers: [{ name: 'timer', type: 'Recurrence' }] })) })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no HTTP Request trigger/);
  });

  it('AZ-LOGIC-004: exportSpec synthesizes partial OpenAPI from Request triggers', async () => {
    const provider = new LogicAppsProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    expect(exported.format).toBe('openapi-json');
    const doc = JSON.parse(exported.content) as {
      openapi: string;
      servers?: Array<{ url: string }>;
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers?.[0]?.url).toBe('https://prod-27.westus.logic.azure.com/workflows/abc123');
    expect(doc.paths['/orders/{orderId}']).toBeDefined();
    expect(doc.paths['/orders/{orderId}']!.post).toBeDefined();
    expect(doc.paths['/orders/{orderId}']!.post!.requestBody).toBeDefined();
  });

  it('AZ-LOGIC-005: provider-declared partial survives derivation (never upgraded to full)', async () => {
    const provider = new LogicAppsProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const derivation = deriveOpenApiDocument({ content: exported.content, format: exported.format, title: 'order-intake' });
    expect(derivation?.completeness).toBe('full'); // syntax alone says full...
    expect(exported.completeness).toBe('partial'); // ...but the provider declaration is partial and runtime must keep it
  });

  it('AZ-LOGIC-006: no SAS material ever appears in candidates or exports', async () => {
    const accessEndpoint = new URL('https://prod-27.westus.logic.azure.com:8443/workflows/abc123');
    accessEndpoint.username = 'user';
    accessEndpoint.password = 'pass';
    accessEndpoint.search = 'sig=secret&sp=%2Ftriggers';
    accessEndpoint.hash = 'fragment';
    const provider = new LogicAppsProvider(client({
      getWorkflow: vi.fn(async () => detail({
        accessEndpoint: accessEndpoint.toString()
      }))
    }));
    const candidates = await provider.listCandidates();
    const exported = await provider.exportSpec(candidates[0]!);
    const everything = JSON.stringify(candidates) + exported.content + JSON.stringify(exported.evidence);
    expect(everything).not.toContain('sig=');
    expect(everything).not.toContain('listCallbackUrl');
    expect(everything).not.toContain('sp=');
    expect(everything).not.toContain('user');
    expect(everything).not.toContain('pass');
    expect(everything).not.toContain('fragment');
    expect(everything).toContain('https://prod-27.westus.logic.azure.com:8443/workflows/abc123');
  });

  it('AZ-LOGIC-007: trigger without relativePath falls back to the invoke path and default method post', async () => {
    const provider = new LogicAppsProvider(
      client({
        getWorkflow: vi.fn(async () =>
          detail({ triggers: [{ name: 'manual', type: 'Request', kind: 'Http' }] })
        )
      })
    );
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const doc = JSON.parse(exported.content) as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths['/triggers/manual/invoke']).toBeDefined();
    expect(doc.paths['/triggers/manual/invoke']!.post).toBeDefined();
  });
});
