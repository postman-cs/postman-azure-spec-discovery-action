import type { TokenCredential } from '@azure/identity';

import type { AzureSdkOptions, LogicWorkflowDetail } from './clients.js';
import {
  armRequest,
  armUrl,
  createArmRestClientOptions,
  extractResourceGroup,
  getArmAccessToken,
  listArmPages,
  type ArmRestClientOptions
} from './arm-rest.js';

const LOGIC_API_VERSION = '2019-05-01';
/** Documented App Service / Standard Logic Apps workflows surface. */
const WEB_WORKFLOWS_API_VERSION = '2023-12-01';

export type LogicListSwaggerResult =
  | { kind: 'swagger'; content: string }
  | { kind: 'permission-denied'; status: number }
  | { kind: 'capability-absent'; status: number; detail?: string }
  | { kind: 'malformed'; detail: string }
  | { kind: 'transient-exhausted'; status: number; retryAfter?: string };

export interface StandardLogicWorkflowSummary {
  id: string;
  name: string;
  siteName: string;
  resourceGroup: string;
  tags: Record<string, string>;
  state?: string;
}

export interface StandardLogicWorkflowDetail {
  id: string;
  name: string;
  siteName: string;
  resourceGroup: string;
  tags: Record<string, string>;
  accessEndpoint?: string;
  /** True when a workflow definition with triggers was returned by ARM. */
  hasDefinition: boolean;
  triggers: LogicWorkflowDetail['triggers'];
}

export interface AzureLogicAppsNativeClient {
  listSwagger(resourceGroup: string, workflowName: string, signal?: AbortSignal): Promise<LogicListSwaggerResult>;
  listStandardWorkflows(resourceGroup?: string, signal?: AbortSignal): Promise<StandardLogicWorkflowSummary[]>;
  getStandardWorkflow(
    resourceGroup: string,
    siteName: string,
    workflowName: string,
    signal?: AbortSignal
  ): Promise<StandardLogicWorkflowDetail>;
  probeStandardLogicAppsReadAccess(resourceGroup?: string, signal?: AbortSignal): Promise<void>;
}

interface WebSiteArmEnvelope {
  id?: string;
  name?: string;
  kind?: string;
  tags?: Record<string, string>;
}

interface WebWorkflowArmEnvelope {
  id?: string;
  name?: string;
  tags?: Record<string, string>;
  properties?: {
    state?: unknown;
    accessEndpoint?: unknown;
    definition?: {
      triggers?: Record<
        string,
        {
          type?: unknown;
          kind?: unknown;
          inputs?: { method?: unknown; relativePath?: unknown; schema?: unknown };
        }
      >;
    };
    files?: Record<string, unknown>;
  };
}

function isWorkflowAppKind(kind: string | undefined): boolean {
  const normalized = (kind ?? '').toLowerCase();
  return normalized.includes('workflowapp') || normalized.includes('logicapp');
}

function projectTriggers(
  definition: WebWorkflowArmEnvelope['properties'] extends infer P
    ? P extends { definition?: infer D }
      ? D
      : undefined
    : undefined
): LogicWorkflowDetail['triggers'] {
  const triggers = (definition as { triggers?: Record<string, unknown> } | undefined)?.triggers ?? {};
  return Object.entries(triggers).map(([triggerName, raw]) => {
    const trigger = (raw ?? {}) as {
      type?: unknown;
      kind?: unknown;
      inputs?: { method?: unknown; relativePath?: unknown; schema?: unknown };
    };
    return {
      name: triggerName,
      type: typeof trigger.type === 'string' ? trigger.type : '',
      kind: typeof trigger.kind === 'string' ? trigger.kind : undefined,
      method: typeof trigger.inputs?.method === 'string' ? trigger.inputs.method : undefined,
      relativePath: typeof trigger.inputs?.relativePath === 'string' ? trigger.inputs.relativePath : undefined,
      schema: trigger.inputs?.schema
    };
  });
}

function parseSwaggerBody(body: unknown): LogicListSwaggerResult {
  if (body === null || body === undefined) {
    return { kind: 'malformed', detail: 'empty listSwagger response' };
  }
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return { kind: 'malformed', detail: 'empty listSwagger string body' };
    return { kind: 'swagger', content: trimmed.endsWith('\n') ? trimmed : `${trimmed}\n` };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'malformed', detail: 'listSwagger response was not an object' };
  }
  const record = body as Record<string, unknown>;
  // Documented shape is a raw swagger/OpenAPI document (swagger/openapi keys).
  if (typeof record.swagger === 'string' || typeof record.openapi === 'string') {
    return { kind: 'swagger', content: `${JSON.stringify(record, null, 2)}\n` };
  }
  // Some gateways wrap under properties.value / value.
  const nested =
    (record.value as unknown) ??
    ((record.properties as { value?: unknown } | undefined)?.value as unknown) ??
    ((record.properties as { swagger?: unknown } | undefined)?.swagger as unknown);
  if (typeof nested === 'string' && nested.trim()) {
    const trimmed = nested.trim();
    return { kind: 'swagger', content: trimmed.endsWith('\n') ? trimmed : `${trimmed}\n` };
  }
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>;
    if (typeof nestedRecord.swagger === 'string' || typeof nestedRecord.openapi === 'string') {
      return { kind: 'swagger', content: `${JSON.stringify(nestedRecord, null, 2)}\n` };
    }
  }
  return { kind: 'malformed', detail: 'listSwagger response lacked a swagger/openapi document' };
}

/**
 * Opt-in native Logic Apps surfaces:
 *  - Consumption `listSwagger` POST (Microsoft.Logic/workflows/listSwagger/action)
 *  - Standard Logic Apps workflows under Microsoft.Web/sites/.../workflows
 *
 * Never calls listCallbackUrl. Never logs SAS material from responses.
 */
