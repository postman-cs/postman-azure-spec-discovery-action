import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findIaCFiles } from './scan.js';

export interface RepoSignals {
  serviceHints: string[];
  explicitApiIdHints: string[];
  inferredApiIdHints: string[];
  evidence: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/** Extract APIM API identifiers from repo content: ARM resource IDs and azure-api.net hostnames. */
function extractApimApiIds(content: string): string[] {
  const matches: string[] = [];
  const armIdPattern = /\/providers\/Microsoft\.ApiManagement\/service\/([a-z0-9][a-z0-9-]*)\/apis\/([a-z0-9][a-z0-9-]*)/gi;
  for (const match of content.matchAll(armIdPattern)) {
    const apiId = (match[2] ?? '').trim();
    if (apiId) {
      matches.push(apiId);
    }
  }
  const envPattern = /\b(?:APIM_API_ID|AZURE_APIM_API_ID|API_MANAGEMENT_API_ID)\s*[:=]\s*["']?([a-z0-9][a-z0-9-]*)\b/gi;
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

const IAC_EXTENSIONS = ['.json', '.bicep', '.yaml', '.yml', '.tf', '.env', '.ts', '.js'];
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
    const statSize = await readFile(file, 'utf8').then((content) => content).catch(() => undefined);
    if (statSize === undefined || statSize.length > MAX_FILE_BYTES) {
      continue;
    }
    const apiIds = extractApimApiIds(statSize);
    if (apiIds.length > 0) {
      inferredApiIds.push(...apiIds);
      evidence.push(`Found APIM API reference(s) in ${path.relative(input.repoRoot, file)}`);
    }
    const services = extractApimServiceHints(statSize);
    if (services.length > 0) {
      serviceHints.push(...services);
      evidence.push(`Found APIM gateway hostname(s) in ${path.relative(input.repoRoot, file)}`);
    }
  }

  return {
    serviceHints: unique(serviceHints),
    explicitApiIdHints: unique(input.expectedApiIds ?? []),
    inferredApiIdHints: unique(inferredApiIds),
    evidence
  };
}
