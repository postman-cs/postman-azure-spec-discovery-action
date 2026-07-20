import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverRepository } from '../src/lib/repo/discovery.js';
import { scanAzureIac } from '../src/lib/repo/azure-iac-scanner.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { findAllRepoSpecs } from '../src/lib/repo/specs.js';
import {
  parseApiOpsConfig,
  parseArmTemplateJson,
  parseAzureDevOpsPipeline,
  parseAzureEnvFile,
  parseAzureYaml,
  parseBicepSource,
  parseDeploymentArtifact,
  parseGitHubActionsWorkflow,
  parsePulumiYaml,
  parseSourceControlDeclaration,
  parseTerraformHcl,
  parseTfvars
} from '../src/lib/repo/parsers/index.js';

const OPENAPI = `openapi: 3.0.3
info:
  title: Demo
  version: 1.0.0
paths:
  /health:
    get:
      responses:
        '200':
          description: ok
`;

const ASYNCAPI = `asyncapi: 2.6.0
info:
  title: Events
  version: 1.0.0
channels:
  user/signedup:
    subscribe:
      message:
        payload:
          type: object
`;

const WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Demo">
  <types/>
</definitions>
`;

const WADL = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://example.com/">
    <resource path="items"/>
  </resources>
</application>
`;

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="Item" type="xs:string"/>
</xs:schema>
`;

const GRAPHQL = `type Query {
  health: String
}
`;

const PROTO = `syntax = "proto3";
package demo;
message Ping { string id = 1; }
service Greeter { rpc SayHello (Ping) returns (Ping); }
`;

const MCP_JSON = JSON.stringify({
  mcpServers: {
    weather: {
      command: 'npx',
      args: ['-y', '@example/weather-mcp']
    }
  }
});

const FULL_APIM =
  '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-demo/providers/Microsoft.ApiManagement/service/apim-demo/apis/orders;rev=2';

const FULL_APIC =
  '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-demo/providers/Microsoft.ApiCenter/services/apic-demo/workspaces/default/apis/orders/versions/v1/definitions/openapi';

describe('R3 repository discovery', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'r3-discovery-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('content-detects every native format under unusual filenames', async () => {
    await writeFile(path.join(repoRoot, 'weird-contract.blob'), OPENAPI);
    await writeFile(path.join(repoRoot, 'events.notasync'), ASYNCAPI);
    await writeFile(path.join(repoRoot, 'soap.service.xml'), WSDL);
    await writeFile(path.join(repoRoot, 'rest.app.xml'), WADL);
    await writeFile(path.join(repoRoot, 'types.model.xml'), XSD);
    await writeFile(path.join(repoRoot, 'schema.sdl'), GRAPHQL);
    await writeFile(path.join(repoRoot, 'messages.txt'), PROTO);
    await writeFile(path.join(repoRoot, 'tools.config.json'), MCP_JSON);
    await writeFile(path.join(repoRoot, 'random.json'), JSON.stringify({ name: 'not-mcp', foo: 1 }));
    // Cross-action negatives: oddly named message-only protobuf and non-object MCP remotes.
    await writeFile(path.join(repoRoot, 'idl.notes'), 'message Ping { string id = 1; }\n');
    await writeFile(
      path.join(repoRoot, 'broken-mcp.json'),
      JSON.stringify({ name: 'io.github.example/weather', remotes: ['https://example.com'] })
    );

    const specs = await findAllRepoSpecs(repoRoot);
    const formats = specs.map((spec) => spec.format).sort();
    expect(formats).toEqual([
      'asyncapi-yaml',
      'graphql-sdl',
      'mcp-json',
      'openapi-yaml',
      'protobuf',
      'wadl',
      'wsdl',
      'xsd'
    ]);
    expect(specs.some((spec) => spec.path === 'random.json')).toBe(false);
    expect(specs.some((spec) => spec.path === 'idl.notes')).toBe(false);
    expect(specs.some((spec) => spec.path === 'broken-mcp.json')).toBe(false);
  });

  it('returns two valid specs in stable ranked order and never first-match selects', async () => {
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await writeFile(path.join(repoRoot, 'docs/secondary.yaml'), OPENAPI.replace('Demo', 'Secondary'));
    await writeFile(path.join(repoRoot, 'openapi.yaml'), OPENAPI.replace('Demo', 'Primary'));

    const first = await findAllRepoSpecs(repoRoot);
    const second = await findAllRepoSpecs(repoRoot);
    expect(first).toHaveLength(2);
    expect(first.map((spec) => spec.path)).toEqual(second.map((spec) => spec.path));
    expect(first[0]?.path).toBe('openapi.yaml');
    expect(first[1]?.path).toBe('docs/secondary.yaml');
    expect(first[0]!.rankScore).toBeGreaterThan(first[1]!.rankScore);
  });

  it('ranks named MCP JSON above content-detected unusual filenames and leaves ambiguity intact', async () => {
    await writeFile(path.join(repoRoot, 'tools.config.json'), MCP_JSON);
    await writeFile(path.join(repoRoot, 'mcp.json'), MCP_JSON);

    const specs = await findAllRepoSpecs(repoRoot);
    expect(specs).toHaveLength(2);
    expect(specs[0]?.path).toBe('mcp.json');
    expect(specs[0]?.format).toBe('mcp-json');
    expect(specs[1]?.path).toBe('tools.config.json');
    expect(specs[0]!.rankScore).toBeGreaterThan(specs[1]!.rankScore);
  });

  it('parses azure.yaml and .azure env allowlisted coordinates', () => {
    const yamlBindings = parseAzureYaml(
      'azure.yaml',
      `
