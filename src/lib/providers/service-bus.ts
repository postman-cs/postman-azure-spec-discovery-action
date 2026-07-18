import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureServiceBusClient, ServiceBusSubscriptionSummary, ServiceBusTopicSummary } from '../azure/clients.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface ServiceBusProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

function sanitizeEndpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return undefined;
  }
}

function filterDescription(subscription: ServiceBusSubscriptionSummary): string {
  const ruleParts = subscription.rules.map((rule) => {
    if (rule.sqlExpression) return `rule ${rule.name}: SQL filter \`${rule.sqlExpression}\``;
    if (rule.correlationSummary) return `rule ${rule.name}: correlation filter (${rule.correlationSummary})`;
    return `rule ${rule.name}`;
  });
  return [`Subscription ${subscription.name}`, ...ruleParts].join('; ');
}

/**
 * Service Bus provider (namespace topics + subscriptions + rules).
 *
 * A namespace is a candidate per topic that has at least one subscription: the
 * topic is an asynchronous publish contract whose consumers are declared
 * control-plane-side. The provider synthesizes a deliberately PARTIAL OpenAPI
 * 3.0 document describing the publish surface: one POST operation per topic
 * mirroring the Service Bus data-plane message path, with every subscription
 * and its SQL/correlation filter metadata described on the operation. Message
 * payload schemas are not declared in ARM, so the export is completeness:
 * partial. Topics without subscriptions stay visible as unsupported
 * candidates.
 *
 * Credential hygiene: only topic/subscription/rule GETs are called -- never
 * namespace/topic authorization rules, never listKeys, never connection
 * strings. The only URL surfaced is the namespace's public serviceBusEndpoint
 * origin.
 */
export class ServiceBusProvider implements SpecProvider {
  public readonly type = 'service-bus' as const;

  private readonly client: AzureServiceBusClient;
  private readonly options: ServiceBusProviderOptions;
  private readonly topicCache = new Map<string, ServiceBusTopicSummary>();

  public constructor(client: AzureServiceBusClient, options: ServiceBusProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeServiceBusReadAccess(this.options.resourceGroup);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const namespaces = await this.client.listNamespaces(this.options.resourceGroup);
    const candidates: SpecCandidate[] = [];
    for (const namespace of namespaces) {
      const topics = await this.client.listTopics(namespace.resourceGroup, namespace.name);
      for (const topic of topics) {
        this.topicCache.set(topic.id, topic);
        const supported = topic.subscriptions.length > 0;
        candidates.push({
          id: topic.id,
          name: `${namespace.name}/${topic.name}`,
          providerType: 'service-bus',
          resourceGroup: namespace.resourceGroup,
          tags: namespace.tags,
          supported,
          evidence: [
            supported
              ? `Service Bus topic ${topic.name} in namespace ${namespace.name} has ${topic.subscriptions.length} subscription(s)`
              : `Service Bus topic ${topic.name} in namespace ${namespace.name} has no subscriptions`,
            ...topic.subscriptions.flatMap((subscription) =>
              subscription.rules
                .filter((rule) => rule.sqlExpression || rule.correlationSummary)
                .map((rule) => `Subscription ${subscription.name} rule ${rule.name} filters deliveries`)
            )
          ],
          meta: {
            namespaceName: namespace.name,
            topicName: topic.name,
            resourceGroup: namespace.resourceGroup,
            subscriptionCount: String(topic.subscriptions.length),
            ...(namespace.serviceBusEndpoint ? { serviceBusEndpoint: namespace.serviceBusEndpoint } : {})
          }
        });
      }
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Service Bus topic ${candidate.name} has no subscriptions to describe`);
    }
    const namespaceName = candidate.meta.namespaceName ?? '';
    const topicName = candidate.meta.topicName ?? '';
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    if (!namespaceName || !topicName || !resourceGroup) {
      throw new Error('Service Bus candidate is missing resource coordinates');
    }
    let topic = this.topicCache.get(candidate.id);
    if (!topic) {
      const topics = await this.client.listTopics(resourceGroup, namespaceName);
      topic = topics.find((entry) => entry.id === candidate.id || entry.name === topicName);
    }
    if (!topic || topic.subscriptions.length === 0) {
      throw new Error(`Service Bus topic ${topicName} has no subscriptions to describe`);
    }

    const endpoint = sanitizeEndpoint(candidate.meta.serviceBusEndpoint);
    const subscriptionDescriptions = topic.subscriptions.map((subscription) => filterDescription(subscription));

    const document = {
      openapi: '3.0.3',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description:
          'Partial OpenAPI synthesized from Service Bus topic metadata: the publish path mirrors the Service Bus data-plane message contract, and consumers are described from control-plane subscriptions and rules. Message payload schemas are not declared in ARM.'
      },
      ...(endpoint ? { servers: [{ url: endpoint }] } : {}),
      paths: {
        [`/${topicName}/messages`]: {
          post: {
            operationId: `publish-${topicName}`,
            summary: `Publish a message to Service Bus topic ${topicName}`,
            description: ['Declared consumers:', ...subscriptionDescriptions].join('\n'),
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', description: 'Message payload (schema not declared in Service Bus metadata)' }
                }
              }
            },
            responses: { default: { description: 'Service Bus data-plane response (not declared in ARM metadata)' } }
          }
        }
      }
    };

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      completeness: 'partial',
      evidence: [
        `Synthesized partial publish contract for Service Bus topic ${topicName} with ${topic.subscriptions.length} subscription(s)`,
        'Authorization rules and key/connection-string surfaces were never requested; the namespace public endpoint is the only URL surfaced'
      ]
    };
  }
}
