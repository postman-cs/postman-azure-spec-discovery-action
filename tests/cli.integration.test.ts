import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { contractOutputNames } from '../src/contracts.js';

describe('CLI argument parsing', () => {
  it('AZ-CLI-001: help/version parse alone; unknown, duplicate, missing-value, positional, and combined flags reject', () => {
    expect(parseCliArgs(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'], {})).toEqual({ kind: 'version' });

    expect(() => parseCliArgs(['--nope'], {})).toThrow('Unknown option: --nope');
    expect(() => parseCliArgs(['--mode', 'resolve-one', '--mode', 'resolve-one'], {})).toThrow('Duplicate option: --mode');
    expect(() => parseCliArgs(['--mode'], {})).toThrow('Missing value for --mode');
    expect(() => parseCliArgs(['positional'], {})).toThrow('Unexpected positional argument: positional');
    expect(() => parseCliArgs(['--help', '--version'], {})).toThrow('cannot be combined');

    const run = parseCliArgs(['--subscription-id', 'sub-1', '--result-json', 'out/result.json'], {});
    expect(run.kind).toBe('run');
    if (run.kind === 'run') {
      expect(run.inputEnv.INPUT_SUBSCRIPTION_ID).toBe('sub-1');
      expect(run.resultJsonPath).toBe('out/result.json');
    }
  });

  it('AZ-CLI-004: help enumerates every accepted value flag and meta option', async () => {
    let help = '';
    await runCli(['--help'], { env: {}, writeStdout: (chunk) => { help += chunk; } });
    expect(help).toContain('Every discovery option expects a value');
    const action = (await import('yaml')).parse(await readFile(path.resolve(import.meta.dirname, '../action.yml'), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    const acceptedValueFlags = [
      'mode', 'subscription-id', 'resource-group', 'api-id', 'repo-url', 'repo-slug', 'git-provider', 'ref', 'sha',
      'repo-root', 'expected-service-name', 'expected-api-ids-json', 'api-filter', 'service-mapping-json',
      'repo-tag-keys-json', 'output-dir', 'max-candidates', 'dry-run', 'preflight-checks',
      'preflight-permission-probe', 'request-timeout-ms', 'max-attempts', 'postman-api-key', 'postman-access-token'
    ];
    for (const name of acceptedValueFlags) expect(help).toContain(`--${name} <value>`);
    for (const name of Object.keys(action.inputs)) expect(help).toContain(`--${name} <value>`);
    for (const option of ['--result-json <path>', '--dotenv-path <path>', '--help', '--version']) expect(help).toContain(option);
  });
});

describe('dotenv serialization', () => {
  it('AZ-CLI-002: all 25 outputs serialize as unique POSTMAN_AZURE_SPEC_* lines with JSON-quoted values', () => {
    const outputs: Record<string, string> = {};
    for (const name of contractOutputNames) {
      outputs[name] = `value-of-${name}`;
    }
    const dotenv = toDotenv(outputs);
    const lines = dotenv.split('\n');

    expect(lines).toHaveLength(25);
    const keys = lines.map((line) => line.split('=')[0]);
    expect(new Set(keys).size).toBe(25);
    for (const key of keys) {
      expect(key).toMatch(/^POSTMAN_AZURE_SPEC_/);
    }
    expect(keys).toContain('POSTMAN_AZURE_SPEC_API_ID');
    expect(keys).toContain('POSTMAN_AZURE_SPEC_FILES_JSON');
    expect(dotenv).not.toContain('POSTMAN_AWS_');
    expect(dotenv).not.toContain('GATEWAY_ID');
    for (const line of lines) {
      const value = line.slice(line.indexOf('=') + 1);
      expect(() => JSON.parse(value)).not.toThrow();
    }
  });
});

describe('runCli side effects', () => {
  let workspace: string;
  let previousCwd: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'az-cli-run-'));
    previousCwd = process.cwd();
    process.chdir(workspace);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('AZ-CLI-003: runCli resolves a repo spec, writes result-json + dotenv, and prints the result JSON to stdout', async () => {
    vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    const spec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Payments', version: '1.0.0' },
      paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
    });
    await writeFile(path.join(workspace, 'openapi.json'), spec, 'utf8');

    let stdout = '';
    await runCli(
      ['--repo-root', workspace, '--result-json', 'out/result.json', '--dotenv-path', 'out/outputs.env'],
      { writeStdout: (chunk) => { stdout += chunk; } }
    );

    const printed = JSON.parse(stdout) as { outputs: Record<string, string> };
    expect(printed.outputs['resolution-status']).toBe('resolved');
    expect(printed.outputs['source-type']).toBe('repo-spec');

    const resultJson = JSON.parse(await readFile(path.join(workspace, 'out/result.json'), 'utf8')) as {
      outputs: Record<string, string>;
    };
    expect(resultJson.outputs).toEqual(printed.outputs);
    for (const name of contractOutputNames) {
      expect(resultJson.outputs[name]).toBeDefined();
    }

    const dotenv = await readFile(path.join(workspace, 'out/outputs.env'), 'utf8');
    expect(dotenv.split('\n')).toHaveLength(25);
    expect(dotenv).toContain('POSTMAN_AZURE_SPEC_RESOLUTION_STATUS="resolved"');
    expect(dotenv).toContain('POSTMAN_AZURE_SPEC_FILES_JSON=""');
  });

  it('rejects result-json through a symlink without writing outside the workspace', async () => {
    vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    const external = await mkdtemp(path.join(tmpdir(), 'az-cli-external-'));
    await mkdir(path.join(workspace, 'out'));
    await symlink(external, path.join(workspace, 'out', 'linked'), 'dir');
    await expect(
      runCli(['--repo-root', workspace, '--result-json', 'out/linked/result.json'], {
        writeStdout: () => undefined,
        dependencies: {
          subscriptions: {
            get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
            list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
          },
          createApimClient: () => { throw new Error('not used'); },
          createAppServiceClient: () => { throw new Error('not used'); },
          writeSpecFile: async () => undefined,
          providers: []
        }
      })
    ).rejects.toThrow('symbolic links');
    await expect(readFile(path.join(external, 'result.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(external, { recursive: true, force: true });
  });
});
