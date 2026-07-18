# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `vMAJOR.MINOR.PATCH` tags.
- The rolling major alias (`vMAJOR`, i.e. `v1`) is force-moved by the release workflow's `advance-major-alias` job after a successful immutable publish.
- Existing immutable release tags are never force-pushed or rewritten.
- `v0` tags stay frozen at the last `v0` release.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Run the package validators from this directory before pushing an immutable tag:

1. Confirm the working tree is clean.
2. `npm test`
3. `npm run typecheck`
4. `npm run lint`
5. `npm run build`
6. `npm run verify:dist`
7. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
8. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cse/onboarding-azure-spec-discovery` with versions that match the GitHub release tag. The rolling major alias updates the action channel and skips npm publishing.

## Compatibility

This action emits `spec-path`, `service-name`, and resolution metadata for downstream actions. Changes to output names, output types, required inputs, or resolution semantics are breaking changes and require a new major release.

## Security fixes

Security fixes ship on the latest immutable `vMAJOR.MINOR.PATCH` tag and move onto the rolling major alias. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).

## Suite release order

Azure discovery can be released on its own unless a downstream onboarding example depends on a new composite or bootstrap feature. When multiple onboarding actions change together, release the lower-level actions first, then update the composite action after its pinned dependencies are available.
