/**
 * Automatic release-cut contract.
 *
 * Pins the invariants whose absence burned release versions elsewhere: a burnt
 * version number must be skipped rather than reused, and the tag must be the
 * last side effect after every gate passes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- release tooling is plain ESM, intentionally outside tsconfig source roots
import * as releaseCut from '../scripts/release-cut.mjs';

const parseConventionalBump = releaseCut.parseConventionalBump as (m: string[]) => string | null;
const applyBump = releaseCut.applyBump as (v: string, b: string) => string;
const selectNextVersion = releaseCut.selectNextVersion as (input: {
  current: string;
  bump: string;
  takenTags: string[];
}) => { version: string; skipped: string[] };
const latestReleaseTag = releaseCut.latestReleaseTag as (tags: string[]) => string | null;

const repoRoot = process.cwd();
const autoReleaseWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/auto-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const releaseCutSource = readFileSync(join(repoRoot, 'scripts/release-cut.mjs'), 'utf8');
const prePushHook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');

describe('release version selection', () => {
  it('skips a burnt version instead of reusing it', () => {
    const plan = selectNextVersion({
      current: '1.3.4',
      bump: 'patch',
      takenTags: ['v1.3.4', 'v1.3.5']
    });
    expect(plan.version).toBe('1.3.6');
    expect(plan.skipped).toContain('1.3.5');
  });

  it('never returns a version that is already tagged', () => {
    const taken = ['v1.0.0', 'v1.0.1', 'v1.0.2', 'v1.0.3'];
    const plan = selectNextVersion({ current: '1.0.0', bump: 'patch', takenTags: taken });
    expect(taken).not.toContain(`v${plan.version}`);
    expect(plan.version).toBe('1.0.4');
  });

  it('normalizes accepted zero-patch minor tags', () => {
    expect(latestReleaseTag(['v2.9.9', 'v3.0', 'v3'])).toBe('v3.0');
    expect(
      selectNextVersion({ current: '2.9.9', bump: 'major', takenTags: ['v3.0'] })
    ).toEqual({ version: '3.0.1', skipped: ['3.0.0'] });
  });

  it('maps conventional commits onto semver bumps', () => {
    expect(parseConventionalBump(['feat: add provider'])).toBe('minor');
    expect(parseConventionalBump(['fix: correct scan'])).toBe('patch');
    expect(parseConventionalBump(['feat!: drop legacy input'])).toBe('major');
    expect(parseConventionalBump(['refactor: x\n\nBREAKING CHANGE: removed'])).toBe('major');
    expect(parseConventionalBump(['feat: a', 'fix: b'])).toBe('minor');
    expect(applyBump('1.3.5', 'minor')).toBe('1.4.0');
  });

  it('does not cut a release for release-plumbing commits alone', () => {
    expect(parseConventionalBump(['chore(release): v1.3.6'])).toBeNull();
    expect(parseConventionalBump(['chore: bump lockfile'])).toBeNull();
    expect(parseConventionalBump(['ci: retune gate queue', 'test: add case'])).toBeNull();
    expect(parseConventionalBump([])).toBeNull();
  });
});

describe('release-cut ordering contract', () => {
  it('creates the tag only after the committed release bytes are verified', () => {
    const tagIndex = releaseCutSource.indexOf("'tag', '-a'");
    const commitIndex = releaseCutSource.indexOf("'commit', '-m'");
    const verifyAfterCommit = releaseCutSource.indexOf('const releaseCommit');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(verifyAfterCommit);
    expect(verifyAfterCommit).toBeLessThan(tagIndex);
    expect(releaseCutSource.indexOf('assertCommittedDistMatchesSource();')).toBeLessThan(tagIndex);
  });

  it('reads every sha in-process rather than through shell variables', () => {
    expect(releaseCutSource).not.toContain('PREPARE_SHA');
    expect(releaseCutSource).toContain("git(['rev-parse', 'HEAD'])");
  });

  it('rebuilds dist before committing and verifies committed dist before tagging', () => {
    expect(releaseCutSource).toContain("run('npm', ['run', 'bundle'])");
    expect(releaseCutSource).toContain("run('npm', ['run', 'verify:dist'])");
    const rebuild = releaseCutSource.indexOf('rebuildDist();');
    const commit = releaseCutSource.indexOf("'commit', '-m'");
    const assertDist = releaseCutSource.indexOf('assertCommittedDistMatchesSource();');
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(rebuild).toBeGreaterThan(-1);
    expect(rebuild).toBeLessThan(commit);
    expect(commit).toBeLessThan(assertDist);
    expect(assertDist).toBeLessThan(tag);
  });

  it('does not import multifile receipt machinery', () => {
    expect(releaseCutSource).not.toContain('multifile-spec-sync');
    expect(releaseCutSource).not.toContain('normalizeReceipt');
    expect(releaseCutSource).not.toContain('assertReceiptIntegrity');
  });
});

describe('auto-release workflow', () => {
  it('cuts from main pushes instead of hand-pushed tags', () => {
    expect(autoReleaseWorkflow).toContain('branches: [main]');
    expect(autoReleaseWorkflow).not.toMatch(/on:\n\s+push:\n\s+tags:/);
  });

  it('rejects manually dispatched cuts outside main', () => {
    expect(autoReleaseWorkflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('fetches full history and tags so burnt versions are visible', () => {
    expect(autoReleaseWorkflow).toContain('fetch-depth: 0');
    expect(autoReleaseWorkflow).toContain('fetch-tags: true');
  });

  it('plans before it cuts and cuts before it pushes', () => {
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    const cut = autoReleaseWorkflow.indexOf('name: Cut release');
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(cut);
    expect(cut).toBeLessThan(push);
  });

  it('pushes only the tag, never a commit onto protected main', () => {
    expect(autoReleaseWorkflow).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(autoReleaseWorkflow).not.toContain('HEAD:${GITHUB_REF_NAME}');
    expect(autoReleaseWorkflow).not.toContain('gh pr create');
  });

  it('never cancels a cut in flight', () => {
    expect(autoReleaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('writes its plan outside the worktree so the cut sees a clean tree', () => {
    expect(autoReleaseWorkflow).not.toMatch(/tee plan\.json/);
    expect(autoReleaseWorkflow).toContain('PLAN_FILE: ${{ runner.temp }}/plan.json');
  });

  it('starts or recovers release.yml after the tag push', () => {
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    const dispatch = autoReleaseWorkflow.indexOf('name: Start or recover release workflow');
    expect(dispatch).toBeGreaterThan(push);
    expect(autoReleaseWorkflow).toContain('require(process.env.PLAN_FILE).previous');
    expect(autoReleaseWorkflow).toContain('gh release view "$TAG"');
    expect(autoReleaseWorkflow).toContain('gh workflow run release.yml --ref "$TAG"');
  });
});

describe('pre-push tag guard', () => {
  it('rejects hand-pushed immutable tags but exempts rolling aliases and CI', () => {
    expect(prePushHook).toContain('refs/tags/v[0-9]*.[0-9]*.[0-9]*');
    expect(prePushHook).toContain('GITHUB_ACTIONS');
    expect(prePushHook).not.toMatch(/refs\/tags\/v\[0-9\]\*\.\[0-9\]\*\)$/);
  });

  it('keeps the dist staleness check', () => {
    expect(prePushHook).toContain('npm run verify:dist');
  });
});
