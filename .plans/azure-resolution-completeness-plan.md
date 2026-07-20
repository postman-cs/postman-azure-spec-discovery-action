# Azure Specification Resolution Completeness Plan

Status: PLANNED
Date: 2026-07-19
Repository: `postman-cs/postman-azure-spec-discovery-action`
Linear project: [Azure Spec Discovery Action](https://linear.app/postman/project/azure-spec-discovery-action-bbfb637f5594)

## Objective

Deliver the broadest practical, deterministic Azure specification resolver for a service repository. A repository owner must be able to add the action after Azure authentication and get one authoritative specification when repository or Azure evidence identifies exactly one source. The resolver must fail closed with ranked, sanitized candidates when evidence is absent or ambiguous.

The product must not claim universal resolution. Azure has no public API that maps an arbitrary repository or gateway hostname to every backing specification, Azure visibility is RBAC-scoped, and compute/network topology often contains no request or response schema. The defensible completion claim is:

> Deterministic, fail-closed resolution across supported repository, APIM, API Center, deployment, and runtime-declared sources within explicitly authorized Azure scopes, with unsupported and ambiguous cases reported rather than guessed.

## Contract Classes

Every provider and output must declare one of these classes. Association metadata must never be presented as a full specification.

| Class | Meaning | Allowed result |
| --- | --- | --- |
| `authoritative` | Original repository artifact or Azure-stored/exported definition bytes | Native document plus derived OpenAPI when supported |
| `reconstructed` | Azure can export a consumer-facing contract, but source fidelity is not guaranteed | Native/exported document with reconstruction evidence |
| `partial` | Methods, routes, envelopes, or topology are known but payload/response schemas are incomplete | Derived OpenAPI marked `partial` |
| `association-only` | Evidence links a repository, deployment, gateway, or resource but yields no contract | Narrowing evidence only; never `resolved` by itself |
| `unsupported` | Azure exposes no safe/documented retrieval route or required access is not enabled | Stable manual-review reason |

## Current Evidence

Verified on 2026-07-19 at `17bf659`:

- `npm test`: 35 files and 220 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Package and immutable release are `1.2.1`; npm reports `1.2.1`.
- Committed live evidence dated 2026-07-18 reports 6/6 passing cases.

Current implementation coverage:

| Route | Implemented | Unit/integration tested | Live validated | Completion verdict |
| --- | --- | --- | --- | --- |
| Repository OpenAPI/Swagger named-file scan | Yes | Yes | Local-only behavior, no dedicated evidence case | Incomplete: filename-biased, first match wins, OpenAPI only |
| Explicit APIM API ARM ID | Yes | Yes | Yes | Implemented for enumerated current APIs only |
| APIM service HTTP export | Yes | Yes | Yes | Implemented |
| APIM workspace HTTP export | Yes | Yes | No | Not validated |
| APIM current revision filtering | Yes | Yes | Current HTTP only | Incomplete: no explicit historical revision contract |
| APIM API versions/version sets | Metadata retained | Partial | No | Incomplete selection semantics |
| APIM SOAP/WSDL export | Yes | Yes | No | Not validated |
| APIM GraphQL SDL retrieval | Yes | Yes | No | Not validated |
| APIM WebSocket/gRPC/OData | Visible manual review | Yes | No | Correctly unsupported until a documented byte route exists |
| App Service `siteConfig.apiDefinition.url` | Yes | Yes | Yes | Implemented for public HTTPS URLs |
| Logic Apps custom connector inline Swagger | Yes | Yes | No | Not validated |
| Consumption Logic App Request-trigger synthesis | Yes | Yes | No | Partial only; native `listSwagger` absent |
| Template Spec embedded APIM document | Yes | Yes | No | Not validated |
| Event Grid webhook synthesis | Yes | Yes | No | Partial only; not validated |
| Service Bus topic synthesis | Yes | Yes | No | Partial only; not validated |
| Function binding synthesis | Yes | Yes | No | Partial only; not validated |
| Repository ARM/compiled-Bicep inline APIM document | Yes | Yes | Yes | Implemented for the narrow scanned shape |
| API Center definition inventory/export | No | No | No | P0 gap |
| Fox-style `GithubOrg`/`GithubRepo` selection | Yes | Yes | No | P0 validation gap |
| Canonical `postman:repo` selection | Yes | Yes | No | P0 validation gap |
| Gateway hostname signal | Service-name hint only | Partial | No | Does not resolve service path/API in multi-API gateways |
| Self-hosted/workspace gateway API association | No | No | No | P0 gap |
| Sovereign cloud ARM endpoints | No; public ARM is hardcoded | Public-cloud tests only | No | P0 portability gap |

## Key Finding: Per-Repository Gateway Resolution

The Fox-style tag path exists but does not yet satisfy the production contract.

Current behavior:

- `GithubOrg` plus `GithubRepo`, `postman:repo`, and configured select-grade keys can select one enumerated candidate.
- Resource Graph fallback can recover matching tags when a provider did not surface them.
- Repository text containing `https://<service>.azure-api.net` contributes only the APIM service name.
- APIM service tags are copied to every API in that service. If a tagged APIM service contains multiple APIs, every API receives the same repository tag and the resolver remains ambiguous.
- The repository scanner does not preserve the URL base path, so `https://gateway.azure-api.net/payments` cannot match APIM `api.path=payments`.
- Gateway-to-API assignments, custom hostnames, versions, revisions, and deployment environment are not part of selection.
- No committed live case proves a clean repository can select and export its tagged or URL-correlated gateway API.

Required contract:

1. Explicit source bindings win: full API Center definition ID, full APIM API ARM ID including workspace/revision, or a committed resolver manifest.
2. A committed repository or deployment declaration that binds a spec path/URL to a full Azure resource ID is select-grade.
3. Exact normalized repository URL plus exact gateway host and API base path is select-grade only when it identifies one current API in the selected environment.
4. A unique API carrying a select-grade repository association is select-grade. Service-level tags alone are narrowing evidence when the service contains multiple APIs.
5. Self-hosted and workspace gateway assignments narrow only within a known APIM service. A gateway assignment does not prove repository ownership.
6. Environment, version, or revision multiplicity must fail closed unless an explicit selector or exact committed binding disambiguates it.
7. Name, resource group, OIDC scope, backend URL, and generic tags remain rank-only evidence.

## Ordered Work

### R1: Exact per-repository APIM and gateway resolution

Priority: P0

Seams:

- `src/lib/repo/specs.ts`
- `src/lib/repo/signals.ts`
- `src/lib/repo/azure-iac-scanner.ts`
- `src/lib/azure/clients.ts`
- `src/lib/providers/apim.ts`
- `src/lib/resolve/narrowing-pipeline.ts`
- `src/runtime.ts`
- `src/contracts.ts`

Implementation:

- Add a committed resolver manifest under `.postman/` that can bind repository, environment, native spec path/URL, APIM API ARM ID, API Center definition ARM ID, gateway ID, API version, and API revision. Reuse `.postman/resources.yaml` when it already contains an exact compatible binding; do not introduce a second state file for the same data.
- Preserve full APIM gateway URLs from repository files and deployment declarations. Normalize hostname and base path separately.
- Enumerate APIM service custom hostnames and retain API `path`, version set, version, and revision metadata.
- Add explicit version/revision selection. A full ARM ID containing `;rev=N` must be addressable even when it is not current; implicit discovery still defaults only to a unique current revision.
- Enumerate service-level self-hosted gateway API assignments and workspace APIs/gateways where documented. Treat assignments as narrowing evidence, not export endpoints.
- Stop copying service-level repository tags into selection-grade API ownership when more than one API is present. Require exact API/path/binding evidence for auto-selection in that case.
- Add `environment`, `gateway-id`, `api-version`, and `api-revision` selectors to Action and CLI contracts only where they remove real ambiguity.
- Return stable sorted candidate IDs and a specific ambiguity reason for duplicate environments, versions, revisions, paths, or repo tags.

Acceptance tests:

- A repository containing one exact APIM hostname plus base path selects the matching API from a multi-API service.
- A hostname without a base path does not select among multiple APIs.
- A unique Fox tag pair selects one API; the same service tag inherited by multiple APIs narrows but does not select.
- Public, custom, workspace, and self-hosted gateway metadata preserve the same API identity semantics.
- Explicit current and historical revisions export the requested revision; implicit discovery selects only a unique current revision.
- Two environments, versions, revisions, or gateway assignments remain unresolved without an exact selector.
- A compiled CLI live case starts with an otherwise clean repository, derives `org/repo`, resolves the run-tagged APIM API through tags and gateway path evidence, exports it, and proves no explicit `api-id` was supplied.

### R2: Azure API Center authoritative definition provider

Priority: P0

Seams:

- `src/lib/providers/api-center.ts`
- `src/lib/azure/api-center-client.ts`
- `src/contracts.ts`
- `src/runtime.ts`

Implementation:

- Enumerate API Center services, workspaces, APIs, versions, and definitions through ARM.
- Export bytes with `definitions/{definition}/exportSpecification?api-version=2024-03-01`.
- Handle immediate `200` and long-running `202` responses with bounded `Location` polling and `Retry-After`.
- Use data-plane search only as optional inventory enrichment. Data-plane `GET Definition` metadata is not a byte-retrieval route.
- Preserve native OpenAPI, AsyncAPI, WSDL, WADL, GraphQL SDL, and protobuf artifacts when API Center stores them.
- Consume API Center deployment/environment metadata and APIM synchronization links as association evidence.
- Add exact definition-ID selection and fail closed across multiple definitions or versions.

Acceptance tests:

- Unit tests cover inventory pagination, 200 export, 202 polling, 429/5xx retry, terminal 4xx, malformed/empty bytes, and every supported native format.
- Permission tests distinguish service-reader export rights from data-plane reader rights.
- A live API Center case exports at least OpenAPI and one non-OpenAPI artifact from the compiled CLI.

### R3: Repository, IaC, deployment, and source-control bindings

Priority: P0

Seams:

- `src/lib/repo/scan.ts`
- `src/lib/repo/specs.ts`
- `src/lib/repo/azure-iac-scanner.ts`
- `src/lib/repo/signals.ts`
- new focused parsers under `src/lib/repo/`

Implementation:

- Detect repository specifications by content and supported format, not a narrow filename list. Scan OpenAPI/Swagger, AsyncAPI, WSDL/XSD, WADL, GraphQL SDL, and `.proto` within existing depth/file/byte and symlink bounds.
- Return all valid local candidates through deterministic ranking. Never silently choose the first of multiple source documents.
- Parse `azure.yaml`, `.azure/<environment>/.env`, ARM, Bicep source and compiled JSON, Terraform/AzAPI, Pulumi state-free source, APIOps configuration, GitHub workflows, and Azure DevOps pipeline YAML for exact spec paths/URLs and Azure resource IDs.
- Parse APIM `value` and `*-link` imports, API Center definition resources, deployment outputs, Template Spec IDs, and deployment stack managed-resource IDs.
- Correlate Azure-side App Service and Container Apps source-control records to normalized repository URL and branch.
- Use deployment history and exported templates only behind an explicit permission/capability path. Redact secure parameters, outputs, SAS URLs, and deployment-script content before evidence is retained.
- Treat intended IaC names, OIDC authorization scope, and source-control linkage as association evidence unless they resolve an exact deployed ID.

Acceptance tests:

- Fixtures cover every parser, variable indirection, multiple environments, malformed documents, ignored build/vendor directories, symlink escape, generated output recursion, and secret-shaped values.
- A repository with two valid local specifications returns ranked ambiguity unless the manifest or pipeline binds one exact source.
- Local-only routes run with no Azure credential or network call.

### R4: Native Azure and runtime-declared specification routes

Priority: P1

Implementation:

- Add an opt-in Consumption Logic Apps `listSwagger` route when the identity has the action permission; retain Request-trigger synthesis as the Reader-only fallback.
- Add Standard Logic Apps workflow discovery under `Microsoft.Web/sites/workflows` where a documented definition route exists.
- Read App Service `aiIntegration.ApiSpecPath`. Retrieve bytes only through an explicitly enabled, least-privilege artifact/SCM capability; disabled SCM remains manual review.
- Detect Azure Functions OpenAPI extension endpoints from function metadata and repository configuration. Never call function/host key list operations.
- Support explicitly declared runtime OpenAPI endpoints for App Service, Functions, Container Apps, Static Web Apps, ACI, and AKS workloads. Targets must originate from the repository manifest or authorized ARM inventory, use guarded HTTPS fetch, block private/metadata destinations after DNS resolution, and never receive Azure/GitHub credentials.
- Add App Service and Container Apps source-control correlation. Endpoint/FQDN metadata without a declared spec remains association-only.
- Keep Event Grid, Service Bus, and Functions synthesized contracts marked `partial`; do not infer application payload schemas.

Acceptance tests:

- Each elevated route proves capability absent, permission denied, success, and fallback behavior.
- Public and private-network reachability are separate results; management-plane discovery must not imply runtime reachability.
- Redirect, DNS rebinding, loopback, link-local, private address, metadata endpoint, oversized body, timeout, and credential-forwarding cases remain blocked.

### R5: Native format and protocol completeness

Priority: P1

Implementation:

- Expand `SpecFormat`, validators, artifact naming, and outputs for AsyncAPI YAML/JSON, WADL, protobuf, WSDL with referenced XSD, and GraphQL SDL.
- Preserve native bytes and bundle relative repository references safely. Never flatten external references by sending Azure credentials to remote hosts.
- Validate OpenAPI 2.0, 3.0, and 3.1 separately and report APIM reconstruction limitations.
- Add APIM WADL export if the current documented API version and live service prove the format.
- Keep APIM WebSocket export unsupported while ARM returns the documented permanent 400.
- Keep APIM gRPC/protobuf and GraphQL native export unsupported unless a documented byte route exists; resolve those protocols from repository or API Center artifacts instead.
- Keep messaging topology and envelope synthesis partial unless an authoritative AsyncAPI/schema artifact is linked.

Acceptance tests:

- Native-format fixtures include valid, malformed, empty, oversized, external-reference, and multi-file documents.
- Derived OpenAPI outputs never upgrade `partial` or `reconstructed` inputs to `full`.

### R6: Cloud, scope, identity, pagination, and retry portability

Priority: P0 before advertising non-public clouds or estate completeness

Implementation:

- Replace hardcoded `management.azure.com` and token audiences with an Azure cloud environment abstraction shared by every direct REST client.
- Support Azure Public, US Government, and China endpoint profiles. Advertise a cloud only after live validation in that cloud.
- Support an explicit subscription list for authorized cross-subscription discovery. Add management-group traversal only as an explicit mode with bounded subscription enumeration and least-privilege documentation.
- Keep Resource Graph absence scoped: report "no visible candidates," never global absence.
- Follow ARM/APIM/API Center `nextLink` as opaque. Preserve Resource Graph query/scopes while applying `$skipToken`.
- Honor `Retry-After`; use bounded jittered retry for 408, 429, transient 5xx, and long-running operations. Do not retry permanent unsupported-format 400 responses.
- Document GitHub OIDC immutable repository-ID and legacy subject forms, Azure DevOps workload identity, Azure-hosted managed identity, and service-principal environment credentials without adding secret inputs.

Acceptance tests:

- Endpoint/audience tests cover all cloud profiles without public-cloud literals leaking into sovereign requests.
- Pagination tests cover zero, one, many, duplicate, repeated-token, malformed-link, and ceiling cases for every new list operation.
- Identity tests cover expired token, wrong tenant/subscription, insufficient RBAC, and provider-specific fail-soft behavior.

### R7: Provider architecture and bounded hydration

Priority: P1 before adding more providers

Implementation:

- Move provider identity, source type, formats, graph descriptors, capability requirements, and contract class into one provider registration seam.
- Split lightweight candidate enumeration from expensive hydration/export.
- Run broad Resource Graph and repository association first, partition candidates, then hydrate the selected partition in `resolve-one`.
- Keep `discover-many` explicit about full-estate cost and retain candidate/page/time ceilings.
- Preserve deterministic ordering independent of provider completion order.

Acceptance tests:

- A large mixed estate proves unselected candidates are not hydrated in `resolve-one`.
- Provider timeout/failure does not block other providers, but a selected candidate export failure fails the run.

### R8: Exhaustive validation matrix and claim gate

Priority: P0

Implementation:

- Extend the disposable Azure live stack and sanitized evidence schema so every advertised authoritative/reconstructed provider has at least one compiled-CLI live case.
- Add live cases for APIM service/workspace, current/explicit revision, version set, SOAP, GraphQL, repository-tag selection, gateway host/path selection, API Center, custom connector, Logic Apps, Template Specs, Function bindings, Event Grid, and Service Bus where provisioning is supported.
- Separate unit-only partial synthesis from live-proven provider behavior in README tables.
- Run private-network cases on an Azure-hosted self-hosted runner; do not infer private reachability from public runners.
- Preserve run-scoped teardown, marker checks, committed evidence redaction, and `finally` cleanup.
- Add a generated coverage manifest that maps every advertised route to implementation, unit test, negative test, live case, permissions, contract class, and unsupported reason.

Claim gate:

- No route may be labeled `validated` without current compiled-bundle live evidence or an explicit local-only rationale.
- No provider may be labeled `implemented` without positive, permission-denied, malformed/unsupported, ambiguity, pagination, and secret-hygiene tests relevant to that provider.
- README and release notes must derive supported/validated labels from the coverage manifest.

## Explicit Unsupported and Non-Automatic Routes

These are completion outcomes, not backlog, unless Azure publishes a new safe API:

- Arbitrary gateway hostname to all backing API specifications: no documented universal reverse-lookup exists.
- APIM developer portal scraping: unsupported and non-authoritative; use ARM export.
- APIM WebSocket definition export: permanent unsupported-format response; report manual review.
- APIM gRPC `.proto` export: no documented export route; use repository or API Center.
- Arbitrary App Service, Functions, Container Apps, ACI, AKS, Event Grid, Service Bus, or Event Hubs schema reconstruction from topology: impossible without an application artifact.
- AKS `/openapi/v3`: describes Kubernetes APIs, not arbitrary workload handlers.
- Blind probing of common runtime paths across an estate: prohibited by default. Only explicit or evidence-derived targets are allowed.
- Credential-emitting operations such as function keys, host keys, callback URLs, connection strings, Key Vault values, or secret-bearing deployment fields: prohibited.
- API Center feature parity in sovereign clouds: unsupported until live-proven per cloud.
- A global claim that no API exists: prohibited because Resource Graph and ARM results are RBAC-filtered.

## External Contracts

- APIM export: <https://learn.microsoft.com/en-us/rest/api/apimanagement/api-export/get?view=rest-apimanagement-2024-05-01>
- APIM workspace APIs: <https://learn.microsoft.com/en-us/rest/api/apimanagement/workspace-api/list-by-service?view=rest-apimanagement-2024-05-01>
- APIM self-hosted gateway assignments: <https://learn.microsoft.com/en-us/rest/api/apimanagement/gateway-api/list-by-service?view=rest-apimanagement-2024-05-01>
- APIM revisions: <https://learn.microsoft.com/en-us/rest/api/apimanagement/api-revision/list-by-service?view=rest-apimanagement-2024-05-01>
- API Center definition export: <https://learn.microsoft.com/en-us/rest/api/resource-manager/apicenter/api-definitions/export-specification?view=rest-resource-manager-apicenter-2024-03-01>
- Logic Apps `listSwagger`: <https://github.com/Azure/azure-rest-api-specs/blob/main/specification/logic/resource-manager/Microsoft.Logic/Logic/stable/2016-06-01/examples/WorkflowsListSwagger.json>
- Resource Graph pagination: <https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/paging-results>
- Azure cloud profiles: <https://learn.microsoft.com/en-us/cli/azure/manage-clouds-azure-cli>

## Gates

For each requirement:

1. Add a failing acceptance test that proves the missing route or ambiguity behavior.
2. Implement through the existing provider, repository, narrowing, or client seam.
3. Run `npm test`, `npm run typecheck`, and `npm run lint`.
4. Run `npm run build` and `npm run verify:dist` with committed bundle parity.
5. Run affected compiled-CLI live cases and refresh sanitized evidence.
6. Update the generated coverage manifest and provider documentation.

Release gate:

- Full package gates pass from a clean synchronized `main`.
- Every P0 acceptance test and live case passes.
- Supported/unsupported tables match the generated coverage manifest.
- Immutable tag, rolling aliases, npm artifact, and committed `dist` are byte-consistent.

## Linear Work Items

| Requirement | Issue |
| --- | --- |
| R1 exact per-repository APIM/gateway resolution | [POS-395](https://linear.app/postman/issue/POS-395/live-prove-exact-per-repository-apim-and-gateway-resolution) |
| R2 API Center inventory/export | [POS-394](https://linear.app/postman/issue/POS-394/add-azure-api-center-inventory-and-authoritative-definition-export) |
| R3 repository/IaC/deployment bindings | [POS-398](https://linear.app/postman/issue/POS-398/expand-repository-iac-deployment-and-source-control-bindings) |
| R4 native/runtime-declared routes | [POS-399](https://linear.app/postman/issue/POS-399/add-native-logic-apps-and-runtime-declared-specification-routes) |
| R5 native formats/protocols | [POS-397](https://linear.app/postman/issue/POS-397/expand-native-specification-formats-and-protocol-handling) |
| R6 cloud/scope/identity portability | [POS-401](https://linear.app/postman/issue/POS-401/make-azure-discovery-cloud-scope-identity-and-retry-portable) |
| R7 provider architecture/hydration | [POS-400](https://linear.app/postman/issue/POS-400/refactor-provider-registration-and-narrow-before-hydration) |
| R8 live validation/claim gate | [POS-396](https://linear.app/postman/issue/POS-396/build-exhaustive-azure-provider-validation-and-coverage-claim-gate) |

## Rollback

- New providers and elevated capabilities must be individually disableable without changing baseline APIM/App Service/local behavior.
- Runtime fetch and data-plane capabilities default off until their permission, network, and secret-hygiene live cases pass.
- A provider regression is removed from the advertised coverage manifest and disabled in the next patch release; existing immutable tags are never moved.
- Generated artifacts from a failed run remain confined to `output-dir` and are not committed by this action.

## Definition of Done

- R1, R2, R3, R6, and R8 P0 work is complete and released.
- R4, R5, and R7 routes are either implemented and validated or explicitly classified as unsupported/opt-in with evidence.
- The clean-repository per-repo APIM gateway case is live-proven without explicit `api-id`.
- API Center authoritative export is live-proven.
- Every advertised route maps to implementation, positive/negative tests, permissions, contract class, and live evidence status.
- No absolute "every Azure specification" or global-absence claim remains in product documentation.
- Linear issues linked from this plan are closed with test, live-run, and release evidence.
