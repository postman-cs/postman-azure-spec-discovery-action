import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
describe('CI workflow contract', () => {
  it('AZ-CI-001: Linux and Windows gates, Node 24, read-only dist assert, no live Azure step', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  windows:']);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(ciWorkflow.match(/npm run bundle/g)).toHaveLength(1);
    expect(ciWorkflow).toContain('runs-on: windows-latest');
    expect(ciWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(ciWorkflow).toContain('run dist       npm run verify:dist:assert');
    expect(ciWorkflow).not.toContain('npm run verify:dist\n');

    expect(ciWorkflow).not.toContain('validate-live-azure-surfaces');
    expect(ciWorkflow).not.toContain('AZURE_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('azure/login');
    expect(ciWorkflow).not.toContain('AZURE_CREDENTIALS');
  });

  it('AZ-CI-002: supersedes only older PR runs and installs pinned binary actionlint', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ciWorkflow).toContain('workflow_dispatch:');
    expect(ciWorkflow).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash'
    );
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(ciWorkflow).toContain('1.7.11 "$RUNNER_TEMP"');
    expect(ciWorkflow).toContain('ACTIONLINT_BIN="$RUNNER_TEMP/actionlint"');
    expect(ciWorkflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('AZ-CI-003: never injects npm auth into PR-capable npm ci and uses lockfile-local commitlint', () => {
    expect(ciWorkflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(ciWorkflow).not.toContain('secrets.NPM_TOKEN');
    expect(ciWorkflow).not.toContain('NPM_TOKEN');
    expect(ciWorkflow).not.toMatch(/\bnpx\s+commitlint\b/);
    expect(ciWorkflow).toMatch(
      /run commitlint\s+(?:\.\/node_modules\/\.bin\/commitlint|node_modules\/\.bin\/commitlint)\b/
    );
    expect(ciWorkflow).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(ciWorkflow).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    // R10 history-depth matrix: Linux gate needs full history for PR commitlint;
    // Windows keeps checkout default/minimum depth (no explicit fetch-depth key).
    const gate = jobText(ciWorkflow, 'gate');
    const windows = jobText(ciWorkflow, 'windows');
    const isolateCheckout = (job: string): string => {
      const checkoutIdx = job.search(/- uses: actions\/checkout@[0-9a-f]{40}/);
      expect(checkoutIdx).toBeGreaterThanOrEqual(0);
      const afterCheckout = job.slice(checkoutIdx);
      const nextStepRel = afterCheckout.search(/\n {6}- /);
      return nextStepRel < 0 ? afterCheckout : afterCheckout.slice(0, nextStepRel);
    };
    const gateCheckout = isolateCheckout(gate);
    const windowsCheckout = isolateCheckout(windows);
    expect(gateCheckout).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(gateCheckout).toContain('fetch-depth: 0');
    expect(gate.indexOf('fetch-depth: 0')).toBeGreaterThanOrEqual(0);
    expect(gate.indexOf('fetch-depth: 0')).toBeLessThan(gate.indexOf('run commitlint'));
    expect(windowsCheckout).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(windowsCheckout).not.toMatch(/^\s*fetch-depth\s*:/m);
  });

  it('AZ-CI-004: Windows exact cache pin, miss-only install, sole direct npm test, no queue', () => {
    const windows = jobText(ciWorkflow, 'windows');
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);

    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    expect(windows).toContain('actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0');
    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('enableCrossOsArchive');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);

    expect(windows.match(/^\s*- run: npm test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/\bnpm test\b/g) ?? []).toHaveLength(1);
    expect(windows).not.toMatch(/npm test --/);
    expect(windows).not.toMatch(/npm test -/);

    expect(windows).not.toContain('Run gates');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('Start-ThreadJob');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('.github/scripts/');
    expect(windows).not.toContain('run-windows-gates.ps1');
    expect(windows).not.toContain('windows-gates');
    expect(windows).not.toContain('Invoke-BoundedGateQueue');
    expect(windows).not.toContain('Assert-NativeGateSucceeded');
    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('verify:dist');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

});
