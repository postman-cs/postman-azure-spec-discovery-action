import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureLogicWorkflowsClient, LogicWorkflowDetail } from '../azure/clients.js';
import type {
  AzureLogicAppsNativeClient,
  LogicListSwaggerResult,
  StandardLogicWorkflowDetail
} from '../azure/logic-apps-native-client.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import { toSafePublicUrl } from './public-url.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { listCandidatesViaHydration } from './types.js';

export interface LogicAppsProviderOptions {
  resourceGroup?: string;
  /** Opt-in Consumption listSwagger POST. Default false. */
  enableListSwagger?: boolean;
  /** When true with enableListSwagger, malformed native responses fail instead of synthesizing. */
  requireNativeSwagger?: boolean;
  /** Optional focused native client for listSwagger + Standard workflows. */
  nativeClient?: AzureLogicAppsNativeClient;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

interface RequestTrigger {
  name: string;
  method?: string;
  relativePath?: string;
  schema?: unknown;
}

function requestTriggers(detail: Pick<LogicWorkflowDetail, 'triggers'>): RequestTrigger[] {
  return detail.triggers
    .filter((trigger) => trigger.type.toLowerCase() === 'request' && (trigger.kind ?? 'Http').toLowerCase() === 'http')
    .map((trigger) => ({
      name: trigger.name,
      method: trigger.method,
      relativePath: trigger.relativePath,
      schema: trigger.schema
    }));
}

/**
 * Normalize a trigger relativePath into an OpenAPI path template:
 * Logic Apps uses the same {param} syntax; ensure a single leading slash.
 */
function toOpenApiPath(relativePath: string | undefined, triggerName: string): string {
  const raw = (relativePath ?? '').trim();
  if (!raw) return `/triggers/${triggerName}/invoke`;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** Pretty-print JSON native swagger when valid; preserve YAML/native bytes otherwise. */
function normalizeExportedSpecContent(content: string, isJson: boolean): string {
  if (!isJson) {
    return content.endsWith('\n') ? content : `${content}\n`;
  }
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  } catch {
    return content.endsWith('\n') ? content : `${content}\n`;
  }
}

function synthesizeFromTriggers(
  name: string,
  triggers: RequestTrigger[],
  accessEndpoint: string | undefined,
  evidencePrefix: string
): SpecExportResult {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const trigger of triggers) {
    const pathKey = toOpenApiPath(trigger.relativePath, trigger.name);
    const method = HTTP_METHODS.has((trigger.method ?? 'post').toLowerCase())
      ? (trigger.method ?? 'post').toLowerCase()
      : 'post';
    const operation: Record<string, unknown> = {
      operationId: trigger.name,
      summary: `Request trigger ${trigger.name}`,
      responses: { default: { description: 'Workflow response (not declared in the workflow definition)' } }
    };
    if (trigger.schema && typeof trigger.schema === 'object' && Object.keys(trigger.schema as object).length > 0) {
      operation.requestBody = {
        content: { 'application/json': { schema: trigger.schema } }
      };
    }
    paths[pathKey] = { ...(paths[pathKey] ?? {}), [method]: operation };
  }

  const document = {
    openapi: '3.0.3',
    info: {
      title: name,
      version: '1.0.0',
      description:
        'Partial OpenAPI synthesized from Logic App Request triggers; responses are not declared in the workflow definition.'
    },
    ...(accessEndpoint ? { servers: [{ url: accessEndpoint }] } : {}),
    paths
  };

  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    format: 'openapi-json',
    filename: 'index.json',
    completeness: 'partial',
    contractClass: 'partial',
    evidence: [
      `${evidencePrefix} from ${triggers.length} Request trigger(s)`,
      'Callback URLs (SAS) were never requested; any access endpoint was reduced to its public origin and path'
    ]
  };
}

/**
 * Consumption + Standard Logic Apps provider.
 *
 * Default path remains Reader-only Request-trigger synthesis. Opt-in
 * `listSwagger` uses ARM POST through the cloud profile/retry/timeout stack.
 * Permission denial / capability absent falls back to synthesis unless the
 * caller required native swagger. Permanent malformed native responses are not
 * silently synthesized when requireNativeSwagger is set.
 *
 * Standard Logic Apps (`Microsoft.Web/sites/workflows`) are enumerated when a
 * native client is supplied; unsupported definitions stay association-only.
 */
export class LogicAppsProvider implements SpecProvider {
  public readonly type = 'logic-apps' as const;

  private readonly client: AzureLogicWorkflowsClient;
  private readonly options: LogicAppsProviderOptions;
  private readonly detailCache = new Map<string, LogicWorkflowDetail>();
  private readonly standardDetailCache = new Map<string, StandardLogicWorkflowDetail>();
  private readonly listSwaggerCalls: string[] = [];

