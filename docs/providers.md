# Provider contracts

Azure spec discovery ships seven providers: `apim`, `app-service`, `custom-apis`, `logic-apps`, `template-specs`, `event-grid`, and `iac-local`. Each implements the same `SpecProvider` seam (`probe`, `listCandidates`, `exportSpec`) and is probed fail-soft and concurrently: authorization failures map to `skipped:iam`, other failures (including a probe exceeding its 30 s deadline) to `skipped:error`, and discovery continues with the remaining providers.

## `apim` — Azure API Management

- Enumerates every visible APIM service (subscription-wide or scoped by `resource-group`) plus each service workspace and lists both service- and workspace-scoped APIs.
- Only **current revisions** are candidates; non-current revisions are dropped at enumeration.
- Only **HTTP** APIs are exportable. SOAP, GraphQL, WebSocket, gRPC, and OData APIs stay visible as unsupported candidates so ambiguity output can name them, but selecting one resolves to manual review and never writes a file.
- Export uses the ARM export protocol: the management call returns a short-lived Storage SAS link, and the document is fetched from that link immediately. A 403 discards the expired link and repeats the whole export/fetch cycle within `max-attempts`; links are never logged. The exported document is validated (`Swagger 2.0`/`OpenAPI 3.x`, non-empty `paths`) before it is written.
- The full APIM API ARM resource ID appears only in the `api-id` output and `resolution-json.apiId`. Logs, evidence, and Step Summaries redact it.

## `app-service` — App Service API definition

- Lists App Service sites and reads `siteConfig.apiDefinition.url`.
- A site is a candidate when its API definition URL is set. Export fetches the URL over HTTPS with a bounded, redirect-limited, content-validated fetch (private-address and non-HTTPS URLs are refused).
- The fetched document is validated the same way as APIM exports before it is written.

## `custom-apis` — Logic Apps custom connectors

- Enumerates `Microsoft.Web/customApis` via generic ARM REST (`api-version 2016-06-01`; no management SDK models this surface). Plain Reader RBAC is enough.
- A connector is a candidate when its `properties.swagger` inline document exists; connectors without one stay visible as unsupported candidates (their `apiDefinitions.originalSwaggerUrl` is surfaced as evidence but never auto-fetched).
- Export re-reads the connector, extracts **only** the inline swagger document, validates it like every other export, and normalizes it to JSON.
- Secret hygiene is structural: the ARM payload carries `connectionParameters.oAuthSettings.clientSecret` beside the swagger, so the client projects only `properties.swagger`, `apiDefinitions.*SwaggerUrl`, and `backendService.serviceUrl`. `connectionParameters` is never read, logged, or serialized.

## `logic-apps` — Consumption Logic App workflows

- Enumerates `Microsoft.Logic/workflows` via generic ARM REST (`api-version 2019-05-01`). Reader-only GETs; disabled workflows are skipped at enumeration.
- A workflow is a candidate when its definition declares at least one HTTP `Request` trigger; workflows without one stay visible as unsupported candidates.
- Export **synthesizes a deliberately partial OpenAPI 3.0 document** from the Request triggers: paths from `relativePath` (fallback `/triggers/<name>/invoke`), methods, and declared request schemas. Responses are not declared in workflow definitions, so operations carry a `default` response and the export is marked `completeness: partial` — the derived-OpenAPI outputs report `partial` even though the document parses as complete OpenAPI 3.x.
- Credential hygiene: `listCallbackUrl` (SAS token in the URL) and `listSwagger` (POST outside plain Reader) are never called. The SAS-free `accessEndpoint` is the only URL surfaced, as the OpenAPI `servers` entry.

## `template-specs` — Template Spec embedded APIM documents

- Enumerates `Microsoft.Resources/templateSpecs` and their versions via generic ARM REST (`api-version 2022-02-01`). Reader GETs only: each version's `mainTemplate` is read directly from the version resource — `exportTemplate` (a POST action) is never called.
- A version is a supported candidate per embedded APIM API resource (`Microsoft.ApiManagement/service/apis` with an inline `openapi`/`swagger` `properties.value`), including templates nested inside `Microsoft.Resources/deployments` resources. Versions without one stay visible as unsupported candidates.
- Resource group deployment history (`deployments` list, a Reader GET whose response carries no template content) contributes "referenced by deployment" evidence only.
- Export validates and normalizes the embedded document and declares `completeness: partial`: an embedded template document may carry unresolved ARM template expressions, so it is not guaranteed to equal the deployed literal.
- Secret hygiene is structural: `Microsoft.Resources/deploymentScripts` subtrees (script content, environment variables) are never walked, and an embedded document that contains a secure parameter default (`secureString`/`secureObject` `defaultValue`) is withheld — its candidate flips to unsupported and the document is never surfaced.

## `event-grid` — Event Grid webhook delivery contracts

- Enumerates Event Grid custom topics, domains, and system topics plus their event subscriptions via `@azure/arm-eventgrid` (Reader GETs, bounded pagination).
- A source is a supported candidate when at least one event subscription delivers to a **WebHook** destination; sources with only service-to-service destinations (Event Hubs, Service Bus, queues, functions) stay visible as unsupported candidates with their destination kinds as evidence.
- Export **synthesizes a deliberately partial OpenAPI 3.0 document** describing the webhook delivery contract: one POST operation per sanitized destination path, request bodies from the delivery schema envelope (Event Grid or CloudEvents 1.0), and `eventType`/`type` enums from `includedEventTypes` filters. Handler responses and event `data` payload schemas are not declared in Event Grid, so the export is `completeness: partial`.
- Credential hygiene: only the server-populated `endpointBaseUrl` is ever read off the ARM response (`endpointUrl`, which may embed query-string tokens, is never projected; `getFullUrl` is never called), and every URL is still defensively stripped to origin + path before surfacing.

## `iac-local` — repository Azure IaC

- Always `available` (no network probe). Scans a bounded set of repository files: ARM templates (`*.json` with `Microsoft.ApiManagement` resources carrying inline OpenAPI), Bicep-compiled JSON, and `azure.yaml` service hints.
- A single embedded spec resolves directly; multiple hits become ranked candidates like any other provider.

## Ordering and narrowing

Probe order is `apim`, `app-service`, `custom-apis`, `logic-apps`, `template-specs`, `event-grid`, `iac-local`. Candidates from all available providers enter the same four-tier narrowing pipeline (`iac-fingerprint`, `rg-correlation`, `tag-prefilter`, `naming-heuristic`); the chosen tier is reported in the `narrowing-strategy` output. Tags in the `postman:*` namespace (`postman:repo`, `postman:project-name`) are the strongest ownership signals.
