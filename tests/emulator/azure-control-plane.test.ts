/**
 * Azure emulator lane: proves the SHIPPED CLI bundle (dist/cli.cjs) speaks the
 * real Azure wire protocol against a hermetic compound fixture -- Entra ID
 * client-credentials auth, ARM subscription preflight, APIM API resolution,
 * the two-step APIM export (ARM returns a Storage SAS link, bytes ride the SAS
 * leg with no bearer token), expired-SAS re-export recovery, and
 * untrusted-SAS-host containment -- with zero live Azure traffic.
 *
 * There is deliberately no endpoint-override product seam; transport rides the
 * runtime's own env contracts (HTTPS_PROXY for the @azure/identity MSAL and
 * ARM SDK pipelines, NODE_USE_ENV_PROXY=1 for the undici SAS fetch,
 * NODE_EXTRA_CA_CERTS for the run-scoped CA). The fixture proxy refuses every
 * CONNECT outside its Azure host allowlist, so green means hermetic. The lane
 * is excluded from `npm test`; CI runs it as a budgeted Linux step (no
 * container required).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EVIL_API_ARM_ID,
  EVIL_SAS_HOST,
  FIXTURE_CLIENT_ID,
  FIXTURE_SUBSCRIPTION_ID,
  FIXTURE_TENANT_ID,
  FLAKY_API_ARM_ID,
  FLAKY_API_ID,
  GOOD_API_ARM_ID,
  SAS_HOST,
  startAzureFixture,
  type AzureFixture
} from './fixture/azure-fixture.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..');
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'dist', 'cli.cjs');

let fixture: AzureFixture;
const workspaces: string[] = [];

const execFileAsync = promisify(execFile);

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function createWorkspace(name: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  workspaces.push(workspace);
  return workspace;
}

// The fixture servers live in this test process, so the CLI child MUST run
// asynchronously: execFileSync would block the event loop and deadlock the
// proxy (it could never accept the child's CONNECT).
async function runCli(workspace: string, env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_ENTRYPOINT, '--result-json', 'result.json'], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      // A hung transport must fail the test, not freeze the worker forever.
      timeout: 45_000,
      killSignal: 'SIGKILL',
      env: {
        // Deliberately NOT process.env: the child sees only the fixture's
        // transport contracts, proving no ambient az-cli/IMDS state leaks in.
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        POSTMAN_ACTIONS_TELEMETRY: 'off',
        HTTPS_PROXY: fixture.proxyUrl,
        HTTP_PROXY: fixture.proxyUrl,
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: fixture.caPath,
        AZURE_TENANT_ID: FIXTURE_TENANT_ID,
        AZURE_CLIENT_ID: FIXTURE_CLIENT_ID,
        AZURE_CLIENT_SECRET: 'ws10-emulator-secret',
        INPUT_MODE: 'resolve-one',
        INPUT_SUBSCRIPTION_ID: FIXTURE_SUBSCRIPTION_ID,
        INPUT_REPO_ROOT: workspace,
        INPUT_OUTPUT_DIR: 'discovered-specs',
        ...env
      }
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : String(failure.stdout ?? ''),
      stderr: typeof failure.stderr === 'string' ? failure.stderr : String(failure.stderr ?? '')
    };
  }
}

function readResult(workspace: string): { outputs: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(workspace, 'result.json'), 'utf8')) as {
    outputs: Record<string, string>;
  };
}

beforeAll(async () => {
  // The ARM leg rides Node's global fetch, which honors NODE_USE_ENV_PROXY on
  // the shipped Node 24 runtime but NOT on Node 25+ (where it dials direct and
  // would leak live requests to management.azure.com). Hard-fail rather than
  // let the lane silently go non-hermetic on a newer local toolchain.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  expect(
    nodeMajor,
    `emulator lane requires Node 24 (shipped runtime); Node ${process.versions.node} global fetch ignores NODE_USE_ENV_PROXY and would dial live Azure`
  ).toBe(24);
  expect(existsSync(CLI_ENTRYPOINT), `missing ${CLI_ENTRYPOINT}; run npm run bundle first`).toBe(true);
  fixture = await startAzureFixture();
});

afterAll(async () => {
  await fixture?.close();
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe('azure fixture transport', () => {
  it('resolve-one exports an explicit APIM API through the proxied control plane and SAS leg', async () => {
    const workspace = await createWorkspace('ws10-azure-apim');
    const result = await runCli(workspace, { INPUT_API_ID: GOOD_API_ARM_ID });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('apim-export');
    expect(outputs['provider-type']).toBe('apim');
    expect(outputs['api-id']).toBe(GOOD_API_ARM_ID);
    expect(outputs['spec-format']).toBe('openapi-json');
    expect(outputs['spec-path']).toMatch(/^discovered-specs\//);
    expect(existsSync(path.join(workspace, outputs['spec-path']!))).toBe(true);

    // Transport proof: Entra token, ARM preflight, APIM export, and the SAS
    // download all rode the fixture through the CONNECT proxy.
    expect(
      fixture.requests.some(
        (r) => r.host === 'login.microsoftonline.com' && r.method === 'POST' && r.path.endsWith('/oauth2/v2.0/token')
      )
    ).toBe(true);
    expect(
      fixture.requests.some(
        (r) => r.host === 'management.azure.com' && r.path === `/subscriptions/${FIXTURE_SUBSCRIPTION_ID}`
      )
    ).toBe(true);
    expect(
      fixture.requests.some(
        (r) => r.host === 'management.azure.com' && r.path === GOOD_API_ARM_ID && r.search.includes('export=true')
      )
    ).toBe(true);
    // The SAS leg is a bare Storage download: no ARM bearer token may ride it.
    const sasRequests = fixture.requests.filter((r) => r.host === SAS_HOST);
    expect(sasRequests.length).toBeGreaterThan(0);
    expect(sasRequests.every((r) => !r.hadAuthorization)).toBe(true);
    expect(fixture.deniedHosts).toEqual([]);
  });

  it('recovers from an expired SAS link by re-exporting for a fresh one', async () => {
    const workspace = await createWorkspace('ws10-azure-flaky');
    const result = await runCli(workspace, { INPUT_API_ID: FLAKY_API_ARM_ID });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('apim-export');
    expect(existsSync(path.join(workspace, outputs['spec-path']!))).toBe(true);

    // Wire proof of the retry protocol: first SAS 403'd, the client discarded
    // it, re-exported via ARM, and downloaded from the fresh link.
    const exportCalls = fixture.requests.filter(
      (r) => r.host === 'management.azure.com' && r.path === FLAKY_API_ARM_ID && r.search.includes('export=true')
    );
    expect(exportCalls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.requests.some((r) => r.host === SAS_HOST && r.path === `/apim-export/${FLAKY_API_ID}-1.json`)).toBe(
      true
    );
    expect(fixture.requests.some((r) => r.host === SAS_HOST && r.path === `/apim-export/${FLAKY_API_ID}-2.json`)).toBe(
      true
    );
    expect(fixture.deniedHosts).toEqual([]);
  });

  it('contains a SAS link pointing at a host outside the egress allowlist', async () => {
    const workspace = await createWorkspace('ws10-azure-evil');
    const result = await runCli(workspace, { INPUT_API_ID: EVIL_API_ARM_ID });

    // The evil host never served bytes: every dial attempt died at the proxy
    // as a refused CONNECT (recorded below), the export hard-failed, and no
    // spec artifact was produced from the poisoned link.
    expect(fixture.requests.some((r) => r.host === EVIL_SAS_HOST)).toBe(false);
    expect(fixture.deniedHosts).toContain(EVIL_SAS_HOST);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(`Failed fetching https://${EVIL_SAS_HOST}/`);
    expect(existsSync(path.join(workspace, 'result.json'))).toBe(false);
  });

  it('fails preflight when ARM denies the subscription read', async () => {
    const workspace = await createWorkspace('ws10-azure-denied');
    const result = await runCli(workspace, {
      INPUT_API_ID: GOOD_API_ARM_ID,
      INPUT_SUBSCRIPTION_ID: '99999999-9999-9999-9999-999999999999'
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/403|AuthorizationFailed|denied/i);
  });
});
