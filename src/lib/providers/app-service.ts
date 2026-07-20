import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureAppServiceClient } from '../azure/clients.js';
import type { AzureAppServiceRuntimeClient } from '../azure/app-service-runtime-client.js';
import { fetchSpecFromUrl, SpecFetchError } from '../fetch/spec-fetcher.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { listCandidatesViaHydration, toSpecCandidate } from './types.js';

export interface AppServiceProviderOptions {
  subscriptionId: string;
  resourceGroup?: string;
  requestTimeoutMs?: number;
  /** Opt-in SCM/VFS retrieval of aiIntegration.ApiSpecPath bytes. Default false. */
  enableScmSpecFetch?: boolean;
  runtimeClient?: AzureAppServiceRuntimeClient;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

/**
 * App Service provider:
 *  - siteConfig.apiDefinition.url remains the default HTTPS guarded-fetch route
 *  - aiIntegration.ApiSpecPath is always surfaced as exact path metadata when present
 *  - ApiSpecPath bytes are retrieved only under explicit SCM opt-in through the
 *    site's own least-privilege SCM/VFS endpoint (no credential forwarding to
 *    arbitrary hosts). Disabled SCM / private unreachable are distinct reasons.
 */
export class AppServiceProvider implements SpecProvider {
  public readonly type = 'app-service' as const;

  private readonly client: AzureAppServiceClient;
  private readonly options: AppServiceProviderOptions;
  private readonly runtimeCache = new Map<string, Awaited<ReturnType<AzureAppServiceRuntimeClient['getSiteRuntimeConfig']>>>();

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

  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const sites = await this.client.listSites(this.options.resourceGroup);
    const headers: SpecCandidateHeader[] = [];
    for (const site of sites) {
      const armId = `/subscriptions/${this.options.subscriptionId}/resourceGroups/${site.resourceGroup}/providers/Microsoft.Web/sites/${site.name}`;
      const apiDefinitionUrl = (site.apiDefinitionUrl ?? '').trim();
      // List payload already carries apiDefinitionUrl; only runtime/SCM config is deferred.
      if (apiDefinitionUrl && !this.options.runtimeClient) {
        headers.push({
          id: armId,
          name: site.name,
          providerType: 'app-service',
          resourceGroup: site.resourceGroup,
          tags: site.tags,
          supported: true,
          headerHydrated: true,
          evidence: [`App Service site ${site.name} declares an API definition URL`],
          meta: {
            siteName: site.name,
            resourceGroup: site.resourceGroup,
            apiDefinitionUrl
          }
        });
        continue;
      }
      if (!apiDefinitionUrl && !this.options.runtimeClient) {
        continue;
      }
      // Runtime config (ApiSpecPath / SCM) is deferred; keep the site for narrowing.
      headers.push({
        id: armId,
        name: site.name,
        providerType: 'app-service',
        resourceGroup: site.resourceGroup,
        tags: site.tags,
        supported: true,
        headerHydrated: false,
        evidence: [
          apiDefinitionUrl
            ? `App Service site ${site.name} declares an API definition URL; runtime config deferred until selected`
            : `App Service site ${site.name} enumerated; runtime/SCM config deferred until selected`
        ],
        meta: {
          siteName: site.name,
          resourceGroup: site.resourceGroup,
          hydrationPending: 'true',
          ...(apiDefinitionUrl ? { apiDefinitionUrl } : {})
        }
      });
    }
    return headers;
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    const out: SpecCandidate[] = [];
    for (const header of headers) {
      if (header.headerHydrated) {
        out.push(toSpecCandidate(header));
        continue;
      }
      out.push(await this.hydrateCandidate(header));
    }
    return out;
  }

  public async hydrateCandidate(header: SpecCandidateHeader): Promise<SpecCandidate> {
    if (header.headerHydrated) {
      return toSpecCandidate(header);
    }
    const resourceGroup = header.meta.resourceGroup ?? header.resourceGroup ?? '';
    const siteName = header.meta.siteName ?? header.name;
    let apiDefinitionUrl = (header.meta.apiDefinitionUrl ?? '').trim();
    let apiSpecPath: string | undefined;
    let scmHostName: string | undefined;
    let publicNetworkAccess: string | undefined;

    if (this.options.runtimeClient) {
      const runtime = await this.options.runtimeClient.getSiteRuntimeConfig(resourceGroup, siteName);
      this.runtimeCache.set(header.id, runtime);
      apiDefinitionUrl = apiDefinitionUrl || (runtime.apiDefinitionUrl ?? '').trim();
      apiSpecPath = runtime.apiSpecPath;
      scmHostName = runtime.scmHostName;
      publicNetworkAccess = runtime.publicNetworkAccess;
    }

    if (!apiDefinitionUrl && !apiSpecPath) {
      return {
        id: header.id,
        name: header.name,
        providerType: 'app-service',
        resourceGroup: header.resourceGroup,
        tags: header.tags,
        supported: false,
        evidence: [`App Service site ${siteName} has no API definition URL or ApiSpecPath`],
        meta: {
          siteName,
          resourceGroup
        }
      };
    }

    const supported = Boolean(apiDefinitionUrl) || Boolean(apiSpecPath && this.options.enableScmSpecFetch);
    return {
      id: header.id,
      name: header.name,
      providerType: 'app-service',
      resourceGroup: header.resourceGroup,
      tags: header.tags,
      supported,
      evidence: [
        ...(apiDefinitionUrl ? [`App Service site ${siteName} declares an API definition URL`] : []),
        ...(apiSpecPath ? [`App Service site ${siteName} declares aiIntegration.ApiSpecPath=${apiSpecPath}`] : []),
        ...(apiSpecPath && !this.options.enableScmSpecFetch
          ? ['ApiSpecPath metadata only; SCM artifact fetch is disabled (opt-in required)']
          : []),
        ...(publicNetworkAccess ? [`publicNetworkAccess=${publicNetworkAccess}`] : [])
      ],
      meta: {
        siteName,
        resourceGroup,
        ...(apiDefinitionUrl ? { apiDefinitionUrl } : {}),
        ...(apiSpecPath ? { apiSpecPath } : {}),
        ...(scmHostName ? { scmHostName } : {}),
        ...(publicNetworkAccess ? { publicNetworkAccess } : {}),
        ...(apiSpecPath && !apiDefinitionUrl && !this.options.enableScmSpecFetch
          ? { manualReviewReason: 'api-spec-path-metadata-only' }
          : {})
      }
    };
  }

