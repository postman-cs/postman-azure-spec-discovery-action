import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { RuntimeDeclaredSpecTarget, RuntimeDeclaredWorkloadKind } from '../providers/runtime-declared-routes.js';
import { assertNoSymlinkEscape, resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';

const RESOURCES_REL = '.postman/resources.yaml';
const DEDICATED_REL = '.postman/azure-bindings.yaml';

const RUNTIME_WORKLOAD_KINDS = new Set<RuntimeDeclaredWorkloadKind>([
  'app-service',
  'functions',
  'container-apps',
  'static-web-apps',
  'aci',
  'aks'
]);

export interface AzureResolverBinding {
  environment?: string;
  nativeSpecPath?: string;
  nativeSpecUrl?: string;
  apimApiId?: string;
  apiCenterDefinitionId?: string;
  gatewayId?: string;
  apiVersion?: string;
  apiRevision?: string;
  /**
   * Committed absolute Functions OpenAPI extension path (must start with `/`).
   * Passed to FunctionBindingsProvider only when enable-functions-openapi-extension
   * is true. Not an action/secret input.
   */
  functionsOpenApiPath?: string;
  /**
   * Committed runtime-declared HTTPS specification targets. Caller JSON alone
   * is never authoritative; runtime must corroborate against this seam or an
   * authorized ARM association URL.
   */
  runtimeDeclaredSpecTargets?: RuntimeDeclaredSpecTarget[];
  source: 'resources.yaml' | 'azure-bindings.yaml';
  evidence: string[];
}

export type AzureBindingLoadResult =
  | { status: 'absent' }
  | { status: 'ok'; binding: AzureResolverBinding }
  | { status: 'error'; reason: string };

type RawBinding = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(raw: RawBinding, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function extractAzureSeams(document: unknown): unknown[] {
  if (!isRecord(document)) return [];
  const seams: unknown[] = [];
  if (document.azure !== undefined) seams.push(document.azure);
  if (isRecord(document.cloudResources) && document.cloudResources.azure !== undefined) {
    seams.push(document.cloudResources.azure);
  }
  if (document.azureResolver !== undefined) seams.push(document.azureResolver);
  return seams;
}

function parseRuntimeDeclaredTargetsFromBinding(
  raw: RawBinding
): RuntimeDeclaredSpecTarget[] | { error: string } {
  const value =
    raw.runtimeDeclaredSpecTargets ??
    raw['runtime-declared-spec-targets'] ??
    raw.runtimeDeclaredTargets ??
    raw['runtime-declared-targets'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return { error: 'runtimeDeclaredSpecTargets must be an array of target mappings' };
  }
  const targets: RuntimeDeclaredSpecTarget[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry)) {
      return { error: `runtimeDeclaredSpecTargets[${index}] must be a mapping` };
    }
    const id = pickString(entry, ['id']);
    const name = pickString(entry, ['name']);
    const url = pickString(entry, ['url']);
    const workloadKind = pickString(entry, ['workloadKind', 'workload-kind']);
    if (!id || !name || !url || !workloadKind) {
      return {
        error: `runtimeDeclaredSpecTargets[${index}] requires id, name, workloadKind, and url`
      };
    }
    if (!RUNTIME_WORKLOAD_KINDS.has(workloadKind as RuntimeDeclaredWorkloadKind)) {
      return {
        error: `runtimeDeclaredSpecTargets[${index}] has unsupported workloadKind`
      };
    }
    targets.push({
      id,
      name,
      url,
      workloadKind: workloadKind as RuntimeDeclaredWorkloadKind,
      ...(pickString(entry, ['resourceId', 'resource-id'])
        ? { resourceId: pickString(entry, ['resourceId', 'resource-id']) }
        : {}),
      ...(pickString(entry, ['resourceGroup', 'resource-group'])
        ? { resourceGroup: pickString(entry, ['resourceGroup', 'resource-group']) }
        : {}),
      ...(pickString(entry, ['providerResourceType', 'provider-resource-type'])
        ? {
            providerResourceType: pickString(entry, ['providerResourceType', 'provider-resource-type'])
          }
        : {}),
      evidence: [`Committed runtime-declared target from .postman binding`]
    });
  }
  return targets;
}

