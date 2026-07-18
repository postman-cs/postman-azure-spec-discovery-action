#!/usr/bin/env node
/* global console, process, URL */
// Live Azure validation runner.
//
// Usage (operator-run only; never in PR CI):
//   npm run build
//   AZURE_SUBSCRIPTION_ID=... AZURE_LOCATION=... \
//     node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
//
// Provisions a run-marked disposable resource group (APIM Consumption + current
// HTTP API + App Service plan/site + stub zip deploy), exercises the compiled
// dist/cli.cjs across six cases, writes sanitized committed evidence, and tears
// down only the group it created after verifying the run marker and subscription.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = process.cwd();
const RUN_MARKER_TAG = 'postman-azure-spec-discovery-live-run';
// Consumption-tier APIM activates in minutes and `az deployment group create`
// already blocks until the service + API report Succeeded, so the export probe
// only needs to absorb short control-plane consistency lag — not the 45-minute
// provisioning window of classic APIM tiers.
const APIM_READY_TIMEOUT_MS = 5 * 60 * 1000;
const APIM_POLL_INTERVAL_MS = 10 * 1000;

/**
 * Classify an export-probe failure. Only states that self-heal after a
 * Succeeded deployment are retryable (control-plane consistency lag, service
 * still updating, transient 5xx/throttle). Auth and request-shape errors never
 * self-heal, so polling on them would silently burn the whole ceiling.
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

export function parseFlags(argv) {
  return {
    provision: argv.includes('--provision'),
    teardown: argv.includes('--teardown')
  };
}

export function requiredEnv(env) {
  const subscriptionId = String(env.AZURE_SUBSCRIPTION_ID ?? '').trim();
  const location = String(env.AZURE_LOCATION ?? '').trim();
  if (!subscriptionId) throw new Error('AZURE_SUBSCRIPTION_ID is required');
  if (!location) throw new Error('AZURE_LOCATION is required');
  return { subscriptionId, location };
}

/**
 * Teardown guard: delete only a group this run created, in the selected
 * subscription, carrying the exact run-marker tag value for this run.
 */
export function shouldDeleteGroup({ manifest, groupShow, subscriptionId }) {
  if (!manifest?.resourceGroup || !manifest?.runMarker) return false;
  if (!groupShow) return false;
  if (groupShow.name !== manifest.resourceGroup) return false;
  const groupSubscription = String(groupShow.id ?? '').split('/')[2] ?? '';
  if (groupSubscription !== subscriptionId) return false;
  const marker = groupShow.tags?.[RUN_MARKER_TAG];
  return marker === manifest.runMarker;
}

/** Sanitize a case result down to the committed evidence schema (no IDs/hosts/URLs). */
export function toEvidenceResult(name, status, resolution) {
  return {
    name,
    status,
    sourceType: resolution?.sourceType ?? '',
    providerType: resolution?.providerType ?? '',
    specFormat: resolution?.specFormat ?? ''
  };
}

