import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The runner module is plain ESM with exported pure helpers; importing it must not
// execute any az command (main is gated on argv[1]).
import {
  API_CENTER_LOCATION,
  CASE_CATALOG,
  CASE_MATRIX_CONCURRENCY,
  CLEANUP_RESOURCE_ORDER,
  EVIDENCE_SCHEMA_VERSION,
  EXPECTED_CASE_CATALOG_SIZE,
  PIPELINE_ID,
  PROVISION_FLAGS,
  STUB_HEALTH_POLL_INTERVAL_MS,
  STUB_HEALTH_TIMEOUT_MS,
  SUITE_VERSION,
  assertExpectedResult,
  buildEvidence,
  classifyProbeError,
  isResourceNotFoundError,
  mapPool,
  parseFlags,
  parseProvisionFlags,
  passingLiveCaseIds,
  provisionCustomConnectorBounded,
  provisionOptionalApimApis,
  renderExecutionPlan,
  requiredEnv,
  runLiveValidation,
  resolveSubscriptionId,
  hasExactResourceIdentity,
  teardownDedicatedResourceGroup,
  teardownSharedGroupResources,
  shouldDeleteGroup,
  shouldDeleteResource,
  toEvidenceResult,
  waitForStubHealth
} from '../validation/scripts/validate-live-azure-surfaces.mjs';
import { eventGridValidationResponse } from '../validation/fixtures/azure/app-service-stub/server.mjs';

const repoRoot = process.cwd();

