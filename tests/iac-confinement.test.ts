import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanAzureIac } from '../src/lib/repo/azure-iac-scanner.js';

function armTemplate(name: string): string {
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
            paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } }
          }
        }
      }
    ]
  });
}

describe('IaC scan confinement', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-iac-confinement-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('AZ-IAC-003: scans at most 200 candidate files in stable lexical order', async () => {
    await Promise.all(
      Array.from({ length: 205 }, async (_, index) => {
        const name = `api-${String(index).padStart(3, '0')}`;
        await writeFile(path.join(repoRoot, `${name}.json`), armTemplate(name));
      })
    );

    const first = await scanAzureIac(repoRoot, 'discovered-specs');
    const second = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(first.candidates).toHaveLength(200);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(second.candidates.map((candidate) => candidate.id));
    expect(first.candidates[0]?.id).toContain('api-000.json');
    expect(first.candidates.at(-1)?.id).toContain('api-199.json');
  });

  it('AZ-IAC-003: depth 6 is included while depth 7, ignored/output dirs, and out-of-root symlinks are excluded', async () => {
    const depth6 = path.join(repoRoot, 'd1/d2/d3/d4/d5/d6');
    const depth7 = path.join(depth6, 'd7');
    await mkdir(depth7, { recursive: true });
    await writeFile(path.join(depth6, 'included.json'), armTemplate('included'));
    await writeFile(path.join(depth7, 'too-deep.json'), armTemplate('too-deep'));
    for (const directory of ['node_modules', '.git', 'dist', 'discovered-specs']) {
      await mkdir(path.join(repoRoot, directory), { recursive: true });
      await writeFile(path.join(repoRoot, directory, 'ignored.json'), armTemplate(directory));
    }
    const outside = await mkdtemp(path.join(tmpdir(), 'az-iac-outside-'));
    try {
      await writeFile(path.join(outside, 'outside.json'), armTemplate('outside'));
      await symlink(path.join(outside, 'outside.json'), path.join(repoRoot, 'outside-link.json'));
      const result = await scanAzureIac(repoRoot, 'discovered-specs');
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(['svc/included']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