  public listCandidates(): Promise<SpecCandidate[]> {
    return listCandidatesViaHydration(this);
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const apiDefinitionUrl = candidate.meta.apiDefinitionUrl ?? '';
    if (apiDefinitionUrl) {
      return this.exportApiDefinitionUrl(candidate, apiDefinitionUrl);
    }

    const apiSpecPath = candidate.meta.apiSpecPath ?? '';
    if (!apiSpecPath) {
      throw new Error('App Service candidate has no API definition URL or ApiSpecPath');
    }
    if (!this.options.enableScmSpecFetch) {
      throw new Error(
        `App Service site ${candidate.name} ApiSpecPath=${apiSpecPath} requires enable-app-service-scm-spec-fetch`
      );
    }
    if (!this.options.runtimeClient) {
      throw new Error('App Service SCM spec fetch requires a runtime client');
    }

    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const siteName = candidate.meta.siteName ?? candidate.name;
    const result = await this.options.runtimeClient.fetchApiSpecFromScm(resourceGroup, siteName, apiSpecPath);
    if (result.kind === 'content') {
      const validated = parseAndValidateOpenApi(result.content);
      return {
        content: result.content,
        format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
        filename: validated.isJson ? 'index.json' : 'index.yaml',
        contractClass: 'authoritative',
        evidence: [
          `Fetched ApiSpecPath artifact for App Service site ${siteName} via site SCM/VFS`,
          `Exact path: ${apiSpecPath}`,
          'Credentials were not forwarded to arbitrary hosts'
        ]
      };
    }
    if (result.kind === 'scm-disabled') {
      throw new Error(
        `App Service site ${siteName} SCM is disabled or unavailable (manual-review: scm-disabled): ${result.detail}`
      );
    }
    if (result.kind === 'private-network-unreachable') {
      throw new Error(
        `App Service site ${siteName} SCM artifact is private-network-unreachable (manual-review: private-network-unreachable): ${result.detail}`
      );
    }
    if (result.kind === 'permission-denied') {
      throw new Error(
        `App Service site ${siteName} SCM artifact fetch denied with HTTP ${result.status}`
      );
    }
    if (result.kind === 'not-found') {
      throw new Error(`App Service site ${siteName} SCM artifact was not found (HTTP ${result.status})`);
    }
    throw new Error(`App Service site ${siteName} SCM artifact fetch failed: ${result.detail}`);
  }

  private async exportApiDefinitionUrl(candidate: SpecCandidate, apiDefinitionUrl: string): Promise<SpecExportResult> {
    const parsedUrl = new URL(apiDefinitionUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`App Service API definition URL must use HTTPS; got ${parsedUrl.protocol}`);
    }
    try {
      const fetched = await fetchSpecFromUrl(apiDefinitionUrl, { timeoutMs: this.options.requestTimeoutMs });
      const validated = parseAndValidateOpenApi(fetched.content);
      const normalized = fetched.content.endsWith('\n') ? fetched.content : `${fetched.content}\n`;
      return {
        content: normalized,
        format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
        filename: validated.isJson ? 'index.json' : 'index.yaml',
        contractClass: 'authoritative',
        evidence: [
          `Fetched API definition for App Service site ${candidate.meta.siteName ?? candidate.name} over HTTPS`,
          'No Authorization/Cookie/Azure/GitHub credentials were forwarded'
        ]
      };
    } catch (error) {
      if (error instanceof SpecFetchError && error.code === 'private-network-unreachable') {
        throw new Error(
          `App Service API definition URL is private-network-unreachable: ${apiDefinitionUrl}`,
          { cause: error }
        );
      }
      if (error instanceof SpecFetchError && error.code === 'blocked-ssrf') {
        throw new Error(`App Service API definition URL blocked by SSRF defenses: ${apiDefinitionUrl}`, {
          cause: error
        });
      }
      throw error;
    }
  }
}
