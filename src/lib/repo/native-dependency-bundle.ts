import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SpecFormat } from '../../contracts.js';
import {
  assessNativeDependencyFidelity,
  dependencyRefKey,
  listNativeDependencyRefs
} from '../spec/dependency-fidelity.js';
import { safeNativeFilename } from '../spec/native-filenames.js';
import { resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';
import type { SpecExportArtifact, SpecExportResult } from '../providers/types.js';

/**
 * Resolve relative protobuf/WSDL/XSD dependency refs against the primary's
 * directory, confined under repoRoot (bootstrap-aligned: never above the
 * primary directory, never over the network).
 */
export async function resolveRepoNativeDependencyCompanions(options: {
  repoRoot: string;
  primaryRelativePath: string;
  primaryContent: string;
  format: SpecFormat;
}): Promise<{
  artifacts: SpecExportArtifact[];
  availableKeys: string[];
  missingRefs: string[];
}> {
  const refs = listNativeDependencyRefs(options.primaryContent, options.format);
  const primaryDir = path.posix.dirname(options.primaryRelativePath.replace(/\\/g, '/'));
  const artifacts: SpecExportArtifact[] = [];
  const availableKeys: string[] = [];
  const missingRefs: string[] = [];

  for (const ref of refs) {
    const key = dependencyRefKey(ref);
    if (!key) {
      missingRefs.push(ref);
      continue;
    }
    const candidateRelative = path.posix.normalize(
      primaryDir === '.' ? key : path.posix.join(primaryDir, key)
    );
    if (candidateRelative.split('/').includes('..')) {
      missingRefs.push(ref);
      continue;
    }
    // Confine under the primary directory (same rule as bootstrap wsdlImportResolver).
    const primaryDirPrefix = primaryDir === '.' ? '' : `${primaryDir}/`;
    if (primaryDir !== '.' && !candidateRelative.startsWith(primaryDirPrefix)) {
      missingRefs.push(ref);
      continue;
    }
    try {
      const absolute = resolvePathWithinRoot(options.repoRoot, candidateRelative, 'native-dependency');
      const content = await readFile(absolute, 'utf8');
      const artifactRel = primaryDir === '.' ? key : key;
      artifacts.push({ relativePath: artifactRel, content });
      availableKeys.push(key, path.posix.basename(key));
    } catch {
      missingRefs.push(ref);
    }
  }

  return { artifacts, availableKeys, missingRefs };
}

/**
 * Build a path-confined export (primary + companion bytes) for repository
 * natives when every relative dependency is already on disk. Remote/absolute
 * refs keep the export partial without fetching.
 */
export async function buildRepoNativeExportBundle(options: {
  repoRoot: string;
  primaryRelativePath: string;
  primaryContent: string;
  format: SpecFormat;
}): Promise<SpecExportResult> {
  const companions = await resolveRepoNativeDependencyCompanions(options);
  const assessment = assessNativeDependencyFidelity({
    content: options.primaryContent,
    format: options.format,
    availableDependencyKeys: companions.availableKeys
  });

  return {
    content: options.primaryContent,
    format: options.format,
    filename: safeNativeFilename(options.format),
    completeness: assessment.completeness,
    contractClass: assessment.contractClass,
    ...(assessment.hasUnresolvedDependencies || companions.artifacts.length === 0
      ? {}
      : { artifacts: companions.artifacts }),
    evidence: [
      `Materialized repository native specification ${options.primaryRelativePath} as ${options.format}`,
      ...assessment.evidence,
      ...(companions.artifacts.length > 0
        ? [
            `Bundled ${companions.artifacts.length} path-confined companion file(s) without concatenation or remote fetch`
          ]
        : [])
    ]
  };
}
