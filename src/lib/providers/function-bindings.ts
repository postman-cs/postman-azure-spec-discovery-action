import type { ProviderProbeStatus } from '../../contracts.js';
import { safeUrlForEvidence } from '../azure/app-service-runtime-client.js';
import type { AzureFunctionsClient, FunctionBindingSummary, FunctionSummary } from '../azure/clients.js';
import { detectFunctionsOpenApiRoutes } from '../azure/functions-openapi.js';
import { fetchSpecFromUrl, SpecFetchError } from '../fetch/spec-fetcher.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { listCandidatesViaHydration } from './types.js';

export interface FunctionBindingsProviderOptions {
  resourceGroup?: string;
  /** Opt-in OpenAPI extension endpoint detection/export. Default false. */
  enableOpenApiExtension?: boolean;
  /** Explicit repo/manifest OpenAPI path (must start with /). */
  explicitOpenApiPath?: string;
  requestTimeoutMs?: number;
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
 * Default export remains deliberately PARTIAL OpenAPI synthesized from trigger
 * bindings. With enableOpenApiExtension, OpenAPI extension endpoints evidenced
 * by function metadata (RenderOpenApiDocument / swagger routes) or an explicit
 * repo path are exported through guarded HTTPS fetch.
 *
 * Credential hygiene: only the functions list GET is called -- never
 * listFunctionKeys, listHostKeys, listFunctionSecrets, or app settings values.
 */
export class FunctionBindingsProvider implements SpecProvider {
  public readonly type = 'function-bindings' as const;

  private readonly client: AzureFunctionsClient;
  private readonly options: FunctionBindingsProviderOptions;
  private readonly functionsCache = new Map<string, FunctionSummary[]>();
  private readonly keyApiCallAttempts: string[] = [];

  public constructor(client: AzureFunctionsClient, options: FunctionBindingsProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  /** Test seam asserting key/secret list APIs were never attempted. */
  public getKeyApiCallAttempts(): readonly string[] {
    return this.keyApiCallAttempts;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeFunctionsReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const apps = await this.client.listFunctionApps(this.options.resourceGroup);
    return apps.map((app) => {
      const id = `${app.id}/functions`;
      return {
        id,
        name: app.name,
        providerType: 'function-bindings' as const,
        resourceGroup: app.resourceGroup,
        tags: app.tags,
        supported: true,
        headerHydrated: false,
        evidence: [
          `Function app ${app.name} enumerated; function binding detail deferred until selected`,
          'Function/host key and app-setting secret list operations were never called'
        ],
        meta: {
          resourceGroup: app.resourceGroup,
          appName: app.name,
          hydrationPending: 'true',
          ...(app.defaultHostName ? { defaultHostName: app.defaultHostName } : {})
        }
      };
    });
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    const out: SpecCandidate[] = [];
    for (const header of headers) {
      out.push(await this.hydrateCandidate(header));
    }
    return out;
  }

  public async hydrateCandidate(header: SpecCandidateHeader): Promise<SpecCandidate> {
    const resourceGroup = header.meta.resourceGroup ?? header.resourceGroup ?? '';
    const appName = header.meta.appName ?? header.name;
    if (!resourceGroup || !appName) {
      throw new Error('Function app header is missing resource coordinates');
    }
    const functions = await this.client.listFunctions(resourceGroup, appName);
    this.keyApiCallAttempts.length = 0;
    const triggers = functions.map(triggerOf).filter((t): t is TriggerView => Boolean(t));
    this.functionsCache.set(header.id, functions);
    const openApiRoutes =
      this.options.enableOpenApiExtension === true
        ? detectFunctionsOpenApiRoutes({
            functions,
            defaultHostName: header.meta.defaultHostName,
            explicitPath: this.options.explicitOpenApiPath
          })
        : [];
    const supported = triggers.length > 0 || openApiRoutes.length > 0;
    const httpCount = triggers.filter((t) => t.triggerType.toLowerCase() === 'httptrigger').length;
    return {
      id: header.id,
      name: header.name,
      providerType: 'function-bindings',
      resourceGroup: header.resourceGroup,
      tags: header.tags,
      supported,
      evidence: [
        supported
          ? `Function app ${appName} declares ${triggers.length} trigger binding(s) (${httpCount} HTTP)`
          : `Function app ${appName} has no functions with trigger bindings`,
        ...openApiRoutes.map((route) => route.evidence),
        ...triggers
          .filter((t) => t.triggerType.toLowerCase() !== 'httptrigger')
          .map((t) => `Function ${t.functionName}: ${t.triggerType}${t.detail ? ` (${t.detail})` : ''}`),
        'Function/host key and app-setting secret list operations were never called'
      ],
      meta: {
        resourceGroup,
        appName,
        triggerCount: String(triggers.length),
        ...(header.meta.defaultHostName ? { defaultHostName: header.meta.defaultHostName } : {}),
        ...(openApiRoutes[0]?.url ? { openApiUrl: openApiRoutes[0].url } : {}),
        ...(openApiRoutes[0]?.path ? { openApiPath: openApiRoutes[0].path } : {}),
        ...(openApiRoutes.length > 0 ? { openApiRouteCount: String(openApiRoutes.length) } : {})
      }
    };
  }

  public listCandidates(): Promise<SpecCandidate[]> {
    return listCandidatesViaHydration(this);
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

    if (this.options.enableOpenApiExtension && candidate.meta.openApiUrl) {
      return this.exportOpenApiExtension(candidate);
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
      contractClass: 'partial',
      evidence: [
        `Synthesized partial OpenAPI from ${triggers.length} trigger binding(s) of function app ${appName}`,
        'Function/host key surfaces and app settings values were never requested; connection references are setting names only'
      ]
    };
  }

  private async exportOpenApiExtension(candidate: SpecCandidate): Promise<SpecExportResult> {
    const openApiUrl = candidate.meta.openApiUrl ?? '';
    if (!openApiUrl) {
      throw new Error(`Function app ${candidate.name} has no evidenced OpenAPI extension URL`);
    }
    const safeUrl = safeUrlForEvidence(openApiUrl);
    const pathEvidence = candidate.meta.openApiPath ?? safeUrl;
    try {
      // Guarded public fetch — never Authorization/Cookie/Azure/GitHub credentials.
      const fetched = await fetchSpecFromUrl(openApiUrl, { timeoutMs: this.options.requestTimeoutMs });
      const validated = parseAndValidateOpenApi(fetched.content);
      const normalized = fetched.content.endsWith('\n') ? fetched.content : `${fetched.content}\n`;
      return {
        content: normalized,
        format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
        filename: validated.isJson ? 'index.json' : 'index.yaml',
        contractClass: 'authoritative',
        evidence: [
          `Fetched Azure Functions OpenAPI extension document from ${pathEvidence}`,
          'Host/function key list operations and app-setting secret reads were never called',
          'No Authorization/Cookie/Azure/GitHub credentials were forwarded on the runtime fetch'
        ]
      };
    } catch (error) {
      if (error instanceof SpecFetchError && error.code === 'private-network-unreachable') {
        throw new Error(
          `Functions OpenAPI extension URL is private-network-unreachable: ${safeUrl}`,
          { cause: error }
        );
      }
      if (error instanceof SpecFetchError && error.code === 'blocked-ssrf') {
        throw new Error(`Functions OpenAPI extension URL blocked by SSRF defenses: ${safeUrl}`, {
          cause: error
        });
      }
      throw error;
    }
  }
}
