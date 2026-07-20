import { parse } from 'yaml';

import type { AzureResourceBinding } from '../discovery-types.js';
import {
  isFullApiCenterDefinitionId,
  isFullApimApiId,
  parseApiCenterDefinitionArmId,
  parseApimApiArmId,
  resolveStaticIndirection
} from '../arm-ids.js';
import { isSecretKey, isSecretValue, sanitizeEvidenceValue } from '../secret-hygiene.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectStrings(value: unknown, into: Record<string, string>, prefix = ''): void {
  if (typeof value === 'string') {
    if (prefix && !isSecretKey(prefix) && !isSecretValue(value)) {
      into[prefix] = value;
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, into, `${prefix}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    if (isRecord(child) && ('secure' in child || child.type === 'secureString')) continue;
    collectStrings(child, into, prefix ? `${prefix}.${key}` : key);
    const text = asString(child);
    if (text && !isSecretValue(text)) {
      into[key] = text;
      into[key.toUpperCase()] = text;
    }
  }
}

function pick(map: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = map[key] ?? map[key.toUpperCase()] ?? map[key.toLowerCase()];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Parse APIOps extractor/publisher configuration (YAML or JSON).
 */
export function parseApiOpsConfig(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(trimmed) : parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(parsed) && !Array.isArray(parsed)) return [];

  const flat: Record<string, string> = { ...variables };
  collectStrings(parsed, flat);

  // Heuristic: APIOps configs usually mention extractor/publisher/APIM coordinates.
  const basename = relativePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const looksApiOps =
    /(?:extractor|publisher|apiops|configuration\.(?:extractor|publisher))/i.test(basename) ||
    Boolean(
      pick(
        flat,
        'API_SPECIFICATION_PATH',
        'specificationPath',
        'CONFIGURATION_YAML_PATH',
        'apimServiceName',
        'API_MANAGEMENT_SERVICE_NAME',
        'extractorSource'
      )
    ) ||
    /apiops|extractor|publisher/i.test(JSON.stringify(Object.keys(flat)));
  if (!looksApiOps) return [];

  const apimApiId = resolveStaticIndirection(
    pick(flat, 'apimApiId', 'APIM_API_ID', 'apiId', 'API_ID') ?? '',
    flat
  );
  const apiCenterDefinitionId = resolveStaticIndirection(
    pick(flat, 'apiCenterDefinitionId', 'API_CENTER_DEFINITION_ID', 'definitionId') ?? '',
    flat
  );
  const serviceName = resolveStaticIndirection(
    pick(flat, 'apimServiceName', 'API_MANAGEMENT_SERVICE_NAME', 'serviceName', 'SERVICE_NAME') ?? '',
    flat
  );
  const resourceGroup = resolveStaticIndirection(
    pick(flat, 'resourceGroup', 'RESOURCE_GROUP_NAME', 'resourceGroupName', 'AZURE_RESOURCE_GROUP') ?? '',
    flat
  );
  const subscriptionId = resolveStaticIndirection(
    pick(flat, 'subscriptionId', 'SUBSCRIPTION_ID', 'AZURE_SUBSCRIPTION_ID') ?? '',
    flat
  );
  const nativeSpecPath = resolveStaticIndirection(
    pick(
      flat,
      'API_SPECIFICATION_PATH',
      'specificationPath',
      'specPath',
      'openapiPath',
      'OPENAPI_PATH',
      'CONFIGURATION_YAML_PATH'
    ) ?? '',
    flat
  );
  const apiVersion = pick(flat, 'apiVersion', 'API_VERSION', 'version');
  const apiRevision = pick(flat, 'apiRevision', 'API_REVISION', 'revision');

  if (!apimApiId && !apiCenterDefinitionId && !serviceName && !nativeSpecPath && !resourceGroup) {
    return [];
  }

  const exact =
    (apimApiId && isFullApimApiId(apimApiId)) ||
    (apiCenterDefinitionId && isFullApiCenterDefinitionId(apiCenterDefinitionId));

  const binding: AzureResourceBinding = {
    class: exact ? 'exact-binding' : 'association-only',
    family: 'apiops',
    serviceName: serviceName || undefined,
    resourceGroup: resourceGroup || undefined,
    subscriptionId: subscriptionId || undefined,
    nativeSpecPath: nativeSpecPath || undefined,
    apiVersion: apiVersion || undefined,
    apiRevision: apiRevision || undefined,
    evidence: [
      {
        sourceFile: relativePath,
        note: `APIOps configuration ${sanitizeEvidenceValue(basename)}`
      }
    ]
  };

  if (apimApiId) {
    if (isFullApimApiId(apimApiId)) {
      const parsedId = parseApimApiArmId(apimApiId);
      binding.apimApiId = parsedId?.fullId ?? apimApiId;
      binding.serviceName = binding.serviceName ?? parsedId?.serviceName;
      binding.resourceGroup = binding.resourceGroup ?? parsedId?.resourceGroup;
      binding.subscriptionId = binding.subscriptionId ?? parsedId?.subscriptionId;
      binding.apiRevision = binding.apiRevision ?? parsedId?.revision;
    } else {
      binding.evidence.push({
        sourceFile: relativePath,
        field: 'apimApiId',
        note: 'APIOps APIM API name without full ARM ID is association-only'
      });
      binding.serviceName = binding.serviceName ?? apimApiId;
    }
  }

  if (apiCenterDefinitionId) {
    if (isFullApiCenterDefinitionId(apiCenterDefinitionId)) {
      const parsedId = parseApiCenterDefinitionArmId(apiCenterDefinitionId);
      binding.apiCenterDefinitionId = parsedId?.fullId ?? apiCenterDefinitionId;
      binding.apiVersion = binding.apiVersion ?? parsedId?.version;
    } else {
      binding.evidence.push({
        sourceFile: relativePath,
        field: 'apiCenterDefinitionId',
        note: 'APIOps API Center reference without full definition ARM ID is association-only'
      });
    }
  }

  return [binding];
}
