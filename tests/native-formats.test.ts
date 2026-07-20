import { describe, expect, it } from 'vitest';

import type { ContractClass, SpecFormat } from '../src/contracts.js';
import {
  detectNativeFormat,
  parseAndValidateNativeSpec
} from '../src/lib/spec/native-formats.js';
import { applyDeclaredFidelity, deriveOpenApiDocument } from '../src/lib/spec/oas-derivation.js';

const REQUIRED_FORMATS: SpecFormat[] = [
  'openapi-yaml',
  'openapi-json',
  'asyncapi-yaml',
  'asyncapi-json',
  'wsdl',
  'wadl',
  'xsd',
  'protobuf',
  'graphql-sdl',
  'mcp-json'
];

const MCP_CLIENT_CONFIG = JSON.stringify({
  mcpServers: {
    weather: {
      command: 'npx',
      args: ['-y', '@example/weather-mcp']
    }
  }
});

const MCP_REGISTRY = JSON.stringify({
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json',
  name: 'io.github.example/weather',
  version: '1.2.0',
  remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }],
  packages: [{ registry_type: 'npm', identifier: '@example/weather-mcp', version: '1.2.0' }]
});

const REQUIRED_CONTRACT_CLASSES: ContractClass[] = [
  'authoritative',
  'reconstructed',
  'partial',
  'association-only',
  'unsupported'
];

describe('native format contracts', () => {
  it('expands SpecFormat with stable names for later repository/API Center providers', () => {
    for (const format of REQUIRED_FORMATS) {
      const assigned: SpecFormat = format;
      expect(assigned).toBe(format);
    }
  });

  it('exposes ContractClass values without requiring serialized contract fields', () => {
    for (const value of REQUIRED_CONTRACT_CLASSES) {
      const assigned: ContractClass = value;
      expect(assigned).toBe(value);
    }
  });
});

