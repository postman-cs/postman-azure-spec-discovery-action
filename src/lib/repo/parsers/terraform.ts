import type { AzureResourceBinding } from '../discovery-types.js';
import {
  isFullApiCenterDefinitionId,
  isFullApimApiId,
  parseApiCenterDefinitionArmId,
  parseApimApiArmId,
  resolveStaticIndirection
} from '../arm-ids.js';
import { isSecretKey, isSecretValue, sanitizeEvidenceValue } from '../secret-hygiene.js';

function extractHclBlocks(content: string, labels: string[]): Array<{ labels: string[]; body: string }> {
  const blocks: Array<{ labels: string[]; body: string }> = [];
  const labelAlt = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(
    `\\b(?:${labelAlt})\\s+((?:"[^"]+"\\s*)+)\\s*\\{`,
    'g'
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const labelRaw = match[1] ?? '';
    const parsedLabels = [...labelRaw.matchAll(/"([^"]+)"/g)].map((item) => item[1]!);
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < content.length && depth > 0) {
      const char = content[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    const body = content.slice(start, index - 1);
    blocks.push({ labels: parsedLabels, body });
  }
  return blocks;
}

function hclString(body: string, key: string): string | undefined {
  const quoted = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i');
  const quotedMatch = body.match(quoted);
  if (quotedMatch?.[1]?.trim()) return quotedMatch[1].trim();
  // Bare references: api_management_name = var.api_management_name
  const ref = new RegExp(`\\b${key}\\s*=\\s*(var\\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_.]*)`, 'i');
  const refMatch = body.match(ref);
  return refMatch?.[1]?.trim() || undefined;
}

function resolveTfValue(raw: string | undefined, variables: Record<string, string>): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (variables[trimmed]) return variables[trimmed];
  if (trimmed.startsWith('var.')) {
    const name = trimmed.slice(4);
    return variables[trimmed] ?? variables[name] ?? undefined;
  }
  return resolveStaticIndirection(trimmed, variables) ?? trimmed;
}

