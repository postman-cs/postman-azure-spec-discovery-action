import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  version?: string;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { devDependencies?: Record<string, string> }>;
};

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
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
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('AZ-CI-001: two independent jobs, Node 24, no needs edges, no live Azure credentials', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  windows:']);

    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(ciWorkflow).not.toMatch(/^\s*needs:/m);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow).toMatch(/^name: CI\n/);
    expect(ciWorkflow).toMatch(/^permissions:\n {2}contents: read\n/m);

    // No credentialed live Azure validation may run in CI (untrusted PRs).
    expect(ciWorkflow).not.toContain('validate-live-azure-surfaces');
    expect(ciWorkflow).not.toContain('AZURE_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('azure/login');
    expect(ciWorkflow).not.toContain('AZURE_CREDENTIALS');
  });

  it('AZ-CI-002: Linux one install, one bundle, max-two queue with exact gate inventory', () => {
    expect(linux).toContain('runs-on: ubuntu-latest');
    expect(linux).toContain('fetch-depth: 0');
    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'dist',
      'actionlint',
      'commitlint'
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');
  });

  it('AZ-CI-003: pinned actionlint 1.7.11 at RUNNER_TEMP and repo-local commitlint pins', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash'
    );
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');

    expect(pkg.version).toBe('1.2.1');
    expect(pkg.devDependencies?.['@commitlint/cli']).toBe('^21.2.1');
    expect(pkg.devDependencies?.['@commitlint/config-conventional']).toBe('^21.2.0');
    const lockRootDev = lock.packages?.['']?.devDependencies;
    expect(lockRootDev?.['@commitlint/cli']).toBe('^21.2.1');
    expect(lockRootDev?.['@commitlint/config-conventional']).toBe('^21.2.0');
  });

  it('AZ-CI-004: Windows exact cache pin, miss-only install, sole direct npm test, no queue', () => {
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

    const install = namedStep(windows, 'Install dependencies');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(install).toContain('npm ci --prefer-offline --no-audit --no-fund');
    expect(install).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);

    expect(windows.match(/^\s*- run: npm test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toMatch(/npm test --/);
    expect(windows).not.toMatch(/npm test -/);

    const testIdx = windows.search(/^\s*- run: npm test\s*$/m);
    const preceding = windows.slice(Math.max(0, testIdx - 80), testIdx);
    expect(preceding).not.toMatch(/if:.*\n\s*- run: npm test/);

    expect(windows).not.toContain('Run gates');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('verify:dist');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('AZ-CI-005: NPM token stays step-local on Linux install and Windows cache-miss only', () => {
    expect(linux.match(/NODE_AUTH_TOKEN/g) ?? []).toHaveLength(1);
    expect(windows.match(/NODE_AUTH_TOKEN/g) ?? []).toHaveLength(1);

    const windowsInstall = namedStep(windows, 'Install dependencies');
    expect(windowsInstall).toContain('NODE_AUTH_TOKEN');
    const windowsWithoutInstall = windows.replace(windowsInstall, '');
    expect(windowsWithoutInstall).not.toContain('NODE_AUTH_TOKEN');

    expect(linux).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(windowsInstall).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
  });
});
