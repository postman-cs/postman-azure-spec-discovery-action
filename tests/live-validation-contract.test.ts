import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The runner module is plain ESM with exported pure helpers; importing it must not
// execute any az command (main is gated on argv[1]).
import {
  buildEvidence,
  classifyProbeError,
  parseFlags,
  requiredEnv,
  shouldDeleteGroup,
  toEvidenceResult
} from '../validation/scripts/validate-live-azure-surfaces.mjs';

const repoRoot = process.cwd();

describe('live validation control flow', () => {
  it('AZ-LIVE-002: env guard, provision/teardown flags, and the teardown marker check are enforced', () => {
    expect(() => requiredEnv({})).toThrow('AZURE_SUBSCRIPTION_ID is required');
    expect(() => requiredEnv({ AZURE_SUBSCRIPTION_ID: 'sub-1' })).toThrow('AZURE_LOCATION is required');
    expect(requiredEnv({ AZURE_SUBSCRIPTION_ID: 'sub-1', AZURE_LOCATION: 'eastus2' })).toEqual({
      subscriptionId: 'sub-1',
      location: 'eastus2'
    });

    expect(parseFlags([])).toEqual({ provision: false, teardown: false });
    expect(parseFlags(['--provision', '--teardown'])).toEqual({ provision: true, teardown: true });

    const manifest = { resourceGroup: 'postman-azure-spec-live-abcd1234', runMarker: 'run-1-abcd1234' };
    const matchingGroup = {
      name: manifest.resourceGroup,
      id: `/subscriptions/sub-1/resourceGroups/${manifest.resourceGroup}`,
      tags: { 'postman-azure-spec-discovery-live-run': manifest.runMarker }
    };

    // Deletion allowed only when name, subscription, and run marker all match.
    expect(shouldDeleteGroup({ manifest, groupShow: matchingGroup, subscriptionId: 'sub-1' })).toBe(true);
    expect(shouldDeleteGroup({ manifest, groupShow: matchingGroup, subscriptionId: 'sub-2' })).toBe(false);
    expect(
      shouldDeleteGroup({
        manifest,
        groupShow: { ...matchingGroup, tags: { 'postman-azure-spec-discovery-live-run': 'other-run' } },
        subscriptionId: 'sub-1'
      })
    ).toBe(false);
    expect(
      shouldDeleteGroup({ manifest, groupShow: { ...matchingGroup, name: 'some-other-group' }, subscriptionId: 'sub-1' })
    ).toBe(false);
    expect(shouldDeleteGroup({ manifest, groupShow: null, subscriptionId: 'sub-1' })).toBe(false);
    expect(shouldDeleteGroup({ manifest: {}, groupShow: matchingGroup, subscriptionId: 'sub-1' })).toBe(false);
  });

  it('AZ-LIVE-002: export-probe errors are classified so fatal failures never poll out the ceiling', () => {
    // Never self-heals: fail fast instead of spinning for the readiness window.
    expect(classifyProbeError('AuthorizationFailed: the client does not have authorization')).toBe('fatal');
    expect(classifyProbeError('InvalidAuthenticationToken: expired')).toBe('fatal');
    expect(classifyProbeError('Operation returned 403 Forbidden')).toBe('fatal');
    expect(classifyProbeError('BadRequest: unsupported format parameter')).toBe('fatal');
    expect(classifyProbeError('Request failed with status 400')).toBe('fatal');

    // Self-heals after a Succeeded deployment: keep polling.
    expect(classifyProbeError('ResourceNotFound: 404 the api was not found')).toBe('retryable');
    expect(classifyProbeError('ServiceUpdating: the service is being updated')).toBe('retryable');
    expect(classifyProbeError('Request failed with status 503')).toBe('retryable');
    expect(classifyProbeError('')).toBe('retryable');
  });

  it('AZ-LIVE-002: evidence construction sanitizes case results down to the committed schema', () => {
    const resolution = {
      status: 'resolved',
      sourceType: 'apim-export',
      providerType: 'apim',
      specFormat: 'openapi-json',
      apiId: '/subscriptions/aaaaaaaa-1111-2222-3333-444444444444/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/x',
      specPath: 'discovered-specs/x/index.json'
    };
    const result = toEvidenceResult('apim-explicit-api-id', 'pass', resolution);
    expect(result).toEqual({
      name: 'apim-explicit-api-id',
      status: 'pass',
      sourceType: 'apim-export',
      providerType: 'apim',
      specFormat: 'openapi-json'
    });

    const evidence = buildEvidence([result, toEvidenceResult('ambiguity', 'fail')]);
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.cases).toBe(2);
    expect(evidence.passed).toBe(1);
    expect(evidence.failed).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain('/subscriptions/');
  });
});

describe('committed evidence hygiene', () => {
  it('AZ-LIVE-003: committed evidence matches the schema and contains no Azure identifiers', () => {
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    if (!existsSync(evidencePath)) {
      // Before the first live run, only assert the README documents the contract.
      const readme = readFileSync(join(repoRoot, 'validation/evidence/README.md'), 'utf8');
      expect(readme).toContain('live-azure-surfaces.json');
      return;
    }
    const raw = readFileSync(evidencePath, 'utf8');
    const evidence = JSON.parse(raw) as {
      schemaVersion: number;
      capturedAt: string;
      cases: number;
      passed: number;
      failed: number;
      results: Array<{ name: string; status: string; sourceType: string; providerType: string; specFormat: string }>;
    };

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.results).toHaveLength(evidence.cases);
    expect(evidence.passed + evidence.failed).toBe(evidence.cases);
    for (const result of evidence.results) {
      expect(Object.keys(result).sort()).toEqual(['name', 'providerType', 'sourceType', 'specFormat', 'status']);
    }

    // Forbidden patterns: UUIDs, ARM IDs, SAS tokens, hostnames, bearer tokens.
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(raw).not.toContain('/subscriptions/');
    expect(raw).not.toMatch(/sig=/i);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/\.azurewebsites\.net/);
    expect(raw).not.toMatch(/Bearer /);
  });

  it('AZ-LIVE-003: evidence README reports the same pass/fail totals as the evidence JSON', () => {
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    const readme = readFileSync(join(repoRoot, 'validation/evidence/README.md'), 'utf8');
    if (!existsSync(evidencePath)) {
      expect(readme).toContain('live-azure-surfaces.json');
      return;
    }
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { cases: number; passed: number; failed: number };
    expect(readme).toContain(`${evidence.cases} cases, ${evidence.passed} passed, ${evidence.failed} failed`);
  });
});
