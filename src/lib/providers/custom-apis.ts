import type { ContractClass, ProviderProbeStatus } from '../../contracts.js';
import type { AzureCustomApisClient } from '../azure/clients.js';
import {
  applyNativeDependencyFidelity,
  assessNativeDependencyFidelity
} from '../spec/dependency-fidelity.js';
import { parseAndValidateNativeSpec } from '../spec/native-formats.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import { toSafePublicUrl } from './public-url.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { toSpecCandidate } from './types.js';

export interface CustomApisProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

function isSoapToRest(importMethod: string | undefined): boolean {
  return (importMethod ?? '').trim().toLowerCase() === 'soaptorest';
}

/**
 * Logic Apps custom connector provider (Microsoft.Web/customApis).
 *
 * Custom connectors store a literal Swagger/OpenAPI document control-plane-side
 * in properties.swagger and/or WSDL bytes in properties.wsdlDefinition.content,
 * readable with plain Reader RBAC. A connector is a candidate when either inline
 * document exists. When both are present, Swagger wins deterministically and WSDL
 * is recorded as demoted evidence. SoapToRest-transformed WSDL is never
 * authoritative (reconstructed/partial).
 *
 * Secret hygiene: the ARM payload carries
 * connectionParameters.oAuthSettings.clientSecret beside the swagger. The
 * client projects only {swagger, wsdlDefinition.content/importMethod,
 * apiDefinitions.*SwaggerUrl, backendService.serviceUrl}; this provider never
 * touches raw properties.
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

  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const candidates = await this.listCandidates();
    return candidates.map((candidate) => ({ ...candidate, headerHydrated: true }));
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    return headers.map((header) => toSpecCandidate(header));
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const connectors = await this.client.listCustomApis(this.options.resourceGroup);
    return connectors.map((connector): SpecCandidate => {
      const supported = connector.hasSwagger || connector.hasWsdl;
      const backendServiceUrl = toSafePublicUrl(connector.backendServiceUrl);
      const originalSwaggerUrl = toSafePublicUrl(connector.originalSwaggerUrl);
      const bothPresent = connector.hasSwagger && connector.hasWsdl;
      // Deterministic preference when both inline documents exist: Swagger wins.
      const preferredFormat = connector.hasSwagger ? 'swagger' : connector.hasWsdl ? 'wsdl' : 'none';
      const soapToRest = isSoapToRest(connector.wsdlImportMethod);
      return {
        id: connector.id,
        name: connector.name,
        providerType: 'custom-apis',
        resourceGroup: connector.resourceGroup,
        tags: connector.tags,
        supported,
        evidence: [
          `Custom connector ${connector.name} ${
            supported
              ? preferredFormat === 'swagger'
                ? 'carries an inline swagger document'
                : 'carries inline WSDL content'
              : 'has no inline swagger or WSDL content'
          }`,
          ...(bothPresent
            ? [
                'Both inline swagger and WSDL content are present; swagger is preferred deterministically and WSDL is demoted'
              ]
            : []),
          ...(preferredFormat === 'wsdl' && soapToRest
            ? ['WSDL importMethod SoapToRest is transformed/lossy; export fidelity is reconstructed (never authoritative)']
            : []),
          ...(backendServiceUrl ? [`Backend service URL: ${backendServiceUrl}`] : []),
          ...(!supported && originalSwaggerUrl
            ? [`Original swagger URL (not auto-fetched): ${originalSwaggerUrl}`]
            : [])
        ],
        meta: {
          resourceGroup: connector.resourceGroup,
          connectorName: connector.name,
          preferredFormat,
          ...(connector.wsdlImportMethod ? { wsdlImportMethod: connector.wsdlImportMethod } : {}),
          ...(backendServiceUrl ? { backendServiceUrl } : {})
        }
      };
    });
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Custom connector ${candidate.name} has no inline swagger or WSDL content to export`);
    }
    const resourceGroup = candidate.meta.resourceGroup ?? '';
    const connectorName = candidate.meta.connectorName ?? '';
    if (!resourceGroup || !connectorName) {
      throw new Error('Custom connector candidate is missing resource coordinates');
    }
    const preferred = candidate.meta.preferredFormat ?? 'swagger';
    if (preferred === 'wsdl') {
      const wsdl = await this.client.getWsdl(resourceGroup, connectorName);
      let validated;
      try {
        validated = parseAndValidateNativeSpec(wsdl.content, 'wsdl');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Custom connector WSDL failed native validation: ${detail}`, { cause: error });
      }
      if (validated.format !== 'wsdl') {
        throw new Error(`Custom connector WSDL detected ${validated.format}, expected wsdl`);
      }
      const soapToRest = isSoapToRest(wsdl.importMethod ?? candidate.meta.wsdlImportMethod);
      const contractClass: ContractClass = soapToRest ? 'reconstructed' : 'authoritative';
      // Inline wsdlDefinition.content is a single primary document; unresolved
      // XSD/WSDL imports stay partial (SoapToRest remains reconstructed).
      return applyNativeDependencyFidelity(
        {
          content: wsdl.content,
          format: 'wsdl',
          filename: 'service.wsdl',
          completeness: soapToRest ? 'partial' : 'full',
          contractClass,
          evidence: [
            `Exported inline WSDL content from custom connector ${connectorName}`,
            ...(soapToRest
              ? ['SoapToRest importMethod marks this WSDL as reconstructed/partial (never authoritative)']
              : ['WSDL content preserved as authoritative native bytes'])
          ]
        },
        assessNativeDependencyFidelity({ content: wsdl.content, format: 'wsdl' })
      );
    }

    const content = await this.client.getSwagger(resourceGroup, connectorName);
    const parsed = parseAndValidateOpenApi(content);
    const normalized = `${JSON.stringify(parsed.document, null, 2)}\n`;
    return {
      content: normalized,
      format: 'openapi-json',
      filename: 'index.json',
      contractClass: 'authoritative',
      evidence: [
        `Exported inline swagger document from custom connector ${connectorName}`,
        ...(candidate.meta.preferredFormat === 'swagger' && candidate.evidence.some((row) => /Both inline swagger and WSDL/i.test(row))
          ? ['WSDL content was demoted because swagger was preferred deterministically']
          : [])
      ]
    };
  }
}