describe('live validation control flow', () => {
  it('AZ-LIVE-001: provisioning is owned by the shared PostmanDevOps service connection / pipeline 157', () => {
    const runbook = readFileSync(join(repoRoot, 'docs/LIVE_TESTING_RUNBOOK.md'), 'utf8');

    expect(runbook).toContain('https://dev.azure.com/PostmanDevOps');
    expect(runbook).toContain('CSE Pilots');
    expect(runbook).toContain('azure-cse-pilot-builders');
    expect(runbook).toContain('pipeline id 157');
    expect(runbook).toContain('Do not provision live-validation resources from a personal Azure subscription');
    expect(runbook).toContain('eastus');
    expect(runbook).toContain('GCP');
    expect(runbook).toContain('requires-capability');
    expect(PIPELINE_ID).toBe(157);
    expect(API_CENTER_LOCATION).toBe('eastus');
  });

  it('AZ-LIVE-002: env guard, provision/teardown flags, and the teardown marker check are enforced', () => {
    expect(() => requiredEnv({})).toThrow(/AZURE_SUBSCRIPTION_ID is required/);
    expect(() => requiredEnv({ AZURE_SUBSCRIPTION_ID: 'sub-1' })).toThrow('AZURE_LOCATION is required');
    expect(requiredEnv({ AZURE_SUBSCRIPTION_ID: 'sub-1', AZURE_LOCATION: 'eastus2' })).toEqual({
      subscriptionId: 'sub-1',
      location: 'eastus2',
      resourceGroup: ''
    });
    expect(requiredEnv({
      AZURE_SUBSCRIPTION_ID: 'sub-1',
      AZURE_LOCATION: 'eastus2',
      AZURE_RESOURCE_GROUP: 'CSE-Azure-Team'
    })).toEqual({
      subscriptionId: 'sub-1',
      location: 'eastus2',
      resourceGroup: 'CSE-Azure-Team'
    });

    // Explicit env wins; otherwise the azure-cse-pilot-builders AzureCLI@2 identity is used.
    expect(resolveSubscriptionId({ AZURE_SUBSCRIPTION_ID: 'explicit-sub' }, () => 'ignored')).toBe('explicit-sub');
    const runner = (command: string, args: string[]) => {
      expect(command).toBe('az');
      expect(args).toEqual(['account', 'show', '--query', 'id', '-o', 'tsv']);
      return 'service-connection-sub\n';
    };
    expect(resolveSubscriptionId({}, runner)).toBe('service-connection-sub');
    expect(() => resolveSubscriptionId({}, () => '   ')).toThrow(/AZURE_SUBSCRIPTION_ID is required/);

    expect(parseFlags([])).toEqual({
      provision: false,
      teardown: false,
      dryRun: false,
      renderPlan: false,
      cancelRecover: false,
      keepAlive: false
    });
    expect(parseFlags(['--provision', '--teardown', '--dry-run', '--render-plan', '--cancel-recover'])).toEqual({
      provision: true,
      teardown: true,
      dryRun: true,
      renderPlan: true,
      cancelRecover: true,
      keepAlive: false
    });
    expect(parseFlags(['--provision', '--keep-alive']).keepAlive).toBe(true);

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

    const matchingResource = {
      name: 'pmspecsiteabcd1234',
      type: 'Microsoft.Web/sites',
      id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.Web/sites/pmspecsiteabcd1234',
      tags: { 'postman:run-marker': manifest.runMarker }
    };
    const sharedManifest = { ...manifest, resourceGroup: 'CSE-Azure-Team' };
    const deleteInput = {
      manifest: sharedManifest,
      resourceShow: matchingResource,
      subscriptionId: 'sub-1',
      expectedName: matchingResource.name,
      expectedType: matchingResource.type
    };
    expect(shouldDeleteResource(deleteInput)).toBe(true);
    expect(shouldDeleteResource({ ...deleteInput, subscriptionId: 'sub-2' })).toBe(false);
    expect(shouldDeleteResource({ ...deleteInput, expectedName: 'another-site' })).toBe(false);
    expect(shouldDeleteResource({
      ...deleteInput,
      resourceShow: { ...matchingResource, tags: { 'postman:run-marker': 'another-run' } }
    })).toBe(false);

    // Untagged nested resources need their complete ARM identity; their own id
    // alone cannot bypass the separately verified run-marked parent check.
    const eventSubscription = {
      name: 'pmspeceg/pmspecegsub',
      type: 'Microsoft.EventGrid/topics/eventSubscriptions',
      id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.EventGrid/topics/pmspeceg/eventSubscriptions/pmspecegsub'
    };
    expect(hasExactResourceIdentity({
      manifest: sharedManifest,
      resourceShow: eventSubscription,
      subscriptionId: 'sub-1',
      expectedName: eventSubscription.name,
      expectedType: eventSubscription.type
    })).toBe(true);
    expect(hasExactResourceIdentity({
      manifest: sharedManifest,
      resourceShow: eventSubscription,
      subscriptionId: 'sub-2',
      expectedName: eventSubscription.name,
      expectedType: eventSubscription.type
    })).toBe(false);
    expect(shouldDeleteResource({
      manifest: sharedManifest,
      resourceShow: eventSubscription,
      subscriptionId: 'sub-1',
      expectedName: eventSubscription.name,
      expectedType: eventSubscription.type
    })).toBe(false);
  });

  it('AZ-LIVE-002: export-probe errors are classified so fatal failures never poll out the ceiling', () => {
    expect(classifyProbeError('AuthorizationFailed: the client does not have authorization')).toBe('fatal');
    expect(classifyProbeError('InvalidAuthenticationToken: expired')).toBe('fatal');
    expect(classifyProbeError('Operation returned 403 Forbidden')).toBe('fatal');
    expect(classifyProbeError('BadRequest: unsupported format parameter')).toBe('fatal');
    expect(classifyProbeError('Request failed with status 400')).toBe('fatal');

    expect(classifyProbeError('ResourceNotFound: 404 the api was not found')).toBe('retryable');
    expect(classifyProbeError('ServiceUpdating: the service is being updated')).toBe('retryable');
    expect(classifyProbeError('Request failed with status 503')).toBe('retryable');
    expect(classifyProbeError('')).toBe('retryable');
  });

  it('AZ-LIVE-002: teardown treats an already-absent resource as successfully cleaned', () => {
    expect(isResourceNotFoundError(new Error('ResourceNotFound: the resource was not found'))).toBe(true);
    expect(isResourceNotFoundError('Resource group could not be found')).toBe(true);
    expect(isResourceNotFoundError("Operation returned an invalid status 'Not Found'")).toBe(true);
    expect(isResourceNotFoundError(new Error('AuthorizationFailed'))).toBe(false);
  });

  it('AZ-LIVE-002: untagged nested resources cannot bypass a mismatched root marker', async () => {
    const commands: string[][] = [];
    const manifest = {
      resourceGroup: 'CSE-Azure-Team',
      runMarker: 'run-1',
      eventGridTopicName: 'topic-1',
      eventGridSubName: 'sub-1'
    };
    const runner = (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === 'resource' && args[1] === 'show' && args.includes('eventSubscriptions')) {
        return JSON.stringify({
          name: 'topic-1/sub-1',
          type: 'Microsoft.EventGrid/topics/eventSubscriptions',
          id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.EventGrid/topics/topic-1/eventSubscriptions/sub-1'
        });
      }
      if (args[0] === 'resource' && args[1] === 'show') {
        return JSON.stringify({
          name: 'topic-1',
          type: 'Microsoft.EventGrid/topics',
          id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.EventGrid/topics/topic-1',
          tags: { 'postman:run-marker': 'other-run' }
        });
      }
      if (args[0] === 'resource' && args[1] === 'list') return '[]';
      if (args[0] === 'graph') return JSON.stringify({ data: [] });
      throw new Error(`unexpected command ${args.join(' ')}`);
    };

    await teardownSharedGroupResources({ runner, log: () => undefined, manifest, subscriptionId: 'sub-1' });
    expect(commands.some((args) => args[0] === 'resource' && args[1] === 'delete')).toBe(false);
  });

  it('AZ-LIVE-002: verified shared-group deletes are asynchronous before the bounded absence audit', async () => {
    const commands: string[][] = [];
    let deploymentShowCount = 0;
    const runner = (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'show') {
        deploymentShowCount += 1;
        return JSON.stringify({
          properties: { provisioningState: deploymentShowCount === 1 ? 'Running' : 'Canceled' }
        });
      }
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'cancel') return '';
      if (args[0] === 'resource' && args[1] === 'show') {
        return JSON.stringify({
          name: 'apim-1',
          type: 'Microsoft.ApiManagement/service',
          id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.ApiManagement/service/apim-1',
          tags: { 'postman:run-marker': 'run-1' }
        });
      }
      if (args[0] === 'resource' && args[1] === 'delete') return '';
      if (args[0] === 'resource' && args[1] === 'list') return '[]';
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'delete') return '';
      if (args[0] === 'graph') return JSON.stringify({ data: [] });
      throw new Error(`unexpected command ${args.join(' ')}`);
    };

    await teardownSharedGroupResources({
      runner,
      log: () => undefined,
      manifest: {
        resourceGroup: 'CSE-Azure-Team',
        runMarker: 'run-1',
        apimName: 'apim-1',
        deploymentName: 'deployment-1'
      },
      subscriptionId: 'sub-1'
    });

    expect(commands).toContainEqual([
      'deployment',
      'group',
      'cancel',
      '--resource-group',
      'CSE-Azure-Team',
      '--name',
      'deployment-1'
    ]);
    expect(commands.findIndex((args) => args[2] === 'cancel')).toBeLessThan(
      commands.findIndex((args) => args[0] === 'resource' && args[1] === 'delete')
    );
    expect(commands).toContainEqual([
      'resource',
      'delete',
      '--ids',
      '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team/providers/Microsoft.ApiManagement/service/apim-1',
      '--no-wait'
    ]);
    expect(commands.some((args) => args[0] === 'resource' && args[1] === 'list')).toBe(true);
    expect(commands).toContainEqual([
      'deployment',
      'group',
      'delete',
      '--resource-group',
      'CSE-Azure-Team',
      '--name',
      'deployment-1',
      '--no-wait'
    ]);
  });

  it('AZ-LIVE-002: evidence construction sanitizes case results down to schema v2', () => {
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
      id: 'apim-explicit-api-id',
      name: 'apim-explicit-api-id',
      status: 'pass',
      sourceType: 'apim-export',
      providerType: 'apim',
      specFormat: 'openapi-json',
      contractClass: 'authoritative'
    });

    const evidence = buildEvidence([
      result,
      toEvidenceResult('ambiguity', 'fail', { reasonCode: 'cli-failed' }),
      toEvidenceResult('service-bus-topic-partial', 'requires-capability', { reasonCode: 'cost-guard-blocked' }),
      toEvidenceResult('local-r3-format-parser-matrix', 'local-only', { reasonCode: 'local-only-matrix' })
    ], { testedCommitHashPrefix: 'b0047c2' });
    expect(evidence.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(evidence.suiteVersion).toBe(SUITE_VERSION);
    expect(evidence.testedCommitHashPrefix).toBe('b0047c2');
    expect(evidence.cases).toBe(4);
    expect(evidence.passed).toBe(1);
    expect(evidence.failed).toBe(1);
    expect(evidence.requiresCapability).toBe(1);
    expect(evidence.localOnly).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain('/subscriptions/');
    expect(passingLiveCaseIds(evidence).has('service-bus-topic-partial')).toBe(false);
    expect(passingLiveCaseIds(evidence).has('apim-explicit-api-id')).toBe(true);
  });
});

