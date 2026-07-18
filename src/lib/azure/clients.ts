import { ApiManagementClient } from '@azure/arm-apimanagement';
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
  isCurrent: boolean;
  apiRevision?: string;
  apiVersion?: string;
  serviceName: string;
  resourceGroup: string;
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
  exportApi(resourceGroup: string, serviceName: string, apiId: string): Promise<string>;
  probeApimReadAccess(resourceGroup?: string): Promise<void>;
}

export interface AzureAppServiceClient {
  listSites(resourceGroup?: string): Promise<AppServiceSiteSummary[]>;
  probeAppServiceReadAccess(resourceGroup?: string): Promise<void>;
}

export interface AzureResourceGraphClient {
  queryResources(subscriptionId: string, kql: string): Promise<ResourceGraphRow[]>;
}

export interface AzureSubscriptionsClient {
  listEnabledSubscriptions(): Promise<SubscriptionSummary[]>;
}

const EXPORT_FORMAT_OPENAPI_JSON = 'openapi+json-link';

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


export class ApimSdkClient implements AzureApimClient {
  private readonly client: ApiManagementClient;
  private readonly requestTimeoutMs?: number;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new ApiManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: options?.maxAttempts ?? 3 }
    });
    this.requestTimeoutMs = options?.requestTimeoutMs;
  }

  public async listServices(resourceGroup?: string): Promise<ApimServiceSummary[]> {
    const iterator = resourceGroup
      ? this.client.apiManagementService.listByResourceGroup(resourceGroup)
      : this.client.apiManagementService.list();
    const services = await collectBounded(iterator, 'APIM service list');
    return services.map((service) => toServiceSummary(service));
  }

  public async listApis(resourceGroup: string, serviceName: string): Promise<ApimApiSummary[]> {
    const apis = await collectBounded(this.client.api.listByService(resourceGroup, serviceName), 'APIM API list');
    return apis.map((api) => toApiSummary(api, serviceName, resourceGroup));
  }

  /**
   * APIM export is a two-step protocol: the ARM call returns a Storage Blob SAS link
   * (TTL 5 minutes), and the bytes must be fetched from that link immediately.
   */
  public async exportApi(resourceGroup: string, serviceName: string, apiId: string): Promise<string> {
    const result = await this.client.apiExport.get(resourceGroup, serviceName, apiId, EXPORT_FORMAT_OPENAPI_JSON, 'true');
    const link = extractExportLink(result);
    if (!link) {
      throw new Error(`APIM export for ${apiId} returned no download link`);
    }
    // The SAS blob link is HTTPS with a 5-minute TTL; route it through the same
    // hardened transport as App Service (HTTPS-only, redirect/size/timeout caps)
    // instead of an unbounded fetch that can hang or exhaust runner memory.
    const fetched = await fetchSpecFromUrl(link, { timeoutMs: this.requestTimeoutMs });
    return fetched.content;
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

function toApiSummary(api: ApiContract, serviceName: string, resourceGroup: string): ApimApiSummary {
  const rawName = api.name ?? '';
  return {
    apiId: rawName,
    displayName: api.displayName ?? rawName,
    path: api.path,
    apiType: api.apiType ?? 'http',
    isCurrent: api.isCurrent ?? true,
    apiRevision: api.apiRevision,
    apiVersion: api.apiVersion,
    serviceName,
    resourceGroup
  };
}

export class AppServiceSdkClient implements AzureAppServiceClient {
  private readonly client: WebSiteManagementClient;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new WebSiteManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: options?.maxAttempts ?? 3 }
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

  public constructor(credential: TokenCredential) {
    this.client = new ResourceGraphClient(credential);
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
      const response = await this.client.resources({
        subscriptions: [subscriptionId],
        query: kql,
        options: skipToken ? { skipToken } : undefined
      });
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
      if (next !== undefined && next === skipToken) break; // defensive: repeated pagination token
      skipToken = next;
    } while (skipToken);
    return rows;
  }
}

export class SubscriptionsSdkClient implements AzureSubscriptionsClient {
  private readonly credential: TokenCredential;

  public constructor(credential: TokenCredential) {
    this.credential = credential;
  }

  /** ARM REST list (the @azure/arm-subscriptions v6 SDK no longer exposes subscriptions.list). */
  public async listEnabledSubscriptions(): Promise<SubscriptionSummary[]> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    if (!token) {
      throw new Error('Azure credential produced no ARM token');
    }
    const subscriptions: SubscriptionSummary[] = [];
    let url: string | undefined = 'https://management.azure.com/subscriptions?api-version=2022-12-01';
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`Subscription listing pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await fetch(url, { headers: { authorization: `Bearer ${token.token}` } });
      if (!response.ok) {
        throw new Error(`Subscription listing failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        value?: Array<{ subscriptionId?: string; displayName?: string; state?: string }>;
        nextLink?: string;
      };
      for (const subscription of body.value ?? []) {
        if ((subscription.state ?? 'Enabled') !== 'Enabled') {
          continue;
        }
        if (subscription.subscriptionId) {
          subscriptions.push({
            subscriptionId: subscription.subscriptionId,
            displayName: subscription.displayName,
            state: subscription.state
          });
        }
      }
      const next: string | undefined = body.nextLink;
      if (next !== undefined && next === url) break; // defensive: repeated pagination link
      url = next;
    }
    return subscriptions;
  }
}
