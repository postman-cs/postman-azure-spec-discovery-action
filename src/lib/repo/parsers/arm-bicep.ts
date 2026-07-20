import type { AzureResourceBinding } from '../discovery-types.js';
import {
  isFullApiCenterDefinitionId,
  isFullApimApiId,
  parseApiCenterDefinitionArmId,
  parseApimApiArmId,
  parseDeploymentStackId,
  parseTemplateSpecId,
  resolveStaticIndirection
} from '../arm-ids.js';
import { isSecureArmParameter, isSecretKey, isSecretValue, sanitizeEvidenceValue } from '../secret-hygiene.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const APIM_API_TYPE = 'microsoft.apimanagement/service/apis';
const API_CENTER_DEF_TYPE = 'microsoft.apicenter/services/workspaces/apis/versions/definitions';

export interface ArmParseResult {
  bindings: AzureResourceBinding[];
  /** Inline OpenAPI/Swagger documents found in APIM `value` (not link formats). */
  inlineDocuments: Array<{ resourceName: string; format: string; value: unknown }>;
  linkReferences: Array<{ resourceName: string; format: string; link: string }>;
}

export function parseArmTemplateJson(relativePath: string, content: string, variables: Record<string, string> = {}): ArmParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { bindings: [], inlineDocuments: [], linkReferences: [] };
  }
  if (!isRecord(parsed)) return { bindings: [], inlineDocuments: [], linkReferences: [] };

  const localVars = { ...variables };
  const parameters = isRecord(parsed.parameters) ? parsed.parameters : {};
  for (const [name, definition] of Object.entries(parameters)) {
    if (isSecureArmParameter(name, definition)) continue;
    if (!isRecord(definition)) continue;
    const defaultValue = definition.defaultValue;
    if (typeof defaultValue === 'string' && defaultValue.trim() && !isSecretValue(defaultValue)) {
      localVars[name] = defaultValue.trim();
      localVars[`parameters('${name}')`] = defaultValue.trim();
    }
  }

  const bindings: AzureResourceBinding[] = [];
  const inlineDocuments: ArmParseResult['inlineDocuments'] = [];
  const linkReferences: ArmParseResult['linkReferences'] = [];

  const walk = (resource: Record<string, unknown>, typeChain: string[]): void => {
    const type = asString(resource.type) ?? '';
    const name = asString(resource.name) ?? '';
    const fullType = [...typeChain, type].filter(Boolean).join('/');
    const fullTypeLower = fullType.toLowerCase();
    const properties = isRecord(resource.properties) ? resource.properties : {};

    if (fullTypeLower === APIM_API_TYPE || type.toLowerCase() === APIM_API_TYPE) {
      const format = (asString(properties.format) ?? '').toLowerCase();
      const value = properties.value;
      const pathValue = asString(properties.path);
      const apiVersion = asString(properties.apiVersion) ?? asString(properties.version);
      const apiRevision = asString(properties.apiRevision) ?? asString(properties.revision);

      if (format.includes('link')) {
        const link = typeof value === 'string' ? value : asString(properties.link) ?? '';
        if (link) {
          linkReferences.push({ resourceName: name || 'apim-api', format, link });
          bindings.push({
            class: 'association-only',
            family: 'arm',
            serviceName: name.split('/')[0],
            nativeSpecUrl: /^[a-z]+:\/\//i.test(link) ? link : undefined,
            nativeSpecPath: /^[a-z]+:\/\//i.test(link) ? undefined : link,
            gatewayBasePath: pathValue,
            apiVersion,
            apiRevision,
            evidence: [
              {
                sourceFile: relativePath,
                field: 'properties.format',
                note: `APIM ${format} import retained as evidence only (not fetched)`
              }
            ]
          });
        }
      } else if ((format.includes('openapi') || format.includes('swagger')) && value !== undefined) {
        inlineDocuments.push({ resourceName: name || 'apim-api', format, value });
        bindings.push({
          class: 'association-only',
          family: 'apim-inline',
          serviceName: name.split('/')[0],
          gatewayBasePath: pathValue,
          apiVersion,
          apiRevision,
          evidence: [
            {
              sourceFile: relativePath,
              field: 'properties.value',
              note: `Inline APIM specification embedded for ${sanitizeEvidenceValue(name || 'apim-api')}`
            }
          ]
        });
      }

      // Constructable exact ID only when subscription/RG are statically known in variables.
      const subscriptionId = localVars.subscriptionId ?? localVars.SUBSCRIPTION_ID ?? localVars.AZURE_SUBSCRIPTION_ID;
      const resourceGroup = localVars.resourceGroupName ?? localVars.resourceGroup ?? localVars.AZURE_RESOURCE_GROUP;
      const service = name.includes('/') ? name.split('/')[0] : localVars.apimServiceName;
      const apiName = name.includes('/') ? name.split('/')[1] : name;
      if (subscriptionId && resourceGroup && service && apiName && !/[()[\]]/.test(`${service}${apiName}`)) {
        const fullId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${service}/apis/${apiName}${apiRevision ? `;rev=${apiRevision}` : ''}`;
        if (isFullApimApiId(fullId)) {
          bindings.push({
            class: 'exact-binding',
            family: 'arm',
            apimApiId: fullId,
            subscriptionId,
            resourceGroup,
            serviceName: service,
            apiRevision,
            apiVersion,
            gatewayBasePath: pathValue,
            evidence: [{ sourceFile: relativePath, note: `constructed exact APIM API ARM ID from ${relativePath}` }]
          });
        }
      }
    }

    if (fullTypeLower.endsWith(API_CENTER_DEF_TYPE) || type.toLowerCase().includes('apicenter') && type.toLowerCase().includes('definition')) {
      const subscriptionId = localVars.subscriptionId ?? localVars.SUBSCRIPTION_ID;
      const resourceGroup = localVars.resourceGroupName ?? localVars.resourceGroup;
      // Name may be service/workspace/api/version/definition
      const parts = name.split('/');
      if (subscriptionId && resourceGroup && parts.length >= 5) {
        const [serviceName, workspace, apiName, version, definitionName] = parts;
        const fullId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiCenter/services/${serviceName}/workspaces/${workspace}/apis/${apiName}/versions/${version}/definitions/${definitionName}`;
        if (isFullApiCenterDefinitionId(fullId)) {
          bindings.push({
            class: 'exact-binding',
            family: 'api-center',
            apiCenterDefinitionId: fullId,
            subscriptionId,
            resourceGroup,
            serviceName,
            apiVersion: version,
            evidence: [{ sourceFile: relativePath, note: `API Center definition resource in ${relativePath}` }]
          });
        }
      } else {
        bindings.push({
          class: 'association-only',
          family: 'api-center',
          serviceName: parts[0],
          apiVersion: parts[3],
          evidence: [{ sourceFile: relativePath, note: 'API Center definition resource missing static subscription/resource group' }]
        });
      }
    }

    // Scan string properties for full ARM IDs (never retain secure parameter values).
    for (const [key, value] of Object.entries({ ...resource, ...properties })) {
      if (isSecretKey(key)) continue;
      if (typeof value !== 'string') continue;
      if (isSecretValue(value)) continue;
      const resolved = resolveStaticIndirection(value, localVars) ?? value;
      const apim = parseApimApiArmId(resolved);
      if (apim && isFullApimApiId(resolved)) {
        bindings.push({
          class: 'exact-binding',
          family: 'arm',
          apimApiId: apim.fullId,
          subscriptionId: apim.subscriptionId,
          resourceGroup: apim.resourceGroup,
          serviceName: apim.serviceName,
          apiRevision: apim.revision,
          evidence: [{ sourceFile: relativePath, field: key, note: 'exact APIM API ARM ID reference' }]
        });
      }
      const center = parseApiCenterDefinitionArmId(resolved);
      if (center) {
        bindings.push({
          class: 'exact-binding',
          family: 'api-center',
          apiCenterDefinitionId: center.fullId,
          subscriptionId: center.subscriptionId,
          resourceGroup: center.resourceGroup,
          serviceName: center.serviceName,
          apiVersion: center.version,
          evidence: [{ sourceFile: relativePath, field: key, note: 'exact API Center definition ARM ID reference' }]
        });
      }
      const templateSpec = parseTemplateSpecId(resolved);
      if (templateSpec) {
        bindings.push({
          class: 'exact-binding',
          family: 'deployment-artifact',
          templateSpecId: templateSpec.fullId,
          evidence: [{ sourceFile: relativePath, field: key, note: `Template Spec ID ${templateSpec.name}` }]
        });
      }
      const stack = parseDeploymentStackId(resolved);
      if (stack) {
        bindings.push({
          class: 'exact-binding',
          family: 'deployment-artifact',
          deploymentStackId: stack.fullId,
          evidence: [{ sourceFile: relativePath, field: key, note: `Deployment stack ID ${stack.name}` }]
        });
      }
    }

    const nested = resource.resources;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        if (isRecord(child)) walk(child, [...typeChain, type]);
      }
    }
  };

  const resources = parsed.resources;
  if (Array.isArray(resources)) {
    for (const resource of resources) {
      if (isRecord(resource)) walk(resource, []);
    }
  }

  // Outputs (non-secure)
  const outputs = parsed.outputs;
  if (isRecord(outputs)) {
    for (const [outName, outDef] of Object.entries(outputs)) {
      if (isSecretKey(outName) || !isRecord(outDef)) continue;
      if (outDef.type === 'secureString' || outDef.type === 'secureObject') continue;
      const value = outDef.value;
      if (typeof value !== 'string' || isSecretValue(value)) continue;
      const resolved = resolveStaticIndirection(value, localVars) ?? value;
      const apim = parseApimApiArmId(resolved);
      if (apim && isFullApimApiId(resolved)) {
        bindings.push({
          class: 'exact-binding',
          family: 'deployment-artifact',
          apimApiId: apim.fullId,
          subscriptionId: apim.subscriptionId,
          resourceGroup: apim.resourceGroup,
          serviceName: apim.serviceName,
          evidence: [{ sourceFile: relativePath, field: `outputs.${outName}`, note: 'deployment output APIM API ID' }]
        });
      }
      const center = parseApiCenterDefinitionArmId(resolved);
      if (center) {
        bindings.push({
          class: 'exact-binding',
          family: 'deployment-artifact',
          apiCenterDefinitionId: center.fullId,
          evidence: [{ sourceFile: relativePath, field: `outputs.${outName}`, note: 'deployment output API Center definition ID' }]
        });
      }
      const templateSpec = parseTemplateSpecId(resolved);
      if (templateSpec) {
        bindings.push({
          class: 'exact-binding',
          family: 'deployment-artifact',
          templateSpecId: templateSpec.fullId,
          evidence: [{ sourceFile: relativePath, field: `outputs.${outName}`, note: 'deployment output Template Spec ID' }]
        });
      }
    }
  }

  return { bindings, inlineDocuments, linkReferences };
}

