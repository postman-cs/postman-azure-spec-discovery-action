import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate } from '../providers/types.js';

const MAX_SCAN_FILES = 200;
const MAX_SCAN_DEPTH = 6;
const APIM_API_TYPE = 'microsoft.apimanagement/service/apis';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

export interface IacFingerprint {
  resourceIds: string[];
  serviceNames: string[];
  resourceGroups: string[];
  evidence: string[];
}

export interface IacScanResult {
  candidates: SpecCandidate[];
  fingerprint: IacFingerprint;
}

interface ArmResource {
  type?: unknown;
  name?: unknown;
  properties?: { value?: unknown; format?: unknown; [k: string]: unknown };
  resources?: unknown;
  [k: string]: unknown;
}

/**
 * Scan repo-local Azure IaC (ARM/compiled-Bicep JSON and azure.yaml) for inline APIM
 * OpenAPI documents and correlation fingerprints.
 *
 * Confinement: rooted at repoRoot, at most depth 6 and 200 candidate files in stable
 * lexical order; skips .git/node_modules/dist and the configured output dir; skips
 * symlinks whose realpath escapes the root. No network, no process execution.
 */
export async function scanAzureIac(repoRoot: string, outputDir: string): Promise<IacScanResult> {
  const resolvedRoot = await realpath(path.resolve(repoRoot)).catch(() => path.resolve(repoRoot));
  const outputDirName = path.basename(outputDir);
  const files = await collectIacFiles(resolvedRoot, resolvedRoot, outputDirName);

  const candidates: SpecCandidate[] = [];
  const fingerprint: IacFingerprint = { resourceIds: [], serviceNames: [], resourceGroups: [], evidence: [] };

  for (const relativePath of files) {
    const absolutePath = path.join(resolvedRoot, relativePath);
    const content = await readFile(absolutePath, 'utf8').catch(() => undefined);
    if (!content) continue;

    if (relativePath.endsWith('.json')) {
      inspectArmTemplate(relativePath, content, candidates, fingerprint);
    } else if (path.basename(relativePath) === 'azure.yaml' || path.basename(relativePath) === 'azure.yml') {
      await inspectAzureYaml(resolvedRoot, relativePath, content, candidates, fingerprint);
    }
  }

  return { candidates, fingerprint };
}

async function collectIacFiles(root: string, current: string, outputDirName: string, depth = 0, count = { value: 0 }): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || count.value >= MAX_SCAN_FILES) return [];
  const results: string[] = [];
  const entries = (await readdir(current).catch(() => [] as string[])).sort();
  for (const entry of entries) {
    if (count.value >= MAX_SCAN_FILES) break;
    if (SKIP_DIRS.has(entry) || entry === outputDirName) continue;
    const fullPath = path.join(current, entry);
    const link = await lstat(fullPath).catch(() => undefined);
    if (!link) continue;
    if (link.isSymbolicLink()) {
      const real = await realpath(fullPath).catch(() => undefined);
      if (!real || !(real === root || real.startsWith(root + path.sep))) continue;
      continue; // symlinks are not traversed even when confined; identity stays with the real file
    }
    if (link.isDirectory()) {
      results.push(...(await collectIacFiles(root, fullPath, outputDirName, depth + 1, count)));
      continue;
    }
    if (!link.isFile()) continue;
    const isJson = entry.endsWith('.json');
    const isAzureYaml = entry === 'azure.yaml' || entry === 'azure.yml';
    if (!isJson && !isAzureYaml) continue;
    count.value += 1;
    results.push(path.relative(root, fullPath).split(path.sep).join('/'));
  }
  return results;
}

