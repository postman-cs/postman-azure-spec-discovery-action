# Support

## Before opening an issue

Check the action logs for the selected provider, `resolution-status`, `source-type`, and `mapping-confidence`. The action is read-only against Azure and silently skips providers your role cannot read, so most discovery failures are caused by subscription mismatch, missing RBAC read permissions, missing repo-local specs, or ambiguous service names.

## What to include

- The action version or tag you ran.
- The `subscription-id` value and provider you expected to resolve.
- The relevant sanitized workflow step log.
- The `resolution-json` output with secrets, subscription IDs, and private hostnames redacted.
- Whether the workflow used azure/login OIDC federation or preconfigured Azure credentials.
- Whether the result was handed to `postman-api-onboarding-action` or `postman-bootstrap-action`.

Do not include Azure secrets, Postman API keys, Postman access tokens, private OpenAPI documents, or unredacted account identifiers in public issues.

## Common support paths

| Symptom | First check |
| --- | --- |
| `Azure credentials are missing or invalid` | Confirm `azure/login` ran first and the federated credential covers this repository and environment. |
| Provider was skipped | Add the provider's read-only IAM permissions from [docs/providers.md](docs/providers.md#security-and-iam). |
| `manual-review` result | Provide a repo-local spec, an exact APIM `api-id`, a canonical `postman:repo` tag, or a stronger service-name hint. |
| Downstream Postman onboarding failed | Check the service-token step outputs and downstream `credential-preflight` setting. Valid values are `warn` and `enforce`. |
| APIM or App Service API was not selected | Confirm the resource group, API type, current APIM revision, and `siteConfig.apiDefinition.url`; then review [docs/providers.md](docs/providers.md). |

## Security reports

Use [SECURITY.md](SECURITY.md) for vulnerability reports or credential exposure concerns. Do not open a public issue for security-sensitive material.
