import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import {
  RuntimeDeclaredRoutesProvider,
  type RuntimeDeclaredSpecTarget
} from '../src/lib/providers/runtime-declared-routes.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'RuntimeOrders', version: '1.0.0' },
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function target(overrides: Partial<RuntimeDeclaredSpecTarget> = {}): RuntimeDeclaredSpecTarget {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders/spec',
    name: 'orders-ca',
    workloadKind: 'container-apps',
    url: 'https://orders.example.com/openapi.json',
    resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders',
    providerResourceType: 'Microsoft.App/containerApps',
    tags: { 'postman:repo': 'contoso/orders' },
    ...overrides
  };
}

describe('R4 runtime-declared specification routes', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-RT-R4-001: disabled by default — lists no candidates and performs no probing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new RuntimeDeclaredRoutesProvider({
      targets: [target()]
    });
    expect(await provider.listCandidates()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AZ-RT-R4-002: explicit HTTPS target exports authoritative validated document', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target()]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.providerType).toBe('runtime-declared');
    expect(candidate!.meta.workloadKind).toBe('container-apps');
    expect(candidate!.evidence.join('\n')).toMatch(/No blind common-path probing/i);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.content).toContain('RuntimeOrders');
  });

  it('AZ-RT-R4-003: rejects blind common-path inventing — only exact declared URLs', async () => {
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: []
    });
    expect(await provider.listCandidates()).toEqual([]);
    // Provider has no API to probe /swagger.json across an estate.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(provider))).not.toContain('probeCommonPaths');
  });

  it('AZ-RT-R4-004: never forwards credentials on public runtime fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: 'https://orders.example.com/openapi.json' })]
    });
    const [candidate] = await provider.listCandidates();
    await provider.exportSpec(candidate!);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-ms-path-query')).toBeNull();
  });

  it('AZ-RT-R4-005: invalid document is not treated as authoritative', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"not":"openapi"}\n', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target()]
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/did not validate|not authoritative/i);
  });

  it('AZ-RT-R4-006: preserves provider/resource identity metadata', async () => {
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [
        target({
          workloadKind: 'aks',
          providerResourceType: 'Microsoft.ContainerService/managedClusters',
          resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/k8s'
        })
      ]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.meta.providerResourceType).toBe('Microsoft.ContainerService/managedClusters');
    expect(candidate!.meta.resourceId).toContain('managedClusters/k8s');
    expect(candidate!.meta.workloadKind).toBe('aks');
  });

  it('AZ-RT-R4-008: exports each bootstrap-native single-file format with shared safeNativeFilename', async () => {
    const samples: Array<{ url: string; body: string; format: string; filename: string }> = [
      {
        url: 'https://orders.example.com/openapi.json',
        body: VALID_OPENAPI,
        format: 'openapi-json',
        filename: 'index.json'
      },
      {
        url: 'https://orders.example.com/openapi.yaml',
        body: 'openapi: "3.0.3"\ninfo:\n  title: RuntimeOrders\n  version: "1"\npaths:\n  /orders:\n    get:\n      responses:\n        "200":\n          description: ok\n',
        format: 'openapi-yaml',
        filename: 'index.yaml'
      },
      {
        url: 'https://orders.example.com/asyncapi.json',
        body: `${JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1.0.0' },
          channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
        })}\n`,
        format: 'asyncapi-json',
        filename: 'asyncapi.json'
      },
      {
        url: 'https://orders.example.com/schema.graphql',
        body: 'type Query { ping: String! }\n',
        format: 'graphql-sdl',
        filename: 'schema.graphql'
      },
      {
        url: 'https://orders.example.com/service.proto',
        body: 'syntax = "proto3";\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\n',
        format: 'protobuf',
        filename: 'service.proto'
      },
      {
        url: 'https://orders.example.com/mcp.json',
        body: `${JSON.stringify({
          mcpServers: { weather: { command: 'npx', args: ['-y', '@example/weather-mcp'] } }
        })}\n`,
        format: 'mcp-json',
        filename: 'mcp.json'
      },
      {
        url: 'https://orders.example.com/service.wsdl',
        body: `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Orders">
  <portType name="OrdersPort"/>
</definitions>`,
        format: 'wsdl',
        filename: 'service.wsdl'
      },
      {
        url: 'https://orders.example.com/service.wadl',
        body: `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://orders.example.com/">
    <resource path="orders">
      <method name="GET"/>
    </resource>
  </resources>
</application>`,
        format: 'wadl',
        filename: 'application.wadl'
      },
      {
        url: 'https://orders.example.com/schema.xsd',
        body: `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="Order" type="xs:string"/>
</xs:schema>`,
        format: 'xsd',
        filename: 'schema.xsd'
      }
    ];

    for (const sample of samples) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(sample.body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      );
      const provider = new RuntimeDeclaredRoutesProvider({
        enabled: true,
        targets: [target({ url: sample.url })]
      });
      const [candidate] = await provider.listCandidates();
      const exported = await provider.exportSpec(candidate!);
      expect(exported.format, sample.url).toBe(sample.format);
      expect(exported.filename, sample.url).toBe(sample.filename);
      expect(exported.contractClass).toBe('authoritative');
      vi.restoreAllMocks();
      lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    }
  });

  it('AZ-RT-R4-007: evidence and errors redact query/SAS while preserving SSRF distinction', async () => {
    const sasUrl = 'https://orders.example.com/openapi.json?sv=2024-01-01&sig=super-secret-sas';
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: sasUrl })]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.evidence.join('\n')).toContain('https://orders.example.com/openapi.json');
    expect(candidate!.evidence.join('\n')).not.toMatch(/sig=|super-secret|sv=/);
    // meta retains the fetchable URL (including SAS) for the guarded fetch itself
    expect(candidate!.meta.specUrl).toBe(sasUrl);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const exported = await provider.exportSpec(candidate!);
    expect(exported.evidence.join('\n')).toContain('https://orders.example.com/openapi.json');
    expect(exported.evidence.join('\n')).not.toMatch(/sig=|super-secret/);

    const blockedProvider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: 'https://127.0.0.1/openapi.json?sig=secret-sas' })]
    });
    const [blocked] = await blockedProvider.listCandidates();
    await expect(blockedProvider.exportSpec(blocked!)).rejects.toThrow(/blocked by SSRF defenses/i);
    try {
      await blockedProvider.exportSpec(blocked!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('https://127.0.0.1/openapi.json');
      expect(message).not.toMatch(/sig=|secret-sas/);
      expect(message).not.toMatch(/private-network-unreachable/i);
    }
  });
});
