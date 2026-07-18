import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureApimClient } from '../azure/clients.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const APIM_API_TYPES = new Set(['http', 'soap', 'graphql', 'websocket', 'grpc', 'odata']);

export interface ApimProviderOptions {
  subscriptionId: string;
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

export function buildApimApiArmId(
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
  workspaceId?: string
): string {
  const serviceRoot = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}`;
  return workspaceId
    ? `${serviceRoot}/workspaces/${workspaceId}/apis/${apiId}`
    : `${serviceRoot}/apis/${apiId}`;
}

/**
 * APIM provider: exports current HTTP revisions as OpenAPI, SOAP as native WSDL,
 * and GraphQL as native SDL. Remaining API types stay visible for manual review.
 */
export class ApimProvider implements SpecProvider {
  public readonly type = 'apim' as const;

  private readonly client: AzureApimClient;
  private readonly options: ApimProviderOptions;

  public constructor(client: AzureApimClient, options: ApimProviderOptions) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApimReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];
    const services = await this.client.listServices(this.options.resourceGroup);
    for (const service of services) {
      const apis = await this.client.listApis(service.resourceGroup, service.name);
      for (const api of apis) {
        if (api.isCurrent === false) continue;
        const apiType = (api.apiType || 'http').toLowerCase();
        const supported = apiType === 'http' || apiType === 'soap' || apiType === 'graphql';
        if (!APIM_API_TYPES.has(apiType)) continue;
        const armId = buildApimApiArmId(
          this.options.subscriptionId,
          service.resourceGroup,
          service.name,
          api.apiId,
          api.workspaceId
        );
        candidates.push({
          id: armId,
          name: api.displayName || api.apiId,
          providerType: 'apim',
          apiId: armId,
          resourceGroup: service.resourceGroup,
          tags: service.tags,
          supported,
          evidence: [
            `APIM service ${service.name} exposes ${apiType.toUpperCase()} API ${api.displayName || api.apiId}`,
            ...(supported ? [] : [`APIM API type ${apiType} has no supported discovery export path`])
          ],
          meta: {
            serviceName: service.name,
            resourceGroup: service.resourceGroup,
            apiId: api.apiId,
            apiType,
            ...(api.workspaceId ? { workspaceId: api.workspaceId } : {})
          }
        });
      }
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`APIM API type ${candidate.meta.apiType ?? 'unknown'} has no supported discovery export path`);
    }
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const serviceName = candidate.meta.serviceName ?? '';
    const apiId = candidate.meta.apiId ?? '';
    if (!resourceGroup || !serviceName || !apiId) {
      throw new Error('APIM candidate is missing service coordinates');
    }
    if (candidate.meta.apiType === 'soap') {
      const content = await this.client.exportApi(resourceGroup, serviceName, apiId, candidate.meta.workspaceId, 'wsdl-link');
      return {
        content,
        format: 'wsdl',
        filename: 'service.wsdl',
        evidence: [`Exported current revision of APIM SOAP API ${apiId} from service ${serviceName} as WSDL`]
      };
    }
    if (candidate.meta.apiType === 'graphql') {
      const content = await this.client.getGraphqlSchema(resourceGroup, serviceName, apiId, candidate.meta.workspaceId);
      return {
        content,
        format: 'graphql-sdl',
        filename: 'schema.graphql',
        evidence: [`Read GraphQL SDL for current APIM API ${apiId} from service ${serviceName}`]
      };
    }
    const content = await this.client.exportApi(resourceGroup, serviceName, apiId, candidate.meta.workspaceId);
    const parsed = parseAndValidateOpenApi(content);
    const normalized = `${JSON.stringify(parsed.document, null, 2)}\n`;
    return {
      content: normalized,
      format: 'openapi-json',
      filename: 'index.json',
      evidence: [`Exported current revision of APIM API ${apiId} from service ${serviceName} as OpenAPI JSON`]
    };
  }
}
