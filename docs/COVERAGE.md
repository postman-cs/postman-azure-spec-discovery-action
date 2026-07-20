# Coverage claim manifest

`coverage/route-claims.json` is the machine-readable source of truth for every currently advertised discovery route and every planned explicit unsupported route.

## Claim boundary

| validationState | Meaning |
| --- | --- |
| `live` | Bound to a matching **passing** case in `validation/evidence/live-azure-surfaces.json` whose `providerType` / `sourceType` / `specFormat` / `contractClass` match `CASE_CATALOG`. Unit tests alone never promote a route to `live`. |
| `local-only` | Behavior is local (repo/filesystem). Must not list remote Azure client/provider implementation files. Requires `localOnlyRationale` and/or a planned local harness case id. |
| `unit-only` | Implemented and covered by automated tests; not live-proven. Requires `plannedLiveEvidenceCase` (catalog id) or `localOnlyRationale`. |
| `unsupported` | Explicit non-support or unimplemented gap. Requires `unsupportedReason`. |

Contract classes (`authoritative`, `reconstructed`, `partial`, `association-only`, `unsupported`) describe what kind of artifact a route can produce. Association metadata must never be presented as a full specification.

## Case catalog and multi-facet claims

The live harness `CASE_CATALOG` is exactly 31 unique case ids. Passing evidence rows must be catalog members with metadata parity. `plannedLiveEvidenceCase` values must exist in that catalog.

When more than one route maps to the same case id, the catalog entry must list those route ids in `claimFacets`. Loose name reuse without `claimFacets` is rejected.

## Updating claims

1. Edit `coverage/route-claims.json` when adding, changing, or retiring a route.
2. Keep `advertisedProviders` aligned with the ten providers documented in `docs/providers.md`.
3. Run `npm run docs:tables` so the README coverage table stays manifest-derived.
4. Run `npm run verify:coverage`.
5. Run `npx vitest run tests/coverage-manifest.test.ts tests/live-validation-contract.test.ts`.

Live promotions require a new or refreshed passing case in the sanitized evidence file first. Do not mark a provider live because a unit test passed. Do not treat planned ids as live.

## Verifier

`npm run verify:coverage` runs `scripts/verify-coverage-manifest.mjs`. It rejects duplicate ids, missing implementation/test files, invalid class/state pairs, live rows without a catalog-compatible passing evidence case, planned ids absent from `CASE_CATALOG`, unsupported rows without a reason, local-only rows with remote implementation files, advertised providers missing from the manifest, missing live/planned/local-only rationale mappings, multi-route case reuse without `claimFacets`, and evidence aggregate/uniqueness/schema-v2 drift.

Provider registration parity: `verifyProviderRegistrationsAgainstManifest` (same script, exercised by `tests/provider-registry.test.ts`) compares `src/lib/providers/registry.ts` rows to coverage routes for default contract class, required capability text, and native-format intersection.

README support/validation labels are rendered from this manifest via `npm run docs:tables` (`scripts/render-action-tables.mjs`).
