import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('release workflow publishing contract', () => {
  it('AZ-RELEASE-000: release runs only for v* tag pushes', () => {
    expect(releaseWorkflow).not.toContain('workflow_dispatch');
    expect(releaseWorkflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- ['"]v\*['"]/);
  });

  it('AZ-RELEASE-001: immutable releases require origin/main, publish npm once, and move only rolling aliases', () => {
    // npm publishes ONLY from the exact package-version tag.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$PKG_VERSION" ]; then');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    // Rolling aliases (v1, v1.0) skip npm publish.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ] || [ "$TAG_VERSION" = "$MAJOR.$MINOR" ]; then');
    expect(releaseWorkflow).toContain('npm_publish=false');
    // npm publish is gated on npm_publish plus not-already-published, with provenance.
    expect(releaseWorkflow).toContain(
      "if: steps.release_tag.outputs.npm_publish == 'true' && steps.npm_package.outputs.already_published != 'true'"
    );
    expect(releaseWorkflow).toContain('npm publish --provenance --access public');
    // GitHub release + tarball for the pushed tag.
    expect(releaseWorkflow).toContain('uses: softprops/action-gh-release@');
    expect(releaseWorkflow).toContain('files: release.tgz');
    // Every release tag must point at protected origin/main.
    expect(releaseWorkflow).toContain("git fetch origin main --no-tags");
    expect(releaseWorkflow).toContain("git rev-parse 'origin/main^{commit}'");
    expect(releaseWorkflow).toContain('if [ "$TAG_COMMIT" != "$MAIN_COMMIT" ]; then');
    // Only the alias job force-moves anything, and only the major/minor aliases.
    const forceMoves = releaseWorkflow.match(/git push origin .* --force/g) ?? [];
    expect(forceMoves).toEqual(['git push origin "$ALIAS" --force']);
    expect(releaseWorkflow).toContain('advance-rolling-aliases:');
    expect(releaseWorkflow).toContain('for ALIAS in "$MAJOR" "$MINOR"; do');
    expect(releaseWorkflow).toContain("if: ${{ needs.release.outputs.npm_publish == 'true' }}");
    // Release gates run before any publish.
    for (const gate of ['npm test', 'npm run typecheck', 'npm run lint', 'npm run verify:dist']) {
      expect(releaseWorkflow).toContain(gate);
    }
    expect(releaseWorkflow).toContain('actionlint');
  });

  it('AZ-RELEASE-002: workflows pin third-party actions to immutable commits', () => {
    for (const file of ['ci.yml', 'release.yml']) {
      const workflow = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
      const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)(?:\s+#\s+([^\n]+))?/g)];
      for (const match of uses) {
        expect(match[1]).toMatch(/@[0-9a-f]{40}$/);
        expect(match[2]).toMatch(/^v\d/);
      }
    }
  });
});