export class LogicAppsNativeSdkClient implements AzureLogicAppsNativeClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly options: ArmRestClientOptions;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.options = createArmRestClientOptions(options);
  }

  public async listSwagger(
    resourceGroup: string,
    workflowName: string,
    signal?: AbortSignal
  ): Promise<LogicListSwaggerResult> {
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const url = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Logic/workflows/${encodeURIComponent(workflowName)}` +
        `/listSwagger?api-version=${LOGIC_API_VERSION}`
    );
    const response = await armRequest(url, token, {
      maxAttempts: this.options.maxAttempts,
      requestTimeoutMs: this.options.requestTimeoutMs,
      operation: 'Logic workflow listSwagger',
      method: 'POST',
      body: '',
      signal,
      sleep: this.options.sleep,
      random: this.options.random
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: 'permission-denied', status: response.status };
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { kind: 'capability-absent', status: response.status };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        kind: 'transient-exhausted',
        status: response.status,
        ...(response.headers.get('retry-after')
          ? { retryAfter: response.headers.get('retry-after') ?? undefined }
          : {})
      };
    }
    if (!response.ok) {
      return { kind: 'capability-absent', status: response.status, detail: `HTTP ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return {
        kind: 'malformed',
        detail: error instanceof Error ? error.message : 'listSwagger body was not JSON'
      };
    }
    return parseSwaggerBody(body);
  }

  public async listStandardWorkflows(
    resourceGroup?: string,
    signal?: AbortSignal
  ): Promise<StandardLogicWorkflowSummary[]> {
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const siteScope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites`
      : 'providers/Microsoft.Web/sites';
    const sitesUrl = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}/${siteScope}?api-version=${WEB_WORKFLOWS_API_VERSION}`
    );
    const sites = await listArmPages<WebSiteArmEnvelope>(
      sitesUrl,
      token,
      'Standard Logic App site listing',
      this.options,
      signal
    );

    const summaries: StandardLogicWorkflowSummary[] = [];
    for (const site of sites) {
      if (!isWorkflowAppKind(site.kind)) continue;
      const siteName = site.name ?? '';
      const siteRg = extractResourceGroup(site.id) || resourceGroup || '';
      if (!siteName || !siteRg) continue;
      const workflowsUrl = armUrl(
        this.options.cloud,
        `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
          `/resourceGroups/${encodeURIComponent(siteRg)}` +
          `/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}` +
          `/workflows?api-version=${WEB_WORKFLOWS_API_VERSION}`
      );
      let workflows: WebWorkflowArmEnvelope[];
      try {
        workflows = await listArmPages<WebWorkflowArmEnvelope>(
          workflowsUrl,
          token,
          'Standard Logic App workflow listing',
          this.options,
          signal
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/HTTP (401|403)/i.test(message) || /authorizationfailed|forbidden/i.test(message)) {
          throw error;
        }
        // Site kind matched but workflows child API absent — skip this site.
        continue;
      }
      for (const workflow of workflows) {
        const id = workflow.id ?? '';
        const rawName = workflow.name ?? '';
        if (!id || !rawName) continue;
        // ARM may return "<site>/<workflow>" names.
        const name = rawName.includes('/') ? (rawName.split('/').pop() ?? rawName) : rawName;
        summaries.push({
          id,
          name,
          siteName,
          resourceGroup: siteRg,
          tags: { ...(site.tags ?? {}), ...(workflow.tags ?? {}) },
          state: typeof workflow.properties?.state === 'string' ? workflow.properties.state : undefined
        });
      }
    }
    return summaries;
  }

  public async getStandardWorkflow(
    resourceGroup: string,
    siteName: string,
    workflowName: string,
    signal?: AbortSignal
  ): Promise<StandardLogicWorkflowDetail> {
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const url = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}` +
        `/workflows/${encodeURIComponent(workflowName)}?api-version=${WEB_WORKFLOWS_API_VERSION}`
    );
    const response = await armRequest(url, token, {
      maxAttempts: this.options.maxAttempts,
      requestTimeoutMs: this.options.requestTimeoutMs,
      operation: 'Standard Logic App workflow read',
      signal,
      sleep: this.options.sleep,
      random: this.options.random
    });
    if (!response.ok) {
      throw new Error(`Standard Logic App workflow read failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as WebWorkflowArmEnvelope;
    const id = body.id ?? '';
    const accessEndpoint = body.properties?.accessEndpoint;
    const triggers = projectTriggers(body.properties?.definition);
    const hasDefinition = Boolean(body.properties?.definition) || triggers.length > 0;
    return {
      id,
      name: workflowName,
      siteName,
      resourceGroup: extractResourceGroup(id) || resourceGroup,
      tags: body.tags ?? {},
      accessEndpoint: typeof accessEndpoint === 'string' && accessEndpoint ? accessEndpoint : undefined,
      hasDefinition,
      triggers
    };
  }

  public async probeStandardLogicAppsReadAccess(resourceGroup?: string, signal?: AbortSignal): Promise<void> {
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites`
      : 'providers/Microsoft.Web/sites';
    const url = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${WEB_WORKFLOWS_API_VERSION}&$top=1`
    );
    const response = await armRequest(url, token, {
      maxAttempts: this.options.maxAttempts,
      requestTimeoutMs: this.options.requestTimeoutMs,
      operation: 'Standard Logic App probe',
      signal,
      sleep: this.options.sleep,
      random: this.options.random
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: standard logic app probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Standard logic app probe failed with HTTP ${response.status}`);
    }
  }
}
