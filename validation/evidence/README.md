# Validation Evidence

This is the single customer-safe evidence document for Azure spec discovery live validation.

Raw Azure identifiers (subscription, tenant, resource group, ARM IDs), hostnames, URLs, request IDs, SAS links, credential-bearing output, and `*.local.json` files must stay out of this document and out of `live-azure-surfaces.json`. The live runner keeps raw manifests and command output in gitignored local files and refreshes only the sanitized summary below.

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

Regenerate with `node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown` after `npm run build` (see `docs/LIVE_TESTING_RUNBOOK.md`).