function hclNestedString(body: string, block: string, key: string): string | undefined {
  const blockRe = new RegExp(`\\b${block}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'i');
  const nested = body.match(blockRe)?.[1];
  if (!nested) return undefined;
  return hclString(nested, key);
}

function looksLikeSpecPath(value: string): boolean {
  return /\.(?:ya?ml|json|wsdl|wadl|xsd|graphql|gql|proto)$/i.test(value) ||
    /(?:openapi|swagger|asyncapi|api)\./i.test(value);
}

function bindingFromId(
  relativePath: string,
  value: string,
  family: AzureResourceBinding['family']
): AzureResourceBinding | undefined {
  if (!value || isSecretValue(value)) return undefined;
  const apim = parseApimApiArmId(value);
  if (apim && isFullApimApiId(value)) {
    return {
      class: 'exact-binding',
      family,
      apimApiId: apim.fullId,
      subscriptionId: apim.subscriptionId,
      resourceGroup: apim.resourceGroup,
      serviceName: apim.serviceName,
      apiRevision: apim.revision,
      evidence: [{ sourceFile: relativePath, note: 'exact APIM API ARM ID in Terraform source' }]
    };
  }
  const center = parseApiCenterDefinitionArmId(value);
  if (center && isFullApiCenterDefinitionId(value)) {
    return {
      class: 'exact-binding',
      family,
      apiCenterDefinitionId: center.fullId,
      subscriptionId: center.subscriptionId,
      resourceGroup: center.resourceGroup,
      serviceName: center.serviceName,
      apiVersion: center.version,
      evidence: [{ sourceFile: relativePath, note: 'exact API Center definition ARM ID in Terraform source' }]
    };
  }
  return undefined;
}

/**
 * Parse Terraform / AzAPI HCL source only. No state, no provider execution.
 */
export function parseTerraformHcl(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  const bindings: AzureResourceBinding[] = [];
  const localVars = { ...variables };

  for (const block of extractHclBlocks(content, ['variable'])) {
    const name = block.labels[0];
    if (!name || isSecretKey(name)) continue;
    const defaultValue = hclString(block.body, 'default');
    if (defaultValue && !isSecretValue(defaultValue)) {
      localVars[name] = defaultValue;
      localVars[`var.${name}`] = defaultValue;
    }
  }

  for (const block of extractHclBlocks(content, ['resource'])) {
    const resourceType = block.labels[0] ?? '';
    const resourceName = block.labels[1] ?? '';
    const body = block.body;

    if (resourceType === 'azurerm_api_management_api') {
      const name = resolveTfValue(hclString(body, 'name'), localVars);
      const serviceName = resolveTfValue(hclString(body, 'api_management_name'), localVars);
      const resourceGroup = resolveTfValue(hclString(body, 'resource_group_name'), localVars);
      const pathValue = resolveTfValue(hclString(body, 'path'), localVars);
      const revision = resolveTfValue(hclString(body, 'revision'), localVars);
      const openapi = resolveTfValue(
        hclNestedString(body, 'import', 'content_value') ?? hclString(body, 'source'),
        localVars
      );
      const contentFormat = hclNestedString(body, 'import', 'content_format') ?? '';

      const binding: AzureResourceBinding = {
        class: 'association-only',
        family: 'terraform',
        serviceName: serviceName ?? name,
        resourceGroup,
        gatewayBasePath: pathValue,
        apiRevision: revision,
        evidence: [
          {
            sourceFile: relativePath,
            note: `Terraform azurerm_api_management_api ${sanitizeEvidenceValue(resourceName)}`
          }
        ]
      };

      if (openapi) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(openapi)) {
          binding.nativeSpecUrl = openapi;
          binding.evidence.push({
            sourceFile: relativePath,
            field: 'import.content_value',
            note: 'Terraform OpenAPI URL retained as evidence only (not fetched)'
          });
        } else if (looksLikeSpecPath(openapi) || contentFormat.toLowerCase().includes('openapi')) {
          binding.nativeSpecPath = openapi;
        }
      }

      const subscriptionId =
        localVars.subscription_id ?? localVars.SUBSCRIPTION_ID ?? localVars.AZURE_SUBSCRIPTION_ID;
      if (
        subscriptionId &&
        resourceGroup &&
        serviceName &&
        name &&
        !/^var\./.test(serviceName) &&
        !/^var\./.test(name) &&
        !/^var\./.test(resourceGroup)
      ) {
        const fullId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/apis/${name}${revision ? `;rev=${revision}` : ''}`;
        if (isFullApimApiId(fullId)) {
          bindings.push({
            ...binding,
            class: 'exact-binding',
            apimApiId: fullId,
            subscriptionId,
            evidence: [
              ...binding.evidence,
              { sourceFile: relativePath, note: 'constructed exact APIM API ARM ID from Terraform locals/vars' }
            ]
          });
          continue;
        }
      }
      bindings.push(binding);
    }

    if (resourceType === 'azapi_resource') {
      const type = hclString(body, 'type') ?? '';
      const name = resolveStaticIndirection(hclString(body, 'name') ?? '', localVars) ?? hclString(body, 'name');
      const typeLower = type.toLowerCase();
      if (typeLower.includes('microsoft.apimanagement/service/apis')) {
        bindings.push({
          class: 'association-only',
          family: 'terraform',
          serviceName: name,
          evidence: [
            {
              sourceFile: relativePath,
              note: `AzAPI APIM API resource ${sanitizeEvidenceValue(name ?? resourceName)}`
            }
          ]
        });
      }
      if (typeLower.includes('microsoft.apicenter') && typeLower.includes('definition')) {
        bindings.push({
          class: 'association-only',
          family: 'terraform',
          serviceName: name,
          evidence: [
            {
              sourceFile: relativePath,
              note: `AzAPI API Center definition ${sanitizeEvidenceValue(name ?? resourceName)}`
            }
          ]
        });
      }
    }
  }

  for (const literal of content.match(/"(?:\\.|[^"\\])*"/g) ?? []) {
    const value = literal.slice(1, -1);
    const resolved = resolveStaticIndirection(value, localVars) ?? value;
    const fromId = bindingFromId(relativePath, resolved, 'terraform');
    if (fromId) bindings.push(fromId);
  }

  return bindings;
}

/**
 * Parse `.tfvars` / `.auto.tfvars` into a variable map. Secret keys/values omitted.
 */
export function parseTfvars(relativePath: string, content: string): Record<string, string> {
  void relativePath;
  const result: Record<string, string> = {};
  const re = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const key = match[1]!;
    const value = match[2]!;
    if (isSecretKey(key) || isSecretValue(value)) continue;
    result[key] = value;
    result[`var.${key}`] = value;
  }
  return result;
}
