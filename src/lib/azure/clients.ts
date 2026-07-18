import { ApiManagementClient } from '@azure/arm-apimanagement';
import type { ApiContract, ApiManagementServiceResource } from '@azure/arm-apimanagement';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { DefaultAzureCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';

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

export class ApimSdkClient implements AzureApimClient {
  private readonly client: ApiManagementClient;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.client = new ApiManagementClient(credential, subscriptionId, {
      retryOptions: { maxRetries: options?.maxAttempts ?? 3 }
    });
  }

  public async listServices(resourceGroup?: string): Promise<ApimServiceSummary[]> {
    const services: ApimServiceSummary[] = [];
    const iterator = resourceGroup
      ? this.client.apiManagementService.listByResourceGroup(resourceGroup)
      : this.client.apiManagementService.list();
    for await (const service of iterator) {
      services.push(toServiceSummary(service));
    }
    return services;
  }

  public async listApis(resourceGroup: string, serviceName: string): Promise<ApimApiSummary[]> {
    const apis: ApimApiSummary[] = [];
    for await (const api of this.client.api.listByService(resourceGroup, serviceName)) {
      apis.push(toApiSummary(api, serviceName, resourceGroup));
    }
    return apis;
  }

  /**
   * APIM export is a two-step protocol: the ARM call returns a Storage Blob SAS link
   * (TTL 5 minutes), and the bytes must be fetched from that link immediately.
   */
  public async exportApi(resourceGroup: string, serviceName: string, apiId: string): Promise<string> {
    const result = await this.client.apiExport.get(resourceGroup, serviceName, apiId, EXPORT_FORMAT_OPENAPI_JSON, 'true');
    const link = result.value?.link;
    if (!link) {
      throw new Error(`APIM export for ${apiId} returned no download link`);
    }
    const response = await fetch(link, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`APIM export link fetch failed with HTTP ${response.status}`);
    }
    return await response.text();
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
    const sites: AppServiceSiteSummary[] = [];
    const iterator = resourceGroup ? this.client.webApps.listByResourceGroup(resourceGroup) : this.client.webApps.list();
    for await (const site of iterator) {
      const siteResourceGroup = site.resourceGroup ?? extractResourceGroup(site.id);
      if (!site.name || !siteResourceGroup) {
        continue;
      }
      let apiDefinitionUrl: string | undefined;
      try {
        const config = await this.client.webApps.getConfiguration(siteResourceGroup, site.name);
        apiDefinitionUrl = config.apiDefinition?.url ?? undefined;
      } catch {
        // Site config may be inaccessible; the site is still a naming signal.
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
    do {
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
    while (url) {
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
