import { describe, expect, it, vi } from 'vitest';

import type {
  ApiCenterDefinitionSummary,
  AzureApiCenterClient
} from '../src/lib/azure/api-center-client.js';
import {
  ApiCenterProvider,
  parseApiCenterDefinitionArmId,
  safeNativeFilename
} from '../src/lib/providers/api-center.js';

const DEF_A =
  '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v1/definitions/openapi';
const DEF_B =
  '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v2/definitions/openapi';

const OPENAPI_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Echo', version: '1.0.0' },
  paths: { '/echo': { get: { responses: { '200': { description: 'ok' } } } } }
});

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Echo
  version: 1.0.0
paths:
  /echo:
    get:
      responses:
        '200':
          description: ok
`;

const ASYNCAPI_JSON = JSON.stringify({
  asyncapi: '2.6.0',
  info: { title: 'Events', version: '1.0.0' },
  channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
});

const ASYNCAPI_YAML = `asyncapi: 2.6.0
info:
  title: Events
  version: 1.0.0
channels:
  ping:
    publish:
      message:
        payload:
          type: string
`;

const WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Echo">
  <types/>
  <message name="EchoRequest"/>
  <portType name="EchoPort"/>
  <binding name="EchoBinding" type="EchoPort"/>
  <service name="EchoService"/>
</definitions>`;

const WADL = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://example.com/">
    <resource path="echo">
      <method name="GET"/>
    </resource>
  </resources>
</application>`;

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="echo" type="xs:string"/>
</xs:schema>`;

const PROTO = `syntax = "proto3";
package echo;
service Echo {
  rpc Ping (PingRequest) returns (PingReply);
}
message PingRequest { string name = 1; }
message PingReply { string message = 1; }
`;

const GRAPHQL = `type Query {
  ping: String!
}
`;

function definition(overrides: Partial<ApiCenterDefinitionSummary> = {}): ApiCenterDefinitionSummary {
  return {
    id: DEF_A,
    name: 'openapi',
    title: 'OpenAPI',
    resourceGroup: 'rg',
    serviceName: 'ac',
    workspaceName: 'default',
    apiName: 'echo',
    apiTitle: 'Echo',
    versionName: 'v1',
    versionTitle: 'v1',
    specificationName: 'openapi',
    specificationVersion: '3.0.3',
    tags: { 'postman:repo': 'contoso/echo' },
    deployments: [
      {
        name: 'prod',
        environmentId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/environments/prod',
        runtimeType: 'Azure API Management'
      }
    ],
    ...overrides
  };
}

