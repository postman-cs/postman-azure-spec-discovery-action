import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function section(startMarker: string, endMarker?: string): string {
  const start = releaseWorkflow.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  if (!endMarker) return releaseWorkflow.slice(start);
  const end = releaseWorkflow.indexOf(endMarker, start + 1);
  expect(end).toBeGreaterThan(start);
  return releaseWorkflow.slice(start, end);
}

function assertOrder(earlier: string, later: string, haystack = releaseWorkflow): void {
  expect(haystack.indexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(earlier)).toBeLessThan(haystack.indexOf(later));
}

describe('release workflow publishing contract', () => {
  it('AZ-RELEASE-000: release runs for v* tag pushes and manual retries', () => {
    expect(releaseWorkflow).toContain('workflow_dispatch:');
    expect(releaseWorkflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- ['"]v\*['"]/);
  });

  it('AZ-RELEASE-001: immutable releases require origin/main, publish npm once, and move only rolling aliases', () => {
    expect(releaseWorkflow).toContain('release_kind=immutable');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ] || [ "$TAG_VERSION" = "$MAJOR.$MINOR" ]; then');
    expect(releaseWorkflow).toContain('release_kind=alias');
    expect(releaseWorkflow).toMatch(/['"]publish['"]\s*,\s*['"]\.\/release\.tgz['"]\s*,\s*['"]--provenance['"]\s*,\s*['"]--access['"]\s*,\s*['"]public['"]/);
    expect(releaseWorkflow).toContain('uses: softprops/action-gh-release@');
    expect(releaseWorkflow).toContain('files: release-artifacts/release.tgz');
    expect(releaseWorkflow).toContain('git fetch --depth=1 origin main --no-tags');
    expect(releaseWorkflow).toContain("git rev-parse 'origin/main^{commit}'");
    expect(releaseWorkflow).toContain('if [ "$TAG_COMMIT" != "$MAIN_COMMIT" ]; then');
    expect(releaseWorkflow).toContain('git push origin "refs/tags/$ALIAS"');
    expect(releaseWorkflow).toContain('advance-rolling-aliases:');
    expect(releaseWorkflow).toContain('for ALIAS in "v$MAJOR" "v$MAJOR.$MINOR"; do');
    expect(releaseWorkflow).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    for (const gate of ['npm test', 'npm run typecheck', 'npm run lint', 'npm run verify:dist:assert']) {
      expect(releaseWorkflow).toContain(gate);
    }
    expect(releaseWorkflow).toContain('actionlint');
  });

  it('AZ-RELEASE-002: workflows pin third-party actions to immutable commits with version comments', () => {
    for (const file of ['ci.yml', 'release.yml']) {
      const workflow = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
      const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)(?:\s+#\s+([^\n]+))?/g)];
      for (const match of uses) {
        expect(match[1]).toMatch(/@[0-9a-f]{40}$/);
        expect(match[2]).toMatch(/^v\d/);
      }
    }
  });

  it('AZ-RELEASE-003: classifies before npm ci with exact permissions and artifact-only publish', () => {
    assertOrder('Classify release tag', 'npm ci');
    expect(releaseWorkflow).toContain('verify-package:');
    expect(releaseWorkflow).toContain('publish:');
    expect(releaseWorkflow).toMatch(/verify-package:\n[\s\S]*?permissions:\n\s+contents: read/);
    expect(releaseWorkflow).toMatch(/publish:\n[\s\S]*?permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(releaseWorkflow).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(releaseWorkflow).toContain('release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');

    const publish = section('\n  publish:', '\n  advance-rolling-aliases:');
    expect(publish).toContain('actions/download-artifact@');
    expect(publish).not.toContain('actions/checkout@');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toContain('npm run build');
    expect(publish).not.toMatch(/npm pack(?:\s|$)/);
    expect(publish).not.toContain('cache:');
    expect(publish).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
  });

  it('AZ-RELEASE-004: verify-package bundles once, runs max-two gates, then executes the repository verifier', () => {
    const verify = section('\n  verify-package:', '\n  publish:');
    assertOrder('- run: npm run bundle', 'name: Run gates', verify);
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('1.7.11 "$RUNNER_TEMP"');
    expect(verify).toMatch(/^\s+- name: Pack release artifact\n\s+run: \|[\s\S]*scripts\/verify-release-artifacts\.mjs/m);
    expect(verify).toContain('release-artifacts/release.tgz');
    expect(verify).toContain('release-artifacts/release-manifest.json');
    expect(verify).toContain('release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('AZ-RELEASE-005: publish extracts and executes the packaged canonical verifier before mutations', () => {
    const publish = section('\n  publish:', '\n  advance-rolling-aliases:');
    expect(publish).toContain('package/scripts/verify-release-artifacts.mjs');
    expect(publish).toContain('"$RUNNER_TEMP/verify-release-artifacts.mjs"');
    expect(publish).toMatch(/tar\s+-xOf\s+release\.tgz\s+package\/scripts\/verify-release-artifacts\.mjs\s*>\s*"\$RUNNER_TEMP\/verify-release-artifacts\.mjs"/);
    expect(publish).toContain('working-directory: release-artifacts');
    expect(publish).toContain('node "$RUNNER_TEMP/verify-release-artifacts.mjs"');
    expect(publish).not.toContain('node scripts/verify-release-artifacts.mjs');
    expect(publish).not.toContain("readdirSync('.').sort()");
    expect(publish).not.toContain('createHash');
    expect(publish).not.toMatch(/manifest\.artifacts\.map\(\s*(?:\(|\{)?\s*(?:\{\s*)?path/);
    expect(publish).not.toMatch(/#\s*Equivalent to node scripts\/verify-release-artifacts\.mjs/);
    assertOrder(
      'node "$RUNNER_TEMP/verify-release-artifacts.mjs"',
      'Publish or verify npm package identity',
      publish
    );
    assertOrder(
      'node "$RUNNER_TEMP/verify-release-artifacts.mjs"',
      'Publish GitHub release',
      publish
    );
  });

  it('AZ-RELEASE-006: npm SRI/identity uses explicit E404 only, before softprops; aliases after publish', () => {
    const publish = section('\n  publish:', '\n  advance-rolling-aliases:');
    assertOrder('Publish or verify npm package identity', 'Publish GitHub release', publish);
    assertOrder("['publish', './release.tgz', '--provenance', '--access', 'public']", 'softprops/action-gh-release', releaseWorkflow);
    assertOrder('\n  publish:', '\n  advance-rolling-aliases:');
    expect(publish).toContain('dist.integrity');
    expect(publish).toContain('isExplicitNpmE404');
    expect(publish).toContain('verifyNpmSri');
    expect(publish).toContain('set +e');
    expect(publish).toMatch(/['"]publish['"]\s*,\s*['"]\.\/release\.tgz['"]\s*,\s*['"]--provenance['"]\s*,\s*['"]--access['"]\s*,\s*['"]public['"]/);
    expect(publish).toMatch(/non-E404|refusing to publish/i);
    expect(publish).not.toMatch(/cat\s+\/tmp\/npm-view\.err/);
    expect(publish).not.toContain('console.error(errText');
  });

  it('AZ-RELEASE-007: alias job freezes major 0, fetches only two alias refs, and uses pure helpers', () => {
    const alias = section('\n  advance-rolling-aliases:');
    expect(alias).toContain('isFrozenAliasMajor');
    expect(alias.indexOf('isFrozenAliasMajor')).toBeLessThan(alias.indexOf('for ALIAS in'));
    expect(alias).toMatch(/frozen|v0/i);
    expect(alias).toContain('for ALIAS in "v$MAJOR" "v$MAJOR.$MINOR"; do');
    expect(alias).toContain('refs/tags/$ALIAS');
    expect(alias).toContain('--no-tags');
    expect(alias).toContain('decideAliasVersion');
    expect(alias).toContain('scripts/verify-release-artifacts.mjs');
    expect(alias).toContain('package.json');
    expect(alias).not.toContain('git fetch --tags --force');
    expect(alias).not.toContain('git fetch --tags');
    expect(alias).toContain('git push origin "refs/tags/$ALIAS" --force');
  });
});
