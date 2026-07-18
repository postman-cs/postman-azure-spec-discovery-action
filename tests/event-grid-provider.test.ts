import { describe, expect, it, vi } from 'vitest';

import type { AzureEventGridClient, EventGridSourceSummary, EventGridSubscriptionSummary } from '../src/lib/azure/clients.js';
import { EventGridProvider, sanitizeWebhookUrl } from '../src/lib/providers/event-grid.js';

const SECRET_QUERY = 'code=super-secret-token';

function source(overrides: Partial<EventGridSourceSummary> = {}): EventGridSourceSummary {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-events/providers/Microsoft.EventGrid/topics/orders-topic',
    name: 'orders-topic',
    resourceGroup: 'rg-events',
    tags: { 'postman:repo': 'contoso/orders' },
    kind: 'topic',
    ...overrides
  };
}

function webhookSubscription(overrides: Partial<EventGridSubscriptionSummary> = {}): EventGridSubscriptionSummary {
  return {
    name: 'orders-webhook',
    destinationKind: 'WebHook',
    webhookBaseUrl: 'https://hooks.contoso.com/api/orders',
    includedEventTypes: ['Contoso.Orders.Created', 'Contoso.Orders.Cancelled'],
    subjectBeginsWith: '/orders/',
    deliverySchema: 'EventGridSchema',
    ...overrides
  };
}

function client(overrides: Partial<AzureEventGridClient> = {}): AzureEventGridClient {
  return {
    listSources: vi.fn(async () => [source()]),
    listSubscriptions: vi.fn(async () => [webhookSubscription()]),
    probeEventGridReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('sanitizeWebhookUrl', () => {
  it('AZ-EG-000: strips query strings, fragments, and credentials; rejects non-HTTP and unparseable URLs', () => {
    expect(sanitizeWebhookUrl(`https://user:pass@hooks.contoso.com/api/orders?${SECRET_QUERY}#frag`)).toEqual({
      origin: 'https://hooks.contoso.com',
      pathname: '/api/orders'
    });
    expect(sanitizeWebhookUrl('ftp://hooks.contoso.com/x')).toBeUndefined();
    expect(sanitizeWebhookUrl('not a url')).toBeUndefined();
    expect(sanitizeWebhookUrl(undefined)).toBeUndefined();
  });
});

describe('EventGridProvider', () => {
  it('AZ-EG-001: probe maps authorization failures to skipped:iam and other failures to skipped:error', async () => {
    const denied = new EventGridProvider(
      client({ probeEventGridReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: HTTP 403'); }) })
    );
    expect(await denied.probe()).toBe('skipped:iam');

    const broken = new EventGridProvider(
      client({ probeEventGridReadAccess: vi.fn(async () => { throw new Error('ETIMEDOUT'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');

    expect(await new EventGridProvider(client()).probe()).toBe('available');
  });

  it('AZ-EG-002: sources with webhook subscriptions are supported candidates; system topic type is evidence', async () => {
    const provider = new EventGridProvider(
      client({
        listSources: vi.fn(async () => [
          source(),
          source({
            id: '/subscriptions/sub-1/resourceGroups/rg-events/providers/Microsoft.EventGrid/systemTopics/storage-events',
            name: 'storage-events',
            kind: 'system-topic',
            topicType: 'Microsoft.Storage.StorageAccounts'
          })
        ])
      })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.supported).toBe(true);
    expect(candidates[0]!.providerType).toBe('event-grid');
    expect(candidates[1]!.evidence.join(' ')).toContain('Microsoft.Storage.StorageAccounts');
  });

  it('AZ-EG-003: sources with only non-webhook destinations stay visible as unsupported with destination evidence', async () => {
    const provider = new EventGridProvider(
      client({
        listSubscriptions: vi.fn(async () => [
          webhookSubscription({ name: 'to-eventhub', destinationKind: 'EventHub', webhookBaseUrl: undefined })
        ])
      })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    expect(candidates[0]!.evidence.join(' ')).toContain('EventHub');
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no webhook event subscription/);
  });

  it('AZ-EG-004: export synthesizes partial OpenAPI with sanitized servers, webhook paths, and eventType enums', async () => {
    const provider = new EventGridProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.completeness).toBe('partial');
    expect(exported.format).toBe('openapi-json');
    const doc = JSON.parse(exported.content) as {
      openapi: string;
      servers?: Array<{ url: string }>;
      paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { items: { properties: Record<string, { enum?: string[] }> } } }> } } }>;
    };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers).toEqual([{ url: 'https://hooks.contoso.com' }]);
    const post = doc.paths['/api/orders']!.post;
    const schema = post.requestBody.content['application/json']!.schema;
    expect(schema.items.properties.eventType!.enum).toEqual(['Contoso.Orders.Created', 'Contoso.Orders.Cancelled']);
  });

  it('AZ-EG-005: CloudEvents delivery schema switches the envelope and enum property', async () => {
    const provider = new EventGridProvider(
      client({
        listSubscriptions: vi.fn(async () => [
          webhookSubscription({ deliverySchema: 'CloudEventSchemaV1_0', includedEventTypes: ['com.contoso.order.created'] })
        ])
      })
    );
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const doc = JSON.parse(exported.content) as {
      paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { items: { required: string[]; properties: Record<string, { enum?: string[] }> } } }> } } }>;
    };
    const items = doc.paths['/api/orders']!.post.requestBody.content['application/json']!.schema.items;
    expect(items.required).toContain('specversion');
    expect(items.properties.type!.enum).toEqual(['com.contoso.order.created']);
  });

  it('AZ-EG-006: query strings and credentials in destination URLs never reach candidates or exports', async () => {
    const provider = new EventGridProvider(
      client({
        listSubscriptions: vi.fn(async () => [
          webhookSubscription({ webhookBaseUrl: `https://hooks.contoso.com/api/orders?${SECRET_QUERY}` })
        ])
      })
    );
    const candidates = await provider.listCandidates();
    expect(JSON.stringify(candidates)).not.toContain(SECRET_QUERY);
    const exported = await provider.exportSpec(candidates[0]!);
    expect(exported.content).not.toContain(SECRET_QUERY);
    expect(exported.content).not.toContain('super-secret-token');
    expect(JSON.stringify(exported.evidence)).not.toContain(SECRET_QUERY);
  });

  it('AZ-EG-007: two webhook subscriptions on the same path merge into one operation with both described', async () => {
    const provider = new EventGridProvider(
      client({
        listSubscriptions: vi.fn(async () => [
          webhookSubscription({ name: 'sub-a' }),
          webhookSubscription({ name: 'sub-b', includedEventTypes: ['Contoso.Other'] })
        ])
      })
    );
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    const doc = JSON.parse(exported.content) as { paths: Record<string, { post: { description: string } }> };
    expect(Object.keys(doc.paths)).toEqual(['/api/orders']);
    expect(doc.paths['/api/orders']!.post.description).toContain('sub-a');
    expect(doc.paths['/api/orders']!.post.description).toContain('sub-b');
  });
});
