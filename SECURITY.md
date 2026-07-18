# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by the rolling `v1` alias) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag, and any relevant (redacted) workflow logs.

## Scope Notes

- This action reads Azure credentials from the runner environment and calls read-only Azure ARM APIs. Prefer GitHub OIDC federation via `azure/login` with `id-token: write` and least-privilege Reader roles needed for the providers you use.
- This action does not require a Postman API key or Postman access token. Postman credentials are consumed by downstream onboarding actions after `spec-path` is resolved.
- Use `postman-resolve-service-token-action` as the primary way to mint a Postman access token and resolve the team ID from a service-account PMAK.
- When service-account minting is unavailable, use the Postman CLI credential store created by `postman login` as the fallback source. Do not paste copied cookies, DevTools values, or manually harvested session credentials into workflow secrets.
- Downstream `credential-preflight` supports `warn` and `enforce` only. Do not document or depend on a public opt-out.
- Reports about secrets you exposed in your own workflow configuration are out of scope; rotate the credential in Azure or Postman immediately.

## Credential Matrix

| Credential | Used by | Recommended source | Notes |
| --- | --- | --- | --- |
| Azure credentials | `azure/login` and this action | GitHub OIDC federated credentials | Grant least-privilege Reader roles for discovery. |
| `POSTMAN_SERVICE_ACCOUNT_API_KEY` | `postman-resolve-service-token-action` and downstream onboarding actions | GitHub secret | Must be a Postman service-account PMAK when minting an access token. |
| Postman access token | Downstream onboarding actions | `postman-resolve-service-token-action` output | Pass through `steps.postman_token.outputs.token`; do not store unless your workflow requires it. |
| Postman team ID | Composite onboarding action | `postman-resolve-service-token-action` output | Pass through `steps.postman_token.outputs.team-id` to the composite action for org-mode handoff. Direct bootstrap workflows should use `workspace-team-id` for workspace creation. |
