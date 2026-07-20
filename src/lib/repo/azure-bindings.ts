import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { assertNoSymlinkEscape, resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';

const RESOURCES_REL = '.postman/resources.yaml';
const DEDICATED_REL = '.postman/azure-bindings.yaml';

export interface AzureResolverBinding {
  environment?: string;
  nativeSpecPath?: string;
  nativeSpecUrl?: string;
  apimApiId?: string;
  apiCenterDefinitionId?: string;
  gatewayId?: string;
  apiVersion?: string;
  apiRevision?: string;
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

function normalizeBindingObject(raw: RawBinding): Omit<AzureResolverBinding, 'source' | 'evidence'> {
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
    apiRevision: pickString(raw, ['apiRevision', 'api-revision'])
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
    apiRevision: binding.apiRevision ?? ''
  });
}

function hasAnyField(binding: Omit<AzureResolverBinding, 'source' | 'evidence'>): boolean {
  return Object.values(binding).some((value) => typeof value === 'string' && value.length > 0);
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
