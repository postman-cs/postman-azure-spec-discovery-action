import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAction, type CoreLike } from '../src/index.js';
import { runCli } from '../src/cli.js';
import type { AzureDependencies } from '../src/runtime.js';
import { contractOutputNames } from '../src/contracts.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';

const repoRoot = resolve(import.meta.dirname, '..');

const CLI_ONLY_INPUTS = [
  'repo-url',
  'repo-slug',
  'git-provider',
  'ref',
  'sha',
  'repo-root',
  'expected-service-name',
  'expected-api-ids-json',
  'api-filter',
  'service-mapping-json',
  'max-candidates',
  'dry-run',
  'preflight-checks',
  'preflight-permission-probe',
  'request-timeout-ms',
  'max-attempts'
];

function actionManifestInputs(): string[] {
  const manifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
    inputs?: Record<string, unknown>;
  };
  return Object.keys(manifest.inputs ?? {});
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const CLI_INPUT_NAMES = \[([^\]]*)\]/);
  if (!match) throw new Error('CLI_INPUT_NAMES array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string);
}

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function stubProvider(): SpecProvider {
  const armId = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments';
  const candidate: SpecCandidate = {
    id: armId,
    name: 'payments',
    providerType: 'apim',
    apiId: armId,
    resourceGroup: 'rg',
    tags: { 'postman:repo': 'org/payments' },
    supported: true,
    evidence: [],
    meta: {}
  };
  return {
    type: 'apim',
    probe: vi.fn(async () => 'available' as const),
    listCandidates: vi.fn(async () => [candidate]),
    exportSpec: vi.fn(async () => ({
      content: VALID_OPENAPI,
      format: 'openapi-json' as const,
      filename: 'index.json' as const,
      evidence: ['stub export']
    }))
  };
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag, and CLI extras stay on the allowlist', () => {
    const cli = new Set(cliInputNames());
    const manifest = new Set(actionManifestInputs());
    expect([...manifest].filter((name) => !cli.has(name))).toEqual([]);
    const extras = cliInputNames().filter((name) => !manifest.has(name) && !CLI_ONLY_INPUTS.includes(name));
    expect(extras).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => !cli.has(name))).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => manifest.has(name))).toEqual([]);
  });
});

describe('adapter parity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AZ-ENTRY-001: action shell and CLI-shaped env produce byte-equal outputs for all 22 outputs', async () => {
    // Hermetic repo root: empty temp dir so neither adapter picks up repo
    // specs/IaC from the action checkout or CI workspace, and both adapters
    // see identical ambient env (CI sets GITHUB_WORKSPACE; locally unset).
    const emptyRepoRoot = mkdtempSync(join(tmpdir(), 'az-parity-'));
    const previousCwd = process.cwd();
    process.chdir(emptyRepoRoot);
    vi.stubEnv('GITHUB_WORKSPACE', emptyRepoRoot);
    vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');
    const runtimeDeps = (provider: SpecProvider): Omit<AzureDependencies, 'core'> => ({
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile: vi.fn(async () => undefined),
      providers: [provider]
    });

    try {
      const actionOutputs: Record<string, string> = {};
      const inputVals: Record<string, string> = { 'api-id': 'payments', 'subscription-id': 'sub-1' };
      const core: CoreLike = {
        getInput: (name: string) => inputVals[name] ?? '',
        group: async (_n, fn) => fn(),
        info: () => undefined,
        warning: () => undefined,
        setOutput: (name, value) => {
          actionOutputs[name] = value;
        },
        setFailed: () => undefined
      };
      await runAction(core, runtimeDeps(stubProvider()));

      let stdout = '';
      await runCli(
        [
          '--api-id', 'payments',
          '--subscription-id', 'sub-1',
          '--repo-root', emptyRepoRoot,
          '--result-json', 'cli-result.json'
        ],
        {
          env: { ...process.env, GITHUB_WORKSPACE: emptyRepoRoot, POSTMAN_ACTIONS_TELEMETRY: 'off' },
          writeStdout: (chunk) => { stdout += chunk; },
          dependencies: runtimeDeps(stubProvider())
        }
      );
      const cliResult = JSON.parse(stdout) as { outputs: Record<string, string> };

      expect(Object.keys(actionOutputs).sort()).toEqual([...contractOutputNames].sort());
      for (const name of contractOutputNames) {
        expect(cliResult.outputs[name] ?? '', `output ${name}`).toBe(actionOutputs[name] ?? '');
      }
    } finally {
      process.chdir(previousCwd);
      rmSync(emptyRepoRoot, { recursive: true, force: true });
    }
  });
});
