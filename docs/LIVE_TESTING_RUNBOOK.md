# Live Azure validation runbook

Live validation provisions disposable real Azure resources, exercises the compiled `dist/cli.cjs` against them, captures sanitized evidence, and tears the resources down. Provisioning is operator-triggered and runs in the shared Azure DevOps deployment context; it is never wired into pull-request CI.

## Deployment context

- Azure DevOps organization: `https://dev.azure.com/PostmanDevOps`
- Project: `CSE Pilots`
- Azure Resource Manager service connection: `azure-cse-pilot-builders`
- Scope: the service connection's `Active Azure Subscription`

Do not provision live-validation resources from a personal Azure subscription. The Azure DevOps `AzureCLI@2` task authenticates with the workload-identity service connection and derives `AZURE_SUBSCRIPTION_ID` from `az account show`; no personal login, tenant, or subscription ID belongs in the pipeline or committed evidence.

## Prerequisites

- Permission to queue the `PostmanDevOps` live-validation pipeline in `CSE Pilots`.
- The `azure-cse-pilot-builders` service connection remains ready and authorized for the pipeline.
- A fresh build: `npm run build`.

## Run

Queue the `postman-azure-spec-discovery-live-validation` pipeline in `PostmanDevOps/CSE Pilots`. Its `AzureCLI@2` task checks out the requested GitHub ref, builds it, derives the service-connection subscription, and runs:

```sh
node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
```

Download the sanitized `azure-spec-discovery-live-evidence` pipeline artifact and commit only `live-azure-surfaces.json` after reviewing it against `validation/evidence/README.md`.

The runner:

1. Derives and pins the subscription supplied by `azure-cse-pilot-builders` (`az account show` then `az account set`).
2. Creates a run-marked resource group with a collision-resistant suffix and deploys `validation/fixtures/azure/live-stack.bicep` (APIM Consumption + current HTTP API + App Service plan/site).
3. Deploys the local App Service stub zip and points `siteConfig.apiDefinition.url` at the stub's `/openapi.json`.
4. Polls APIM until export is available (5-minute ceiling, 10-second interval).
5. Runs six CLI cases: explicit APIM `api-id`; APIM discovery; App Service API definition; `discover-many`; local IaC single resolve; ambiguity fixture.
6. Writes sanitized evidence to `validation/evidence/live-azure-surfaces.json` (schema 1: totals plus per-case `{name,status,sourceType,providerType,specFormat}` — no IDs, hosts, URLs, or spec bodies).
7. In `finally`, requests `az group delete --yes --no-wait` for the generated group only after verifying its run marker tag and subscription. A marker mismatch refuses deletion and prints the group name for manual cleanup.

## Flags

- `--provision` — required to create any Azure resource.
- `--teardown` — required to delete the run's resource group.
- Omit both to re-validate an existing stack from a `.local.json` manifest within the same service-connection subscription.

## Safety rules

- The runner deletes only the resource group it created, verified by run marker tag + subscription.
- Raw manifests, deployment outputs, and zips are gitignored (`validation/.gitignore`); only sanitized evidence is committed.
- Never substitute a personal service connection, personal `az login`, or production subscription.
