# Changelog

## v1.3.0

Multi-protocol and multi-file definition handoff for Postman onboarding.

- Add MCP JSON discovery and preserve complete protobuf and WSDL/XSD dependency sets with a content-free `spec-files-json` inventory.
- Export documented APIM protobuf schemas, Custom API WSDL, and exact authorized runtime declarations without inferred endpoint probing.
- Production-wire native dependency bundles with atomic staging, rollback, stale-member cleanup, symlink confinement, and source-set limits.
- Keep unresolved cloud dependencies partial/manual and preserve explicit fidelity classes through resolution outputs.

## v1.2.0

Gateway-tag repo resolution: per-service-repo automatic discovery via ownership tags (discovery-hub concept applied at the repo level).

- `tag-prefilter` narrowing now matches tag keys and values case-insensitively (Azure tag names are case-insensitive) and tolerates a trailing `.git` on either side.
- `GithubOrg`/`GithubRepo` tag pairs compose to `<org>/<repo>` and are select-grade beside canonical `postman:repo` — a gateway tagged with its owning repo resolves automatically for that repo's workflow run.
- New CLI-only `repo-tag-keys-json` input registers extra select-grade tag keys (JSON string array, matched case-insensitively). Action inputs/outputs are unchanged; the 24-key output contract is untouched.
- The Resource Graph fallback promised by the tag-prefilter tier is now wired: when enumerated candidates carry no matching tag bag, one targeted tag-lookup query (`buildRepoTagLookupQuery`) maps select-grade tags to ARM IDs and intersects with the enumerated set. Fail-soft: query errors narrow nothing.
- Narrowing evidence now names the select path (`select-grade repo tag`) instead of assuming canonical-tag-only matching.

## v1.1.0

Wave-2 discovery surface: six new providers, APIM WSDL/GraphQL exports, and a new discover-estate mode.

- Six new providers behind concurrent fail-soft probes: `custom-apis` (Logic Apps connector inline swagger), `logic-apps` (Request-trigger partial OpenAPI synthesis), `template-specs` (embedded APIM inline documents with secure-default redaction), `event-grid` (webhook delivery contracts; destination URLs sanitized), `service-bus` (topic publish contracts with SQL/correlation filter metadata), and `function-bindings` (trigger-binding partial webhooks; connection-setting names only).
- APIM SOAP APIs export native WSDL (`wsdl-link`); APIM GraphQL APIs export native SDL through the Reader schema surface plus a partial derived-OpenAPI `/graphql` POST shell. Non-HTTP API types stay visible as candidates.
- `derived-openapi-*` outputs: non-OpenAPI sources also emit a derived OpenAPI 3.x document with an explicit `full`/`partial` completeness marker (downgrade-only).
- New `discover-estate` mode: one Resource Graph sweep over `Resources` + `ResourceContainers` for repo-association tags (`postman:repo`, `github:repository`, `GithubOrg`/`GithubRepo`, `repo`, `repository`), deduped to an org/repo roster written as `repos.json` and emitted on new `repos-json`/`repo-count` outputs. Association only: no spec export, no PRs, no GitHub writes.
- Resource Graph now rides direct ARM REST: the legacy `@azure/arm-resourcegraph` SDK runtime produced an abort signal Node's native fetch rejects, which broke every Resource Graph query at runtime. Dependency dropped.
- Output contract grows from 22 to 24 keys (`repos-json`, `repo-count`); existing keys and ordering are unchanged.

## v1.0.1

Patch release after `v1.0.0` packaging failure.

- Add `package.json` `repository.url` so npm provenance publish succeeds.
- Keep APIM Consumption-tier workspace fail-soft recognition for `MethodNotAllowedInPricingTier`.

## v1.0.0

Initial release.

- Zero-config Azure spec discovery for Postman onboarding with three providers: APIM current-revision HTTP export, App Service API definition fetch, and repo-local Azure IaC extraction.
- Repo-spec short-circuit, four-tier narrowing pipeline, ranked ambiguity Step Summary, and confidence-scored resolution.
- GitHub Action (`dist/index.cjs`) and portable CLI (`dist/cli.cjs`) over one shared runtime with 22 locked outputs and dotenv export.
- Anonymous single-event telemetry (`azure-spec-discovery`) with strict payload hygiene and opt-out.
