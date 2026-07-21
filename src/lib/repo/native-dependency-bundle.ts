import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { SpecFormat } from '../../contracts.js';
import {
  assessNativeDependencyFidelity,
  dependencyRefKey,
  listNativeDependencyRefs
} from '../spec/dependency-fidelity.js';
import { safeNativeFilename } from '../spec/native-filenames.js';
import { assertNoSymlinkEscape, resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';
import type { SpecExportArtifact, SpecExportResult } from '../providers/types.js';

/**
 * Bootstrap/PRD definition-bundle ceilings for native transitive closures.
 * Distinct from repository-scan limits (200 files / depth 6 / 512 KiB).
 * maxFiles counts the primary root plus companions (101 total including root).
 */
export const NATIVE_CLOSURE_LIMITS = {
  maxFiles: 101,
  maxDepth: 20,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
} as const;

export type NativeClosureLimits = {
  maxFiles: number;
  maxDepth: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

/** Test-only overrides; production callers omit these. Values cannot exceed PRD defaults. */
export type NativeClosureLimitOverrides = Partial<NativeClosureLimits>;

export function resolveNativeClosureLimits(
  overrides?: NativeClosureLimitOverrides
): NativeClosureLimits {
  const clamp = (value: number | undefined, ceiling: number, floor: number): number => {
    const raw = value === undefined ? ceiling : Math.floor(value);
    if (!Number.isFinite(raw)) return ceiling;
    return Math.min(Math.max(raw, floor), ceiling);
  };
  return {
    maxFiles: clamp(overrides?.maxFiles, NATIVE_CLOSURE_LIMITS.maxFiles, 1),
    maxDepth: clamp(overrides?.maxDepth, NATIVE_CLOSURE_LIMITS.maxDepth, 0),
    maxBytesPerFile: clamp(overrides?.maxBytesPerFile, NATIVE_CLOSURE_LIMITS.maxBytesPerFile, 1),
    maxTotalBytes: clamp(overrides?.maxTotalBytes, NATIVE_CLOSURE_LIMITS.maxTotalBytes, 1)
  };
}

interface CompanionQueueItem {
  /** Raw dependency ref as written by the importing document. */
  ref: string;
  /** Repo-relative POSIX directory of the importing file (under the primary directory). */
  importerDir: string;
  /** Dependency hop depth from the primary (primary refs start at 1). */
  depth: number;
}

function companionNativeFormat(primaryFormat: SpecFormat, relativePath: string): SpecFormat {
  if (primaryFormat === 'protobuf') return 'protobuf';
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.wsdl')) return 'wsdl';
  if (lower.endsWith('.xsd')) return 'xsd';
  if (primaryFormat === 'wsdl' || primaryFormat === 'xsd') return primaryFormat;
  return primaryFormat;
}

function primaryRelativeArtifactPath(primaryDir: string, candidateRelative: string): string {
  if (primaryDir === '.' || primaryDir === '') return candidateRelative;
  const relative = path.posix.relative(primaryDir, candidateRelative);
  return relative || path.posix.basename(candidateRelative);
}

/**
 * Resolve relative protobuf/WSDL/XSD dependency refs against each importer's
 * directory, confined under the primary directory and repoRoot (bootstrap-aligned:
 * never above the primary directory, never over the network, never through
 * symlink escapes). Traverses the full local closure with file/depth/byte ceilings.
 */
export async function resolveRepoNativeDependencyCompanions(options: {
  repoRoot: string;
  primaryRelativePath: string;
  primaryContent: string;
  format: SpecFormat;
  /** Injectable ceilings for tests; cannot raise production PRD defaults. */
  limits?: NativeClosureLimitOverrides;
}): Promise<{
  artifacts: SpecExportArtifact[];
  availableKeys: string[];
  missingRefs: string[];
  /**
   * True when the primary root alone exceeds per-file or total byte ceilings.
   * Set even when the dependency queue is empty so dependency-free oversized
   * roots cannot return a false-full closure.
   */
  closureLimitExceeded: boolean;
}> {
  const limits = resolveNativeClosureLimits(options.limits);
  const primaryRelativeNormalized = path.posix.normalize(
    options.primaryRelativePath.replace(/\\/g, '/')
  );
  const primaryDir = path.posix.dirname(primaryRelativeNormalized);
  const primaryDirPrefix = primaryDir === '.' ? '' : `${primaryDir}/`;
  const artifacts: SpecExportArtifact[] = [];
  const availableKeys: string[] = [];
  const missingRefs: string[] = [];
  // Seed root identity so cycles back to the primary never re-add it as a companion
  // or consume the unique-file / depth budgets a second time.
  const seenCandidateRelatives = new Set<string>([primaryRelativeNormalized]);
  let totalBytes = Buffer.byteLength(options.primaryContent, 'utf8');
  const queue: CompanionQueueItem[] = listNativeDependencyRefs(options.primaryContent, options.format).map(
    (ref) => ({
      ref,
      importerDir: primaryDir,
      depth: 1
    })
  );

  // Root alone over per-member or total ceiling: fail closed even with an empty
  // dependency queue (do not rely on missingRefs generated from dependencies).
  if (totalBytes > limits.maxBytesPerFile || totalBytes > limits.maxTotalBytes) {
    for (const item of queue) {
      missingRefs.push(item.ref);
    }
    return { artifacts, availableKeys, missingRefs, closureLimitExceeded: true };
  }

  while (queue.length > 0) {
    const item = queue.shift()!;

    const key = dependencyRefKey(item.ref);
    if (!key) {
      missingRefs.push(item.ref);
      continue;
    }

    const candidateRelative = path.posix.normalize(
      item.importerDir === '.' ? key : path.posix.join(item.importerDir, key)
    );
    if (candidateRelative.split('/').includes('..')) {
      missingRefs.push(item.ref);
      continue;
    }
    // Confine under the primary directory (same rule as bootstrap wsdlImportResolver).
    if (primaryDir !== '.' && !candidateRelative.startsWith(primaryDirPrefix)) {
      missingRefs.push(item.ref);
      continue;
    }
    // Root/seen de-dup before depth and new-member file-cap enforcement so cycles
    // and duplicate refs never false-positive as partial.
    if (seenCandidateRelatives.has(candidateRelative)) {
      continue;
    }

    if (item.depth > limits.maxDepth) {
      missingRefs.push(item.ref);
      continue;
    }
    // maxFiles includes the primary root; 101 total allowed, 102nd unique is partial.
    if (1 + artifacts.length >= limits.maxFiles) {
      missingRefs.push(item.ref);
      continue;
    }

    seenCandidateRelatives.add(candidateRelative);

    try {
      await assertNoSymlinkEscape(options.repoRoot, candidateRelative, 'native-dependency');
      const absolute = resolvePathWithinRoot(options.repoRoot, candidateRelative, 'native-dependency');
      const fileStat = await stat(absolute);
      if (!fileStat.isFile()) {
        missingRefs.push(item.ref);
        continue;
      }
      // Reject before reading when per-member or cumulative budget would be exceeded.
      if (fileStat.size > limits.maxBytesPerFile || totalBytes + fileStat.size > limits.maxTotalBytes) {
        missingRefs.push(item.ref);
        continue;
      }
      const content = await readFile(absolute, 'utf8');
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > limits.maxBytesPerFile || totalBytes + byteLength > limits.maxTotalBytes) {
        missingRefs.push(item.ref);
        continue;
      }

      totalBytes += byteLength;
      // Importer-relative identity projected from the primary directory for staging.
      const artifactRel = primaryRelativeArtifactPath(primaryDir, candidateRelative);
      artifacts.push({ relativePath: artifactRel, content });
      availableKeys.push(key, path.posix.basename(key), artifactRel, path.posix.basename(artifactRel));

      const companionDir = path.posix.dirname(candidateRelative);
      const nestedFormat = companionNativeFormat(options.format, candidateRelative);
      for (const nestedRef of listNativeDependencyRefs(content, nestedFormat)) {
        queue.push({
          ref: nestedRef,
          importerDir: companionDir,
          depth: item.depth + 1
        });
      }
    } catch {
      missingRefs.push(item.ref);
    }
  }

  return { artifacts, availableKeys, missingRefs, closureLimitExceeded: false };
}

/**
 * Build a path-confined export (primary + companion bytes) for repository
 * natives when every relative dependency in the transitive closure is already
 * on disk. Remote/absolute/escaping/missing refs keep the export partial without
 * fetching. Primary filename is the safe native name; companion relativePath
 * values stay primary-directory-relative (import-key normalized for siblings).
 */
export async function buildRepoNativeExportBundle(options: {
  repoRoot: string;
  primaryRelativePath: string;
  primaryContent: string;
  format: SpecFormat;
  /** Injectable ceilings for tests; cannot raise production PRD defaults. */
  limits?: NativeClosureLimitOverrides;
}): Promise<SpecExportResult> {
  const companions = await resolveRepoNativeDependencyCompanions(options);
  const assessment = assessNativeDependencyFidelity({
    content: options.primaryContent,
    format: options.format,
    availableDependencyKeys: companions.availableKeys
  });
  // Root-byte overage is an explicit closure-limit failure, independent of
  // dependency missingRefs (including dependency-free roots).
  const closureIncomplete =
    companions.missingRefs.length > 0 || companions.closureLimitExceeded;
  const hasUnresolved = assessment.hasUnresolvedDependencies || closureIncomplete;
  const completeness: 'full' | 'partial' = hasUnresolved ? 'partial' : assessment.completeness;
  const contractClass: 'authoritative' | 'partial' = hasUnresolved ? 'partial' : assessment.contractClass;

  const artifacts =
    !hasUnresolved && companions.artifacts.length > 0
      ? companions.artifacts.map((artifact) => ({
          relativePath: artifact.relativePath.replace(/\\/g, '/'),
          content: artifact.content
        }))
      : undefined;

  return {
    content: options.primaryContent,
    format: options.format,
    filename: safeNativeFilename(options.format),
    completeness,
    contractClass,
    ...(artifacts ? { artifacts } : {}),
    evidence: [
      `Materialized repository native specification ${options.primaryRelativePath} as ${options.format}`,
      ...assessment.evidence,
      ...(companions.closureLimitExceeded
        ? [
            `${options.format} primary root exceeds native closure per-file or total byte ceiling`,
            'Export fidelity is partial; no authoritative/full closure when the root alone exceeds per-file or total byte limits'
          ]
        : companions.missingRefs.length > 0
          ? [
              `${options.format} transitive closure has unresolved dependency reference(s): ${companions.missingRefs.join(', ')}`,
              'Export fidelity is partial; no authoritative/full closure without dependency bytes (never concatenated or remotely fetched with Azure credentials)'
            ]
          : []),
      ...(artifacts
        ? [`Bundled ${artifacts.length} path-confined companion file(s) without concatenation or remote fetch`]
        : [])
    ]
  };
}
