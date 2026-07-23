import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decideAliasVersion,
  isExplicitNpmE404,
  isFrozenAliasMajor,
  readTarballPackageIdentity,
  validateManifest,
  validateTagVersion,
  verifyNpmSri,
  verifyReleaseArtifactsDirectory
} from '../scripts/verify-release-artifacts.mjs';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

const baseManifest = {
  schema_version: 1,
  repository: 'postman-cs/postman-azure-spec-discovery-action',
  commit_sha: 'a'.repeat(40),
  tag: 'v1.3.3',
  package_name: '@postman-cse/onboarding-azure-spec-discovery',
  package_version: '1.3.3',
  artifacts: [{ path: 'release.tgz', sha256: sha256('tarball') }]
};

function writeTarball(directory: string, pkg = { name: baseManifest.package_name, version: baseManifest.package_version }): string {
  const staging = join(directory, 'package');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg));
  const tarball = join(directory, 'release.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
  rmSync(staging, { recursive: true, force: true });
  return tarball;
}

describe('release artifact verifier', () => {
  it('AZ-ARTIFACT-001: accepts only exact Azure immutable tags and one release.tgz artifact', () => {
    expect(() => validateManifest(baseManifest, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': sha256('tarball') }
    })).not.toThrow();
    expect(() => validateTagVersion('v1.3.3', '1.3.3')).not.toThrow();
    expect(() => validateTagVersion('v1.3', '1.3.3')).toThrow(/exact immutable tag/);
  });

  it('AZ-ARTIFACT-002: rejects wrong repository, SHA, tag, package name, package version, and checksum', () => {
    for (const context of [
      { repository: 'other/repo', commitSha: baseManifest.commit_sha, tag: baseManifest.tag, packageName: baseManifest.package_name, packageVersion: baseManifest.package_version, checksums: { 'release.tgz': sha256('tarball') } },
      { repository: baseManifest.repository, commitSha: 'b'.repeat(40), tag: baseManifest.tag, packageName: baseManifest.package_name, packageVersion: baseManifest.package_version, checksums: { 'release.tgz': sha256('tarball') } },
      { repository: baseManifest.repository, commitSha: baseManifest.commit_sha, tag: 'v1.3.4', packageName: baseManifest.package_name, packageVersion: baseManifest.package_version, checksums: { 'release.tgz': sha256('tarball') } },
      { repository: baseManifest.repository, commitSha: baseManifest.commit_sha, tag: baseManifest.tag, packageName: '@other/pkg', packageVersion: baseManifest.package_version, checksums: { 'release.tgz': sha256('tarball') } },
      { repository: baseManifest.repository, commitSha: baseManifest.commit_sha, tag: baseManifest.tag, packageName: baseManifest.package_name, packageVersion: '9.9.9', checksums: { 'release.tgz': sha256('tarball') } },
      { repository: baseManifest.repository, commitSha: baseManifest.commit_sha, tag: baseManifest.tag, packageName: baseManifest.package_name, packageVersion: baseManifest.package_version, checksums: { 'release.tgz': sha256('wrong') } }
    ]) expect(() => validateManifest(baseManifest, context)).toThrow();
  });

  it('AZ-ARTIFACT-003: rejects missing, duplicate, extra, traversal, and malformed-hash artifacts', () => {
    expect(() => validateManifest({ ...baseManifest, artifacts: [] }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': sha256('tarball') }
    })).toThrow();

    expect(() => validateManifest({
      ...baseManifest,
      artifacts: [
        { path: 'release.tgz', sha256: sha256('tarball') },
        { path: 'release.tgz', sha256: sha256('tarball') }
      ]
    }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': sha256('tarball') }
    })).toThrow();

    expect(() => validateManifest({
      ...baseManifest,
      artifacts: [
        { path: 'release.tgz', sha256: sha256('tarball') },
        { path: 'extra.tgz', sha256: sha256('extra') }
      ]
    }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': sha256('tarball'), 'extra.tgz': sha256('extra') }
    })).toThrow();

    expect(() => validateManifest({
      ...baseManifest,
      artifacts: [{ path: '../escape.tgz', sha256: sha256('tarball') }]
    }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { '../escape.tgz': sha256('tarball') }
    })).toThrow();

    expect(() => validateManifest({
      ...baseManifest,
      artifacts: [{ path: 'release.tgz', sha256: 'NOT_A_HASH' }]
    }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': 'NOT_A_HASH' }
    })).toThrow();

    expect(() => validateManifest({
      ...baseManifest,
      artifacts: [{ path: 'release.tgz', sha256: 'A'.repeat(64) }]
    }, {
      repository: baseManifest.repository,
      commitSha: baseManifest.commit_sha,
      tag: baseManifest.tag,
      packageName: baseManifest.package_name,
      packageVersion: baseManifest.package_version,
      checksums: { 'release.tgz': 'A'.repeat(64) }
    })).toThrow();
  });

  it('AZ-ARTIFACT-004: pure helpers cover tarball identity, npm SRI mismatch, and alias decisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'azure-release-'));
    try {
      const tarball = writeTarball(directory);
      expect(readTarballPackageIdentity(tarball)).toEqual({
        name: baseManifest.package_name,
        version: baseManifest.package_version
      });

      const sri = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
      expect(() => verifyNpmSri(tarball, sri)).not.toThrow();
      expect(() => verifyNpmSri(tarball, 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(/integrity|sri|mismatch/i);

      expect(decideAliasVersion({ currentVersion: '1.3.2', candidateVersion: '1.3.3' })).toEqual({ action: 'advance' });
      expect(decideAliasVersion({ currentVersion: '1.3.3', candidateVersion: '1.3.3' })).toEqual({ action: 'advance' });
      expect(decideAliasVersion({ currentVersion: '1.4.0', candidateVersion: '1.3.3' })).toEqual({ action: 'skip' });
      expect(() => decideAliasVersion({ currentVersion: '1.3', candidateVersion: '1.3.3' })).toThrow();
      expect(() => decideAliasVersion({ currentVersion: '1.3.3', candidateVersion: 'bad' })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('AZ-ARTIFACT-005: workflow transfers only the signed release allowlist', () => {
    expect(releaseWorkflow).toContain('release.tgz');
    expect(releaseWorkflow).toContain('release-manifest.json');
    expect(releaseWorkflow).not.toMatch(/path:\s*[\s\S]*node_modules/);
    expect(releaseWorkflow).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
  });

  it('AZ-ARTIFACT-006b: isExplicitNpmE404 is true only for explicit npm E404 forms', () => {
    expect(isExplicitNpmE404('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/pkg')).toBe(true);
    expect(isExplicitNpmE404('npm ERR! code E404\nnpm ERR! 404 Not Found')).toBe(true);
    expect(isExplicitNpmE404('npm error code E401\nnpm error 401 Unauthorized')).toBe(false);
    expect(isExplicitNpmE404('npm error code E403')).toBe(false);
    expect(isExplicitNpmE404('npm error code E500')).toBe(false);
    expect(isExplicitNpmE404('npm error code ETIMEDOUT')).toBe(false);
    expect(isExplicitNpmE404('network socket hang up')).toBe(false);
    expect(isExplicitNpmE404('')).toBe(false);
  });

  it('AZ-ARTIFACT-006c: isFrozenAliasMajor freezes only major 0', () => {
    expect(isFrozenAliasMajor(0)).toBe(true);
    expect(isFrozenAliasMajor('0')).toBe(true);
    expect(isFrozenAliasMajor(1)).toBe(false);
    expect(isFrozenAliasMajor(2)).toBe(false);
    expect(() => isFrozenAliasMajor('x')).toThrow();
    expect(() => isFrozenAliasMajor(-1)).toThrow();
  });

  it('AZ-ARTIFACT-006: verifyReleaseArtifactsDirectory rejects hidden and ordinary extras', () => {
    const directory = mkdtempSync(join(tmpdir(), 'azure-release-dir-'));
    try {
      const tarball = writeTarball(directory);
      const digest = sha256(readFileSync(tarball));
      writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({
        schema_version: 1,
        repository: baseManifest.repository,
        commit_sha: baseManifest.commit_sha,
        tag: baseManifest.tag,
        package_name: baseManifest.package_name,
        package_version: baseManifest.package_version,
        artifacts: [{ path: 'release.tgz', sha256: digest }]
      }));

      const expected = {
        repository: baseManifest.repository,
        commitSha: baseManifest.commit_sha,
        tag: baseManifest.tag,
        packageName: baseManifest.package_name,
        packageVersion: baseManifest.package_version
      };
      expect(() => verifyReleaseArtifactsDirectory(directory, expected)).not.toThrow();

      writeFileSync(join(directory, '.npmrc'), '//registry.npmjs.org/:_authToken=leak');
      expect(() => verifyReleaseArtifactsDirectory(directory, expected)).toThrow(/exactly|unexpected|directory/i);
      rmSync(join(directory, '.npmrc'));

      writeFileSync(join(directory, 'evil.bin'), 'extra');
      expect(() => verifyReleaseArtifactsDirectory(directory, expected)).toThrow(/exactly|unexpected|directory/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