export function buildEvidence(results) {
  const passed = results.filter((result) => result.status === 'pass').length;
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString().slice(0, 10),
    cases: results.length,
    passed,
    failed: results.length - passed,
    results
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

/**
 * Main control flow, dependency-injected for unit tests (AZ-LIVE-002):
 *   deps.runner  — execFileSync-compatible process runner
 *   deps.log     — line logger
 *   deps.now     — clock (ms)
 *   deps.sleep   — delay(ms)
 */
export async function runLiveValidation({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  const runner = deps.runner ?? defaultRunner;
  const log = deps.log ?? ((line) => console.error(line));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? delay;
  const runCases = deps.runCases ?? runDefaultCases;

  const flags = parseFlags(argv);
  const { subscriptionId, location } = requiredEnv(env);

  const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
  if (!existsSync(cliPath)) {
    throw new Error(`Missing CLI bundle at ${cliPath}; run npm run build first`);
  }

  az(runner, ['account', 'set', '--subscription', subscriptionId]);
  az(runner, ['account', 'show']);

  // Crash recovery: AZURE_LIVE_RESUME_SUFFIX + AZURE_LIVE_RESUME_MARKER reuse a
  // stack a previous interrupted run provisioned (teardown guard still verifies
  // the run-marker tag on the group before deleting anything).
  const resumeSuffix = String(env.AZURE_LIVE_RESUME_SUFFIX ?? '').trim();
  const resumeMarker = String(env.AZURE_LIVE_RESUME_MARKER ?? '').trim();
  if (Boolean(resumeSuffix) !== Boolean(resumeMarker)) {
    throw new Error('AZURE_LIVE_RESUME_SUFFIX and AZURE_LIVE_RESUME_MARKER must be set together');
  }
  const suffix = resumeSuffix || randomBytes(4).toString('hex');
  const runMarker = resumeMarker || `run-${now()}-${suffix}`;
  const resourceGroup = `postman-azure-spec-live-${suffix}`;
  const apimName = `pmspecapim${suffix}`;
  const planName = `pmspecplan${suffix}`;
  const siteName = `pmspecsite${suffix}`;
  const manifest = { resourceGroup, runMarker, subscriptionId, apimName, planName, siteName };

  let provisioned = Boolean(resumeSuffix);
  const results = [];
  try {
    if (flags.provision) {
      log(`Creating resource group ${resourceGroup} in ${location}`);
      az(runner, [
        'group', 'create',
        '--name', resourceGroup,
        '--location', location,
        '--tags', `${RUN_MARKER_TAG}=${runMarker}`
      ]);
      provisioned = true;
      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      log('Deploying live-stack.bicep (APIM Consumption + App Service)');
      az(runner, [
        'deployment', 'group', 'create',
        '--resource-group', resourceGroup,
        '--template-file', 'validation/fixtures/azure/live-stack.bicep',
        '--parameters',
        `runMarker=${runMarker}`,
        `apimName=${apimName}`,
        `appServicePlanName=${planName}`,
        `siteName=${siteName}`
      ]);

      log('Deploying App Service stub zip');
      const stubDir = path.join(repoRoot, 'validation/fixtures/azure/app-service-stub');
      const zipDir = await mkdtemp(path.join(os.tmpdir(), 'az-stub-zip-'));
      const zipPath = path.join(zipDir, 'stub.zip');
      runner('zip', ['-j', zipPath, path.join(stubDir, 'package.json'), path.join(stubDir, 'server.mjs'), path.join(stubDir, 'openapi.json')]);
      az(runner, ['webapp', 'deploy', '--resource-group', resourceGroup, '--name', siteName, '--src-path', zipPath, '--type', 'zip']);
      await rm(zipDir, { recursive: true, force: true });

      const site = azJson(runner, ['webapp', 'show', '--resource-group', resourceGroup, '--name', siteName]);
      const stubUrl = `https://${site.defaultHostName}/openapi.json`;
      log(`Setting siteConfig.apiDefinition.url`);
      az(runner, [
        'rest', '--method', 'patch',
        '--url',
        `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${siteName}/config/web?api-version=2023-12-01`,
        '--body', JSON.stringify({ properties: { apiDefinition: { url: stubUrl } } })
      ]);

      log('Waiting for APIM export availability');
      const deadline = now() + APIM_READY_TIMEOUT_MS;
      let ready = false;
      let lastProbeError = '';
      for (;;) {
        try {
          const exportProbe = azJson(runner, [
            'rest', '--method', 'get',
            '--url',
            `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${apimName}/apis/payments-live?export=true&format=openapi%2Bjson-link&api-version=2022-08-01`
          ]);
          if (exportProbe?.link || exportProbe?.value?.link || exportProbe?.properties?.value?.link) {
            ready = true;
            break;
          }
          lastProbeError = 'export response contained no download link';
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          // Redact SAS signatures before logging or throwing.
          lastProbeError = raw.replace(/sig=[^&\s"']+/gi, 'sig=REDACTED');
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
    }

    const caseResults = await runCases({ runner, log, manifest, subscriptionId, cliPath });
    results.push(...caseResults);

    const evidence = buildEvidence(results);
    await writeFile(
      path.join(repoRoot, 'validation/evidence/live-azure-surfaces.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8'
    );
    log(`Live validation: ${evidence.passed}/${evidence.cases} passed`);

    if (evidence.failed > 0) {
      throw new Error(`${evidence.failed} live validation case(s) failed`);
    }
    return evidence;
  } finally {
    if (flags.teardown && provisioned) {
      try {
        const groupShow = azJson(runner, ['group', 'show', '--name', resourceGroup]);
        if (shouldDeleteGroup({ manifest, groupShow, subscriptionId })) {
          log(`Requesting deletion of run-marked resource group ${resourceGroup}`);
          az(runner, ['group', 'delete', '--yes', '--no-wait', '--name', resourceGroup]);
        } else {
          log(`REFUSING deletion: ${resourceGroup} failed the run-marker/subscription check; delete manually after review.`);
        }
      } catch (error) {
        log(`Teardown error for ${resourceGroup}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function runCli(runner, cliPath, args, cwd) {
  const stdout = runner(process.execPath, [cliPath, ...args], { cwd });
  return JSON.parse(stdout);
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

async function runDefaultCases({ runner, log, manifest, subscriptionId, cliPath }) {
  const results = [];
  const armApiId = `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/Microsoft.ApiManagement/service/${manifest.apimName}/apis/payments-live`;

  async function runCase(name, fn) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `az-live-${name}-`));
    try {
      const resolution = await fn(workspace);
      results.push(toEvidenceResult(name, 'pass', resolution));
      log(`case ${name}: pass`);
    } catch (error) {
      results.push(toEvidenceResult(name, 'fail'));
      log(`case ${name}: fail (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  const expectResolved = (result, expectedSource) => {
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
  };

  await runCase('apim-explicit-api-id', async (workspace) => {
    const result = runCli(runner, cliPath, [
      '--subscription-id', subscriptionId,
      '--resource-group', manifest.resourceGroup,
      '--api-id', armApiId,
      '--repo-root', workspace,
      '--result-json', 'result.json'
    ], workspace);
    return expectResolved(result, 'apim-export');
  });

  await runCase('apim-discovery', async (workspace) => {
    const result = runCli(runner, cliPath, [
      '--subscription-id', subscriptionId,
      '--resource-group', manifest.resourceGroup,
      '--expected-service-name', 'payments-live',
      '--repo-root', workspace,
      '--result-json', 'result.json'
    ], workspace);
    return expectResolved(result, 'apim-export');
  });

  await runCase('app-service-api-definition', async (workspace) => {
    const result = runCli(runner, cliPath, [
      '--subscription-id', subscriptionId,
      '--resource-group', manifest.resourceGroup,
      '--expected-service-name', 'payments-live-site',
      '--api-filter', manifest.siteName,
      '--repo-root', workspace,
      '--result-json', 'result.json'
    ], workspace);
    return expectResolved(result, 'app-service-api-definition');
  });

  await runCase('discover-many', async (workspace) => {
    const result = runCli(runner, cliPath, [
      '--mode', 'discover-many',
      '--subscription-id', subscriptionId,
      '--resource-group', manifest.resourceGroup,
      '--repo-root', workspace,
      '--result-json', 'result.json'
    ], workspace);
    if (!Array.isArray(result.discovered) || result.discovered.length < 1) {
      throw new Error('discover-many exported no services');
    }
    if ((result.exportSummary?.failed ?? 1) !== 0) {
      throw new Error('discover-many reported export failures');
    }
    return { sourceType: 'discover-many', providerType: result.discovered[0]?.providerType ?? '', specFormat: result.discovered[0]?.specFormat ?? '' };
  });

  await runCase('iac-single', async (workspace) => {
    await seedIacSingle(workspace);
    const result = runCli(runner, cliPath, [
      '--repo-root', workspace,
      '--preflight-checks', 'false',
      '--subscription-id', subscriptionId,
      '--result-json', 'result.json'
    ], workspace);
    return expectResolved(result, 'iac-embedded');
  });

  await runCase('ambiguity', async (workspace) => {
    await seedAmbiguity(workspace);
    const result = runCli(runner, cliPath, [
      '--repo-root', workspace,
      '--preflight-checks', 'false',
      '--subscription-id', subscriptionId,
      '--result-json', 'result.json'
    ], workspace);
    const resolution = result.resolution;
    if (!resolution || resolution.status !== 'unresolved') {
      throw new Error(`expected unresolved ambiguity, got ${resolution?.status ?? 'missing'}`);
    }
    if ((resolution.rankedCandidates?.length ?? 0) < 2) {
      throw new Error('expected at least two ranked candidates');
    }
    return resolution;
  });

  return results;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = path.resolve(new URL(import.meta.url).pathname);
if (entrypoint === here) {
  runLiveValidation().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
