#!/usr/bin/env node
/* global console, process, URL */
// Live Azure validation runner (R8 / POS-396).
//
// Operator-triggered only; never wired into pull-request CI. Preferred path is
// Azure DevOps pipeline id 157 (`postman-azure-spec-discovery-live-validation`)
// in PostmanDevOps/CSE Pilots, service connection `azure-cse-pilot-builders`.
// That pipeline enforces an exact immutable githubRef; this harness records only
// a short commit correlation hash (or suite/case-set version), never raw IDs.
//
// Local equivalent (only when already authenticated as that same service-
// connection identity — never a personal subscription):
//   npm run build
//   AZURE_LOCATION=eastus2 \
//     node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
//
// Dry-run / render (no Azure credentials):
//   node validation/scripts/validate-live-azure-surfaces.mjs --dry-run --render-plan
//
// Cancellation recovery (re-enter teardown for a prior run marker):
//   AZURE_LIVE_RESUME_SUFFIX=... AZURE_LIVE_RESUME_MARKER=... \
//     node validation/scripts/validate-live-azure-surfaces.mjs --teardown --cancel-recover

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = process.cwd();
export const SUITE_VERSION = 'r8-pos-396-v1';
export const EVIDENCE_SCHEMA_VERSION = 2;
export const API_CENTER_LOCATION = 'eastus';
export const RUN_MARKER_TAG = 'postman-azure-spec-discovery-live-run';
export const RESOURCE_RUN_MARKER_TAG = 'postman:run-marker';
export const PIPELINE_ID = 157;
export const PIPELINE_NAME = 'postman-azure-spec-discovery-live-validation';

const APIM_READY_TIMEOUT_MS = 5 * 60 * 1000;
const APIM_POLL_INTERVAL_MS = 10 * 1000;
const CLEANUP_READY_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_POLL_INTERVAL_MS = 10 * 1000;