name: shop
services:
  api:
    project: ./specs/api.yaml
    resourceGroup: rg-shop
`
    );
    expect(yamlBindings.some((binding) => binding.nativeSpecPath === 'specs/api.yaml')).toBe(true);
    expect(yamlBindings.every((binding) => binding.class === 'association-only')).toBe(true);

    const envBindings = parseAzureEnvFile(
      '.azure/prod/.env',
      `
APIM_API_ID=${FULL_APIM}
API_CENTER_DEFINITION_ID=${FULL_APIC}
STORAGE_KEY=AccountKey=super-secret
OPENAPI_PATH=specs/api.yaml
`
    );
    expect(envBindings).toHaveLength(1);
    expect(envBindings[0]?.class).toBe('exact-binding');
    expect(envBindings[0]?.apimApiId).toBe(FULL_APIM);
    expect(JSON.stringify(envBindings)).not.toContain('super-secret');
    expect(JSON.stringify(envBindings)).not.toContain('AccountKey');
  });

  it('parses ARM/Bicep exact and association cases including link imports', () => {
    const arm = parseArmTemplateJson(
      'apim.json',
      JSON.stringify({
        parameters: {
          subscriptionId: { type: 'string', defaultValue: '11111111-1111-1111-1111-111111111111' },
          resourceGroupName: { type: 'string', defaultValue: 'rg-demo' },
          adminPassword: { type: 'secureString', defaultValue: 'do-not-leak' }
        },
        resources: [
          {
            type: 'Microsoft.ApiManagement/service/apis',
            name: 'apim-demo/orders',
            properties: {
              format: 'openapi+json-link',
              value: 'https://example.com/openapi.json',
              path: 'orders'
            }
          }
        ]
      })
    );
    expect(arm.linkReferences).toHaveLength(1);
    expect(arm.bindings.some((binding) => binding.nativeSpecUrl?.includes('example.com'))).toBe(true);
    expect(arm.bindings.some((binding) => binding.class === 'exact-binding' && binding.apimApiId)).toBe(true);
    expect(JSON.stringify(arm)).not.toContain('do-not-leak');

    const bicep = parseBicepSource(
      'main.bicep',
      `