function client(overrides: Partial<AzureApiCenterClient> = {}): AzureApiCenterClient {
  return {
    listServices: vi.fn(async () => []),
    listDefinitions: vi.fn(async () => [definition()]),
    exportSpecification: vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const })),
    probeApiCenterReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('ApiCenterProvider', () => {
  it('AZ-APIC-PROV-001: probe maps 401/403 to skipped:iam and other failures to skipped:error', async () => {
    const denied = new ApiCenterProvider(
      client({
        probeApiCenterReadAccess: vi.fn(async () => {
          throw new Error('AuthorizationFailed: API Center probe returned HTTP 403');
        })
      }),
      { subscriptionId: 'sub-1' }
    );
    expect(await denied.probe()).toBe('skipped:iam');

    const broken = new ApiCenterProvider(
      client({
        probeApiCenterReadAccess: vi.fn(async () => {
          throw new Error('ECONNRESET');
        })
      }),
      { subscriptionId: 'sub-1' }
    );
    expect(await broken.probe()).toBe('skipped:error');
    expect(await new ApiCenterProvider(client(), { subscriptionId: 'sub-1' }).probe()).toBe('available');
  });

  it('AZ-APIC-PROV-002: candidates use full definition ARM ids and treat deployments as association evidence only', async () => {
    const provider = new ApiCenterProvider(client(), { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(DEF_A);
    expect(candidates[0]!.providerType).toBe('api-center');
    expect(candidates[0]!.supported).toBe(true);
    expect(candidates[0]!.evidence.join(' ')).toContain('deployment prod');
    expect(candidates[0]!.evidence.join(' ').toLowerCase()).toContain('association');
  });

  it('AZ-APIC-PROV-003: multiple definitions remain listed; no first/latest auto-pick in provider', async () => {
    const provider = new ApiCenterProvider(
      client({
        listDefinitions: vi.fn(async () => [
          definition({ id: DEF_A, versionName: 'v1', name: 'openapi' }),
          definition({ id: DEF_B, versionName: 'v2', name: 'openapi', versionTitle: 'v2' })
        ])
      }),
      { subscriptionId: 'sub-1' }
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.id).sort()).toEqual([DEF_A, DEF_B].sort());
  });

  it('AZ-APIC-PROV-004: exact definition ARM id selects only that candidate', async () => {
    const exportSpecification = vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const }));
    const provider = new ApiCenterProvider(
      client({
        listDefinitions: vi.fn(async () => [
          definition({ id: DEF_A }),
          definition({ id: DEF_B, versionName: 'v2', name: 'openapi' })
        ]),
        exportSpecification
      }),
      { subscriptionId: 'sub-1' }
    );
    const candidates = await provider.listCandidates();
    const exact = candidates.find((c) => c.id === DEF_B);
    expect(exact).toBeTruthy();
    const exported = await provider.exportSpec(exact!);
    expect(exported.format).toBe('openapi-json');
    expect(exported.contractClass).toBe('authoritative');
    expect(exportSpecification).toHaveBeenCalledTimes(1);
    expect(exportSpecification).toHaveBeenCalledWith(
      expect.objectContaining({ definitionName: 'openapi', versionName: 'v2' })
    );
  });

  it('AZ-APIC-PROV-004a: a complete exact definition ARM id exports directly without broad inventory', async () => {
    const listDefinitions = vi.fn(async () => [definition({ id: DEF_A })]);
    const exportSpecification = vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const }));
    const provider = new ApiCenterProvider(client({ listDefinitions, exportSpecification }), { subscriptionId: 'sub-1' });

    const exact = provider.resolveExplicitDefinition(DEF_B);
    expect(exact).toBeTruthy();
    await provider.exportSpec(exact!);

    expect(listDefinitions).not.toHaveBeenCalled();
    expect(exportSpecification).toHaveBeenCalledWith(expect.objectContaining({ versionName: 'v2', definitionName: 'openapi' }));
    expect(
      provider.resolveExplicitDefinition(
        '/subscriptions/other/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v1/definitions/openapi'
      )
    ).toBeUndefined();
  });

  it('AZ-APIC-PROV-005: all native formats export with stable filenames; empty/malformed/wrong-kind fail', async () => {
    const cases: Array<{ content: string; format: string; filename: string }> = [
      { content: OPENAPI_JSON, format: 'openapi-json', filename: 'index.json' },
      { content: OPENAPI_YAML, format: 'openapi-yaml', filename: 'index.yaml' },
      { content: ASYNCAPI_JSON, format: 'asyncapi-json', filename: 'asyncapi.json' },
      { content: ASYNCAPI_YAML, format: 'asyncapi-yaml', filename: 'asyncapi.yaml' },
      { content: WSDL, format: 'wsdl', filename: 'service.wsdl' },
      { content: WADL, format: 'wadl', filename: 'application.wadl' },
      { content: XSD, format: 'xsd', filename: 'schema.xsd' },
      { content: PROTO, format: 'protobuf', filename: 'service.proto' },
      { content: GRAPHQL, format: 'graphql-sdl', filename: 'schema.graphql' }
    ];

    for (const entry of cases) {
      const provider = new ApiCenterProvider(
        client({
          exportSpecification: vi.fn(async () => ({ content: entry.content, source: 'inline' as const }))
        }),
        { subscriptionId: 'sub-1' }
      );
      const [candidate] = await provider.listCandidates();
      const exported = await provider.exportSpec(candidate!);
      expect(exported.format).toBe(entry.format);
      expect(exported.filename).toBe(entry.filename);
      expect(exported.contractClass).toBe('authoritative');
      if (entry.format === 'openapi-json') {
        expect(exported.content.endsWith('\n')).toBe(true);
        expect(JSON.parse(exported.content).openapi).toBe('3.0.3');
      } else {
        expect(exported.content).toBe(entry.content);
      }
    }

    for (const bad of ['', '{not-json', 'just text', '{"openapi":"3.0.3","info":{},"paths":{}}']) {
      const provider = new ApiCenterProvider(
        client({ exportSpecification: vi.fn(async () => ({ content: bad, source: 'inline' as const })) }),
        { subscriptionId: 'sub-1' }
      );
      const [candidate] = await provider.listCandidates();
      await expect(provider.exportSpec(candidate!)).rejects.toThrow(/empty|parseable|paths|supported native|wrong kind|not an/i);
    }
  });

  it('AZ-APIC-PROV-006: parseApiCenterDefinitionArmId and safeNativeFilename helpers', () => {
    const parsed = parseApiCenterDefinitionArmId(DEF_A);
    expect(parsed).toEqual({
      subscriptionId: 'sub-1',
      resourceGroup: 'rg',
      serviceName: 'ac',
      workspaceName: 'default',
      apiName: 'echo',
      versionName: 'v1',
      definitionName: 'openapi'
    });
    expect(parseApiCenterDefinitionArmId('/subscriptions/x/resourceGroups/rg/providers/Microsoft.ApiManagement/service/s/apis/a')).toBeUndefined();
    expect(safeNativeFilename('openapi-json')).toBe('index.json');
    expect(safeNativeFilename('protobuf')).toBe('service.proto');
  });
});
