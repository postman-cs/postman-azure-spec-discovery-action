export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
}

export interface ActionOutputContract {
  description: string;
}

export interface AzureSpecDiscoveryActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
}

export type ActionMode = 'resolve-one' | 'discover-many' | 'discover-estate';

export type ResolutionStatus = 'resolved' | 'unresolved';

export type ProviderType =
  | 'apim'
  | 'api-center'
  | 'app-service'
  | 'iac-local'
  | 'custom-apis'
  | 'logic-apps'
  | 'template-specs'
  | 'event-grid'
  | 'service-bus'
  | 'function-bindings'
  | 'runtime-declared';

export type SourceType =
  | 'repo-spec'
  | 'apim-export'
  | 'api-center-export'
  | 'app-service-api-definition'
  | 'iac-embedded'
  | 'custom-api-swagger'
  | 'logic-apps-workflow'
  | 'template-spec-embedded'
  | 'event-grid-webhook'
  | 'service-bus-topic'
  | 'function-bindings-trigger'
  | 'runtime-declared-spec'
  | 'manual-review'
  | 'discover-many'
  | 'discover-estate';

/**
 * Stable native specification format names used by repository and Azure
 * providers. Serialization is part of the name for YAML/JSON families so
 * later artifact writers can preserve native bytes without re-detecting.
 */
export type SpecFormat =
  | 'openapi-yaml'
  | 'openapi-json'
  | 'asyncapi-yaml'
  | 'asyncapi-json'
  | 'wsdl'
  | 'wadl'
  | 'xsd'
  | 'protobuf'
  | 'graphql-sdl';

/**
 * Provider/output contract fidelity class. Association metadata must never be
 * presented as a full specification. Optional on serialized results so existing
 * consumers remain compatible until later lanes wire the field.
 */
export type ContractClass =
  | 'authoritative'
  | 'reconstructed'
  | 'partial'
  | 'association-only'
  | 'unsupported';

export type ProviderProbeStatus = 'available' | 'skipped:iam' | 'skipped:error';

export type NarrowingTier =
  | 'gateway-host-path'
  | 'tag-prefilter'
  | 'gateway-assignment'
  | 'iac-fingerprint'
  | 'rg-correlation'
  | 'naming-heuristic';

export interface ProviderProbeResult {
  provider: ProviderType;
  status: ProviderProbeStatus;
  evidence?: string;
}

export interface AmbiguousCandidateView {
  rank: number;
  serviceName: string;
  resourceId: string;
  apiId?: string;
  providerType: ProviderType;
  confidence: number;
  supported: boolean;
  evidence: string[];
}

export interface NarrowingMetadata {
  tier: NarrowingTier;
  mode: 'select' | 'narrow';
  droppedCount: number; // demoted count; no candidate is deleted here
}

export interface ResolutionResult {
  status: ResolutionStatus;
  sourceType: SourceType;
  serviceName: string;
  confidence: number;
  specPath?: string;
  apiId?: string;
  providerType?: ProviderType;
  specFormat?: SpecFormat;
  /** Optional fidelity class for later provider wiring; omitted in v1 outputs. */
  contractClass?: ContractClass;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: '3.0.3' | '3.1.0';
  derivedOpenApiCompleteness?: 'full' | 'partial';
  derivedOpenApiFormat?: 'openapi-json';
  derivedOpenApiEvidence?: string[];
  narrowing?: NarrowingMetadata;
  providerProbes?: ProviderProbeResult[];
  rankedCandidates?: AmbiguousCandidateView[];
  evidence: string[];
}

export interface DiscoveredService {
  serviceName: string;
  specPath: string;
  apiId?: string;
  providerType: ProviderType;
  specFormat: SpecFormat;
  /** Optional fidelity class for later provider wiring; omitted in v1 outputs. */
  contractClass?: ContractClass;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: '3.0.3' | '3.1.0';
  derivedOpenApiCompleteness?: 'full' | 'partial';
  derivedOpenApiFormat?: 'openapi-json';
  derivedOpenApiEvidence?: string[];
}

