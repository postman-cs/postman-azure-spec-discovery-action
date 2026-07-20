import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiManagementClient } from '@azure/arm-apimanagement';

import { ApimProvider } from '../src/lib/providers/apim.js';
import { ApimSdkClient } from '../src/lib/azure/clients.js';
import { execute, resolveInputs, type AzureDependencies, type ReporterLike } from '../src/runtime.js';
import type { AzureApimClient } from '../src/lib/azure/clients.js';

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'az-apim-'));
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reporter: ReporterLike = {
  group: async (_name, fn) => fn(),
  info: () => undefined,
  warning: () => undefined
};

function clientForApiType(apiType: string): AzureApimClient {
  return {
    listServices: vi.fn(async () => [{ name: 'svc', resourceGroup: 'rg', tags: { 'postman:project-name': 'payments' } }]),
    listApis: vi.fn(async () => [
      {
        apiId: 'payments',
        displayName: 'Payments API',
        apiType,
        isCurrent: true,
        serviceName: 'svc',
        resourceGroup: 'rg'
      }
    ]),
    getApi: vi.fn(async () => {
      throw new Error('getApi must not be called in this test');
    }),
    exportApi: vi.fn(async () => {
      throw new Error('export must never be attempted for unsupported types');
    }),
    getGraphqlSchema: vi.fn(async () => {
      throw new Error('schema read must never be attempted for unsupported types');
    }),
    listApiSchemas: vi.fn(async () => []),
    getApiSchemaDocument: vi.fn(async () => {
      throw new Error('schema document unused');
    }),
    getProtobufSchema: vi.fn(async () => {
      throw new Error('protobuf unused');
    }),
    probeApimReadAccess: vi.fn(async () => undefined)
  };
}

describe('APIM unsupported API types', () => {
  it.each(['websocket', 'odata'])(
    'AZ-APIM-004: selected %s candidate resolves to manual review without writes',
    async (apiType) => {
      const provider = new ApimProvider(clientForApiType(apiType), { subscriptionId: 'sub-1' });
      const writeSpecFile = vi.fn();
      const dependencies: AzureDependencies = {
        core: reporter,
        subscriptions: {
          get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
          list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
        },
        createApimClient: () => {
          throw new Error('unused');
        },
        createAppServiceClient: () => {
          throw new Error('unused');
        },
        writeSpecFile,
        providers: [provider]
      };

      const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
      const result = await execute(inputs, dependencies);

      expect(result.resolution?.status).toBe('unresolved');
      expect(result.resolution?.sourceType).toBe('manual-review');
      expect(JSON.stringify(result.resolution)).toContain(`APIM API type ${apiType} has no supported discovery export path`);
      expect(writeSpecFile).not.toHaveBeenCalled();
    }
  );

  it('AZ-APIM-004b: gRPC without text/protobuf schema stays manual-review', async () => {
    const provider = new ApimProvider(clientForApiType('grpc'), { subscriptionId: 'sub-1' });
    const writeSpecFile = vi.fn();
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile,
      providers: [provider]
    };

    const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
    const result = await execute(inputs, dependencies);

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(JSON.stringify(result.resolution)).toMatch(/no text\/protobuf schema/i);
    expect(writeSpecFile).not.toHaveBeenCalled();
  });
});

const REALISTIC_WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://postman.example/payments"
             name="PaymentsSoap"
             targetNamespace="http://postman.example/payments">
  <types/>
  <message name="GetHealthRequest"/>
  <message name="GetHealthResponse"/>
  <portType name="PaymentsPortType">
    <operation name="GetHealth">
      <input message="tns:GetHealthRequest"/>
      <output message="tns:GetHealthResponse"/>
    </operation>
  </portType>
  <binding name="PaymentsBinding" type="tns:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding"/>
  </service>
</definitions>`;

const REALISTIC_GRAPHQL = `type Query {
  ping: String!
  health: Health!
}

type Health {
  status: String!
}
`;

const REALISTIC_PROTO = `syntax = "proto3";
package payments;
service Payments {
  rpc GetHealth (HealthRequest) returns (HealthReply);
}
message HealthRequest {}
message HealthReply { string status = 1; }
`;

const PROTO_WITH_IMPORT = `syntax = "proto3";
package payments;
import "common/types.proto";
service Payments {
  rpc GetHealth (HealthRequest) returns (HealthReply);
}
message HealthRequest {}
message HealthReply { string status = 1; }
`;

const WSDL_WITH_XSD_IMPORT = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://postman.example/payments"
             name="PaymentsSoap"
             targetNamespace="http://postman.example/payments">
  <types>
    <xsd:schema>
      <xsd:import namespace="urn:shared" schemaLocation="shared.xsd"/>
    </xsd:schema>
  </types>
  <message name="GetHealthRequest"/>
  <message name="GetHealthResponse"/>
  <portType name="PaymentsPortType">
    <operation name="GetHealth">
      <input message="tns:GetHealthRequest"/>
      <output message="tns:GetHealthResponse"/>
    </operation>
  </portType>
  <binding name="PaymentsBinding" type="tns:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding"/>
  </service>
</definitions>`;

