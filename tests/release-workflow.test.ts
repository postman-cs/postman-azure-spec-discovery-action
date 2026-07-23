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
    expect(releaseWorkflow).toContain('npm publish ./release.tgz --provenance --access public');
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

  it('AZ-RELEASE-005: publish hardens an executable byte verifier without comment-only script matches', () => {
    const publish = section('\n  publish:', '\n  advance-rolling-aliases:');
    const verifyStep = publish.match(/- name: Verify release artifacts\n([\s\S]*?)(?=\n {6}- name: |\n?$)/)?.[1] ?? '';
    expect(verifyStep).toContain('working-directory: release-artifacts');
    expect(verifyStep).toContain('run: |');
    expect(verifyStep).toContain("readdirSync('.').sort()");
    expect(verifyStep).not.toContain("startsWith('.')");
    expect(verifyStep).not.toMatch(/readdirSync\('\.'\)\.filter/);
    expect(verifyStep).toContain('release-manifest.json');
    expect(verifyStep).toContain('release.tgz');
    expect(verifyStep).toContain("path !== 'release.tgz'");
    expect(verifyStep).not.toContain('Equivalent to node scripts/verify-release-artifacts.mjs');
    expect(verifyStep).not.toMatch(/manifest\.artifacts\.map\(\s*(?:\(|\{)?\s*(?:\{\s*)?path/);
    expect(verifyStep).not.toMatch(/readFileSync\(\s*path\s*\)/);
    expect(publish).not.toMatch(/#\s*Equivalent to node scripts\/verify-release-artifacts\.mjs/);
  });

  it('AZ-RELEASE-006: npm SRI/identity runs before softprops, and aliases run after publish', () => {
    const publish = section('\n  publish:', '\n  advance-rolling-aliases:');
    assertOrder('Publish or verify npm package identity', 'Publish GitHub release', publish);
    assertOrder('npm publish ./release.tgz --provenance --access public', 'softprops/action-gh-release', releaseWorkflow);
    assertOrder('\n  publish:', '\n  advance-rolling-aliases:');
    expect(publish).toContain('dist.integrity');
    expect(publish).toContain('sha512-');
    expect(publish).toContain('npm integrity differs from staged tarball');
    expect(publish).toContain('npm publish ./release.tgz --provenance --access public');
  });

  it('AZ-RELEASE-007: alias job fetches only the two alias refs and decides with the pure helper', () => {
    const alias = section('\n  advance-rolling-aliases:');
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
