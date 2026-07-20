import { describe, expect, it, vi } from 'vitest';

import type {
  ApiCenterDefinitionSummary,
  ApiCenterDefinitionsResult,
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

const MCP_JSON = JSON.stringify({
  mcpServers: {
    echo: {
      command: 'npx',
      args: ['-y', '@example/echo-mcp']
    }
  }
});

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
    ...overrides
  };
}

function client(overrides: Partial<AzureApiCenterClient> = {}): AzureApiCenterClient {
  return {
    listServices: vi.fn(async () => []),
    listDefinitions: vi.fn(async () => [definition()]),
    listDeployments: vi.fn(async () => [
      {
        name: 'prod',
        environmentId:
          '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/environments/prod',
        runtimeType: 'Azure API Management'
      }
    ]),
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

  it('AZ-APIC-PROV-001a: hierarchy AuthorizationFailed during header listing is unavailable (distinct from association denial)', async () => {
    const listDefinitions = vi.fn(async () => {
      throw new Error('AuthorizationFailed: API Center service listing returned HTTP 403');
    });
    const listDeployments = vi.fn(async () => {
      throw new Error('should not list deployments when hierarchy is denied');
    });
    const provider = new ApiCenterProvider(client({ listDefinitions, listDeployments }), { subscriptionId: 'sub-1' });
    await expect(provider.listCandidateHeaders()).rejects.toThrow(/AuthorizationFailed/);
    await expect(provider.listCandidates()).rejects.toThrow(/AuthorizationFailed/);
    expect(listDeployments).not.toHaveBeenCalled();
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

  it('AZ-APIC-PROV-002a: headers are unhydrated and do not call listDeployments; only selected hydrate', async () => {
    const listDefinitions = vi.fn(async () => [
      definition({ id: DEF_A, versionName: 'v1' }),
      definition({ id: DEF_B, versionName: 'v2', versionTitle: 'v2' })
    ]);
    const listDeployments = vi.fn(async (coords) => [
      {
        name: `dep-${coords.versionName}`,
        runtimeType: 'Azure API Management'
      }
    ]);
    const exportSpecification = vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const }));
    const provider = new ApiCenterProvider(
      client({ listDefinitions, listDeployments, exportSpecification }),
      { subscriptionId: 'sub-1' }
    );

    const headers = await provider.listCandidateHeaders();
    expect(headers).toHaveLength(2);
    expect(headers.every((h) => h.headerHydrated === false)).toBe(true);
    expect(headers.every((h) => !/deployment \S+ .*association evidence only/i.test(h.evidence.join(' ')))).toBe(
      true
    );
    expect(listDeployments).not.toHaveBeenCalled();
    expect(exportSpecification).not.toHaveBeenCalled();

    const selected = headers.find((h) => h.id === DEF_B)!;
    const hydrated = await provider.hydrateCandidates([selected]);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]!.id).toBe(DEF_B);
    expect(hydrated[0]!.evidence.join(' ')).toContain('deployment dep-v2');
    expect(listDeployments).toHaveBeenCalledTimes(1);
    expect(listDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceGroup: 'rg',
        serviceName: 'ac',
        workspaceName: 'default',
        apiName: 'echo',
        versionName: 'v2'
      })
    );
    expect(exportSpecification).not.toHaveBeenCalled();
  });

  it('AZ-APIC-PROV-002b: hydrateCandidates preserves stable order and fail-soft optional deployment enrichment', async () => {
    const listDefinitions = vi.fn(async () => [
      definition({ id: DEF_A, versionName: 'v1' }),
      definition({ id: DEF_B, versionName: 'v2' })
    ]);
    // Mirrors client fail-soft: deployment 403 yields empty association, not a thrown error.
    const listDeployments = vi.fn(async (coords) => {
      if (coords.versionName === 'v1') return [];
      return [{ name: 'prod-v2', runtimeType: 'Azure API Management' }];
    });
    const provider = new ApiCenterProvider(client({ listDefinitions, listDeployments }), { subscriptionId: 'sub-1' });
    const headers = await provider.listCandidateHeaders();
    const hydrated = await provider.hydrateCandidates(headers);
    expect(hydrated.map((c) => c.id)).toEqual(headers.map((h) => h.id));
    expect(hydrated[0]!.evidence.join(' ')).not.toMatch(/deployment /i);
    expect(hydrated[1]!.evidence.join(' ')).toContain('deployment prod-v2');
    expect(listDeployments).toHaveBeenCalledTimes(2);
  });

  it('AZ-APIC-PROV-002c: optional deployment denial is association-only; selected export still succeeds', async () => {
    const listDeployments = vi.fn(async () => []);
    const exportSpecification = vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const }));
    const provider = new ApiCenterProvider(client({ listDeployments, exportSpecification }), { subscriptionId: 'sub-1' });
    const [header] = await provider.listCandidateHeaders();
    const [candidate] = await provider.hydrateCandidates([header!]);
    expect(candidate!.supported).toBe(true);
    expect(candidate!.evidence.join(' ')).not.toMatch(/deployment /i);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.format).toBe('openapi-json');
    expect(exportSpecification).toHaveBeenCalledTimes(1);
  });

  it('AZ-APIC-PROV-002d: truncated inventory fails closed; no partial headers; exact definition-ID still resolves', async () => {
    const truncatedMessage =
      'API Center inventory was truncated; refusing to treat partial results as exhaustive without an exact API Center definition binding';
    const listDefinitions = vi.fn(async () => {
      const definitions: ApiCenterDefinitionsResult = [
        definition({ id: DEF_A }),
        definition({ id: DEF_B, versionName: 'v2' })
      ];
      Object.defineProperty(definitions, 'truncated', { value: true, enumerable: false });
      return definitions;
    });
    const provider = new ApiCenterProvider(client({ listDefinitions }), { subscriptionId: 'sub-1' });

    await expect(provider.listCandidateHeaders()).rejects.toThrow(truncatedMessage);
    await expect(provider.listCandidates()).rejects.toThrow(truncatedMessage);

    // Exact definition-ID resolution bypasses broad inventory entirely.
    const exact = provider.resolveExplicitDefinition(DEF_B);
    expect(exact).toBeTruthy();
    expect(exact!.id).toBe(DEF_B);
    expect(listDefinitions).toHaveBeenCalledTimes(2);
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
    const listDeployments = vi.fn(async () => [{ name: 'prod' }]);
    const exportSpecification = vi.fn(async () => ({ content: OPENAPI_JSON, source: 'inline' as const }));
    const provider = new ApiCenterProvider(client({ listDefinitions, listDeployments, exportSpecification }), {
      subscriptionId: 'sub-1'
    });

    const exact = provider.resolveExplicitDefinition(DEF_B);
    expect(exact).toBeTruthy();
    await provider.exportSpec(exact!);

    expect(listDefinitions).not.toHaveBeenCalled();
    expect(listDeployments).not.toHaveBeenCalled();
    expect(exportSpecification).toHaveBeenCalledWith(expect.objectContaining({ versionName: 'v2', definitionName: 'openapi' }));
    expect(
      provider.resolveExplicitDefinition(
        '/subscriptions/other/resourceGroups/rg/providers/Microsoft.ApiCenter/services/ac/workspaces/default/apis/echo/versions/v1/definitions/openapi'
      )
    ).toBeUndefined();
  });

  it('AZ-APIC-PROV-004b: selected export 403 fails without retry and does not inventory', async () => {
    const listDefinitions = vi.fn(async () => [definition()]);
    const listDeployments = vi.fn(async () => []);
    const exportSpecification = vi.fn(async () => {
      throw new Error('API Center exportSpecification failed with HTTP 403');
    });
    const provider = new ApiCenterProvider(client({ listDefinitions, listDeployments, exportSpecification }), {
      subscriptionId: 'sub-1'
    });
    const exact = provider.resolveExplicitDefinition(DEF_A);
    await expect(provider.exportSpec(exact!)).rejects.toThrow(/HTTP 403/);
    expect(exportSpecification).toHaveBeenCalledTimes(1);
    expect(listDefinitions).not.toHaveBeenCalled();
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it('AZ-APIC-PROV-005d: no-import protobuf/WSDL stay authoritative; imported deps are partial', async () => {
    const closedProto = new ApiCenterProvider(
      client({
        exportSpecification: vi.fn(async () => ({ content: PROTO, source: 'inline' as const }))
      }),
      { subscriptionId: 'sub-1' }
    );
    const [closedCandidate] = await closedProto.listCandidates();
    const closedExport = await closedProto.exportSpec(closedCandidate!);
    expect(closedExport.contractClass).toBe('authoritative');
    expect(closedExport.evidence.join(' ')).toMatch(/dependency-closed|No external protobuf dependency/i);

    const importedProto = `syntax = "proto3";
package echo;
import "shared.proto";
service Echo { rpc Ping (Empty) returns (Empty); }
message Empty {}
`;
    const openProto = new ApiCenterProvider(
      client({
        exportSpecification: vi.fn(async () => ({ content: importedProto, source: 'inline' as const }))
      }),
      { subscriptionId: 'sub-1' }
    );
    const [openCandidate] = await openProto.listCandidates();
    const openExport = await openProto.exportSpec(openCandidate!);
    expect(openExport.contractClass).toBe('partial');
    expect(openExport.completeness).toBe('partial');
    expect(openExport.evidence.join(' ')).toMatch(/shared\.proto|unresolved dependency/i);

    const importedWsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema" name="Echo">
  <types><xsd:schema><xsd:import namespace="urn:x" schemaLocation="types.xsd"/></xsd:schema></types>
  <portType name="EchoPort"/>
</definitions>`;
    const openWsdl = new ApiCenterProvider(
      client({
        exportSpecification: vi.fn(async () => ({ content: importedWsdl, source: 'inline' as const }))
      }),
      { subscriptionId: 'sub-1' }
    );
    const [wsdlCandidate] = await openWsdl.listCandidates();
    const wsdlExport = await openWsdl.exportSpec(wsdlCandidate!);
    expect(wsdlExport.contractClass).toBe('partial');
    expect(wsdlExport.evidence.join(' ')).toMatch(/types\.xsd|unresolved dependency/i);
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
      { content: GRAPHQL, format: 'graphql-sdl', filename: 'schema.graphql' },
      { content: MCP_JSON, format: 'mcp-json', filename: 'mcp.json' }
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

    for (const bad of [
      '',
      '{not-json',
      'just text',
      '{"openapi":"3.0.3","info":{},"paths":{}}',
      '{"name":"not-mcp"}',
      '{"mcpServers":{}}'
    ]) {
      const provider = new ApiCenterProvider(
        client({ exportSpecification: vi.fn(async () => ({ content: bad, source: 'inline' as const })) }),
        { subscriptionId: 'sub-1' }
      );
      const [candidate] = await provider.listCandidates();
      await expect(provider.exportSpec(candidate!)).rejects.toThrow(
        /empty|parseable|paths|supported native|wrong kind|not an|MCP JSON/i
      );
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
    expect(safeNativeFilename('mcp-json')).toBe('mcp.json');
  });
});
