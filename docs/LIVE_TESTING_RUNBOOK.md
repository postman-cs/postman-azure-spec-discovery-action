# Live Azure validation runbook

Live validation provisions disposable real Azure resources, exercises the compiled `dist/cli.cjs` against them, captures sanitized evidence, and tears the resources down. It is operator-run only — never wired into pull-request CI.

## Prerequisites

- `az` CLI authenticated (`az account show` succeeds) with rights to create resource groups, APIM Consumption instances, and App Service plans/sites in the target subscription.
- Environment: `AZURE_SUBSCRIPTION_ID` (target subscription) and `AZURE_LOCATION` (a region that allows APIM Consumption and App Service, e.g. `eastus2`).
- A fresh build: `npm run build`.

## Run

```sh
cd cse/postman-azure-spec-discovery-action
npm run build
node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
```

The runner:

1. Sets the subscription explicitly (`az account set --subscription "$AZURE_SUBSCRIPTION_ID"`).
2. Creates a run-marked resource group with a collision-resistant suffix and deploys `validation/fixtures/azure/live-stack.bicep` (APIM Consumption + current HTTP API + App Service plan/site).
3. Deploys the local App Service stub zip and points `siteConfig.apiDefinition.url` at the stub's `/openapi.json`.
4. Polls APIM until export is available (45-minute ceiling, 30-second interval).
5. Runs six CLI cases: explicit APIM `api-id`; APIM discovery; App Service API definition; `discover-many`; local IaC single resolve; ambiguity fixture.
6. Writes sanitized evidence to `validation/evidence/live-azure-surfaces.json` (schema 1: totals plus per-case `{name,status,sourceType,providerType,specFormat}` — no IDs, hosts, URLs, or spec bodies).
7. In `finally`, requests `az group delete --yes --no-wait` for the generated group only after verifying its run marker tag and subscription. A marker mismatch refuses deletion and prints the group name for manual cleanup.

## Flags

- `--provision` — required to create any Azure resource.
- `--teardown` — required to delete the run's resource group.
- Omit both to re-validate an existing stack from a `.local.json` manifest.

## Safety rules

- The runner deletes only the resource group it created, verified by run marker tag + subscription.
- Raw manifests, deployment outputs, and zips are gitignored (`validation/.gitignore`); only sanitized evidence is committed.
- Never run this against a production subscription.
