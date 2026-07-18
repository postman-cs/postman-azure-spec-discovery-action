import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

function template(name: string): string {
  return JSON.stringify({
    resources: [
      {
        type: 'Microsoft.ApiManagement/service/apis',
        name: `svc/${name}`,
        properties: {
          format: 'openapi+json',
          value: {
            openapi: '3.0.3',
            info: { title: name, version: '1.0.0' },
            paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } }
          }
        }
      }
    ]
  });
}

describe('local IaC resolution', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-iac-provider-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function dependencies(writeSpecFile: AzureDependencies['writeSpecFile']): AzureDependencies {
    return {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => { throw new Error('local IaC must not enumerate subscriptions'); })
      },
      createApimClient: () => { throw new Error('local IaC must not create APIM client'); },
      createAppServiceClient: () => { throw new Error('local IaC must not create App Service client'); },
      writeSpecFile
    };
  }

  it('AZ-IAC-002: exactly one valid inline document resolves with confidence 100', async () => {
    await writeFile(path.join(repoRoot, 'main.json'), template('payments'));
    const writeSpecFile = vi.fn<AzureDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(resolveInputs({ INPUT_REPO_ROOT: repoRoot }), dependencies(writeSpecFile));
    expect(result.resolution).toMatchObject({ status: 'resolved', sourceType: 'iac-embedded', confidence: 100 });
    expect(writeSpecFile).toHaveBeenCalledTimes(1);
  });

  it('AZ-IAC-002: multiple valid inline documents remain manual-review and write nothing', async () => {
    await writeFile(path.join(repoRoot, 'alpha.json'), template('alpha'));
    await writeFile(path.join(repoRoot, 'bravo.json'), template('bravo'));
    const writeSpecFile = vi.fn<AzureDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(resolveInputs({ INPUT_REPO_ROOT: repoRoot }), dependencies(writeSpecFile));
    expect(result.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(result.resolution?.rankedCandidates).toHaveLength(2);
    expect(writeSpecFile).not.toHaveBeenCalled();
  });
});
