# Provider contracts

Azure spec discovery ships three providers in v1. Each implements the same `SpecProvider` seam (`probe`, `listCandidates`, `exportSpec`) and is probed fail-soft: authorization failures map to `skipped:iam`, other failures to `skipped:error`, and discovery continues with the remaining providers.

## `apim` — Azure API Management

- Enumerates every visible APIM service (subscription-wide or scoped by `resource-group`) and lists its APIs.
- Only **current revisions** are candidates; non-current revisions are dropped at enumeration.
- Only **HTTP** APIs are exportable. SOAP, GraphQL, and WebSocket APIs stay visible as unsupported candidates so ambiguity output can name them, but selecting one resolves to manual review and never writes a file.
- Export uses the ARM export protocol: the management call returns a short-lived Storage SAS link, and the document is fetched from that link immediately. The exported document is validated (`Swagger 2.0`/`OpenAPI 3.x`, non-empty `paths`) before it is written.
- The full APIM API ARM resource ID appears only in the `api-id` output and `resolution-json.apiId`. Logs, evidence, and Step Summaries redact it.

## `app-service` — App Service API definition

- Lists App Service sites and reads `siteConfig.apiDefinition.url`.
- A site is a candidate when its API definition URL is set. Export fetches the URL over HTTPS with a bounded, redirect-limited, content-validated fetch (private-address and non-HTTPS URLs are refused).
- The fetched document is validated the same way as APIM exports before it is written.

## `iac-local` — repository Azure IaC

- Always `available` (no network probe). Scans a bounded set of repository files: ARM templates (`*.json` with `Microsoft.ApiManagement` resources carrying inline OpenAPI), Bicep-compiled JSON, and `azure.yaml` service hints.
- A single embedded spec resolves directly; multiple hits become ranked candidates like any other provider.

## Ordering and narrowing

Probe order is `apim`, `app-service`, `iac-local`. Candidates from all available providers enter the same four-tier narrowing pipeline (`iac-fingerprint`, `rg-correlation`, `tag-prefilter`, `naming-heuristic`); the chosen tier is reported in the `narrowing-strategy` output. Tags in the `postman:*` namespace (`postman:repo`, `postman:project-name`) are the strongest ownership signals.