function normalizeBindingObject(
  raw: RawBinding
): Omit<AzureResolverBinding, 'source' | 'evidence'> | { error: string } {
  const runtimeDeclaredSpecTargets = parseRuntimeDeclaredTargetsFromBinding(raw);
  if ('error' in runtimeDeclaredSpecTargets) return runtimeDeclaredSpecTargets;
  const functionsOpenApiPath = pickString(raw, [
    'functionsOpenApiPath',
    'functions-openapi-path',
    'functionsOpenApi',
    'functions-openapi'
  ]);
  if (functionsOpenApiPath !== undefined && !functionsOpenApiPath.startsWith('/')) {
    return {
      error: 'functionsOpenApiPath must be an absolute path starting with /'
    };
  }
  return {
    environment: pickString(raw, ['environment', 'env']),
    nativeSpecPath: pickString(raw, ['nativeSpecPath', 'native-spec-path', 'specPath', 'spec-path']),
    nativeSpecUrl: pickString(raw, ['nativeSpecUrl', 'native-spec-url', 'specUrl', 'spec-url']),
    apimApiId: pickString(raw, ['apimApiId', 'apim-api-id', 'apiId', 'api-id', 'apimApiArmId', 'apim-api-arm-id']),
    apiCenterDefinitionId: pickString(raw, [
      'apiCenterDefinitionId',
      'api-center-definition-id',
      'apiCenterDefinitionArmId',
      'api-center-definition-arm-id'
    ]),
    gatewayId: pickString(raw, ['gatewayId', 'gateway-id']),
    apiVersion: pickString(raw, ['apiVersion', 'api-version']),
    apiRevision: pickString(raw, ['apiRevision', 'api-revision']),
    ...(functionsOpenApiPath ? { functionsOpenApiPath } : {}),
    ...(runtimeDeclaredSpecTargets.length > 0 ? { runtimeDeclaredSpecTargets } : {})
  };
}

function bindingFingerprint(binding: Omit<AzureResolverBinding, 'source' | 'evidence'>): string {
  return JSON.stringify({
    environment: binding.environment ?? '',
    nativeSpecPath: binding.nativeSpecPath ?? '',
    nativeSpecUrl: binding.nativeSpecUrl ?? '',
    apimApiId: binding.apimApiId ?? '',
    apiCenterDefinitionId: binding.apiCenterDefinitionId ?? '',
    gatewayId: binding.gatewayId ?? '',
    apiVersion: binding.apiVersion ?? '',
    apiRevision: binding.apiRevision ?? '',
    functionsOpenApiPath: binding.functionsOpenApiPath ?? '',
    runtimeDeclaredSpecTargets: (binding.runtimeDeclaredSpecTargets ?? []).map((target) => ({
      id: target.id,
      url: target.url,
      workloadKind: target.workloadKind
    }))
  });
}

function hasAnyField(binding: Omit<AzureResolverBinding, 'source' | 'evidence'>): boolean {
  if ((binding.runtimeDeclaredSpecTargets?.length ?? 0) > 0) return true;
  return Object.entries(binding).some(
    ([key, value]) =>
      key !== 'runtimeDeclaredSpecTargets' && typeof value === 'string' && value.length > 0
  );
}

function coerceBindingList(seam: unknown): RawBinding[] | { error: string } {
  if (seam === undefined || seam === null) return [];
  if (Array.isArray(seam)) {
    const objects: RawBinding[] = [];
    for (const entry of seam) {
      if (!isRecord(entry)) {
        return { error: 'Azure resolver binding array entries must be mappings' };
      }
      objects.push(entry);
    }
    return objects;
  }
  if (isRecord(seam)) return [seam];
  return { error: 'Azure resolver binding must be a mapping or an array of mappings' };
}

