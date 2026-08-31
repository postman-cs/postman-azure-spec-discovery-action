# postman-azure-spec-discovery-action

Discovers Azure-hosted API specs (APIM, App Service, Functions, Logic Apps, and related surfaces) and emits resolution metadata for downstream Postman API onboarding. Dual entry: GitHub Action (`dist/index.cjs`) + CLI (`dist/cli.cjs`).

## Commands

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run bundle
npm run verify:dist:assert  # read-only dist contract (CI)
npm run verify:dist         # rebuild + git diff + assert
npm run setup:hooks         # wire .githooks/pre-push
```

## CI

`.github/workflows/ci.yml` runs one `gate` job on Linux plus Windows test job. Bundles once, queues at most two checks on one runner. Typecheck once. Dist read-only `verify:dist:assert`; no second build.

## Releases

Tags are an **output** of passing run, never input. Never push release tag by hand; `.githooks/pre-push` rejects immutable `vMAJOR.MINOR.PATCH` tags.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps, rebuilds `dist/`, runs typecheck/lint/test, commits, re-verifies committed bytes, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- release commit lives only on tag; `release.yml` is started explicitly after tag push.
- `RELEASE_POLICY.md` holds full contract.
- `main` requires pull requests and green `ready` check (admins included, no bypass). Merge with `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge --delete-branch`; never `--admin`.
- `.githooks/pre-push` runs typecheck, lint, and test before every branch push.

## Anti-Patterns

- Never hardcode secrets, tokens, or absolute paths in durable memory
- Never create docs/README edits unless requested