param subscriptionId string = '11111111-1111-1111-1111-111111111111'
@secure()
param secret string = 'nope'
resource api 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = {
  name: 'apim-demo/orders'
  properties: {
    format: 'openapi-link'
    value: 'https://example.com/spec.yaml'
    path: 'orders'
  }
}
var id = '${FULL_APIM}'
`
    );
    expect(bicep.some((binding) => binding.class === 'exact-binding')).toBe(true);
    expect(JSON.stringify(bicep)).not.toContain('nope');
  });

  it('parses Terraform/AzAPI and tfvars static indirection', () => {
    const vars = parseTfvars(
      'prod.tfvars',
      `
subscription_id = "11111111-1111-1111-1111-111111111111"
resource_group_name = "rg-demo"
api_management_name = "apim-demo"
password = "secret-value"
`
    );
    expect(vars.password).toBeUndefined();
    const bindings = parseTerraformHcl(
      'apim.tf',
      `
resource "azurerm_api_management_api" "orders" {
  name                = "orders"
  api_management_name = var.api_management_name
  resource_group_name = var.resource_group_name
  revision            = "2"
  path                = "orders"
  import {
    content_format = "openapi"
    content_value  = "specs/orders.yaml"
  }
}
`,
      vars
    );
    expect(bindings.some((binding) => binding.class === 'exact-binding' && binding.apimApiId?.includes('/apis/orders'))).toBe(
      true
    );
    expect(bindings.some((binding) => binding.nativeSpecPath === 'specs/orders.yaml')).toBe(true);
    expect(JSON.stringify(bindings)).not.toContain('secret-value');
  });

  it('parses Pulumi YAML association/exact and skips secret stacks', () => {
    const skipped = parsePulumiYaml('Pulumi.prod.yaml', 'secretsprovider: passphrase\nencryptionsalt: abc\n');
    expect(skipped).toEqual([]);

    const bindings = parsePulumiYaml(
      'Pulumi.yaml',
      `
resources:
  ordersApi:
    type: azure-native:apimanagement:Api
    properties:
      name: orders
      path: orders
      openApiSpecification: specs/orders.yaml
      id: ${FULL_APIM}
`
    );
    expect(bindings.some((binding) => binding.nativeSpecPath === 'specs/orders.yaml')).toBe(true);
    expect(bindings.some((binding) => binding.class === 'exact-binding')).toBe(true);
  });

  it('parses APIOps, GitHub Actions, and Azure DevOps declarations', () => {
    const apiops = parseApiOpsConfig(
      'configuration.extractor.yaml',
      `
apimServiceName: apim-demo
resourceGroup: rg-demo
API_SPECIFICATION_PATH: specs/orders.yaml
apimApiId: ${FULL_APIM}
`
    );
    expect(apiops[0]?.class).toBe('exact-binding');
    expect(apiops[0]?.nativeSpecPath).toBe('specs/orders.yaml');

    const gha = parseGitHubActionsWorkflow(
      '.github/workflows/publish.yml',
      `
env:
  APIM_API_ID: ${FULL_APIM}
  OPENAPI_PATH: specs/orders.yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          client-secret: \${{ secrets.AZURE_CLIENT_SECRET }}
      - run: echo publish
        env:
          SPEC: \${{ env.OPENAPI_PATH }}
`
    );
    expect(gha.some((binding) => binding.class === 'exact-binding')).toBe(true);
    expect(gha.some((binding) => binding.nativeSpecPath === 'specs/orders.yaml')).toBe(true);
    expect(JSON.stringify(gha)).not.toMatch(/secrets\.AZURE_CLIENT_SECRET/);

    const ado = parseAzureDevOpsPipeline(
      'azure-pipelines.yml',
      `
variables:
  - name: APIM_API_ID
    value: ${FULL_APIM}
steps:
  - task: AzureCLI@2
    inputs:
      scriptPath: specs/orders.yaml
