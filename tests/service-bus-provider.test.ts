import { describe, expect, it, vi } from 'vitest';

import type { AzureServiceBusClient, ServiceBusNamespaceSummary, ServiceBusTopicSummary } from '../src/lib/azure/clients.js';
import { ServiceBusProvider } from '../src/lib/providers/service-bus.js';

const TOPIC_ID =
  '/subscriptions/sub-1/resourceGroups/rg-bus/providers/Microsoft.ServiceBus/namespaces/orders-bus/topics/order-events';

function namespaceSummary(overrides: Partial<ServiceBusNamespaceSummary> = {}): ServiceBusNamespaceSummary {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-bus/providers/Microsoft.ServiceBus/namespaces/orders-bus',
    name: 'orders-bus',
    resourceGroup: 'rg-bus',
    tags: { 'postman:repo': 'contoso/orders' },
    serviceBusEndpoint: 'https://orders-bus.servicebus.windows.net:443/',
    ...overrides
  };
}

function topicSummary(overrides: Partial<ServiceBusTopicSummary> = {}): ServiceBusTopicSummary {
  return {
    id: TOPIC_ID,
    name: 'order-events',
    subscriptions: [
      {
        name: 'billing',
        rules: [{ name: 'high-value', sqlExpression: "amount > 1000 AND region = 'us'" }]
      },
      {
        name: 'audit',
        rules: [{ name: 'corr', correlationSummary: 'correlationId=order-created, contentType=application/json' }]
      }
    ],
    ...overrides
  };
}

function client(overrides: Partial<AzureServiceBusClient> = {}): AzureServiceBusClient {
  const defaultTopic = topicSummary();
  const base: AzureServiceBusClient = {
    listNamespaces: vi.fn(async () => [namespaceSummary()]),
    listTopicHeaders: vi.fn(async () => [{ id: defaultTopic.id, name: defaultTopic.name }]),
    listTopics: vi.fn(async () => [defaultTopic]),
    probeServiceBusReadAccess: vi.fn(async () => undefined)
  };
  const merged = { ...base, ...overrides };
  if (overrides.listTopics && !overrides.listTopicHeaders) {
    merged.listTopicHeaders = vi.fn(async () => {
      const topics = await overrides.listTopics!('rg', 'orders-bus');
      return topics.map((topic) => ({ id: topic.id, name: topic.name }));
    });
  }
  return merged;
}

describe('ServiceBusProvider', () => {
  it('AZ-SB-001: probe maps authorization failures to skipped:iam and other failures to skipped:error', async () => {
    const denied = new ServiceBusProvider(
      client({ probeServiceBusReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: HTTP 403'); }) })
    );
    expect(await denied.probe()).toBe('skipped:iam');

    const broken = new ServiceBusProvider(
      client({ probeServiceBusReadAccess: vi.fn(async () => { throw new Error('EAI_AGAIN'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');

    expect(await new ServiceBusProvider(client()).probe()).toBe('available');
  });

  it('AZ-SB-002: topics with subscriptions are supported candidates named namespace/topic with filter evidence', async () => {
    const provider = new ServiceBusProvider(client());
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.providerType).toBe('service-bus');
    expect(candidate.supported).toBe(true);
    expect(candidate.name).toBe('orders-bus/order-events');
    expect(candidate.tags['postman:repo']).toBe('contoso/orders');
    expect(candidate.evidence.join(' ')).toContain('high-value');
  });

  it('AZ-SB-003: topics without subscriptions stay visible as unsupported, never exported', async () => {
    const provider = new ServiceBusProvider(
      client({ listTopics: vi.fn(async () => [topicSummary({ subscriptions: [] })]) })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no subscriptions/);
  });

  it('AZ-SB-004: export synthesizes a partial publish contract with SQL and correlation filter metadata', async () => {
    const provider = new ServiceBusProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    expect(exported.format).toBe('openapi-json');
    const doc = JSON.parse(exported.content) as {
      openapi: string;
      servers?: Array<{ url: string }>;
      paths: Record<string, { post: { description: string } }>;
    };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers).toEqual([{ url: 'https://orders-bus.servicebus.windows.net' }]);
    const post = doc.paths['/order-events/messages']!.post;
    expect(post.description).toContain("amount > 1000 AND region = 'us'");
    expect(post.description).toContain('correlationId=order-created');
    expect(post.description).toContain('billing');
    expect(post.description).toContain('audit');
  });

  it('AZ-SB-005: no connection strings, SAS material, or key surfaces ever appear in candidates or exports', async () => {
    const provider = new ServiceBusProvider(client());
    const candidates = await provider.listCandidates();
    const exported = await provider.exportSpec(candidates[0]!);
    for (const serialized of [JSON.stringify(candidates), exported.content, JSON.stringify(exported.evidence)]) {
      expect(serialized).not.toMatch(/SharedAccessKey/i);
      expect(serialized).not.toMatch(/listKeys/i);
      expect(serialized).not.toMatch(/Endpoint=sb:/i);
    }
  });

  it('AZ-SB-006: export re-hydrates the topic when the candidate cache is cold', async () => {
    const provider = new ServiceBusProvider(client());
    const [candidate] = await provider.listCandidates();
    const cold = new ServiceBusProvider(client());
    const exported = await cold.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
  });
});
