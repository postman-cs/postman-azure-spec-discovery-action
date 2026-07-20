import type { ContractClass, ProviderType, SourceType, SpecFormat } from '../../contracts.js';

/**
 * Single registration seam for provider identity. Runtime construction, coverage
 * verification, and docs derive source type / formats / permissions from here
 * instead of duplicated switch statements.
 */
export interface ProviderRegistration {
  providerType: ProviderType;
  sourceType: SourceType;
  defaultContractClass: ContractClass;
  nativeFormats: readonly SpecFormat[];
  /** Human-readable required capability / RBAC text (matches coverage claims). */
  requiredCapability: string;
  /** Resource Graph `type` values this provider contributes (lowercase). */
  resourceGraphTypes: readonly string[];
  /**
   * AzureDependencies factory key used to construct this provider, or a local
   * sentinel when no cloud client is required.
   */
  dependencyKey:
    | 'createApimClient'
    | 'createApiCenterClient'
    | 'createAppServiceClient'
    | 'createCustomApisClient'
    | 'createLogicWorkflowsClient'
    | 'createTemplateSpecsClient'
    | 'createEventGridClient'
    | 'createServiceBusClient'
    | 'createFunctionsClient'
    | 'local-iac'
    | 'runtime-declared';
  /** Ascending probe / enumeration order (stable, independent of settle order). */
  probeOrder: number;
  /** Stable unsupported-reason tokens when the provider surfaces association-only rows. */
  unsupportedReasons: readonly string[];
}

/**
 * Every ProviderType exactly once, ordered by probeOrder. runtime-declared is
 * registered but not an advertised automatic-discovery provider in coverage.
 */
