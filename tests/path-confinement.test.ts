import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('output path confinement', () => {
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
