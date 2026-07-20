# Coverage claim manifest

`coverage/route-claims.json` is the machine-readable source of truth for every currently advertised discovery route and every planned explicit unsupported route.

## Claim boundary

| validationState | Meaning |
| --- | --- |
| `live` | Bound to a matching **passing** case in `validation/evidence/live-azure-surfaces.json`. Unit tests alone never promote a route to `live`. |
| `local-only` | Behavior is local (repo/filesystem). Must not list remote Azure client/provider implementation files. |
| `unit-only` | Implemented and covered by automated tests; not live-proven. |
| `unsupported` | Explicit non-support or unimplemented gap. Requires `unsupportedReason`. |

Contract classes (`authoritative`, `reconstructed`, `partial`, `association-only`, `unsupported`) describe what kind of artifact a route can produce. Association metadata must never be presented as a full specification.

## Updating claims

1. Edit `coverage/route-claims.json` when adding, changing, or retiring a route.
2. Keep `advertisedProviders` aligned with the ten providers documented in `docs/providers.md`.
3. Run `npm run verify:coverage`.
4. Run `npx vitest run tests/coverage-manifest.test.ts`.

Live promotions require a new or refreshed passing case in the sanitized evidence file first. Do not mark a provider live because a unit test passed.

## Verifier

`npm run verify:coverage` runs `scripts/verify-coverage-manifest.mjs` (Node stdlib only). It rejects duplicate ids, missing implementation/test files, invalid class/state pairs, live rows without a passing evidence case, unsupported rows without a reason, local-only rows with remote implementation files, and advertised providers missing from the manifest.
