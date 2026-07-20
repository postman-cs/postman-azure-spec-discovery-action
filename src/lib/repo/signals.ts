import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findIaCFiles } from './scan.js';
import { isSecretPath } from './secret-hygiene.js';

export type GatewayUrlKind = 'azure-api-net' | 'https';

export interface GatewayUrlEvidence {
  hostname: string;
  basePath: string;
  kind: GatewayUrlKind;
  sourceFile?: string;
}

export interface RepoSignals {
  serviceHints: string[];
  explicitApiIdHints: string[];
  inferredApiIdHints: string[];
  gatewayUrls: GatewayUrlEvidence[];
  evidence: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/** Normalize an API base path: strip leading/trailing slashes; keep internal segments. */
export function normalizeApiBasePath(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+$/, '')
    .replace(/[\\/]+/g, '/');
}

export function normalizeHostname(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Extract APIM API identifiers from repo content: ARM resource IDs and azure-api.net hostnames. */
function extractApimApiIds(content: string): string[] {
  const matches: string[] = [];
  const armIdPattern =
    /\/providers\/Microsoft\.ApiManagement\/service\/([a-z0-9][a-z0-9-]*)\/apis\/([a-z0-9][a-z0-9-]*(?:;rev=\d+)?)/gi;
  for (const match of content.matchAll(armIdPattern)) {
    const apiId = (match[2] ?? '').trim();
    if (apiId) {
      matches.push(apiId);
    }
  }
  const envPattern =
    /\b(?:APIM_API_ID|AZURE_APIM_API_ID|API_MANAGEMENT_API_ID)\s*[:=]\s*["']?([a-z0-9][a-z0-9-]*(?:;rev=\d+)?)\b/gi;
  for (const match of content.matchAll(envPattern)) {
    const value = (match[1] ?? '').trim();
    if (value) {
      matches.push(value);
    }
  }
  return unique(matches);
}

/** Extract APIM service names from azure-api.net gateway hostnames referenced in the repo. */
function extractApimServiceHints(content: string): string[] {
  const matches: string[] = [];
  const hostPattern = /https:\/\/([a-z0-9][a-z0-9-]*)\.azure-api\.net/gi;
  for (const match of content.matchAll(hostPattern)) {
    const service = (match[1] ?? '').trim();
    if (service) {
      matches.push(service);
    }
  }
  return unique(matches);
}

/**
 * Preserve gateway URL evidence as normalized hostname + base path.
 * Includes default `*.azure-api.net` and other https hosts (custom APIM hostnames
 * become select-grade only when they later match enumerated service hostnames).
 * Query strings and fragments are discarded; content is never executed.
 */
export function extractGatewayUrlEvidence(content: string, sourceFile?: string): GatewayUrlEvidence[] {
  const found: GatewayUrlEvidence[] = [];
  const seen = new Set<string>();
  const urlPattern = /https:\/\/([a-z0-9][a-z0-9.-]*)(\/[^\s"'<>]*)?/gi;
  for (const match of content.matchAll(urlPattern)) {
    const hostname = normalizeHostname(match[1]);
    if (!hostname) continue;
    const rawPath = match[2] ?? '';
    const withoutQuery = rawPath.split(/[?#]/)[0] ?? '';
    const basePath = normalizeApiBasePath(withoutQuery);
    const kind: GatewayUrlKind = hostname.endsWith('.azure-api.net') ? 'azure-api-net' : 'https';
    const key = `${kind}|${hostname}|${basePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ hostname, basePath, kind, ...(sourceFile ? { sourceFile } : {}) });
  }
  return found;
}

const IAC_EXTENSIONS = ['.json', '.bicep', '.yaml', '.yml', '.tf', '.env', '.ts', '.js', '.md'];
const MAX_FILE_BYTES = 512 * 1024;

export interface CollectRepoSignalsInput {
  repoRoot: string;
  expectedServiceName?: string;
  expectedApiIds?: string[];
  repoSlug?: string;
}

export async function collectRepoSignals(input: CollectRepoSignalsInput): Promise<RepoSignals> {
  const serviceHints: string[] = [];
  const inferredApiIds: string[] = [];
  const gatewayUrls: GatewayUrlEvidence[] = [];
  const evidence: string[] = [];

  if (input.expectedServiceName) {
    serviceHints.push(input.expectedServiceName);
  }
  if (input.repoSlug) {
    const repoName = input.repoSlug.split('/').pop() ?? '';
    if (repoName) {
      serviceHints.push(repoName);
    }
  }

  const files = await findIaCFiles(input.repoRoot, IAC_EXTENSIONS);
  for (const file of files) {
    const relative = path.relative(input.repoRoot, file).split(path.sep).join('/');
    // Never generically read secret/state-bearing paths (root .env, tfstate, credentials, etc.).
    if (isSecretPath(relative)) {
      continue;
    }
    const content = await readFile(file, 'utf8').then((value) => value).catch(() => undefined);
    if (content === undefined || content.length > MAX_FILE_BYTES) {
      continue;
    }
    const apiIds = extractApimApiIds(content);
    if (apiIds.length > 0) {
      inferredApiIds.push(...apiIds);
      evidence.push(`Found APIM API reference(s) in ${relative}`);
    }
    const services = extractApimServiceHints(content);
    if (services.length > 0) {
      serviceHints.push(...services);
      evidence.push(`Found APIM gateway hostname(s) in ${relative}`);
    }
    const urls = extractGatewayUrlEvidence(content, relative);
    if (urls.length > 0) {
      gatewayUrls.push(...urls);
      evidence.push(`Found gateway URL evidence in ${relative}`);
    }
  }

  // Deduplicate gateway URLs while preserving first-seen order.
  const dedupedUrls: GatewayUrlEvidence[] = [];
  const seenUrls = new Set<string>();
  for (const url of gatewayUrls) {
    const key = `${url.kind}|${url.hostname}|${url.basePath}`;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    dedupedUrls.push(url);
  }

  return {
    serviceHints: unique(serviceHints),
    explicitApiIdHints: unique(input.expectedApiIds ?? []),
    inferredApiIdHints: unique(inferredApiIds),
    gatewayUrls: dedupedUrls,
    evidence
  };
}
