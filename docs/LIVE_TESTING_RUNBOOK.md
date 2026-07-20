# Live Azure validation runbook

Live validation provisions disposable real Azure resources, exercises the compiled `dist/cli.cjs` against them, captures sanitized schema-v2 evidence, and tears the resources down. Provisioning is operator-triggered and runs in the shared Azure DevOps deployment context; it is never wired into pull-request CI.

## Deployment context

- Azure DevOps organization: `https://dev.azure.com/PostmanDevOps`
- Project: `CSE Pilots`
- Pipeline: `postman-azure-spec-discovery-live-validation` (**pipeline id 157**)
- Azure Resource Manager service connection: `azure-cse-pilot-builders`
- Scope: the service connection's `Active Azure Subscription`
- Resource group: `CSE-Azure-Team` (the connection's Contributor scope)
- API Center location: **`eastus`** (harness constant; independent of `AZURE_LOCATION` used for APIM/App Service)

Do not provision live-validation resources from a personal Azure subscription. The Azure DevOps `AzureCLI@2` task authenticates with the workload-identity service connection and derives `AZURE_SUBSCRIPTION_ID` from `az account show`; no personal login, tenant, or subscription ID belongs in the pipeline or committed evidence.

## Exact SHA / githubRef

Pipeline 157 must be queued with an exact immutable GitHub ref (full commit SHA). The pipeline enforces that checkout; the harness does **not** accept a mutable branch tip as proof identity. The harness records only:

- `suiteVersion` (case-set version, currently `r8-pos-396-v1`), and/or
- `testedCommitHashPrefix` (7-character commit correlation hash)

It never writes raw pipeline run IDs, full ARM IDs, or subscription identifiers into committed evidence.

## Prerequisites

- Permission to queue pipeline 157 in `CSE Pilots`.
- The `azure-cse-pilot-builders` service connection remains ready and authorized for the pipeline.
- A fresh build of the exact SHA: `npm run build`.

## Run

Queue pipeline **157** (`postman-azure-spec-discovery-live-validation`) in `PostmanDevOps/CSE Pilots` with the exact SHA. Its `AzureCLI@2` task checks out that ref, builds it, derives the service-connection subscription, and runs:

```sh
node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
```

Download the sanitized `azure-spec-discovery-live-evidence` pipeline artifact and commit only `live-azure-surfaces.json` after reviewing it against `validation/evidence/README.md`. Discard raw manifests, deployment outputs, and `*.local.json` files.

### Dry-run / render (no Azure credentials)

```sh
node validation/scripts/validate-live-azure-surfaces.mjs --dry-run --render-plan
```

Writes gitignored `validation/evidence/live-azure-surfaces.dry-run.local.json` and prints the case/cleanup plan. Never contacts Azure.

### Cancellation recovery

If a run is cancelled after provision:

```sh
AZURE_LIVE_RESUME_SUFFIX=<suffix> AZURE_LIVE_RESUME_MARKER=<run-marker> \
  node validation/scripts/validate-live-azure-surfaces.mjs --teardown --cancel-recover
```

Teardown still requires exact type/name/subscription/group/marker matches. Repeated absence is success. The shared resource group is never deleted.

## Matrix lanes

The runner executes the R8 case catalog (baseline six + APIM clean-repo/format/unsupported inventory + API Center + Logic Apps + custom connector + Template Specs + Event Grid + optional Service Bus + Functions/App Service runtime + local-only R3). Explicit provision flags (`AZURE_LIVE_PROVISION_FLAGS`) gate optional resources. Missing capability becomes machine-readable `requires-capability` with a sanitized reason code — not a silent pass.

| Lane | Notes |
| --- | --- |
| Baseline six | Always attempted when provisioned. |
| APIM multi-API clean repo | Repo tag, Fox `GithubOrg`/`GithubRepo`, host+path, host-only ambiguity, version/revision ambiguity, historical revision, version set. |
| APIM formats | SOAP/WSDL and GraphQL SDL when Azure accepts inventory. |
| APIM unsupported | WebSocket/gRPC/OData classified as manual-review only when Azure accepts inventory; otherwise `requires-capability`. |
| API Center | `eastus`; preflight checks `Microsoft.ApiCenter` registration. Never auto-registers the provider or elevates RBAC. |
| Logic Apps | Consumption request trigger: native `listSwagger` opt-in and Reader synthesis fallback. |
| Custom connector | Inline Swagger when ARM deployment supports it safely. |
| Template Specs | Embedded APIM OpenAPI definition. |
| Event Grid | Webhook partial contract via run-owned App Service endpoint **without secret query**. |
| Service Bus | Standard topic/subscription only when explicitly opted in and cost-bounded; otherwise `requires-capability` (`cost-guard-blocked`). |
| Functions / App Service runtime | Run-owned apps; no key retrieval. |
| Local R3 | Compiled CLI format/parser matrix; `local-only`; no Azure calls. |

## Capability vs GCP category mismatch

Azure evidence uses `requires-capability` for blocked public-cloud lanes. That is **not** the GCP live-harness `substitute` status. Coverage verification accepts only `status: pass` as backing for `validationState: live`. Neither `requires-capability` nor GCP `substitute` promotes a route to live.

## Flags

- `--provision` — required to create any Azure resource.
- `--teardown` — required to delete the run-created resources.
- `--dry-run` / `--render-plan` — local plan/evidence shape without Azure.
- `--cancel-recover` — teardown-only recovery using resume suffix/marker (and optional local manifest).
- Omit provision+teardown (without dry-run) to re-validate an existing stack from a `.local.json` manifest within the same service-connection subscription.

## Safety rules

- Every root resource uses the run marker. The gitignored local manifest records exact type/name/id for operator recovery.
- Shared-group teardown deletes only exact run-created resources verified by name, type, subscription, group, and run marker, in reverse dependency order. Dedicated-group mode deletes only the group it created, verified by run marker and subscription.
- Residual Resource Graph audit must report zero run-marked resources after cleanup.
- Never delete shared RG `CSE-Azure-Team`.
- Never auto-register a resource provider or elevate RBAC.
- Raw manifests, deployment outputs, zips, and dry-run locals are gitignored; only sanitized evidence is committed.
- Never substitute a personal service connection, personal `az login`, or production subscription.
- Failure evidence is still written in the sanitized schema when cases run.
