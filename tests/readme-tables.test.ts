import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('README action tables', () => {
  it('AZ-DOCS-001: README tables match action.yml and docs name the three v1 providers and non-goals', () => {
    expect(() =>
      execFileSync(process.execPath, [resolve(repoRoot, 'scripts/render-action-tables.mjs'), '--check'], {
        cwd: repoRoot,
        stdio: 'pipe'
      })
    ).not.toThrow();

    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const providersDoc = readFileSync(resolve(repoRoot, 'docs/providers.md'), 'utf8');

    for (const provider of ['`apim`', '`app-service`', '`iac-local`']) {
      expect(readme).toContain(provider);
      expect(providersDoc).toContain(provider);
    }
    // Non-goals must be documented so users do not expect them.
    for (const nonGoal of ['API Center', 'Functions', 'Container Apps']) {
      expect(readme).toContain(nonGoal);
    }
    expect(readme).toContain('manual review');
  });
});
