import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureAppServiceClient } from '../azure/clients.js';
import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface AppServiceProviderOptions {
  subscriptionId: string;
  resourceGroup?: string;
  requestTimeoutMs?: number;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

/**
 * App Service provider: a site is a candidate only when siteConfig.apiDefinition.url
 * is non-empty. HTTPS is mandatory before any fetch; the shared fetcher enforces
 * redirect, size, and timeout caps; every remote document must validate as
 * Swagger 2.0 / OpenAPI 3.x before it is exported.
 */
export class AppServiceProvider implements SpecProvider {
  public readonly type = 'app-service' as const;

  private readonly client: AzureAppServiceClient;
  private readonly options: AppServiceProviderOptions;

  public constructor(client: AzureAppServiceClient, options: AppServiceProviderOptions) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeAppServiceReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const sites = await this.client.listSites(this.options.resourceGroup);
    const candidates: SpecCandidate[] = [];
    for (const site of sites) {
      const apiDefinitionUrl = (site.apiDefinitionUrl ?? '').trim();
      if (!apiDefinitionUrl) continue;
      const armId = `/subscriptions/${this.options.subscriptionId}/resourceGroups/${site.resourceGroup}/providers/Microsoft.Web/sites/${site.name}`;
      candidates.push({
        id: armId,
        name: site.name,
        providerType: 'app-service',
        resourceGroup: site.resourceGroup,
        tags: site.tags,
        supported: true,
        evidence: [`App Service site ${site.name} declares an API definition URL`],
        meta: { siteName: site.name, resourceGroup: site.resourceGroup, apiDefinitionUrl }
      });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const apiDefinitionUrl = candidate.meta.apiDefinitionUrl ?? '';
    if (!apiDefinitionUrl) {
      throw new Error('App Service candidate has no API definition URL');
    }
    const parsedUrl = new URL(apiDefinitionUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`App Service API definition URL must use HTTPS; got ${parsedUrl.protocol}`);
    }
    const fetched = await fetchSpecFromUrl(apiDefinitionUrl, { timeoutMs: this.options.requestTimeoutMs });
    const validated = parseAndValidateOpenApi(fetched.content);
    const normalized = fetched.content.endsWith('\n') ? fetched.content : `${fetched.content}\n`;
    return {
      content: normalized,
      format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
      filename: validated.isJson ? 'index.json' : 'index.yaml',
      evidence: [`Fetched API definition for App Service site ${candidate.meta.siteName ?? candidate.name} over HTTPS`]
    };
  }
}
