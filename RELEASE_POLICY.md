# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `vMAJOR.MINOR.PATCH` tags.
- The rolling major and minor aliases (`vMAJOR` and `vMAJOR.MINOR`, i.e. `v1` and `v1.0`) are force-moved by the release workflow's `advance-rolling-aliases` job after a successful immutable publish.
- Existing immutable release tags are never force-pushed or rewritten.
- Every release tag commit is cut from protected `origin/main` by `.github/workflows/auto-release.yml`; the release workflow verifies that ancestry before publication. The tagged commit carries the version bump and rebuilt `dist/` and is not pushed onto `main`.
- `v0` tags stay frozen at the last `v0` release.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump, rebuild `dist/`, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Before planning another cut, auto-release reconciles the latest immutable tag
when its GitHub release is missing or either rolling alias has not advanced. It
does not duplicate an active release run, and a successful release completion
resumes planning.

Do not push `vMAJOR.MINOR.PATCH` tags by hand. The pre-push hook refuses them,
because a hand-pushed tag becomes a public identifier before any gate has run
against it.

To see what the next merge would cut:

```sh
git fetch origin --tags
node scripts/release-cut.mjs --plan
```

The same gates run locally before any push:

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. `npm run verify:dist`
6. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
7. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cse/onboarding-azure-spec-discovery` with versions that match the GitHub release tag. Rolling major/minor aliases update action channels and skip npm publishing.

## Compatibility

This action emits `spec-path`, `service-name`, and resolution metadata for downstream actions. Changes to output names, output types, required inputs, or resolution semantics are breaking changes and require a new major release.

## Security fixes

Security fixes ship on the latest immutable `vMAJOR.MINOR.PATCH` tag and move onto the rolling major/minor aliases. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).

## Suite release order

Azure discovery can be released on its own unless a downstream onboarding example depends on a new composite or bootstrap feature. When multiple onboarding actions change together, release the lower-level actions first, then update the composite action after its pinned dependencies are available.
