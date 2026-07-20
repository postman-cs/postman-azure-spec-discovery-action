import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('README action tables', () => {
  it('AZ-DOCS-001: README tables match action.yml and docs name providers, discovery flow, and non-goals', () => {
    expect(() =>
      execFileSync(process.execPath, [resolve(repoRoot, 'scripts/render-action-tables.mjs'), '--check'], {
        cwd: repoRoot,
        stdio: 'pipe'
      })
    ).not.toThrow();

    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const providersDoc = readFileSync(resolve(repoRoot, 'docs/providers.md'), 'utf8');
    expect(readme).toContain('<!-- coverage-table:start -->');
    expect(readme).toContain('coverage/route-claims.json');
    expect(readme).toMatch(/live:`apim-explicit-api-id`/);
    expect(readme).toMatch(/unit-only/);

    const providerIdentifiers = [
      '`apim`',
      '`api-center`',
      '`app-service`',
      '`custom-apis`',
      '`iac-local`',
      '`logic-apps`',
      '`template-specs`',
      '`event-grid`',
      '`service-bus`',
      '`function-bindings`'
    ];
    for (const provider of providerIdentifiers) {
      expect(readme).toContain(provider);
      expect(providersDoc).toContain(provider);
    }
    expect(readme).toMatch(/Exactly one repo-local native specification .* resolves without calling Azure/is);
    expect(readme).toMatch(/Multiple valid local specs fail closed/i);
    expect(readme).toMatch(/all available supported Azure candidates enter the same narrowing and ranking flow/i);
    // Non-goals must be documented so users do not expect them.
    for (const nonGoal of ['API Center', 'Container Apps']) {
      expect(readme).toContain(nonGoal);
    }
    expect(readme).toContain('manual review');
    expect(readme).toContain('Emit all 24 outputs');
    expect(providersDoc).toContain('## Security and IAM');
    expect(providersDoc).toContain('API Management Service Reader');
    expect(providersDoc).toContain('Inaccessible providers fail-soft');
    const support = readFileSync(resolve(repoRoot, 'SUPPORT.md'), 'utf8');
    expect(support).toContain('docs/providers.md#security-and-iam');
  });
});
