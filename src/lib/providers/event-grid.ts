import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureEventGridClient, EventGridSourceSummary, EventGridSubscriptionSummary } from '../azure/clients.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface EventGridProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

/**
 * Sanitize a webhook destination URL for surfacing: parse, drop credentials,
 * query string, and fragment, and return only origin + path. Unparseable
 * URLs yield undefined and are never surfaced.
 */
export function sanitizeWebhookUrl(raw: string | undefined): { origin: string; pathname: string } | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return { origin: url.origin, pathname: url.pathname || '/' };
  } catch {
    return undefined;
  }
}

const EVENT_GRID_ENVELOPE_SCHEMA = {
  type: 'object',
  description: 'Event Grid event schema envelope',
  required: ['id', 'subject', 'eventType', 'eventTime', 'data'],
  properties: {
    id: { type: 'string' },
    topic: { type: 'string' },
    subject: { type: 'string' },
    eventType: { type: 'string' },
    eventTime: { type: 'string', format: 'date-time' },
    dataVersion: { type: 'string' },
    metadataVersion: { type: 'string' },
    data: { type: 'object' }
  }
} as const;

const CLOUD_EVENTS_ENVELOPE_SCHEMA = {
  type: 'object',
  description: 'CloudEvents 1.0 schema envelope',
  required: ['specversion', 'id', 'source', 'type'],
  properties: {
    specversion: { type: 'string', enum: ['1.0'] },
    id: { type: 'string' },
    source: { type: 'string' },
    type: { type: 'string' },
    subject: { type: 'string' },
    time: { type: 'string', format: 'date-time' },
    datacontenttype: { type: 'string' },
    data: { type: 'object' }
  }
} as const;

function envelopeSchemaFor(deliverySchema: string | undefined, includedEventTypes: string[]): Record<string, unknown> {
  const base = (deliverySchema ?? '').toLowerCase().includes('cloudevent')
    ? CLOUD_EVENTS_ENVELOPE_SCHEMA
    : EVENT_GRID_ENVELOPE_SCHEMA;
  const typeProperty = base === CLOUD_EVENTS_ENVELOPE_SCHEMA ? 'type' : 'eventType';
  const schema = JSON.parse(JSON.stringify(base)) as { properties: Record<string, Record<string, unknown>> };
  if (includedEventTypes.length > 0) {
    schema.properties[typeProperty] = { ...schema.properties[typeProperty], enum: includedEventTypes };
  }
  return schema as unknown as Record<string, unknown>;
}

function subscriptionFilterEvidence(subscription: EventGridSubscriptionSummary): string[] {
  const parts: string[] = [];
  if (subscription.includedEventTypes.length > 0) {
    parts.push(`event types: ${subscription.includedEventTypes.join(', ')}`);
  }
  if (subscription.subjectBeginsWith) parts.push(`subject begins with ${subscription.subjectBeginsWith}`);
  if (subscription.subjectEndsWith) parts.push(`subject ends with ${subscription.subjectEndsWith}`);
  return parts;
}

/**
 * Event Grid provider (topics, domains, and system topics).
 *
 * A source is an inbound webhook API surface when at least one of its event
 * subscriptions delivers to a WebHook destination. The provider synthesizes a
 * deliberately PARTIAL OpenAPI 3.0 document describing the webhook delivery
 * contract: one POST operation per sanitized destination path, request bodies
 * from the delivery schema envelope (Event Grid or CloudEvents), and
 * `eventType` enums from includedEventTypes filters. Sources without webhook
 * subscriptions stay visible as unsupported candidates.
 *
 * Credential hygiene: the ARM GET surface only ever exposes the server-side
 * `endpointBaseUrl` (Azure never returns the full `endpointUrl`, which may
 * carry query-string tokens); the client maps only that field, and the
 * provider still defensively strips credentials, query, and fragment from
 * every URL before surfacing it.
 */
export class EventGridProvider implements SpecProvider {
  public readonly type = 'event-grid' as const;