`
    );
    expect(ado.some((binding) => binding.class === 'exact-binding')).toBe(true);
  });

  it('parses deployment artifacts and source-control association fields', () => {
    const artifacts = parseDeploymentArtifact(
      'deployments/outputs.json',
      JSON.stringify({
        outputs: {
          apiId: { type: 'string', value: FULL_APIM },
          templateSpecId: {
            type: 'string',
            value:
              '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-demo/providers/Microsoft.Resources/templateSpecs/demo/versions/v1'
          },
          adminPassword: { type: 'secureString', value: 'nope' }
        }
      })
    );
    expect(artifacts.some((binding) => binding.apimApiId === FULL_APIM)).toBe(true);
    expect(artifacts.some((binding) => binding.templateSpecId)).toBe(true);
    expect(JSON.stringify(artifacts)).not.toContain('nope');

    const sourceControl = parseSourceControlDeclaration(
      'infra/app.json',
      JSON.stringify({
        type: 'Microsoft.Web/sites',
        name: 'app-demo',
        properties: {
          siteConfig: { scmType: 'GitHub' },
          repoUrl: 'https://github.com/acme/demo',
          branch: 'main'
        }
      })
    );
    expect(sourceControl[0]?.class).toBe('association-only');
    expect(sourceControl[0]?.sourceControlRepoUrl).toBe('https://github.com/acme/demo');
    expect(sourceControl[0]?.sourceControlBranch).toBe('main');
  });

  it('aggregate discovery returns specs, exact bindings, associations, diagnostics', async () => {
    await writeFile(path.join(repoRoot, 'openapi.yaml'), OPENAPI);
    await writeFile(path.join(repoRoot, 'async.events.yaml'), ASYNCAPI);
    await mkdir(path.join(repoRoot, '.azure/prod'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.azure/prod/.env'),
      `APIM_API_ID=${FULL_APIM}\nCLIENT_SECRET=super-secret\n`
    );
    await writeFile(
      path.join(repoRoot, 'azure.yaml'),
      `name: shop\nservices:\n  api:\n    project: ./openapi.yaml\n`
    );

    const result = await discoverRepository({ repoRoot, outputDir: 'discovered-specs' });
    expect(result.localSpecs.length).toBeGreaterThanOrEqual(2);
    expect(result.exactBindings.some((binding) => binding.apimApiId === FULL_APIM)).toBe(true);
    expect(result.associations.some((binding) => binding.family === 'azure-yaml')).toBe(true);
    expect(result.diagnostics.messages.some((message) => /multiple local specifications/i.test(message))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('respects depth/file/symlink/ignored-dir boundaries and skips secret paths', async () => {
    const depth6 = path.join(repoRoot, 'd1/d2/d3/d4/d5/d6');
    const depth7 = path.join(depth6, 'd7');
    await mkdir(depth7, { recursive: true });
    await writeFile(path.join(depth6, 'included.yaml'), OPENAPI);
    await writeFile(path.join(depth7, 'too-deep.yaml'), OPENAPI);
    for (const directory of ['node_modules', '.git', 'dist', 'vendor', 'discovered-specs', 'build']) {
      await mkdir(path.join(repoRoot, directory), { recursive: true });
      await writeFile(path.join(repoRoot, directory, 'ignored.yaml'), OPENAPI);
    }
    await writeFile(path.join(repoRoot, 'terraform.tfstate'), '{"secrets":"nope"}');
    await writeFile(path.join(repoRoot, 'oversized.yaml'), `${OPENAPI}\n${'x'.repeat(600_000)}`);

    const outside = await mkdtemp(path.join(tmpdir(), 'r3-outside-'));
    try {
      await writeFile(path.join(outside, 'outside.yaml'), OPENAPI);
      await symlink(path.join(outside, 'outside.yaml'), path.join(repoRoot, 'outside-link.yaml'));
      await symlink(outside, path.join(repoRoot, 'outside-dir'));

      const specs = await findAllRepoSpecs(repoRoot, { outputDirName: 'discovered-specs' });
      expect(specs.map((spec) => spec.path)).toEqual(['d1/d2/d3/d4/d5/d6/included.yaml']);

      const discovery = await discoverRepository({ repoRoot, outputDir: 'discovered-specs' });
      expect(discovery.diagnostics.skippedSecretFiles).toContain('terraform.tfstate');
      expect(JSON.stringify(discovery)).not.toContain('nope');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('scanAzureIac compatibility keeps confinement and exposes discovery', async () => {
    await Promise.all(
      Array.from({ length: 205 }, async (_, index) => {
        const name = `api-${String(index).padStart(3, '0')}`;
        await writeFile(
          path.join(repoRoot, `${name}.json`),
          JSON.stringify({
            resources: [
              {
                type: 'Microsoft.ApiManagement/service/apis',
                name: `svc/${name}`,
                properties: {
                  format: 'openapi+json',
                  value: {
                    openapi: '3.0.3',
                    info: { title: name, version: '1.0.0' },
                    paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } }
                  }
                }
              }
            ]
          })
        );
      })
    );
    const result = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(result.candidates).toHaveLength(200);
    expect(result.discovery).toBeDefined();
    expect(result.candidates[0]?.id).toContain('api-000.json');
  });

  it('makes no process or network calls during local discovery', async () => {
    await writeFile(path.join(repoRoot, 'openapi.yaml'), OPENAPI);
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await discoverRepository({ repoRoot });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats unresolved variable indirection as non-binding', () => {
    const bindings = parseTerraformHcl(
      'api.tf',
      `
