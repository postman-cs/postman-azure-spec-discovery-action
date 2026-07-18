# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by rolling major and minor aliases such as `v1` and `v1.0`) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag, and any relevant (redacted) workflow logs.

## Scope Notes

- This action reads Azure credentials from the runner environment and calls read-only Azure ARM APIs. Prefer Azure OIDC federation via `azure/login` with `id-token: write` and the least-privilege roles documented in [docs/providers.md](docs/providers.md#security-and-iam).
- The optional `postman-api-key` and `postman-access-token` inputs are used only to enrich anonymous telemetry with `account_type`. They are not used for Azure discovery or Postman asset operations.
- Reports about secrets you exposed in your own workflow configuration are out of scope; rotate the credential in Azure or Postman immediately.
