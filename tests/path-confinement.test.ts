import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { writeFileWithinRoot } from '../src/lib/utils/resolve-path-within-root.js';

describe('output path confinement', () => {
  it('rejects an output directory symlink without writing outside the root', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-path-symlink-'));
    const root = path.join(sandbox, 'repo');
    const external = path.join(sandbox, 'external');
    await mkdir(root);
    await mkdir(external);
    await symlink(external, path.join(root, 'output-dir'), 'dir');
    await expect(writeFileWithinRoot(root, 'output-dir/spec.json', '{}', 'output-dir')).rejects.toThrow(
      /symbolic links.*output-dir\/spec\.json/
    );
    expect(existsSync(path.join(external, 'spec.json'))).toBe(false);
    await rm(sandbox, { recursive: true, force: true });
  });

  it('rejects a nested symlink component and permits a normal nested write', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-path-nested-'));
    const root = path.join(sandbox, 'repo');
    const external = path.join(sandbox, 'external');
    await mkdir(path.join(root, 'output-dir'), { recursive: true });
    await mkdir(external);
    await symlink(external, path.join(root, 'output-dir', 'nested'), 'dir');
    await expect(writeFileWithinRoot(root, 'output-dir/nested/spec.json', '{}', 'output-dir')).rejects.toThrow(
      'symbolic links'
    );
    expect(existsSync(path.join(external, 'spec.json'))).toBe(false);
    await writeFileWithinRoot(root, 'safe/nested/spec.json', '{"ok":true}', 'output-dir');
    expect(await readFile(path.join(root, 'safe/nested/spec.json'), 'utf8')).toBe('{"ok":true}');
    await rm(sandbox, { recursive: true, force: true });
  });

  it('rejects an existing target-file symlink without modifying its destination', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-path-target-symlink-'));
    const root = path.join(sandbox, 'repo');
    const external = path.join(sandbox, 'external.json');
    await mkdir(root);
    await writeFile(external, 'unchanged', 'utf8');
    await symlink(external, path.join(root, 'result.json'));
    await expect(writeFileWithinRoot(root, 'result.json', 'changed', 'Output path')).rejects.toThrow(
      'symbolic links'
    );
    expect(await readFile(external, 'utf8')).toBe('unchanged');
    await rm(sandbox, { recursive: true, force: true });
  });

  it('AZ-CONTRACT-004: CLI rejects output-dir escape with exit 1 and no outside write', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-path-confinement-'));
    const repoRoot = path.join(sandbox, 'repo');
    await mkdir(repoRoot);
    try {
      const cli = path.resolve(process.cwd(), 'dist/cli.cjs');
      const result = spawnSync(
        process.execPath,
        [cli, '--repo-root', repoRoot, '--output-dir', '../escape', '--result-json', 'result.json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, POSTMAN_ACTIONS_TELEMETRY: 'off' }
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('output-dir must stay within repo-root/workspace; received ../escape');
      expect(existsSync(path.join(sandbox, 'escape'))).toBe(false);
      expect(existsSync(path.join(repoRoot, 'result.json'))).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