/** Machine-readable case catalog for the public-Azure safe matrix. */
export const CASE_CATALOG = Object.freeze([
  // Baseline six (retained)
  { id: 'apim-explicit-api-id', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'apim-discovery', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'app-service-api-definition', providerType: 'app-service', sourceType: 'app-service-api-definition', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'discover-many', providerType: 'apim', sourceType: 'discover-many', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'iac-single', providerType: 'iac-local', sourceType: 'iac-embedded', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'ambiguity', providerType: '', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'baseline' },

  // APIM multi-API clean repository / association
  { id: 'apim-clean-repo-tag', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-clean-repo-fox-pair', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-gateway-host-path', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-host-only-ambiguity', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-version-revision-ambiguity', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-explicit-historical-revision', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-version-set', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-soap-wsdl', providerType: 'apim', sourceType: 'apim-export', specFormat: 'wsdl', contractClass: 'authoritative', lane: 'apim-formats', requires: ['apim-soap'] },
  { id: 'apim-graphql-sdl', providerType: 'apim', sourceType: 'apim-export', specFormat: 'graphql-sdl', contractClass: 'authoritative', lane: 'apim-formats', requires: ['apim-graphql'] },
  { id: 'apim-unsupported-websocket', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-websocket'] },
  { id: 'apim-unsupported-grpc', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-grpc'] },
  { id: 'apim-unsupported-odata', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-odata'] },

  // API Center (eastus)
  { id: 'api-center-openapi-export', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-native-non-openapi', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'graphql-sdl', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-exact-binding', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-ambiguity', providerType: 'api-center', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'api-center', requires: ['api-center'] },

  // Logic Apps / custom connector / template specs
  { id: 'logic-apps-list-swagger', providerType: 'logic-apps', sourceType: 'logic-apps-workflow', specFormat: 'openapi-json', contractClass: 'reconstructed', lane: 'logic-apps', requires: ['logic-app'] },
  { id: 'logic-apps-reader-synthesis', providerType: 'logic-apps', sourceType: 'logic-apps-workflow', specFormat: 'openapi-json', contractClass: 'partial', lane: 'logic-apps', requires: ['logic-app'] },
  { id: 'custom-apis-inline-swagger', providerType: 'custom-apis', sourceType: 'custom-api-swagger', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'custom-apis', requires: ['custom-connector'] },
  { id: 'template-specs-embedded-apim', providerType: 'template-specs', sourceType: 'template-spec-embedded', specFormat: 'openapi-json', contractClass: 'partial', lane: 'template-specs', requires: ['template-spec'] },

  // Partial contracts
  { id: 'event-grid-webhook-partial', providerType: 'event-grid', sourceType: 'event-grid-webhook', specFormat: 'openapi-json', contractClass: 'partial', lane: 'event-grid', requires: ['event-grid'] },
  { id: 'service-bus-topic-partial', providerType: 'service-bus', sourceType: 'service-bus-topic', specFormat: 'openapi-json', contractClass: 'partial', lane: 'service-bus', requires: ['service-bus-standard'] },

  // Functions / App Service runtime-declared
  { id: 'function-bindings-openapi-extension', providerType: 'function-bindings', sourceType: 'function-bindings-trigger', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'functions', requires: ['function-app'] },
  { id: 'app-service-apispecpath-runtime', providerType: 'app-service', sourceType: 'app-service-api-definition', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'app-service-runtime', requires: ['app-service'] },

  // Local-only R3 (compiled CLI, no Azure)
  { id: 'local-r3-format-parser-matrix', providerType: 'repo', sourceType: 'repo-spec', specFormat: 'openapi-yaml', contractClass: 'authoritative', lane: 'local-r3', localOnly: true }
]);

export const PROVISION_FLAGS = Object.freeze({
  'apim-core': true,
  'apim-multi': true,
  'apim-soap': true,
  'apim-graphql': true,
  'apim-websocket': true,
  'apim-grpc': true,
  'apim-odata': true,
  'app-service': true,
  'api-center': true,
  'logic-app': true,
  'custom-connector': true,
  'template-spec': true,
  'event-grid': true,
  'service-bus-standard': false, // opt-in; cost-bounded Standard only when explicitly enabled
  'function-app': true
});

/** Reverse-dependency cleanup order for shared-group resource deletes. */
export const CLEANUP_RESOURCE_ORDER = Object.freeze([
  { key: 'eventGridSubName', type: 'Microsoft.EventGrid/topics/eventSubscriptions', nested: true, parentKey: 'eventGridTopicName', parentType: 'Microsoft.EventGrid/topics' },
  { key: 'eventGridTopicName', type: 'Microsoft.EventGrid/topics' },
  { key: 'serviceBusSubName', type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', nested: true, parentKey: 'serviceBusNamespaceName', parentType: 'Microsoft.ServiceBus/namespaces' },
  { key: 'serviceBusTopicName', type: 'Microsoft.ServiceBus/namespaces/topics', nested: true, parentKey: 'serviceBusNamespaceName', parentType: 'Microsoft.ServiceBus/namespaces' },
  { key: 'serviceBusNamespaceName', type: 'Microsoft.ServiceBus/namespaces' },
  { key: 'apiCenterServiceName', type: 'Microsoft.ApiCenter/services' },
  { key: 'functionAppName', type: 'Microsoft.Web/sites' },
  { key: 'customConnectorName', type: 'Microsoft.Web/customApis' },
  { key: 'logicAppName', type: 'Microsoft.Logic/workflows' },
  { key: 'templateSpecName', type: 'Microsoft.Resources/templateSpecs' },
  { key: 'siteName', type: 'Microsoft.Web/sites' },
  { key: 'planName', type: 'Microsoft.Web/serverfarms' },
  { key: 'apimName', type: 'Microsoft.ApiManagement/service' }
]);

export const SANITIZED_REASON_CODES = Object.freeze([
  'cli-failed',
  'unexpected-status',
  'unexpected-source-type',
  'provider-not-registered',
  'rbac-insufficient',
  'sku-unsupported',
  'region-unsupported',
  'cost-guard-blocked',
  'inventory-rejected',
  'export-unsupported',
  'capability-absent',
  'teardown-refused',
  'residue-detected',
  'local-only-matrix',
  'dry-run-skipped'
]);

/**
 * Classify an export-probe failure. Only states that self-heal after a
 * Succeeded deployment are retryable.
 */
export function classifyProbeError(message) {
  const text = String(message ?? '');
  if (/\b(401|403)\b|AuthorizationFailed|InvalidAuthenticationToken|Unauthorized|Forbidden/i.test(text)) {
    return 'fatal';
  }
  if (/\b400\b|BadRequest|InvalidParameters|ValidationError/i.test(text)) {
    return 'fatal';
  }
  return 'retryable';
}

export function isResourceNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ResourceNotFound|could not be found|was not found|NotFound/i.test(message);
}

export function parseFlags(argv) {
  return {
    provision: argv.includes('--provision'),
    teardown: argv.includes('--teardown'),
    dryRun: argv.includes('--dry-run'),
    renderPlan: argv.includes('--render-plan'),
    cancelRecover: argv.includes('--cancel-recover')
  };
}

export function parseProvisionFlags(env = process.env) {
  const raw = String(env.AZURE_LIVE_PROVISION_FLAGS ?? '').trim();
  const flags = { ...PROVISION_FLAGS };
  if (!raw) return flags;
  for (const token of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
    const disabled = token.startsWith('!');
    const key = disabled ? token.slice(1) : token.replace(/^\+/, '');
    if (!(key in flags)) {
      throw new Error(`Unknown provision flag ${JSON.stringify(key)}; expected one of ${Object.keys(PROVISION_FLAGS).join(', ')}`);
    }
    flags[key] = !disabled;
  }
  return flags;
}

export function requiredEnv(env) {
  const subscriptionId = String(env.AZURE_SUBSCRIPTION_ID ?? '').trim();
  const location = String(env.AZURE_LOCATION ?? '').trim();
  const resourceGroup = String(env.AZURE_RESOURCE_GROUP ?? '').trim();
  if (!subscriptionId) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID is required (set it explicitly, or authenticate az so `az account show` returns the azure-cse-pilot-builders subscription)'
    );
  }
  if (!location) throw new Error('AZURE_LOCATION is required');
  return { subscriptionId, location, resourceGroup };
}

export function shouldDeleteGroup({ manifest, groupShow, subscriptionId }) {
  if (!manifest?.resourceGroup || !manifest?.runMarker) return false;
  if (!groupShow) return false;
  if (groupShow.name !== manifest.resourceGroup) return false;
  const groupSubscription = String(groupShow.id ?? '').split('/')[2] ?? '';
  if (groupSubscription !== subscriptionId) return false;
  const marker = groupShow.tags?.[RUN_MARKER_TAG];
  return marker === manifest.runMarker;
}

export function shouldDeleteResource({ manifest, resourceShow, subscriptionId, expectedName, expectedType }) {
  if (!hasExactResourceIdentity({ manifest, resourceShow, subscriptionId, expectedName, expectedType })) return false;
  return resourceShow.tags?.[RESOURCE_RUN_MARKER_TAG] === manifest.runMarker;
}

/** Verify an ARM resource is exactly the run's expected object, without trusting tags. */
export function hasExactResourceIdentity({ manifest, resourceShow, subscriptionId, expectedName, expectedType }) {
  if (!manifest?.resourceGroup || !resourceShow?.id) return false;
  if (resourceShow.name !== expectedName || resourceShow.type?.toLowerCase() !== expectedType.toLowerCase()) return false;
  const expectedPrefix = `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/`.toLowerCase();
  if (!String(resourceShow.id).toLowerCase().startsWith(expectedPrefix)) return false;
  return true;
}

/** Short commit correlation hash only — never raw pipeline/run IDs. */
export function resolveCommitHashPrefix(env = process.env, runner = defaultRunner) {
  const fromEnv = String(env.AZURE_LIVE_COMMIT_PREFIX ?? env.BUILD_SOURCEVERSION ?? env.GITHUB_SHA ?? '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 7).toLowerCase();
  try {
    const sha = String(runner('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }) ?? '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7).toLowerCase();
  } catch {
    // ignore
  }
  return '';
}

export function sanitizeReasonCode(code) {
  const value = String(code ?? '').trim();
  if (!value) return undefined;
  if (SANITIZED_REASON_CODES.includes(value)) return value;
  return 'capability-absent';
}

export function toEvidenceResult(id, status, fields = {}) {
  const catalog = CASE_CATALOG.find((row) => row.id === id);
  const result = {
    id,
    name: id,
    status,
    providerType: fields.providerType ?? catalog?.providerType ?? '',
    sourceType: fields.sourceType ?? catalog?.sourceType ?? '',
    specFormat: fields.specFormat ?? catalog?.specFormat ?? '',
    contractClass: fields.contractClass ?? catalog?.contractClass ?? ''
  };
  const reasonCode = sanitizeReasonCode(fields.reasonCode);
  if (reasonCode) result.reasonCode = reasonCode;
  return result;
}

export function buildEvidence(results, { suiteVersion = SUITE_VERSION, testedCommitHashPrefix = '' } = {}) {
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const requiresCapability = results.filter((result) => result.status === 'requires-capability').length;
  const localOnly = results.filter((result) => result.status === 'local-only').length;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    suiteVersion,
    testedCommitHashPrefix: testedCommitHashPrefix || undefined,
    capturedAt: new Date().toISOString().slice(0, 10),
    cases: results.length,
    passed,
    failed,
    requiresCapability,
    localOnly,
    results
  };
}

/** Coverage helper: only `pass` backs validationState=live. */
export function passingLiveCaseIds(evidence) {
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  return new Set(
    results
      .filter((row) => row && row.status === 'pass')
      .map((row) => (typeof row.name === 'string' && row.name ? row.name : row.id))
      .filter((name) => typeof name === 'string' && name.trim())
  );
}

export function renderExecutionPlan({ provisionFlags = PROVISION_FLAGS, flags = parseFlags([]) } = {}) {
  const cases = CASE_CATALOG.map((row) => {
    const missing = (row.requires ?? []).filter((key) => provisionFlags[key] === false);
    return {
      id: row.id,
      lane: row.lane,
      localOnly: Boolean(row.localOnly),
      requires: row.requires ?? [],
      blockedByFlags: missing,
      plannedStatus: row.localOnly
        ? 'local-only'
        : missing.length > 0
          ? 'requires-capability'
          : 'executable'
    };
  });
  const cleanup = CLEANUP_RESOURCE_ORDER.map((row) => ({ key: row.key, type: row.type }));
  return {
    suiteVersion: SUITE_VERSION,
    pipelineId: PIPELINE_ID,
    pipelineName: PIPELINE_NAME,
    apiCenterLocation: API_CENTER_LOCATION,
    flags,
    provisionFlags,
    caseCount: cases.length,
    cases,
    cleanupOrder: cleanup,
    notes: [
      'Immutable githubRef is enforced by pipeline 157; harness records only testedCommitHashPrefix or suiteVersion.',
      'requires-capability is not live proof (Azure category; not GCP substitute).',
      'Never auto-register providers or elevate RBAC.',
      'Never delete the shared resource group CSE-Azure-Team.',
      'No personal subscription path.'
    ]
  };
}

function az(runner, args, options = {}) {
  return runner('az', args, options);
}

function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function azJson(runner, args) {
  const stdout = az(runner, [...args, '-o', 'json']);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export function resolveSubscriptionId(env, runner) {
  const fromEnv = String(env.AZURE_SUBSCRIPTION_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromAccount = String(az(runner, ['account', 'show', '--query', 'id', '-o', 'tsv']) ?? '').trim();
  if (!fromAccount) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID is required (set it explicitly, or authenticate az so `az account show` returns the azure-cse-pilot-builders subscription)'
    );
  }
  return fromAccount;
}

function redactSecrets(text) {
  return String(text ?? '')
    .replace(/sig=[^&\s"']+/gi, 'sig=REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer REDACTED')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[redacted-uuid]');
}

function runCli(runner, cliPath, args, cwd) {
  const stdout = runner(process.execPath, [cliPath, ...args], { cwd });
  return JSON.parse(stdout);
}

function capabilityReasonFromError(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/MissingSubscriptionRegistration|provider.*not registered|Register the .* resource provider/i.test(text)) {
    return 'provider-not-registered';
  }
  if (/AuthorizationFailed|Forbidden|does not have authorization|RBAC/i.test(text)) {
    return 'rbac-insufficient';
  }
  if (/SkuNotSupported|InvalidSku|sku/i.test(text)) {
    return 'sku-unsupported';
  }
  if (/LocationNotAvailable|region|Location .* not available/i.test(text)) {
    return 'region-unsupported';
  }
  if (/BadRequest|ValidationError|InvalidApiType|apiType/i.test(text)) {
    return 'inventory-rejected';
  }
  return 'capability-absent';
}

async function seedIacSingle(workspace) {
  const fixtures = path.join(repoRoot, 'validation/fixtures/azure/iac-single');
  await cp(path.join(fixtures, 'azure.yaml'), path.join(workspace, 'azure.yaml'));
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  await cp(path.join(fixtures, 'main.json'), path.join(workspace, 'infra', 'main.json'));
}

async function seedAmbiguity(workspace) {
  const spec = (name) =>
    JSON.stringify({
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          apiVersion: '2023-05-01-preview',
          name: `apim-live/${name}`,
          properties: {
            displayName: name,
            path: name,
            protocols: ['https'],
            format: 'openapi+json',
            value: JSON.stringify({
              openapi: '3.0.3',
              info: { title: name, version: '1.0.0' },
              paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } }
            })
          }
        }
      ]
    });
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  await writeFile(path.join(workspace, 'infra', 'alpha.json'), spec('payments-alpha'), 'utf8');
  await writeFile(path.join(workspace, 'infra', 'bravo.json'), spec('payments-bravo'), 'utf8');
}

async function seedCleanRepoGateway(workspace, { gatewayHostname, apiPath, hostOnly = false }) {
  const lines = hostOnly
    ? [`Gateway host: https://${gatewayHostname}/`]
    : [`Gateway: https://${gatewayHostname}/${apiPath}`];
  await writeFile(path.join(workspace, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
}

async function seedLocalR3(workspace) {
  const source = path.join(repoRoot, 'validation/fixtures/azure/local-r3/specs');
  await mkdir(path.join(workspace, 'specs'), { recursive: true });
  for (const file of [
    'openapi.yaml',
    'asyncapi.yaml',
    'schema.graphql',
    'service.wsdl',
    'service.wadl',
    'types.xsd',
    'service.proto'
  ]) {
    await cp(path.join(source, file), path.join(workspace, 'specs', file));
  }
}

function expectResolved(result, expectedSource) {
  const resolution = result.resolution;
  if (!resolution || resolution.status !== 'resolved') {
    throw new Error(`expected resolved, got ${resolution?.status ?? 'missing'}`);
  }
  if (resolution.sourceType !== expectedSource) {
    throw new Error(`expected sourceType ${expectedSource}, got ${resolution.sourceType}`);
  }
  if (resolution.specPath && path.isAbsolute(resolution.specPath)) {
    throw new Error('spec path must be repo-relative');
  }
  return resolution;
}

function expectUnresolved(result) {
  const resolution = result.resolution;
  if (!resolution || resolution.status !== 'unresolved') {
    throw new Error(`expected unresolved, got ${resolution?.status ?? 'missing'}`);
  }
  if ((resolution.rankedCandidates?.length ?? 0) < 2) {
    throw new Error('expected at least two ranked candidates');
  }
  return resolution;
}

export function buildManifestNames({ suffix, runMarker, subscriptionId, resourceGroup, ownsResourceGroup, provisionFlags }) {
  return {
    resourceGroup,
    runMarker,
    subscriptionId,
    ownsResourceGroup,
    deploymentName: `postman-azure-spec-live-${suffix}`,
    extendedDeploymentName: `postman-azure-spec-ext-${suffix}`,
    apimName: `pmspecapim${suffix}`,
    planName: `pmspecplan${suffix}`,
    siteName: `pmspecsite${suffix}`,
    logicAppName: `pmspeclogic${suffix}`,
    customConnectorName: `pmspecconn${suffix}`,
    templateSpecName: `pmspectpl${suffix}`,
    eventGridTopicName: `pmspeceg${suffix}`,
    eventGridSubName: `pmspecegsub${suffix}`,
    apiCenterServiceName: `pmspecapic${suffix}`,
    functionAppName: `pmspecfn${suffix}`,
    serviceBusNamespaceName: `pmspecsb${suffix}`,
    serviceBusTopicName: 'payments-live',
    serviceBusSubName: 'payments-live-sub',
    repoSlug: 'postman-cs/postman-azure-spec-discovery-action',
    provisionFlags,
    resources: []
  };
}

export function recordManifestResource(manifest, entry) {
  manifest.resources.push({
    type: entry.type,
    name: entry.name,
    id: entry.id ?? null
  });
}

async function putApimApi(runner, { subscriptionId, resourceGroup, apimName, apiName, body }) {
  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.ApiManagement/service/${apimName}/apis/${encodeURIComponent(apiName)}?api-version=2024-05-01`;
  az(runner, ['rest', '--method', 'put', '--url', url, '--body', JSON.stringify(body)]);
}

async function provisionOptionalApimApis({ runner, log, manifest, subscriptionId, provisionFlags, capabilities }) {
  const { resourceGroup, apimName } = manifest;
  const soapWsdl = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/soap.wsdl'), 'utf8');
  const graphqlSdl = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/schema.graphql'), 'utf8');

  const optional = [
    {
      flag: 'apim-soap',
      apiName: 'payments-soap',
      body: {
        properties: {
          displayName: 'Payments SOAP API',
          path: 'payments-soap',
          protocols: ['https'],
          apiType: 'soap',
          format: 'wsdl',
          value: soapWsdl
        }
      }
    },
    {
      flag: 'apim-graphql',
      apiName: 'payments-graphql',
      body: {
        properties: {
          displayName: 'Payments GraphQL API',
          path: 'payments-graphql',
          protocols: ['https'],
          apiType: 'graphql'
        }
      },
      afterCreate: async () => {
        const schemaUrl =
          `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
          `/providers/Microsoft.ApiManagement/service/${apimName}/apis/payments-graphql/schemas/graphql?api-version=2024-05-01`;
        az(runner, [
          'rest',
          '--method',
          'put',
          '--url',
          schemaUrl,
          '--body',
          JSON.stringify({
            properties: {
              contentType: 'application/vnd.ms-azure-apim.graphql.schema',
              document: { value: graphqlSdl }
            }
          })
        ]);
      }
    },
    {
      flag: 'apim-websocket',
      apiName: 'payments-websocket',
      body: {
        properties: {
          displayName: 'Payments WebSocket API',
          path: 'payments-websocket',
          protocols: ['wss'],
          apiType: 'websocket',
          serviceUrl: 'wss://example.invalid/ws'
        }
      }
    },
    {
      flag: 'apim-grpc',
      apiName: 'payments-grpc',
      body: {
        properties: {
          displayName: 'Payments gRPC API',
          path: 'payments-grpc',
          protocols: ['https'],
          apiType: 'grpc'
        }
      }
    },
    {
      flag: 'apim-odata',
      apiName: 'payments-odata',
      body: {
        properties: {
          displayName: 'Payments OData API',
          path: 'payments-odata',
          protocols: ['https'],
          apiType: 'odata',
          serviceUrl: 'https://example.invalid/odata'
        }
      }
    }
  ];

  for (const item of optional) {
    if (!provisionFlags[item.flag]) {
      capabilities[item.flag] = { ok: false, reasonCode: 'cost-guard-blocked' };
      continue;
    }
    try {
      await putApimApi(runner, {
        subscriptionId,
        resourceGroup,
        apimName,
        apiName: item.apiName,
        body: item.body
      });
      if (item.afterCreate) await item.afterCreate();
      capabilities[item.flag] = { ok: true };
      recordManifestResource(manifest, {
        type: 'Microsoft.ApiManagement/service/apis',
        name: `${apimName}/${item.apiName}`
      });
      log(`Provisioned optional APIM API lane ${item.flag}`);
    } catch (error) {
      const reasonCode = capabilityReasonFromError(error);
      capabilities[item.flag] = { ok: false, reasonCode };
      log(`Optional APIM lane ${item.flag} unavailable (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

async function preflightApiCenterProvider(runner, subscriptionId) {
  try {
    const providers = azJson(runner, [
      'provider',
      'show',
      '--namespace',
      'Microsoft.ApiCenter',
      '--subscription',
      subscriptionId
    ]);
    const state = String(providers?.registrationState ?? '').toLowerCase();
    if (state !== 'registered') {
      return { ok: false, reasonCode: 'provider-not-registered' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reasonCode: capabilityReasonFromError(error) };
  }
}

async function provisionApiCenter({ runner, log, manifest, subscriptionId, capabilities }) {
  const preflight = await preflightApiCenterProvider(runner, subscriptionId);
  if (!preflight.ok) {
    capabilities['api-center'] = preflight;
    log(`API Center preflight blocked: ${preflight.reasonCode}`);
    return;
  }
  try {
    az(runner, [
      'apic',
      'service',
      'create',
      '--name',
      manifest.apiCenterServiceName,
      '--resource-group',
      manifest.resourceGroup,
      '--location',
      API_CENTER_LOCATION,
      '--tags',
      `${RESOURCE_RUN_MARKER_TAG}=${manifest.runMarker}`
    ]);
    // Workspace / API / version / definitions (OpenAPI + GraphQL native).
    const base =
      `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}` +
      `/providers/Microsoft.ApiCenter/services/${manifest.apiCenterServiceName}`;
    az(runner, [
      'rest',
      '--method',
      'put',
      '--url',
      `${base}/workspaces/default?api-version=2024-03-01`,
      '--body',
      JSON.stringify({ properties: { title: 'default' } })
    ]);
    az(runner, [
      'rest',
      '--method',
      'put',
      '--url',
      `${base}/workspaces/default/apis/payments-apic?api-version=2024-03-01`,
      '--body',
      JSON.stringify({ properties: { title: 'Payments API Center', kind: 'rest' } })
    ]);
    az(runner, [
      'rest',
      '--method',
      'put',
      '--url',
      `${base}/workspaces/default/apis/payments-apic/versions/v1?api-version=2024-03-01`,
      '--body',
      JSON.stringify({ properties: { title: 'v1', lifecycleStage: 'healthy' } })
    ]);
    const openapi = await readFile(path.join(repoRoot, 'validation/fixtures/azure/app-service-stub/openapi.json'), 'utf8');
    az(runner, [
      'rest',
      '--method',
      'put',
      '--url',
      `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/openapi?api-version=2024-03-01`,
      '--body',
      JSON.stringify({
        properties: {
          title: 'openapi',
          specification: { name: 'openapi', version: '3.0.3' }
        }
      })
    ]);
    az(runner, [
      'rest',
      '--method',
      'post',
      '--url',
      `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/openapi:importSpecification?api-version=2024-03-01`,
      '--body',
      JSON.stringify({ format: 'inline', value: openapi, specification: { name: 'openapi', version: '3.0.3' } })
    ]);
    const gql = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/schema.graphql'), 'utf8');
    az(runner, [
      'rest',
      '--method',
      'put',
      '--url',
      `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/graphql?api-version=2024-03-01`,
      '--body',
      JSON.stringify({
        properties: {
          title: 'graphql',
          specification: { name: 'graphql', version: 'October2021' }
        }
      })
    ]);
    az(runner, [
      'rest',
      '--method',
      'post',
      '--url',
      `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/graphql:importSpecification?api-version=2024-03-01`,
      '--body',
      JSON.stringify({ format: 'inline', value: gql, specification: { name: 'graphql', version: 'October2021' } })
    ]);
    capabilities['api-center'] = { ok: true };
    recordManifestResource(manifest, {
      type: 'Microsoft.ApiCenter/services',
      name: manifest.apiCenterServiceName
    });
    log(`Provisioned API Center service in ${API_CENTER_LOCATION}`);
  } catch (error) {
    const reasonCode = capabilityReasonFromError(error);
    capabilities['api-center'] = { ok: false, reasonCode };
    log(`API Center provision blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
}

async function provisionServiceBusIfGuarded({ runner, log, manifest, subscriptionId, provisionFlags, capabilities }) {
  if (!provisionFlags['service-bus-standard']) {
    capabilities['service-bus-standard'] = { ok: false, reasonCode: 'cost-guard-blocked' };
    log('Service Bus Standard lane disabled by cost guard (set AZURE_LIVE_PROVISION_FLAGS=service-bus-standard to opt in)');
    return;
  }
  try {
    az(runner, [
      'servicebus',
      'namespace',
      'create',
      '--name',
      manifest.serviceBusNamespaceName,
      '--resource-group',
      manifest.resourceGroup,
      '--location',
      String(process.env.AZURE_LOCATION || 'eastus2'),
      '--sku',
      'Standard',
      '--tags',
      `${RESOURCE_RUN_MARKER_TAG}=${manifest.runMarker}`
    ]);
    az(runner, [
      'servicebus',
      'topic',
      'create',
      '--namespace-name',
      manifest.serviceBusNamespaceName,
      '--resource-group',
      manifest.resourceGroup,
      '--name',
      manifest.serviceBusTopicName
    ]);
    az(runner, [
      'servicebus',
      'topic',
      'subscription',
      'create',
      '--namespace-name',
      manifest.serviceBusNamespaceName,
      '--resource-group',
      manifest.resourceGroup,
      '--topic-name',
      manifest.serviceBusTopicName,
      '--name',
      manifest.serviceBusSubName
    ]);
    capabilities['service-bus-standard'] = { ok: true };
    recordManifestResource(manifest, {
      type: 'Microsoft.ServiceBus/namespaces',
      name: manifest.serviceBusNamespaceName
    });
    log('Provisioned run-owned Service Bus Standard namespace');
  } catch (error) {
    const reasonCode = capabilityReasonFromError(error);
    capabilities['service-bus-standard'] = { ok: false, reasonCode };
    log(`Service Bus provision blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  void subscriptionId;
}

async function residualResourceGraphAudit({ runner, log, subscriptionId, runMarker }) {
  try {
    const query =
      `Resources | where tags['${RESOURCE_RUN_MARKER_TAG}'] == '${runMarker}' | project id, type, name, resourceGroup`;
    const rows =
      azJson(runner, [
        'graph',
        'query',
        '-q',
        query,
        '--subscriptions',
        subscriptionId
      ])?.data ?? [];
    if (Array.isArray(rows) && rows.length > 0) {
      log(`Resource Graph residual audit found ${rows.length} run-marked resource(s)`);
      return rows.length;
    }
    log('Resource Graph residual audit: zero run-marked resources');
    return 0;
  } catch (error) {
    log(`Resource Graph residual audit skipped/failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return -1;
  }
}

export async function teardownSharedGroupResources({
  runner,
  log,
  manifest,
  subscriptionId,
  now = () => Date.now(),
  sleep = delay
}) {
  const cleanupErrors = [];
  const resourceGroup = manifest.resourceGroup;
  const runMarker = manifest.runMarker;

  for (const resource of CLEANUP_RESOURCE_ORDER) {
    const name = manifest[resource.key];
    if (!name) continue;
    try {
      if (resource.nested && resource.parentKey && resource.parentType && manifest[resource.parentKey]) {
        const nestedName =
          resource.key === 'eventGridSubName'
            ? `${manifest.eventGridTopicName}/${name}`
            : resource.key === 'serviceBusTopicName'
              ? `${manifest.serviceBusNamespaceName}/${name}`
              : `${manifest.serviceBusNamespaceName}/${manifest.serviceBusTopicName}/${name}`;
        const show = azJson(runner, [
          'resource',
          'show',
          '--resource-group',
          resourceGroup,
          '--resource-type',
          resource.type,
          '--name',
          nestedName
        ]);
        const parentName = manifest[resource.parentKey];
        const parent = azJson(runner, [
          'resource', 'show', '--resource-group', resourceGroup,
          '--resource-type', resource.parentType, '--name', parentName
        ]);
        if (
          hasExactResourceIdentity({ manifest, resourceShow: show, subscriptionId, expectedName: nestedName, expectedType: resource.type }) &&
          shouldDeleteResource({ manifest, resourceShow: parent, subscriptionId, expectedName: parentName, expectedType: resource.parentType })
        ) {
          // Child resources commonly have no tags; their exact ARM identity plus a
          // fully verified run-marked root parent is the deletion authority.
          log(`Deleting run-marked ${resource.type} ${nestedName}`);
          az(runner, ['resource', 'delete', '--ids', show.id]);
        } else {
          log(`REFUSING nested deletion: identity or parent marker mismatch for ${nestedName}`);
        }
        continue;
      }

      const resourceShow = azJson(runner, [
        'resource',
        'show',
        '--resource-group',
        resourceGroup,
        '--resource-type',
        resource.type,
        '--name',
        name
      ]);
      if (
        shouldDeleteResource({
          manifest,
          resourceShow,
          subscriptionId,
          expectedName: name,
          expectedType: resource.type
        })
      ) {
        log(`Deleting run-marked ${resource.type} ${name} from shared group ${resourceGroup}`);
        az(runner, ['resource', 'delete', '--ids', resourceShow.id]);
      } else {
        log(`REFUSING deletion: ${name} failed the run-marker/resource identity check.`);
      }
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        log(`Run-marked ${resource.type} ${name} is already absent`);
      } else {
        cleanupErrors.push(error);
        log(`Teardown error for ${name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  for (const deploymentName of [manifest.extendedDeploymentName, manifest.deploymentName].filter(Boolean)) {
    try {
      az(runner, ['deployment', 'group', 'delete', '--resource-group', resourceGroup, '--name', deploymentName]);
    } catch (error) {
      if (!isResourceNotFoundError(error)) {
        cleanupErrors.push(error);
        log(`Deployment-record cleanup error for ${deploymentName}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  const cleanupDeadline = now() + CLEANUP_READY_TIMEOUT_MS;
  let residual = [];
  for (;;) {
    const groupResources =
      azJson(runner, ['resource', 'list', '--resource-group', resourceGroup]) ?? [];
    residual = groupResources.filter((resource) => resource.tags?.[RESOURCE_RUN_MARKER_TAG] === runMarker);
    if (residual.length === 0 || now() >= cleanupDeadline) break;
    log(`Waiting for ${residual.length} run-marked resource deletion(s) to finish`);
    await sleep(CLEANUP_POLL_INTERVAL_MS);
  }
  if (residual.length > 0) {
    cleanupErrors.push(new Error(`${residual.length} run-marked resource(s) remain`));
  }

  const graphCount = await residualResourceGraphAudit({ runner, log, subscriptionId, runMarker });
  if (graphCount > 0) {
    cleanupErrors.push(new Error(`Resource Graph residual audit reported ${graphCount} resource(s)`));
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`Shared-group teardown did not complete: ${cleanupErrors.length} cleanup check(s) failed`);
  }
}

async function runDefaultCases({ runner, log, manifest, subscriptionId, cliPath, capabilities = {} }) {
  const results = [];
  const armApiId =
    `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/Microsoft.ApiManagement/service/${manifest.apimName}/apis/payments-live`;
  const historicalApiId = `${armApiId};rev=2`;
  const gatewayHostname = `${manifest.apimName}.azure-api.net`;

  async function runCase(id, fn, { allowRequiresCapability = false } = {}) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `az-live-${id}-`));
    try {
      const resolution = await fn(workspace);
      if (resolution?.__status === 'requires-capability') {
        results.push(
          toEvidenceResult(id, 'requires-capability', {
            reasonCode: resolution.reasonCode,
            providerType: resolution.providerType,
            sourceType: resolution.sourceType,
            specFormat: resolution.specFormat,
            contractClass: resolution.contractClass
          })
        );
        log(`case ${id}: requires-capability (${resolution.reasonCode ?? 'capability-absent'})`);
        return;
      }
      if (resolution?.__status === 'local-only') {
        results.push(
          toEvidenceResult(id, 'local-only', {
            reasonCode: 'local-only-matrix',
            providerType: resolution.providerType,
            sourceType: resolution.sourceType,
            specFormat: resolution.specFormat
          })
        );
        log(`case ${id}: local-only`);
        return;
      }
      results.push(toEvidenceResult(id, 'pass', resolution));
      log(`case ${id}: pass`);
    } catch (error) {
      if (allowRequiresCapability) {
        results.push(
          toEvidenceResult(id, 'requires-capability', {
            reasonCode: capabilityReasonFromError(error)
          })
        );
        log(`case ${id}: requires-capability (${capabilityReasonFromError(error)})`);
      } else {
        results.push(toEvidenceResult(id, 'fail', { reasonCode: 'cli-failed' }));
        log(`case ${id}: fail (${redactSecrets(error instanceof Error ? error.message : String(error))})`);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  function capabilityGate(flag) {
    const state = capabilities[flag];
    if (state && state.ok === false) {
      return {
        __status: 'requires-capability',
        reasonCode: state.reasonCode ?? 'capability-absent'
      };
    }
    return null;
  }

  // --- Baseline six ---
  await runCase('apim-explicit-api-id', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--api-id',
        armApiId,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-discovery', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('app-service-api-definition', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live-site',
        '--api-filter',
        manifest.siteName,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'app-service-api-definition');
  });

  await runCase('discover-many', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--mode',
        'discover-many',
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    if (!Array.isArray(result.discovered) || result.discovered.length < 1) {
      throw new Error('discover-many exported no services');
    }
    if ((result.exportSummary?.failed ?? 1) !== 0) {
      throw new Error('discover-many reported export failures');
    }
    return {
      sourceType: 'discover-many',
      providerType: result.discovered[0]?.providerType ?? '',
      specFormat: result.discovered[0]?.specFormat ?? ''
    };
  });

  await runCase('iac-single', async (workspace) => {
    await seedIacSingle(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'iac-embedded');
  });

  await runCase('ambiguity', async (workspace) => {
    await seedAmbiguity(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectUnresolved(result);
  });

  // --- APIM clean-repo / formats ---
  await runCase('apim-clean-repo-tag', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--repo-slug',
        manifest.repoSlug,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-clean-repo-fox-pair', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--repo-slug',
        manifest.repoSlug,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-gateway-host-path', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: 'payments-live' });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-host-only-ambiguity', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: '', hostOnly: true });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectUnresolved(result);
  });

  await runCase('apim-version-revision-ambiguity', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: 'payments-live' });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--api-version',
        'v1',
        '--result-json',
        'result.json'
      ],
      workspace
    );
    // With version set + historical revision inventory, ambiguity or exact current is acceptable
    // as long as we do not silently pick a non-current revision without --api-revision.
    if (result.resolution?.status === 'resolved') {
      const apiId = String(result.resolution.apiId ?? '');
      if (/;rev=2$/i.test(apiId)) {
        throw new Error('selected historical revision without explicit api-revision');
      }
      return expectResolved(result, 'apim-export');
    }
    return expectUnresolved(result);
  });

  await runCase('apim-explicit-historical-revision', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--api-id',
        historicalApiId,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-version-set', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--api-version',
        'v1',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-soap-wsdl', async (workspace) => {
    const gated = capabilityGate('apim-soap');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'Payments SOAP API',
        '--api-filter',
        'payments-soap',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    if (resolution.specFormat !== 'wsdl') {
      throw new Error(`expected wsdl, got ${resolution.specFormat}`);
    }
    return resolution;
  });

  await runCase('apim-graphql-sdl', async (workspace) => {
    const gated = capabilityGate('apim-graphql');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'Payments GraphQL API',
        '--api-filter',
        'payments-graphql',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    if (resolution.specFormat !== 'graphql-sdl') {
      throw new Error(`expected graphql-sdl, got ${resolution.specFormat}`);
    }
    return resolution;
  });

  for (const unsupported of [
    { id: 'apim-unsupported-websocket', flag: 'apim-websocket', filter: 'payments-websocket' },
    { id: 'apim-unsupported-grpc', flag: 'apim-grpc', filter: 'payments-grpc' },
    { id: 'apim-unsupported-odata', flag: 'apim-odata', filter: 'payments-odata' }
  ]) {
    await runCase(unsupported.id, async (workspace) => {
      const gated = capabilityGate(unsupported.flag);
      if (gated) return gated;
      const result = runCli(
        runner,
        cliPath,
        [
          '--subscription-id',
          subscriptionId,
          '--resource-group',
          manifest.resourceGroup,
          '--api-filter',
          unsupported.filter,
          '--repo-root',
          workspace,
          '--result-json',
          'result.json'
        ],
        workspace
      );
      const resolution = result.resolution;
      if (!resolution || resolution.status !== 'unresolved' || resolution.sourceType !== 'manual-review') {
        throw new Error(`expected manual-review for ${unsupported.filter}, got ${resolution?.status}/${resolution?.sourceType}`);
      }
      return resolution;
    });
  }

  // --- API Center ---
  for (const apiCenterCase of [
    'api-center-openapi-export',
    'api-center-native-non-openapi',
    'api-center-exact-binding',
    'api-center-ambiguity'
  ]) {
    await runCase(apiCenterCase, async (workspace) => {
      const gated = capabilityGate('api-center');
      if (gated) {
        return {
          ...gated,
          reasonCode: gated.reasonCode,
          providerType: 'api-center'
        };
      }
      const definitionId =
        `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/Microsoft.ApiCenter/services/${manifest.apiCenterServiceName}/workspaces/default/apis/payments-apic/versions/v1/definitions/${
          apiCenterCase === 'api-center-native-non-openapi' ? 'graphql' : 'openapi'
        }`;
      if (apiCenterCase === 'api-center-ambiguity') {
        const result = runCli(
          runner,
          cliPath,
          [
            '--subscription-id',
            subscriptionId,
            '--resource-group',
            manifest.resourceGroup,
            '--repo-root',
            workspace,
            '--result-json',
            'result.json'
          ],
          workspace
        );
        // Ambiguity across OpenAPI + GraphQL definitions should rank, not guess.
        if (result.resolution?.status === 'resolved') {
          throw new Error('expected ambiguity across API Center definitions');
        }
        return expectUnresolved(result);
      }
      const args = [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ];
      if (apiCenterCase === 'api-center-exact-binding' || apiCenterCase === 'api-center-openapi-export' || apiCenterCase === 'api-center-native-non-openapi') {
        args.push('--api-center-definition-id', definitionId);
      }
      const result = runCli(runner, cliPath, args, workspace);
      return expectResolved(result, 'api-center-export');
    });
  }

  // --- Logic / connector / template / event-grid / service-bus / functions ---
  await runCase('logic-apps-list-swagger', async (workspace) => {
    const gated = capabilityGate('logic-app');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-logic',
        '--enable-logic-apps-list-swagger',
        'true',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'logic-apps-workflow');
  });

  await runCase('logic-apps-reader-synthesis', async (workspace) => {
    const gated = capabilityGate('logic-app');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-logic',
        '--enable-logic-apps-list-swagger',
        'false',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'logic-apps-workflow');
  });

  await runCase('custom-apis-inline-swagger', async (workspace) => {
    const gated = capabilityGate('custom-connector');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-connector',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'custom-api-swagger');
  });

  await runCase('template-specs-embedded-apim', async (workspace) => {
    const gated = capabilityGate('template-spec');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-templatespec',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'template-spec-embedded');
  });

  await runCase('event-grid-webhook-partial', async (workspace) => {
    const gated = capabilityGate('event-grid');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-eventgrid',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'event-grid-webhook');
  });

  await runCase('service-bus-topic-partial', async (workspace) => {
    const gated = capabilityGate('service-bus-standard');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'service-bus-topic');
  });

  await runCase('function-bindings-openapi-extension', async (workspace) => {
    const gated = capabilityGate('function-app');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-functions',
        '--enable-functions-openapi-extension',
        'true',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'function-bindings-trigger');
  });

  await runCase('app-service-apispecpath-runtime', async (workspace) => {
    const gated = capabilityGate('app-service');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live-site',
        '--api-filter',
        manifest.siteName,
        '--enable-app-service-scm-spec-fetch',
        'true',
        '--enable-runtime-declared-spec-routes',
        'true',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    // Public apiDefinition.url remains the authoritative path when SCM path is absent.
    return expectResolved(result, 'app-service-api-definition');
  });

  await runCase('local-r3-format-parser-matrix', async (workspace) => {
    await seedLocalR3(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    // Multiple native formats => ambiguity or single openapi resolve; either proves CLI parsing without Azure.
    if (result.resolution?.status === 'resolved' && result.resolution.sourceType === 'repo-spec') {
      return { __status: 'local-only', ...result.resolution };
    }
    if (result.resolution?.status === 'unresolved' && (result.resolution.rankedCandidates?.length ?? 0) >= 2) {
      return {
        __status: 'local-only',
        providerType: 'repo',
        sourceType: 'manual-review',
        specFormat: '',
        contractClass: 'authoritative'
      };
    }
    throw new Error('local R3 matrix did not exercise compiled CLI repo discovery');
  });

  return results;
}

