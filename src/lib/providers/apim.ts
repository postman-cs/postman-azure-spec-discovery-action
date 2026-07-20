import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureApimClient, ApimApiSummary, ApimServiceSummary } from '../azure/clients.js';
import { normalizeApiBasePath, normalizeHostname } from '../repo/signals.js';
import {
  applyNativeDependencyFidelity,
  assessNativeDependencyFidelity
} from '../spec/dependency-fidelity.js';
import { parseAndValidateNativeSpec } from '../spec/native-formats.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { toSpecCandidate } from './types.js';

const APIM_API_TYPES = new Set(['http', 'soap', 'graphql', 'websocket', 'grpc', 'odata']);
/**
 * Current APIs with a supported discovery export path (HTTP OpenAPI, SOAP WSDL,
 * GraphQL SDL, gRPC protobuf via schema list/get). gRPC is only exportable when a
 * `text/protobuf` schema is present — see listCandidates.
 */
const SUPPORTED_EXPORTABLE_API_TYPES = new Set(['http', 'soap', 'graphql', 'grpc']);
const SELECT_GRADE_TAG_KEYS = new Set(['postman:repo', 'githuborg', 'githubrepo']);

async function grpcHasProtobufSchema(
  client: AzureApimClient,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
  workspaceId?: string
): Promise<boolean> {
  try {
    const schemas = await client.listApiSchemas(resourceGroup, serviceName, apiId, workspaceId);
    return schemas.some((entry) => (entry.contentType ?? '').trim().toLowerCase() === 'text/protobuf');
  } catch {
    return false;
  }
}

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

