import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ProviderType } from '../src/contracts.js';
import {
  ADVERTISED_PROVIDER_TYPES,
  getProviderRegistration,
  PROVIDER_REGISTRATIONS,
  providerRegistrationsInProbeOrder,
  sourceTypeForProvider
} from '../src/lib/providers/registry.js';
import {
  ADVERTISED_PROVIDERS,
  verifyProviderRegistrationsAgainstManifest
} from '../scripts/verify-coverage-manifest.mjs';

const ALL_PROVIDER_TYPES: ProviderType[] = [
  'apim',
  'api-center',
  'app-service',
  'iac-local',
  'custom-apis',
  'logic-apps',
  'template-specs',
  'event-grid',
  'service-bus',
  'function-bindings',
  'runtime-declared'
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('provider registration seam (R7 / POS-400)', () => {
  it('AZ-R7-001: registry includes every ProviderType exactly once', () => {
    const types = PROVIDER_REGISTRATIONS.map((entry) => entry.providerType);
    expect(types.sort()).toEqual([...ALL_PROVIDER_TYPES].sort());
    expect(new Set(types).size).toBe(types.length);
  });

  it('AZ-R7-002: registration owns source/class/formats/permissions/graph/probe metadata', () => {
    for (const registration of PROVIDER_REGISTRATIONS) {
      expect(registration.sourceType.length).toBeGreaterThan(0);
      expect(registration.defaultContractClass.length).toBeGreaterThan(0);
      expect(registration.nativeFormats.length).toBeGreaterThan(0);
      expect(registration.requiredCapability.length).toBeGreaterThan(0);
      expect(registration.dependencyKey.length).toBeGreaterThan(0);
      expect(Number.isInteger(registration.probeOrder)).toBe(true);
      expect(Array.isArray(registration.resourceGraphTypes)).toBe(true);
      expect(Array.isArray(registration.unsupportedReasons)).toBe(true);
      expect(getProviderRegistration(registration.providerType)).toBe(registration);
      expect(sourceTypeForProvider(registration.providerType)).toBe(registration.sourceType);
    }
  });

  it('AZ-R7-003: advertised registrations align with coverage manifest rows', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'coverage', 'route-claims.json'), 'utf8')) as {
      advertisedProviders: string[];
      routes: Array<{
        provider: string;
        contractClass: string;
        nativeFormats: string[];
        requiredCapability: string;
      }>;
    };

    expect(manifest.advertisedProviders).toEqual([...ADVERTISED_PROVIDER_TYPES]);
    expect(ADVERTISED_PROVIDERS).toEqual([...ADVERTISED_PROVIDER_TYPES]);

    const verified = verifyProviderRegistrationsAgainstManifest({
      registrations: PROVIDER_REGISTRATIONS.map((entry) => ({
        providerType: entry.providerType,
        defaultContractClass: entry.defaultContractClass,
        nativeFormats: [...entry.nativeFormats],
        requiredCapability: entry.requiredCapability
      })),
      manifest
    });
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it('AZ-R7-004: probe order is unique and stable', () => {
    const ordered = providerRegistrationsInProbeOrder();
    const orders = ordered.map((entry) => entry.probeOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});
