import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureCustomApisClient } from '../azure/clients.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import { toSafePublicUrl } from './public-url.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface CustomApisProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

/**
 * Logic Apps custom connector provider (Microsoft.Web/customApis).
 *
 * Custom connectors store a literal Swagger/OpenAPI document control-plane-side
 * in properties.swagger, readable with plain Reader RBAC -- the richest
 * spec-bearing Azure surface outside APIM. A connector is a candidate only when
 * that inline swagger exists; connectors without one stay visible as
 * unsupported manual-review candidates (originalSwaggerUrl and backendService
 * URLs surface as evidence, never auto-fetched).
 *
 * Secret hygiene: the ARM payload carries
 * connectionParameters.oAuthSettings.clientSecret beside the swagger. The
 * client projects only {swagger, apiDefinitions.*SwaggerUrl,
 * backendService.serviceUrl}; this provider never touches raw properties.
 */
export class CustomApisProvider implements SpecProvider {
  public readonly type = 'custom-apis' as const;

  private readonly client: AzureCustomApisClient;
  private readonly options: CustomApisProviderOptions;

  public constructor(client: AzureCustomApisClient, options: CustomApisProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeCustomApisReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const connectors = await this.client.listCustomApis(this.options.resourceGroup);
    return connectors.map((connector): SpecCandidate => {
      const supported = connector.hasSwagger;
      const backendServiceUrl = toSafePublicUrl(connector.backendServiceUrl);
      const originalSwaggerUrl = toSafePublicUrl(connector.originalSwaggerUrl);
      return {
        id: connector.id,
        name: connector.name,
        providerType: 'custom-apis',
        resourceGroup: connector.resourceGroup,
        tags: connector.tags,
        supported,
        evidence: [
          `Custom connector ${connector.name} ${supported ? 'carries an inline swagger document' : 'has no inline swagger document'}`,
          ...(backendServiceUrl ? [`Backend service URL: ${backendServiceUrl}`] : []),
          ...(!supported && originalSwaggerUrl ? [`Original swagger URL (not auto-fetched): ${originalSwaggerUrl}`] : [])
        ],
        meta: {
          resourceGroup: connector.resourceGroup,
          connectorName: connector.name,
          ...(backendServiceUrl ? { backendServiceUrl } : {})
        }
      };
    });
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Custom connector ${candidate.name} has no inline swagger document to export`);
    }
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const connectorName = candidate.meta.connectorName ?? '';
    if (!resourceGroup || !connectorName) {
      throw new Error('Custom connector candidate is missing resource coordinates');
    }
    const content = await this.client.getSwagger(resourceGroup, connectorName);
    const parsed = parseAndValidateOpenApi(content);
    const normalized = `${JSON.stringify(parsed.document, null, 2)}\n`;
    return {
      content: normalized,
      format: 'openapi-json',
      filename: 'index.json',
      evidence: [`Exported inline swagger document from custom connector ${connectorName}`]
    };
  }
}
