# Postman Onboarding: Azure Spec Discovery

[![CI](https://github.com/postman-cs/postman-azure-spec-discovery-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-azure-spec-discovery-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-azure-spec-discovery-action?sort=semver)](https://github.com/postman-cs/postman-azure-spec-discovery-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-azure-spec-discovery)](https://www.npmjs.com/package/@postman-cse/onboarding-azure-spec-discovery) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zero-config discovery and export of API specs from Azure services using only your existing Azure credentials. Use it when a service already runs on Azure and you need a source-of-truth [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/) specification that Postman onboarding can turn into deterministic collections, OpenAPI-backed contract checks, smoke tests, mocks, monitors, repo artifacts, and CI runs.

The action resolves the best specification source for the current repository in this order:

1. **Repo spec** — an OpenAPI/Swagger file already committed to the repository wins outright; Azure is never called.
2. **Azure API Management (APIM)** — the current HTTP revision of an APIM API, exported as OpenAPI 3.0 JSON through the ARM export protocol.
3. **App Service API definition** — a site whose `apiDefinition.url` points at a reachable OpenAPI document.
4. **Local Azure IaC** — OpenAPI content embedded in ARM/Bicep templates or referenced by `azure.yaml` in the repository.

When several Azure candidates match, a four-tier narrowing pipeline (IaC fingerprint, resource-group correlation, `postman:*` tag prefilter, naming heuristic) orders them, and genuinely ambiguous results surface as a ranked GitHub Step Summary table instead of a guess.

## Auth and Postman handoff

The action authenticates with `DefaultAzureCredential` — GitHub OIDC via `azure/login`, environment credentials, or Azure CLI login all work with no extra configuration. It needs only read access (`Reader` plus `API Management Service Reader` covers everything). It never creates, modifies, or deletes Azure resources.

The optional `postman-api-key` / `postman-access-token` inputs exist only to enrich anonymous telemetry with the session account type. They are never used for Azure calls or Postman asset operations.

## Usage

```yaml
jobs:
  discover:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - id: spec
        uses: postman-cs/postman-azure-spec-discovery-action@v1
      - run: echo "Resolved ${{ steps.spec.outputs.source-type }} -> ${{ steps.spec.outputs.spec-path }}"
```

## Examples

### Zero-config resolve-one

```yaml
- uses: postman-cs/postman-azure-spec-discovery-action@v1
```

### Known APIM API

```yaml
- uses: postman-cs/postman-azure-spec-discovery-action@v1
  with:
    api-id: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<svc>/apis/<api>
```

### discover-many mode

```yaml
- uses: postman-cs/postman-azure-spec-discovery-action@v1
  with:
    mode: discover-many
    resource-group: payments-rg
```

### Chaining into Postman API onboarding

```yaml
- id: spec
  uses: postman-cs/postman-azure-spec-discovery-action@v1
- uses: postman-cs/postman-api-onboarding-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    spec-path: ${{ steps.spec.outputs.spec-path }}
```

### GitLab and other CI (portable CLI)

```sh
npx @postman-cse/onboarding-azure-spec-discovery \
  --subscription-id "$AZURE_SUBSCRIPTION_ID" \
  --result-json postman-azure-spec-discovery-result.json \
  --dotenv-path azure-spec.env
```

The CLI exposes every action input as a `--kebab-case` flag plus CLI-only flags for repo context and discovery tuning (`--repo-root`, `--expected-service-name`, `--dry-run`, `--max-candidates`, and friends). `--help` lists all of them.

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `mode` | Discovery mode: resolve-one selects the single best service for this repository; discover-many exports every exportable candidate. | no | `resolve-one` |
| `subscription-id` | Optional Azure subscription ID used as the discovery enumeration root. When omitted, the single enabled subscription visible to the credential is used; multiple enabled subscriptions require this input. | no | n/a |
| `resource-group` | Optional resource group that scopes discovery to one group instead of the whole subscription. | no | n/a |
| `api-id` | Optional full APIM API ARM resource ID for this service. Use this to bypass broader subscription discovery. | no | n/a |
| `output-dir` | Directory under the repository root where generated specs are written. | no | `discovered-specs` |
| `postman-api-key` | Optional service-account PMAK used to mint or re-mint a postman-access-token for telemetry enrichment (account_type). Not used for any Azure or Postman asset operation. | no | n/a |
| `postman-access-token` | Optional Postman service-account access token, used only to enrich anonymous telemetry with the session account_type. When omitted, postman-api-key alone can mint one for the same purpose. Not used for any Azure or Postman asset operation. | no | n/a |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `resolution-json` | JSON resolution result describing status, source type, confidence, and evidence. |
| `resolution-status` | Resolution status: resolved or unresolved. |
| `source-type` | Resolved source type: repo-spec, apim-export, app-service-api-definition, iac-embedded, manual-review, or discover-many. |
| `mapping-confidence` | Numeric confidence score for the selected service candidate. |
| `spec-path` | Path to the resolved or generated specification when available. |
| `api-id` | Full APIM API ARM resource ID for APIM resolutions; empty for App Service or IaC-local resolutions. |
| `service-name` | Resolved service name. |
| `services-json` | discover-many output: JSON array of exported services. |
| `service-count` | discover-many output: number of exported services. |
| `export-summary-json` | JSON summary of attempted, exported, failed, and skipped candidates. |
| `candidates-json` | Ranked ambiguous candidates as JSON when resolution is unresolved with at least two candidates; empty otherwise. |
| `provider-type` | Provider that produced the resolved spec: apim, app-service, or iac-local. |
| `spec-format` | Format of the resolved spec: openapi-yaml or openapi-json. |
| `contract-origin` | Compatibility output; always empty in v1. |
| `contract-metadata-path` | Compatibility output; always empty in v1. |
| `variant-count` | Compatibility output; always empty in v1. |
| `derived-openapi-path` | Path to the derived OpenAPI 3.x document when the source was not already OpenAPI 3.x. |
| `derived-openapi-version` | OpenAPI version of the derived document: 3.0.3 or 3.1.0. |
| `derived-openapi-completeness` | Whether the derived OpenAPI document is full or partial. |
| `derived-openapi-format` | Serialization format of the derived OpenAPI document: openapi-json. |
| `derived-openapi-evidence-json` | JSON array of evidence strings describing how the derived OpenAPI document was produced. |
| `narrowing-strategy` | Narrowing tier that produced the candidate ordering: iac-fingerprint, rg-correlation, tag-prefilter, naming-heuristic, or none. |
<!-- outputs-table:end -->

## Supported providers

| Provider | Source | Exported format |
| --- | --- | --- |
| `apim` | Azure API Management current HTTP API revision (ARM export + SAS link) | OpenAPI 3.0 JSON |
| `app-service` | App Service `siteConfig.apiDefinition.url` document | OpenAPI JSON or YAML |
| `iac-local` | OpenAPI embedded in repo ARM/Bicep templates or referenced by `azure.yaml` | OpenAPI JSON or YAML |

Non-HTTP APIM API types (SOAP, GraphQL, WebSocket, gRPC, OData) are surfaced as visible-unsupported candidates and routed to manual review; they are never exported in v1. Service- and workspace-scoped APIM APIs are both enumerated. Azure API Center, Functions, Container Apps, and management-group enumeration are out of scope for v1.

## How it works

1. Resolve inputs, repository context, and the target subscription (explicit `subscription-id`, or the single enabled subscription).
2. Short-circuit to a committed repo spec when one exists.
3. Probe providers fail-soft: an unauthorized provider is skipped (`skipped:iam`), an erroring one is skipped (`skipped:error`), and discovery continues with the rest.
4. Enumerate candidates, narrow with the four-tier pipeline, and score against repository signals.
5. Export the winner (APIM ARM export, guarded HTTPS fetch, or IaC extraction), validate it is real OpenAPI/Swagger with at least one path, and write it under `output-dir` confined to the repository root.
6. Emit all 22 outputs; ambiguous resolutions additionally render a ranked Step Summary table.

## Resources

- [docs/providers.md](docs/providers.md) — provider contracts and evidence semantics.
- [docs/LIVE_TESTING_RUNBOOK.md](docs/LIVE_TESTING_RUNBOOK.md) — operator-run live Azure validation.
- [RELEASE_POLICY.md](RELEASE_POLICY.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

## Telemetry

The action emits one anonymous `completion` event per run (action name `azure-spec-discovery`) through `@postman-cse/automation-telemetry-core`. The payload never contains Azure subscription, tenant, or resource identifiers, resource names, tags, spec content, URLs, or credentials. Opt out with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1`.

## License

[MIT](LICENSE)
