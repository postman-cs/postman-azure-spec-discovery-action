import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureFunctionsClient, FunctionBindingSummary, FunctionSummary } from '../azure/clients.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface FunctionBindingsProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

interface TriggerView {
  functionName: string;
  triggerType: string;
  route?: string;
  methods: string[];
  authLevel?: string;
  connectionSettingName?: string;
  detail?: string;
}

function triggerOf(fn: FunctionSummary): TriggerView | undefined {
  const trigger = fn.bindings.find((binding) => binding.type.toLowerCase().endsWith('trigger'));
  if (!trigger) return undefined;
  return {
    functionName: fn.name,
    triggerType: trigger.type,
    ...(trigger.route ? { route: trigger.route } : {}),
    methods: trigger.methods ?? [],
    ...(trigger.authLevel ? { authLevel: trigger.authLevel } : {}),
    ...(trigger.connectionSettingName ? { connectionSettingName: trigger.connectionSettingName } : {}),
    ...(triggerDetail(trigger) ? { detail: triggerDetail(trigger) } : {})
  };
}

function triggerDetail(binding: FunctionBindingSummary): string | undefined {
  const parts = [
    binding.queueName ? `queue ${binding.queueName}` : undefined,
    binding.topicName ? `topic ${binding.topicName}` : undefined,
    binding.subscriptionName ? `subscription ${binding.subscriptionName}` : undefined,
    binding.eventHubName ? `event hub ${binding.eventHubName}` : undefined,
    binding.path ? `path ${binding.path}` : undefined,
    binding.schedule ? `schedule ${binding.schedule}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function httpPathFor(trigger: TriggerView): string {
  const route = (trigger.route ?? '').trim().replace(/^\/+/, '');
  return route ? `/api/${route}` : `/api/${trigger.functionName}`;
}

/**
 * Function bindings provider (Microsoft.Web/sites/functions config.bindings).
 *
 * A function app is a candidate when at least one of its functions declares a
 * trigger binding. The provider synthesizes a deliberately PARTIAL OpenAPI 3.0
 * document from the trigger topology: httpTrigger functions become real HTTP
 * operations (route + methods from the binding), and event-source triggers
 * (queue, Service Bus, Event Grid, Event Hubs, blob, timer) become
 * x-azure-trigger-documented POST entries under /functions/<name>/invocations
 * so the event surface stays visible without inventing public routes.
 * Response contracts are not declared in bindings, so every operation carries
 * a default response and the export is completeness: partial.
 *
 * Credential hygiene: only the functions list GET is called -- never
 * listFunctionKeys, listHostKeys, listFunctionSecrets, or app settings values.
 * Binding connection properties are setting NAMES by design; the client
 * projects only known structural fields and never serializes raw binding
 * payloads beyond them.
 */
export class FunctionBindingsProvider implements SpecProvider {
  public readonly type = 'function-bindings' as const;

  private readonly client: AzureFunctionsClient;
  private readonly options: FunctionBindingsProviderOptions;
  private readonly functionsCache = new Map<string, FunctionSummary[]>();

  public constructor(client: AzureFunctionsClient, options: FunctionBindingsProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeFunctionsReadAccess(this.options.resourceGroup);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const apps = await this.client.listFunctionApps(this.options.resourceGroup);
    const candidates: SpecCandidate[] = [];
    for (const app of apps) {
      const functions = await this.client.listFunctions(app.resourceGroup, app.name);
      const triggers = functions.map(triggerOf).filter((t): t is TriggerView => Boolean(t));
      // Candidate id gets a /functions suffix so it can never collide with the
      // app-service provider's candidate for the same site resource.
      const id = `${app.id}/functions`;
      this.functionsCache.set(id, functions);
      const supported = triggers.length > 0;
      const httpCount = triggers.filter((t) => t.triggerType.toLowerCase() === 'httptrigger').length;
      candidates.push({
        id,
        name: app.name,
        providerType: 'function-bindings',
        resourceGroup: app.resourceGroup,
        tags: app.tags,
        supported,
        evidence: [
          supported
            ? `Function app ${app.name} declares ${triggers.length} trigger binding(s) (${httpCount} HTTP)`
            : `Function app ${app.name} has no functions with trigger bindings`,
          ...triggers
            .filter((t) => t.triggerType.toLowerCase() !== 'httptrigger')
            .map((t) => `Function ${t.functionName}: ${t.triggerType}${t.detail ? ` (${t.detail})` : ''}`)
        ],
        meta: {
          resourceGroup: app.resourceGroup,
          appName: app.name,
          triggerCount: String(triggers.length),
          ...(app.defaultHostName ? { defaultHostName: app.defaultHostName } : {})
        }
      });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Function app ${candidate.name} has no trigger bindings to export`);
    }
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const appName = candidate.meta.appName ?? '';
    if (!resourceGroup || !appName) {
      throw new Error('Function app candidate is missing resource coordinates');
    }
    const functions =
      this.functionsCache.get(candidate.id) ?? (await this.client.listFunctions(resourceGroup, appName));
    const triggers = functions.map(triggerOf).filter((t): t is TriggerView => Boolean(t));
    if (triggers.length === 0) {
      throw new Error(`Function app ${appName} has no trigger bindings to export`);
    }

    const paths: Record<string, Record<string, unknown>> = {};
    for (const trigger of triggers) {
      if (trigger.triggerType.toLowerCase() === 'httptrigger') {
        const pathKey = httpPathFor(trigger);
        const methods = trigger.methods.length > 0 ? trigger.methods : ['get', 'post'];
        for (const rawMethod of methods) {
          const method = HTTP_METHODS.has(rawMethod.toLowerCase()) ? rawMethod.toLowerCase() : 'post';
          paths[pathKey] = {
            ...(paths[pathKey] ?? {}),
            [method]: {
              operationId: `${trigger.functionName}-${method}`,
              summary: `HTTP trigger ${trigger.functionName}`,
              ...(trigger.authLevel ? { description: `authLevel: ${trigger.authLevel}` } : {}),
              responses: { default: { description: 'Function response (not declared in bindings)' } }
            }
          };
        }
        continue;
      }
      const pathKey = `/functions/${trigger.functionName}/invocations`;
      paths[pathKey] = {
        post: {
          operationId: `${trigger.functionName}-invoke`,
          summary: `${trigger.triggerType} ${trigger.functionName}`,
          description: [
            `Event-source trigger (${trigger.triggerType}); this is a documented trigger surface, not a public HTTP route.`,
            ...(trigger.detail ? [trigger.detail] : []),
            ...(trigger.connectionSettingName ? [`connection setting name: ${trigger.connectionSettingName}`] : [])
          ].join('\n'),
          'x-azure-trigger-documented': true,
          responses: { default: { description: 'Trigger invocation (contract not declared in bindings)' } }
        }
      };
    }

    const hostName = candidate.meta.defaultHostName;
    const document = {
      openapi: '3.0.3',
      info: {
        title: appName,
        version: '1.0.0',
        description:
          'Partial OpenAPI synthesized from Azure Functions trigger bindings; response contracts and event payload schemas are not declared in bindings. Non-HTTP trigger entries are documented surfaces, not public routes.'
      },
      ...(hostName ? { servers: [{ url: `https://${hostName}` }] } : {}),
      paths
    };

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      completeness: 'partial',
      evidence: [
        `Synthesized partial OpenAPI from ${triggers.length} trigger binding(s) of function app ${appName}`,
        'Function/host key surfaces and app settings values were never requested; connection references are setting names only'
      ]
    };
  }
}