describe('native format detection', () => {
  it('identifies OpenAPI JSON vs YAML across 2.0, 3.0, and 3.1', () => {
    expect(
      detectNativeFormat(
        JSON.stringify({ swagger: '2.0', info: { title: 's', version: '1' }, paths: { '/a': {} } })
      )
    ).toMatchObject({ format: 'openapi-json', kind: 'openapi', version: 'swagger-2.0' });

    expect(
      detectNativeFormat('openapi: "3.0.3"\ninfo:\n  title: o\n  version: "1"\npaths:\n  /a: {}\n')
    ).toMatchObject({ format: 'openapi-yaml', kind: 'openapi', version: 'openapi-3.0' });

    expect(
      detectNativeFormat(
        JSON.stringify({ openapi: '3.1.0', info: { title: 'o', version: '1' }, paths: { '/a': {} } })
      )
    ).toMatchObject({ format: 'openapi-json', kind: 'openapi', version: 'openapi-3.1' });
  });

  it('identifies AsyncAPI JSON vs YAML', () => {
    expect(
      detectNativeFormat(
        JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1.0.0' },
          channels: { ping: { publish: { message: { payload: { type: 'object' } } } } }
        })
      )
    ).toMatchObject({ format: 'asyncapi-json', kind: 'asyncapi' });

    expect(
      detectNativeFormat(
        'asyncapi: 3.0.0\ninfo:\n  title: events\n  version: "1"\nchannels:\n  ping:\n    address: ping\n'
      )
    ).toMatchObject({ format: 'asyncapi-yaml', kind: 'asyncapi' });
  });

  it('distinguishes WSDL, WADL, and XSD XML roots without fetching references', () => {
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  name="Orders">
  <types>
    <xsd:schema>
      <xsd:import schemaLocation="./orders.xsd"/>
    </xsd:schema>
  </types>
  <portType name="OrdersPort"/>
</definitions>`;
    expect(detectNativeFormat(wsdl)).toMatchObject({ format: 'wsdl', kind: 'wsdl' });

    const wadl = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://example.com/">
    <resource path="orders">
      <method name="GET"/>
    </resource>
  </resources>
</application>`;
    expect(detectNativeFormat(wadl)).toMatchObject({ format: 'wadl', kind: 'wadl' });

    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:element name="Order" type="xs:string"/>
</xs:schema>`;
    expect(detectNativeFormat(xsd)).toMatchObject({ format: 'xsd', kind: 'xsd' });
  });

  it('detects protobuf from syntax or service/rpc; message-only needs .proto hint', () => {
    expect(
      detectNativeFormat('syntax = "proto3";\npackage demo;\nmessage Ping { string id = 1; }\n')
    ).toMatchObject({ format: 'protobuf', kind: 'protobuf' });

    expect(
      detectNativeFormat('service Greeter {\n  rpc SayHello (HelloRequest) returns (HelloReply);\n}\n')
    ).toMatchObject({ format: 'protobuf', kind: 'protobuf' });

    // Bootstrap content-path: bare message IDL is not protobuf without .proto hint.
    expect(detectNativeFormat('message Ping { string id = 1; }\n')).toBeUndefined();
    expect(detectNativeFormat('message Ping { string id = 1; }\n', 'notes.txt')).toBeUndefined();
    expect(detectNativeFormat('message Ping { string id = 1; }\n', 'types.proto')).toMatchObject({
      format: 'protobuf',
      kind: 'protobuf'
    });

    expect(detectNativeFormat('// not a protobuf file, just a comment\n')).toBeUndefined();
  });

  it('detects GraphQL SDL only when a type or schema definition is present', () => {
    expect(detectNativeFormat('type Query { ping: String! }\n')).toMatchObject({
      format: 'graphql-sdl',
      kind: 'graphql-sdl'
    });
    expect(detectNativeFormat('schema { query: Query }\n')).toMatchObject({
      format: 'graphql-sdl',
      kind: 'graphql-sdl'
    });
    expect(detectNativeFormat('type: object\nproperties:\n  id: { type: string }\n')).toBeUndefined();
  });

  it('detects MCP client config and registry JSON; rejects arbitrary JSON and YAML near-matches', () => {
    expect(detectNativeFormat(MCP_CLIENT_CONFIG)).toMatchObject({
      format: 'mcp-json',
      kind: 'mcp-json',
      serialization: 'json'
    });
    expect(detectNativeFormat(MCP_REGISTRY)).toMatchObject({
      format: 'mcp-json',
      kind: 'mcp-json'
    });
    // Empty $schema shell / non-object remotes/packages must not resolve.
    expect(
      detectNativeFormat(
        JSON.stringify({
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json',
          name: 'io.github.example/empty-shell'
        })
      )
    ).toBeUndefined();
    expect(
      detectNativeFormat(JSON.stringify({ name: 'io.github.example/weather', remotes: ['https://example.com'] }))
    ).toBeUndefined();
    expect(
      detectNativeFormat(JSON.stringify({ name: 'io.github.example/weather', packages: ['@example/pkg'] }))
    ).toBeUndefined();

    expect(detectNativeFormat(JSON.stringify({ name: 'not-mcp' }))).toBeUndefined();
    expect(detectNativeFormat(JSON.stringify({ foo: 1, bar: ['a'] }))).toBeUndefined();
    expect(detectNativeFormat(JSON.stringify({ mcpServers: [] }))).toBeUndefined();
    expect(detectNativeFormat(JSON.stringify({ mcpServers: 'weather' }))).toBeUndefined();
    expect(detectNativeFormat(JSON.stringify({ name: 'x', remotes: { url: 'https://example.com' } }))).toBeUndefined();
    expect(
      detectNativeFormat('mcpServers:\n  weather:\n    command: npx\n')
    ).toBeUndefined();
  });
});

describe('native format validation', () => {
  it('rejects empty, malformed, and wrong-kind documents for each supported family', () => {
    expect(() => parseAndValidateNativeSpec('')).toThrow(/empty/i);
    expect(() => parseAndValidateNativeSpec('{not json')).toThrow(/parseable|malformed/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': {} } }),
        'asyncapi-json'
      )
    ).toThrow(/asyncapi|wrong/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1.0.0' },
          channels: { ping: {} }
        }),
        'openapi-json'
      )
    ).toThrow(/openapi|swagger|wrong/i);
  });

  it('validates AsyncAPI documents and preserves JSON vs YAML identity', () => {
    const json = parseAndValidateNativeSpec(
      JSON.stringify({
        asyncapi: '2.6.0',
        info: { title: 'events', version: '1.0.0' },
        channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
      })
    );
    expect(json).toMatchObject({ format: 'asyncapi-json', kind: 'asyncapi' });

    const yaml = parseAndValidateNativeSpec(
      'asyncapi: 2.6.0\ninfo:\n  title: events\n  version: "1"\nchannels:\n  ping:\n    publish:\n      message:\n        payload:\n          type: string\n'
    );
    expect(yaml).toMatchObject({ format: 'asyncapi-yaml', kind: 'asyncapi' });

    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({ asyncapi: '2.6.0', info: { title: 'events', version: '1.0.0' }, channels: {} })
      )
    ).toThrow(/channel/i);
  });

  it('validates WSDL with XSD references without fetching them', () => {
    const content = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <wsdl:types>
    <xsd:schema>
      <xsd:import namespace="urn:orders" schemaLocation="orders.xsd"/>
      <xsd:include schemaLocation="./common.xsd"/>
    </xsd:schema>
  </wsdl:types>
  <wsdl:portType name="Orders"/>
</wsdl:definitions>`;
    const validated = parseAndValidateNativeSpec(content);
    expect(validated.format).toBe('wsdl');
    expect(validated.xsdReferences).toEqual(expect.arrayContaining(['orders.xsd', './common.xsd']));
  });

  it('validates WADL and standalone XSD roots', () => {
    const wadl = parseAndValidateNativeSpec(`<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://example.com/api">
    <resource path="items">
      <method name="GET" id="listItems"/>
    </resource>
  </resources>
</application>`);
    expect(wadl.format).toBe('wadl');

    const xsd = parseAndValidateNativeSpec(`<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema">
  <element name="Item" type="string"/>
</schema>`);
    expect(xsd.format).toBe('xsd');

    expect(() => parseAndValidateNativeSpec('<root><child/></root>')).toThrow(/wsdl|wadl|xsd|xml/i);
  });

  it('validates protobuf structure and GraphQL SDL definitions', () => {
    expect(
      parseAndValidateNativeSpec('syntax = "proto3";\nmessage Ping { string id = 1; }\n').format
    ).toBe('protobuf');
    expect(() => parseAndValidateNativeSpec('message Ping { string id = 1; }\n')).toThrow(
      /protobuf|syntax|service|supported native/i
    );
    expect(parseAndValidateNativeSpec('message Ping { string id = 1; }\n', undefined, 'x.proto').format).toBe(
      'protobuf'
    );
    expect(() => parseAndValidateNativeSpec('package only.comments;\n')).toThrow(/protobuf|syntax|message|service/i);

    expect(parseAndValidateNativeSpec('type Query { ok: Boolean! }\n').format).toBe('graphql-sdl');
    expect(() => parseAndValidateNativeSpec('# just a comment\n')).toThrow(/graphql|type|schema/i);
  });

  it('validates MCP JSON client/registry documents and rejects empty or malformed near-matches', () => {
    const client = parseAndValidateNativeSpec(MCP_CLIENT_CONFIG);
    expect(client).toMatchObject({ format: 'mcp-json', kind: 'mcp-json', serialization: 'json' });
    expect(client.document).toMatchObject({ mcpServers: expect.any(Object) });

    const registry = parseAndValidateNativeSpec(MCP_REGISTRY);
    expect(registry).toMatchObject({ format: 'mcp-json', kind: 'mcp-json' });
    expect(registry.document).toMatchObject({
      name: 'io.github.example/weather',
      remotes: expect.any(Array),
      packages: expect.any(Array)
    });

    expect(() => parseAndValidateNativeSpec(JSON.stringify({ name: 'not-mcp' }))).toThrow(
      /supported native|MCP JSON/i
    );
    expect(() => parseAndValidateNativeSpec(JSON.stringify({ mcpServers: {} }))).toThrow(/MCP JSON/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json',
          name: 'io.github.example/empty-shell'
        })
      )
    ).toThrow(/MCP JSON/i);
    expect(() =>
      parseAndValidateNativeSpec(JSON.stringify({ name: 'io.github.example/weather', remotes: [] }))
    ).toThrow(/MCP JSON/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({ name: 'io.github.example/weather', remotes: ['https://example.com/sse'] })
      )
    ).toThrow(/MCP JSON/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({ name: 'io.github.example/weather', packages: ['@example/weather-mcp'] })
      )
    ).toThrow(/MCP JSON/i);
    expect(() => parseAndValidateNativeSpec(MCP_CLIENT_CONFIG, 'openapi-json')).toThrow(/openapi|wrong/i);
    expect(() => parseAndValidateNativeSpec('mcpServers:\n  weather:\n    command: npx\n', 'mcp-json')).toThrow(
      /MCP JSON|JSON object/i
    );
  });
});