/**
 * Main control flow, dependency-injected for unit tests.
 */
export async function runLiveValidation({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  const runner = deps.runner ?? defaultRunner;
  const log = deps.log ?? ((line) => console.error(line));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? delay;
  const runCases = deps.runCases ?? runDefaultCases;

  const flags = parseFlags(argv);
  const provisionFlags = parseProvisionFlags(env);
  const testedCommitHashPrefix = resolveCommitHashPrefix(env, runner);

  if (flags.dryRun || flags.renderPlan) {
    const plan = renderExecutionPlan({ provisionFlags, flags });
    const dryResults = CASE_CATALOG.map((row) => {
      if (row.localOnly) {
        return toEvidenceResult(row.id, 'local-only', { reasonCode: 'local-only-matrix' });
      }
      const missing = (row.requires ?? []).filter((key) => provisionFlags[key] === false);
      if (missing.length > 0) {
        return toEvidenceResult(row.id, 'requires-capability', { reasonCode: 'cost-guard-blocked' });
      }
      return toEvidenceResult(row.id, 'requires-capability', { reasonCode: 'dry-run-skipped' });
    });
    const evidence = buildEvidence(dryResults, { testedCommitHashPrefix });
    await mkdir(path.join(repoRoot, 'validation/evidence'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'validation/evidence/live-azure-surfaces.dry-run.local.json'),
      `${JSON.stringify({ plan, evidence }, null, 2)}\n`,
      'utf8'
    );
    log(`Dry-run plan: ${plan.caseCount} cases; suite ${SUITE_VERSION}; commit ${testedCommitHashPrefix || 'unset'}`);
    if (flags.renderPlan) {
      console.log(JSON.stringify(plan, null, 2));
    }
    return evidence;
  }

  const subscriptionId = resolveSubscriptionId(env, runner);
  const { location, resourceGroup: sharedResourceGroup } = requiredEnv({ ...env, AZURE_SUBSCRIPTION_ID: subscriptionId });

  const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
  if (!existsSync(cliPath)) {
    throw new Error(`Missing CLI bundle at ${cliPath}; run npm run build first`);
  }

  az(runner, ['account', 'set', '--subscription', subscriptionId]);
  az(runner, ['account', 'show']);

  const resumeSuffix = String(env.AZURE_LIVE_RESUME_SUFFIX ?? '').trim();
  const resumeMarker = String(env.AZURE_LIVE_RESUME_MARKER ?? '').trim();
  if (Boolean(resumeSuffix) !== Boolean(resumeMarker)) {
    throw new Error('AZURE_LIVE_RESUME_SUFFIX and AZURE_LIVE_RESUME_MARKER must be set together');
  }
  const suffix = resumeSuffix || randomBytes(4).toString('hex');
  const runMarker = resumeMarker || `run-${now()}-${suffix}`;
  const resourceGroup = sharedResourceGroup || `postman-azure-spec-live-${suffix}`;
  const ownsResourceGroup = !sharedResourceGroup;
  const manifest = buildManifestNames({
    suffix,
    runMarker,
    subscriptionId,
    resourceGroup,
    ownsResourceGroup,
    provisionFlags
  });

  let provisioned = Boolean(resumeSuffix) || flags.cancelRecover;
  const capabilities = {
    'apim-multi': { ok: provisionFlags['apim-multi'] !== false },
    'app-service': { ok: provisionFlags['app-service'] !== false }
  };
  let evidence;
  let cleanupFailure;
  try {
    if (flags.provision) {
      if (ownsResourceGroup) {
        log(`Creating resource group ${resourceGroup} in ${location}`);
        az(runner, [
          'group',
          'create',
          '--name',
          resourceGroup,
          '--location',
          location,
          '--tags',
          `${RUN_MARKER_TAG}=${runMarker}`
        ]);
      } else {
        log(`Using shared resource group ${resourceGroup} in ${location}`);
        const groupShow = azJson(runner, ['group', 'show', '--name', resourceGroup]);
        const groupSubscription = String(groupShow?.id ?? '').split('/')[2] ?? '';
        if (groupShow?.name !== resourceGroup || groupSubscription !== subscriptionId) {
          throw new Error(`AZURE_RESOURCE_GROUP ${resourceGroup} is not in the selected subscription`);
        }
      }
      provisioned = true;
      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      log('Deploying live-stack.bicep (APIM Consumption + App Service + optional multi-API)');
      az(runner, [
        'deployment',
        'group',
        'create',
        '--name',
        manifest.deploymentName,
        '--resource-group',
        resourceGroup,
        '--template-file',
        'validation/fixtures/azure/live-stack.bicep',
        '--parameters',
        `runMarker=${runMarker}`,
        `apimName=${manifest.apimName}`,
        `appServicePlanName=${manifest.planName}`,
        `siteName=${manifest.siteName}`,
        `repoSlug=${manifest.repoSlug}`,
        `provisionMultiApi=${provisionFlags['apim-multi'] ? 'true' : 'false'}`
      ]);
      recordManifestResource(manifest, { type: 'Microsoft.ApiManagement/service', name: manifest.apimName });
      recordManifestResource(manifest, { type: 'Microsoft.Web/serverfarms', name: manifest.planName });
      recordManifestResource(manifest, { type: 'Microsoft.Web/sites', name: manifest.siteName });

      log('Deploying App Service stub zip');
      const stubDir = path.join(repoRoot, 'validation/fixtures/azure/app-service-stub');
      const zipDir = await mkdtemp(path.join(os.tmpdir(), 'az-stub-zip-'));
      const zipPath = path.join(zipDir, 'stub.zip');
      runner('zip', [
        '-j',
        zipPath,
        path.join(stubDir, 'package.json'),
        path.join(stubDir, 'server.mjs'),
        path.join(stubDir, 'openapi.json')
      ]);
      az(runner, [
        'webapp',
        'deploy',
        '--resource-group',
        resourceGroup,
        '--name',
        manifest.siteName,
        '--src-path',
        zipPath,
        '--type',
        'zip'
      ]);
      await rm(zipDir, { recursive: true, force: true });

      const site = azJson(runner, ['webapp', 'show', '--resource-group', resourceGroup, '--name', manifest.siteName]);
      const stubUrl = `https://${site.defaultHostName}/openapi.json`;
      // Public apiDefinition.url only — no secret query parameters.
      log('Setting siteConfig.apiDefinition.url');
      az(runner, [
        'rest',
        '--method',
        'patch',
        '--url',
        `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${manifest.siteName}/config/web?api-version=2023-12-01`,
        '--body',
        JSON.stringify({ properties: { apiDefinition: { url: stubUrl } } })
      ]);

      await provisionOptionalApimApis({
        runner,
        log,
        manifest,
        subscriptionId,
        provisionFlags,
        capabilities
      });

      const webhookEndpointUrl = stubUrl.replace(/openapi\.json$/, 'health');
      if (
        provisionFlags['logic-app'] ||
        provisionFlags['custom-connector'] ||
        provisionFlags['template-spec'] ||
        provisionFlags['event-grid'] ||
        provisionFlags['function-app']
      ) {
        try {
          log('Deploying extended-stack.bicep (logic/connector/templatespec/eventgrid/functions)');
          const plan = azJson(runner, [
            'resource',
            'show',
            '--resource-group',
            resourceGroup,
            '--resource-type',
            'Microsoft.Web/serverfarms',
            '--name',
            manifest.planName
          ]);
          az(runner, [
            'deployment',
            'group',
            'create',
            '--name',
            manifest.extendedDeploymentName,
            '--resource-group',
            resourceGroup,
            '--template-file',
            'validation/fixtures/azure/extended-stack.bicep',
            '--parameters',
            `runMarker=${runMarker}`,
            `logicAppName=${manifest.logicAppName}`,
            `customConnectorName=${manifest.customConnectorName}`,
            `templateSpecName=${manifest.templateSpecName}`,
            `eventGridTopicName=${manifest.eventGridTopicName}`,
            `eventGridSubName=${manifest.eventGridSubName}`,
            `webhookEndpointUrl=${webhookEndpointUrl}`,
            `functionAppName=${manifest.functionAppName}`,
            `appServicePlanId=${plan?.id ?? ''}`,
            `provisionLogicApp=${provisionFlags['logic-app'] ? 'true' : 'false'}`,
            `provisionCustomConnector=${provisionFlags['custom-connector'] ? 'true' : 'false'}`,
            `provisionTemplateSpec=${provisionFlags['template-spec'] ? 'true' : 'false'}`,
            `provisionEventGrid=${provisionFlags['event-grid'] ? 'true' : 'false'}`,
            `provisionFunctionApp=${provisionFlags['function-app'] ? 'true' : 'false'}`
          ]);
          for (const [flag, key, type] of [
            ['logic-app', 'logicAppName', 'Microsoft.Logic/workflows'],
            ['custom-connector', 'customConnectorName', 'Microsoft.Web/customApis'],
            ['template-spec', 'templateSpecName', 'Microsoft.Resources/templateSpecs'],
            ['event-grid', 'eventGridTopicName', 'Microsoft.EventGrid/topics'],
            ['function-app', 'functionAppName', 'Microsoft.Web/sites']
          ]) {
            if (provisionFlags[flag]) {
              capabilities[flag] = { ok: true };
              recordManifestResource(manifest, { type, name: manifest[key] });
            } else {
              capabilities[flag] = { ok: false, reasonCode: 'cost-guard-blocked' };
            }
          }
        } catch (error) {
          const reasonCode = capabilityReasonFromError(error);
          for (const flag of ['logic-app', 'custom-connector', 'template-spec', 'event-grid', 'function-app']) {
            if (provisionFlags[flag] && !capabilities[flag]?.ok) {
              capabilities[flag] = { ok: false, reasonCode };
            }
          }
          log(`Extended stack partially blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      }

      if (provisionFlags['api-center']) {
        await provisionApiCenter({ runner, log, manifest, subscriptionId, capabilities });
      } else {
        capabilities['api-center'] = { ok: false, reasonCode: 'cost-guard-blocked' };
      }

      await provisionServiceBusIfGuarded({
        runner,
        log,
        manifest,
        subscriptionId,
        provisionFlags,
        capabilities
      });

      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      log('Waiting for APIM export availability');
      const deadline = now() + APIM_READY_TIMEOUT_MS;
      let ready = false;
      let lastProbeError = '';
      for (;;) {
        try {
          const exportProbe = azJson(runner, [
            'rest',
            '--method',
            'get',
            '--url',
            `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${manifest.apimName}/apis/payments-live?export=true&format=openapi%2Bjson-link&api-version=2024-05-01`
          ]);
          if (exportProbe?.link || exportProbe?.value?.link || exportProbe?.properties?.value?.link) {
            ready = true;
            break;
          }
          lastProbeError = 'export response contained no download link';
        } catch (error) {
          lastProbeError = redactSecrets(error instanceof Error ? error.message : String(error));
          if (classifyProbeError(lastProbeError) === 'fatal') {
            throw new Error(`APIM export probe failed with a non-retryable error: ${lastProbeError}`);
          }
          log(`APIM export probe not ready yet: ${lastProbeError}`);
        }
        if (now() >= deadline) break;
        await sleep(APIM_POLL_INTERVAL_MS);
      }
      if (!ready) {
        throw new Error(
          `APIM export did not become available within the ${APIM_READY_TIMEOUT_MS / 60000}-minute readiness ceiling` +
            (lastProbeError ? `; last probe error: ${lastProbeError}` : '')
        );
      }
    } else if (flags.cancelRecover) {
      const localManifestPath = path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json');
      if (existsSync(localManifestPath)) {
        Object.assign(manifest, JSON.parse(readFileSync(localManifestPath, 'utf8')));
      }
      provisioned = true;
      log(`Cancel-recover mode: will teardown run marker ${manifest.runMarker}`);
    }

    const results = flags.cancelRecover
      ? []
      : await runCases({ runner, log, manifest, subscriptionId, cliPath, capabilities });
    evidence = buildEvidence(results, { testedCommitHashPrefix });
    if (!flags.cancelRecover) {
      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-azure-surfaces.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      );
      log(
        `Live validation: ${evidence.passed} pass / ${evidence.failed} fail / ${evidence.requiresCapability} requires-capability / ${evidence.localOnly} local-only (${evidence.cases} cases)`
      );
      if (evidence.failed > 0) {
        throw new Error(`${evidence.failed} live validation case(s) failed`);
      }
    }
  } finally {
    if (flags.teardown && provisioned) {
      if (ownsResourceGroup) {
        try {
          const groupShow = azJson(runner, ['group', 'show', '--name', resourceGroup]);
          if (shouldDeleteGroup({ manifest, groupShow, subscriptionId })) {
            log(`Requesting deletion of run-marked resource group ${resourceGroup}`);
            az(runner, ['group', 'delete', '--yes', '--no-wait', '--name', resourceGroup]);
          } else {
            log(`REFUSING deletion: ${resourceGroup} failed the run-marker/subscription check; delete manually after review.`);
          }
        } catch (error) {
          log(`Teardown error for ${resourceGroup}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      } else {
        try {
          await teardownSharedGroupResources({ runner, log, manifest, subscriptionId, now, sleep });
        } catch (error) {
          cleanupFailure = error instanceof Error ? error : new Error(String(error));
          log(`Shared-group teardown failure: ${redactSecrets(cleanupFailure.message)}`);
        }
      }
    }
  }

  // Always publish sanitized evidence on failure paths (never claim unrun passes).
  if (!evidence) {
    evidence = buildEvidence(
      [toEvidenceResult('runner', 'fail', { reasonCode: 'cli-failed' })],
      { testedCommitHashPrefix }
    );
  }
  if (!flags.cancelRecover && !flags.dryRun) {
    await writeFile(
      path.join(repoRoot, 'validation/evidence/live-azure-surfaces.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8'
    );
  }
  if (cleanupFailure) throw cleanupFailure;
  return evidence;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = path.resolve(new URL(import.meta.url).pathname);
if (entrypoint === here) {
  runLiveValidation().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