export interface ExportSummary {
  attempted: number;
  exported: number;
  failed: number;
  skipped: number;
}

export const actionContract: AzureSpecDiscoveryActionContract = {
  name: 'Postman Onboarding: Azure Spec Discovery',
  description:
    'Discover Azure-hosted API specs and expose a spec path for Postman onboarding. Part of the Postman API Onboarding suite.',
  inputs: {
    mode: {
      description:
        'Discovery mode: resolve-one selects the single best service for this repository; discover-many exports every exportable candidate; discover-estate enumerates repo-associated Azure resources across the selected subscription scope(s) without exporting specs.',
      required: false,
      default: 'resolve-one'
    },
    'subscription-id': {
      description:
        'Optional Azure subscription ID used as the discovery enumeration root. When omitted, the single enabled subscription visible to the credential is used; multiple enabled subscriptions require this input or subscription-ids-json.',
      required: false,
      default: ''
    },
    'subscription-ids-json': {
      description:
        'Optional JSON array of Azure subscription IDs for explicit multi-subscription discovery. Conflicts with subscription-id unless both identify exactly the same one ID. Empty keeps single-enabled-subscription behavior. Never auto-enumerates all visible subscriptions.',
      required: false,
      default: ''
    },
    'resource-group': {
      description: 'Optional resource group that scopes discovery to one group instead of the whole subscription.',
      required: false,
      default: ''
    },
    'api-id': {
      description: 'Optional full APIM API ARM resource ID for this service. Use this to bypass broader subscription discovery. Supports historical revisions via ;rev=N.',
      required: false,
      default: ''
    },
    environment: {
      description: 'Optional deployment environment selector used to disambiguate APIs that share a repository association across environments.',
      required: false,
      default: ''
    },
    'gateway-id': {
      description: 'Optional self-hosted or workspace gateway id used to narrow APIM API candidates. The value "managed" is rejected.',
      required: false,
      default: ''
    },
    'api-version': {
      description: 'Optional APIM API version selector used when multiple versions share the same path or repository association.',
      required: false,
      default: ''
    },
    'api-revision': {
      description: 'Optional APIM API revision selector used when multiple revisions remain after other evidence.',
      required: false,
      default: ''
    },
    'api-center-definition-id': {
      description:
        'Optional full Azure API Center definition ARM resource ID. Exact match only; conflicts with a different .postman apiCenterDefinitionId binding.',
      required: false,
      default: ''
    },
    'output-dir': {
      description: 'Directory under the repository root where generated specs are written.',
      required: false,
      default: 'discovered-specs'
    },
    'postman-api-key': {
      description: 'Optional service-account PMAK used to mint or re-mint a postman-access-token for telemetry enrichment (account_type). Not used for any Azure or Postman asset operation.',
      required: false,
      default: ''
    },
    'postman-access-token': {
      description: 'Optional Postman service-account access token, used only to enrich anonymous telemetry with the session account_type. When omitted, postman-api-key alone can mint one for the same purpose. Not used for any Azure or Postman asset operation.',
      required: false,
      default: ''
    },
    'enable-logic-apps-list-swagger': {
      description:
        'Opt-in Consumption Logic Apps native listSwagger POST. Default false. When denied or capability-absent, falls back to Reader-only Request-trigger synthesis unless require-logic-apps-native-swagger is true.',
      required: false,
      default: 'false'
    },
    'require-logic-apps-native-swagger': {
      description:
        'When true with enable-logic-apps-list-swagger, a permanent malformed native listSwagger response fails instead of silently synthesizing. Default false.',
      required: false,
      default: 'false'
    },
    'enable-app-service-scm-spec-fetch': {
      description:
        'Opt-in retrieval of App Service aiIntegration.ApiSpecPath bytes through the site SCM/VFS endpoint. Default false. Metadata is still surfaced when the path is present.',
      required: false,
      default: 'false'
    },
    'enable-functions-openapi-extension': {
      description:
        'Opt-in detection/export of Azure Functions OpenAPI extension endpoints evidenced by function metadata or an explicit declared path. Default false. Never lists host/function keys.',
      required: false,
      default: 'false'
    },
    'enable-runtime-declared-spec-routes': {
      description:
        'Opt-in provider for explicitly declared HTTPS specification URLs on App Service, Functions, Container Apps, Static Web Apps, ACI, and AKS workloads. Default false. No blind common-path probing.',
      required: false,
      default: 'false'
    },
    'runtime-declared-spec-targets-json': {
      description:
        'JSON array of explicit runtime-declared specification targets when enable-runtime-declared-spec-routes is true. Each entry requires id, name, workloadKind, and https url.',
      required: false,
      default: '[]'
    }
  },
  outputs: {
    'resolution-json': {
      description: 'JSON resolution result describing status, source type, confidence, and evidence.'
    },
    'resolution-status': {
      description: 'Resolution status: resolved or unresolved.'
    },
    'source-type': {
      description:
        'Resolved source type: repo-spec, apim-export, api-center-export, app-service-api-definition, iac-embedded, custom-api-swagger, logic-apps-workflow, template-spec-embedded, event-grid-webhook, service-bus-topic, function-bindings-trigger, runtime-declared-spec, manual-review, discover-many, or discover-estate.'
    },

    'mapping-confidence': {
      description: 'Numeric confidence score for the selected service candidate.'
    },
    'spec-path': {
      description: 'Path to the resolved or generated specification when available.'
    },
    'api-id': {
      description:
        'Full APIM API ARM resource ID or API Center definition ARM resource ID when those providers resolve; empty for App Service or IaC-local resolutions.'
    },
    'service-name': {
      description: 'Resolved service name.'
    },
    'services-json': {
      description: 'discover-many output: JSON array of exported services.'
    },
    'service-count': {
      description: 'discover-many output: number of exported services.'
    },
    'export-summary-json': {
      description: 'JSON summary of attempted, exported, failed, and skipped candidates.'
    },
    'candidates-json': {
      description: 'Ranked ambiguous candidates as JSON when resolution is unresolved with at least two candidates; empty otherwise.'
    },
    'provider-type': {
      description:
        'Provider that produced the resolved spec: apim, api-center, app-service, iac-local, custom-apis, logic-apps, template-specs, event-grid, service-bus, function-bindings, or runtime-declared.'
    },

    'spec-format': {
      description:
        'Format of the resolved spec: openapi-yaml, openapi-json, asyncapi-yaml, asyncapi-json, wsdl, wadl, xsd, protobuf, or graphql-sdl.'
    },
    'contract-origin': {
      description: 'Compatibility output; always empty in v1.'
    },
    'contract-metadata-path': {
      description: 'Compatibility output; always empty in v1.'
    },
    'variant-count': {
      description: 'Compatibility output; always empty in v1.'
    },
    'derived-openapi-path': {
      description: 'Path to the derived OpenAPI 3.x document when the source was not already OpenAPI 3.x.'
    },
    'derived-openapi-version': {
      description: 'OpenAPI version of the derived document: 3.0.3 or 3.1.0.'
    },
    'derived-openapi-completeness': {
      description: 'Whether the derived OpenAPI document is full or partial.'
    },
    'derived-openapi-format': {
      description: 'Serialization format of the derived OpenAPI document: openapi-json.'
    },
    'derived-openapi-evidence-json': {
      description: 'JSON array of evidence strings describing how the derived OpenAPI document was produced.'
    },
    'narrowing-strategy': {
      description: 'Narrowing tier that produced the candidate ordering: gateway-host-path, tag-prefilter, gateway-assignment, iac-fingerprint, rg-correlation, naming-heuristic, or none.'
    },
    'repos-json': {
      description:
        'discover-estate output: JSON array of deduped org/repo associations discovered from repo tags across the selected subscription scope(s); empty otherwise.'
    },
    'repo-count': {
      description: 'discover-estate output: number of deduped org/repo associations; empty otherwise.'
    }
  }
};

export const contractInputNames: string[] = Object.keys(actionContract.inputs);

export const contractOutputNames: string[] = Object.keys(actionContract.outputs);
