import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('release workflow publishing contract', () => {
  it('AZ-RELEASE-001: only the exact immutable version tag publishes npm; rolling aliases skip npm and only the alias job force-moves', () => {
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
    // Only the alias job force-moves anything, and only the major alias tag.
    const forceMoves = releaseWorkflow.match(/git push origin .* --force/g) ?? [];
    expect(forceMoves).toEqual(['git push origin "$MAJOR" --force']);
    expect(releaseWorkflow).toContain('advance-major-alias:');
    expect(releaseWorkflow).toContain("if: ${{ needs.release.outputs.npm_publish == 'true' }}");
    // Release gates run before any publish.
    for (const gate of ['npm test', 'npm run typecheck', 'npm run verify:dist']) {
      expect(releaseWorkflow).toContain(gate);
    }
    expect(releaseWorkflow).toContain('actionlint');
  });
});
