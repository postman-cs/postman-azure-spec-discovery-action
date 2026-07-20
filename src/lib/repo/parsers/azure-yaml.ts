import path from 'node:path';
import { parse } from 'yaml';

import type { AzureResourceBinding } from '../discovery-types.js';
import { parseAllowlistedEnvContent, sanitizeEvidenceValue } from '../secret-hygiene.js';
import { isFullApimApiId, isFullApiCenterDefinitionId, parseApimApiArmId, parseApiCenterDefinitionArmId, resolveStaticIndirection } from '../arm-ids.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Parse azd `azure.yaml` for project/service names (association) and local spec path references.
 * Remote URLs are evidence only and never fetched.
 */
export function parseAzureYaml(relativePath: string, content: string, variables: Record<string, string> = {}): AzureResourceBinding[] {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const bindings: AzureResourceBinding[] = [];
  const name = asString(parsed.name);
  if (name) {
    bindings.push({
      class: 'association-only',
      family: 'azure-yaml',
      serviceName: name,
      evidence: [{ sourceFile: relativePath, field: 'name', note: `azd project name ${sanitizeEvidenceValue(name)}` }]
    });
  }

  const services = parsed.services;
  if (isRecord(services)) {
    for (const [serviceName, serviceValue] of Object.entries(services)) {
      if (!isRecord(serviceValue)) continue;
      const project = asString(serviceValue.project);
      const resourceGroup = asString(serviceValue.resourceGroup) ?? asString(serviceValue.resource_group);
      if (resourceGroup) {
        bindings.push({
          class: 'association-only',
          family: 'azure-yaml',
          serviceName,
          resourceGroup,
          evidence: [{ sourceFile: relativePath, field: `services.${serviceName}.resourceGroup`, note: `azd service resource group ${sanitizeEvidenceValue(resourceGroup)}` }]
        });
      }
      if (!project) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(project)) {
        bindings.push({
          class: 'association-only',
          family: 'azure-yaml',
          serviceName,
          nativeSpecUrl: project,
          evidence: [{ sourceFile: relativePath, field: `services.${serviceName}.project`, note: 'azd service project URL retained as evidence only (not fetched)' }]
        });
        continue;
      }
      const resolved = resolveStaticIndirection(project, variables) ?? project;
      const candidateRelative = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), resolved.split(path.sep).join('/')));
      if (candidateRelative.startsWith('..')) continue;
      bindings.push({
        class: 'association-only',
        family: 'azure-yaml',
        serviceName,
        nativeSpecPath: candidateRelative,
        evidence: [{ sourceFile: relativePath, field: `services.${serviceName}.project`, note: `azd service references local path ${candidateRelative}` }]
      });
    }
  }

  // Optional azure resolver-style seams if present in azure.yaml.
  for (const seamKey of ['azure', 'api', 'apim']) {
    const seam = parsed[seamKey];
    if (!isRecord(seam)) continue;
    bindings.push(...bindingsFromCoordinateObject(relativePath, seam, variables, 'azure-yaml'));
  }

  return bindings;
}

/**
 * Parse `.azure/<environment>/.env` allowlisted non-secret Azure coordinates only.
 */
export function parseAzureEnvFile(relativePath: string, content: string): AzureResourceBinding[] {
  const envMatch = relativePath.replace(/\\/g, '/').match(/(?:^|\/)\.azure\/([^/]+)\/\.env$/i);
  const environment = envMatch?.[1];
  const values = parseAllowlistedEnvContent(content);
  if (Object.keys(values).length === 0) return [];

  const apimApiId = values.APIM_API_ID ?? values.AZURE_APIM_API_ID ?? values.API_MANAGEMENT_API_ID;
  const apiCenterDefinitionId = values.API_CENTER_DEFINITION_ID ?? values.AZURE_API_CENTER_DEFINITION_ID;
  const serviceName = values.APIM_SERVICE_NAME ?? values.SERVICE_NAME;
  const resourceGroup = values.AZURE_RESOURCE_GROUP ?? values.AZURE_RESOURCE_GROUP_NAME ?? values.RESOURCE_GROUP;
  const subscriptionId = values.AZURE_SUBSCRIPTION_ID ?? values.SUBSCRIPTION_ID;
  const nativeSpecPath = values.OPENAPI_PATH ?? values.SPEC_PATH ?? values.NATIVE_SPEC_PATH ?? values.API_SPEC_PATH;
  const gateway = values.APIM_GATEWAY_URL;
  const apiVersion = values.API_VERSION;
  const apiRevision = values.API_REVISION;

  const exact =
    (apimApiId && isFullApimApiId(apimApiId)) ||
    (apiCenterDefinitionId && isFullApiCenterDefinitionId(apiCenterDefinitionId));

  const binding: AzureResourceBinding = {
    class: exact ? 'exact-binding' : 'association-only',
    family: 'azure-env',
    environment: environment ?? values.AZURE_ENV_NAME,
    serviceName,
    resourceGroup,
    subscriptionId,
    nativeSpecPath,
    apiVersion,
    apiRevision,
    evidence: [
      {
        sourceFile: relativePath,
        note: `allowlisted azure env coordinates from ${relativePath}${environment ? ` (env ${environment})` : ''}`
      }
    ]
  };

  if (apimApiId) {
    const parsed = parseApimApiArmId(apimApiId);
    if (parsed && isFullApimApiId(apimApiId)) {
      binding.apimApiId = parsed.fullId;
      binding.serviceName = binding.serviceName ?? parsed.serviceName;
      binding.resourceGroup = binding.resourceGroup ?? parsed.resourceGroup;
      binding.subscriptionId = binding.subscriptionId ?? parsed.subscriptionId;
      binding.apiRevision = binding.apiRevision ?? parsed.revision;
    } else {
      binding.serviceName = binding.serviceName ?? apimApiId;
      binding.evidence.push({ sourceFile: relativePath, field: 'APIM_API_ID', note: 'APIM API id without full ARM path is association-only' });
    }
  }
  if (apiCenterDefinitionId) {
    const parsed = parseApiCenterDefinitionArmId(apiCenterDefinitionId);
    if (parsed) {
      binding.apiCenterDefinitionId = parsed.fullId;
      binding.serviceName = binding.serviceName ?? parsed.serviceName;
      binding.resourceGroup = binding.resourceGroup ?? parsed.resourceGroup;
      binding.subscriptionId = binding.subscriptionId ?? parsed.subscriptionId;
      binding.apiVersion = binding.apiVersion ?? parsed.version;
    }
  }
  if (gateway && !/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+:[^@/\s]+@/i.test(gateway)) {
    try {
      const url = new URL(gateway);
      binding.gatewayHostname = url.hostname.toLowerCase();
      binding.gatewayBasePath = url.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
    } catch {
      // ignore malformed
    }
  }

  return [binding];
}