  private readonly client: AzureEventGridClient;
  private readonly options: EventGridProviderOptions;
  private readonly subscriptionCache = new Map<string, EventGridSubscriptionSummary[]>();

  public constructor(client: AzureEventGridClient, options: EventGridProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeEventGridReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const sources = await this.client.listSources(this.options.resourceGroup);
    const candidates: SpecCandidate[] = [];
    for (const source of sources) {
      const subscriptions = await this.client.listSubscriptions({
        kind: source.kind,
        resourceGroup: source.resourceGroup,
        name: source.name
      });
      this.subscriptionCache.set(source.id, subscriptions);
      const webhookSubscriptions = subscriptions.filter((s) => sanitizeWebhookUrl(s.webhookBaseUrl));
      const otherDestinations = subscriptions.filter((s) => !s.webhookBaseUrl && s.destinationKind);
      const supported = webhookSubscriptions.length > 0;
      candidates.push({
        id: source.id,
        name: source.name,
        providerType: 'event-grid',
        resourceGroup: source.resourceGroup,
        tags: source.tags,
        supported,
        evidence: [
          supported
            ? `Event Grid ${source.kind} ${source.name} delivers to ${webhookSubscriptions.length} webhook subscription(s)`
            : `Event Grid ${source.kind} ${source.name} has no webhook event subscription`,
          ...(source.topicType ? [`System topic type: ${source.topicType}`] : []),
          ...otherDestinations.map((s) => `Subscription ${s.name} delivers to ${s.destinationKind} (not a webhook contract)`)
        ],
        meta: {
          kind: source.kind,
          resourceGroup: source.resourceGroup,
          sourceName: source.name,
          webhookSubscriptionCount: String(webhookSubscriptions.length)
        }
      });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Event Grid source ${candidate.name} has no webhook event subscription to export`);
    }
    const kind = (candidate.meta.kind ?? 'topic') as EventGridSourceSummary['kind'];
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const sourceName = candidate.meta.sourceName ?? '';
    if (!resourceGroup || !sourceName) {
      throw new Error('Event Grid candidate is missing resource coordinates');
    }
    const subscriptions =
      this.subscriptionCache.get(candidate.id) ??
      (await this.client.listSubscriptions({ kind, resourceGroup, name: sourceName }));

    const servers = new Set<string>();
    const paths: Record<string, Record<string, unknown>> = {};
    let webhookCount = 0;
    for (const subscription of subscriptions) {
      const sanitized = sanitizeWebhookUrl(subscription.webhookBaseUrl);
      if (!sanitized) continue;
      webhookCount += 1;
      servers.add(sanitized.origin);
      const existing = paths[sanitized.pathname]?.post as { description?: string } | undefined;
      const filterParts = subscriptionFilterEvidence(subscription);
      const description = [
        `Event Grid webhook delivery for subscription ${subscription.name}`,
        ...(subscription.deliverySchema ? [`delivery schema ${subscription.deliverySchema}`] : []),
        ...filterParts
      ].join('; ');
      if (existing) {
        existing.description = `${existing.description ?? ''}\n${description}`;
        continue;
      }
      paths[sanitized.pathname] = {
        post: {
          operationId: subscription.name,
          summary: `Webhook delivery to ${sanitized.pathname}`,
          description,
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: envelopeSchemaFor(subscription.deliverySchema, subscription.includedEventTypes)
                }
              }
            }
          },
          responses: { default: { description: 'Webhook handler response (contract not declared in Event Grid)' } }
        }
      };
    }

    const document = {
      openapi: '3.0.3',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description: `Partial OpenAPI synthesized from Event Grid ${kind} webhook event subscriptions; handler responses and payload data schemas are not declared in Event Grid.`
      },
      ...(servers.size > 0 ? { servers: [...servers].map((url) => ({ url })) } : {}),
      paths
    };

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      completeness: 'partial',
      evidence: [
        `Synthesized partial OpenAPI from ${webhookCount} webhook subscription(s) of Event Grid ${kind} ${sourceName}`,
        'Destination URLs were sanitized to origin + path; query strings, fragments, and credentials are never surfaced'
      ]
    };
  }
}