/**
 * Pure bounded Bicep source parser (no compilation, no AZ CLI).
 * Extracts resource types/names, @secure() params (skipped), and string literals containing ARM IDs / spec paths.
 */
export function parseBicepSource(relativePath: string, content: string, variables: Record<string, string> = {}): AzureResourceBinding[] {
  const bindings: AzureResourceBinding[] = [];
  const localVars = { ...variables };

  // param defaults (skip @secure)
  const paramRe = /(?:@secure\(\)\s*)?param\s+([A-Za-z_]\w*)\s+\w+(?:\s*=\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"))?/g;
  let match: RegExpExecArray | null;
  const secureParams = new Set<string>();
  const secureParamRe = /@secure\(\)\s*param\s+([A-Za-z_]\w*)/g;
  while ((match = secureParamRe.exec(content)) !== null) {
    secureParams.add(match[1]!);
  }
  while ((match = paramRe.exec(content)) !== null) {
    const name = match[1]!;
    if (secureParams.has(name) || isSecretKey(name)) continue;
    const rawDefault = match[2];
    if (!rawDefault) continue;
    const value = rawDefault.slice(1, -1);
    if (!value || isSecretValue(value)) continue;
    localVars[name] = value;
  }

  // resource symbolicName 'type@version' = { name: '...'
  const resourceRe =
    /resource\s+([A-Za-z_]\w*)\s+'([^'@]+)@[^']+'\s*=\s*\{([\s\S]*?)\n\}/g;
  while ((match = resourceRe.exec(content)) !== null) {
    const type = match[2]!;
    const body = match[3] ?? '';
    const nameMatch = body.match(/\bname:\s*'([^']+)'/);
    const name = nameMatch?.[1] ?? match[1]!;
    const typeLower = type.toLowerCase();

    if (typeLower === 'microsoft.apimanagement/service/apis') {
      const formatMatch = body.match(/\bformat:\s*'([^']+)'/i);
      const format = (formatMatch?.[1] ?? '').toLowerCase();
      const pathMatch = body.match(/\bpath:\s*'([^']+)'/);
      const valueLink = body.match(/\bvalue:\s*'([^']+)'/);
      if (format.includes('link') && valueLink?.[1]) {
        const link = valueLink[1];
        bindings.push({
          class: 'association-only',
          family: 'bicep',
          serviceName: name.split('/')[0],
          nativeSpecUrl: /^[a-z]+:\/\//i.test(link) ? link : undefined,
          nativeSpecPath: /^[a-z]+:\/\//i.test(link) ? undefined : link,
          gatewayBasePath: pathMatch?.[1],
          evidence: [{ sourceFile: relativePath, note: `Bicep APIM ${format} import evidence only (not fetched)` }]
        });
      } else {
        bindings.push({
          class: 'association-only',
          family: 'bicep',
          serviceName: name.split('/')[0],
          gatewayBasePath: pathMatch?.[1],
          evidence: [{ sourceFile: relativePath, note: `Bicep APIM API resource ${sanitizeEvidenceValue(name)}` }]
        });
      }
    }

    if (typeLower.includes('microsoft.apicenter') && typeLower.includes('definition')) {
      bindings.push({
        class: 'association-only',
        family: 'bicep',
        serviceName: name.split('/')[0],
        evidence: [{ sourceFile: relativePath, note: `Bicep API Center definition resource ${sanitizeEvidenceValue(name)}` }]
      });
    }
  }

  // Literal ARM IDs in source
  for (const literal of content.match(/'(?:\\'|[^'])*'/g) ?? []) {
    const value = literal.slice(1, -1);
    if (!value || isSecretValue(value)) continue;
    const resolved = resolveStaticIndirection(value, localVars) ?? value;
    const apim = parseApimApiArmId(resolved);
    if (apim && isFullApimApiId(resolved)) {
      bindings.push({
        class: 'exact-binding',
        family: 'bicep',
        apimApiId: apim.fullId,
        subscriptionId: apim.subscriptionId,
        resourceGroup: apim.resourceGroup,
        serviceName: apim.serviceName,
        apiRevision: apim.revision,
        evidence: [{ sourceFile: relativePath, note: 'exact APIM API ARM ID in Bicep source' }]
      });
    }
    const center = parseApiCenterDefinitionArmId(resolved);
    if (center) {
      bindings.push({
        class: 'exact-binding',
        family: 'bicep',
        apiCenterDefinitionId: center.fullId,
        subscriptionId: center.subscriptionId,
        resourceGroup: center.resourceGroup,
        serviceName: center.serviceName,
        apiVersion: center.version,
        evidence: [{ sourceFile: relativePath, note: 'exact API Center definition ARM ID in Bicep source' }]
      });
    }
  }

  return bindings;
}
