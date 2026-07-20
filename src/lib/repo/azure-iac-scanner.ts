import type { SpecCandidate } from '../providers/types.js';
import { discoverRepository, scanAzureIacFromDiscovery } from './discovery.js';
import type { RepositoryDiscoveryResult } from './discovery-types.js';

export interface IacFingerprint {
  resourceIds: string[];
  serviceNames: string[];
  resourceGroups: string[];
  evidence: string[];
}

export interface IacScanResult {
  candidates: SpecCandidate[];
  fingerprint: IacFingerprint;
  /** R3 aggregate discovery payload for later runtime integration. */
  discovery?: RepositoryDiscoveryResult;
}

/**
 * Scan repo-local Azure IaC for inline APIM OpenAPI documents and correlation fingerprints.
 *
 * Confinement: rooted at repoRoot, depth 6 / 200 files, lexical order, skipped
 * build/vendor/output dirs, no symlink traversal, no network, no process execution.
 */
export async function scanAzureIac(repoRoot: string, outputDir: string): Promise<IacScanResult> {
  const { candidates, discovery } = await scanAzureIacFromDiscovery(repoRoot, outputDir);

  const fingerprint: IacFingerprint = {
    resourceIds: [],
    serviceNames: [],
    resourceGroups: [],
    evidence: []
  };

  for (const binding of [...discovery.exactBindings, ...discovery.associations]) {
    if (binding.apimApiId) fingerprint.resourceIds.push(binding.apimApiId);
    if (binding.apiCenterDefinitionId) fingerprint.resourceIds.push(binding.apiCenterDefinitionId);
    if (binding.templateSpecId) fingerprint.resourceIds.push(binding.templateSpecId);
    if (binding.deploymentStackId) fingerprint.resourceIds.push(binding.deploymentStackId);
    if (binding.serviceName) fingerprint.serviceNames.push(binding.serviceName);
    if (binding.resourceGroup) fingerprint.resourceGroups.push(binding.resourceGroup);
    for (const item of binding.evidence) {
      fingerprint.evidence.push(item.note);
    }
  }

  fingerprint.resourceIds = [...new Set(fingerprint.resourceIds)];
  fingerprint.serviceNames = [...new Set(fingerprint.serviceNames)];
  fingerprint.resourceGroups = [...new Set(fingerprint.resourceGroups)];
  fingerprint.evidence = [...new Set(fingerprint.evidence)];

  return { candidates, fingerprint, discovery };
}

/** Aggregate local discovery entry point (specs + bindings + diagnostics). */
export async function discoverRepositoryBindings(
  repoRoot: string,
  outputDir?: string
): Promise<RepositoryDiscoveryResult> {
  return discoverRepository({ repoRoot, outputDir });
}

export type { RepositoryDiscoveryResult } from './discovery-types.js';