resource "azurerm_api_management_api" "orders" {
  name                = "orders"
  api_management_name = var.missing_service
  resource_group_name = "rg-demo"
  revision            = "1"
}
`
    );
    expect(bindings.every((binding) => binding.class === 'association-only')).toBe(true);
  });

  it('marks multiple azure environments as distinct association/exact rows', () => {
    const prod = parseAzureEnvFile('.azure/prod/.env', `APIM_API_ID=${FULL_APIM}\n`);
    const dev = parseAzureEnvFile('.azure/dev/.env', `APIM_SERVICE_NAME=apim-dev\n`);
    expect(prod[0]?.environment).toBe('prod');
    expect(prod[0]?.class).toBe('exact-binding');
    expect(dev[0]?.environment).toBe('dev');
    expect(dev[0]?.class).toBe('association-only');
  });

  it('C3/Q1: secret-named and root .env files are not read into discovery or signals', async () => {
    const leakedHost = 'leaked-secret-service.azure-api.net';
    const leakedUrl = `https://${leakedHost}/orders`;
    await writeFile(path.join(repoRoot, 'secrets.json'), JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'LeakedFromSecrets', version: '1.0.0' },
      paths: {
        '/health': {
          get: { responses: { '200': { description: 'ok' } } }
        }
      },
      servers: [{ url: leakedUrl }]
    }));
    await writeFile(
      path.join(repoRoot, 'credentials.env'),
      `APIM_GATEWAY_URL=${leakedUrl}\nAPIM_API_ID=${FULL_APIM}\n`
    );
    await writeFile(
      path.join(repoRoot, '.env'),
      `APIM_GATEWAY_URL=${leakedUrl}\nOPENAPI_PATH=specs/leaked.yaml\n`
    );
    // Dedicated R3 allowlist path must remain readable via discovery.
    await mkdir(path.join(repoRoot, '.azure/prod'), { recursive: true });
    await writeFile(path.join(repoRoot, '.azure/prod/.env'), `APIM_API_ID=${FULL_APIM}\n`);

    const specs = await findAllRepoSpecs(repoRoot);
    expect(specs.some((spec) => spec.path === 'secrets.json')).toBe(false);
    expect(specs.some((spec) => spec.path === '.env')).toBe(false);
    expect(specs.some((spec) => spec.path === 'credentials.env')).toBe(false);
    expect(JSON.stringify(specs)).not.toContain('LeakedFromSecrets');
    expect(JSON.stringify(specs)).not.toContain(leakedHost);

    const discovery = await discoverRepository({ repoRoot });
    expect(discovery.localSpecs.some((spec) => spec.path === 'secrets.json')).toBe(false);
    expect(discovery.diagnostics.skippedSecretFiles).toEqual(
      expect.arrayContaining(['.env', 'credentials.env', 'secrets.json'])
    );
    expect(discovery.exactBindings.some((binding) => binding.apimApiId === FULL_APIM)).toBe(true);
    expect(JSON.stringify(discovery.localSpecs)).not.toContain(leakedHost);
    expect(JSON.stringify(discovery.exactBindings)).not.toContain(leakedHost);

    const signals = await collectRepoSignals({ repoRoot });
    expect(signals.gatewayUrls.some((url) => url.hostname === leakedHost)).toBe(false);
    expect(signals.serviceHints).not.toContain('leaked-secret-service');
    expect(JSON.stringify(signals)).not.toContain(leakedHost);
  });

  it('C3/Q1: discovers exact Pulumi binding from conventional infra/index.ts', async () => {
    await mkdir(path.join(repoRoot, 'infra'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'infra/index.ts'),
      `
import * as apimanagement from "@pulumi/azure-native/apimanagement";

const ordersApi = new apimanagement.Api("orders", {
  path: "orders",
  openApiSpecification: "specs/orders.yaml",
});

export const apimApiId = "${FULL_APIM}";
`
    );

    const discovery = await discoverRepository({ repoRoot });
    expect(
      discovery.exactBindings.some(
        (binding) =>
          binding.family === 'pulumi' &&
          binding.class === 'exact-binding' &&
          binding.apimApiId === FULL_APIM
      )
    ).toBe(true);
    expect(
      discovery.associations.some(
        (binding) => binding.family === 'pulumi' && binding.nativeSpecPath === 'specs/orders.yaml'
      ) ||
        discovery.exactBindings.some(
          (binding) => binding.family === 'pulumi' && binding.nativeSpecPath === 'specs/orders.yaml'
        )
    ).toBe(true);
  });

  it('C3/Q1: parser object walks terminate on over-deep and over-node input', () => {
    let deep: Record<string, unknown> = { value: FULL_APIM };
    for (let i = 0; i < 80; i += 1) {
      deep = { nest: deep };
    }
    const deepStarted = Date.now();
    const deepArtifacts = parseDeploymentArtifact('deployments/deep.json', JSON.stringify(deep));
    expect(Date.now() - deepStarted).toBeLessThan(1000);
    expect(Array.isArray(deepArtifacts)).toBe(true);

    const wide: Record<string, string> = {};
    for (let i = 0; i < 5000; i += 1) {
      wide[`k${i}`] = i === 0 ? FULL_APIM : `value-${i}`;
    }
    const wideStarted = Date.now();
    const wideArtifacts = parseDeploymentArtifact('deployments/wide.json', JSON.stringify({ outputs: wide }));
    expect(Date.now() - wideStarted).toBeLessThan(2000);
    expect(Array.isArray(wideArtifacts)).toBe(true);

    let nestedWorkflow: Record<string, unknown> = {
      env: { OPENAPI_PATH: 'specs/orders.yaml' },
      jobs: { publish: { steps: [{ run: 'echo' }] } }
    };
    for (let i = 0; i < 80; i += 1) {
      nestedWorkflow = { wrap: nestedWorkflow };
    }
    const ciStarted = Date.now();
    const gha = parseGitHubActionsWorkflow(
      '.github/workflows/deep.yml',
      // Keep YAML shallow enough to parse; depth ceiling is exercised on the object walk.
      `env:\n  OPENAPI_PATH: specs/orders.yaml\njobs:\n  publish:\n    steps:\n      - run: echo\n`
    );
    expect(Date.now() - ciStarted).toBeLessThan(1000);
    expect(gha.some((binding) => binding.nativeSpecPath === 'specs/orders.yaml')).toBe(true);

    let nestedSite: Record<string, unknown> = {
      type: 'Microsoft.Web/sites',
      name: 'app-demo',
      properties: { repoUrl: 'https://github.com/acme/demo', branch: 'main' }
    };
    for (let i = 0; i < 80; i += 1) {
      nestedSite = { wrap: nestedSite };
    }
    const scStarted = Date.now();
    const sourceControl = parseSourceControlDeclaration('infra/deep.json', JSON.stringify(nestedSite));
    expect(Date.now() - scStarted).toBeLessThan(1000);
    expect(Array.isArray(sourceControl)).toBe(true);
    // Over-deep wrap means the source-control shape may be skipped; termination is the contract.
    void nestedWorkflow;
  });
});
