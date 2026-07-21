import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { actionContract, contractInputNames, contractOutputNames } from '../src/contracts.js';
import { buildExecutionOutputs, resolveInputs } from '../src/runtime.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, { description?: string }>;
};

const LOCKED_OUTPUT_ORDER = [
  'resolution-json',
  'resolution-status',
  'source-type',
  'mapping-confidence',
  'spec-path',
  'spec-files-json',
  'api-id',
  'service-name',
  'services-json',
  'service-count',
  'export-summary-json',
  'candidates-json',
  'provider-type',
  'spec-format',
  'contract-origin',
  'contract-metadata-path',
  'variant-count',
  'derived-openapi-path',
  'derived-openapi-version',
  'derived-openapi-completeness',
  'derived-openapi-format',
  'derived-openapi-evidence-json',
  'narrowing-strategy',
  'repos-json',
  'repo-count'
];

const LOCKED_INPUT_ORDER = [
  'mode',
  'subscription-id',
  'subscription-ids-json',
  'resource-group',
  'api-id',
  'environment',
  'gateway-id',
  'api-version',
  'api-revision',
  'api-center-definition-id',
  'output-dir',
  'postman-api-key',
  'postman-access-token',
  'enable-logic-apps-list-swagger',
  'require-logic-apps-native-swagger',
  'enable-app-service-scm-spec-fetch',
  'enable-functions-openapi-extension',
  'enable-runtime-declared-spec-routes',
  'runtime-declared-spec-targets-json'
];

describe('action contract', () => {
  it('AZ-CONTRACT-001: action.yml and actionContract declare the locked inputs and outputs in order', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(LOCKED_INPUT_ORDER);
    expect(contractInputNames).toEqual(LOCKED_INPUT_ORDER);
    expect(Object.keys(actionManifest.outputs)).toEqual(LOCKED_OUTPUT_ORDER);
    expect(contractOutputNames).toEqual(LOCKED_OUTPUT_ORDER);
    expect(actionContract.name).toBe('Postman Onboarding: Azure Spec Discovery');
  });

  it('AZ-CONTRACT-002: mode defaults to resolve-one, accepts discover-many, rejects anything else', () => {
    const base = { GITHUB_WORKSPACE: '/tmp/example-repo' };
    expect(resolveInputs({ ...base }).mode).toBe('resolve-one');
    expect(resolveInputs({ ...base, INPUT_MODE: 'discover-many' }).mode).toBe('discover-many');
    expect(resolveInputs({ ...base, INPUT_MODE: 'discover-estate' }).mode).toBe('discover-estate');
    expect(() => resolveInputs({ ...base, INPUT_MODE: 'anything-else' })).toThrow(
      'mode must be resolve-one, discover-many, or discover-estate, got: anything-else'
    );
  });

  it('AZ-CONTRACT-003: source-type manifest description includes discover-estate', () => {
    const sourceDescription = actionContract.outputs['source-type']?.description;
    const manifestDescription = actionManifest.outputs['source-type']?.description;
    expect(sourceDescription).toBe(manifestDescription);
    expect(sourceDescription).toContain('discover-estate');
  });

  it('AZ-CONTRACT-005: buildExecutionOutputs emits all 25 keys in every mode with locked empty behavior', () => {
    const resolveOne = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'resolved',
        sourceType: 'apim-export',
        serviceName: 'payments',
        confidence: 100,
        specPath: 'discovered-specs/payments/index.json',
        apiId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments',
        providerType: 'apim',
        specFormat: 'openapi-json',
        evidence: ['test']
      }
    });
    expect(Object.keys(resolveOne).sort()).toEqual([...LOCKED_OUTPUT_ORDER].sort());
    expect(resolveOne['services-json']).toBe('[]');
    expect(resolveOne['service-count']).toBe('0');
    expect(resolveOne['spec-files-json']).toBe('');
    expect(resolveOne['export-summary-json']).toBe(JSON.stringify({ attempted: 0, exported: 0, failed: 0, skipped: 0 }));
    expect(resolveOne['contract-origin']).toBe('');
    expect(resolveOne['contract-metadata-path']).toBe('');
    expect(resolveOne['variant-count']).toBe('');
    expect(resolveOne['candidates-json']).toBe('');

    const discoverMany = buildExecutionOutputs({
      mode: 'discover-many',
      discovered: [
        {
          serviceName: 'payments',
          specPath: 'discovered-specs/payments/index.json',
          providerType: 'apim',
          specFormat: 'openapi-json'
        }
      ],
      exportSummary: { attempted: 1, exported: 1, failed: 0, skipped: 0 }
    });
    expect(Object.keys(discoverMany).sort()).toEqual([...LOCKED_OUTPUT_ORDER].sort());
    expect(discoverMany['source-type']).toBe('discover-many');
    expect(discoverMany['resolution-status']).toBe('resolved');
    expect(discoverMany['mapping-confidence']).toBe('100');
    expect(discoverMany['service-count']).toBe('1');

    const discoverManyFailed = buildExecutionOutputs({
      mode: 'discover-many',
      discovered: [],
      exportSummary: { attempted: 2, exported: 1, failed: 1, skipped: 0 }
    });
    expect(discoverManyFailed['resolution-status']).toBe('unresolved');
    expect(discoverManyFailed['mapping-confidence']).toBe('0');

    const discoverEstate = buildExecutionOutputs({
      mode: 'discover-estate',
      discovered: [],
      estate: [{ org: 'acme', repo: 'payments', tagSources: ['postman:repo'], resourceTypes: [], resourceIds: [] }]
    });
    expect(Object.keys(discoverEstate).sort()).toEqual([...LOCKED_OUTPUT_ORDER].sort());
    expect(discoverEstate['source-type']).toBe('discover-estate');
    expect(discoverEstate['repo-count']).toBe('1');
    expect(discoverEstate['spec-path']).toBe('');
    expect(discoverEstate['spec-files-json']).toBe('');
    expect(discoverEstate['services-json']).toBe('[]');
  });

  it('AZ-CONTRACT-005b: unresolved with >=2 ranked candidates serializes candidates-json', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: 'unknown-service',
        confidence: 30,
        rankedCandidates: [
          { rank: 1, serviceName: 'a', resourceId: '/x/a', providerType: 'apim', confidence: 30, supported: true, evidence: [] },
          { rank: 2, serviceName: 'b', resourceId: '/x/b', providerType: 'apim', confidence: 30, supported: true, evidence: [] }
        ],
        evidence: []
      }
    });
    expect(outputs['resolution-status']).toBe('unresolved');
    expect(JSON.parse(outputs['candidates-json'] as string)).toHaveLength(2);
    expect(outputs['narrowing-strategy']).toBe('none');
  });
});
