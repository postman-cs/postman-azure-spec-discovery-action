# Validation Evidence

This is the single customer-safe evidence document for Azure spec discovery live validation.

Raw Azure identifiers (subscription, tenant, resource group, ARM IDs), hostnames, URLs, request IDs, SAS links, credential-bearing output, and `*.local.json` files must stay out of this document and out of `live-azure-surfaces.json`. The live runner keeps raw manifests and command output in gitignored local files and refreshes only the sanitized summary below.

## Claim boundary

Live evidence proves only the cases listed in `live-azure-surfaces.json`. It is not a full product coverage matrix.

- The machine-readable coverage claim for every advertised and explicit unsupported route lives in `coverage/route-claims.json` (see `docs/COVERAGE.md`).
- A passing unit test does not promote a route to `validationState: live`.
- Only a matching passing case name in this evidence file may back a `live` claim.
- Routes marked `unit-only`, `local-only`, or `unsupported` in the claim manifest are outside the live proof set below.

## Live Azure surfaces

Evidence file: `live-azure-surfaces.json` (schema 1). It reports only case totals and per-case `{name, status, sourceType, providerType, specFormat}`.

Latest committed run: 6 cases, 6 passed, 0 failed.

| Case | Validated behavior |
| --- | --- |
| `apim-explicit-api-id` | Explicit APIM ARM `api-id` resolves and exports the current HTTP revision as OpenAPI JSON. |
| `apim-discovery` | Resource-group-scoped APIM discovery resolves the live API without an explicit ID. |
| `app-service-api-definition` | App Service `siteConfig.apiDefinition.url` resolves and the document passes OpenAPI validation. |
| `discover-many` | discover-many exports every exportable candidate in the run resource group and reports an export summary. |
| `iac-single` | A repository containing one inline ARM-embedded OpenAPI spec resolves locally (cloud providers fail soft). |
| `ambiguity` | Two equal local candidates surface as an unresolved ranked-candidate resolution instead of a guess. |

Regenerate by queueing `postman-azure-spec-discovery-live-validation` in `PostmanDevOps/CSE Pilots` (service connection `azure-cse-pilot-builders`). Download the sanitized artifact and commit only `live-azure-surfaces.json` after review (see `docs/LIVE_TESTING_RUNBOOK.md`).
