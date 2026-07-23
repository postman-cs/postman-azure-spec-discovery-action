export interface ReleaseManifest {
  schema_version: number;
  repository: string;
  commit_sha: string;
  tag: string;
  package_name: string;
  package_version: string;
  artifacts: Array<{ path: string; sha256: string }>;
}

export function isExplicitNpmE404(output: string | null | undefined): boolean;
export function isFrozenAliasMajor(major: string | number): boolean;
export function validateTagVersion(tag: string, packageVersion: string): void;
export function validateManifest(
  manifest: ReleaseManifest,
  context: {
    repository: string;
    commitSha: string;
    tag: string;
    packageName?: string;
    packageVersion?: string;
    checksums: Record<string, string>;
  }
): void;
export function readTarballPackageIdentity(tarball: string): { name: string; version: string };
export function computeNpmSri(tarballPath: string): string;
export function verifyNpmSri(tarballPath: string, expectedSri: string): string;
export function decideAliasVersion(input: {
  currentVersion: string;
  candidateVersion: string;
}): { action: 'advance' | 'skip' };
export function verifyReleaseArtifactsDirectory(
  directory: string,
  expected?: {
    repository?: string;
    commitSha?: string;
    tag?: string;
    packageName?: string;
    packageVersion?: string;
  }
): ReleaseManifest;