  public constructor(client: AzureLogicWorkflowsClient, options: LogicAppsProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  /** Test seam: URLs/operations invoked for listSwagger (never callback URLs). */
  public getListSwaggerCallLog(): readonly string[] {
    return this.listSwaggerCalls;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeLogicWorkflowsReadAccess(this.options.resourceGroup, signal);
      if (this.options.nativeClient) {
        await this.options.nativeClient.probeStandardLogicAppsReadAccess(this.options.resourceGroup, signal);
      }
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  /**
   * Lightweight workflow headers only — no per-workflow definition GET.
   * Candidates are retained for narrowing even though support is provisional.
   */
  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const headers: SpecCandidateHeader[] = [];

    const workflows = await this.client.listWorkflows(this.options.resourceGroup);
    for (const workflow of workflows) {
      if ((workflow.state ?? '').toLowerCase() === 'disabled') continue;
      headers.push({
        id: workflow.id,
        name: workflow.name,
        providerType: 'logic-apps',
        resourceGroup: workflow.resourceGroup,
        tags: workflow.tags,
        supported: true,
        headerHydrated: false,
        evidence: [
          `Logic App workflow ${workflow.name} enumerated; definition detail deferred until selected`,
          ...(this.options.enableListSwagger ? ['Native listSwagger opt-in enabled for export'] : [])
        ],
        meta: {
          resourceGroup: workflow.resourceGroup,
          workflowName: workflow.name,
          logicHosting: 'consumption',
          hydrationPending: 'true'
        }
      });
    }

    if (this.options.nativeClient) {
      const standard = await this.options.nativeClient.listStandardWorkflows(this.options.resourceGroup);
      for (const workflow of standard) {
        if ((workflow.state ?? '').toLowerCase() === 'disabled') continue;
        headers.push({
          id: workflow.id,
          name: `${workflow.siteName}/${workflow.name}`,
          providerType: 'logic-apps',
          resourceGroup: workflow.resourceGroup,
          tags: workflow.tags,
          supported: true,
          headerHydrated: false,
          evidence: [
            `Standard Logic App workflow ${workflow.siteName}/${workflow.name} enumerated; definition detail deferred until selected`
          ],
          meta: {
            resourceGroup: workflow.resourceGroup,
            siteName: workflow.siteName,
            workflowName: workflow.name,
            logicHosting: 'standard',
            hydrationPending: 'true'
          }
        });
      }
    }

    return headers;
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
    const workflowName = header.meta.workflowName ?? '';
    if (!resourceGroup || !workflowName) {
      throw new Error('Logic App header is missing resource coordinates');
    }

    if (header.meta.logicHosting === 'standard') {
      if (!this.options.nativeClient) {
        throw new Error('Standard Logic App hydration requires a native client');
      }
      const siteName = header.meta.siteName ?? '';
      if (!siteName) {
        throw new Error('Standard Logic App header is missing siteName');
      }
      const detail = await this.options.nativeClient.getStandardWorkflow(resourceGroup, siteName, workflowName);
      this.standardDetailCache.set(detail.id || header.id, detail);
      const triggers = requestTriggers(detail);
      const supported = detail.hasDefinition && triggers.length > 0;
      const accessEndpoint = toSafePublicUrl(detail.accessEndpoint);
      return {
        id: header.id,
        name: header.name,
        providerType: 'logic-apps',
        resourceGroup: header.resourceGroup,
        tags: header.tags,
        supported,
        evidence: [
          supported
            ? `Standard Logic App workflow ${siteName}/${workflowName} exposes ${triggers.length} HTTP Request trigger(s) via documented definition route`
            : detail.hasDefinition
              ? `Standard Logic App workflow ${siteName}/${workflowName} definition has no HTTP Request trigger`
              : `Standard Logic App workflow ${siteName}/${workflowName} has no documented definition/spec route; association-only`,
          ...(accessEndpoint ? [`Access endpoint: ${accessEndpoint}`] : [])
        ],
        meta: {
          resourceGroup,
          siteName,
          workflowName,
          logicHosting: 'standard',
          triggerCount: String(triggers.length),
          ...(supported ? {} : { contractClass: 'association-only' })
        }
      };
    }

    const detail = await this.client.getWorkflow(resourceGroup, workflowName);
    this.detailCache.set(detail.id || header.id, detail);
    const triggers = requestTriggers(detail);
    const supported = triggers.length > 0;
    const accessEndpoint = toSafePublicUrl(detail.accessEndpoint);
    return {
      id: header.id,
      name: header.name,
      providerType: 'logic-apps',
      resourceGroup: header.resourceGroup,
      tags: header.tags,
      supported,
      evidence: [
        supported
          ? `Logic App workflow ${workflowName} exposes ${triggers.length} HTTP Request trigger(s)`
          : `Logic App workflow ${workflowName} has no HTTP Request trigger`,
        ...(accessEndpoint ? [`Access endpoint: ${accessEndpoint}`] : []),
        ...(this.options.enableListSwagger ? ['Native listSwagger opt-in enabled for export'] : [])
      ],
      meta: {
        resourceGroup,
        workflowName,
        logicHosting: 'consumption',
        triggerCount: String(triggers.length)
      }
    };
  }

  public listCandidates(): Promise<SpecCandidate[]> {
    return listCandidatesViaHydration(this);
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Logic App workflow ${candidate.name} has no HTTP Request trigger to export`);
    }
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const workflowName = candidate.meta.workflowName ?? '';
    if (!resourceGroup || !workflowName) {
      throw new Error('Logic App candidate is missing resource coordinates');
    }

    if (candidate.meta.logicHosting === 'standard') {
      return this.exportStandard(candidate, resourceGroup, workflowName);
    }
    return this.exportConsumption(candidate, resourceGroup, workflowName);
  }

  private async exportConsumption(
    candidate: SpecCandidate,
    resourceGroup: string,
    workflowName: string
  ): Promise<SpecExportResult> {
    if (this.options.enableListSwagger && this.options.nativeClient) {
      this.listSwaggerCalls.push(`${resourceGroup}/${workflowName}`);
      const native = await this.options.nativeClient.listSwagger(resourceGroup, workflowName);
      const handled = await this.handleListSwaggerResult(native, candidate, resourceGroup, workflowName);
      if (handled) return handled;
    } else if (this.options.enableListSwagger && !this.options.nativeClient) {
      // Interface may also expose listSwagger on the primary client in later wiring.
      const maybeList = (this.client as AzureLogicWorkflowsClient & {
        listSwagger?: AzureLogicAppsNativeClient['listSwagger'];
      }).listSwagger;
      if (maybeList) {
        this.listSwaggerCalls.push(`${resourceGroup}/${workflowName}`);
        const native = await maybeList.call(this.client, resourceGroup, workflowName);
        const handled = await this.handleListSwaggerResult(native, candidate, resourceGroup, workflowName);
        if (handled) return handled;
      }
    }

    return this.synthesizeConsumption(candidate, resourceGroup, workflowName);
  }

  private async handleListSwaggerResult(
    native: LogicListSwaggerResult,
    candidate: SpecCandidate,
    resourceGroup: string,
    workflowName: string
  ): Promise<SpecExportResult | undefined> {
    if (native.kind === 'swagger') {
      try {
        const validated = parseAndValidateOpenApi(native.content);
        const content = normalizeExportedSpecContent(native.content, validated.isJson);
        return {
          content,
          format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
          filename: validated.isJson ? 'index.json' : 'index.yaml',
          completeness: 'full',
          contractClass: 'reconstructed',
          evidence: [
            `Retrieved native listSwagger document for Logic App workflow ${workflowName}`,
            'Callback URLs (SAS) were never requested; any access endpoint was reduced to its public origin and path'
          ]
        };
      } catch (error) {
        if (this.options.requireNativeSwagger) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Native listSwagger for Logic App workflow ${workflowName} was malformed/invalid and native swagger was required: ${detail}`,
            { cause: error }
          );
        }
        return undefined;
      }
    }

    if (native.kind === 'malformed') {
      if (this.options.requireNativeSwagger) {
        throw new Error(
          `Native listSwagger for Logic App workflow ${workflowName} was malformed and native swagger was required: ${native.detail}`
        );
      }
      return undefined;
    }

    if (native.kind === 'transient-exhausted') {
      throw new Error(
        `Native listSwagger for Logic App workflow ${workflowName} exhausted retries with HTTP ${native.status}` +
          (native.retryAfter ? ` (Retry-After: ${native.retryAfter})` : '')
      );
    }

    // permission-denied / capability-absent → Reader-only synthesis fallback
    void candidate;
    void resourceGroup;
    return undefined;
  }

  private async synthesizeConsumption(
    candidate: SpecCandidate,
    resourceGroup: string,
    workflowName: string
  ): Promise<SpecExportResult> {
    const detail =
      this.detailCache.get(candidate.id) ?? (await this.client.getWorkflow(resourceGroup, workflowName));
    const triggers = requestTriggers(detail);
    const accessEndpoint = toSafePublicUrl(detail.accessEndpoint);
    if (triggers.length === 0) {
      throw new Error(`Logic App workflow ${workflowName} has no HTTP Request trigger to export`);
    }
    return synthesizeFromTriggers(
      detail.name,
      triggers,
      accessEndpoint,
      `Synthesized partial OpenAPI`
    );
  }

  private async exportStandard(
    candidate: SpecCandidate,
    resourceGroup: string,
    workflowName: string
  ): Promise<SpecExportResult> {
    const siteName = candidate.meta.siteName ?? '';
    if (!siteName || !this.options.nativeClient) {
      throw new Error(`Standard Logic App workflow ${candidate.name} lacks a documented definition route`);
    }
    const detail =
      this.standardDetailCache.get(candidate.id) ??
      (await this.options.nativeClient.getStandardWorkflow(resourceGroup, siteName, workflowName));
    if (!detail.hasDefinition) {
      throw new Error(
        `Standard Logic App workflow ${siteName}/${workflowName} has no documented definition/spec route (association-only)`
      );
    }
    const triggers = requestTriggers(detail);
    if (triggers.length === 0) {
      throw new Error(`Standard Logic App workflow ${siteName}/${workflowName} has no HTTP Request trigger to export`);
    }
    return synthesizeFromTriggers(
      `${siteName}/${workflowName}`,
      triggers,
      toSafePublicUrl(detail.accessEndpoint),
      `Synthesized partial OpenAPI from Standard Logic App definition`
    );
  }
}