export const PROVIDER_REGISTRATIONS: readonly ProviderRegistration[] = Object.freeze([
  {
    providerType: 'apim',
    sourceType: 'apim-export',
    defaultContractClass: 'authoritative',
    nativeFormats: ['openapi-json', 'wsdl', 'graphql-sdl', 'protobuf'],
    requiredCapability: 'API Management Service Reader',
    resourceGraphTypes: [
      'microsoft.apimanagement/service/apis',
      'microsoft.apimanagement/service/workspaces/apis'
    ],
    dependencyKey: 'createApimClient',
    probeOrder: 10,
    unsupportedReasons: ['unsupported-api-type', 'non-current-revision']
  },
  {
    providerType: 'api-center',
    sourceType: 'api-center-export',
    defaultContractClass: 'authoritative',
    nativeFormats: [
      'openapi-json',
      'openapi-yaml',
      'asyncapi-json',
      'asyncapi-yaml',
      'wsdl',
      'wadl',
      'xsd',
      'protobuf',
      'graphql-sdl',
      'mcp-json'
    ],
    requiredCapability:
      'Microsoft.ApiCenter read + definitions/exportSpecification/action (Service Reader); data-plane inventory optional and unused',
    resourceGraphTypes: [],
    dependencyKey: 'createApiCenterClient',
    probeOrder: 20,
    unsupportedReasons: ['empty-export', 'malformed-native-export']
  },
  {
    providerType: 'app-service',
    sourceType: 'app-service-api-definition',
    defaultContractClass: 'authoritative',
    nativeFormats: ['openapi-json', 'openapi-yaml'],
    requiredCapability: 'Reader (Microsoft.Web/sites read)',
    resourceGraphTypes: ['microsoft.web/sites'],
    dependencyKey: 'createAppServiceClient',
    probeOrder: 30,
    unsupportedReasons: ['api-spec-path-metadata-only', 'scm-disabled', 'private-network-unreachable']
  },
  {
    providerType: 'custom-apis',
    sourceType: 'custom-api-swagger',
    defaultContractClass: 'authoritative',
    nativeFormats: ['openapi-json', 'wsdl'],
    requiredCapability: 'Reader (Microsoft.Web/customApis read)',
    resourceGraphTypes: ['microsoft.web/customapis'],
    dependencyKey: 'createCustomApisClient',
    probeOrder: 40,
    unsupportedReasons: ['no-inline-swagger']
  },
  {
    providerType: 'logic-apps',
    sourceType: 'logic-apps-workflow',
    defaultContractClass: 'partial',
    nativeFormats: ['openapi-json'],
    requiredCapability: 'Reader (Microsoft.Logic/workflows read)',
    resourceGraphTypes: ['microsoft.logic/workflows'],
    dependencyKey: 'createLogicWorkflowsClient',
    probeOrder: 50,
    unsupportedReasons: ['no-http-request-trigger', 'standard-association-only']
  },
  {
    providerType: 'template-specs',
    sourceType: 'template-spec-embedded',
    defaultContractClass: 'partial',
    nativeFormats: ['openapi-json'],
    requiredCapability: 'Reader (Microsoft.Resources/templateSpecs read)',
    resourceGraphTypes: ['microsoft.resources/templatespecs/versions'],
    dependencyKey: 'createTemplateSpecsClient',
    probeOrder: 60,
    unsupportedReasons: ['no-inline-apim-document', 'secure-parameter-default-withheld']
  },
  {
    providerType: 'event-grid',
    sourceType: 'event-grid-webhook',
    defaultContractClass: 'partial',
    nativeFormats: ['openapi-json'],
    requiredCapability: 'Reader (Microsoft.EventGrid read)',
    resourceGraphTypes: [
      'microsoft.eventgrid/topics',
      'microsoft.eventgrid/domains',
      'microsoft.eventgrid/systemtopics'
    ],
    dependencyKey: 'createEventGridClient',
    probeOrder: 70,
    unsupportedReasons: ['no-webhook-subscription']
  },
  {
    providerType: 'service-bus',
    sourceType: 'service-bus-topic',
    defaultContractClass: 'partial',
    nativeFormats: ['openapi-json'],
    requiredCapability: 'Reader (Microsoft.ServiceBus read)',
    resourceGraphTypes: ['microsoft.servicebus/namespaces/topics'],
    dependencyKey: 'createServiceBusClient',
    probeOrder: 80,
    unsupportedReasons: ['no-subscriptions']
  },
  {
    providerType: 'function-bindings',
    sourceType: 'function-bindings-trigger',
    defaultContractClass: 'partial',
    nativeFormats: ['openapi-json'],
    requiredCapability: 'Reader (Microsoft.Web/sites/functions read)',
    resourceGraphTypes: ['microsoft.web/sites'],
    dependencyKey: 'createFunctionsClient',
    probeOrder: 90,
    unsupportedReasons: ['no-trigger-bindings']
  },
  {
    providerType: 'iac-local',
    sourceType: 'iac-embedded',
    defaultContractClass: 'authoritative',
    nativeFormats: [
      'openapi-json',
      'openapi-yaml',
      'asyncapi-json',
      'asyncapi-yaml',
      'wsdl',
      'wadl',
      'xsd',
      'protobuf',
      'graphql-sdl',
      'mcp-json'
    ],
    requiredCapability: 'none (local filesystem)',
    resourceGraphTypes: [],
    dependencyKey: 'local-iac',
    probeOrder: 110,
    unsupportedReasons: ['multiple-local-specs']
  },
  {
    providerType: 'runtime-declared',
    sourceType: 'runtime-declared-spec',
    defaultContractClass: 'authoritative',
    nativeFormats: [
      'openapi-json',
      'openapi-yaml',
      'asyncapi-json',
      'asyncapi-yaml',
      'wsdl',
      'wadl',
      'xsd',
      'protobuf',
      'graphql-sdl',
      'mcp-json'
    ],
    requiredCapability: 'explicit named runtime target',
    resourceGraphTypes: [],
    dependencyKey: 'runtime-declared',
    probeOrder: 100,
    unsupportedReasons: ['disabled', 'blocked-destination', 'private-network-unreachable']
  }
]);

const BY_TYPE = new Map(PROVIDER_REGISTRATIONS.map((entry) => [entry.providerType, entry]));

/** Advertised automatic-discovery providers (excludes opt-in runtime-declared). */
export const ADVERTISED_PROVIDER_TYPES: readonly ProviderType[] = Object.freeze(
  PROVIDER_REGISTRATIONS.filter((entry) => entry.providerType !== 'runtime-declared').map(
    (entry) => entry.providerType
  )
);

export function getProviderRegistration(providerType: ProviderType): ProviderRegistration {
  const registration = BY_TYPE.get(providerType);
  if (!registration) {
    throw new Error(`No provider registration for ${providerType}`);
  }
  return registration;
}

export function sourceTypeForProvider(providerType: ProviderType): SourceType {
  return getProviderRegistration(providerType).sourceType;
}

export function defaultContractClassForProvider(providerType: ProviderType): ContractClass {
  return getProviderRegistration(providerType).defaultContractClass;
}

export function providerRegistrationsInProbeOrder(): readonly ProviderRegistration[] {
  return [...PROVIDER_REGISTRATIONS].sort((a, b) => a.probeOrder - b.probeOrder || a.providerType.localeCompare(b.providerType));
}

/** Resource Graph candidate types owned by registered providers (deduped, stable). */
export function registeredResourceGraphTypes(): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const registration of providerRegistrationsInProbeOrder()) {
    for (const type of registration.resourceGraphTypes) {
      const key = type.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}
