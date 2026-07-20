# Validation Evidence

This is the single customer-safe evidence document for Azure spec discovery live validation.

Raw Azure identifiers (subscription, tenant, resource group, ARM IDs), hostnames, URLs, request IDs, SAS links, credential-bearing output, and `*.local.json` files must stay out of this document and out of `live-azure-surfaces.json`. The live runner keeps raw manifests and command output in gitignored local files and refreshes only the sanitized summary below.

## Claim boundary

Live evidence proves only the cases listed in `live-azure-surfaces.json` with `status: pass`. It is not a full product coverage matrix.

- The machine-readable coverage claim for every advertised and explicit unsupported route lives in `coverage/route-claims.json` (see `docs/COVERAGE.md`).
- A passing unit test does not promote a route to `validationState: live`.
- Only a matching **passing** case id/name in this evidence file may back a `live` claim.
- `requires-capability` is an explicit blocked lane, not live proof. It is the Azure harness category for missing provider registration, RBAC, SKU/region, or cost guards — not the GCP `substitute` category.
- `local-only` proves compiled-CLI local parsing without Azure calls; it never promotes a remote route to `live`.
- Routes marked `unit-only`, `local-only`, or `unsupported` in the claim manifest remain outside the live proof set until a new sanitized pass is committed.

## Evidence schema v2

Evidence file: `live-azure-surfaces.json`.

Receipt metadata:

- `schemaVersion` (2)
- `suiteVersion` — case-set version (currently `r8-pos-396-v1`)
- `testedCommitHashPrefix` — optional short commit correlation hash (never raw pipeline/run IDs; omitted on historical migrations)
- `capturedAt` — UTC date
- totals: `cases`, `passed`, `failed`, `requiresCapability`, `localOnly`

Per-case fields only: `id`, `name` (same as id for coverage binding), `status` (`pass|fail|requires-capability|local-only`), `providerType`, `sourceType`, `specFormat`, `contractClass`, optional sanitized `reasonCode`.

No IDs, UUIDs, hosts, URLs, names, paths, SAS, tokens, request IDs, or spec bodies.

## Live Azure surfaces

Latest committed run: 6 cases, 6 passed, 0 failed, 0 requires-capability, 0 local-only.

These six passes are the truthful historical baseline. Expanded R8 matrix cases are implemented in the harness and mapped as planned ids in `coverage/route-claims.json`, but they remain `unit-only` until a credentialed pipeline 157 run commits new sanitized passes. Do not treat planned ids as live.

| Case | Validated behavior |
| --- | --- |
| `apim-explicit-api-id` | Explicit APIM ARM `api-id` resolves and exports the current HTTP revision as OpenAPI JSON. |
| `apim-discovery` | Resource-group-scoped APIM discovery resolves the live API without an explicit ID. |
| `app-service-api-definition` | App Service `siteConfig.apiDefinition.url` resolves and the document passes OpenAPI validation. |
| `discover-many` | discover-many exports every exportable candidate in the run resource group and reports an export summary. |
| `iac-single` | A repository containing one inline ARM-embedded OpenAPI spec resolves locally (cloud providers fail soft). |
| `ambiguity` | Two equal local candidates surface as an unresolved ranked-candidate resolution instead of a guess. |

Regenerate by queueing pipeline **157** (`postman-azure-spec-discovery-live-validation`) in `PostmanDevOps/CSE Pilots` (service connection `azure-cse-pilot-builders`) against an exact immutable GitHub SHA. Download the sanitized `azure-spec-discovery-live-evidence` artifact and commit only `live-azure-surfaces.json` after review (see `docs/LIVE_TESTING_RUNBOOK.md`).