async function validateNativeSpecPath(repoRoot: string, nativeSpecPath: string): Promise<string | undefined> {
  try {
    resolvePathWithinRoot(repoRoot, nativeSpecPath, 'nativeSpecPath');
    await assertNoSymlinkEscape(repoRoot, nativeSpecPath, 'nativeSpecPath');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

async function parseBindingDocument(
  repoRoot: string,
  relativePath: string,
  source: AzureResolverBinding['source'],
  content: string
): Promise<AzureBindingLoadResult> {
  let document: unknown;
  try {
    document = parseYaml(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'error', reason: `${relativePath} is not parseable YAML (${detail})` };
  }

  const seams =
    source === 'resources.yaml' ? extractAzureSeams(document) : isRecord(document) ? [document] : [];
  if (seams.length === 0) return { status: 'absent' };

  const normalized: Array<Omit<AzureResolverBinding, 'source' | 'evidence'>> = [];
  for (const seam of seams) {
    const list = coerceBindingList(seam);
    if ('error' in list) return { status: 'error', reason: list.error };
    for (const raw of list) {
      const binding = normalizeBindingObject(raw);
      if ('error' in binding) return { status: 'error', reason: binding.error };
      if (hasAnyField(binding)) normalized.push(binding);
    }
  }
  if (normalized.length === 0) return { status: 'absent' };

  const unique = new Map<string, Omit<AzureResolverBinding, 'source' | 'evidence'>>();
  for (const binding of normalized) {
    unique.set(bindingFingerprint(binding), binding);
  }
  if (unique.size > 1) {
    return {
      status: 'error',
      reason: `Conflicting Azure resolver bindings in ${relativePath}; refusing to choose among ${unique.size} distinct bindings`
    };
  }

  const binding = [...unique.values()][0]!;
  if (binding.nativeSpecPath) {
    const pathError = await validateNativeSpecPath(repoRoot, binding.nativeSpecPath);
    if (pathError) return { status: 'error', reason: pathError };
  }
  if (binding.gatewayId && binding.gatewayId.trim().toLowerCase() === 'managed') {
    return {
      status: 'error',
      reason: 'gatewayId "managed" is not a self-hosted gateway identity; omit it or supply a real gateway id'
    };
  }

  return {
    status: 'ok',
    binding: {
      ...binding,
      source,
      evidence: [`Loaded exact Azure resolver binding from ${relativePath}`]
    }
  };
}

async function readIfPresent(repoRoot: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.join(repoRoot, relativePath);
  try {
    await access(absolute, constants.R_OK);
  } catch {
    return undefined;
  }
  // Confine + reject symlink escape for the state file itself.
  await assertNoSymlinkEscape(repoRoot, relativePath, relativePath);
  return readFile(absolute, 'utf8');
}

/**
 * Load an exact Azure resolver binding.
 * Prefer a compatible seam in `.postman/resources.yaml`; only read the dedicated
 * `.postman/azure-bindings.yaml` when that seam is absent.
 */
export async function loadAzureResolverBinding(repoRoot: string): Promise<AzureBindingLoadResult> {
  try {
    const resourcesContent = await readIfPresent(repoRoot, RESOURCES_REL);
    if (resourcesContent !== undefined) {
      const fromResources = await parseBindingDocument(repoRoot, RESOURCES_REL, 'resources.yaml', resourcesContent);
      if (fromResources.status !== 'absent') return fromResources;
    }

    const dedicatedContent = await readIfPresent(repoRoot, DEDICATED_REL);
    if (dedicatedContent === undefined) return { status: 'absent' };
    return parseBindingDocument(repoRoot, DEDICATED_REL, 'azure-bindings.yaml', dedicatedContent);
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}