describe('native fidelity helpers', () => {
  it('never upgrades provider-declared partial or reconstructed fidelity to full', () => {
    const openapiFull = deriveOpenApiDocument({
      content: JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'api', version: '1' },
        paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } }
      }),
      format: 'openapi-json'
    });
    expect(openapiFull?.completeness).toBe('full');

    expect(
      applyDeclaredFidelity(openapiFull!, { completeness: 'partial' }).completeness
    ).toBe('partial');
    expect(
      applyDeclaredFidelity(openapiFull!, { contractClass: 'reconstructed' }).completeness
    ).toBe('partial');
    expect(
      applyDeclaredFidelity(openapiFull!, { contractClass: 'partial' }).completeness
    ).toBe('partial');
    expect(
      applyDeclaredFidelity(openapiFull!, { contractClass: 'authoritative' }).completeness
    ).toBe('full');
  });

  it('keeps native non-OpenAPI derivation partial when present', () => {
    const graphql = deriveOpenApiDocument({
      content: 'type Query { ping: String! }',
      format: 'graphql-sdl',
      title: 'G'
    });
    expect(graphql?.completeness).toBe('partial');
    expect(
      applyDeclaredFidelity(graphql!, { contractClass: 'authoritative' }).completeness
    ).toBe('partial');
  });
});
