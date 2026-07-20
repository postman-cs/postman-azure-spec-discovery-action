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

interface SourceControlHit {
  repoUrl?: string;
  branch?: string;
  resourceId?: string;
  serviceName?: string;
  field: string;
}

function collectHits(value: unknown, field: string, hits: SourceControlHit[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectHits(entry, `${field}[${index}]`, hits));
    return;
  }
  if (!isRecord(value)) return;

  const type = (asString(value.type) ?? '').toLowerCase();
  const props = isRecord(value.properties) ? value.properties : value;
  const siteConfig = isRecord(props.siteConfig) ? props.siteConfig : undefined;
  const sourceControl =
    isRecord(props.sourceControl) ? props.sourceControl :
    isRecord(value.sourceControl) ? value.sourceControl :
    isRecord(siteConfig?.scmType) ? props :
    undefined;

  const repoUrl =
    asString(props.repoUrl) ??
    asString(props.repositoryUrl) ??
    asString(sourceControl && isRecord(sourceControl) ? sourceControl.repoUrl : undefined) ??
    asString(sourceControl && isRecord(sourceControl) ? sourceControl.repositoryUrl : undefined) ??
    asString(isRecord(props.githubActionConfiguration) ? asString((props.githubActionConfiguration as Record<string, unknown>).repositoryUrl ?? (props.githubActionConfiguration as Record<string, unknown>).repoUrl) : undefined);

  const branch =
    asString(props.branch) ??
    asString(sourceControl && isRecord(sourceControl) ? sourceControl.branch : undefined) ??
    asString(isRecord(props.githubActionConfiguration) ? asString((props.githubActionConfiguration as Record<string, unknown>).branch) : undefined);

  const hasSourceControlShape =
    Boolean(repoUrl) ||
    Boolean(branch) ||
    Boolean(asString(props.scmType)) ||
    Boolean(siteConfig && asString(siteConfig.scmType)) ||
    type.includes('microsoft.web/sites/sourcecontrols') ||
    type.includes('microsoft.app/containerapps') && Boolean(isRecord(props.configuration));

  // Container Apps configuration.sourceControl
  const configuration = isRecord(props.configuration) ? props.configuration : undefined;
  const caSource = configuration && isRecord(configuration.sourceControl) ? configuration.sourceControl : undefined;
  const caRepo =
    repoUrl ??
    asString(caSource?.repoUrl) ??
    asString(caSource?.repositoryUrl);
  const caBranch = branch ?? asString(caSource?.branch);

  if (hasSourceControlShape || caRepo || caBranch) {
    // githubActionSecret / credentials must never appear in evidence values.
    if (caSource && isRecord(caSource) && ('githubActionSecret' in caSource || 'credentials' in caSource)) {
      hits.push({
        repoUrl: caRepo,
        branch: caBranch,
        serviceName: asString(value.name) ?? asString(props.name),
        resourceId: asString(value.id),
        field: `${field}.configuration.sourceControl`
      });
    } else {
      hits.push({
        repoUrl: caRepo ?? repoUrl,
        branch: caBranch ?? branch,
        serviceName: asString(value.name) ?? asString(props.name),
        resourceId: asString(value.id),
        field: field || 'sourceControl'
      });
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    if (typeof child === 'string' && isSecretValue(child)) continue;
    collectHits(child, field ? `${field}.${key}` : key, hits);
  }
}

/**
 * Parse App Service / Container Apps source-control declaration fields from repo/IaC.
 * Source-control linkage is association-only unless a full deployed resource ID is also present.
 */
export function parseSourceControlDeclaration(
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

  const hits: SourceControlHit[] = [];
  collectHits(parsed, '', hits);
  if (hits.length === 0) return [];

  const bindings: AzureResourceBinding[] = [];
  for (const hit of hits) {
    const repoUrl = hit.repoUrl ? resolveStaticIndirection(hit.repoUrl, variables) ?? hit.repoUrl : undefined;
    const branch = hit.branch ? resolveStaticIndirection(hit.branch, variables) ?? hit.branch : undefined;
    if (repoUrl && isSecretValue(repoUrl)) continue;

    const resourceId = hit.resourceId ? resolveStaticIndirection(hit.resourceId, variables) ?? hit.resourceId : undefined;
    const exactApim = resourceId && isFullApimApiId(resourceId) ? parseApimApiArmId(resourceId) : undefined;
    const exactCenter =
      resourceId && isFullApiCenterDefinitionId(resourceId) ? parseApiCenterDefinitionArmId(resourceId) : undefined;

    const binding: AzureResourceBinding = {
      class: exactApim || exactCenter ? 'exact-binding' : 'association-only',
      family: 'source-control',
      serviceName: hit.serviceName,
      sourceControlRepoUrl: repoUrl && !isSecretValue(repoUrl) ? repoUrl : undefined,
      sourceControlBranch: branch && !isSecretValue(branch) ? branch : undefined,
      evidence: [
        {
          sourceFile: relativePath,
          field: hit.field,
          note: `source-control declaration${repoUrl ? ` repo ${sanitizeEvidenceValue(repoUrl)}` : ''}${branch ? ` branch ${sanitizeEvidenceValue(branch)}` : ''} (association unless full deployed ID present)`
        }
      ]
    };

    if (exactApim) {
      binding.apimApiId = exactApim.fullId;
      binding.subscriptionId = exactApim.subscriptionId;
      binding.resourceGroup = exactApim.resourceGroup;
      binding.serviceName = binding.serviceName ?? exactApim.serviceName;
    }
    if (exactCenter) {
      binding.apiCenterDefinitionId = exactCenter.fullId;
      binding.subscriptionId = exactCenter.subscriptionId;
      binding.resourceGroup = exactCenter.resourceGroup;
      binding.serviceName = binding.serviceName ?? exactCenter.serviceName;
      binding.apiVersion = exactCenter.version;
    }

    if (binding.sourceControlRepoUrl || binding.sourceControlBranch || binding.apimApiId || binding.apiCenterDefinitionId) {
      bindings.push(binding);
    }
  }

  return bindings;
}
