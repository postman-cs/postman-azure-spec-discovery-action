import { ApiManagementClient } from '@azure/arm-apimanagement';
import { EventGridManagementClient } from '@azure/arm-eventgrid';
import { ServiceBusManagementClient } from '@azure/arm-servicebus';
import type { ApiContract, ApiManagementServiceResource } from '@azure/arm-apimanagement';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { DefaultAzureCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';

import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';

export interface AzureSdkOptions {
  requestTimeoutMs: number;
  maxAttempts: number;
}

export interface ApimServiceSummary {
  name: string;
  resourceGroup: string;
  location?: string;
  tags: Record<string, string>;
}

export interface ApimApiSummary {
  apiId: string;
  displayName: string;
  path?: string;
  apiType: string;
  isCurrent?: boolean;
  apiRevision?: string;
  apiVersion?: string;
  apiVersionSetId?: string;
  serviceName: string;
  resourceGroup: string;
  workspaceId?: string;
}

export interface AppServiceSiteSummary {
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  apiDefinitionUrl?: string;
}

export interface ResourceGraphRow {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  tags: Record<string, string>;
}

export interface SubscriptionSummary {
  subscriptionId: string;
  displayName?: string;
  state?: string;
}

function extractResourceGroup(resourceId: string | undefined): string {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(resourceId ?? '');
  return match?.[1] ?? '';
}

export function createAzureCredential(): TokenCredential {
  return new DefaultAzureCredential();
}

/** Azure control-plane client contracts consumed by the runtime; SDK-backed by default, stubbed in tests. */
export interface AzureApimClient {
  listServices(resourceGroup?: string): Promise<ApimServiceSummary[]>;
  listApis(resourceGroup: string, serviceName: string): Promise<ApimApiSummary[]>;
  exportApi(resourceGroup: string, serviceName: string, apiId: string, workspaceId?: string, format?: ApimExportFormat): Promise<string>;
  getGraphqlSchema(resourceGroup: string, serviceName: string, apiId: string, workspaceId?: string): Promise<string>;
  probeApimReadAccess(resourceGroup?: string): Promise<void>;
}

export interface AzureAppServiceClient {
  listSites(resourceGroup?: string): Promise<AppServiceSiteSummary[]>;
  probeAppServiceReadAccess(resourceGroup?: string): Promise<void>;
}

export interface AzureResourceGraphClient {
  queryResources(subscriptionId: string, kql: string): Promise<ResourceGraphRow[]>;
}

/**
 * Logic Apps custom connector summary. Only secret-free fields are ever
 * projected out of Microsoft.Web/customApis: the ARM payload carries
 * connectionParameters.oAuthSettings.clientSecret beside the swagger, so the
 * client must never surface raw properties.
 */
export interface CustomApiSummary {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  hasSwagger: boolean;
  backendServiceUrl?: string;
  originalSwaggerUrl?: string;
}

export interface AzureCustomApisClient {
  listCustomApis(resourceGroup?: string): Promise<CustomApiSummary[]>;
  getSwagger(resourceGroup: string, name: string): Promise<string>;
  probeCustomApisReadAccess(resourceGroup?: string): Promise<void>;
}

/** Consumption Logic App workflow summary (list projection; no definition yet). */
export interface LogicWorkflowSummary {
  id: string;
  name: string;
  resourceGroup: string;
  location?: string;
  tags: Record<string, string>;
  state?: string;
}

/**
 * Request-triggered workflow detail. accessEndpoint is the workflow's base
 * invoke endpoint WITHOUT any SAS material; callback URLs (listCallbackUrl)
 * carry sig= tokens and are never requested by this client.
 */
export interface LogicWorkflowDetail {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  accessEndpoint?: string;
  triggers: Array<{
    name: string;
    type: string;
    kind?: string;
    method?: string;
    relativePath?: string;
    schema?: unknown;
  }>;
}

export interface AzureLogicWorkflowsClient {
  listWorkflows(resourceGroup?: string): Promise<LogicWorkflowSummary[]>;
  getWorkflow(resourceGroup: string, name: string): Promise<LogicWorkflowDetail>;
  probeLogicWorkflowsReadAccess(resourceGroup?: string): Promise<void>;
}

export interface AzureSubscriptionsClient {
  get(subscriptionId: string): Promise<SubscriptionSummary>;
  list(): Promise<SubscriptionSummary[]>;
}

export type ApimExportFormat = 'openapi+json-link' | 'wsdl-link';
const EXPORT_FORMAT_OPENAPI_JSON: ApimExportFormat = 'openapi+json-link';

/**
 * Absolute ceiling on pages consumed from any Azure list/pagination surface.
 * Defensive bound so a misbehaving continuation token can never spin the
 * action forever; 100 pages of standard ARM page sizes far exceeds any
 * realistic subscription for this action's scope.
 */
const MAX_LIST_PAGES = 100;

async function collectBounded<T>(iterable: AsyncIterable<T>, surface: string): Promise<T[]> {
  const items: T[] = [];
  const paged = (iterable as { byPage?: () => AsyncIterable<T[]> }).byPage?.();
  if (paged) {
    let pages = 0;
    for await (const page of paged) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`${surface} pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      items.push(...page);
    }
    return items;
  }
  let count = 0;
  const maxItems = MAX_LIST_PAGES * 1000;
  for await (const item of iterable) {
    count += 1;
    if (count > maxItems) {
      throw new Error(`${surface} enumeration exceeded ${maxItems} items; aborting`);
    }
    items.push(item);
  }
  return items;
}

/**
 * The ARM `apiExport.get` response nests the download link at either
 * `value.link` (the shape the SDK model claims) or `properties.value.link`
 * (the shape the live 2024-05-01 API actually returns). The generated SDK
 * mapper does not reliably project the runtime `properties.value` payload onto
 * `ApiExportResult.value`, so read both shapes defensively.
 */
function extractExportLink(result: unknown): string | undefined {
  const record = (result ?? {}) as Record<string, unknown>;
  // Raw REST (`?export=true&format=openapi+json-link`) returns the SAS link at
  // the top level; the readiness probe already accepts this shape.
  const topLevel = record.link;
  if (typeof topLevel === 'string' && topLevel) {
    return topLevel;
  }
  const direct = (record.value as { link?: unknown } | undefined)?.link;
  if (typeof direct === 'string' && direct) {
    return direct;
  }
  const properties = record.properties as { value?: { link?: unknown } } | undefined;
  const nested = properties?.value?.link;
  if (typeof nested === 'string' && nested) {
    return nested;
  }
  return undefined;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|unauthorized|\b401\b|\b403\b/i.test(message);
}

/**
 * Flatten Azure SDK / RestError surfaces into one searchable string.
 * RestError keeps `response` non-enumerable, so String(error) alone can miss
 * the pricing-tier body that ARM returns for workspace calls on Consumption.
 */
function azureErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const record = error as Error & {
    code?: unknown;
    statusCode?: unknown;
    response?: { bodyAsText?: unknown; parsedBody?: unknown };
    details?: unknown;
  };
  const parts = [
    error.message,
    record.code,
    record.statusCode,
    record.response?.bodyAsText,
    typeof record.response?.parsedBody === 'string'
      ? record.response.parsedBody
      : record.response?.parsedBody
        ? JSON.stringify(record.response.parsedBody)
        : undefined,
    typeof record.details === 'string' ? record.details : record.details ? JSON.stringify(record.details) : undefined
  ];
  return parts.filter((part) => part !== undefined && part !== null && `${part}`.length > 0).join(' ');
}

function isUnsupportedWorkspaceTierError(error: unknown): boolean {
  const text = azureErrorText(error);
  // Documented Consumption/classic-tier rejection for the workspace ARM surface.
  if (/workspace feature is not supported in this service tier/i.test(text)) return true;
  // Live ARM often returns MethodNotAllowedInPricingTier for SKU-gated APIM APIs.
  if (/MethodNotAllowedInPricingTier/i.test(text)) return true;
  if (/method not allowed in .*(pricing tier|sku)/i.test(text)) return true;
  // Broader workspace+SKU wording observed across portal/SDK wrappers.
  if (/workspace/i.test(text) && /not supported|unsupported|not available|pricing tier|\bsku\b/i.test(text)) {
    return true;
  }
  return false;
}

function sdkMaxRetries(options?: AzureSdkOptions): number {
  return Math.max(0, (options?.maxAttempts ?? 3) - 1);
}

function isHttp403(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP 403\b|\b403\b.*forbidden|forbidden.*\b403\b/i.test(message);
}

function isTransientAzureError(error: unknown): boolean {
  const record = (error ?? {}) as { statusCode?: unknown; status?: unknown };
  const status = Number(record.statusCode ?? record.status);
  if (status === 408 || status === 429 || status >= 500) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b408\b|\b429\b|\b5\d\d\b|timeout|temporar(?:y|ily)|throttl/i.test(message);
}

function revisionGroup(api: ApimApiSummary): string {
  return (api.apiVersionSetId ?? api.apiVersion ?? api.apiId.replace(/;rev=.*$/i, '')).toLowerCase();
}

function retainCurrentApis(apis: ApimApiSummary[]): ApimApiSummary[] {
  const groupsWithCurrent = new Set(
    apis.filter((api) => api.isCurrent === true).map(revisionGroup)
  );
  return apis.filter((api) => {
    if (api.isCurrent === false) return false;
    return api.isCurrent === true || !groupsWithCurrent.has(revisionGroup(api));
  });
}


export class ApimSdkClient implements AzureApimClient {
  private readonly client: ApiManagementClient;
  private readonly requestTimeoutMs?: number;
  private readonly maxAttempts: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new ApiManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: sdkMaxRetries(options) }
    });
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.maxAttempts = options?.maxAttempts ?? 3;
  }

  public async listServices(resourceGroup?: string): Promise<ApimServiceSummary[]> {
    const iterator = resourceGroup
      ? this.client.apiManagementService.listByResourceGroup(resourceGroup)
      : this.client.apiManagementService.list();
    const services = await collectBounded(iterator, 'APIM service list');
    return services.map((service) => toServiceSummary(service));
  }

  public async listApis(resourceGroup: string, serviceName: string): Promise<ApimApiSummary[]> {
    const serviceApis = await collectBounded(this.client.api.listByService(resourceGroup, serviceName), 'APIM API list');
    const summaries = serviceApis.map((api) => toApiSummary(api, serviceName, resourceGroup));
    // Workspaces exist only on Premium v2 / workspace-capable tiers; every other tier
    // (Consumption, Developer, Basic, Standard) rejects the workspace surface outright.
    // Workspace enumeration is therefore additive and fail-soft only for the explicit
    // unsupported-tier response. Other failures must propagate rather than silently
    // dropping workspace APIs from a workspace-capable service.
    try {
      const workspaces = await collectBounded(
        this.client.workspace.listByService(resourceGroup, serviceName),
        'APIM workspace list'
      );
      for (const workspace of workspaces) {
        const workspaceId = workspace.name ?? '';
        if (!workspaceId) continue;
        const workspaceApis = await collectBounded(
          this.client.workspaceApi.listByService(resourceGroup, serviceName, workspaceId),
          `APIM workspace ${workspaceId} API list`
        );
        summaries.push(...workspaceApis.map((api) => toApiSummary(api, serviceName, resourceGroup, workspaceId)));
      }
    } catch (error) {
      if (!isUnsupportedWorkspaceTierError(error)) throw error;
    }
    return retainCurrentApis(summaries);
  }

  /**
   * APIM export is a two-step protocol: the ARM call returns a Storage Blob SAS link
   * (TTL 5 minutes), and the bytes must be fetched from that link immediately.
   */
  public async exportApi(
    resourceGroup: string,
    serviceName: string,
    apiId: string,
    workspaceId?: string,
    format: ApimExportFormat = EXPORT_FORMAT_OPENAPI_JSON
  ): Promise<string> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const result = workspaceId
        ? await this.client.workspaceApiExport.get(
            resourceGroup,
            serviceName,
            workspaceId,
            apiId,
            format,
            'true'
          )
        : await this.client.apiExport.get(resourceGroup, serviceName, apiId, format, 'true');
      const link = extractExportLink(result);
      if (!link) {
        throw new Error(`APIM export for ${apiId} returned no download link`);
      }
      try {
        const fetched = await fetchSpecFromUrl(link, { timeoutMs: this.requestTimeoutMs });
        return fetched.content;
      } catch (error) {
        if (!isHttp403(error)) throw error;
        if (attempt === this.maxAttempts) {
          throw new Error(`APIM export fetch failed with HTTP 403 after ${attempt} attempt(s)`);
        }
      }
    }
    throw new Error('APIM export exhausted its attempt limit');
  }

  public async getGraphqlSchema(resourceGroup: string, serviceName: string, apiId: string, workspaceId?: string): Promise<string> {
    const schemas = workspaceId
      ? await collectBounded(
          this.client.workspaceApiSchema.listByApi(resourceGroup, serviceName, workspaceId, apiId),
          `APIM workspace ${workspaceId} API schema list`
        )
      : await collectBounded(this.client.apiSchema.listByApi(resourceGroup, serviceName, apiId), 'APIM API schema list');
    const schema = schemas.find((entry) => entry.name?.toLowerCase() === 'graphql')
      ?? schemas.find((entry) => entry.contentType?.toLowerCase().includes('graphql'));
    if (!schema?.name) {
      throw new Error(`APIM GraphQL API ${apiId} returned no GraphQL schema`);
    }
    const detail = workspaceId
      ? await this.client.workspaceApiSchema.get(resourceGroup, serviceName, workspaceId, apiId, schema.name)
      : await this.client.apiSchema.get(resourceGroup, serviceName, apiId, schema.name);
    if (typeof detail.value !== 'string' || !detail.value.trim()) {
      throw new Error(`APIM GraphQL schema ${schema.name} returned no SDL value`);
    }
    return detail.value;
  }

  public async probeApimReadAccess(resourceGroup?: string): Promise<void> {
    const iterator = resourceGroup
      ? this.client.apiManagementService.listByResourceGroup(resourceGroup)
      : this.client.apiManagementService.list();
    await iterator[Symbol.asyncIterator]().next();
  }
}

function toServiceSummary(service: ApiManagementServiceResource): ApimServiceSummary {
  return {
    name: service.name ?? '',
    resourceGroup: extractResourceGroup(service.id),
    location: service.location,
    tags: (service.tags ?? {}) as Record<string, string>
  };
}

function toApiSummary(api: ApiContract, serviceName: string, resourceGroup: string, workspaceId?: string): ApimApiSummary {
  const rawName = api.name ?? '';
  return {
    apiId: rawName,
    displayName: api.displayName ?? rawName,
    path: api.path,
    apiType: api.apiType ?? 'http',
    isCurrent: api.isCurrent,
    apiRevision: api.apiRevision,
    apiVersion: api.apiVersion,
    apiVersionSetId: api.apiVersionSetId,
    serviceName,
    resourceGroup,
    workspaceId
  };
}

export class AppServiceSdkClient implements AzureAppServiceClient {
  private readonly client: WebSiteManagementClient;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new WebSiteManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: sdkMaxRetries(options) }
    });
  }

  public async listSites(resourceGroup?: string): Promise<AppServiceSiteSummary[]> {
    const iterator = resourceGroup ? this.client.webApps.listByResourceGroup(resourceGroup) : this.client.webApps.list();
    const rawSites = await collectBounded(iterator, 'App Service site list');
    const sites: AppServiceSiteSummary[] = [];
    for (const site of rawSites) {
      const siteResourceGroup = site.resourceGroup ?? extractResourceGroup(site.id);
      if (!site.name || !siteResourceGroup) {
        continue;
      }
      let apiDefinitionUrl: string | undefined;
      try {
        const config = await this.client.webApps.getConfiguration(siteResourceGroup, site.name);
        apiDefinitionUrl = config.apiDefinition?.url ?? undefined;
      } catch (error) {
        // A permission failure must not be silently reduced to "no API
        // definition" — that would drop a real API. Transient errors are
        // already retried by the SDK (maxRetries); surface auth failures.
        if (isAuthorizationError(error)) {
          throw error;
        }
        // Genuine non-auth read failure: keep the site as a naming signal only.
      }
      sites.push({
        name: site.name,
        resourceGroup: siteResourceGroup,
        tags: (site.tags ?? {}) as Record<string, string>,
        apiDefinitionUrl
      });
    }
    return sites;
  }

  public async probeAppServiceReadAccess(resourceGroup?: string): Promise<void> {
    const iterator = resourceGroup ? this.client.webApps.listByResourceGroup(resourceGroup) : this.client.webApps.list();
    await iterator[Symbol.asyncIterator]().next();
  }
}

export class ResourceGraphSdkClient implements AzureResourceGraphClient {
  private readonly client: ResourceGraphClient;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, options?: AzureSdkOptions) {
    this.client = new ResourceGraphClient(credential);
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async queryResources(subscriptionId: string, kql: string): Promise<ResourceGraphRow[]> {
    const rows: ResourceGraphRow[] = [];
    let skipToken: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`Resource Graph pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      let response: { data?: unknown; skipToken?: string } | undefined;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        try {
          response = await this.client.resources({
            subscriptions: [subscriptionId],
            query: kql,
            options: skipToken ? { skipToken } : undefined
          }, { timeout: this.requestTimeoutMs }) as { data?: unknown; skipToken?: string };
          break;
        } catch (error) {
          if (!isTransientAzureError(error) || attempt === this.maxAttempts) throw error;
        }
      }
      if (!response) throw new Error('Resource Graph query exhausted its attempt limit');
      const data = Array.isArray(response.data) ? response.data : [];
      for (const row of data) {
        const record = row as Record<string, unknown>;
        rows.push({
          id: String(record.id ?? ''),
          name: String(record.name ?? ''),
          type: String(record.type ?? ''),
          resourceGroup: String(record.resourceGroup ?? ''),
          tags: (record.tags ?? {}) as Record<string, string>
        });
      }
      const next = response.skipToken;
      if (next !== undefined && next === skipToken) {
        throw new Error('Resource Graph pagination returned a repeated skip token; aborting');
      }
      skipToken = next;
    } while (skipToken);
    return rows;
  }
}