function serviceHostnames(service: ApimServiceSummary): string[] {
  const hosts = new Set<string>();
  const gatewayHost = normalizeHostname(service.gatewayHostname);
  if (gatewayHost) hosts.add(gatewayHost);
  // Default managed hostname when SDK omits gatewayUrl but service name is known.
  if (!gatewayHost && service.name) {
    hosts.add(`${service.name.toLowerCase()}.azure-api.net`);
  }
  for (const host of service.customHostnames ?? []) {
    const normalized = normalizeHostname(host);
    if (normalized) hosts.add(normalized);
  }
  return [...hosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function assignedGatewaysForApi(service: ApimServiceSummary, api: ApimApiSummary): string[] {
  const ids = new Set<string>();
  for (const id of api.assignedGatewayIds ?? []) {
    if (id && id.toLowerCase() !== 'managed') ids.add(id);
  }
  for (const assignment of service.gatewayAssignments ?? []) {
    if (assignment.gatewayId.toLowerCase() === 'managed') continue;
    const apiBase = api.apiId.replace(/;rev=.*$/i, '').toLowerCase();
    if (assignment.apiIds.some((id) => id.toLowerCase() === api.apiId.toLowerCase() || id.toLowerCase() === apiBase)) {
      ids.add(assignment.gatewayId);
    }
  }
  if (api.workspaceId) {
    for (const link of service.workspaceGateways ?? []) {
      if (link.workspaceId === api.workspaceId) {
        for (const gatewayId of link.gatewayIds) {
          if (gatewayId && gatewayId.toLowerCase() !== 'managed') ids.add(gatewayId);
        }
      }
    }
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function stripSelectGradeTags(tags: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!SELECT_GRADE_TAG_KEYS.has(key.toLowerCase())) next[key] = value;
  }
  return next;
}

function tagsForApi(service: ApimServiceSummary, eligibleApiCount: number): { tags: Record<string, string>; tagSource: 'api' | 'service-inherited' } {
  const tags = { ...(service.tags ?? {}) };
  // A service tag is effective ownership only when this service contributes one
  // eligible API to discovery. APIs excluded for being historical or unsupported
  // must not turn a single eligible API into an ambiguous inherited tag.
  return { tags, tagSource: eligibleApiCount <= 1 ? 'api' : 'service-inherited' };
}

/**
 * APIM provider: exports current HTTP revisions as OpenAPI, SOAP as native WSDL,
 * GraphQL as native SDL, and gRPC as native protobuf when a `text/protobuf`
 * schema document is present. Remaining API types stay visible for manual review.
 * Explicit `;rev=N` ids are addressable via getApi even when not current.
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

  /**
   * APIM list surfaces already return API identity, tags, path, and type —
   * treat headers as hydrated. Export remains the expensive selected call.
   */
  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const candidates = await this.listCandidates();
    return candidates.map((candidate) => ({ ...candidate, headerHydrated: true }));
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    return headers.map((header) => toSpecCandidate(header));
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];
    const services = await this.client.listServices(this.options.resourceGroup);
    for (const service of services) {
      const apis = await this.client.listApis(service.resourceGroup, service.name);
      // Precompute gRPC protobuf schema presence so eligibility and supported flags agree.
      const grpcProtobufByApiId = new Map<string, boolean>();
      for (const api of apis) {
        if (api.isCurrent === false) continue;
        if ((api.apiType || 'http').toLowerCase() !== 'grpc') continue;
        grpcProtobufByApiId.set(
          api.apiId,
          await grpcHasProtobufSchema(
            this.client,
            service.resourceGroup,
            service.name,
            api.apiId,
            api.workspaceId
          )
        );
      }
      // Inherited service-tag eligibility counts only current, supported/exportable APIs.
      // Unsupported types (websocket/odata, gRPC without protobuf schema) stay visible for
      // manual review but must not turn a sole eligible API into an ambiguous inherited tag.
      const eligibleApiCount = apis.filter((api) => {
        if (api.isCurrent === false) return false;
        const apiType = (api.apiType || 'http').toLowerCase();
        if (apiType === 'grpc') return grpcProtobufByApiId.get(api.apiId) === true;
        return SUPPORTED_EXPORTABLE_API_TYPES.has(apiType);
      }).length;
      const { tags: serviceTags, tagSource } = tagsForApi(service, eligibleApiCount);
      const hostnames = serviceHostnames(service);
      for (const api of apis) {
        if (api.isCurrent === false) continue;
        const apiType = (api.apiType || 'http').toLowerCase();
        if (!APIM_API_TYPES.has(apiType)) continue;
        const hasProtobuf = apiType === 'grpc' ? grpcProtobufByApiId.get(api.apiId) === true : false;
        const supported =
          apiType === 'grpc' ? hasProtobuf : SUPPORTED_EXPORTABLE_API_TYPES.has(apiType);
        // When a service has a sole eligible API, unsupported siblings must not
        // carry select-grade repo tags or they would re-poison tag selection.
        const tags =
          supported || eligibleApiCount > 1 ? serviceTags : stripSelectGradeTags(serviceTags);
        const armId = buildApimApiArmId(
          this.options.subscriptionId,
          service.resourceGroup,
          service.name,
          api.apiId,
          api.workspaceId
        );
        const assignedGatewayIds = assignedGatewaysForApi(service, api);
        const unsupportedReason =
          apiType === 'grpc' && !hasProtobuf
            ? 'APIM gRPC API has no text/protobuf schema document to export'
            : `APIM API type ${apiType} has no supported discovery export path`;
        candidates.push({
          id: armId,
          name: api.displayName || api.apiId,
          providerType: 'apim',
          apiId: armId,
          resourceGroup: service.resourceGroup,
          tags,
          supported,
          evidence: [
            `APIM service ${service.name} exposes ${apiType.toUpperCase()} API ${api.displayName || api.apiId}`,
            ...(supported ? [] : [unsupportedReason]),
            ...(hostnames.length > 0 ? [`Service hostnames: ${hostnames.join(', ')}`] : []),
            ...(assignedGatewayIds.length > 0
              ? [`Assigned gateways: ${assignedGatewayIds.join(', ')}`]
              : [])
          ],
          meta: {
            serviceName: service.name,
            resourceGroup: service.resourceGroup,
            apiId: api.apiId,
            apiType,
            tagSource,
            path: normalizeApiBasePath(api.path),
            hostnames: hostnames.join(','),
            ...(api.apiVersion ? { apiVersion: api.apiVersion } : {}),
            ...(api.apiRevision ? { apiRevision: api.apiRevision } : {}),
            ...(api.apiVersionSetId ? { apiVersionSetId: api.apiVersionSetId } : {}),
            ...(api.workspaceId ? { workspaceId: api.workspaceId } : {}),
            ...(assignedGatewayIds.length > 0 ? { assignedGatewayIds: assignedGatewayIds.join(',') } : {}),
            // Preserve select-grade key presence for tests/docs without claiming API ownership.
            ...(apis.length > 1 && Object.keys(tags).some((key) => SELECT_GRADE_TAG_KEYS.has(key.toLowerCase()))
              ? { inheritedSelectGradeTags: 'true' }
              : {})
          }
        });
      }
    }
    return candidates;
  }

  /**
   * Resolve an explicit API (including historical `;rev=N`) that may be absent
   * from the current-revision candidate list.
   */
  public async resolveExplicitApi(apiArmOrName: string): Promise<SpecCandidate | undefined> {
    const parsed = parseApimApiArmId(apiArmOrName);
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
    const api = await this.client.getApi(parsed.resourceGroup, parsed.serviceName, parsed.apiId, parsed.workspaceId);
    const services = await this.client.listServices(parsed.resourceGroup);
    const service =
      services.find((entry) => entry.name === parsed.serviceName) ??
      ({
        name: parsed.serviceName,
        resourceGroup: parsed.resourceGroup,
        tags: {},
        customHostnames: [],
        gatewayAssignments: [],
        workspaceGateways: []
      } satisfies ApimServiceSummary);
    const armId = buildApimApiArmId(
      this.options.subscriptionId,
      parsed.resourceGroup,
      parsed.serviceName,
      api.apiId,
      api.workspaceId ?? parsed.workspaceId
    );
    const apiType = (api.apiType || 'http').toLowerCase();
    const hasProtobuf =
      apiType === 'grpc'
        ? await grpcHasProtobufSchema(
            this.client,
            parsed.resourceGroup,
            parsed.serviceName,
            api.apiId,
            api.workspaceId ?? parsed.workspaceId
          )
        : false;
    const supported =
      apiType === 'grpc' ? hasProtobuf : SUPPORTED_EXPORTABLE_API_TYPES.has(apiType);
    const hostnames = serviceHostnames(service);
    const assignedGatewayIds = assignedGatewaysForApi(service, api);
    return {
      id: armId,
      name: api.displayName || api.apiId,
      providerType: 'apim',
      apiId: armId,
      resourceGroup: parsed.resourceGroup,
      tags: service.tags ?? {},
      supported,
      evidence: [
        `Explicit APIM API ${api.apiId} resolved from service ${parsed.serviceName}`,
        ...(apiType === 'grpc' && !hasProtobuf
          ? ['APIM gRPC API has no text/protobuf schema document to export']
          : [])
      ],
      meta: {
        serviceName: parsed.serviceName,
        resourceGroup: parsed.resourceGroup,
        apiId: api.apiId,
        apiType,
        tagSource: 'api',
        path: normalizeApiBasePath(api.path),
        hostnames: hostnames.join(','),
        ...(api.apiVersion ? { apiVersion: api.apiVersion } : {}),
        ...(api.apiRevision ? { apiRevision: String(api.apiRevision) } : {}),
        ...(api.workspaceId || parsed.workspaceId
          ? { workspaceId: api.workspaceId ?? parsed.workspaceId ?? '' }
          : {}),
        ...(assignedGatewayIds.length > 0 ? { assignedGatewayIds: assignedGatewayIds.join(',') } : {})
      }
    };
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
      let validated;
      try {
        validated = parseAndValidateNativeSpec(content, 'wsdl');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`APIM SOAP export failed native validation: ${detail}`, { cause: error });
      }
      if (validated.format !== 'wsdl') {
        throw new Error(`APIM SOAP export detected ${validated.format}, expected wsdl`);
      }
      // APIM wsdl-link returns a single primary document; unresolved XSD/WSDL
      // imports have no authoritative companion-byte route → partial.
      return applyNativeDependencyFidelity(
        {
          content,
          format: 'wsdl',
          filename: 'service.wsdl',
          contractClass: 'authoritative',
          evidence: [`Exported revision of APIM SOAP API ${apiId} from service ${serviceName} as WSDL`]
        },
        assessNativeDependencyFidelity({ content, format: 'wsdl' })
      );
    }
    if (candidate.meta.apiType === 'graphql') {
      const content = await this.client.getGraphqlSchema(resourceGroup, serviceName, apiId, candidate.meta.workspaceId);
      let validated;
      try {
        validated = parseAndValidateNativeSpec(content, 'graphql-sdl');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`APIM GraphQL export failed native validation: ${detail}`, { cause: error });
      }
      if (validated.format !== 'graphql-sdl') {
        throw new Error(`APIM GraphQL export detected ${validated.format}, expected graphql-sdl`);
      }
      return {
        content,
        format: 'graphql-sdl',
        filename: 'schema.graphql',
        contractClass: 'authoritative',
        evidence: [`Read GraphQL SDL for APIM API ${apiId} from service ${serviceName}`]
      };
    }
    if (candidate.meta.apiType === 'grpc') {
      const content = await this.client.getProtobufSchema(
        resourceGroup,
        serviceName,
        apiId,
        candidate.meta.workspaceId
      );
      let validated;
      try {
        // Content-path validation only: do not apply a `.proto` filename hint that
        // would accept message-only IDL. Bootstrap-usable protobuf requires
        // syntax=proto[23] or a service/rpc block.
        validated = parseAndValidateNativeSpec(content, 'protobuf');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`APIM gRPC export failed native validation: ${detail}`, { cause: error });
      }
      if (validated.format !== 'protobuf') {
        throw new Error(`APIM gRPC export detected ${validated.format}, expected protobuf`);
      }
      // Schema list/get returns one primary text/protobuf document. Imports are
      // not an APIM export-format surface; mark partial when present.
      return applyNativeDependencyFidelity(
        {
          content,
          format: 'protobuf',
          filename: 'service.proto',
          contractClass: 'authoritative',
          evidence: [
            `Read text/protobuf schema for APIM gRPC API ${apiId} from service ${serviceName}`,
            'APIM export format was not used; schema list/get is the documented protobuf byte route'
          ]
        },
        assessNativeDependencyFidelity({ content, format: 'protobuf' })
      );
    }
    const content = await this.client.exportApi(resourceGroup, serviceName, apiId, candidate.meta.workspaceId);
    const parsed = parseAndValidateOpenApi(content);
    const normalized = `${JSON.stringify(parsed.document, null, 2)}\n`;
    return {
      content: normalized,
      format: 'openapi-json',
      filename: 'index.json',
      contractClass: 'authoritative',
      evidence: [`Exported revision of APIM API ${apiId} from service ${serviceName} as OpenAPI JSON`]
    };
  }
}

export function parseApimApiArmId(value: string): {
  subscriptionId: string;
  resourceGroup: string;
  serviceName: string;
  apiId: string;
  workspaceId?: string;
} | undefined {
  const trimmed = value.trim();
  const withWorkspace =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)\/workspaces\/([^/]+)\/apis\/([^/]+)$/i.exec(
      trimmed
    );
  if (withWorkspace) {
    return {
      subscriptionId: withWorkspace[1]!,
      resourceGroup: withWorkspace[2]!,
      serviceName: withWorkspace[3]!,
      workspaceId: withWorkspace[4]!,
      apiId: withWorkspace[5]!
    };
  }
  const serviceScoped =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)\/apis\/([^/]+)$/i.exec(
      trimmed
    );
  if (serviceScoped) {
    return {
      subscriptionId: serviceScoped[1]!,
      resourceGroup: serviceScoped[2]!,
      serviceName: serviceScoped[3]!,
      apiId: serviceScoped[4]!
    };
  }
  return undefined;
}
