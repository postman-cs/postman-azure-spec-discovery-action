import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(ciWorkflow, 'gate');
const distParity = jobText(ciWorkflow, 'dist-parity');
const ready = jobText(ciWorkflow, 'ready');
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('AZ-CI-001: keeps independent Linux/Windows jobs with no needs edges and adds dist-parity + ready aggregation', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  dist-parity:', '  windows:', '  ready:']);
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(distParity).toMatch(/^\s*needs:\s*gate\s*$/m);
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
    expect(ready).toContain('if: always()');
    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow).not.toContain('validate-live-azure-surfaces');
    expect(ciWorkflow).not.toContain('AZURE_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('azure/login');
    expect(ciWorkflow).not.toContain('AZURE_CREDENTIALS');
  });

  it('AZ-CI-002: supersedes only older PR runs and bundles once before bounded Linux gates', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ciWorkflow).toContain('workflow_dispatch:');

    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'dist-shape',
      'actionlint',
      'docs-pins',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist-shape npm run verify:dist:shape');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('run docs-pins  npm run docs:pins');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');

    expect(runGates).not.toContain('verify:dist:assert');
    expect(runGates).not.toContain('verify:dist:parity');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(linux).not.toContain('name: expected-dist');
  });

  it('AZ-CI-003: never injects npm auth into PR-capable npm ci and uses lockfile-local commitlint', () => {
    expect(ciWorkflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(ciWorkflow).not.toContain('secrets.NPM_TOKEN');
    expect(ciWorkflow).not.toContain('NPM_TOKEN');
    expect(linux).toContain('npx commitlint');
    expect(ciWorkflow).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(ciWorkflow).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    // R10 history-depth matrix: Linux gate needs full history for PR commit   ;
    const isolateCheckout = (job: string): string => {
      const checkoutIdx = job.search(/- uses: actions\/checkout@[0-9a-f]{40}/);
      expect(checkoutIdx).toBeGreaterThanOrEqual(0);
      const afterCheckout = job.slice(checkoutIdx);
      const nextStepRel = afterCheckout.search(/\n {6}- /);
      return nextStepRel < 0 ? afterCheckout : afterCheckout.slice(0, nextStepRel);
    };
    const gateCheckout = isolateCheckout(linux);
    const windowsCheckout = isolateCheckout(windows);
    expect(gateCheckout).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(gateCheckout).toContain('fetch-depth: 0');
    expect(linux.indexOf('fetch-depth: 0')).toBeGreaterThanOrEqual(0);
    expect(linux.indexOf('fetch-depth: 0')).toBeLessThan(linux.indexOf('run commitlint'));
    expect(windowsCheckout).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(windowsCheckout).not.toMatch(/^\s*fetch-depth\s*:/m);
  });

  it('AZ-CI-004: Windows exact cache pin, miss-only install, sole direct node --run test, no queue', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);

    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...ciWorkflow.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(windows).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('enableCrossOsArchive');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);

    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/\bnpm test\b/g) ?? []).toHaveLength(0);
    expect(windows).not.toMatch(/node --run test --/);
    expect(windows).not.toMatch(/node --run test -/);

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

  it('AZ-CI-005: installs pinned binary actionlint and runs Azure emulator lane after fan-out', () => {
    expect(ciWorkflow).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash'
    );
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(ciWorkflow).toContain('1.7.11 "$RUNNER_TEMP"');
    expect(ciWorkflow).toContain('ACTIONLINT_BIN="$RUNNER_TEMP/actionlint"');
    expect(ciWorkflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');

    const lane = namedStep(linux, 'Azure emulator transport lane');
    expect(lane).toContain('npm run test:emulator:azure');
    expect(lane).toContain('cap 27s');
    expect(lane).toContain('if [ "$elapsed" -gt 27 ]; then');
    expect(windows).not.toContain('emulator');
    expect(linux.indexOf('- name: Run gates')).toBeLessThan(linux.indexOf('- name: Azure emulator transport lane'));
    expect(linux.indexOf('- name: Azure emulator transport lane')).toBeLessThan(linux.indexOf('- name: Ensure clean tracked tree outside dist'));
  });

  it('AZ-CI-006: uploads candidate dist from gate and expected-dist from dist-parity on mismatch', () => {
    const candidate = namedStep(linux, 'Upload candidate dist');
    expect(candidate).toMatch(/uses:\s+actions\/upload-artifact@[0-9a-f]{40}\s+#\s+v7/);
    expect(candidate).toContain('name: candidate-dist');
    expect(candidate).toContain('dist/');
    expect(candidate).toContain('dist-manifest.json');
    expect(namedStep(linux, 'Write dist manifest')).toContain('lock_hash');
    expect(namedStep(linux, 'Ensure clean tracked tree outside dist')).toContain('git status --porcelain');
    expect(linux).not.toContain('name: expected-dist');

    const upload = namedStep(distParity, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toMatch(/uses:\s+actions\/upload-artifact@[0-9a-f]{40}\s+#\s+v7/);
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(distParity).toContain('npm run verify:dist:parity');
    expect(distParity).not.toContain('verify:dist:shape');
    expect(distParity).not.toContain('verify:dist:assert');
    expect(distParity).toContain('fetch-depth: 0');
    expect(distParity).toContain('npm run bundle');
  });

  it('AZ-CI-007: aggregates gate, dist-parity, and windows in a required ready job', () => {
    expect(ready).toContain('if: always()');
    expect(ready).toContain('needs.gate.result');
    expect(ready).toContain('needs.dist-parity.result');
    expect(ready).toContain('needs.windows.result');
    expect(ready).toContain('exit 1');
    expect(ready).toContain('CI ready');
  });
});
