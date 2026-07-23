import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RELEASE_TGZ = 'release.tgz';
const RELEASE_MANIFEST = 'release-manifest.json';
const EXACT_DIRECTORY_ENTRIES = [RELEASE_MANIFEST, RELEASE_TGZ];

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const parseExactSemver = (value) => {
  const raw = String(value ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`invalid x.y.z version: ${value}`);
  }
  return raw.split('.').map((part) => Number(part));
};

export function validateTagVersion(tag, packageVersion) {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`expected exact immutable tag v${packageVersion}; got ${tag}`);
  }
}

export function validateManifest(manifest, { repository, commitSha, tag, packageName, packageVersion, checksums }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest missing');
  if (manifest.schema_version !== 1) throw new Error('unsupported manifest schema_version');
  for (const [field, expected] of Object.entries({
    repository,
    commit_sha: commitSha,
    tag
  })) {
    if (manifest[field] !== expected) throw new Error(`manifest ${field} mismatch`);
  }
  if (typeof manifest.package_name !== 'string' || manifest.package_name.length === 0) {
    throw new Error('manifest package_name missing');
  }
  if (typeof manifest.package_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.package_version)) {
    throw new Error('manifest package_version missing or invalid');
  }
  if (packageName !== undefined && manifest.package_name !== packageName) {
    throw new Error('manifest package_name mismatch');
  }
  if (packageVersion !== undefined && manifest.package_version !== packageVersion) {
    throw new Error('manifest package_version mismatch');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
    throw new Error('manifest artifacts must contain exactly one release.tgz entry');
  }
  const artifact = manifest.artifacts[0];
  if (!artifact || artifact.path !== RELEASE_TGZ) throw new Error('manifest artifact path must be exactly release.tgz');
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('invalid manifest artifact sha256');
  }
  if (!checksums || checksums[RELEASE_TGZ] !== artifact.sha256) {
    throw new Error(`artifact checksum mismatch: ${RELEASE_TGZ}`);
  }
}

export function readTarballPackageIdentity(tarball) {
  const result = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot inspect ${basename(tarball)}`);
  const pkg = JSON.parse(result.stdout);
  if (typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string') {
    throw new Error('tarball package identity missing');
  }
  return { name: pkg.name, version: pkg.version };
}

export function computeNpmSri(tarballPath) {
  return `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
}

export function verifyNpmSri(tarballPath, expectedSri) {
  const actual = computeNpmSri(tarballPath);
  if (actual !== String(expectedSri ?? '').trim()) {
    throw new Error('npm integrity/sri mismatch against staged tarball');
  }
  return actual;
}

/**
 * Decide whether a rolling alias should move.
 * advance when current is equal/older than candidate; skip when current is newer.
 */
export function decideAliasVersion({ currentVersion, candidateVersion }) {
  const current = parseExactSemver(currentVersion);
  const candidate = parseExactSemver(candidateVersion);
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > candidate[i]) return { action: 'skip' };
    if (current[i] < candidate[i]) return { action: 'advance' };
  }
  return { action: 'advance' };
}

export function verifyReleaseArtifactsDirectory(directory, expected = {}) {
  const entries = readdirSync(directory).sort();
  if (entries.length !== EXACT_DIRECTORY_ENTRIES.length || entries.some((entry, index) => entry !== EXACT_DIRECTORY_ENTRIES[index])) {
    throw new Error(`directory must contain exactly ${EXACT_DIRECTORY_ENTRIES.join(' and ')}`);
  }

  const manifestPath = join(directory, RELEASE_MANIFEST);
  const tarballPath = join(directory, RELEASE_TGZ);
  if (!existsSync(manifestPath) || !existsSync(tarballPath)) {
    throw new Error('release manifest or tarball missing');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const checksums = { [RELEASE_TGZ]: sha256File(tarballPath) };
  validateManifest(manifest, {
    repository: expected.repository,
    commitSha: expected.commitSha,
    tag: expected.tag,
    packageName: expected.packageName,
    packageVersion: expected.packageVersion,
    checksums
  });
  const pkg = readTarballPackageIdentity(tarballPath);
  if (pkg.name !== manifest.package_name || pkg.version !== manifest.package_version) {
    throw new Error('tarball package identity mismatch');
  }
  validateTagVersion(manifest.tag, manifest.package_version);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyReleaseArtifactsDirectory(process.cwd(), {
    repository: process.env.GITHUB_REPOSITORY,
    commitSha: process.env.GITHUB_SHA,
    tag: process.env.GITHUB_REF_NAME
  });
}
