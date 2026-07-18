import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureLogicWorkflowsClient, LogicWorkflowDetail } from '../azure/clients.js';
import { toSafePublicUrl } from './public-url.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface LogicAppsProviderOptions {
  resourceGroup?: string;
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

function requestTriggers(detail: LogicWorkflowDetail): RequestTrigger[] {
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

/**
 * Consumption Logic Apps provider (Microsoft.Logic/workflows).
 *
 * A workflow is an inbound HTTP API when its definition has Request (HTTP)
 * triggers; the provider synthesizes a deliberately PARTIAL OpenAPI 3.0
 * document from those triggers: paths from relativePath, methods, and the
 * declared request schema. Responses are unknowable from the definition, so
 * every operation carries a default response. Workflows without Request
 * triggers stay visible as unsupported candidates.
 *
 * Credential hygiene: the provider never calls listCallbackUrl (SAS token in
 * the URL) or listSwagger (POST outside Reader). accessEndpoint (SAS-free
 * base endpoint) is sanitized before it is surfaced as an OpenAPI server entry.
 */
export class LogicAppsProvider implements SpecProvider {
  public readonly type = 'logic-apps' as const;

  private readonly client: AzureLogicWorkflowsClient;
  private readonly options: LogicAppsProviderOptions;
  private readonly detailCache = new Map<string, LogicWorkflowDetail>();

  public constructor(client: AzureLogicWorkflowsClient, options: LogicAppsProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeLogicWorkflowsReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const workflows = await this.client.listWorkflows(this.options.resourceGroup);
    const candidates: SpecCandidate[] = [];
    for (const workflow of workflows) {
      if ((workflow.state ?? '').toLowerCase() === 'disabled') continue;
      const detail = await this.client.getWorkflow(workflow.resourceGroup, workflow.name);
      this.detailCache.set(detail.id || workflow.id, detail);
      const triggers = requestTriggers(detail);
      const supported = triggers.length > 0;
      const accessEndpoint = toSafePublicUrl(detail.accessEndpoint);
      candidates.push({
        id: workflow.id,
        name: workflow.name,
        providerType: 'logic-apps',
        resourceGroup: workflow.resourceGroup,
        tags: workflow.tags,
        supported,
        evidence: [
          supported
            ? `Logic App workflow ${workflow.name} exposes ${triggers.length} HTTP Request trigger(s)`
            : `Logic App workflow ${workflow.name} has no HTTP Request trigger`,
          ...(accessEndpoint ? [`Access endpoint: ${accessEndpoint}`] : [])
        ],
        meta: {
          resourceGroup: workflow.resourceGroup,
          workflowName: workflow.name,
          triggerCount: String(triggers.length)
        }
      });
    }
    return candidates;
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
    const detail =
      this.detailCache.get(candidate.id) ?? (await this.client.getWorkflow(resourceGroup, workflowName));
    const triggers = requestTriggers(detail);
    const accessEndpoint = toSafePublicUrl(detail.accessEndpoint);
    if (triggers.length === 0) {
      throw new Error(`Logic App workflow ${workflowName} has no HTTP Request trigger to export`);
    }

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
      if (trigger.schema && typeof trigger.schema === 'object' && Object.keys(trigger.schema).length > 0) {
        operation.requestBody = {
          content: { 'application/json': { schema: trigger.schema } }
        };
      }
      paths[pathKey] = { ...(paths[pathKey] ?? {}), [method]: operation };
    }

    const document = {
      openapi: '3.0.3',
      info: {
        title: detail.name,
        version: '1.0.0',
        description: 'Partial OpenAPI synthesized from Logic App Request triggers; responses are not declared in the workflow definition.'
      },
      ...(accessEndpoint ? { servers: [{ url: accessEndpoint }] } : {}),
      paths
    };

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      completeness: 'partial',
      evidence: [
        `Synthesized partial OpenAPI from ${triggers.length} Request trigger(s) of Logic App workflow ${workflowName}`,
        'Callback URLs (SAS) were never requested; any access endpoint was reduced to its public origin and path'
      ]
    };
  }
}
