import { describe, expect, it, vi } from 'vitest';

import type { AzureLogicWorkflowsClient, LogicWorkflowDetail, LogicWorkflowSummary } from '../src/lib/azure/clients.js';
import type {
  AzureLogicAppsNativeClient,
  LogicListSwaggerResult,
  StandardLogicWorkflowDetail,
  StandardLogicWorkflowSummary
} from '../src/lib/azure/logic-apps-native-client.js';
import { LogicAppsProvider } from '../src/lib/providers/logic-apps.js';

const NATIVE_SWAGGER = `${JSON.stringify({
  swagger: '2.0',
  info: { title: 'flow', version: '1.0.0' },
  paths: { '/manual/paths/invoke': { post: { responses: { default: { description: 'ok' } } } } }
})}\n`;

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

function native(overrides: Partial<AzureLogicAppsNativeClient> = {}): AzureLogicAppsNativeClient {
  return {
    listSwagger: vi.fn(async (): Promise<LogicListSwaggerResult> => ({ kind: 'swagger', content: NATIVE_SWAGGER })),
    listStandardWorkflows: vi.fn(async () => [] as StandardLogicWorkflowSummary[]),
    getStandardWorkflow: vi.fn(async () => {
      throw new Error('unused');
    }),
    probeStandardLogicAppsReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('R4 Logic Apps native listSwagger + Standard', () => {
  it('AZ-LOGIC-R4-001: listSwagger success exports reconstructed native document', async () => {
    const nativeClient = native();
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      nativeClient
    });
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('reconstructed');
    expect(exported.completeness).toBe('full');
    expect(exported.format).toBe('openapi-json');
    expect(exported.content).toContain('"swagger": "2.0"');
    expect(exported.evidence.join(' ')).toMatch(/listSwagger/);
    expect(exported.evidence.join(' ')).toMatch(/Callback URLs \(SAS\) were never requested/);
    expect(nativeClient.listSwagger).toHaveBeenCalledWith('rg-flow', 'order-intake');
    expect(provider.getListSwaggerCallLog()).toEqual(['rg-flow/order-intake']);
  });

  it('AZ-LOGIC-R4-002: 401/403 permission denial falls back to Reader-only synthesis', async () => {
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      nativeClient: native({
        listSwagger: vi.fn(async (): Promise<LogicListSwaggerResult> => ({
          kind: 'permission-denied',
          status: 403
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    expect(exported.contractClass).toBe('partial');
    expect(exported.content).toContain('Partial OpenAPI synthesized');
  });

  it('AZ-LOGIC-R4-003: capability-absent falls back to synthesis', async () => {
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      nativeClient: native({
        listSwagger: vi.fn(async (): Promise<LogicListSwaggerResult> => ({
          kind: 'capability-absent',
          status: 404
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
  });

  it('AZ-LOGIC-R4-004: explicit-required malformed native fails without synthesis', async () => {
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      requireNativeSwagger: true,
      nativeClient: native({
        listSwagger: vi.fn(async (): Promise<LogicListSwaggerResult> => ({
          kind: 'malformed',
          detail: 'missing swagger key'
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/malformed.*required/i);
  });

  it('AZ-LOGIC-R4-005: transient 429/5xx exhausted retries surface Retry-After', async () => {
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      nativeClient: native({
        listSwagger: vi.fn(async (): Promise<LogicListSwaggerResult> => ({
          kind: 'transient-exhausted',
          status: 429,
          retryAfter: '12'
        }))
      })
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/429.*Retry-After: 12/i);
  });

  it('AZ-LOGIC-R4-006: never calls listCallbackUrl / never logs SAS', async () => {
    const provider = new LogicAppsProvider(client(), {
      enableListSwagger: true,
      nativeClient: native()
    });
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const blob = JSON.stringify(candidate) + exported.content + JSON.stringify(exported.evidence);
    expect(blob).not.toMatch(/listCallbackUrl/i);
    expect(blob).not.toContain('sig=');
    expect(provider.getListSwaggerCallLog().join(',')).not.toMatch(/callback/i);
  });

  it('AZ-LOGIC-R4-007: Standard Logic Apps with definition Request triggers are supported', async () => {
    const standardSummary: StandardLogicWorkflowSummary = {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/std-app/workflows/http-flow',
      name: 'http-flow',
      siteName: 'std-app',
      resourceGroup: 'rg',
      tags: {},
      state: 'Enabled'
    };
    const standardDetail: StandardLogicWorkflowDetail = {
      id: standardSummary.id,
      name: 'http-flow',
      siteName: 'std-app',
      resourceGroup: 'rg',
      tags: {},
      hasDefinition: true,
      accessEndpoint: 'https://std-app.azurewebsites.net:443/api/http-flow/triggers/manual/invoke',
      triggers: [{ name: 'manual', type: 'Request', kind: 'Http', method: 'POST', relativePath: 'intake' }]
    };
    const provider = new LogicAppsProvider(client({ listWorkflows: vi.fn(async () => []) }), {
      nativeClient: native({
        listStandardWorkflows: vi.fn(async () => [standardSummary]),
        getStandardWorkflow: vi.fn(async () => standardDetail)
      })
    });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(true);
    expect(candidates[0]!.meta.logicHosting).toBe('standard');
    const exported = await provider.exportSpec(candidates[0]!);
    expect(exported.completeness).toBe('partial');
    expect(exported.contractClass).toBe('partial');
  });

  it('AZ-LOGIC-R4-008: Standard Logic Apps without definition stay association-only / unsupported', async () => {
    const standardSummary: StandardLogicWorkflowSummary = {
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/std-app/workflows/opaque',
      name: 'opaque',
      siteName: 'std-app',
      resourceGroup: 'rg',
      tags: {},
      state: 'Enabled'
    };
    const provider = new LogicAppsProvider(client({ listWorkflows: vi.fn(async () => []) }), {
      nativeClient: native({
        listStandardWorkflows: vi.fn(async () => [standardSummary]),
        getStandardWorkflow: vi.fn(async () => ({
          id: standardSummary.id,
          name: 'opaque',
          siteName: 'std-app',
          resourceGroup: 'rg',
          tags: {},
          hasDefinition: false,
          triggers: []
        }))
      })
    });
    const candidates = await provider.listCandidates();
    expect(candidates[0]!.supported).toBe(false);
    expect(candidates[0]!.meta.contractClass).toBe('association-only');
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no HTTP Request trigger|association-only/i);
  });
});