export class SubscriptionsSdkClient implements AzureSubscriptionsClient {
  private readonly credential: TokenCredential;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, options?: AzureSdkOptions) {
    this.credential = credential;
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async get(subscriptionId: string): Promise<SubscriptionSummary> {
    const token = await this.getArmToken();
    const response = await this.fetchArm(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`,
      token,
      'Subscription lookup'
    );
    if (!response.ok) {
      throw new Error(`Subscription lookup failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { subscriptionId?: string; displayName?: string; state?: string };
    if (!body.subscriptionId) throw new Error('Subscription lookup returned no subscription ID');
    return { subscriptionId: body.subscriptionId, displayName: body.displayName, state: body.state };
  }

  /** ARM REST list (the @azure/arm-subscriptions v6 SDK no longer exposes subscriptions.list). */
  public async list(): Promise<SubscriptionSummary[]> {
    const token = await this.getArmToken();
    const subscriptions: SubscriptionSummary[] = [];
    let url: string | undefined = 'https://management.azure.com/subscriptions?api-version=2022-12-01';
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`Subscription listing pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.fetchArm(url, token, 'Subscription listing');
      if (!response.ok) {
        throw new Error(`Subscription listing failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        value?: Array<{ subscriptionId?: string; displayName?: string; state?: string }>;
        nextLink?: string;
      };
      for (const subscription of body.value ?? []) {
        if (subscription.subscriptionId) {
          subscriptions.push({
            subscriptionId: subscription.subscriptionId,
            displayName: subscription.displayName,
            state: subscription.state
          });
        }
      }
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) {
        throw new Error('Subscription listing pagination returned a repeated nextLink; aborting');
      }
      url = next;
    }
    return subscriptions;
  }

  private async getArmToken(): Promise<string> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    return token.token;
  }

  private async fetchArm(url: string, token: string, operation: string): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (response.ok || ![408, 429].includes(response.status) && response.status < 500) return response;
        if (attempt === this.maxAttempts) return response;
      } catch (error) {
        if (attempt === this.maxAttempts) throw new Error(`${operation} failed after ${attempt} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }
}
const CUSTOM_APIS_API_VERSION = '2016-06-01';

interface CustomApiArmEnvelope {
  id?: string;
  name?: string;
  tags?: Record<string, string>;
  properties?: {
    swagger?: unknown;
    backendService?: { serviceUrl?: unknown };
    apiDefinitions?: { originalSwaggerUrl?: unknown; modifiedSwaggerUrl?: unknown };
  };
}

function toCustomApiSummary(entry: CustomApiArmEnvelope): CustomApiSummary | undefined {
  const id = entry.id ?? '';
  const name = entry.name ?? '';
  if (!id || !name) return undefined;
  const properties = entry.properties ?? {};
  const backendServiceUrl = properties.backendService?.serviceUrl;
  const originalSwaggerUrl = properties.apiDefinitions?.originalSwaggerUrl;
  return {
    id,
    name,
    resourceGroup: extractResourceGroup(id),
    tags: entry.tags ?? {},
    hasSwagger: properties.swagger !== undefined && properties.swagger !== null,
    ...(typeof backendServiceUrl === 'string' && backendServiceUrl ? { backendServiceUrl } : {}),
    ...(typeof originalSwaggerUrl === 'string' && originalSwaggerUrl ? { originalSwaggerUrl } : {})
  };
}

/**
 * Logic Apps custom connectors (Microsoft.Web/customApis) via generic ARM REST.
 * No management SDK models this surface, so the client speaks ARM directly with
 * the same token/retry/pagination discipline as SubscriptionsSdkClient.
 *
 * Secret hygiene is structural: list/get responses are projected through
 * toCustomApiSummary / the swagger property ONLY. connectionParameters (which
 * can carry oAuthSettings.clientSecret) is never read, logged, or returned.
 */
export class CustomApisSdkClient implements AzureCustomApisClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async listCustomApis(resourceGroup?: string): Promise<CustomApiSummary[]> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/customApis`
      : 'providers/Microsoft.Web/customApis';
    let url: string | undefined =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${CUSTOM_APIS_API_VERSION}`;
    const summaries: CustomApiSummary[] = [];
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`Custom API listing pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.fetchArm(url, token, 'Custom API listing');
      if (!response.ok) {
        throw new Error(`Custom API listing failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { value?: CustomApiArmEnvelope[]; nextLink?: string };
      for (const entry of body.value ?? []) {
        const summary = toCustomApiSummary(entry);
        if (summary) summaries.push(summary);
      }
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) {
        throw new Error('Custom API listing pagination returned a repeated nextLink; aborting');
      }
      url = next;
    }
    return summaries;
  }

  public async getSwagger(resourceGroup: string, name: string): Promise<string> {
    const token = await this.getArmToken();
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/customApis/${encodeURIComponent(name)}` +
      `?api-version=${CUSTOM_APIS_API_VERSION}`;
    const response = await this.fetchArm(url, token, 'Custom API read');
    if (!response.ok) {
      throw new Error(`Custom API read failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as CustomApiArmEnvelope;
    const swagger = body.properties?.swagger;
    if (swagger === undefined || swagger === null) {
      throw new Error(`Custom API ${name} carries no inline swagger document`);
    }
    return `${JSON.stringify(swagger, null, 2)}\n`;
  }

  public async probeCustomApisReadAccess(resourceGroup?: string): Promise<void> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/customApis`
      : 'providers/Microsoft.Web/customApis';
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${CUSTOM_APIS_API_VERSION}&$top=1`;
    const response = await this.fetchArm(url, token, 'Custom API probe');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: custom API probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Custom API probe failed with HTTP ${response.status}`);
    }
  }

  private async getArmToken(): Promise<string> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    return token.token;
  }

  private async fetchArm(url: string, token: string, operation: string): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (response.ok || ![408, 429].includes(response.status) && response.status < 500) return response;
        if (attempt === this.maxAttempts) return response;
      } catch (error) {
        if (attempt === this.maxAttempts) throw new Error(`${operation} failed after ${attempt} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }
}

const LOGIC_API_VERSION = '2019-05-01';

interface LogicWorkflowArmEnvelope {
  id?: string;
  name?: string;
  location?: string;
  tags?: Record<string, string>;
  properties?: {
    state?: unknown;
    accessEndpoint?: unknown;
    definition?: {
      triggers?: Record<string, {
        type?: unknown;
        kind?: unknown;
        inputs?: { method?: unknown; relativePath?: unknown; schema?: unknown };
      }>;
    };
  };
}

/**
 * Consumption Logic Apps (Microsoft.Logic/workflows) via generic ARM REST.
 * Reader-only GETs: list projects summaries; get returns the workflow
 * definition whose Request triggers make a workflow an inbound HTTP API.
 *
 * Never calls listCallbackUrl / listSwagger POST actions: callback URLs embed
 * SAS signatures and POST actions sit outside plain Reader RBAC. The
 * accessEndpoint property is the SAS-free base endpoint and is safe to emit.
 */
export class LogicWorkflowsSdkClient implements AzureLogicWorkflowsClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async listWorkflows(resourceGroup?: string): Promise<LogicWorkflowSummary[]> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Logic/workflows`
      : 'providers/Microsoft.Logic/workflows';
    let url: string | undefined =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${LOGIC_API_VERSION}`;
    const summaries: LogicWorkflowSummary[] = [];
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`Logic workflow listing pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.fetchArm(url, token, 'Logic workflow listing');
      if (!response.ok) {
        throw new Error(`Logic workflow listing failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { value?: LogicWorkflowArmEnvelope[]; nextLink?: string };
      for (const entry of body.value ?? []) {
        const id = entry.id ?? '';
        const name = entry.name ?? '';
        if (!id || !name) continue;
        summaries.push({
          id,
          name,
          resourceGroup: extractResourceGroup(id),
          location: entry.location,
          tags: entry.tags ?? {},
          state: typeof entry.properties?.state === 'string' ? entry.properties.state : undefined
        });
      }
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) {
        throw new Error('Logic workflow listing pagination returned a repeated nextLink; aborting');
      }
      url = next;
    }
    return summaries;
  }

  public async getWorkflow(resourceGroup: string, name: string): Promise<LogicWorkflowDetail> {
    const token = await this.getArmToken();
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Logic/workflows/${encodeURIComponent(name)}` +
      `?api-version=${LOGIC_API_VERSION}`;
    const response = await this.fetchArm(url, token, 'Logic workflow read');
    if (!response.ok) {
      throw new Error(`Logic workflow read failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as LogicWorkflowArmEnvelope;
    const id = body.id ?? '';
    const workflowName = body.name ?? name;
    const accessEndpoint = body.properties?.accessEndpoint;
    const triggerEntries = Object.entries(body.properties?.definition?.triggers ?? {});
    return {
      id,
      name: workflowName,
      resourceGroup: extractResourceGroup(id) || resourceGroup,
      tags: body.tags ?? {},
      accessEndpoint: typeof accessEndpoint === 'string' && accessEndpoint ? accessEndpoint : undefined,
      triggers: triggerEntries.map(([triggerName, trigger]) => ({
        name: triggerName,
        type: typeof trigger.type === 'string' ? trigger.type : '',
        kind: typeof trigger.kind === 'string' ? trigger.kind : undefined,
        method: typeof trigger.inputs?.method === 'string' ? trigger.inputs.method : undefined,
        relativePath: typeof trigger.inputs?.relativePath === 'string' ? trigger.inputs.relativePath : undefined,
        schema: trigger.inputs?.schema
      }))
    };
  }

  public async probeLogicWorkflowsReadAccess(resourceGroup?: string): Promise<void> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Logic/workflows`
      : 'providers/Microsoft.Logic/workflows';
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${LOGIC_API_VERSION}&$top=1`;
    const response = await this.fetchArm(url, token, 'Logic workflow probe');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: logic workflow probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Logic workflow probe failed with HTTP ${response.status}`);
    }
  }

  private async getArmToken(): Promise<string> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    return token.token;
  }

  private async fetchArm(url: string, token: string, operation: string): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (response.ok || ![408, 429].includes(response.status) && response.status < 500) return response;
        if (attempt === this.maxAttempts) return response;
      } catch (error) {
        if (attempt === this.maxAttempts) throw new Error(`${operation} failed after ${attempt} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }
}

export interface TemplateSpecSummary {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
}

export interface TemplateSpecVersionSummary {
  id: string;
  name: string;
}

export interface DeploymentSummary {
  name: string;
  templateSpecVersionId?: string;
}

export interface AzureTemplateSpecsClient {
  listTemplateSpecs(resourceGroup?: string): Promise<TemplateSpecSummary[]>;
  listVersions(resourceGroup: string, templateSpecName: string): Promise<TemplateSpecVersionSummary[]>;
  getVersionMainTemplate(resourceGroup: string, templateSpecName: string, version: string): Promise<unknown>;
  listDeployments(resourceGroup: string): Promise<DeploymentSummary[]>;
  probeTemplateSpecsReadAccess(resourceGroup?: string): Promise<void>;
}

const TEMPLATE_SPECS_API_VERSION = '2022-02-01';
const DEPLOYMENTS_API_VERSION = '2021-04-01';

interface TemplateSpecArmEnvelope {
  id?: string;
  name?: string;
  tags?: Record<string, string>;
}

interface TemplateSpecVersionArmEnvelope {
  id?: string;
  name?: string;
  properties?: { mainTemplate?: unknown };
}

interface DeploymentArmEnvelope {
  name?: string;
  properties?: { templateLink?: { id?: unknown } };
}

/**
 * Template Specs (Microsoft.Resources/templateSpecs) via generic ARM REST with
 * the same token/retry/pagination discipline as CustomApisSdkClient. Reader
 * GETs only: version documents are read directly (never exportTemplate, which
 * is a POST action), and resource group deployment history comes from the
 * deployments list GET whose response never includes template content.
 */
export class TemplateSpecsSdkClient implements AzureTemplateSpecsClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async listTemplateSpecs(resourceGroup?: string): Promise<TemplateSpecSummary[]> {
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/templateSpecs`
      : 'providers/Microsoft.Resources/templateSpecs';
    const first =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${TEMPLATE_SPECS_API_VERSION}`;
    const entries = await this.listPaged<TemplateSpecArmEnvelope>(first, 'Template spec listing');
    const summaries: TemplateSpecSummary[] = [];
    for (const entry of entries) {
      const id = entry.id ?? '';
      const name = entry.name ?? '';
      if (!id || !name) continue;
      summaries.push({ id, name, resourceGroup: extractResourceGroup(id), tags: entry.tags ?? {} });
    }
    return summaries;
  }

  public async listVersions(resourceGroup: string, templateSpecName: string): Promise<TemplateSpecVersionSummary[]> {
    const first =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/templateSpecs/${encodeURIComponent(templateSpecName)}` +
      `/versions?api-version=${TEMPLATE_SPECS_API_VERSION}`;
    const entries = await this.listPaged<TemplateSpecVersionArmEnvelope>(first, 'Template spec version listing');
    const summaries: TemplateSpecVersionSummary[] = [];
    for (const entry of entries) {
      const id = entry.id ?? '';
      const name = entry.name ?? '';
      if (!id || !name) continue;
      summaries.push({ id, name });
    }
    return summaries;
  }

  public async getVersionMainTemplate(resourceGroup: string, templateSpecName: string, version: string): Promise<unknown> {
    const token = await this.getArmToken();
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/templateSpecs/${encodeURIComponent(templateSpecName)}` +
      `/versions/${encodeURIComponent(version)}?api-version=${TEMPLATE_SPECS_API_VERSION}`;
    const response = await this.fetchArm(url, token, 'Template spec version read');
    if (!response.ok) {
      throw new Error(`Template spec version read failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as TemplateSpecVersionArmEnvelope;
    return body.properties?.mainTemplate;
  }

  public async listDeployments(resourceGroup: string): Promise<DeploymentSummary[]> {
    const first =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/?api-version=${DEPLOYMENTS_API_VERSION}`;
    const entries = await this.listPaged<DeploymentArmEnvelope>(first, 'Deployment listing');
    const summaries: DeploymentSummary[] = [];
    for (const entry of entries) {
      const name = entry.name ?? '';
      if (!name) continue;
      const templateLinkId = entry.properties?.templateLink?.id;
      summaries.push({
        name,
        ...(typeof templateLinkId === 'string' && templateLinkId ? { templateSpecVersionId: templateLinkId } : {})
      });
    }
    return summaries;
  }

  public async probeTemplateSpecsReadAccess(resourceGroup?: string): Promise<void> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/templateSpecs`
      : 'providers/Microsoft.Resources/templateSpecs';
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${TEMPLATE_SPECS_API_VERSION}&$top=1`;
    const response = await this.fetchArm(url, token, 'Template spec probe');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: template spec probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Template spec probe failed with HTTP ${response.status}`);
    }
  }

  private async listPaged<T>(firstUrl: string, operation: string): Promise<T[]> {
    const token = await this.getArmToken();
    let url: string | undefined = firstUrl;
    const entries: T[] = [];
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`${operation} pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.fetchArm(url, token, operation);
      if (!response.ok) {
        throw new Error(`${operation} failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { value?: T[]; nextLink?: string };
      entries.push(...(body.value ?? []));
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) {
        throw new Error(`${operation} pagination returned a repeated nextLink; aborting`);
      }
      url = next;
    }
    return entries;
  }

  private async getArmToken(): Promise<string> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    return token.token;
  }

  private async fetchArm(url: string, token: string, operation: string): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (response.ok || ![408, 429].includes(response.status) && response.status < 500) return response;
        if (attempt === this.maxAttempts) return response;
      } catch (error) {
        if (attempt === this.maxAttempts) throw new Error(`${operation} failed after ${attempt} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }
}

export interface EventGridSourceSummary {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  kind: 'topic' | 'domain' | 'system-topic';
  topicType?: string;
}

export interface EventGridSubscriptionSummary {
  name: string;
  destinationKind?: string;
  webhookBaseUrl?: string;
  includedEventTypes: string[];
  subjectBeginsWith?: string;
  subjectEndsWith?: string;
  deliverySchema?: string;
}

export interface AzureEventGridClient {
  listSources(resourceGroup?: string): Promise<EventGridSourceSummary[]>;
  listSubscriptions(source: { kind: EventGridSourceSummary['kind']; resourceGroup: string; name: string }): Promise<EventGridSubscriptionSummary[]>;
  probeEventGridReadAccess(resourceGroup?: string): Promise<void>;
}

interface EventGridDestinationLike {
  endpointType?: string;
  endpointBaseUrl?: string;
}

interface EventGridEventSubscriptionLike {
  name?: string;
  destination?: EventGridDestinationLike;
  filter?: { includedEventTypes?: string[]; subjectBeginsWith?: string; subjectEndsWith?: string };
  eventDeliverySchema?: string;
}

function toEventGridSubscriptionSummary(subscription: EventGridEventSubscriptionLike): EventGridSubscriptionSummary | undefined {
  const name = subscription.name ?? '';
  if (!name) return undefined;
  const destination = subscription.destination;
  const endpointType = destination?.endpointType ?? '';
  const isWebhook = endpointType.toLowerCase() === 'webhook';
  // Secret hygiene: only the server-populated endpointBaseUrl is ever read.
  // The writable endpointUrl (which may embed query-string tokens) is never
  // projected off the ARM response.
  const webhookBaseUrl = isWebhook && typeof destination?.endpointBaseUrl === 'string' ? destination.endpointBaseUrl : undefined;
  return {
    name,
    ...(endpointType ? { destinationKind: endpointType } : {}),
    ...(webhookBaseUrl ? { webhookBaseUrl } : {}),
    includedEventTypes: subscription.filter?.includedEventTypes ?? [],
    ...(subscription.filter?.subjectBeginsWith ? { subjectBeginsWith: subscription.filter.subjectBeginsWith } : {}),
    ...(subscription.filter?.subjectEndsWith ? { subjectEndsWith: subscription.filter.subjectEndsWith } : {}),
    ...(subscription.eventDeliverySchema ? { deliverySchema: subscription.eventDeliverySchema } : {})
  };
}

/**
 * Event Grid management surface via @azure/arm-eventgrid: custom topics,
 * domains, and system topics plus their event subscriptions, all Reader GETs
 * with bounded pagination. getFullUrl (the POST that returns the complete
 * webhook URL including query-string secrets) is never called.
 */
export class EventGridSdkClient implements AzureEventGridClient {
  private readonly client: EventGridManagementClient;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new EventGridManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: sdkMaxRetries(options) }
    });
  }

  public async listSources(resourceGroup?: string): Promise<EventGridSourceSummary[]> {
    const [topics, domains, systemTopics] = await Promise.all([
      collectBounded(
        resourceGroup ? this.client.topics.listByResourceGroup(resourceGroup) : this.client.topics.listBySubscription(),
        'Event Grid topic list'
      ),
      collectBounded(
        resourceGroup ? this.client.domains.listByResourceGroup(resourceGroup) : this.client.domains.listBySubscription(),
        'Event Grid domain list'
      ),
      collectBounded(
        resourceGroup
          ? this.client.systemTopics.listByResourceGroup(resourceGroup)
          : this.client.systemTopics.listBySubscription(),
        'Event Grid system topic list'
      )
    ]);
    const summaries: EventGridSourceSummary[] = [];
    const push = (
      entry: { id?: string; name?: string; tags?: Record<string, string>; topicType?: string },
      kind: EventGridSourceSummary['kind']
    ): void => {
      const id = entry.id ?? '';
      const name = entry.name ?? '';
      if (!id || !name) return;
      summaries.push({
        id,
        name,
        resourceGroup: extractResourceGroup(id),
        tags: entry.tags ?? {},
        kind,
        ...(entry.topicType ? { topicType: entry.topicType } : {})
      });
    };
    for (const topic of topics) push(topic, 'topic');
    for (const domain of domains) push(domain, 'domain');
    for (const systemTopic of systemTopics) push(systemTopic, 'system-topic');
    return summaries;
  }

  public async listSubscriptions(source: {
    kind: EventGridSourceSummary['kind'];
    resourceGroup: string;
    name: string;
  }): Promise<EventGridSubscriptionSummary[]> {
    const iterator =
      source.kind === 'topic'
        ? this.client.topicEventSubscriptions.list(source.resourceGroup, source.name)
        : source.kind === 'domain'
          ? this.client.domainEventSubscriptions.list(source.resourceGroup, source.name)
          : this.client.systemTopicEventSubscriptions.listBySystemTopic(source.resourceGroup, source.name);
    const subscriptions = await collectBounded(iterator, `Event Grid ${source.kind} subscription list`);
    const summaries: EventGridSubscriptionSummary[] = [];
    for (const subscription of subscriptions) {
      const summary = toEventGridSubscriptionSummary(subscription as EventGridEventSubscriptionLike);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  public async probeEventGridReadAccess(resourceGroup?: string): Promise<void> {
    const iterator = resourceGroup
      ? this.client.topics.listByResourceGroup(resourceGroup)
      : this.client.topics.listBySubscription();
    await iterator[Symbol.asyncIterator]().next();
  }
}

export interface ServiceBusNamespaceSummary {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  serviceBusEndpoint?: string;
}

export interface ServiceBusRuleSummary {
  name: string;
  sqlExpression?: string;
  correlationSummary?: string;
}

export interface ServiceBusSubscriptionSummary {
  name: string;
  rules: ServiceBusRuleSummary[];
}

export interface ServiceBusTopicSummary {
  id: string;
  name: string;
  subscriptions: ServiceBusSubscriptionSummary[];
}

export interface AzureServiceBusClient {
  listNamespaces(resourceGroup?: string): Promise<ServiceBusNamespaceSummary[]>;
  listTopics(resourceGroup: string, namespaceName: string): Promise<ServiceBusTopicSummary[]>;
  probeServiceBusReadAccess(resourceGroup?: string): Promise<void>;
}

interface CorrelationFilterLike {
  correlationId?: string;
  messageId?: string;
  to?: string;
  replyTo?: string;
  label?: string;
  sessionId?: string;
  contentType?: string;
}

function correlationSummary(filter: CorrelationFilterLike | undefined): string | undefined {
  if (!filter) return undefined;
  const parts = Object.entries({
    correlationId: filter.correlationId,
    messageId: filter.messageId,
    to: filter.to,
    replyTo: filter.replyTo,
    label: filter.label,
    sessionId: filter.sessionId,
    contentType: filter.contentType
  })
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Service Bus management surface via @azure/arm-servicebus: namespaces,
 * topics, subscriptions, and rules, all Reader GETs with bounded pagination.
 * Authorization-rule surfaces and listKeys (which return connection strings)
 * are never called.
 */
export class ServiceBusSdkClient implements AzureServiceBusClient {
  private readonly client: ServiceBusManagementClient;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new ServiceBusManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: sdkMaxRetries(options) }
    });
  }

  public async listNamespaces(resourceGroup?: string): Promise<ServiceBusNamespaceSummary[]> {
    const iterator = resourceGroup
      ? this.client.namespaces.listByResourceGroup(resourceGroup)
      : this.client.namespaces.list();
    const namespaces = await collectBounded(iterator, 'Service Bus namespace list');
    const summaries: ServiceBusNamespaceSummary[] = [];
    for (const namespace of namespaces) {
      const id = namespace.id ?? '';
      const name = namespace.name ?? '';
      if (!id || !name) continue;
      summaries.push({
        id,
        name,
        resourceGroup: extractResourceGroup(id),
        tags: (namespace.tags ?? {}) as Record<string, string>,
        ...(namespace.serviceBusEndpoint ? { serviceBusEndpoint: namespace.serviceBusEndpoint } : {})
      });
    }
    return summaries;
  }

  public async listTopics(resourceGroup: string, namespaceName: string): Promise<ServiceBusTopicSummary[]> {
    const topics = await collectBounded(
      this.client.topics.listByNamespace(resourceGroup, namespaceName),
      'Service Bus topic list'
    );
    const summaries: ServiceBusTopicSummary[] = [];
    for (const topic of topics) {
      const id = topic.id ?? '';
      const name = topic.name ?? '';
      if (!id || !name) continue;
      const subscriptions = await collectBounded(
        this.client.subscriptions.listByTopic(resourceGroup, namespaceName, name),
        `Service Bus topic ${name} subscription list`
      );
      const subscriptionSummaries: ServiceBusSubscriptionSummary[] = [];
      for (const subscription of subscriptions) {
        const subscriptionName = subscription.name ?? '';
        if (!subscriptionName) continue;
        const rules = await collectBounded(
          this.client.rules.listBySubscriptions(resourceGroup, namespaceName, name, subscriptionName),
          `Service Bus subscription ${subscriptionName} rule list`
        );
        subscriptionSummaries.push({
          name: subscriptionName,
          rules: rules
            .filter((rule) => Boolean(rule.name))
            .map((rule) => ({
              name: rule.name ?? '',
              ...(rule.sqlFilter?.sqlExpression ? { sqlExpression: rule.sqlFilter.sqlExpression } : {}),
              ...(correlationSummary(rule.correlationFilter) ? { correlationSummary: correlationSummary(rule.correlationFilter) } : {})
            }))
        });
      }
      summaries.push({ id, name, subscriptions: subscriptionSummaries });
    }
    return summaries;
  }

  public async probeServiceBusReadAccess(resourceGroup?: string): Promise<void> {
    const iterator = resourceGroup
      ? this.client.namespaces.listByResourceGroup(resourceGroup)
      : this.client.namespaces.list();
    await iterator[Symbol.asyncIterator]().next();
  }
}

export interface FunctionAppSummary {
  id: string;
  name: string;
  resourceGroup: string;
  tags: Record<string, string>;
  defaultHostName?: string;
}

export interface FunctionBindingSummary {
  type: string;
  direction?: string;
  name?: string;
  route?: string;
  methods?: string[];
  authLevel?: string;
  /** Connection APP SETTING NAME only -- values are never read. */
  connectionSettingName?: string;
  queueName?: string;
  topicName?: string;
  subscriptionName?: string;
  eventHubName?: string;
  path?: string;
  schedule?: string;
}

export interface FunctionSummary {
  name: string;
  bindings: FunctionBindingSummary[];
}

export interface AzureFunctionsClient {
  listFunctionApps(resourceGroup?: string): Promise<FunctionAppSummary[]>;
  listFunctions(resourceGroup: string, appName: string): Promise<FunctionSummary[]>;
  probeFunctionsReadAccess(resourceGroup?: string): Promise<void>;
}

const FUNCTIONS_API_VERSION = '2023-12-01';

interface FunctionAppArmEnvelope {
  id?: string;
  name?: string;
  kind?: string;
  tags?: Record<string, string>;
  properties?: { defaultHostName?: string };
}

interface FunctionArmEnvelope {
  name?: string;
  properties?: { config?: { bindings?: unknown } };
}

interface RawBinding {
  type?: unknown;
  direction?: unknown;
  name?: unknown;
  route?: unknown;
  methods?: unknown;
  authLevel?: unknown;
  connection?: unknown;
  queueName?: unknown;
  topicName?: unknown;
  subscriptionName?: unknown;
  eventHubName?: unknown;
  path?: unknown;
  schedule?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Project a raw binding onto the structural summary. Only known fields are
 * read; `connection` is an app SETTING NAME (never a value) and everything
 * else in the raw payload is dropped, never serialized.
 */
function toBindingSummary(raw: RawBinding): FunctionBindingSummary | undefined {
  const type = str(raw.type);
  if (!type) return undefined;
  const methods = Array.isArray(raw.methods)
    ? raw.methods.filter((m): m is string => typeof m === 'string')
    : undefined;
  return {
    type,
    ...(str(raw.direction) ? { direction: str(raw.direction) } : {}),
    ...(str(raw.name) ? { name: str(raw.name) } : {}),
    ...(str(raw.route) ? { route: str(raw.route) } : {}),
    ...(methods && methods.length > 0 ? { methods } : {}),
    ...(str(raw.authLevel) ? { authLevel: str(raw.authLevel) } : {}),
    ...(str(raw.connection) ? { connectionSettingName: str(raw.connection) } : {}),
    ...(str(raw.queueName) ? { queueName: str(raw.queueName) } : {}),
    ...(str(raw.topicName) ? { topicName: str(raw.topicName) } : {}),
    ...(str(raw.subscriptionName) ? { subscriptionName: str(raw.subscriptionName) } : {}),
    ...(str(raw.eventHubName) ? { eventHubName: str(raw.eventHubName) } : {}),
    ...(str(raw.path) ? { path: str(raw.path) } : {}),
    ...(str(raw.schedule) ? { schedule: str(raw.schedule) } : {})
  };
}

/**
 * Azure Functions surface (Microsoft.Web/sites of kind functionapp and their
 * functions) via generic ARM REST with the same token/retry/pagination
 * discipline as CustomApisSdkClient. Reader GETs only: listFunctionKeys,
 * listHostKeys, listFunctionSecrets, and app settings list (POSTs returning
 * secrets) are never called.
 */
export class FunctionsSdkClient implements AzureFunctionsClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  public async listFunctionApps(resourceGroup?: string): Promise<FunctionAppSummary[]> {
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites`
      : 'providers/Microsoft.Web/sites';
    const first =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${FUNCTIONS_API_VERSION}`;
    const entries = await this.listPaged<FunctionAppArmEnvelope>(first, 'Function app listing');
    const summaries: FunctionAppSummary[] = [];
    for (const entry of entries) {
      const id = entry.id ?? '';
      const name = entry.name ?? '';
      const kind = (entry.kind ?? '').toLowerCase();
      if (!id || !name) continue;
      if (!kind.includes('functionapp')) continue;
      summaries.push({
        id,
        name,
        resourceGroup: extractResourceGroup(id),
        tags: entry.tags ?? {},
        ...(entry.properties?.defaultHostName ? { defaultHostName: entry.properties.defaultHostName } : {})
      });
    }
    return summaries;
  }

  public async listFunctions(resourceGroup: string, appName: string): Promise<FunctionSummary[]> {
    const first =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}` +
      `/functions?api-version=${FUNCTIONS_API_VERSION}`;
    const entries = await this.listPaged<FunctionArmEnvelope>(first, 'Function listing');
    const summaries: FunctionSummary[] = [];
    for (const entry of entries) {
      const fullName = entry.name ?? '';
      if (!fullName) continue;
      // ARM names functions as <app>/<function>; keep the short segment.
      const name = fullName.includes('/') ? fullName.split('/').pop() ?? fullName : fullName;
      const rawBindings = entry.properties?.config?.bindings;
      const bindings: FunctionBindingSummary[] = [];
      if (Array.isArray(rawBindings)) {
        for (const raw of rawBindings) {
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const summary = toBindingSummary(raw as RawBinding);
            if (summary) bindings.push(summary);
          }
        }
      }
      summaries.push({ name, bindings });
    }
    return summaries;
  }

  public async probeFunctionsReadAccess(resourceGroup?: string): Promise<void> {
    const token = await this.getArmToken();
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites`
      : 'providers/Microsoft.Web/sites';
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${FUNCTIONS_API_VERSION}&$top=1`;
    const response = await this.fetchArm(url, token, 'Function app probe');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: function app probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Function app probe failed with HTTP ${response.status}`);
    }
  }

  private async listPaged<T>(firstUrl: string, operation: string): Promise<T[]> {
    const token = await this.getArmToken();
    let url: string | undefined = firstUrl;
    const entries: T[] = [];
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`${operation} pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.fetchArm(url, token, operation);
      if (!response.ok) {
        throw new Error(`${operation} failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { value?: T[]; nextLink?: string };
      entries.push(...(body.value ?? []));
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) {
        throw new Error(`${operation} pagination returned a repeated nextLink; aborting`);
      }
      url = next;
    }
    return entries;
  }

  private async getArmToken(): Promise<string> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    return token.token;
  }

  private async fetchArm(url: string, token: string, operation: string): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (response.ok || ![408, 429].includes(response.status) && response.status < 500) return response;
        if (attempt === this.maxAttempts) return response;
      } catch (error) {
        if (attempt === this.maxAttempts) throw new Error(`${operation} failed after ${attempt} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }
}
