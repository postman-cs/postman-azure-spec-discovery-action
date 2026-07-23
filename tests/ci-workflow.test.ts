import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const helperPath = join(root, '.github/scripts/run-windows-gates.ps1');
const windowsHelper = readFileSync(helperPath, 'utf8');

function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function runHelperScenario(scriptBody: string): { status: number | null; stdout: string; stderr: string } {
  expect(existsSync(helperPath)).toBe(true);
  const directory = mkdtempSync(join(tmpdir(), 'windows-gates-'));
  const scriptPath = join(directory, 'scenario.ps1');
  writeFileSync(
    scriptPath,
    [
      `$ErrorActionPreference = 'Stop'`,
      `. '${helperPath.replace(/'/g, "''")}'`,
      scriptBody,
      `exit 0`,
      ''
    ].join('\n')
  );
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath], {
      encoding: 'utf8',
      cwd: directory,
      timeout: 10_000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: `${result.stdout ?? ''}`,
      stderr: `${result.stderr ?? ''}`
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('CI workflow contract', () => {
  it('AZ-CI-001: Linux and Windows gates, Node 24, read-only dist assert, no live Azure step', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  windows:']);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow.match(/npm ci/g)).toHaveLength(2);
    expect(ciWorkflow.match(/npm run bundle/g)).toHaveLength(2);
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
  });

  it('AZ-CI-004: Windows composes every npm gate through Assert-NativeGateSucceeded and max=2 queue', () => {
    const windows = jobText(ciWorkflow, 'windows');
    expect(windows).toContain('shell: pwsh');
    expect(windows).toContain('.github/scripts/run-windows-gates.ps1');
    expect(windows).toContain('Invoke-BoundedGateQueue');
    expect(windows).toContain('-MaxParallel 2');
    expect(windows).toContain("Name = 'lint'");
    expect(windows).toContain("Name = 'test'");
    expect(windows).toContain("Name = 'typecheck'");
    expect(windows).toContain("Name = 'dist'");
    expect(windows).toContain('npm run lint');
    expect(windows).toContain('npm test');
    expect(windows).toContain('npm run typecheck');
    expect(windows).toContain('npm run verify:dist:assert');
    for (const [command, name] of [
      ['npm run lint', 'lint'],
      ['npm test', 'test'],
      ['npm run typecheck', 'typecheck'],
      ['npm run verify:dist:assert', 'dist']
    ] as const) {
      expect(windows).toMatch(
        new RegExp(
          `${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;\\s*Assert-NativeGateSucceeded\\s+-Name\\s+'${name}'\\s+-ExitCode\\s+\\$LASTEXITCODE`
        )
      );
    }
    expect(windows).not.toContain('if ($LASTEXITCODE -ne 0)');
    expect(windows).not.toContain('Invoke-Expression');
    expect(windows).not.toContain('Job.State -eq \'Completed\'');
    expect(windows.indexOf('npm run bundle')).toBeLessThan(windows.indexOf('Invoke-BoundedGateQueue'));
    expect(windows.match(/npm run bundle/g)).toHaveLength(1);
  });

  it('AZ-CI-005: helper uses Start-ThreadJob with ThrottleLimit and Assert-NativeGateSucceeded', () => {
    expect(windowsHelper).toContain('function Assert-NativeGateSucceeded');
    expect(windowsHelper).toContain('Start-ThreadJob');
    expect(windowsHelper).toContain('-ThrottleLimit $MaxParallel');
    expect(windowsHelper).not.toMatch(/\bStart-Job\b/);
    expect(windowsHelper).toContain('Invoke-BoundedGateQueue');
    expect(windowsHelper).toContain('gate:$($gate.Name)=$status');
  });

  it('AZ-CI-006: Assert-NativeGateSucceeded and bounded queue prove exit mapping without nested natives', () => {
    const result = runHelperScenario(`
Assert-NativeGateSucceeded -Name 'probe' -ExitCode 0
Write-Output 'assert:zero=ok'
try {
  Assert-NativeGateSucceeded -Name 'probe' -ExitCode 7
  Write-Output 'assert:nonzero=unexpected-success'
} catch {
  Write-Output 'assert:nonzero=thrown'
  Write-Output $_.Exception.Message
}

# Single max-two queue: one pass + one throw proves pass/fail lines and aggregate failure.
$queueFailed = $false
try {
  Invoke-BoundedGateQueue -Gates @(
    @{ Name = 'ok'; ScriptBlock = { Assert-NativeGateSucceeded -Name 'ok' -ExitCode 0 } },
    @{ Name = 'bad'; ScriptBlock = { Assert-NativeGateSucceeded -Name 'bad' -ExitCode 7 } }
  ) -MaxParallel 2
} catch {
  $queueFailed = $true
  Write-Output $_.Exception.Message
}
if (-not $queueFailed) { throw 'expected queue aggregate failure' }
Write-Output 'scenario:mixed=done'
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('assert:zero=ok');
    expect(result.stdout).toContain('assert:nonzero=thrown');
    expect(result.stdout).toMatch(/probe.*7|exit code 7/i);
    expect(result.stdout).not.toContain('assert:nonzero=unexpected-success');
    expect(result.stdout).toContain('gate:ok=pass');
    expect(result.stdout).toContain('gate:bad=fail');
    expect(result.stdout).toContain('scenario:mixed=done');
  }, 10_000);
});
