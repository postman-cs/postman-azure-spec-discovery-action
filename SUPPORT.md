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
| `Azure credentials are missing or invalid` | Confirm `aws-actions/configure-aws-credentials` ran first and `aws-region` matches the role session. |
| Provider was skipped | Add the provider's read-only IAM permissions from [docs/providers.md](docs/providers.md#security-and-iam). |
| `manual-review` result | Provide a repo-local spec, SSM spec registration, Backstage API entity, known `gateway-id`, or stronger service-name hint. |
| Downstream Postman onboarding failed | Check the service-token step outputs and downstream `credential-preflight` setting. Valid values are `warn` and `enforce`. |
| SNS contract was not selected | Review [docs/sns-contract-resolution.md](docs/sns-contract-resolution.md) for the precedence chain and required SNS permissions. |

## Security reports

Use [SECURITY.md](SECURITY.md) for vulnerability reports or credential exposure concerns. Do not open a public issue for security-sensitive material.