describe('R8 harness matrix contract', () => {
  it('AZ-LIVE-010: case catalog is exactly 31 unique ids covering the safe matrix', () => {
    const ids = CASE_CATALOG.map((row) => row.id);
    expect(CASE_CATALOG.length).toBe(EXPECTED_CASE_CATALOG_SIZE);
    expect(new Set(ids).size).toBe(EXPECTED_CASE_CATALOG_SIZE);
    for (const baseline of [
      'apim-explicit-api-id',
      'apim-discovery',
      'app-service-api-definition',
      'discover-many',
      'iac-single',
      'ambiguity'
    ]) {
      expect(ids).toContain(baseline);
    }
    expect(ids).toContain('apim-clean-repo-tag');
    expect(ids).toContain('apim-clean-repo-github-org-repo-pair');
    expect(ids).toContain('apim-gateway-host-path');
    expect(ids).toContain('apim-version-revision-ambiguity');
    expect(ids).toContain('api-center-openapi-export');
    expect(ids).toContain('api-center-native-non-openapi');
    expect(ids).toContain('logic-apps-list-swagger');
    expect(ids).toContain('function-bindings-openapi-extension');
    expect(ids).toContain('app-service-apispecpath-runtime');
    expect(ids).toContain('event-grid-webhook-partial');
    expect(ids).toContain('service-bus-topic-partial');
    expect(ids).toContain('local-r3-format-parser-matrix');
    const gateway = CASE_CATALOG.find((row) => row.id === 'apim-gateway-host-path');
    expect(gateway?.claimFacets).toEqual([
      'association.gateway-hostname-hint',
      'association.clean-repo-host-path'
    ]);
    expect(PROVISION_FLAGS['service-bus-standard']).toBe(false);
    expect(CLEANUP_RESOURCE_ORDER[0]?.type).toMatch(/EventGrid|ServiceBus|ApiCenter|Web|Logic|Resources|ApiManagement/);
  });

  it('AZ-LIVE-013: assertExpectedResult rejects catalog metadata mismatch and placeholder fallbacks', () => {
    expect(() =>
      assertExpectedResult('apim-soap-wsdl', {
        status: 'resolved',
        sourceType: 'apim-export',
        providerType: 'apim',
        specFormat: 'openapi-json',
        contractClass: 'authoritative'
      })
    ).toThrow(/specFormat/);

    expect(() =>
      assertExpectedResult('logic-apps-list-swagger', {
        status: 'resolved',
        sourceType: 'logic-apps-workflow',
        providerType: 'logic-apps',
        specFormat: 'openapi-json',
        contractClass: 'partial',
        evidence: ['Synthesized partial OpenAPI']
      }, { forbiddenEvidence: 'Synthesized partial' })
    ).toThrow(/forbidden evidence/i);

    const ok = assertExpectedResult('apim-explicit-api-id', {
      status: 'resolved',
      sourceType: 'apim-export',
      providerType: 'apim',
      specFormat: 'openapi-json',
      contractClass: 'authoritative',
      apiId: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.ApiManagement/service/s/apis/payments-live'
    }, { expectedApiIdSuffix: '/apis/payments-live' });
    expect(ok.contractClass).toBe('authoritative');
  });

  it('AZ-LIVE-014: dedicated resource-group teardown awaits absence and fails on residue', async () => {
    const calls: string[][] = [];
    let showCount = 0;
    const runner = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'group' && args[1] === 'show') {
        showCount += 1;
        if (showCount === 1) {
          return JSON.stringify({
            name: 'postman-azure-spec-live-abcd',
            id: '/subscriptions/sub-1/resourceGroups/postman-azure-spec-live-abcd',
            tags: { 'postman-azure-spec-discovery-live-run': 'run-1' }
          });
        }
        throw new Error('ResourceGroupNotFound: could not be found');
      }
      if (args[0] === 'group' && args[1] === 'delete') return '';
      if (args[0] === 'graph') return JSON.stringify({ data: [] });
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    await teardownDedicatedResourceGroup({
      runner,
      log: () => undefined,
      manifest: { resourceGroup: 'postman-azure-spec-live-abcd', runMarker: 'run-1' },
      subscriptionId: 'sub-1',
      now: () => 0,
      sleep: async () => undefined
    });
    expect(calls.some((args) => args[0] === 'group' && args[1] === 'delete')).toBe(true);
    expect(calls.some((args) => args[0] === 'group' && args[1] === 'delete' && args.includes('--no-wait'))).toBe(
      false
    );

    await expect(
      teardownDedicatedResourceGroup({
        runner: (_c, args) => {
          if (args[0] === 'group' && args[1] === 'show') {
            return JSON.stringify({
              name: 'postman-azure-spec-live-abcd',
              id: '/subscriptions/sub-1/resourceGroups/postman-azure-spec-live-abcd',
              tags: { 'postman-azure-spec-discovery-live-run': 'run-1' }
            });
          }
          if (args[0] === 'group' && args[1] === 'delete') return '';
          if (args[0] === 'graph') return JSON.stringify({ data: [{ id: '/x' }] });
          return '';
        },
        log: () => undefined,
        manifest: { resourceGroup: 'postman-azure-spec-live-abcd', runMarker: 'run-1' },
        subscriptionId: 'sub-1',
        now: (() => {
          let t = 0;
          return () => {
            t += 10 * 60 * 1000;
            return t;
          };
        })(),
        sleep: async () => undefined
      })
    ).rejects.toThrow(/timed out|residual/i);
  });

  it('AZ-LIVE-011: dry-run/render-plan proves commands/cases/cleanup without Azure credentials', async () => {
    const { runLiveValidation } = await import('../validation/scripts/validate-live-azure-surfaces.mjs');
    const calls: string[] = [];
    const evidence = await runLiveValidation({
      argv: ['--dry-run', '--render-plan'],
      env: { AZURE_LIVE_COMMIT_PREFIX: 'deadbee' },
      deps: {
        runner: (command: string) => {
          calls.push(command);
          throw new Error('runner must not be invoked in dry-run');
        },
        log: () => undefined
      }
    });

    expect(calls).toEqual([]);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.suiteVersion).toBe(SUITE_VERSION);
    expect(evidence.testedCommitHashPrefix).toBe('deadbee');
    expect(evidence.cases).toBe(CASE_CATALOG.length);
    expect(evidence.passed).toBe(0);
    expect(evidence.results.every((row) => row.status === 'requires-capability' || row.status === 'local-only')).toBe(
      true
    );
    expect(evidence.results.some((row) => row.id === 'local-r3-format-parser-matrix' && row.status === 'local-only')).toBe(
      true
    );
    expect(evidence.results.some((row) => row.id === 'service-bus-topic-partial' && row.reasonCode === 'cost-guard-blocked')).toBe(
      true
    );

    const plan = renderExecutionPlan({
      provisionFlags: parseProvisionFlags({ AZURE_LIVE_PROVISION_FLAGS: '!api-center,service-bus-standard' }),
      flags: parseFlags(['--dry-run'])
    });
    expect(plan.pipelineId).toBe(157);
    expect(plan.apiCenterLocation).toBe('eastus');
    expect(plan.provisionFlags['api-center']).toBe(false);
    expect(plan.provisionFlags['service-bus-standard']).toBe(true);
    expect(plan.cleanupOrder.length).toBe(CLEANUP_RESOURCE_ORDER.length);
    expect(plan.notes.some((note) => /personal subscription/i.test(note))).toBe(true);
    expect(plan.cases.find((row) => row.id === 'api-center-openapi-export')?.plannedStatus).toBe('requires-capability');
  });

  it('AZ-LIVE-012: fixtures required by the expanded harness exist', () => {
    const required = [
      'validation/fixtures/azure/live-stack.bicep',
      'validation/fixtures/azure/extended-stack.bicep',
      'validation/fixtures/azure/apim-apis/soap.wsdl',
      'validation/fixtures/azure/apim-apis/schema.graphql',
      'validation/fixtures/azure/apim-apis/orders-live.json',
      'validation/fixtures/azure/local-r3/specs/openapi.yaml',
      'validation/fixtures/azure/local-r3/specs/service.proto',
      'validation/fixtures/azure/app-service-stub/openapi.json',
      'validation/fixtures/azure/iac-single/main.json'
    ];
    for (const rel of required) {
      expect(existsSync(join(repoRoot, rel)), rel).toBe(true);
    }
    const liveStack = readFileSync(join(repoRoot, 'validation/fixtures/azure/live-stack.bicep'), 'utf8');
    expect(liveStack).toContain('provisionMultiApi');
    expect(liveStack).toContain('postman:repo');
    expect(liveStack).toContain('GithubOrg');
    expect(liveStack).toMatch(/name:\s*'B1'/);
    expect(liveStack).toMatch(/tier:\s*'Basic'/);
    expect(liveStack).toMatch(/alwaysOn:\s*true/);
    expect(liveStack).not.toMatch(/name:\s*'F1'/);
    expect(liveStack).toMatch(/service-inherited|path-selects payments-live|Clean-repo isolation/i);
    const revisionStart = liveStack.indexOf('resource paymentsApiRev2');
    const revisionEnd = liveStack.indexOf('resource ordersApi');
    const revisionBlock = revisionStart >= 0 && revisionEnd > revisionStart
      ? liveStack.slice(revisionStart, revisionEnd)
      : '';
    expect(revisionBlock).toContain('sourceApiId: paymentsApi.id');
    expect(revisionBlock).not.toMatch(/\bapiVersionSetId\s*:/);
    expect(revisionBlock).not.toMatch(/\bapiVersion\s*:/);
    const extended = readFileSync(join(repoRoot, 'validation/fixtures/azure/extended-stack.bicep'), 'utf8');
    expect(extended).toContain('Microsoft.Logic/workflows');
    expect(extended).toContain('Microsoft.EventGrid/topics');
    expect(extended).toContain('templateSpecs');
    const runbook = readFileSync(join(repoRoot, 'docs/LIVE_TESTING_RUNBOOK.md'), 'utf8');
    expect(runbook).toMatch(/GITHUB_REPOSITORY/);
    expect(runbook).toMatch(/terminal absence|awaits group deletion/i);
  });

  it('AZ-LIVE-015: provisioning failure writes sanitized failure evidence after shared-group teardown, then rethrows', async () => {
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    const hadEvidence = existsSync(evidencePath);
    const baseline = hadEvidence ? readFileSync(evidencePath, 'utf8') : undefined;
    const originalFailure = new Error('provisioning exploded with secret=do-not-persist');
    const runner = (command: string, args: string[]) => {
      if (command !== 'az') throw new Error(`unexpected command ${command}`);
      if (args[0] === 'account') return '';
      if (args[0] === 'group' && args[1] === 'show') {
        return JSON.stringify({ name: 'CSE-Azure-Team', id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team' });
      }
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'create') throw originalFailure;
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'show') throw new Error('ResourceNotFound');
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'delete') return '';
      if (args[0] === 'resource' && args[1] === 'show') throw new Error('ResourceNotFound');
      if (args[0] === 'resource' && args[1] === 'list') return '[]';
      if (args[0] === 'graph') return JSON.stringify({ data: [] });
      throw new Error(`unexpected az command ${args.join(' ')}`);
    };

    try {
      await expect(runLiveValidation({
        argv: ['--provision', '--teardown'],
        env: {
          AZURE_SUBSCRIPTION_ID: 'sub-1',
          AZURE_LOCATION: 'eastus2',
          AZURE_RESOURCE_GROUP: 'CSE-Azure-Team',
          AZURE_LIVE_COMMIT_PREFIX: 'f3c7775'
        },
        deps: { runner, log: () => undefined }
      })).rejects.toBe(originalFailure);

      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      expect(evidence).toMatchObject({
        schemaVersion: 2,
        testedCommitHashPrefix: 'f3c7775',
        cases: 1,
        failed: 1,
        results: [{ id: 'runner', status: 'fail', reasonCode: 'cli-failed' }]
      });
      expect(JSON.stringify(evidence)).not.toContain('do-not-persist');
    } finally {
      if (hadEvidence) writeFileSync(evidencePath, baseline!, 'utf8');
      else rmSync(evidencePath, { force: true });
    }
  });

  it('AZ-LIVE-016: the disposable webhook completes Event Grid subscription validation', () => {
    expect(eventGridValidationResponse([
      {
        eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
        data: { validationCode: 'challenge-code' }
      }
    ])).toEqual({ validationResponse: 'challenge-code' });
    expect(eventGridValidationResponse([{ eventType: 'ordinary-event', data: {} }])).toBeUndefined();
    expect(eventGridValidationResponse({})).toBeUndefined();
  });

  it('AZ-LIVE-017: evidence phases and per-case durationMs are additive sanitized timing fields', () => {
    expect(STUB_HEALTH_TIMEOUT_MS).toBe(120_000);
    expect(STUB_HEALTH_POLL_INTERVAL_MS).toBe(5_000);
    expect(CASE_MATRIX_CONCURRENCY).toBe(5);

    const evidence = buildEvidence(
      [
        toEvidenceResult('apim-explicit-api-id', 'pass', { durationMs: 12.7 }),
        toEvidenceResult('ambiguity', 'fail', { reasonCode: 'cli-failed', durationMs: 3 })
      ],
      {
        testedCommitHashPrefix: 'abc1234',
        phases: [
          { name: 'live-stack-deploy', durationMs: 100 },
          { name: 'parallel-provision', durationMs: 200 },
          { name: 'extended-stack', durationMs: 50 },
          { name: 'apim-export-ready', durationMs: 40 },
          { name: 'case-matrix', durationMs: 80 },
          { name: 'teardown', durationMs: 30 }
        ]
      }
    );

    expect(evidence.phases).toEqual([
      { name: 'live-stack-deploy', durationMs: 100 },
      { name: 'parallel-provision', durationMs: 200 },
      { name: 'extended-stack', durationMs: 50 },
      { name: 'apim-export-ready', durationMs: 40 },
      { name: 'case-matrix', durationMs: 80 },
      { name: 'teardown', durationMs: 30 }
    ]);
    expect(evidence.results[0]?.durationMs).toBe(13);
    expect(evidence.results[1]?.durationMs).toBe(3);
    expect(JSON.stringify(evidence)).not.toMatch(/\.azurewebsites\.net/);
    expect(JSON.stringify(evidence)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('AZ-LIVE-018: case-matrix mapPool preserves catalog order under out-of-order completion', async () => {
    const order = CASE_CATALOG.map((row) => row.id).slice(0, 8);
    expect(CASE_MATRIX_CONCURRENCY).toBe(5);

    const deferred = order.map(() => {
      let resolve!: (value: string) => void;
      const promise = new Promise<string>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    });

    const running = mapPool(order, CASE_MATRIX_CONCURRENCY, async (id, index) => deferred[index]!.promise);

    // Complete in reverse so pool workers finish out of catalog order.
    for (let i = order.length - 1; i >= 0; i -= 1) {
      deferred[i]!.resolve(order[i]!);
    }

    await expect(running).resolves.toEqual(order);
  });

  it('AZ-LIVE-019: failed stub health gate skips extended-stack and marks event-grid capability-absent', async () => {
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    const hadEvidence = existsSync(evidencePath);
    const baseline = hadEvidence ? readFileSync(evidencePath, 'utf8') : undefined;
    const commands: string[][] = [];
    let t = 0;
    const runner = (command: string, args: string[]) => {
      if (command === 'zip') return '';
      if (command !== 'az') throw new Error(`unexpected command ${command}`);
      commands.push(args);
      if (args[0] === 'account') return '';
      if (args[0] === 'group' && args[1] === 'show') {
        return JSON.stringify({
          name: 'CSE-Azure-Team',
          id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team'
        });
      }
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'create') {
        if (args.includes('validation/fixtures/azure/extended-stack.bicep')) {
          throw new Error('extended-stack must not be deployed when health gate fails');
        }
        return '';
      }
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'show') {
        throw new Error('ResourceNotFound');
      }
      if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'delete') return '';
      if (args[0] === 'webapp' && args[1] === 'deploy') return '';
      if (args[0] === 'webapp' && args[1] === 'show') {
        return JSON.stringify({ defaultHostName: 'pmspecsiteabcd.azurewebsites.net' });
      }
      if (args[0] === 'rest' && args.includes('--method') && args.includes('get')) {
        return JSON.stringify({ link: 'https://example.invalid/export' });
      }
      if (args[0] === 'rest') return '';
      if (args[0] === 'provider') {
        return JSON.stringify({ registrationState: 'NotRegistered' });
      }
      if (args[0] === 'resource' && args[1] === 'show') throw new Error('ResourceNotFound');
      if (args[0] === 'resource' && args[1] === 'list') return '[]';
      if (args[0] === 'graph') return JSON.stringify({ data: [] });
      return '';
    };

    try {
      const evidence = await runLiveValidation({
        argv: ['--provision', '--teardown'],
        env: {
          AZURE_SUBSCRIPTION_ID: 'sub-1',
          AZURE_LOCATION: 'eastus2',
          AZURE_RESOURCE_GROUP: 'CSE-Azure-Team',
          AZURE_LIVE_COMMIT_PREFIX: 'a1b2c3d',
          AZURE_LIVE_PROVISION_FLAGS: '!api-center,!service-bus-standard'
        },
        deps: {
          runner,
          log: () => undefined,
          sleep: async () => undefined,
          now: () => {
            // Jump in large steps so the 120s health-gate ceiling elapses quickly in unit tests.
            t += 60_000;
            return t;
          },
          fetch: (async () => ({ status: 503 })) as unknown as typeof fetch,
          runCases: async ({
            capabilities
          }: {
            capabilities: Record<string, { ok: boolean; reasonCode?: string }>;
          }) => {
            expect(capabilities['event-grid']).toEqual({ ok: false, reasonCode: 'capability-absent' });
            return [
              toEvidenceResult('event-grid-webhook-partial', 'requires-capability', {
                reasonCode: 'capability-absent',
                durationMs: 1
              })
            ];
          }
        }
      });

      expect(
        commands.some(
          (args) =>
            args[0] === 'deployment' &&
            args[2] === 'create' &&
            args.includes('validation/fixtures/azure/extended-stack.bicep')
        )
      ).toBe(false);
      expect(evidence.phases?.some((phase) => phase.name === 'extended-stack')).toBe(true);
      expect(evidence.phases?.every((phase) => typeof phase.durationMs === 'number')).toBe(true);
      expect(evidence.results[0]?.durationMs).toBe(1);
      expect(evidence.results[0]?.reasonCode).toBe('capability-absent');
      expect(JSON.stringify(evidence)).not.toContain('pmspecsiteabcd');
    } finally {
      if (hadEvidence) writeFileSync(evidencePath, baseline!, 'utf8');
      else rmSync(evidencePath, { force: true });
    }
  });

  it('AZ-LIVE-020: websocket inventory omits an unverified backend URL', async () => {
    const bodies: string[] = [];
    const runner = (_command: string, args: string[]) => {
      if (args[0] === 'rest' && args.includes('put')) {
        const bodyIdx = args.indexOf('--body');
        if (bodyIdx >= 0) bodies.push(String(args[bodyIdx + 1] ?? ''));
      }
      return '';
    };
    const capabilities: Record<string, { ok: boolean; reasonCode?: string }> = {};
    await provisionOptionalApimApis({
      runner,
      log: () => undefined,
      manifest: {
        resourceGroup: 'CSE-Azure-Team',
        apimName: 'pmspecapimabcd',
        siteName: 'pmspecsiteabcd',
        resources: []
      },
      subscriptionId: 'sub-1',
      provisionFlags: {
        'apim-soap': false,
        'apim-graphql': false,
        'apim-websocket': true,
        'apim-grpc': false,
        'apim-odata': false
      },
      capabilities
    });

    expect(capabilities['apim-websocket']).toEqual({ ok: true });
    const websocketBody = bodies.find((body) => body.includes('"type":"websocket"'));
    expect(websocketBody).toBeTruthy();
    expect(websocketBody).not.toContain('serviceUrl');
  });

  it('AZ-LIVE-021: waitForStubHealth returns false on persistent non-200 without hanging', async () => {
    let probes = 0;
    const ok = await waitForStubHealth({
      url: 'https://example.invalid/health',
      timeoutMs: 20,
      intervalMs: 5,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })(),
      sleep: async () => undefined,
      fetchImpl: (async () => {
        probes += 1;
        return { status: 503 };
      }) as unknown as typeof fetch,
      log: () => undefined
    });
    expect(ok).toBe(false);
    expect(probes).toBeGreaterThan(0);
  });

  it('AZ-LIVE-023: custom connector provisioning is isolated and command-bounded', async () => {
    const calls: Array<{ args: string[]; options?: Record<string, unknown> }> = [];
    const capabilities: Record<string, { ok: boolean; reasonCode?: string }> = {};
    await provisionCustomConnectorBounded({
      asyncRunner: async (_command, args, options) => {
        calls.push({ args, options });
        if (args[0] === 'rest' && args.includes('get')) {
          return JSON.stringify({ location: 'eastus', tags: {} });
        }
        throw new Error('InternalServerError');
      },
      log: () => undefined,
      manifest: {
        resourceGroup: 'CSE-Azure-Team',
        customConnectorName: 'pmspecconnabcd1234',
        runMarker: 'persistent-abcd1234',
        resources: []
      },
      subscriptionId: 'sub-1',
      location: 'eastus2',
      provisionFlags: { 'custom-connector': true },
      capabilities,
      siteHostname: 'pmspecsiteabcd1234.azurewebsites.net'
    });

    expect(capabilities['custom-connector']).toEqual({ ok: false, reasonCode: 'capability-absent' });
    const put = calls.find((call) => call.args[0] === 'rest' && call.args.includes('put'));
    expect(put?.options).toEqual({ timeout: 30_000 });
    expect(put?.args.join(' ')).toContain('pmspecsiteabcd1234.azurewebsites.net');
    expect(put?.args.join(' ')).toContain('"location":"eastus"');
    const bicep = readFileSync(join(repoRoot, 'validation/fixtures/azure/extended-stack.bicep'), 'utf8');
    expect(bicep).not.toContain('Microsoft.Web/customApis');
    expect(bicep).not.toContain('customConnectorName');
  });

  it('AZ-LIVE-022: keep-alive requires a persistent suffix, refuses --teardown, and never tears down', async () => {
    await expect(runLiveValidation({
      argv: ['--provision', '--keep-alive'],
      env: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_LOCATION: 'eastus2',
        AZURE_RESOURCE_GROUP: 'CSE-Azure-Team'
      },
      deps: { runner: () => '', log: () => undefined }
    })).rejects.toThrow(/AZURE_LIVE_PERSISTENT_SUFFIX/);

    await expect(runLiveValidation({
      argv: ['--provision', '--keep-alive', '--teardown'],
      env: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_LOCATION: 'eastus2',
        AZURE_RESOURCE_GROUP: 'CSE-Azure-Team',
        AZURE_LIVE_PERSISTENT_SUFFIX: 'c5e1feed'
      },
      deps: { runner: () => '', log: () => undefined }
    })).rejects.toThrow(/mutually exclusive/);

    // Full keep-alive pass: existing persistent APIM short-circuits live-stack deploy and no delete is ever issued.
    const commands: string[][] = [];
    const runner = (command: string, args: string[]) => {
      if (command === 'zip') return '';
      if (command !== 'az') return '';
      commands.push(args);
      if (args[0] === 'account') return args.includes('--query') ? 'sub-1\n' : '';
      if (args[0] === 'group' && args[1] === 'show') {
        return JSON.stringify({ name: 'CSE-Azure-Team', id: '/subscriptions/sub-1/resourceGroups/CSE-Azure-Team' });
      }
      if (args[0] === 'resource' && args[1] === 'show' && args.includes('Microsoft.ApiManagement/service')) {
        return JSON.stringify({
          tags: { 'postman:run-marker': 'persistent-c5e1feed' }
        });
      }
      if (args[0] === 'resource' && args[1] === 'show') {
        return JSON.stringify({ id: '/subscriptions/sub-1/rg/plan' });
      }
      if (args[0] === 'webapp' && args[1] === 'show') {
        return JSON.stringify({ defaultHostName: 'stub.azurewebsites.net' });
      }
      if (args[0] === 'webapp') return '';
      if (args[0] === 'rest') {
        return JSON.stringify({ link: 'https://example.invalid/export' });
      }
      if (args[0] === 'deployment') return '';
      if (args[0] === 'apic') return '';
      return '';
    };
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    const hadEvidence = existsSync(evidencePath);
    const baseline = hadEvidence ? readFileSync(evidencePath, 'utf8') : undefined;
    try {
      await runLiveValidation({
        argv: ['--provision', '--keep-alive'],
        env: {
          AZURE_SUBSCRIPTION_ID: 'sub-1',
          AZURE_LOCATION: 'eastus2',
          AZURE_RESOURCE_GROUP: 'CSE-Azure-Team',
          AZURE_LIVE_COMMIT_PREFIX: 'f3c7775',
          AZURE_LIVE_PERSISTENT_SUFFIX: 'c5e1feed',
          AZURE_LIVE_CASE_FILTER: 'apim-explicit-api-id, iac-single',
          AZURE_LIVE_PROVISION_FLAGS: '!apim-multi,!apim-soap,!apim-graphql,!apim-websocket,!apim-grpc,!apim-odata,!api-center,!logic-app,!custom-connector,!template-spec,!event-grid,!function-app'
        },
        deps: {
          runner,
          log: () => undefined,
          sleep: async () => undefined,
          fetch: (async () => ({ status: 200 })) as unknown as typeof fetch,
          runCases: async ({ caseFilter }: { caseFilter: string[] }) => {
            expect(caseFilter).toEqual(['apim-explicit-api-id', 'iac-single']);
            return [];
          }
        }
      });
    } finally {
      if (hadEvidence) writeFileSync(evidencePath, baseline!, 'utf8');
      else rmSync(evidencePath, { force: true });
    }
    const flat = commands.map((args) => args.join(' '));
    expect(flat.some((line) => line.startsWith('deployment group create'))).toBe(false);
    expect(flat.some((line) => line.includes('delete'))).toBe(false);
  });
});