export function bindingsFromCoordinateObject(
  relativePath: string,
  raw: Record<string, unknown>,
  variables: Record<string, string>,
  family: AzureResourceBinding['family']
): AzureResourceBinding[] {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = asString(raw[key]);
      if (!value) continue;
      return resolveStaticIndirection(value, variables) ?? value;
    }
    return undefined;
  };

  const apimApiId = pick('apimApiId', 'apim-api-id', 'apiId', 'api-id', 'id');
  const apiCenterDefinitionId = pick(
    'apiCenterDefinitionId',
    'api-center-definition-id',
    'definitionId',
    'definition-id'
  );
  const serviceName = pick('serviceName', 'service', 'apimServiceName');
  const resourceGroup = pick('resourceGroup', 'resource-group', 'resourceGroupName');
  const subscriptionId = pick('subscriptionId', 'subscription-id');
  const environment = pick('environment', 'env');
  const nativeSpecPath = pick('nativeSpecPath', 'specPath', 'openapi', 'specification', 'spec');
  const nativeSpecUrl = pick('nativeSpecUrl', 'specUrl');
  const apiVersion = pick('apiVersion', 'api-version', 'version');
  const apiRevision = pick('apiRevision', 'api-revision', 'revision');

  if (
    !apimApiId &&
    !apiCenterDefinitionId &&
    !serviceName &&
    !resourceGroup &&
    !nativeSpecPath &&
    !nativeSpecUrl
  ) {
    return [];
  }

  const exact =
    (apimApiId && isFullApimApiId(apimApiId)) ||
    (apiCenterDefinitionId && isFullApiCenterDefinitionId(apiCenterDefinitionId));

  const binding: AzureResourceBinding = {
    class: exact ? 'exact-binding' : 'association-only',
    family,
    serviceName,
    resourceGroup,
    subscriptionId,
    environment,
    nativeSpecPath,
    nativeSpecUrl,
    apiVersion,
    apiRevision,
    evidence: [{ sourceFile: relativePath, note: `${family} coordinate object` }]
  };

  if (apimApiId && isFullApimApiId(apimApiId)) {
    const parsed = parseApimApiArmId(apimApiId);
    binding.apimApiId = parsed?.fullId ?? apimApiId;
    binding.serviceName = binding.serviceName ?? parsed?.serviceName;
    binding.resourceGroup = binding.resourceGroup ?? parsed?.resourceGroup;
    binding.subscriptionId = binding.subscriptionId ?? parsed?.subscriptionId;
    binding.apiRevision = binding.apiRevision ?? parsed?.revision;
  } else if (apimApiId) {
    binding.evidence.push({
      sourceFile: relativePath,
      field: 'apimApiId',
      note: 'intended APIM API name/id without full deployed ARM ID is association-only'
    });
    binding.serviceName = binding.serviceName ?? apimApiId;
  }

  if (apiCenterDefinitionId && isFullApiCenterDefinitionId(apiCenterDefinitionId)) {
    const parsed = parseApiCenterDefinitionArmId(apiCenterDefinitionId);
    binding.apiCenterDefinitionId = parsed?.fullId ?? apiCenterDefinitionId;
    binding.apiVersion = binding.apiVersion ?? parsed?.version;
  } else if (apiCenterDefinitionId) {
    binding.evidence.push({
      sourceFile: relativePath,
      field: 'apiCenterDefinitionId',
      note: 'API Center reference without full definition ARM ID is association-only'
    });
  }

  return [binding];
}