describe('APIM SOAP and GraphQL exports', () => {
  it('exports SOAP as native WSDL after validation', async () => {
    const client = clientForApiType('soap');
    vi.mocked(client.exportApi).mockResolvedValue(REALISTIC_WSDL);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;

    expect(candidate.supported).toBe(true);
    const exported = await provider.exportSpec(candidate);
    expect(exported).toMatchObject({
      content: REALISTIC_WSDL,
      format: 'wsdl',
      filename: 'service.wsdl',
      contractClass: 'authoritative'
    });
    expect(exported.evidence.join(' ')).toMatch(/dependency-closed|No external wsdl dependency/i);
    expect(client.exportApi).toHaveBeenCalledWith('rg', 'svc', 'payments', undefined, 'wsdl-link');
  });

  it('AZ-APIM-SOAP-DEP: WSDL with unresolved XSD import is partial', async () => {
    const client = clientForApiType('soap');
    vi.mocked(client.exportApi).mockResolvedValue(WSDL_WITH_XSD_IMPORT);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    const exported = await provider.exportSpec(candidate);
    expect(exported.contractClass).toBe('partial');
    expect(exported.completeness).toBe('partial');
    expect(exported.evidence.join(' ')).toMatch(/shared\.xsd|unresolved dependency/i);
  });

  it('exports GraphQL SDL after validation and preserves native bytes', async () => {
    const client = clientForApiType('graphql');
    vi.mocked(client.getGraphqlSchema).mockResolvedValue(REALISTIC_GRAPHQL);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;

    expect(candidate.supported).toBe(true);
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({
      content: REALISTIC_GRAPHQL,
      format: 'graphql-sdl',
      filename: 'schema.graphql',
      contractClass: 'authoritative'
    });
    expect(client.getGraphqlSchema).toHaveBeenCalledWith('rg', 'svc', 'payments', undefined);
  });

  it.each([
    ['empty', ''],
    ['HTML', '<!DOCTYPE html><html><body>not a spec</body></html>'],
    ['malformed non-XML', 'not a wsdl document {{{'],
    ['wrong-kind OpenAPI', '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}'],
    ['wrong-kind GraphQL SDL', REALISTIC_GRAPHQL]
  ])('rejects %s SOAP native bytes before returning SpecExportResult', async (_label, content) => {
    const client = clientForApiType('soap');
    vi.mocked(client.exportApi).mockResolvedValue(content);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    await expect(provider.exportSpec(candidate)).rejects.toThrow(/native validation|wrong kind|empty|XML|wsdl|GraphQL|parseable/i);
  });

  it.each([
    ['empty', ''],
    ['HTML', '<html><body>schema</body></html>'],
    ['comment-only', '# just a comment\n'],
    ['wrong-kind WSDL', REALISTIC_WSDL]
  ])('rejects %s GraphQL native bytes before returning SpecExportResult', async (_label, content) => {
    const client = clientForApiType('graphql');
    vi.mocked(client.getGraphqlSchema).mockResolvedValue(content);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    await expect(provider.exportSpec(candidate)).rejects.toThrow(/native validation|wrong kind|empty|GraphQL|wsdl/i);
  });
});