describe('committed evidence hygiene', () => {
  it('AZ-LIVE-003: committed evidence matches schema v2 and contains no Azure identifiers', () => {
    const evidencePath = join(repoRoot, 'validation/evidence/live-azure-surfaces.json');
    if (!existsSync(evidencePath)) {
      const readme = readFileSync(join(repoRoot, 'validation/evidence/README.md'), 'utf8');
      expect(readme).toContain('live-azure-surfaces.json');
      return;
    }
    const raw = readFileSync(evidencePath, 'utf8');
    const evidence = JSON.parse(raw) as {
      schemaVersion: number;
      suiteVersion: string;
      capturedAt: string;
      cases: number;
      passed: number;
      failed: number;
      requiresCapability: number;
      localOnly: number;
      results: Array<{
        id: string;
        name: string;
        status: string;
        sourceType: string;
        providerType: string;
        specFormat: string;
        contractClass: string;
      }>;
    };

    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.suiteVersion).toBe(SUITE_VERSION);
    expect(evidence.results).toHaveLength(evidence.cases);
    expect(evidence.passed + evidence.failed + evidence.requiresCapability + evidence.localOnly).toBe(evidence.cases);
    // Historical baseline remains truthful: six passes, no invented expanded passes.
    expect(evidence.passed).toBe(6);
    expect(evidence.cases).toBe(6);
    for (const result of evidence.results) {
      expect(result.id).toBe(result.name);
      expect(result.status).toBe('pass');
      expect(result.contractClass).toBeTruthy();
    }

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
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      cases: number;
      passed: number;
      failed: number;
      requiresCapability: number;
      localOnly: number;
    };
    expect(readme).toContain(
      `${evidence.cases} cases, ${evidence.passed} passed, ${evidence.failed} failed, ${evidence.requiresCapability} requires-capability, ${evidence.localOnly} local-only`
    );
    expect(readme).toContain('requires-capability');
    expect(readme).toContain('schema v2');
  });
});
