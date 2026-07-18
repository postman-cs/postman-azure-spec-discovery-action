import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('CI workflow contract', () => {
  it('AZ-CI-001: single gate job, Node 24, one npm ci, one bundle, capped parallel local gates, read-only dist assert, no live Azure step', () => {
    // One gate job only
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:']);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow.match(/npm ci/g)).toHaveLength(1);
    expect(ciWorkflow.match(/npm run bundle/g)).toHaveLength(1);
    expect(ciWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(ciWorkflow).toContain('run dist       npm run verify:dist:assert');
    expect(ciWorkflow).not.toContain('npm run verify:dist\n');

    // No credentialed live Azure validation may run in CI (untrusted PRs).
    expect(ciWorkflow).not.toContain('validate-live-azure-surfaces');
    expect(ciWorkflow).not.toContain('AZURE_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('azure/login');
    expect(ciWorkflow).not.toContain('AZURE_CREDENTIALS');
  });
});
