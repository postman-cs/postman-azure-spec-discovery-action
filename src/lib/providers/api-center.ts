import type { ContractClass, ProviderProbeStatus, SpecFormat } from '../../contracts.js';
import type { ApiCenterDefinitionSummary, AzureApiCenterClient } from '../azure/api-center-client.js';
import { parseAndValidateNativeSpec } from '../spec/native-formats.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface ApiCenterProviderOptions {
  subscriptionId: string;
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

export function parseApiCenterDefinitionArmId(value: string): {
  subscriptionId: string;
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  versionName: string;
  definitionName: string;
} | undefined {
  const trimmed = value.trim();
  const match =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiCenter\/services\/([^/]+)\/workspaces\/([^/]+)\/apis\/([^/]+)\/versions\/([^/]+)\/definitions\/([^/]+)$/i.exec(
      trimmed
    );
  if (!match) return undefined;
  return {
    subscriptionId: match[1]!,
    resourceGroup: match[2]!,
    serviceName: match[3]!,
    workspaceName: match[4]!,
    apiName: match[5]!,
    versionName: match[6]!,
    definitionName: match[7]!
  };
}

/** Stable, safe artifact filenames for preserved native API Center exports. */
export function safeNativeFilename(format: SpecFormat): string {
  switch (format) {
    case 'openapi-json':
      return 'index.json';
    case 'openapi-yaml':
      return 'index.yaml';
    case 'asyncapi-json':
      return 'asyncapi.json';
    case 'asyncapi-yaml':
      return 'asyncapi.yaml';
    case 'wsdl':
      return 'service.wsdl';
    case 'wadl':
      return 'application.wadl';
    case 'xsd':
      return 'schema.xsd';
    case 'protobuf':
      return 'service.proto';
    case 'graphql-sdl':
      return 'schema.graphql';
  }
}

function associationEvidence(definition: ApiCenterDefinitionSummary): string[] {
  const evidence: string[] = [];
  for (const deployment of definition.deployments ?? []) {
    const runtime = deployment.runtimeType ? ` (${deployment.runtimeType})` : '';
    evidence.push(
      `API Center deployment ${deployment.name}${runtime} is association evidence only and is not used as a specification source`
    );
  }
  if (definition.lifecycleStage) {
    evidence.push(`API Center version lifecycle stage ${definition.lifecycleStage} is association evidence only`);
  }
  return evidence;
}

function toCandidate(definition: ApiCenterDefinitionSummary): SpecCandidate {
  const display =
    definition.title ||
    definition.apiTitle ||
    `${definition.apiName}/${definition.versionName}/${definition.name}`;
  return {
    id: definition.id,
    name: display,
    providerType: 'api-center',
    apiId: definition.id,
    resourceGroup: definition.resourceGroup,
    tags: definition.tags,
    supported: true,
    evidence: [
      `API Center service ${definition.serviceName} workspace ${definition.workspaceName} exposes definition ${definition.name} for API ${definition.apiName} version ${definition.versionName}`,
      ...associationEvidence(definition)
    ],
    meta: {
      serviceName: definition.serviceName,
      resourceGroup: definition.resourceGroup,
      workspaceName: definition.workspaceName,
      apiName: definition.apiName,
      versionName: definition.versionName,
      definitionName: definition.name,
      ...(definition.specificationName ? { specificationName: definition.specificationName } : {}),
      ...(definition.specificationVersion ? { specificationVersion: definition.specificationVersion } : {}),
      ...(definition.lifecycleStage ? { lifecycleStage: definition.lifecycleStage } : {}),
      contractClass: 'authoritative' satisfies ContractClass
    }
  };
}

/**
 * Authoritative Azure API Center provider: inventories definition ARM resources
 * and exports native specification bytes via exportSpecification.
 */
export class ApiCenterProvider implements SpecProvider {
  public readonly type = 'api-center' as const;

  private readonly client: AzureApiCenterClient;
  private readonly options: ApiCenterProviderOptions;

  public constructor(client: AzureApiCenterClient, options: ApiCenterProviderOptions) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApiCenterReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const definitions = await this.client.listDefinitions(this.options.resourceGroup);
    return definitions
      .map(toCandidate)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Resolve an explicit definition ARM id that may be absent from a filtered
   * inventory (for example when resource-group scope differs). Coordinates are
   * taken from the ARM id itself; export still validates native bytes.
   */
  public resolveExplicitDefinition(definitionArmId: string): SpecCandidate | undefined {
    const parsed = parseApiCenterDefinitionArmId(definitionArmId);
    if (!parsed) return undefined;
    if (parsed.subscriptionId.toLowerCase() !== this.options.subscriptionId.toLowerCase()) {
      return undefined;
    }
    if (
      this.options.resourceGroup &&
      parsed.resourceGroup.toLowerCase() !== this.options.resourceGroup.toLowerCase()
    ) {
      return undefined;
    }
    return toCandidate({
      id: definitionArmId,
      name: parsed.definitionName,
      resourceGroup: parsed.resourceGroup,
      serviceName: parsed.serviceName,
      workspaceName: parsed.workspaceName,
      apiName: parsed.apiName,
      versionName: parsed.versionName,
      tags: {},
      deployments: []
    });
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const resourceGroup = candidate.meta.resourceGroup ?? candidate.resourceGroup ?? '';
    const serviceName = candidate.meta.serviceName ?? '';
    const workspaceName = candidate.meta.workspaceName ?? '';
    const apiName = candidate.meta.apiName ?? '';
    const versionName = candidate.meta.versionName ?? '';
    const definitionName = candidate.meta.definitionName ?? '';
    if (!resourceGroup || !serviceName || !workspaceName || !apiName || !versionName || !definitionName) {
      const parsed = parseApiCenterDefinitionArmId(candidate.id);
      if (!parsed) {
        throw new Error('API Center candidate is missing definition coordinates');
      }
      return this.exportCoordinates(parsed, candidate);
    }
    return this.exportCoordinates(
      {
        resourceGroup,
        serviceName,
        workspaceName,
        apiName,
        versionName,
        definitionName
      },
      candidate
    );
  }

  private async exportCoordinates(
    coords: {
      resourceGroup: string;
      serviceName: string;
      workspaceName: string;
      apiName: string;
      versionName: string;
      definitionName: string;
    },
    candidate: SpecCandidate
  ): Promise<SpecExportResult> {
    const exported = await this.client.exportSpecification(coords);
    let validated;
    try {
      validated = parseAndValidateNativeSpec(exported.content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`API Center definition export failed native validation: ${detail}`, { cause: error });
    }

    let content = exported.content;
    if (validated.format === 'openapi-json' && validated.document) {
      content = `${JSON.stringify(validated.document, null, 2)}\n`;
    }

    return {
      content,
      format: validated.format,
      filename: safeNativeFilename(validated.format),
      contractClass: 'authoritative',
      evidence: [
        `Exported API Center definition ${coords.definitionName} from service ${coords.serviceName} as ${validated.format} (${exported.source})`,
        ...candidate.evidence.filter((line) => /association evidence/i.test(line))
      ]
    };
  }
}