describe('APIM gRPC protobuf schema list/get', () => {
  function grpcClientWithProtobuf(content: string): AzureApimClient {
    const client = clientForApiType('grpc');
    vi.mocked(client.listApiSchemas).mockResolvedValue([{ name: 'default', contentType: 'text/protobuf' }]);
    vi.mocked(client.getProtobufSchema).mockResolvedValue(content);
    return client;
  }

  it('AZ-APIM-GRPC-001: list marks gRPC supported only when text/protobuf schema header is present', async () => {
    const withSchema = new ApimProvider(grpcClientWithProtobuf(REALISTIC_PROTO), { subscriptionId: 'sub-1' });
    const supported = (await withSchema.listCandidates())[0]!;
    expect(supported.supported).toBe(true);
    expect(supported.meta.apiType).toBe('grpc');

    const without = new ApimProvider(clientForApiType('grpc'), { subscriptionId: 'sub-1' });
    const unsupported = (await without.listCandidates())[0]!;
    expect(unsupported.supported).toBe(false);
    expect(unsupported.evidence.join(' ')).toMatch(/no text\/protobuf schema/i);
  });

  it('AZ-APIM-GRPC-002: export uses getProtobufSchema (not APIM export format) and writes service.proto', async () => {
    const client = grpcClientWithProtobuf(REALISTIC_PROTO);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    const exported = await provider.exportSpec(candidate);
    expect(exported).toMatchObject({
      content: REALISTIC_PROTO,
      format: 'protobuf',
      filename: 'service.proto',
      contractClass: 'authoritative'
    });
    expect(exported.evidence.join(' ')).toMatch(/dependency-closed|No external protobuf dependency/i);
    expect(client.getProtobufSchema).toHaveBeenCalledWith('rg', 'svc', 'payments', undefined);
    expect(client.exportApi).not.toHaveBeenCalled();
  });

  it('AZ-APIM-GRPC-002b: protobuf with unresolved import is partial, never authoritative/full', async () => {
    const client = grpcClientWithProtobuf(PROTO_WITH_IMPORT);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    const exported = await provider.exportSpec(candidate);
    expect(exported.contractClass).toBe('partial');
    expect(exported.completeness).toBe('partial');
    expect(exported.evidence.join(' ')).toMatch(/unresolved dependency|common\/types\.proto/i);
  });

  it('AZ-APIM-GRPC-003: malformed/message-only protobuf stays unsupported at export', async () => {
    const client = grpcClientWithProtobuf('message Ping { string id = 1; }\n');
    // Force list-time support so export path is exercised.
    vi.mocked(client.listApiSchemas).mockResolvedValue([{ name: 'default', contentType: 'text/protobuf' }]);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate.supported).toBe(true);
    await expect(provider.exportSpec(candidate)).rejects.toThrow(/native validation|protobuf/i);
  });

  it('AZ-APIM-GRPC-004: end-to-end resolve-one writes service.proto with contractClass', async () => {
    const client = grpcClientWithProtobuf(REALISTIC_PROTO);
    const provider = new ApimProvider(client, { subscriptionId: 'sub-1' });
    const writeSpecFile = vi.fn(async () => undefined);
    const dependencies: AzureDependencies = {
      core: reporter,
      subscriptions: {
        get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: () => {
        throw new Error('unused');
      },
      createAppServiceClient: () => {
        throw new Error('unused');
      },
      writeSpecFile,
      providers: [provider]
    };
    const inputs = resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' });
    const result = await execute(inputs, dependencies);
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.specFormat).toBe('protobuf');
    expect(result.resolution?.contractClass).toBe('authoritative');
    expect(result.resolution?.specPath).toMatch(/service\.proto$/);
    expect(writeSpecFile).toHaveBeenCalled();
    const firstCall = writeSpecFile.mock.calls[0] as unknown as [string, string, string] | undefined;
    expect(firstCall?.[1]).toContain('service Payments');
  });
});

describe('APIM export link lifecycle', () => {
  it('AZ-APIM-003: each 403 discards the SAS URL and re-exports within maxAttempts', async () => {
    const credential = { getToken: vi.fn(async () => ({ token: 'token', expiresOnTimestamp: Date.now() + 60_000 })) };
    const client = new ApimSdkClient(credential, 'sub-1', { requestTimeoutMs: 30000, maxAttempts: 3 });
    const sdk = (client as unknown as { client: ApiManagementClient }).client;
    const exportSpy = vi.spyOn(sdk.apiExport, 'get');
    exportSpy
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/first?sig=first' } })
      .mockResolvedValueOnce({ value: { link: 'https://1.1.1.1/second?sig=second' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"openapi":"3.0.3","paths":{"/ok":{}}}', { status: 200 }));

    await expect(client.exportApi('rg', 'svc', 'payments')).resolves.toContain('openapi');
    expect(exportSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    exportSpy.mockReset();
    fetchSpy.mockReset();
    exportSpy.mockResolvedValue({ value: { link: 'https://1.1.1.1/expired?sig=secret' } });
    fetchSpy.mockResolvedValue(new Response('expired', { status: 403 }));
    await expect(client.exportApi('rg', 'svc', 'payments')).rejects.toThrow('HTTP 403 after 3 attempt(s)');
    expect(exportSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
