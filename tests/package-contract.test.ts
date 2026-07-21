import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

interface PackageJson {
  name: string;
  version: string;
  engines?: Record<string, string>;
  files?: string[];
  dependencies: Record<string, string>;
  bin?: Record<string, string>;
  repository?: { type?: string; url?: string };
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

const AZURE_PINS: Record<string, string> = {
  '@azure/identity': '4.13.1',
  '@azure/arm-apimanagement': '10.0.0',
  '@azure/arm-appservice': '19.0.0',
  '@azure/arm-resources': '8.0.0',
  '@azure/arm-subscriptions': '6.0.0'
};

describe('package contract', () => {
  it('AZ-CONTRACT-006: name, version, engine, Azure pins, and packaged files are locked', () => {
    expect(pkg.name).toBe('@postman-cse/onboarding-azure-spec-discovery');
    expect(pkg.version).toBe('1.3.0');
    expect(pkg.engines?.node).toBe('>=24');
    expect(pkg.bin?.['postman-azure-spec-discovery']).toBe('dist/cli.cjs');
    expect(pkg.repository?.type).toBe('git');
    expect(pkg.repository?.url).toBe('https://github.com/postman-cs/postman-azure-spec-discovery-action');

    for (const [name, version] of Object.entries(AZURE_PINS)) {
      expect(pkg.dependencies[name], `${name} must be pinned exactly`).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} lockfile pin`).toBe(version);
    }

    for (const entry of ['action.yml', 'dist', 'README.md', 'docs', 'SECURITY.md', 'SUPPORT.md', 'RELEASE_POLICY.md']) {
      expect(pkg.files, `files must include ${entry}`).toContain(entry);
    }
  });

  it('AZ-CONTRACT-007: setup:hooks installs the executable committed pre-push hook', () => {
    const hook = resolve(repoRoot, '.githooks/pre-push');
    expect(() => accessSync(hook, constants.F_OK | constants.X_OK)).not.toThrow();
    expect(pkg.scripts?.['setup:hooks']).toContain('.githooks');
  });
});
