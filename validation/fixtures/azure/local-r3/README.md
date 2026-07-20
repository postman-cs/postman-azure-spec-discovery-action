# Local-only R3 format/parser matrix fixtures

These fixtures are exercised by the live harness through compiled `dist/cli.cjs`
with `--preflight-checks false` and no Azure network calls. They prove content
detection and parser coverage for native formats only (`local-only` evidence
status). They are not live Azure proof.
