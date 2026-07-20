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

function pushIdBindings(
  relativePath: string,
  value: string,
  family: AzureResourceBinding['family'],
  bindings: AzureResourceBinding[]
): void {
  if (!value || isSecretValue(value)) return;
  const apim = parseApimApiArmId(value);
  if (apim && isFullApimApiId(value)) {
    bindings.push({
      class: 'exact-binding',
      family,
      apimApiId: apim.fullId,
      subscriptionId: apim.subscriptionId,
      resourceGroup: apim.resourceGroup,
      serviceName: apim.serviceName,
      apiRevision: apim.revision,
      evidence: [{ sourceFile: relativePath, note: 'exact APIM API ARM ID in Pulumi declaration' }]
    });
  }
  const center = parseApiCenterDefinitionArmId(value);
  if (center && isFullApiCenterDefinitionId(value)) {
    bindings.push({
      class: 'exact-binding',
      family,
      apiCenterDefinitionId: center.fullId,
      subscriptionId: center.subscriptionId,
      resourceGroup: center.resourceGroup,
      serviceName: center.serviceName,
      apiVersion: center.version,
      evidence: [{ sourceFile: relativePath, note: 'exact API Center definition ARM ID in Pulumi declaration' }]
    });
  }
}

/**
 * Parse Pulumi YAML program declarations. No state, no secrets provider execution.
 */
export function parsePulumiYaml(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  // Skip stack settings that primarily hold encrypted secrets.
  if ('encryptionsalt' in parsed || 'secretsprovider' in parsed) {
    return [];
  }

  const bindings: AzureResourceBinding[] = [];
  const localVars = { ...variables };
  const config = isRecord(parsed.config) ? parsed.config : {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretKey(key)) continue;
    if (isRecord(value) && 'secure' in value) continue;
    const text = asString(value);
    if (!text || isSecretValue(text)) continue;
    localVars[key] = text;
    const short = key.includes(':') ? key.split(':').pop()! : key;
    localVars[short] = text;
  }

  const resources = isRecord(parsed.resources) ? parsed.resources : {};
  for (const [logicalName, resourceValue] of Object.entries(resources)) {
    if (!isRecord(resourceValue)) continue;
    const type = asString(resourceValue.type) ?? '';
    const props = isRecord(resourceValue.properties) ? resourceValue.properties : {};
    const typeLower = type.toLowerCase();

    if (
      typeLower.includes('apimanagement') &&
      (typeLower.includes('api') || typeLower.endsWith('/api'))
    ) {
      const name = resolveStaticIndirection(asString(props.name) ?? '', localVars) ?? asString(props.name) ?? logicalName;
      const pathValue = asString(props.path);
      const serviceName =
        asString(props.apiManagementName) ??
        asString(props.apiManagementServiceName) ??
        asString(props.serviceName);
      const openapi =
        asString(props.openApiSpecification) ??
        asString(props.openapi) ??
        asString(props.specification) ??
        (isRecord(props.import) ? asString(props.import.value) ?? asString(props.import.contentValue) : undefined);

      const binding: AzureResourceBinding = {
        class: 'association-only',
        family: 'pulumi',
        serviceName: serviceName ?? name,
        gatewayBasePath: pathValue,
        evidence: [
          {
            sourceFile: relativePath,
            note: `Pulumi YAML APIM API ${sanitizeEvidenceValue(logicalName)}`
          }
        ]
      };
      if (openapi) {
        const resolved = resolveStaticIndirection(openapi, localVars) ?? openapi;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved)) {
          binding.nativeSpecUrl = resolved;
          binding.evidence.push({
            sourceFile: relativePath,
            note: 'Pulumi OpenAPI URL retained as evidence only (not fetched)'
          });
        } else {
          binding.nativeSpecPath = resolved;
        }
      }
      bindings.push(binding);
    }

    if (typeLower.includes('apicenter') && typeLower.includes('definition')) {
      bindings.push({
        class: 'association-only',
        family: 'pulumi',
        serviceName: asString(props.name) ?? logicalName,
        evidence: [
          {
            sourceFile: relativePath,
            note: `Pulumi YAML API Center definition ${sanitizeEvidenceValue(logicalName)}`
          }
        ]
      });
    }

    for (const value of Object.values(props)) {
      if (typeof value === 'string') {
        const resolved = resolveStaticIndirection(value, localVars) ?? value;
        pushIdBindings(relativePath, resolved, 'pulumi', bindings);
      }
    }
  }

  return bindings;
}

/**
 * Parse Pulumi TypeScript/Python/Go/C# source declarations via bounded regex.
 * No program execution.
 */
export function parsePulumiSource(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  const bindings: AzureResourceBinding[] = [];
  const localVars = { ...variables };

  // new apimanagement.Api("name", { ... }) or ApiManagementApi(...)
  const ctorRe =
    /(?:new\s+(?:[\w.]+)?(?:ApiManagement)?Api|apimanagement\.Api|azure\.apimanagement\.Api)\s*\(\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = ctorRe.exec(content)) !== null) {
    bindings.push({
      class: 'association-only',
      family: 'pulumi',
      serviceName: match[1],
      evidence: [
        {
          sourceFile: relativePath,
          note: `Pulumi source APIM API declaration ${sanitizeEvidenceValue(match[1]!)}`
        }
      ]
    });
  }

  const pathRe =
    /(?:openApiSpecification|openapi|specification|contentValue|specPath)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = pathRe.exec(content)) !== null) {
    const value = resolveStaticIndirection(match[1]!, localVars) ?? match[1]!;
    if (!value || isSecretValue(value)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      bindings.push({
        class: 'association-only',
        family: 'pulumi',
        nativeSpecUrl: value,
        evidence: [{ sourceFile: relativePath, note: 'Pulumi source OpenAPI URL evidence only (not fetched)' }]
      });
    } else {
      bindings.push({
        class: 'association-only',
        family: 'pulumi',
        nativeSpecPath: value,
        evidence: [{ sourceFile: relativePath, note: `Pulumi source local spec path ${sanitizeEvidenceValue(value)}` }]
      });
    }
  }

  for (const literal of content.match(/["'](?:\\.|[^"'\\])*["']/g) ?? []) {
    const value = literal.slice(1, -1);
    const resolved = resolveStaticIndirection(value, localVars) ?? value;
    pushIdBindings(relativePath, resolved, 'pulumi', bindings);
  }

  return bindings;
}
