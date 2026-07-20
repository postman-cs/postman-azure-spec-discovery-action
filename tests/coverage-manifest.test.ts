import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ADVERTISED_PROVIDERS,
  CONTRACT_CLASSES,
  VALIDATION_STATES,
  verifyCoverageManifest
} from '../scripts/verify-coverage-manifest.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(repoRoot, 'coverage', 'route-claims.json');
const evidencePath = path.join(repoRoot, 'validation', 'evidence', 'live-azure-surfaces.json');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function cloneManifest(): Record<string, unknown> {
  return structuredClone(loadJson(manifestPath) as Record<string, unknown>);
}

function verifyMutated(
  mutate: (manifest: Record<string, unknown>) => void,
  options: { evidence?: unknown } = {}
): ReturnType<typeof verifyCoverageManifest> {
  const manifest = cloneManifest();
  mutate(manifest);
  return verifyCoverageManifest({
    root: repoRoot,
    manifest,
    evidence: options.evidence ?? loadJson(evidencePath)
  });
}

describe('coverage claim manifest contract', () => {
  it('AZ-COV-001: committed manifest exists and lists every advertised provider route', () => {
    const manifest = loadJson(manifestPath) as {
      schemaVersion: number;
      advertisedProviders: string[];
      routes: Array<{
        id: string;
        provider: string;
        contractClass: string;
        validationState: string;
        liveEvidenceCase?: string | null;
      }>;
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.advertisedProviders).toEqual([...ADVERTISED_PROVIDERS]);
    expect(manifest.routes.length).toBeGreaterThan(0);

    for (const provider of ADVERTISED_PROVIDERS) {
      expect(
        manifest.routes.some((route) => route.provider === provider),
        `missing advertised provider route for ${provider}`
      ).toBe(true);
    }

    for (const route of manifest.routes) {
      expect(CONTRACT_CLASSES.has(route.contractClass as never)).toBe(true);
      expect(VALIDATION_STATES.has(route.validationState as never)).toBe(true);
    }
  });

  it('AZ-COV-002: live rows bind only to the six committed passing evidence cases', () => {
    const manifest = loadJson(manifestPath) as {
      routes: Array<{
        id: string;
        validationState: string;
        liveEvidenceCase?: string | null;
        plannedLiveEvidenceCase?: string | null;
      }>;
    };
    const evidence = loadJson(evidencePath) as {
      schemaVersion: number;
      results: Array<{ name?: string; id?: string; status: string }>;
    };
    expect(evidence.schemaVersion).toBe(2);
    const passing = new Set(
      evidence.results
        .filter((row) => row.status === 'pass')
        .map((row) => row.name || row.id)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    );

    expect(passing.size).toBe(6);
    expect([...passing].sort()).toEqual([
      'ambiguity',
      'apim-discovery',
      'apim-explicit-api-id',
      'app-service-api-definition',
      'discover-many',
      'iac-single'
    ]);

    const liveCases = manifest.routes
      .filter((route) => route.validationState === 'live')
      .map((route) => route.liveEvidenceCase)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

    for (const liveCase of liveCases) {
      expect(passing.has(liveCase), `live claim references unknown/failing case ${liveCase}`).toBe(true);
    }

    // Unit tests alone must not inflate live claims beyond committed evidence.
    expect(new Set(liveCases).size).toBeLessThanOrEqual(passing.size);

    // Planned harness ids may be mapped while remaining unit-only.
    const planned = manifest.routes.filter(
      (route) => typeof route.plannedLiveEvidenceCase === 'string' && route.plannedLiveEvidenceCase.length > 0
    );
    expect(planned.length).toBeGreaterThan(0);
    for (const route of planned) {
      expect(route.validationState).not.toBe('live');
    }
  });

  it('AZ-COV-018: requires-capability evidence never backs a live claim', () => {
    const result = verifyMutated(
      (manifest) => {
        const routes = manifest.routes as Array<Record<string, unknown>>;
        const route = routes.find((row) => row.validationState === 'unit-only')!;
        route.validationState = 'live';
        route.liveEvidenceCase = 'service-bus-topic-partial';
      },
      {
        evidence: {
          schemaVersion: 2,
          suiteVersion: 'r8-pos-396-v1',
          capturedAt: '2026-07-20',
          cases: 1,
          passed: 0,
          failed: 0,
          requiresCapability: 1,
          localOnly: 0,
          results: [
            {
              id: 'service-bus-topic-partial',
              name: 'service-bus-topic-partial',
              status: 'requires-capability',
              providerType: 'service-bus',
              sourceType: 'service-bus-topic',
              specFormat: 'openapi-json',
              contractClass: 'partial',
              reasonCode: 'cost-guard-blocked'
            }
          ]
        }
      }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /live evidence/i.test(error))).toBe(true);
  });

  it('AZ-COV-003: npm run verify:coverage passes against the committed tree', () => {
    const result = spawnSync('npm', ['run', 'verify:coverage'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('verify-coverage-manifest: ok');
  });

  it('AZ-COV-004: verifyCoverageManifest accepts the committed manifest', () => {
    const result = verifyCoverageManifest({
      root: repoRoot,
      manifest: loadJson(manifestPath),
      evidence: loadJson(evidencePath)
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('coverage claim verifier negatives', () => {
  it('AZ-COV-010: rejects duplicate route ids', () => {
    const result = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      routes.push({ ...routes[0], id: routes[0]!.id });
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /duplicate id/i.test(error))).toBe(true);
  });

  it('AZ-COV-011: rejects missing implementation files and missing test files', () => {
    const missingImpl = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      routes[0]!.implementationFiles = ['src/lib/providers/does-not-exist.ts'];
    });
    expect(missingImpl.ok).toBe(false);
    expect(missingImpl.errors.some((error) => /implementation file/i.test(error))).toBe(true);

    const missingTest = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => Array.isArray(row.positiveTests) && (row.positiveTests as string[]).length > 0)!;
      route.positiveTests = ['tests/does-not-exist.test.ts'];
    });
    expect(missingTest.ok).toBe(false);
    expect(missingTest.errors.some((error) => /test file/i.test(error))).toBe(true);
  });

  it('AZ-COV-012: rejects invalid contract class and validation state combinations', () => {
    const badClass = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      routes[0]!.contractClass = 'invented';
    });
    expect(badClass.ok).toBe(false);
    expect(badClass.errors.some((error) => /contract class/i.test(error))).toBe(true);

    const unsupportedMismatch = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => row.contractClass === 'authoritative')!;
      route.validationState = 'unsupported';
      route.unsupportedReason = 'should not pair authoritative with unsupported';
    });
    expect(unsupportedMismatch.ok).toBe(false);
    expect(unsupportedMismatch.errors.some((error) => /unsupported/i.test(error))).toBe(true);

    const liveWithoutCase = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => row.validationState === 'unit-only')!;
      route.validationState = 'live';
      route.liveEvidenceCase = null;
    });
    expect(liveWithoutCase.ok).toBe(false);
    expect(liveWithoutCase.errors.some((error) => /liveEvidenceCase/i.test(error))).toBe(true);
  });

  it('AZ-COV-013: rejects live rows without a matching passing evidence case', () => {
    const result = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => row.validationState === 'unit-only')!;
      route.validationState = 'live';
      route.liveEvidenceCase = 'not-a-real-live-case';
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /live evidence/i.test(error))).toBe(true);
  });

  it('AZ-COV-014: rejects unsupported rows without an explicit reason', () => {
    const result = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => row.contractClass === 'unsupported')!;
      route.unsupportedReason = '';
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /unsupportedReason/i.test(error))).toBe(true);
  });

  it('AZ-COV-015: rejects local-only rows that list remote implementation files', () => {
    const result = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      const route = routes.find((row) => row.validationState === 'local-only')!;
      route.implementationFiles = ['src/lib/providers/apim.ts', 'src/lib/azure/clients.ts'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /local-only/i.test(error) && /remote/i.test(error))).toBe(true);
  });

  it('AZ-COV-016: rejects when an advertised provider has no route in the manifest', () => {
    const result = verifyMutated((manifest) => {
      const routes = manifest.routes as Array<Record<string, unknown>>;
      manifest.routes = routes.filter((row) => row.provider !== 'event-grid');
      manifest.advertisedProviders = [...ADVERTISED_PROVIDERS];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /advertised provider/i.test(error) && /event-grid/i.test(error))).toBe(
      true
    );
  });

  it('AZ-COV-017: fixture tree with a mutated manifest fails the CLI verifier', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'coverage-claim-'));
    tempDirs.push(fixtureRoot);

    // Minimal tree: copy only what the verifier needs, then mutate the claim.
    mkdirSync(path.join(fixtureRoot, 'coverage'), { recursive: true });
    mkdirSync(path.join(fixtureRoot, 'validation', 'evidence'), { recursive: true });
    mkdirSync(path.join(fixtureRoot, 'docs'), { recursive: true });
    mkdirSync(path.join(fixtureRoot, 'src', 'lib', 'providers'), { recursive: true });
    mkdirSync(path.join(fixtureRoot, 'tests'), { recursive: true });

    writeFileSync(path.join(fixtureRoot, 'docs', 'providers.md'), readFileSync(path.join(repoRoot, 'docs', 'providers.md')));
    writeFileSync(
      path.join(fixtureRoot, 'validation', 'evidence', 'live-azure-surfaces.json'),
      readFileSync(evidencePath)
    );
    writeFileSync(path.join(fixtureRoot, 'src', 'lib', 'providers', 'apim.ts'), '// fixture\n');
    writeFileSync(path.join(fixtureRoot, 'tests', 'apim-provider.test.ts'), '// fixture\n');

    const manifest = {
      schemaVersion: 1,
      advertisedProviders: [...ADVERTISED_PROVIDERS],
      routes: [
        {
          id: 'fixture.apim',
          provider: 'apim',
          route: 'http-export',
          implementationFiles: ['src/lib/providers/apim.ts'],
          contractClass: 'authoritative',
          nativeFormats: ['openapi-json'],
          requiredCapability: 'API Management Service Reader',
          positiveTests: ['tests/apim-provider.test.ts'],
          negativeTests: ['tests/apim-provider.test.ts'],
          securityTests: [],
          paginationTests: [],
          validationState: 'unit-only',
          liveEvidenceCase: null,
          unsupportedReason: null
        }
      ]
    };
    writeFileSync(path.join(fixtureRoot, 'coverage', 'route-claims.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-coverage-manifest.mjs'), fixtureRoot], {
      encoding: 'utf8'
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/advertised provider/i);
  });
});