function inspectArmTemplate(
  relativePath: string,
  content: string,
  candidates: SpecCandidate[],
  fingerprint: IacFingerprint
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const resources = (parsed as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) return;

  const walk = (resource: ArmResource, chain: string[]): void => {
    const type = typeof resource.type === 'string' ? resource.type : '';
    const name = typeof resource.name === 'string' ? resource.name : '';
    const fullType = chain.length > 0 ? `${chain.join('/')}/${type}` : type;

    if (type && name) {
      fingerprint.resourceIds.push(name);
      if (/apimanagement/i.test(fullType)) {
        fingerprint.serviceNames.push(name.split('/')[0] ?? name);
      }
      if (/^microsoft\.resources\/resourcegroups$/i.test(fullType)) {
        fingerprint.resourceGroups.push(name);
      }
    }

    if (fullType.toLowerCase() === APIM_API_TYPE) {
      const format = typeof resource.properties?.format === 'string' ? resource.properties.format.toLowerCase() : '';
      const value = resource.properties?.value;
      const isInlineFormat = (format.includes('openapi') || format.includes('swagger')) && !format.includes('link');
      if (format.includes('link')) {
        fingerprint.evidence.push(`IaC ${relativePath} references linked spec format ${format} (evidence only; not fetched)`);
      } else if (isInlineFormat && value !== undefined) {
        const inline = extractInlineDocument(value);
        if (inline) {
          candidates.push({
            id: `${relativePath}#${name || 'apim-api'}`,
            name: name || 'apim-api',
            providerType: 'iac-local',
            tags: {},
            supported: true,
            evidence: [`Inline OpenAPI document embedded in ${relativePath} resource ${name || '(unnamed)'}`],
            meta: { relativePath, inlineContent: inline.content, inlineFormat: inline.isJson ? 'openapi-json' : 'openapi-yaml' }
          });
        }
      }
    }

    const nested = resource.resources;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          walk(child as ArmResource, [...chain, type]);
        }
      }
    }
  };

  for (const resource of resources) {
    if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
      walk(resource as ArmResource, []);
    }
  }
}

function extractInlineDocument(value: unknown): { content: string; isJson: boolean } | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    try {
      parseAndValidateOpenApi(serialized);
      return { content: serialized, isJson: true };
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const validated = parseAndValidateOpenApi(value);
      return { content: value.endsWith('\n') ? value : `${value}\n`, isJson: validated.isJson };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function inspectAzureYaml(
  root: string,
  relativePath: string,
  content: string,
  candidates: SpecCandidate[],
  fingerprint: IacFingerprint
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const doc = parsed as { name?: unknown; services?: Record<string, { project?: unknown; [k: string]: unknown }>; [k: string]: unknown };

  if (typeof doc.name === 'string' && doc.name.trim()) {
    fingerprint.serviceNames.push(doc.name.trim());
    fingerprint.evidence.push(`azure.yaml project name ${doc.name.trim()}`);
  }
  const services = doc.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [serviceName, service] of Object.entries(services)) {
      fingerprint.serviceNames.push(serviceName);
      const project = typeof service?.project === 'string' ? service.project : undefined;
      if (!project) continue;
      // Only confined, already-existing OpenAPI file references become candidates. Never URLs, never hooks.
      if (/^[a-z]+:\/\//i.test(project)) continue;
      const candidateRelative = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), project.split(path.sep).join('/')));
      if (candidateRelative.startsWith('..')) continue;
      const absolute = path.join(root, candidateRelative);
      const real = await realpath(absolute).catch(() => undefined);
      if (!real || !(real === root || real.startsWith(root + path.sep))) continue;
      const fileContent = await readFile(real, 'utf8').catch(() => undefined);
      if (!fileContent) continue;
      try {
        const validated = parseAndValidateOpenApi(fileContent);
        candidates.push({
          id: `${relativePath}#${serviceName}`,
          name: serviceName,
          providerType: 'iac-local',
          tags: {},
          supported: true,
          evidence: [`azure.yaml service ${serviceName} references OpenAPI file ${candidateRelative}`],
          meta: {
            relativePath: candidateRelative,
            inlineContent: fileContent.endsWith('\n') ? fileContent : `${fileContent}\n`,
            inlineFormat: validated.isJson ? 'openapi-json' : 'openapi-yaml'
          }
        });
      } catch {
        // Reference exists but is not a valid OpenAPI document; hint only.
      }
    }
  }
}
