import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectNativeFormat, parseAndValidateNativeSpec } from '../src/lib/spec/native-formats.js';
import { safeNativeFilename } from '../src/lib/spec/native-filenames.js';

const bootstrapDetectUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../postman-bootstrap-action/src/lib/spec/detect-spec-type.ts'
  )
).href;

async function loadBootstrapDetect(): Promise<{
  detectSpecType: (content: string, fileName?: string) => string;
}> {
  // Cross-action: import bootstrap's actual detector module.
  return import(bootstrapDetectUrl);
}

const FIXTURES: Array<{
  label: string;
  content: string;
  fileName: string;
  azureFormat: string;
  bootstrapType: string;
  mustReject?: boolean;
}> = [
  {
    label: 'openapi-json',
    content: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Demo', version: '1' },
      paths: { '/ok': { get: { responses: { '200': { description: 'ok' } } } } }
    }),
    fileName: 'index.json',
    azureFormat: 'openapi-json',
    bootstrapType: 'openapi'
  },
  {
    label: 'asyncapi-yaml',
    content:
      'asyncapi: 2.6.0\ninfo:\n  title: events\n  version: "1"\nchannels:\n  ping:\n    publish:\n      message:\n        payload:\n          type: string\n',
    fileName: 'asyncapi.yaml',
    azureFormat: 'asyncapi-yaml',
    bootstrapType: 'asyncapi'
  },
  {
    label: 'graphql-sdl',
    content: 'type Query { ping: String! }\n',
    fileName: 'schema.graphql',
    azureFormat: 'graphql-sdl',
    bootstrapType: 'graphql'
  },
  {
    label: 'protobuf-service',
    content: 'syntax = "proto3";\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\n',
    fileName: 'service.proto',
    azureFormat: 'protobuf',
    bootstrapType: 'grpc'
  },
  {
    label: 'wsdl',
    content: `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Demo">
  <portType name="DemoPort"/>
</definitions>`,
    fileName: 'service.wsdl',
    azureFormat: 'wsdl',
    bootstrapType: 'soap'
  },
  {
    label: 'mcp-json',
    content: JSON.stringify({
      mcpServers: { weather: { command: 'npx', args: ['-y', '@example/weather-mcp'] } }
    }),
    fileName: 'mcp.json',
    azureFormat: 'mcp-json',
    bootstrapType: 'mcp'
  },
  {
    label: 'message-only-proto-odd-name',
    content: 'message Ping { string id = 1; }\n',
    fileName: 'notes.txt',
    azureFormat: '',
    bootstrapType: 'openapi',
    mustReject: true
  },
  {
    label: 'mcp-non-object-remotes',
    content: JSON.stringify({ name: 'io.github.example/weather', remotes: ['https://example.com'] }),
    fileName: 'server.json',
    azureFormat: '',
    bootstrapType: 'mcp',
    mustReject: true
  }
];

describe('cross-action bootstrap native conformance', () => {
  it('AZ-BOOTSTRAP-CONF-001: discovery accepts only formats/content bootstrap detector/parser expects', async () => {
    const { detectSpecType } = await loadBootstrapDetect();

    for (const fixture of FIXTURES) {
      const azure = detectNativeFormat(fixture.content, fixture.fileName);
      const bootstrap = detectSpecType(fixture.content, fixture.fileName);

      if (fixture.mustReject) {
        expect(azure, fixture.label).toBeUndefined();
        expect(() => parseAndValidateNativeSpec(fixture.content, undefined, fixture.fileName)).toThrow();
        // Bootstrap may still classify by filename/heuristics; discovery must not resolve
        // formats bootstrap would reject for usable onboarding bytes.
        if (fixture.label === 'message-only-proto-odd-name') {
          expect(bootstrap).not.toBe('grpc');
        }
        continue;
      }

      expect(azure?.format, fixture.label).toBe(fixture.azureFormat);
      expect(bootstrap, fixture.label).toBe(fixture.bootstrapType);
      expect(parseAndValidateNativeSpec(fixture.content, fixture.azureFormat as never, fixture.fileName).format).toBe(
        fixture.azureFormat
      );
      expect(safeNativeFilename(fixture.azureFormat as never)).toBe(fixture.fileName);
    }
  });
});
