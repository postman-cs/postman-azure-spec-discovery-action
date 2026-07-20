import { describe, expect, it } from 'vitest';

import type { SpecFormat } from '../src/contracts.js';
import { detectNativeFormat, parseAndValidateNativeSpec } from '../src/lib/spec/native-formats.js';
import { safeNativeFilename } from '../src/lib/spec/native-filenames.js';

/**
 * Bootstrap protocol ids from postman-bootstrap-action `detectSpecType`
 * (kept here as a frozen cross-action contract — this repo must not import
 * sibling checkout paths).
 */
type BootstrapProtocol = 'openapi' | 'graphql' | 'grpc' | 'soap' | 'asyncapi' | 'mcp';

/**
 * Exact detector signals bootstrap uses (filename extension / content shape).
 * Test-only oracle: mirrors the published detection contract without copying
 * bootstrap production implementation.
 */
const BOOTSTRAP_DETECTOR_SIGNALS: Record<
  BootstrapProtocol,
  {
    /** Filename patterns that make the extension hint authoritative. */
    filenameHints: RegExp[];
    /** Content patterns that classify without relying on an extension hint. */
    contentSignals: RegExp[];
  }
> = {
  openapi: {
    filenameHints: [],
    contentSignals: [/"openapi"\s*:\s*"/, /^\s*["']?openapi["']?\s*:/m, /"swagger"\s*:\s*"2\.0"/]
  },
  graphql: {
    filenameHints: [/\.graphql$/i, /\.graphqls$/i, /\.gql$/i],
    contentSignals: [
      /^\s*(?:"""[\s\S]*?"""\s*)?(?:extend\s+)?(?:(?:type|interface|enum|union|scalar|input)\s+[A-Za-z_]|schema\s*\{|directive\s+@)/m
    ]
  },
  grpc: {
    filenameHints: [/\.proto$/i],
    contentSignals: [/^\s*syntax\s*=\s*["']proto[23]["']/m, /\bservice\s+\w+\s*\{[\s\S]*\brpc\b/]
  },
  soap: {
    filenameHints: [/\.wsdl$/i],
    contentSignals: [
      /<(?:[A-Za-z_][\w.-]*:)?(?:definitions|description)\b/i,
      /schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl/i
    ]
  },
  asyncapi: {
    filenameHints: [/asyncapi/i],
    contentSignals: [/"asyncapi"\s*:\s*"/, /^\s*["']?asyncapi["']?\s*:\s*["']?\d/m]
  },
  mcp: {
    filenameHints: [],
    contentSignals: [/"mcpServers"\s*:\s*\{/, /modelcontextprotocol/i, /"remotes"\s*:\s*\[/, /"packages"\s*:\s*\[/]
  }
};

/** Minimal test-only oracle: which bootstrap signals fire for filename+content. */
function matchedBootstrapSignals(
  protocol: BootstrapProtocol,
  content: string,
  fileName: string
): { filename: string[]; content: string[] } {
  const contract = BOOTSTRAP_DETECTOR_SIGNALS[protocol];
  const filename = contract.filenameHints
    .filter((pattern) => pattern.test(fileName))
    .map((pattern) => pattern.source);
  const contentHits = contract.contentSignals
    .filter((pattern) => pattern.test(content))
    .map((pattern) => pattern.source);
  return { filename, content: contentHits };
}

function assertBootstrapSignalsPresent(
  protocol: BootstrapProtocol,
  content: string,
  fileName: string,
  label: string
): void {
  const hits = matchedBootstrapSignals(protocol, content, fileName);
  expect(
    hits.filename.length + hits.content.length,
    `${label}: discovery output must carry at least one bootstrap ${protocol} detector signal`
  ).toBeGreaterThan(0);
}

interface ConformanceFixture {
  label: string;
  content: string;
  fileName: string;
  azureFormat: SpecFormat | '';
  bootstrapProtocol: BootstrapProtocol;
  mustReject?: boolean;
  /**
   * Negative cases: bootstrap may still classify by a loose signal; discovery
   * must reject when bytes are not bootstrap-usable for onboarding.
   */
  rejectReason?: string;
}

const FIXTURES: ConformanceFixture[] = [
  {
    label: 'openapi-json',
    content: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Demo', version: '1' },
      paths: { '/ok': { get: { responses: { '200': { description: 'ok' } } } } }
    }),
    fileName: 'index.json',
    azureFormat: 'openapi-json',
    bootstrapProtocol: 'openapi'
  },
  {
    label: 'asyncapi-yaml',
    content:
      'asyncapi: 2.6.0\ninfo:\n  title: events\n  version: "1"\nchannels:\n  ping:\n    publish:\n      message:\n        payload:\n          type: string\n',
    fileName: 'asyncapi.yaml',
    azureFormat: 'asyncapi-yaml',
    bootstrapProtocol: 'asyncapi'
  },
  {
    label: 'graphql-sdl',
    content: 'type Query { ping: String! }\n',
    fileName: 'schema.graphql',
    azureFormat: 'graphql-sdl',
    bootstrapProtocol: 'graphql'
  },
  {
    label: 'protobuf-service',
    content: 'syntax = "proto3";\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\n',
    fileName: 'service.proto',
    azureFormat: 'protobuf',
    bootstrapProtocol: 'grpc'
  },
  {
    label: 'wsdl',
    content: `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Demo">
  <portType name="DemoPort"/>
</definitions>`,
    fileName: 'service.wsdl',
    azureFormat: 'wsdl',
    bootstrapProtocol: 'soap'
  },
  {
    label: 'mcp-json',
    content: JSON.stringify({
      mcpServers: { weather: { command: 'npx', args: ['-y', '@example/weather-mcp'] } }
    }),
    fileName: 'mcp.json',
    azureFormat: 'mcp-json',
    bootstrapProtocol: 'mcp'
  },
  {
    label: 'message-only-proto-odd-name',
    content: 'message Ping { string id = 1; }\n',
    fileName: 'notes.txt',
    azureFormat: '',
    bootstrapProtocol: 'grpc',
    mustReject: true,
    rejectReason:
      'message-only IDL without .proto hint, syntax=proto[23], or service{rpc} is not bootstrap-usable grpc'
  },
  {
    label: 'mcp-non-object-remotes',
    content: JSON.stringify({ name: 'io.github.example/weather', remotes: ['https://example.com'] }),
    fileName: 'server.json',
    azureFormat: '',
    bootstrapProtocol: 'mcp',
    mustReject: true,
    rejectReason:
      'registry shape with string remotes matches a loose mcp name+remotes signal but lacks usable object remotes/packages entries'
  }
];

describe('cross-action bootstrap native conformance', () => {
  it('AZ-BOOTSTRAP-CONF-001: discovery accepts only formats/content carrying bootstrap detector signals', () => {
    for (const fixture of FIXTURES) {
      const azure = detectNativeFormat(fixture.content, fixture.fileName);

      if (fixture.mustReject) {
        expect(azure, fixture.label).toBeUndefined();
        expect(() => parseAndValidateNativeSpec(fixture.content, undefined, fixture.fileName)).toThrow();

        if (fixture.label === 'message-only-proto-odd-name') {
          // Bootstrap content-path grpc requires syntax= or service{rpc}; odd
          // filename must not invent a .proto hint. Discovery must stay rejected.
          const grpcHits = matchedBootstrapSignals('grpc', fixture.content, fixture.fileName);
          expect(grpcHits.filename, fixture.rejectReason).toHaveLength(0);
          expect(grpcHits.content, fixture.rejectReason).toHaveLength(0);
        }

        if (fixture.label === 'mcp-non-object-remotes') {
          // Loose bootstrap mcp signal (name + remotes array) may fire, but
          // discovery requires usable object entries — keep rejected.
          const mcpHits = matchedBootstrapSignals('mcp', fixture.content, fixture.fileName);
          expect(mcpHits.content.some((source) => source.includes('remotes')), fixture.rejectReason).toBe(true);
          expect(azure, fixture.rejectReason).toBeUndefined();
        }
        continue;
      }

      expect(azure?.format, fixture.label).toBe(fixture.azureFormat);
      assertBootstrapSignalsPresent(
        fixture.bootstrapProtocol,
        fixture.content,
        fixture.fileName,
        fixture.label
      );
      expect(parseAndValidateNativeSpec(fixture.content, fixture.azureFormat as SpecFormat, fixture.fileName).format).toBe(
        fixture.azureFormat
      );
      expect(safeNativeFilename(fixture.azureFormat as SpecFormat)).toBe(fixture.fileName);
    }
  });

  it('AZ-BOOTSTRAP-CONF-002: contract table covers MCP, proto, WSDL, AsyncAPI, GraphQL, OpenAPI', () => {
    const protocols = new Set(FIXTURES.filter((f) => !f.mustReject).map((f) => f.bootstrapProtocol));
    expect([...protocols].sort()).toEqual(['asyncapi', 'graphql', 'grpc', 'mcp', 'openapi', 'soap'].sort());
    expect(FIXTURES.some((f) => f.label === 'message-only-proto-odd-name' && f.mustReject)).toBe(true);
    expect(FIXTURES.some((f) => f.label === 'mcp-non-object-remotes' && f.mustReject)).toBe(true);
  });
});
